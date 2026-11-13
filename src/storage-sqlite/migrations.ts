import { createHash } from "node:crypto";
import type { SqliteDatabase } from "./database.js";

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  /** Stable contract identifier for behavior that runs outside the SQL batch. */
  readonly checksumKey?: string;
  readonly afterApply?: (database: SqliteDatabase) => void;
  readonly disableForeignKeysForRebuild?: boolean;
}

interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export interface MigrationInspection {
  readonly status: "missing" | "behind" | "current" | "ahead" | "drift";
  readonly appliedVersion: number;
  readonly supportedVersion: number;
  readonly appliedCount: number;
}

export const initialMigrations: readonly SqliteMigration[] = [
  {
    version: 1,
    name: "initial-projects",
    sql: `
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL COLLATE NOCASE UNIQUE,
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        product_goal TEXT NOT NULL CHECK (length(trim(product_goal)) > 0),
        timezone TEXT NOT NULL CHECK (length(trim(timezone)) > 0),
        created_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: "local-identity-audit-idempotency",
    sql: `
      CREATE TABLE principals (
        principal_id TEXT PRIMARY KEY,
        principal_type TEXT NOT NULL CHECK (principal_type IN ('human', 'agent', 'service')),
        identity_key TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
        created_at TEXT NOT NULL
      ) STRICT;

      ALTER TABLE projects
        ADD COLUMN created_by_principal_id TEXT REFERENCES principals(principal_id);

      CREATE TABLE project_memberships (
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'po', 'developer', 'qa', 'tech_lead', 'facilitator', 'stakeholder')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, principal_id, role)
      ) STRICT;

      CREATE INDEX project_memberships_by_principal
        ON project_memberships (principal_id, project_id);

      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        reason TEXT,
        event_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (event_schema_version > 0),
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
      ) STRICT;

      CREATE INDEX audit_events_by_project_sequence
        ON audit_events (project_id, sequence);

      CREATE TABLE idempotency_records (
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        action TEXT NOT NULL,
        request_id TEXT NOT NULL,
        payload_hash TEXT CHECK (payload_hash IS NULL OR length(payload_hash) = 64),
        response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (project_id, principal_id, action, request_id),
        CHECK (expires_at > created_at)
      ) STRICT;
    `,
  },
  {
    version: 3,
    name: "work-items-and-criteria",
    sql: `
      CREATE TABLE project_sequences (
        project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
        next_work_item_number INTEGER NOT NULL CHECK (next_work_item_number > 0)
      ) STRICT;

      CREATE TABLE work_items (
        item_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        item_key TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('epic', 'feature', 'story', 'bug', 'task')),
        parent_id TEXT,
        related_story_id TEXT,
        title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
        description TEXT,
        state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'ready', 'in_progress', 'in_review', 'in_validation', 'done', 'cancelled')),
        priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, item_key),
        UNIQUE (project_id, item_id),
        FOREIGN KEY (project_id, parent_id) REFERENCES work_items(project_id, item_id),
        FOREIGN KEY (project_id, related_story_id) REFERENCES work_items(project_id, item_id),
        CHECK (type <> 'epic' OR parent_id IS NULL),
        CHECK (type = 'epic' OR parent_id IS NOT NULL),
        CHECK (type = 'bug' OR related_story_id IS NULL),
        CHECK (parent_id IS NULL OR parent_id <> item_id)
      ) STRICT;

      CREATE INDEX work_items_by_project_type_state
        ON work_items (project_id, type, state, item_key);

      CREATE INDEX work_items_by_parent
        ON work_items (project_id, parent_id, item_key);

      CREATE TABLE work_item_criteria (
        criterion_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        criterion_key TEXT NOT NULL CHECK (length(trim(criterion_key)) BETWEEN 1 AND 20),
        description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 2000),
        is_required INTEGER NOT NULL DEFAULT 1 CHECK (is_required IN (0, 1)),
        position INTEGER NOT NULL CHECK (position > 0),
        created_at TEXT NOT NULL,
        UNIQUE (project_id, item_id, criterion_key),
        UNIQUE (project_id, item_id, position),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    version: 4,
    name: "immutable-work-item-revisions",
    sql: `
      CREATE TABLE work_item_revisions (
        revision_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
        created_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        created_at TEXT NOT NULL,
        UNIQUE (project_id, item_id, revision_number),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id)
      ) STRICT;

      CREATE INDEX work_item_revisions_by_item
        ON work_item_revisions (project_id, item_id, revision_number);

      INSERT INTO work_item_revisions
        (revision_id, project_id, item_id, revision_number, snapshot_json,
         created_by_principal_id, created_at)
      SELECT
        item_id || ':revision:1',
        project_id,
        item_id,
        1,
        json_object(
          'type', type,
          'parentId', parent_id,
          'relatedStoryId', related_story_id,
          'title', title,
          'description', description,
          'priority', priority,
          'criteria', json(COALESCE((
            SELECT json_group_array(json(ordered_criteria.criterion_json))
            FROM (
              SELECT json_object(
                'id', c.criterion_id,
                'key', c.criterion_key,
                'description', c.description,
                'required', json(CASE WHEN c.is_required = 1 THEN 'true' ELSE 'false' END),
                'position', c.position
              ) AS criterion_json
              FROM work_item_criteria AS c
              WHERE c.project_id = work_items.project_id AND c.item_id = work_items.item_id
              ORDER BY c.position
            ) AS ordered_criteria
          ), '[]'))
        ),
        created_by_principal_id,
        created_at
      FROM work_items;

      CREATE TRIGGER work_item_revisions_no_update
        BEFORE UPDATE ON work_item_revisions
        BEGIN
          SELECT RAISE(ABORT, 'work item revisions are immutable');
        END;

      CREATE TRIGGER work_item_revisions_no_delete
        BEFORE DELETE ON work_item_revisions
        BEGIN
          SELECT RAISE(ABORT, 'work item revisions are immutable');
        END;
    `,
  },
  {
    version: 5,
    name: "work-item-full-text-index",
    sql: `
      CREATE VIRTUAL TABLE work_items_fts USING fts5(
        title,
        description,
        content='work_items',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER work_items_fts_after_insert
        AFTER INSERT ON work_items
        BEGIN
          INSERT INTO work_items_fts (rowid, title, description)
          VALUES (new.rowid, new.title, new.description);
        END;

      CREATE TRIGGER work_items_fts_after_delete
        AFTER DELETE ON work_items
        BEGIN
          INSERT INTO work_items_fts (work_items_fts, rowid, title, description)
          VALUES ('delete', old.rowid, old.title, old.description);
        END;

      CREATE TRIGGER work_items_fts_after_update
        AFTER UPDATE OF title, description ON work_items
        BEGIN
          INSERT INTO work_items_fts (work_items_fts, rowid, title, description)
          VALUES ('delete', old.rowid, old.title, old.description);
          INSERT INTO work_items_fts (rowid, title, description)
          VALUES (new.rowid, new.title, new.description);
        END;

      INSERT INTO work_items_fts (work_items_fts) VALUES ('rebuild');
    `,
  },
  {
    version: 6,
    name: "specification-identities-and-revisions",
    sql: `
      CREATE TABLE specifications (
        spec_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        spec_key TEXT NOT NULL COLLATE NOCASE,
        kind TEXT NOT NULL CHECK (kind IN ('business_rule', 'glossary', 'api_contract', 'adr', 'non_functional')),
        title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        created_at TEXT NOT NULL,
        UNIQUE (project_id, spec_key),
        UNIQUE (project_id, spec_id)
      ) STRICT;

      CREATE INDEX specifications_by_project_kind
        ON specifications (project_id, kind, spec_key);

      CREATE TABLE specification_revisions (
        revision_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        spec_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        status TEXT NOT NULL CHECK (status IN ('draft', 'in_review', 'published', 'superseded')),
        content_json TEXT NOT NULL CHECK (json_valid(content_json)),
        created_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        created_at TEXT NOT NULL,
        published_by_principal_id TEXT REFERENCES principals(principal_id),
        published_at TEXT,
        UNIQUE (project_id, spec_id, revision_number),
        FOREIGN KEY (project_id, spec_id) REFERENCES specifications(project_id, spec_id),
        CHECK (
          (status IN ('draft', 'in_review') AND published_by_principal_id IS NULL AND published_at IS NULL)
          OR
          (status IN ('published', 'superseded') AND published_by_principal_id IS NOT NULL AND published_at IS NOT NULL)
        )
      ) STRICT;

      CREATE UNIQUE INDEX specification_one_published_revision
        ON specification_revisions (project_id, spec_id) WHERE status = 'published';

      CREATE INDEX specification_revisions_by_spec
        ON specification_revisions (project_id, spec_id, revision_number);

      CREATE TRIGGER specification_revisions_immutable_content
        BEFORE UPDATE ON specification_revisions
        WHEN
          NEW.revision_id IS NOT OLD.revision_id OR
          NEW.project_id IS NOT OLD.project_id OR
          NEW.spec_id IS NOT OLD.spec_id OR
          NEW.revision_number IS NOT OLD.revision_number OR
          NEW.content_json IS NOT OLD.content_json OR
          NEW.created_by_principal_id IS NOT OLD.created_by_principal_id OR
          NEW.created_at IS NOT OLD.created_at OR
          NOT (
            (OLD.status = 'draft' AND NEW.status IN ('in_review', 'published')) OR
            (OLD.status = 'in_review' AND NEW.status IN ('draft', 'published')) OR
            (OLD.status = 'published' AND NEW.status = 'superseded'
              AND NEW.published_by_principal_id IS OLD.published_by_principal_id
              AND NEW.published_at IS OLD.published_at)
          )
        BEGIN
          SELECT RAISE(ABORT, 'specification revision content and history are immutable');
        END;

      CREATE TRIGGER specification_revisions_no_delete
        BEFORE DELETE ON specification_revisions
        BEGIN
          SELECT RAISE(ABORT, 'specification revisions are immutable');
        END;
    `,
  },
  {
    version: 7,
    name: "typed-project-trace-graph",
    sql: `
      CREATE TABLE trace_nodes (
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        node_id TEXT NOT NULL,
        node_type TEXT NOT NULL CHECK (node_type IN ('work_item', 'specification')),
        node_key TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY (project_id, node_id),
        UNIQUE (project_id, node_type, node_key)
      ) STRICT;

      CREATE INDEX trace_nodes_by_key
        ON trace_nodes (project_id, node_key COLLATE NOCASE);

      INSERT INTO trace_nodes (project_id, node_id, node_type, node_key)
        SELECT project_id, item_id, 'work_item', item_key FROM work_items;
      INSERT INTO trace_nodes (project_id, node_id, node_type, node_key)
        SELECT project_id, spec_id, 'specification', spec_key FROM specifications;

      CREATE TRIGGER trace_nodes_after_work_item_insert
        AFTER INSERT ON work_items
        BEGIN
          INSERT INTO trace_nodes (project_id, node_id, node_type, node_key)
          VALUES (new.project_id, new.item_id, 'work_item', new.item_key);
        END;

      CREATE TRIGGER trace_nodes_after_specification_insert
        AFTER INSERT ON specifications
        BEGIN
          INSERT INTO trace_nodes (project_id, node_id, node_type, node_key)
          VALUES (new.project_id, new.spec_id, 'specification', new.spec_key);
        END;

      CREATE TABLE trace_links (
        link_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        link_type TEXT NOT NULL CHECK (link_type IN ('depends_on', 'relates_to', 'implements')),
        created_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        created_at TEXT NOT NULL,
        removed_by_principal_id TEXT REFERENCES principals(principal_id),
        removed_at TEXT,
        FOREIGN KEY (project_id, source_id) REFERENCES trace_nodes(project_id, node_id),
        FOREIGN KEY (project_id, target_id) REFERENCES trace_nodes(project_id, node_id),
        CHECK (source_id <> target_id),
        CHECK (
          (removed_at IS NULL AND removed_by_principal_id IS NULL)
          OR
          (removed_at IS NOT NULL AND removed_by_principal_id IS NOT NULL)
        )
      ) STRICT;

      CREATE UNIQUE INDEX trace_links_unique_active
        ON trace_links (project_id, source_id, target_id, link_type) WHERE removed_at IS NULL;
      CREATE INDEX trace_links_by_source
        ON trace_links (project_id, source_id, link_type, removed_at);
      CREATE INDEX trace_links_by_target
        ON trace_links (project_id, target_id, link_type, removed_at);

      CREATE TRIGGER trace_links_validate_endpoint_types
        BEFORE INSERT ON trace_links
        BEGIN
          SELECT CASE WHEN new.link_type = 'depends_on' AND (
            (SELECT node_type FROM trace_nodes WHERE project_id = new.project_id AND node_id = new.source_id) <> 'work_item'
            OR
            (SELECT node_type FROM trace_nodes WHERE project_id = new.project_id AND node_id = new.target_id) <> 'work_item'
          ) THEN RAISE(ABORT, 'depends_on endpoints must be work items') END;
          SELECT CASE WHEN new.link_type = 'implements' AND (
            (SELECT node_type FROM trace_nodes WHERE project_id = new.project_id AND node_id = new.source_id) <> 'work_item'
            OR
            (SELECT node_type FROM trace_nodes WHERE project_id = new.project_id AND node_id = new.target_id) <> 'specification'
          ) THEN RAISE(ABORT, 'implements must link a work item to a specification') END;
        END;

      CREATE TRIGGER trace_links_immutable
        BEFORE UPDATE ON trace_links
        WHEN
          new.link_id IS NOT old.link_id OR
          new.project_id IS NOT old.project_id OR
          new.source_id IS NOT old.source_id OR
          new.target_id IS NOT old.target_id OR
          new.link_type IS NOT old.link_type OR
          new.created_by_principal_id IS NOT old.created_by_principal_id OR
          new.created_at IS NOT old.created_at OR
          old.removed_at IS NOT NULL OR
          new.removed_at IS NULL OR
          new.removed_by_principal_id IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'trace link history is immutable');
        END;

      CREATE TRIGGER trace_links_no_delete
        BEFORE DELETE ON trace_links
        BEGIN
          SELECT RAISE(ABORT, 'trace link history is immutable');
        END;
    `,
  },
  {
    version: 8,
    name: "work-item-rank-assignment-comments-estimates",
    sql: `
      ALTER TABLE work_items ADD COLUMN rank INTEGER NOT NULL DEFAULT 0 CHECK (rank >= 0);
      ALTER TABLE work_items ADD COLUMN assignee_principal_id TEXT REFERENCES principals(principal_id);

      WITH ordered_items AS (
        SELECT item_id, ROW_NUMBER() OVER (
          PARTITION BY project_id, type, parent_id ORDER BY item_key COLLATE NOCASE, item_id
        ) AS position
        FROM work_items
      )
      UPDATE work_items
        SET rank = (SELECT position * 1024 FROM ordered_items WHERE ordered_items.item_id = work_items.item_id);

      CREATE INDEX work_items_by_rank
        ON work_items (project_id, type, parent_id, rank, item_key);

      CREATE TABLE work_item_comments (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        comment_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        author_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 5000),
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id)
      ) STRICT;

      CREATE INDEX work_item_comments_by_item
        ON work_item_comments (project_id, item_id, sequence);

      CREATE TRIGGER work_item_comments_immutable_update
        BEFORE UPDATE ON work_item_comments
        BEGIN
          SELECT RAISE(ABORT, 'work item comments are immutable');
        END;

      CREATE TRIGGER work_item_comments_immutable_delete
        BEFORE DELETE ON work_item_comments
        BEGIN
          SELECT RAISE(ABORT, 'work item comments are immutable');
        END;

      CREATE TABLE work_item_estimate_proposals (
        proposal_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        unit TEXT NOT NULL CHECK (unit IN ('points', 'hours')),
        value INTEGER NOT NULL CHECK (value BETWEEN 1 AND 10000),
        rationale TEXT NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 1000),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected', 'superseded')),
        proposed_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        proposed_at TEXT NOT NULL,
        resolved_by_principal_id TEXT REFERENCES principals(principal_id),
        resolved_at TEXT,
        UNIQUE (project_id, item_id, proposal_id),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id),
        CHECK (
          (status = 'pending' AND resolved_by_principal_id IS NULL AND resolved_at IS NULL)
          OR
          (status <> 'pending' AND resolved_by_principal_id IS NOT NULL AND resolved_at IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX work_item_estimate_proposals_by_item
        ON work_item_estimate_proposals (project_id, item_id, unit, proposed_at);

      CREATE TRIGGER work_item_estimate_proposals_validate_unit
        BEFORE INSERT ON work_item_estimate_proposals
        BEGIN
          SELECT CASE WHEN new.unit = 'points' AND (
            SELECT type FROM work_items WHERE project_id = new.project_id AND item_id = new.item_id
          ) NOT IN ('story', 'bug') THEN RAISE(ABORT, 'points estimates require a story or bug') END;
          SELECT CASE WHEN new.unit = 'hours' AND (
            SELECT type FROM work_items WHERE project_id = new.project_id AND item_id = new.item_id
          ) <> 'task' THEN RAISE(ABORT, 'hour estimates require a task') END;
        END;

      CREATE TRIGGER work_item_estimate_proposals_immutable
        BEFORE UPDATE ON work_item_estimate_proposals
        WHEN
          new.proposal_id IS NOT old.proposal_id OR
          new.project_id IS NOT old.project_id OR
          new.item_id IS NOT old.item_id OR
          new.unit IS NOT old.unit OR
          new.value IS NOT old.value OR
          new.rationale IS NOT old.rationale OR
          new.proposed_by_principal_id IS NOT old.proposed_by_principal_id OR
          new.proposed_at IS NOT old.proposed_at OR
          NOT (
            (old.status = 'pending' AND new.status IN ('confirmed', 'rejected', 'superseded')
              AND new.resolved_by_principal_id IS NOT NULL AND new.resolved_at IS NOT NULL)
            OR
            (old.status = 'confirmed' AND new.status = 'superseded'
              AND new.resolved_by_principal_id IS old.resolved_by_principal_id
              AND new.resolved_at IS old.resolved_at)
          )
        BEGIN
          SELECT RAISE(ABORT, 'estimate proposal content and history are immutable');
        END;

      CREATE TRIGGER work_item_estimate_proposals_immutable_delete
        BEFORE DELETE ON work_item_estimate_proposals
        BEGIN
          SELECT RAISE(ABORT, 'estimate proposal history is immutable');
        END;

      CREATE TABLE work_item_estimates (
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        unit TEXT NOT NULL CHECK (unit IN ('points', 'hours')),
        value INTEGER NOT NULL CHECK (value BETWEEN 1 AND 10000),
        proposal_id TEXT NOT NULL,
        confirmed_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        confirmed_at TEXT NOT NULL,
        PRIMARY KEY (project_id, item_id, unit),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id),
        FOREIGN KEY (project_id, item_id, proposal_id)
          REFERENCES work_item_estimate_proposals(project_id, item_id, proposal_id)
      ) STRICT;
    `,
  },
  {
    version: 9,
    name: "publishable-work-item-revisions",
    sql: `
      ALTER TABLE work_item_revisions
        ADD COLUMN status TEXT NOT NULL DEFAULT 'published'
        CHECK (status IN ('draft', 'published', 'superseded'));
      ALTER TABLE work_item_revisions
        ADD COLUMN published_by_principal_id TEXT REFERENCES principals(principal_id);
      ALTER TABLE work_item_revisions ADD COLUMN published_at TEXT;
      ALTER TABLE work_item_criteria
        ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1));

      DROP TRIGGER work_item_revisions_no_update;
      UPDATE work_item_revisions
        SET published_by_principal_id = created_by_principal_id,
            published_at = created_at;

      CREATE UNIQUE INDEX work_item_one_published_revision
        ON work_item_revisions (project_id, item_id) WHERE status = 'published';
      CREATE UNIQUE INDEX work_item_one_draft_revision
        ON work_item_revisions (project_id, item_id) WHERE status = 'draft';
      CREATE INDEX work_item_criteria_current
        ON work_item_criteria (project_id, item_id, is_active, position);

      CREATE TRIGGER work_item_revisions_validate_insert
        BEFORE INSERT ON work_item_revisions
        WHEN
          (new.status = 'draft' AND
            (new.published_by_principal_id IS NOT NULL OR new.published_at IS NOT NULL)) OR
          (new.status = 'published' AND
            (new.published_by_principal_id IS NULL OR new.published_at IS NULL)) OR
          new.status = 'superseded'
        BEGIN
          SELECT RAISE(ABORT, 'work item revision publication metadata is invalid');
        END;

      CREATE TRIGGER work_item_revisions_validate_update
        BEFORE UPDATE ON work_item_revisions
        WHEN
          new.revision_id IS NOT old.revision_id OR
          new.project_id IS NOT old.project_id OR
          new.item_id IS NOT old.item_id OR
          new.revision_number IS NOT old.revision_number OR
          new.snapshot_json IS NOT old.snapshot_json OR
          new.created_by_principal_id IS NOT old.created_by_principal_id OR
          new.created_at IS NOT old.created_at OR
          NOT (
            (old.status = 'draft' AND new.status = 'published'
              AND old.published_by_principal_id IS NULL AND old.published_at IS NULL
              AND new.published_by_principal_id IS NOT NULL AND new.published_at IS NOT NULL)
            OR
            (old.status = 'published' AND new.status = 'superseded'
              AND new.published_by_principal_id IS old.published_by_principal_id
              AND new.published_at IS old.published_at)
          )
        BEGIN
          SELECT RAISE(ABORT, 'work item revision content is immutable');
        END;

    `,
  },
  {
    version: 10,
    name: "versioned-scenarios-coverage-and-test-runs",
    sql: `
      CREATE TABLE scenarios (
        scenario_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        scenario_key TEXT NOT NULL CHECK (length(trim(scenario_key)) BETWEEN 1 AND 32),
        kind TEXT NOT NULL CHECK (kind IN ('acceptance', 'regression', 'integration', 'performance', 'security', 'manual')),
        title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        created_at TEXT NOT NULL,
        UNIQUE (project_id, scenario_key),
        UNIQUE (project_id, scenario_id)
      ) STRICT;

      CREATE TABLE scenario_revisions (
        revision_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'superseded')),
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
        created_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        created_at TEXT NOT NULL,
        published_by_principal_id TEXT REFERENCES principals(principal_id),
        published_at TEXT,
        UNIQUE (project_id, scenario_id, revision_number),
        UNIQUE (project_id, scenario_id, revision_number, revision_id),
        FOREIGN KEY (project_id, scenario_id) REFERENCES scenarios(project_id, scenario_id),
        CHECK (
          (status = 'draft' AND published_by_principal_id IS NULL AND published_at IS NULL)
          OR
          (status IN ('published', 'superseded') AND published_by_principal_id IS NOT NULL AND published_at IS NOT NULL)
        )
      ) STRICT;

      CREATE UNIQUE INDEX scenario_one_published_revision
        ON scenario_revisions (project_id, scenario_id) WHERE status = 'published';
      CREATE UNIQUE INDEX scenario_one_draft_revision
        ON scenario_revisions (project_id, scenario_id) WHERE status = 'draft';
      CREATE INDEX scenario_revisions_by_scenario
        ON scenario_revisions (project_id, scenario_id, revision_number);

      CREATE TRIGGER scenario_revisions_validate_insert
        BEFORE INSERT ON scenario_revisions
        WHEN
          new.status <> 'draft' OR
          new.published_by_principal_id IS NOT NULL OR
          new.published_at IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'scenario revision publication metadata is invalid');
        END;

      CREATE TRIGGER scenario_revisions_immutable_update
        BEFORE UPDATE ON scenario_revisions
        WHEN
          new.revision_id IS NOT old.revision_id OR
          new.project_id IS NOT old.project_id OR
          new.scenario_id IS NOT old.scenario_id OR
          new.revision_number IS NOT old.revision_number OR
          new.snapshot_json IS NOT old.snapshot_json OR
          new.created_by_principal_id IS NOT old.created_by_principal_id OR
          new.created_at IS NOT old.created_at OR
          NOT (
            (old.status = 'draft' AND new.status = 'published'
              AND old.published_by_principal_id IS NULL AND old.published_at IS NULL
              AND new.published_by_principal_id IS NOT NULL AND new.published_at IS NOT NULL)
            OR
            (old.status = 'published' AND new.status = 'superseded'
              AND new.published_by_principal_id IS old.published_by_principal_id
              AND new.published_at IS old.published_at)
          )
        BEGIN
          SELECT RAISE(ABORT, 'scenario revision content is immutable');
        END;

      CREATE TRIGGER scenario_revisions_immutable_delete
        BEFORE DELETE ON scenario_revisions
        BEGIN
          SELECT RAISE(ABORT, 'scenario revision history is immutable');
        END;

      CREATE TABLE scenario_revision_coverage (
        project_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL,
        target_type TEXT NOT NULL CHECK (target_type IN ('criterion', 'specification')),
        target_id TEXT NOT NULL,
        FOREIGN KEY (project_id, scenario_id, revision_number)
          REFERENCES scenario_revisions(project_id, scenario_id, revision_number),
        PRIMARY KEY (project_id, scenario_id, revision_number, target_type, target_id)
      ) STRICT;

      CREATE INDEX scenario_coverage_by_target
        ON scenario_revision_coverage (project_id, target_type, target_id, scenario_id, revision_number);

      CREATE TRIGGER scenario_coverage_validate_target
        BEFORE INSERT ON scenario_revision_coverage
        BEGIN
          SELECT CASE WHEN (
            SELECT status FROM scenario_revisions
            WHERE project_id = new.project_id AND scenario_id = new.scenario_id
              AND revision_number = new.revision_number
          ) <> 'draft' THEN RAISE(ABORT, 'scenario coverage can only be added to a draft revision') END;
          SELECT CASE WHEN new.target_type = 'criterion' AND NOT EXISTS (
            SELECT 1 FROM work_item_criteria c
            WHERE c.project_id = new.project_id AND c.criterion_id = new.target_id
          ) THEN RAISE(ABORT, 'scenario criterion coverage target is invalid') END;
          SELECT CASE WHEN new.target_type = 'specification' AND NOT EXISTS (
            SELECT 1 FROM specifications s
            WHERE s.project_id = new.project_id AND s.spec_id = new.target_id
          ) THEN RAISE(ABORT, 'scenario specification coverage target is invalid') END;
        END;

      CREATE TRIGGER scenario_coverage_immutable_update
        BEFORE UPDATE ON scenario_revision_coverage
        BEGIN
          SELECT RAISE(ABORT, 'scenario coverage history is immutable');
        END;

      CREATE TRIGGER scenario_coverage_immutable_delete
        BEFORE DELETE ON scenario_revision_coverage
        BEGIN
          SELECT RAISE(ABORT, 'scenario coverage history is immutable');
        END;

      CREATE TABLE test_runs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL,
        build_id TEXT NOT NULL CHECK (length(trim(build_id)) BETWEEN 1 AND 128),
        result TEXT NOT NULL CHECK (result IN ('passed', 'failed', 'blocked', 'skipped')),
        notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
        evidence_uri TEXT CHECK (evidence_uri IS NULL OR length(evidence_uri) <= 2048),
        executed_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        executed_at TEXT NOT NULL,
        FOREIGN KEY (project_id, scenario_id, revision_number)
          REFERENCES scenario_revisions(project_id, scenario_id, revision_number)
      ) STRICT;

      CREATE INDEX test_runs_by_scenario_build
        ON test_runs (project_id, scenario_id, revision_number, build_id, sequence DESC);

      CREATE TRIGGER test_runs_require_published_scenario
        BEFORE INSERT ON test_runs
        WHEN NOT EXISTS (
          SELECT 1 FROM scenario_revisions r
          WHERE r.project_id = new.project_id AND r.scenario_id = new.scenario_id
            AND r.revision_number = new.revision_number AND r.status IN ('published', 'superseded')
        )
        BEGIN
          SELECT RAISE(ABORT, 'test runs require a published scenario revision');
        END;

      CREATE TRIGGER test_runs_immutable_update
        BEFORE UPDATE ON test_runs
        BEGIN
          SELECT RAISE(ABORT, 'test run observations are immutable');
        END;

      CREATE TRIGGER test_runs_immutable_delete
        BEFORE DELETE ON test_runs
        BEGIN
          SELECT RAISE(ABORT, 'test run history is immutable');
        END;
    `,
  },
  {
    version: 11,
    name: "work-item-baselines-and-impact-flags",
    sql: `
      CREATE TABLE work_baselines (
        baseline_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        kind TEXT NOT NULL CHECK (kind IN ('ready', 'revalidation')),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
        created_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        created_at TEXT NOT NULL,
        UNIQUE (project_id, item_id, sequence),
        UNIQUE (project_id, baseline_id),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id)
      ) STRICT;

      CREATE INDEX work_baselines_by_item
        ON work_baselines (project_id, item_id, sequence DESC);

      CREATE TRIGGER work_baselines_immutable_update
        BEFORE UPDATE ON work_baselines
        BEGIN
          SELECT RAISE(ABORT, 'baseline history is immutable');
        END;

      CREATE TRIGGER work_baselines_immutable_delete
        BEFORE DELETE ON work_baselines
        BEGIN
          SELECT RAISE(ABORT, 'baseline history is immutable');
        END;

      CREATE TABLE baseline_refs (
        project_id TEXT NOT NULL,
        baseline_id TEXT NOT NULL,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('work_item_revision', 'specification_revision', 'scenario_revision')),
        entity_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        PRIMARY KEY (project_id, baseline_id, entity_type, entity_id, revision_number),
        FOREIGN KEY (project_id, baseline_id) REFERENCES work_baselines(project_id, baseline_id)
      ) STRICT;

      CREATE INDEX baseline_refs_by_entity
        ON baseline_refs (project_id, entity_type, entity_id, revision_number);

      CREATE TRIGGER baseline_refs_validate_revision
        BEFORE INSERT ON baseline_refs
        BEGIN
          SELECT CASE WHEN new.entity_type = 'work_item_revision' AND NOT EXISTS (
            SELECT 1 FROM work_item_revisions r
            WHERE r.project_id = new.project_id AND r.item_id = new.entity_id
              AND r.revision_number = new.revision_number AND r.status = 'published'
          ) THEN RAISE(ABORT, 'baseline work item revision must be published') END;
          SELECT CASE WHEN new.entity_type = 'specification_revision' AND NOT EXISTS (
            SELECT 1 FROM specification_revisions r
            WHERE r.project_id = new.project_id AND r.spec_id = new.entity_id
              AND r.revision_number = new.revision_number AND r.status = 'published'
          ) THEN RAISE(ABORT, 'baseline specification revision must be published') END;
          SELECT CASE WHEN new.entity_type = 'scenario_revision' AND NOT EXISTS (
            SELECT 1 FROM scenario_revisions r
            WHERE r.project_id = new.project_id AND r.scenario_id = new.entity_id
              AND r.revision_number = new.revision_number AND r.status = 'published'
          ) THEN RAISE(ABORT, 'baseline scenario revision must be published') END;
        END;

      CREATE TRIGGER baseline_refs_immutable_update
        BEFORE UPDATE ON baseline_refs
        BEGIN
          SELECT RAISE(ABORT, 'baseline references are immutable');
        END;

      CREATE TRIGGER baseline_refs_immutable_delete
        BEFORE DELETE ON baseline_refs
        BEGIN
          SELECT RAISE(ABORT, 'baseline references are immutable');
        END;

      CREATE TABLE impact_flags (
        impact_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        baseline_id TEXT NOT NULL,
        specification_id TEXT NOT NULL,
        baseline_revision INTEGER NOT NULL CHECK (baseline_revision > 0),
        published_revision INTEGER NOT NULL CHECK (published_revision > baseline_revision),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'revalidated')),
        created_at TEXT NOT NULL,
        resolved_by_principal_id TEXT REFERENCES principals(principal_id),
        resolved_at TEXT,
        revalidated_baseline_id TEXT,
        UNIQUE (project_id, item_id, baseline_id, specification_id, published_revision),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id),
        FOREIGN KEY (project_id, baseline_id) REFERENCES work_baselines(project_id, baseline_id),
        FOREIGN KEY (project_id, specification_id) REFERENCES specifications(project_id, spec_id),
        FOREIGN KEY (project_id, revalidated_baseline_id) REFERENCES work_baselines(project_id, baseline_id),
        CHECK (
          (status = 'open' AND resolved_by_principal_id IS NULL AND resolved_at IS NULL AND revalidated_baseline_id IS NULL)
          OR
          (status = 'revalidated' AND resolved_by_principal_id IS NOT NULL AND resolved_at IS NOT NULL AND revalidated_baseline_id IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX impact_flags_by_item
        ON impact_flags (project_id, item_id, status, created_at DESC);

      CREATE TRIGGER impact_flags_validate_insert
        BEFORE INSERT ON impact_flags
        WHEN NOT EXISTS (
          SELECT 1 FROM baseline_refs br
          WHERE br.project_id = new.project_id AND br.baseline_id = new.baseline_id
            AND br.entity_type = 'specification_revision'
            AND br.entity_id = new.specification_id AND br.revision_number = new.baseline_revision
        )
        BEGIN
          SELECT RAISE(ABORT, 'impact must reference the specification revision in its baseline');
        END;

      CREATE TRIGGER impact_flags_validate_resolution
        BEFORE UPDATE ON impact_flags
        WHEN new.status = 'revalidated' AND NOT EXISTS (
          SELECT 1 FROM work_baselines b
          INNER JOIN baseline_refs br ON br.project_id = b.project_id AND br.baseline_id = b.baseline_id
          WHERE b.project_id = new.project_id AND b.item_id = new.item_id
            AND b.baseline_id = new.revalidated_baseline_id
            AND b.sequence > (SELECT old_b.sequence FROM work_baselines old_b WHERE old_b.project_id = old.project_id AND old_b.baseline_id = old.baseline_id)
            AND br.entity_type = 'specification_revision'
            AND br.entity_id = new.specification_id AND br.revision_number = new.published_revision
        )
        BEGIN
          SELECT RAISE(ABORT, 'impact resolution requires a newer baseline with the published revision');
        END;

      CREATE TRIGGER impact_flags_immutable_update
        BEFORE UPDATE ON impact_flags
        WHEN
          new.impact_id IS NOT old.impact_id OR
          new.project_id IS NOT old.project_id OR
          new.item_id IS NOT old.item_id OR
          new.baseline_id IS NOT old.baseline_id OR
          new.specification_id IS NOT old.specification_id OR
          new.baseline_revision IS NOT old.baseline_revision OR
          new.published_revision IS NOT old.published_revision OR
          new.reason IS NOT old.reason OR
          new.created_at IS NOT old.created_at OR
          NOT (
            old.status = 'open' AND new.status = 'revalidated'
            AND new.resolved_by_principal_id IS NOT NULL AND new.resolved_at IS NOT NULL
            AND new.revalidated_baseline_id IS NOT NULL
          )
        BEGIN
          SELECT RAISE(ABORT, 'impact history is immutable');
        END;

      CREATE TRIGGER impact_flags_immutable_delete
        BEFORE DELETE ON impact_flags
        BEGIN
          SELECT RAISE(ABORT, 'impact history is immutable');
        END;
    `,
  },
  {
    version: 12,
    name: "workflow-evidence-and-qa-certification",
    sql: `
      CREATE TABLE evidence (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        evidence_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        baseline_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('pull_request', 'commit', 'build', 'artifact', 'test_report', 'other')),
        uri TEXT NOT NULL CHECK (length(trim(uri)) BETWEEN 1 AND 2048),
        build_id TEXT CHECK (build_id IS NULL OR length(trim(build_id)) BETWEEN 1 AND 128),
        description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 2000),
        added_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id),
        FOREIGN KEY (project_id, baseline_id) REFERENCES work_baselines(project_id, baseline_id)
      ) STRICT;

      CREATE INDEX evidence_by_item
        ON evidence (project_id, item_id, sequence);
      CREATE INDEX evidence_by_build
        ON evidence (project_id, build_id, item_id);

      CREATE TRIGGER evidence_validate_baseline
        BEFORE INSERT ON evidence
        WHEN new.baseline_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM work_baselines b
          WHERE b.project_id = new.project_id AND b.baseline_id = new.baseline_id
            AND (b.item_id = new.item_id OR b.item_id = (
              SELECT parent_id FROM work_items
              WHERE project_id = new.project_id AND item_id = new.item_id AND type = 'task'
            ))
        )
        BEGIN
          SELECT RAISE(ABORT, 'evidence baseline must belong to the item or its parent PBI');
        END;

      CREATE TRIGGER evidence_immutable_update
        BEFORE UPDATE ON evidence
        BEGIN
          SELECT RAISE(ABORT, 'evidence history is immutable');
        END;
      CREATE TRIGGER evidence_immutable_delete
        BEFORE DELETE ON evidence
        BEGIN
          SELECT RAISE(ABORT, 'evidence history is immutable');
        END;

      CREATE TABLE test_run_certifications (
        certification_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        baseline_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES test_runs(run_id),
        certified_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
        certified_at TEXT NOT NULL,
        UNIQUE (project_id, item_id, baseline_id, run_id),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id),
        FOREIGN KEY (project_id, baseline_id) REFERENCES work_baselines(project_id, baseline_id)
      ) STRICT;

      CREATE INDEX test_run_certifications_by_item_baseline
        ON test_run_certifications (project_id, item_id, baseline_id, run_id);

      CREATE TRIGGER test_run_certifications_validate
        BEFORE INSERT ON test_run_certifications
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM work_baselines b
            INNER JOIN test_runs tr ON tr.project_id = b.project_id
            INNER JOIN scenario_revision_coverage c ON c.project_id = tr.project_id
              AND c.scenario_id = tr.scenario_id AND c.revision_number = tr.revision_number
            INNER JOIN baseline_refs br ON br.project_id = b.project_id AND br.baseline_id = b.baseline_id
              AND br.entity_type = 'scenario_revision' AND br.entity_id = tr.scenario_id
              AND br.revision_number = tr.revision_number
            WHERE b.project_id = new.project_id AND b.item_id = new.item_id
              AND b.baseline_id = new.baseline_id AND tr.run_id = new.run_id AND tr.result = 'passed'
              AND c.target_type IN ('criterion', 'specification')
          ) THEN RAISE(ABORT, 'certification must reference a passing scenario from the pinned baseline') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM principals p
            INNER JOIN project_memberships pm ON pm.principal_id = p.principal_id
            WHERE p.principal_id = new.certified_by_principal_id AND p.principal_type = 'human'
              AND pm.project_id = new.project_id AND pm.role = 'qa'
          ) THEN RAISE(ABORT, 'only a human QA project member can certify a test run') END;
        END;

      CREATE TRIGGER test_run_certifications_immutable_update
        BEFORE UPDATE ON test_run_certifications
        BEGIN
          SELECT RAISE(ABORT, 'test run certifications are immutable');
        END;
      CREATE TRIGGER test_run_certifications_immutable_delete
        BEFORE DELETE ON test_run_certifications
        BEGIN
          SELECT RAISE(ABORT, 'test run certifications are immutable');
        END;

      CREATE TABLE work_item_state_transitions (
        transition_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        from_state TEXT NOT NULL CHECK (from_state IN ('draft', 'ready', 'in_progress', 'in_review', 'in_validation', 'done', 'cancelled')),
        to_state TEXT NOT NULL CHECK (to_state IN ('draft', 'ready', 'in_progress', 'in_review', 'in_validation', 'done', 'cancelled')),
        item_version INTEGER NOT NULL CHECK (item_version > 0),
        baseline_id TEXT,
        build_id TEXT CHECK (build_id IS NULL OR length(trim(build_id)) BETWEEN 1 AND 128),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
        transitioned_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        transitioned_at TEXT NOT NULL,
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id),
        FOREIGN KEY (project_id, baseline_id) REFERENCES work_baselines(project_id, baseline_id)
      ) STRICT;

      CREATE INDEX work_item_transitions_by_item
        ON work_item_state_transitions (project_id, item_id, item_version);
      CREATE TRIGGER work_item_state_transitions_immutable_update
        BEFORE UPDATE ON work_item_state_transitions
        BEGIN
          SELECT RAISE(ABORT, 'work item transition history is immutable');
        END;
      CREATE TRIGGER work_item_state_transitions_immutable_delete
        BEFORE DELETE ON work_item_state_transitions
        BEGIN
          SELECT RAISE(ABORT, 'work item transition history is immutable');
        END;
    `,
  },
  {
    version: 13,
    name: "team-calendar-and-capacity",
    sql: `
      CREATE TABLE teams (
        team_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL UNIQUE REFERENCES projects(project_id),
        current_version INTEGER NOT NULL CHECK (current_version > 0),
        created_at TEXT NOT NULL,
        UNIQUE (project_id, team_id)
      ) STRICT;

      CREATE TABLE team_config_versions (
        project_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        team_name TEXT NOT NULL CHECK (length(trim(team_name)) BETWEEN 1 AND 120),
        timezone TEXT NOT NULL CHECK (length(trim(timezone)) BETWEEN 1 AND 100),
        hours_per_day REAL NOT NULL CHECK (hours_per_day > 0 AND hours_per_day <= 24),
        working_days_json TEXT NOT NULL CHECK (json_valid(working_days_json)),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
        created_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, team_id, version),
        FOREIGN KEY (project_id, team_id) REFERENCES teams(project_id, team_id)
      ) STRICT;

      CREATE TABLE team_member_capacities (
        project_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        dedication_percent REAL NOT NULL CHECK (dedication_percent >= 0 AND dedication_percent <= 100),
        active_from TEXT,
        active_until TEXT,
        PRIMARY KEY (project_id, team_id, config_version, principal_id),
        CHECK (active_from IS NULL OR active_until IS NULL OR active_from <= active_until),
        FOREIGN KEY (project_id, team_id, config_version)
          REFERENCES team_config_versions(project_id, team_id, version)
      ) STRICT;

      CREATE TABLE team_holidays (
        project_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        holiday_date TEXT NOT NULL CHECK (length(holiday_date) = 10),
        label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 200),
        PRIMARY KEY (project_id, team_id, config_version, holiday_date),
        FOREIGN KEY (project_id, team_id, config_version)
          REFERENCES team_config_versions(project_id, team_id, version)
      ) STRICT;

      CREATE TABLE team_absences (
        project_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        principal_id TEXT NOT NULL,
        absence_date TEXT NOT NULL CHECK (length(absence_date) = 10),
        hours REAL NOT NULL CHECK (hours >= 0 AND hours <= 24),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 200),
        PRIMARY KEY (project_id, team_id, config_version, principal_id, absence_date),
        FOREIGN KEY (project_id, team_id, config_version, principal_id)
          REFERENCES team_member_capacities(project_id, team_id, config_version, principal_id)
      ) STRICT;

      CREATE INDEX team_member_capacities_by_principal
        ON team_member_capacities (project_id, principal_id, config_version);
      CREATE INDEX team_absences_by_date
        ON team_absences (project_id, team_id, config_version, absence_date);

      CREATE TRIGGER team_member_capacity_validate_project_member
        BEFORE INSERT ON team_member_capacities
        WHEN NOT EXISTS (
          SELECT 1 FROM project_memberships pm
          WHERE pm.project_id = new.project_id AND pm.principal_id = new.principal_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'team members must belong to the project');
        END;

      CREATE TRIGGER team_config_versions_immutable_update
        BEFORE UPDATE ON team_config_versions
        BEGIN
          SELECT RAISE(ABORT, 'team configuration history is immutable');
        END;
      CREATE TRIGGER team_config_versions_immutable_delete
        BEFORE DELETE ON team_config_versions
        BEGIN
          SELECT RAISE(ABORT, 'team configuration history is immutable');
        END;
      CREATE TRIGGER team_member_capacities_immutable_update
        BEFORE UPDATE ON team_member_capacities
        BEGIN
          SELECT RAISE(ABORT, 'team member capacity history is immutable');
        END;
      CREATE TRIGGER team_member_capacities_immutable_delete
        BEFORE DELETE ON team_member_capacities
        BEGIN
          SELECT RAISE(ABORT, 'team member capacity history is immutable');
        END;
      CREATE TRIGGER team_holidays_immutable_update
        BEFORE UPDATE ON team_holidays
        BEGIN
          SELECT RAISE(ABORT, 'calendar history is immutable');
        END;
      CREATE TRIGGER team_holidays_immutable_delete
        BEFORE DELETE ON team_holidays
        BEGIN
          SELECT RAISE(ABORT, 'calendar history is immutable');
        END;
      CREATE TRIGGER team_absences_immutable_update
        BEFORE UPDATE ON team_absences
        BEGIN
          SELECT RAISE(ABORT, 'absence history is immutable');
        END;
      CREATE TRIGGER team_absences_immutable_delete
        BEFORE DELETE ON team_absences
        BEGIN
          SELECT RAISE(ABORT, 'absence history is immutable');
        END;
    `,
  },
  {
    version: 14,
    name: "definition-of-done-and-sprint-planning",
    sql: `
      CREATE TABLE dod_revisions (
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        criteria_json TEXT NOT NULL CHECK (json_valid(criteria_json)),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
        created_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, revision_number)
      ) STRICT;

      CREATE TRIGGER dod_revisions_immutable_update
        BEFORE UPDATE ON dod_revisions
        BEGIN
          SELECT RAISE(ABORT, 'definition of done history is immutable');
        END;
      CREATE TRIGGER dod_revisions_immutable_delete
        BEFORE DELETE ON dod_revisions
        BEGIN
          SELECT RAISE(ABORT, 'definition of done history is immutable');
        END;

      CREATE TABLE sprints (
        sprint_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        sprint_key TEXT NOT NULL,
        title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
        goal TEXT NOT NULL CHECK (length(trim(goal)) BETWEEN 1 AND 1000),
        starts_on TEXT NOT NULL CHECK (length(starts_on) = 10),
        ends_on TEXT NOT NULL CHECK (length(ends_on) = 10),
        status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'closed', 'cancelled')),
        team_id TEXT NOT NULL,
        capacity_config_version INTEGER NOT NULL CHECK (capacity_config_version > 0),
        dod_revision_number INTEGER NOT NULL CHECK (dod_revision_number > 0),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        created_at TEXT NOT NULL,
        started_at TEXT,
        closed_at TEXT,
        cancelled_at TEXT,
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
        review_summary TEXT,
        started_snapshot_json TEXT CHECK (started_snapshot_json IS NULL OR json_valid(started_snapshot_json)),
        closed_snapshot_json TEXT CHECK (closed_snapshot_json IS NULL OR json_valid(closed_snapshot_json)),
        UNIQUE (project_id, sprint_key),
        UNIQUE (project_id, sprint_id),
        FOREIGN KEY (project_id, team_id, capacity_config_version)
          REFERENCES team_config_versions(project_id, team_id, version),
        FOREIGN KEY (project_id, dod_revision_number)
          REFERENCES dod_revisions(project_id, revision_number),
        CHECK (starts_on <= ends_on)
      ) STRICT;

      CREATE UNIQUE INDEX one_active_sprint_per_project
        ON sprints (project_id) WHERE status = 'active';
      CREATE INDEX sprints_by_project_dates
        ON sprints (project_id, starts_on, sprint_key);

      CREATE TABLE sprint_scope_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_event_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        sprint_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        item_title TEXT NOT NULL,
        item_state TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('add', 'remove')),
        baseline_id TEXT NOT NULL,
        item_revision_number INTEGER NOT NULL CHECK (item_revision_number > 0),
        points INTEGER NOT NULL CHECK (points > 0),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
        changed_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        changed_at TEXT NOT NULL,
        FOREIGN KEY (project_id, sprint_id) REFERENCES sprints(project_id, sprint_id),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id),
        FOREIGN KEY (project_id, baseline_id) REFERENCES work_baselines(project_id, baseline_id)
      ) STRICT;

      CREATE INDEX sprint_scope_events_by_sprint
        ON sprint_scope_events (project_id, sprint_id, sequence);
      CREATE INDEX sprint_scope_events_by_item
        ON sprint_scope_events (project_id, item_id, sprint_id, sequence);

      CREATE TRIGGER sprint_scope_events_immutable_update
        BEFORE UPDATE ON sprint_scope_events
        BEGIN
          SELECT RAISE(ABORT, 'sprint scope history is immutable');
        END;
      CREATE TRIGGER sprint_scope_events_immutable_delete
        BEFORE DELETE ON sprint_scope_events
        BEGIN
          SELECT RAISE(ABORT, 'sprint scope history is immutable');
        END;

      CREATE TABLE sprint_state_transitions (
        transition_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        sprint_id TEXT NOT NULL,
        from_state TEXT NOT NULL CHECK (from_state IN ('draft', 'active', 'closed', 'cancelled')),
        to_state TEXT NOT NULL CHECK (to_state IN ('draft', 'active', 'closed', 'cancelled')),
        sprint_version INTEGER NOT NULL CHECK (sprint_version > 0),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
        transitioned_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        transitioned_at TEXT NOT NULL,
        FOREIGN KEY (project_id, sprint_id) REFERENCES sprints(project_id, sprint_id)
      ) STRICT;

      CREATE INDEX sprint_state_transitions_by_sprint
        ON sprint_state_transitions (project_id, sprint_id, sprint_version);
      CREATE TRIGGER sprint_state_transitions_immutable_update
        BEFORE UPDATE ON sprint_state_transitions
        BEGIN
          SELECT RAISE(ABORT, 'sprint transition history is immutable');
        END;
      CREATE TRIGGER sprint_state_transitions_immutable_delete
        BEFORE DELETE ON sprint_state_transitions
        BEGIN
          SELECT RAISE(ABORT, 'sprint transition history is immutable');
        END;
    `,
  },
  {
    version: 15,
    name: "sprint-retrospectives",
    sql: `
      CREATE TABLE sprint_retrospectives (
        project_id TEXT NOT NULL,
        sprint_id TEXT NOT NULL,
        current_version INTEGER NOT NULL CHECK (current_version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, sprint_id),
        FOREIGN KEY (project_id, sprint_id) REFERENCES sprints(project_id, sprint_id)
      ) STRICT;

      CREATE TABLE sprint_retrospective_revisions (
        project_id TEXT NOT NULL,
        sprint_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 2000),
        keep_doing_json TEXT NOT NULL CHECK (json_valid(keep_doing_json)),
        stop_doing_json TEXT NOT NULL CHECK (json_valid(stop_doing_json)),
        try_next_json TEXT NOT NULL CHECK (json_valid(try_next_json)),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
        created_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, sprint_id, revision_number),
        FOREIGN KEY (project_id, sprint_id) REFERENCES sprint_retrospectives(project_id, sprint_id)
      ) STRICT;

      CREATE TABLE sprint_retrospective_actions (
        project_id TEXT NOT NULL,
        sprint_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        action_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position > 0),
        title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 300),
        owner_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        linked_work_item_id TEXT,
        PRIMARY KEY (project_id, sprint_id, revision_number, action_id),
        UNIQUE (project_id, sprint_id, revision_number, position),
        FOREIGN KEY (project_id, sprint_id, revision_number)
          REFERENCES sprint_retrospective_revisions(project_id, sprint_id, revision_number),
        FOREIGN KEY (project_id, linked_work_item_id)
          REFERENCES work_items(project_id, item_id)
      ) STRICT;

      CREATE INDEX sprint_retrospective_revisions_by_sprint
        ON sprint_retrospective_revisions (project_id, sprint_id, revision_number DESC);
      CREATE INDEX sprint_retrospective_actions_by_owner
        ON sprint_retrospective_actions (project_id, owner_principal_id, sprint_id);
      CREATE INDEX sprint_retrospective_actions_by_item
        ON sprint_retrospective_actions (project_id, linked_work_item_id);

      CREATE TRIGGER sprint_retrospectives_validate_closed_sprint_insert
        BEFORE INSERT ON sprint_retrospectives
        WHEN NOT EXISTS (
          SELECT 1 FROM sprints s
          WHERE s.project_id = new.project_id AND s.sprint_id = new.sprint_id AND s.status = 'closed'
        )
        BEGIN
          SELECT RAISE(ABORT, 'retrospective requires a closed sprint');
        END;
      CREATE TRIGGER sprint_retrospectives_validate_version_update
        BEFORE UPDATE ON sprint_retrospectives
        WHEN new.project_id <> old.project_id OR new.sprint_id <> old.sprint_id
          OR new.current_version <> old.current_version + 1
          OR new.created_at <> old.created_at
        BEGIN
          SELECT RAISE(ABORT, 'retrospective version must advance by one');
        END;
      CREATE TRIGGER sprint_retrospectives_immutable_delete
        BEFORE DELETE ON sprint_retrospectives
        BEGIN
          SELECT RAISE(ABORT, 'retrospective history is immutable');
        END;

      CREATE TRIGGER sprint_retrospective_revisions_validate_closed_sprint
        BEFORE INSERT ON sprint_retrospective_revisions
        WHEN NOT EXISTS (
          SELECT 1 FROM sprints s
          WHERE s.project_id = new.project_id AND s.sprint_id = new.sprint_id AND s.status = 'closed'
        )
        BEGIN
          SELECT RAISE(ABORT, 'retrospective requires a closed sprint');
        END;
      CREATE TRIGGER sprint_retrospective_revisions_validate_human_author
        BEFORE INSERT ON sprint_retrospective_revisions
        WHEN NOT EXISTS (
          SELECT 1 FROM principals p
          INNER JOIN project_memberships pm ON pm.principal_id = p.principal_id
          WHERE p.principal_id = new.created_by_principal_id AND p.principal_type = 'human'
            AND pm.project_id = new.project_id AND pm.role = 'facilitator'
        )
        BEGIN
          SELECT RAISE(ABORT, 'retrospective requires a human facilitator');
        END;
      CREATE TRIGGER sprint_retrospective_revisions_immutable_update
        BEFORE UPDATE ON sprint_retrospective_revisions
        BEGIN
          SELECT RAISE(ABORT, 'retrospective revision history is immutable');
        END;
      CREATE TRIGGER sprint_retrospective_revisions_immutable_delete
        BEFORE DELETE ON sprint_retrospective_revisions
        BEGIN
          SELECT RAISE(ABORT, 'retrospective revision history is immutable');
        END;

      CREATE TRIGGER sprint_retrospective_actions_validate_human_member
        BEFORE INSERT ON sprint_retrospective_actions
        WHEN NOT EXISTS (
          SELECT 1 FROM principals p
          INNER JOIN project_memberships pm ON pm.principal_id = p.principal_id
          WHERE p.principal_id = new.owner_principal_id AND p.principal_type = 'human'
            AND pm.project_id = new.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'retrospective action owner must be a human project member');
        END;
      CREATE TRIGGER sprint_retrospective_actions_validate_linked_pbi
        BEFORE INSERT ON sprint_retrospective_actions
        WHEN new.linked_work_item_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM work_items wi
          WHERE wi.project_id = new.project_id AND wi.item_id = new.linked_work_item_id
            AND wi.type IN ('story', 'bug')
        )
        BEGIN
          SELECT RAISE(ABORT, 'retrospective action link must reference a PBI in the same project');
        END;
      CREATE TRIGGER sprint_retrospective_actions_immutable_update
        BEFORE UPDATE ON sprint_retrospective_actions
        BEGIN
          SELECT RAISE(ABORT, 'retrospective action history is immutable');
        END;
      CREATE TRIGGER sprint_retrospective_actions_immutable_delete
        BEFORE DELETE ON sprint_retrospective_actions
        BEGIN
          SELECT RAISE(ABORT, 'retrospective action history is immutable');
        END;
    `,
  },
  {
    version: 16,
    name: "milestones-approved-scope-and-team-generations",
    sql: `
      ALTER TABLE teams
        ADD COLUMN current_generation INTEGER NOT NULL DEFAULT 0 CHECK (current_generation >= 0);
      ALTER TABLE team_config_versions
        ADD COLUMN generation_number INTEGER NOT NULL DEFAULT 0 CHECK (generation_number >= 0);

      CREATE INDEX team_config_versions_by_generation
        ON team_config_versions (project_id, team_id, generation_number, version);

      CREATE TRIGGER teams_validate_generation_update
        BEFORE UPDATE OF current_generation ON teams
        WHEN new.current_generation < old.current_generation
          OR new.current_generation > old.current_generation + 1
        BEGIN
          SELECT RAISE(ABORT, 'team generation must stay the same or advance by one');
        END;

      CREATE TABLE milestones (
        milestone_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        milestone_key TEXT NOT NULL COLLATE NOCASE,
        title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
        goal TEXT NOT NULL CHECK (length(trim(goal)) BETWEEN 1 AND 1000),
        target_date TEXT NOT NULL CHECK (length(target_date) = 10),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
        UNIQUE (project_id, milestone_key),
        UNIQUE (project_id, milestone_id)
      ) STRICT;

      CREATE INDEX milestones_by_project_target
        ON milestones (project_id, target_date, milestone_key);

      CREATE TRIGGER milestones_validate_update
        BEFORE UPDATE ON milestones
        WHEN new.project_id <> old.project_id OR new.milestone_id <> old.milestone_id
          OR new.milestone_key <> old.milestone_key OR new.title <> old.title
          OR new.goal <> old.goal OR new.target_date <> old.target_date
          OR new.created_by_principal_id <> old.created_by_principal_id
          OR new.created_at <> old.created_at OR new.reason <> old.reason
          OR new.version <> old.version + 1
        BEGIN
          SELECT RAISE(ABORT, 'milestone scope version must advance by one');
        END;
      CREATE TRIGGER milestones_immutable_delete
        BEFORE DELETE ON milestones
        BEGIN
          SELECT RAISE(ABORT, 'milestone history is immutable');
        END;

      CREATE TABLE milestone_scope_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_event_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        milestone_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        item_title TEXT NOT NULL,
        item_state TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('add', 'remove')),
        baseline_id TEXT NOT NULL,
        item_revision_number INTEGER NOT NULL CHECK (item_revision_number > 0),
        points INTEGER NOT NULL CHECK (points > 0),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
        changed_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        changed_at TEXT NOT NULL,
        FOREIGN KEY (project_id, milestone_id) REFERENCES milestones(project_id, milestone_id),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id),
        FOREIGN KEY (project_id, baseline_id) REFERENCES work_baselines(project_id, baseline_id)
      ) STRICT;

      CREATE INDEX milestone_scope_events_by_milestone
        ON milestone_scope_events (project_id, milestone_id, sequence);
      CREATE INDEX milestone_scope_events_by_item
        ON milestone_scope_events (project_id, item_id, milestone_id, sequence);

      CREATE TRIGGER milestone_scope_events_validate_pbi
        BEFORE INSERT ON milestone_scope_events
        WHEN NOT EXISTS (
          SELECT 1 FROM work_items wi
          WHERE wi.project_id = new.project_id AND wi.item_id = new.item_id
            AND wi.type IN ('story', 'bug')
        )
        BEGIN
          SELECT RAISE(ABORT, 'milestone scope can contain only PBIs in the same project');
        END;
      CREATE TRIGGER milestone_scope_events_immutable_update
        BEFORE UPDATE ON milestone_scope_events
        BEGIN
          SELECT RAISE(ABORT, 'milestone scope history is immutable');
        END;
      CREATE TRIGGER milestone_scope_events_immutable_delete
        BEFORE DELETE ON milestone_scope_events
        BEGIN
          SELECT RAISE(ABORT, 'milestone scope history is immutable');
        END;
    `,
  },
  {
    version: 17,
    name: "immutable-milestone-forecast-snapshots",
    sql: `
      CREATE TABLE milestone_forecast_snapshots (
        forecast_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        milestone_id TEXT NOT NULL,
        algorithm_version TEXT NOT NULL CHECK (length(trim(algorithm_version)) BETWEEN 1 AND 32),
        as_of_date TEXT NOT NULL CHECK (length(as_of_date) = 10),
        watermark_sequence INTEGER NOT NULL CHECK (watermark_sequence >= 0),
        calculated_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
        calculation_input_json TEXT NOT NULL CHECK (json_valid(calculation_input_json)),
        UNIQUE (project_id, milestone_id, algorithm_version, as_of_date, watermark_sequence),
        FOREIGN KEY (project_id, milestone_id) REFERENCES milestones(project_id, milestone_id)
      ) STRICT;

      CREATE INDEX milestone_forecast_snapshots_by_history
        ON milestone_forecast_snapshots (project_id, milestone_id, watermark_sequence DESC, calculated_at DESC);

      CREATE TRIGGER milestone_forecast_snapshots_immutable_update
        BEFORE UPDATE ON milestone_forecast_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'forecast history is immutable');
        END;
      CREATE TRIGGER milestone_forecast_snapshots_immutable_delete
        BEFORE DELETE ON milestone_forecast_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'forecast history is immutable');
        END;
    `,
  },
  {
    version: 18,
    name: "single-use-tool-approvals",
    sql: `
      CREATE TABLE command_approvals (
        approval_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        tool_name TEXT NOT NULL CHECK (length(trim(tool_name)) BETWEEN 1 AND 120),
        arguments_hash TEXT NOT NULL CHECK (length(arguments_hash) = 64),
        expected_version INTEGER CHECK (expected_version IS NULL OR expected_version >= 0),
        executor_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        approved_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        consumed_by_principal_id TEXT REFERENCES principals(principal_id),
        revoked_at TEXT,
        revoked_by_principal_id TEXT REFERENCES principals(principal_id),
        CHECK ((consumed_at IS NULL) = (consumed_by_principal_id IS NULL)),
        CHECK ((revoked_at IS NULL) = (revoked_by_principal_id IS NULL)),
        CHECK (consumed_at IS NULL OR revoked_at IS NULL)
      ) STRICT;

      CREATE INDEX command_approvals_by_executor
        ON command_approvals (project_id, executor_principal_id, expires_at);

      CREATE TRIGGER command_approvals_binding_immutable
        BEFORE UPDATE ON command_approvals
        WHEN old.approval_id IS NOT new.approval_id
          OR old.project_id IS NOT new.project_id
          OR old.tool_name IS NOT new.tool_name
          OR old.arguments_hash IS NOT new.arguments_hash
          OR old.expected_version IS NOT new.expected_version
          OR old.executor_principal_id IS NOT new.executor_principal_id
          OR old.approved_by_principal_id IS NOT new.approved_by_principal_id
          OR old.issued_at IS NOT new.issued_at
          OR old.expires_at IS NOT new.expires_at
        BEGIN
          SELECT RAISE(ABORT, 'tool approval bindings are immutable');
        END;

      CREATE TRIGGER command_approvals_status_transition
        BEFORE UPDATE ON command_approvals
        WHEN NOT (
          old.consumed_at IS NULL AND old.revoked_at IS NULL
          AND new.consumed_at IS NOT NULL AND new.revoked_at IS NULL
          AND old.revoked_by_principal_id IS new.revoked_by_principal_id
          OR old.consumed_at IS NULL AND old.revoked_at IS NULL
          AND new.consumed_at IS NULL AND new.revoked_at IS NOT NULL
          AND old.consumed_by_principal_id IS new.consumed_by_principal_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'tool approval can only be consumed or revoked once');
        END;
    `,
  },
  {
    version: 19,
    name: "authenticated-webhook-receipts",
    sql: `
      CREATE TABLE webhook_receipts (
        receipt_id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 64),
        delivery_id TEXT NOT NULL CHECK (length(trim(delivery_id)) BETWEEN 1 AND 128),
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        event_type TEXT NOT NULL CHECK (length(trim(event_type)) BETWEEN 1 AND 120),
        payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
        receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
        received_at TEXT NOT NULL,
        PRIMARY KEY (provider, delivery_id)
      ) STRICT;

      CREATE INDEX webhook_receipts_by_project_received
        ON webhook_receipts (project_id, received_at DESC);

      CREATE TRIGGER webhook_receipts_immutable_update
        BEFORE UPDATE ON webhook_receipts
        BEGIN
          SELECT RAISE(ABORT, 'webhook receipts are immutable');
        END;

      CREATE TRIGGER webhook_receipts_immutable_delete
        BEFORE DELETE ON webhook_receipts
        BEGIN
          SELECT RAISE(ABORT, 'webhook receipts are immutable');
        END;
    `,
  },
  {
    version: 20,
    name: "github-pull-request-and-workflow-references",
    sql: `
      CREATE TABLE github_pull_request_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        receipt_id TEXT NOT NULL UNIQUE REFERENCES webhook_receipts(receipt_id),
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        repository_id TEXT NOT NULL CHECK (length(trim(repository_id)) BETWEEN 1 AND 32),
        repository_full_name TEXT NOT NULL CHECK (length(trim(repository_full_name)) BETWEEN 3 AND 201),
        pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
        action TEXT NOT NULL CHECK (action IN ('opened', 'reopened', 'synchronize', 'edited', 'closed', 'ready_for_review', 'converted_to_draft')),
        html_url TEXT NOT NULL CHECK (length(trim(html_url)) BETWEEN 1 AND 2048),
        title TEXT NOT NULL CHECK (length(title) <= 500),
        state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
        merged INTEGER NOT NULL CHECK (merged IN (0, 1)),
        draft INTEGER NOT NULL CHECK (draft IN (0, 1)),
        head_ref TEXT NOT NULL CHECK (length(head_ref) <= 255),
        head_sha TEXT NOT NULL CHECK (length(head_sha) IN (40, 64) AND head_sha NOT GLOB '*[^a-fA-F0-9]*'),
        base_ref TEXT NOT NULL CHECK (length(base_ref) <= 255),
        base_sha TEXT NOT NULL CHECK (length(base_sha) IN (40, 64) AND base_sha NOT GLOB '*[^a-fA-F0-9]*'),
        work_item_id TEXT,
        work_item_key TEXT CHECK (work_item_key IS NULL OR length(work_item_key) BETWEEN 3 AND 80),
        received_at TEXT NOT NULL,
        FOREIGN KEY (project_id, work_item_id) REFERENCES work_items(project_id, item_id)
      ) STRICT;

      CREATE INDEX github_pull_request_events_latest
        ON github_pull_request_events (project_id, repository_full_name, pull_request_number, sequence DESC);
      CREATE INDEX github_pull_request_events_by_item
        ON github_pull_request_events (project_id, work_item_id, sequence DESC);

      CREATE TRIGGER github_pull_request_events_immutable_update
        BEFORE UPDATE ON github_pull_request_events
        BEGIN
          SELECT RAISE(ABORT, 'GitHub pull request events are immutable');
        END;

      CREATE TRIGGER github_pull_request_events_immutable_delete
        BEFORE DELETE ON github_pull_request_events
        BEGIN
          SELECT RAISE(ABORT, 'GitHub pull request events are immutable');
        END;

      CREATE TABLE github_workflow_run_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        receipt_id TEXT NOT NULL UNIQUE REFERENCES webhook_receipts(receipt_id),
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        repository_id TEXT NOT NULL CHECK (length(trim(repository_id)) BETWEEN 1 AND 32),
        repository_full_name TEXT NOT NULL CHECK (length(trim(repository_full_name)) BETWEEN 3 AND 201),
        workflow_run_id TEXT NOT NULL CHECK (length(trim(workflow_run_id)) BETWEEN 1 AND 32),
        run_number INTEGER NOT NULL CHECK (run_number > 0),
        name TEXT CHECK (name IS NULL OR length(name) <= 200),
        status TEXT NOT NULL CHECK (length(trim(status)) BETWEEN 1 AND 40),
        conclusion TEXT CHECK (conclusion IS NULL OR length(conclusion) <= 40),
        html_url TEXT NOT NULL CHECK (length(trim(html_url)) BETWEEN 1 AND 2048),
        head_branch TEXT NOT NULL CHECK (length(head_branch) <= 255),
        head_sha TEXT NOT NULL CHECK (length(head_sha) IN (40, 64) AND head_sha NOT GLOB '*[^a-fA-F0-9]*'),
        pull_request_numbers_json TEXT NOT NULL CHECK (json_valid(pull_request_numbers_json)),
        work_item_id TEXT,
        work_item_key TEXT CHECK (work_item_key IS NULL OR length(work_item_key) BETWEEN 3 AND 80),
        received_at TEXT NOT NULL,
        FOREIGN KEY (project_id, work_item_id) REFERENCES work_items(project_id, item_id)
      ) STRICT;

      CREATE INDEX github_workflow_run_events_latest
        ON github_workflow_run_events (project_id, repository_full_name, workflow_run_id, sequence DESC);
      CREATE INDEX github_workflow_run_events_by_item
        ON github_workflow_run_events (project_id, work_item_id, sequence DESC);

      CREATE TRIGGER github_workflow_run_events_immutable_update
        BEFORE UPDATE ON github_workflow_run_events
        BEGIN
          SELECT RAISE(ABORT, 'GitHub workflow run events are immutable');
        END;

      CREATE TRIGGER github_workflow_run_events_immutable_delete
        BEFORE DELETE ON github_workflow_run_events
        BEGIN
          SELECT RAISE(ABORT, 'GitHub workflow run events are immutable');
        END;
    `,
  },
  {
    version: 21,
    name: "external-work-item-import-links-and-snapshots",
    sql: `
      CREATE TABLE external_work_item_links (
        external_link_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        provider TEXT NOT NULL CHECK (provider IN ('github', 'azure-devops')),
        external_scope TEXT NOT NULL CHECK (length(trim(external_scope)) BETWEEN 1 AND 240),
        external_id TEXT NOT NULL CHECK (length(trim(external_id)) BETWEEN 1 AND 64),
        source_url TEXT NOT NULL CHECK (length(trim(source_url)) BETWEEN 1 AND 2048),
        work_item_id TEXT NOT NULL,
        work_item_type TEXT NOT NULL CHECK (work_item_type IN ('story', 'bug')),
        linked_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        linked_at TEXT NOT NULL,
        UNIQUE (provider, external_scope, external_id),
        UNIQUE (project_id, work_item_id),
        FOREIGN KEY (project_id, work_item_id) REFERENCES work_items(project_id, item_id)
      ) STRICT;

      CREATE INDEX external_work_item_links_by_project
        ON external_work_item_links (project_id, provider, external_scope);

      CREATE TABLE external_work_item_snapshots (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id TEXT NOT NULL UNIQUE,
        external_link_id TEXT NOT NULL REFERENCES external_work_item_links(external_link_id),
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
        source_json TEXT NOT NULL CHECK (json_valid(source_json)),
        observed_at TEXT NOT NULL,
        UNIQUE (external_link_id, source_sha256)
      ) STRICT;

      CREATE INDEX external_work_item_snapshots_latest
        ON external_work_item_snapshots (external_link_id, sequence DESC);

      CREATE TRIGGER external_work_item_links_immutable_update
        BEFORE UPDATE ON external_work_item_links
        BEGIN
          SELECT RAISE(ABORT, 'external work item links are immutable');
        END;

      CREATE TRIGGER external_work_item_links_immutable_delete
        BEFORE DELETE ON external_work_item_links
        BEGIN
          SELECT RAISE(ABORT, 'external work item links are immutable');
        END;

      CREATE TRIGGER external_work_item_snapshots_immutable_update
        BEFORE UPDATE ON external_work_item_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'external work item snapshots are immutable');
        END;

      CREATE TRIGGER external_work_item_snapshots_immutable_delete
        BEFORE DELETE ON external_work_item_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'external work item snapshots are immutable');
        END;

      CREATE TABLE external_work_item_import_runs (
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        provider TEXT NOT NULL CHECK (provider IN ('github', 'azure-devops')),
        request_id TEXT NOT NULL CHECK (length(trim(request_id)) BETWEEN 1 AND 128),
        plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64),
        principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, provider, request_id)
      ) STRICT;

      CREATE TRIGGER external_work_item_import_runs_immutable_update
        BEFORE UPDATE ON external_work_item_import_runs
        BEGIN
          SELECT RAISE(ABORT, 'external work item import runs are immutable');
        END;

      CREATE TRIGGER external_work_item_import_runs_immutable_delete
        BEFORE DELETE ON external_work_item_import_runs
        BEGIN
          SELECT RAISE(ABORT, 'external work item import runs are immutable');
        END;
    `,
  },
  {
    version: 22,
    name: "multiple-teams-per-project-and-legacy-default-team",
    checksumKey: "seed-default-teams-with-uuid-v5-v1",
    disableForeignKeysForRebuild: true,
    sql: `
      CREATE TABLE teams_v22 (
        team_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        current_version INTEGER NOT NULL CHECK (current_version >= 0),
        current_generation INTEGER NOT NULL CHECK (current_generation >= 0),
        created_at TEXT NOT NULL,
        UNIQUE (project_id, team_id)
      ) STRICT;

      INSERT INTO teams_v22 (team_id, project_id, current_version, current_generation, created_at)
        SELECT team_id, project_id, current_version, current_generation, created_at FROM teams;

      DROP TABLE teams;
      ALTER TABLE teams_v22 RENAME TO teams;

      CREATE TRIGGER teams_validate_generation_update
        BEFORE UPDATE OF current_generation ON teams
        WHEN new.current_generation < old.current_generation
          OR new.current_generation > old.current_generation + 1
        BEGIN
          SELECT RAISE(ABORT, 'team generation must stay the same or advance by one');
        END;

      CREATE TRIGGER teams_prevent_reset_to_unconfigured
        BEFORE UPDATE OF current_version ON teams
        WHEN new.current_version = 0
          AND EXISTS (
            SELECT 1 FROM team_config_versions config
            WHERE config.project_id = old.project_id AND config.team_id = old.team_id
          )
        BEGIN
          SELECT RAISE(ABORT, 'configured teams cannot return to version zero');
        END;

      CREATE TRIGGER team_config_versions_require_current_head
        BEFORE INSERT ON team_config_versions
        WHEN NOT EXISTS (
          SELECT 1 FROM teams team
          WHERE team.project_id = new.project_id
            AND team.team_id = new.team_id
            AND team.current_version = new.version
            AND team.current_version > 0
        )
        BEGIN
          SELECT RAISE(ABORT, 'team configuration must match the current team version');
        END;
    `,
    afterApply: seedDefaultTeamsAndVerifyForeignKeys,
  },
  {
    version: 23,
    name: "scope-sprints-and-forecast-history-by-team",
    sql: `
      DROP INDEX one_active_sprint_per_project;
      CREATE UNIQUE INDEX one_active_sprint_per_team
        ON sprints (project_id, team_id) WHERE status = 'active';

      CREATE TABLE milestone_forecast_snapshots_v23 (
        forecast_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        milestone_id TEXT NOT NULL,
        team_id TEXT,
        algorithm_version TEXT NOT NULL CHECK (length(trim(algorithm_version)) BETWEEN 1 AND 32),
        as_of_date TEXT NOT NULL CHECK (length(as_of_date) = 10),
        watermark_sequence INTEGER NOT NULL CHECK (watermark_sequence >= 0),
        calculated_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
        calculation_input_json TEXT NOT NULL CHECK (json_valid(calculation_input_json)),
        FOREIGN KEY (project_id, milestone_id) REFERENCES milestones(project_id, milestone_id),
        FOREIGN KEY (project_id, team_id) REFERENCES teams(project_id, team_id)
      ) STRICT;

      INSERT INTO milestone_forecast_snapshots_v23
        (forecast_id, project_id, milestone_id, team_id, algorithm_version, as_of_date,
         watermark_sequence, calculated_at, snapshot_json, calculation_input_json)
      SELECT forecast_id, project_id, milestone_id, json_extract(snapshot_json, '$.teamId'),
             algorithm_version, as_of_date, watermark_sequence, calculated_at,
             snapshot_json, calculation_input_json
      FROM milestone_forecast_snapshots;

      DROP TABLE milestone_forecast_snapshots;
      ALTER TABLE milestone_forecast_snapshots_v23 RENAME TO milestone_forecast_snapshots;

      CREATE UNIQUE INDEX milestone_forecast_snapshots_unique_team_history
        ON milestone_forecast_snapshots
          (project_id, milestone_id, COALESCE(team_id, ''), algorithm_version, as_of_date, watermark_sequence);
      CREATE INDEX milestone_forecast_snapshots_by_history
        ON milestone_forecast_snapshots
          (project_id, milestone_id, team_id, watermark_sequence DESC, calculated_at DESC);

      CREATE TRIGGER milestone_forecast_snapshots_immutable_update
        BEFORE UPDATE ON milestone_forecast_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'forecast history is immutable');
        END;
      CREATE TRIGGER milestone_forecast_snapshots_immutable_delete
        BEFORE DELETE ON milestone_forecast_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'forecast history is immutable');
        END;
    `,
  },
  {
    version: 24,
    name: "index-test-run-history-by-project-and-scenario",
    sql: `
      CREATE INDEX test_runs_by_project_sequence
        ON test_runs (project_id, sequence DESC);
      CREATE INDEX test_runs_by_scenario_sequence
        ON test_runs (project_id, scenario_id, sequence DESC);
    `,
  },
  {
    version: 25,
    name: "development-sessions-release-events-and-task-qa-links",
    sql: `
      CREATE TABLE development_sessions (
        session_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        developer_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        session_reference TEXT CHECK (session_reference IS NULL OR length(trim(session_reference)) BETWEEN 1 AND 160),
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
        started_at TEXT NOT NULL,
        last_resumed_at TEXT,
        ended_at TEXT,
        active_seconds INTEGER NOT NULL DEFAULT 0 CHECK (active_seconds >= 0),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id),
        UNIQUE (project_id, session_id),
        CHECK ((status = 'active' AND last_resumed_at IS NOT NULL AND ended_at IS NULL)
          OR (status = 'paused' AND last_resumed_at IS NULL AND ended_at IS NULL)
          OR (status IN ('completed', 'cancelled') AND last_resumed_at IS NULL AND ended_at IS NOT NULL))
      ) STRICT;

      CREATE UNIQUE INDEX development_sessions_one_active_per_task
        ON development_sessions (project_id, item_id) WHERE status = 'active';
      CREATE UNIQUE INDEX development_sessions_one_open_per_developer_task
        ON development_sessions (project_id, item_id, developer_principal_id) WHERE status IN ('active', 'paused');
      CREATE INDEX development_sessions_by_developer
        ON development_sessions (project_id, developer_principal_id, started_at DESC);

      CREATE TABLE development_session_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('started', 'paused', 'resumed', 'completed', 'cancelled')),
        principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        occurred_at TEXT NOT NULL,
        reason TEXT,
        FOREIGN KEY (project_id, session_id) REFERENCES development_sessions(project_id, session_id)
      ) STRICT;
      CREATE INDEX development_session_events_by_session
        ON development_session_events (project_id, session_id, sequence);
      CREATE TRIGGER development_session_events_immutable_update
        BEFORE UPDATE ON development_session_events
        BEGIN SELECT RAISE(ABORT, 'development session event history is immutable'); END;
      CREATE TRIGGER development_session_events_immutable_delete
        BEFORE DELETE ON development_session_events
        BEGIN SELECT RAISE(ABORT, 'development session event history is immutable'); END;

      CREATE TABLE development_session_spec_refs (
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        spec_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL,
        captured_at TEXT NOT NULL,
        PRIMARY KEY (project_id, session_id, spec_id),
        FOREIGN KEY (project_id, session_id) REFERENCES development_sessions(project_id, session_id),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id),
        FOREIGN KEY (project_id, spec_id, revision_number)
          REFERENCES specification_revisions(project_id, spec_id, revision_number)
      ) STRICT;
      CREATE TRIGGER development_session_spec_refs_immutable_update
        BEFORE UPDATE ON development_session_spec_refs
        BEGIN SELECT RAISE(ABORT, 'session technical specification references are immutable'); END;
      CREATE TRIGGER development_session_spec_refs_immutable_delete
        BEFORE DELETE ON development_session_spec_refs
        BEGIN SELECT RAISE(ABORT, 'session technical specification references are immutable'); END;

      CREATE TABLE scenario_revision_work_items (
        project_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL,
        item_id TEXT NOT NULL,
        PRIMARY KEY (project_id, scenario_id, revision_number, item_id),
        FOREIGN KEY (project_id, scenario_id, revision_number)
          REFERENCES scenario_revisions(project_id, scenario_id, revision_number),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id)
      ) STRICT;
      CREATE INDEX scenario_revision_work_items_by_task
        ON scenario_revision_work_items (project_id, item_id, scenario_id, revision_number);
      CREATE TRIGGER scenario_revision_work_items_validate
        BEFORE INSERT ON scenario_revision_work_items
        BEGIN
          SELECT CASE WHEN (SELECT status FROM scenario_revisions WHERE project_id = new.project_id
            AND scenario_id = new.scenario_id AND revision_number = new.revision_number) <> 'draft'
            THEN RAISE(ABORT, 'task scenario links can only be added to draft revisions') END;
          SELECT CASE WHEN (SELECT type FROM work_items WHERE project_id = new.project_id AND item_id = new.item_id) <> 'task'
            THEN RAISE(ABORT, 'scenario revision links may target only task work items') END;
        END;
      CREATE TRIGGER scenario_revision_work_items_immutable_update
        BEFORE UPDATE ON scenario_revision_work_items
        BEGIN SELECT RAISE(ABORT, 'scenario task coverage history is immutable'); END;
      CREATE TRIGGER scenario_revision_work_items_immutable_delete
        BEFORE DELETE ON scenario_revision_work_items
        BEGIN SELECT RAISE(ABORT, 'scenario task coverage history is immutable'); END;

      CREATE TABLE development_session_scenario_refs (
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL,
        captured_at TEXT NOT NULL,
        PRIMARY KEY (project_id, session_id, scenario_id),
        FOREIGN KEY (project_id, session_id) REFERENCES development_sessions(project_id, session_id),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id),
        FOREIGN KEY (project_id, scenario_id, revision_number)
          REFERENCES scenario_revisions(project_id, scenario_id, revision_number)
      ) STRICT;
      CREATE TRIGGER development_session_scenario_refs_immutable_update
        BEFORE UPDATE ON development_session_scenario_refs
        BEGIN SELECT RAISE(ABORT, 'session scenario references are immutable'); END;
      CREATE TRIGGER development_session_scenario_refs_immutable_delete
        BEFORE DELETE ON development_session_scenario_refs
        BEGIN SELECT RAISE(ABORT, 'session scenario references are immutable'); END;

      CREATE TABLE test_run_work_items (
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        linked_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        linked_at TEXT NOT NULL,
        PRIMARY KEY (project_id, run_id, item_id),
        FOREIGN KEY (run_id) REFERENCES test_runs(run_id),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id)
      ) STRICT;
      CREATE INDEX test_run_work_items_by_item
        ON test_run_work_items (project_id, item_id, run_id);
      CREATE TRIGGER test_run_work_items_validate_task
        BEFORE INSERT ON test_run_work_items
        WHEN (SELECT type FROM work_items WHERE project_id = new.project_id AND item_id = new.item_id) <> 'task'
        BEGIN SELECT RAISE(ABORT, 'test runs can only be linked directly to task work items'); END;
      CREATE TRIGGER test_run_work_items_validate_project
        BEFORE INSERT ON test_run_work_items
        WHEN (SELECT project_id FROM test_runs WHERE run_id = new.run_id) <> new.project_id
        BEGIN SELECT RAISE(ABORT, 'test run and work item must belong to the same project'); END;
      CREATE TRIGGER test_run_work_items_immutable_update
        BEFORE UPDATE ON test_run_work_items
        BEGIN SELECT RAISE(ABORT, 'test run task links are immutable'); END;
      CREATE TRIGGER test_run_work_items_immutable_delete
        BEFORE DELETE ON test_run_work_items
        BEGIN SELECT RAISE(ABORT, 'test run task links are immutable'); END;

      CREATE TABLE deployment_events (
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        environment TEXT NOT NULL CHECK (environment IN ('homologation', 'production')),
        build_id TEXT NOT NULL CHECK (length(trim(build_id)) BETWEEN 1 AND 128),
        release_version TEXT CHECK (release_version IS NULL OR length(trim(release_version)) BETWEEN 1 AND 128),
        pipeline_run_id TEXT CHECK (pipeline_run_id IS NULL OR length(trim(pipeline_run_id)) BETWEEN 1 AND 160),
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'rolled_back')),
        deployed_at TEXT NOT NULL,
        principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
        rollback_of_event_id TEXT,
        FOREIGN KEY (project_id, rollback_of_event_id) REFERENCES deployment_events(project_id, event_id),
        UNIQUE (project_id, event_id),
        CHECK ((outcome = 'rolled_back' AND rollback_of_event_id IS NOT NULL)
          OR (outcome <> 'rolled_back' AND rollback_of_event_id IS NULL))
      ) STRICT;
      CREATE INDEX deployment_events_by_environment_date
        ON deployment_events (project_id, environment, deployed_at DESC);

      CREATE TABLE deployment_event_work_items (
        project_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        PRIMARY KEY (project_id, event_id, item_id),
        FOREIGN KEY (project_id, event_id) REFERENCES deployment_events(project_id, event_id),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id)
      ) STRICT;
      CREATE INDEX deployment_event_work_items_by_item
        ON deployment_event_work_items (project_id, item_id, event_id);

      CREATE TABLE deployment_event_milestones (
        project_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        milestone_id TEXT NOT NULL,
        PRIMARY KEY (project_id, event_id, milestone_id),
        FOREIGN KEY (project_id, event_id) REFERENCES deployment_events(project_id, event_id),
        FOREIGN KEY (project_id, milestone_id) REFERENCES milestones(project_id, milestone_id)
      ) STRICT;
      CREATE TRIGGER deployment_events_immutable_update
        BEFORE UPDATE ON deployment_events
        BEGIN SELECT RAISE(ABORT, 'deployment event history is immutable'); END;
      CREATE TRIGGER deployment_events_immutable_delete
        BEFORE DELETE ON deployment_events
        BEGIN SELECT RAISE(ABORT, 'deployment event history is immutable'); END;
      CREATE TRIGGER deployment_event_work_items_immutable_update
        BEFORE UPDATE ON deployment_event_work_items
        BEGIN SELECT RAISE(ABORT, 'deployment work item links are immutable'); END;
      CREATE TRIGGER deployment_event_work_items_immutable_delete
        BEFORE DELETE ON deployment_event_work_items
        BEGIN SELECT RAISE(ABORT, 'deployment work item links are immutable'); END;
      CREATE TRIGGER deployment_event_milestones_immutable_update
        BEFORE UPDATE ON deployment_event_milestones
        BEGIN SELECT RAISE(ABORT, 'deployment milestone links are immutable'); END;
      CREATE TRIGGER deployment_event_milestones_immutable_delete
        BEFORE DELETE ON deployment_event_milestones
        BEGIN SELECT RAISE(ABORT, 'deployment milestone links are immutable'); END;
    `,
  },
  {
    version: 26,
    name: "stable-roadmap-id-mapping",
    sql: `
      CREATE TABLE roadmap_item_ids (
        project_id TEXT NOT NULL,
        roadmap_id TEXT NOT NULL CHECK (roadmap_id GLOB 'SSDD-[0-9][0-9][0-9]'),
        item_id TEXT NOT NULL,
        bound_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        bound_at TEXT NOT NULL,
        PRIMARY KEY (project_id, roadmap_id),
        UNIQUE (project_id, item_id),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id)
      ) STRICT;
      CREATE INDEX roadmap_item_ids_by_item ON roadmap_item_ids (project_id, item_id);
      CREATE TRIGGER roadmap_item_ids_validate_task
        BEFORE INSERT ON roadmap_item_ids
        WHEN (SELECT type FROM work_items WHERE project_id = new.project_id AND item_id = new.item_id) <> 'task'
        BEGIN SELECT RAISE(ABORT, 'roadmap IDs can only bind to task work items'); END;
      CREATE TRIGGER roadmap_item_ids_immutable_update
        BEFORE UPDATE ON roadmap_item_ids
        BEGIN SELECT RAISE(ABORT, 'roadmap ID mappings are immutable'); END;
      CREATE TRIGGER roadmap_item_ids_immutable_delete
        BEFORE DELETE ON roadmap_item_ids
        BEGIN SELECT RAISE(ABORT, 'roadmap ID mappings are immutable'); END;
    `,
  },
  {
    version: 27,
    name: "project-history-query-indexes",
    sql: `
      CREATE INDEX work_item_transitions_by_project_time
        ON work_item_state_transitions (project_id, transitioned_at DESC, item_id, item_version DESC);
      CREATE INDEX work_item_transitions_by_item_time
        ON work_item_state_transitions (project_id, item_id, transitioned_at DESC, item_version DESC);
      CREATE INDEX work_item_revisions_by_item_publication
        ON work_item_revisions (project_id, item_id, published_at DESC, revision_number DESC)
        WHERE published_at IS NOT NULL;
      CREATE INDEX specification_revisions_by_item_publication
        ON specification_revisions (project_id, spec_id, published_at DESC, revision_number DESC)
        WHERE published_at IS NOT NULL;
      CREATE INDEX scenario_revisions_by_item_publication
        ON scenario_revisions (project_id, scenario_id, published_at DESC, revision_number DESC)
        WHERE published_at IS NOT NULL;
      CREATE INDEX audit_events_by_project_occurred
        ON audit_events (project_id, occurred_at DESC, sequence DESC);
      CREATE INDEX test_runs_by_project_executed
        ON test_runs (project_id, executed_at DESC, sequence DESC);
      CREATE INDEX development_sessions_by_project_start
        ON development_sessions (project_id, started_at DESC, session_id);
      CREATE INDEX development_session_events_by_project_time
        ON development_session_events (project_id, occurred_at, session_id, sequence);
      CREATE INDEX deployment_events_by_project_date
        ON deployment_events (project_id, deployed_at DESC, event_id);
      CREATE INDEX sprint_state_transitions_by_project_time
        ON sprint_state_transitions (project_id, transitioned_at, sprint_id, sprint_version);
      CREATE INDEX sprint_scope_events_by_project_time
        ON sprint_scope_events (project_id, changed_at, sprint_id, sequence);
      CREATE INDEX milestone_scope_events_by_project_time
        ON milestone_scope_events (project_id, changed_at, milestone_id, sequence);
    `,
  },
  {
    version: 28,
    name: "user-authentication-profiles-and-semantic-index",
    sql: `
      CREATE TABLE instance_administrators (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        principal_id TEXT NOT NULL UNIQUE REFERENCES principals(principal_id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE principal_api_keys (
        key_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64),
        key_prefix TEXT NOT NULL CHECK (length(key_prefix) BETWEEN 8 AND 20),
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        CHECK (revoked_at IS NULL OR revoked_at >= created_at)
      ) STRICT;
      CREATE UNIQUE INDEX principal_api_keys_one_active_per_principal
        ON principal_api_keys (principal_id) WHERE revoked_at IS NULL;

      CREATE TABLE principal_admin_events (
        event_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        actor_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        target_principal_id TEXT REFERENCES principals(principal_id),
        action TEXT NOT NULL CHECK (action IN ('bootstrap', 'user.create', 'user.auth_key.rotate', 'user.auth_key.revoke')),
        payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        response_json TEXT NOT NULL CHECK (json_valid(response_json))
      ) STRICT;
      CREATE INDEX principal_admin_events_by_target
        ON principal_admin_events (target_principal_id, occurred_at DESC);
      CREATE TRIGGER principal_admin_events_immutable_update
        BEFORE UPDATE ON principal_admin_events
        BEGIN SELECT RAISE(ABORT, 'principal admin events are immutable'); END;
      CREATE TRIGGER principal_admin_events_immutable_delete
        BEFORE DELETE ON principal_admin_events
        BEGIN SELECT RAISE(ABORT, 'principal admin events are immutable'); END;

      CREATE TABLE work_item_embeddings (
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        model_key TEXT NOT NULL,
        model_name TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
        vector_json TEXT NOT NULL CHECK (json_valid(vector_json)),
        dimension INTEGER NOT NULL CHECK (dimension > 0),
        indexed_at TEXT NOT NULL,
        PRIMARY KEY (project_id, item_id, model_key),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX work_item_embeddings_by_model
        ON work_item_embeddings (project_id, model_key, item_id);

      CREATE INDEX work_items_by_assignee
        ON work_items (project_id, assignee_principal_id, rank, item_key);
    `,
  },
  {
    version: 29,
    name: "point-estimate-audit-query-index",
    sql: `
      CREATE INDEX audit_events_by_project_type_entity_time
        ON audit_events (project_id, event_type, entity_id, occurred_at, sequence);
    `,
  },
  {
    version: 30,
    name: "versioned-task-workflows-and-weighted-progress",
    sql: `
      CREATE TABLE task_workflow_revisions (
        revision_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'superseded', 'withdrawn')),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
        created_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        created_at TEXT NOT NULL,
        published_by_principal_id TEXT REFERENCES principals(principal_id),
        published_at TEXT,
        PRIMARY KEY (project_id, item_id, revision_number),
        UNIQUE (project_id, item_id, revision_id),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id),
        CHECK ((status IN ('draft', 'withdrawn') AND published_by_principal_id IS NULL AND published_at IS NULL)
          OR (status IN ('published', 'superseded') AND published_by_principal_id IS NOT NULL AND published_at IS NOT NULL))
      ) STRICT;
      CREATE UNIQUE INDEX task_workflow_one_draft
        ON task_workflow_revisions (project_id, item_id) WHERE status = 'draft';
      CREATE UNIQUE INDEX task_workflow_one_published
        ON task_workflow_revisions (project_id, item_id) WHERE status = 'published';
      CREATE INDEX task_workflow_revisions_by_item
        ON task_workflow_revisions (project_id, item_id, revision_number DESC);

      CREATE TABLE task_workflow_steps (
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL,
        step_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 50),
        title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
        description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 4000),
        effort_basis_points INTEGER NOT NULL CHECK (effort_basis_points BETWEEN 1 AND 10000),
        PRIMARY KEY (project_id, item_id, revision_number, step_id),
        UNIQUE (project_id, item_id, revision_number, position),
        FOREIGN KEY (project_id, item_id, revision_number)
          REFERENCES task_workflow_revisions(project_id, item_id, revision_number)
      ) STRICT;
      CREATE INDEX task_workflow_steps_by_order
        ON task_workflow_steps (project_id, item_id, revision_number, position);
      CREATE TRIGGER task_workflow_steps_validate_insert
        BEFORE INSERT ON task_workflow_steps
        BEGIN
          SELECT CASE WHEN (SELECT status FROM task_workflow_revisions
            WHERE project_id = new.project_id AND item_id = new.item_id AND revision_number = new.revision_number) <> 'draft'
            THEN RAISE(ABORT, 'task workflow steps may only be added to a draft revision') END;
          SELECT CASE WHEN (SELECT type FROM work_items
            WHERE project_id = new.project_id AND item_id = new.item_id) <> 'task'
            THEN RAISE(ABORT, 'task workflows may only be attached to task work items') END;
        END;
      CREATE TRIGGER task_workflow_steps_immutable_update
        BEFORE UPDATE ON task_workflow_steps
        BEGIN SELECT RAISE(ABORT, 'task workflow revision steps are immutable'); END;
      CREATE TRIGGER task_workflow_steps_immutable_delete
        BEFORE DELETE ON task_workflow_steps
        BEGIN SELECT RAISE(ABORT, 'task workflow revision steps are immutable'); END;

      CREATE TABLE task_workflow_step_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL,
        step_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('status_changed', 'carried_forward', 'reset')),
        from_status TEXT NOT NULL CHECK (from_status IN ('pending', 'in_progress', 'done')),
        to_status TEXT NOT NULL CHECK (to_status IN ('pending', 'in_progress', 'done')),
        principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
        occurred_at TEXT NOT NULL,
        FOREIGN KEY (project_id, item_id, revision_number, step_id)
          REFERENCES task_workflow_steps(project_id, item_id, revision_number, step_id)
      ) STRICT;
      CREATE INDEX task_workflow_step_events_latest
        ON task_workflow_step_events (project_id, item_id, revision_number, step_id, sequence DESC);
      CREATE TRIGGER task_workflow_step_events_validate_insert
        BEFORE INSERT ON task_workflow_step_events
        BEGIN
          SELECT CASE WHEN (SELECT status FROM task_workflow_revisions
            WHERE project_id = new.project_id AND item_id = new.item_id AND revision_number = new.revision_number) <> 'published'
            THEN RAISE(ABORT, 'task workflow progress requires a published revision') END;
        END;
      CREATE TRIGGER task_workflow_step_events_immutable_update
        BEFORE UPDATE ON task_workflow_step_events
        BEGIN SELECT RAISE(ABORT, 'task workflow progress history is immutable'); END;
      CREATE TRIGGER task_workflow_step_events_immutable_delete
        BEFORE DELETE ON task_workflow_step_events
        BEGIN SELECT RAISE(ABORT, 'task workflow progress history is immutable'); END;

      CREATE TABLE development_session_workflow_refs (
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL,
        pinned_at TEXT NOT NULL,
        PRIMARY KEY (project_id, session_id),
        FOREIGN KEY (project_id, session_id) REFERENCES development_sessions(project_id, session_id),
        FOREIGN KEY (project_id, item_id, revision_number)
          REFERENCES task_workflow_revisions(project_id, item_id, revision_number)
      ) STRICT;
      CREATE INDEX development_session_workflow_refs_by_task
        ON development_session_workflow_refs (project_id, item_id, revision_number);
      CREATE TRIGGER development_session_workflow_refs_validate_insert
        BEFORE INSERT ON development_session_workflow_refs
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM development_sessions s
            WHERE s.project_id = new.project_id AND s.session_id = new.session_id AND s.item_id = new.item_id
          ) THEN RAISE(ABORT, 'session workflow reference must match the task') END;
          SELECT CASE WHEN (SELECT status FROM task_workflow_revisions
            WHERE project_id = new.project_id AND item_id = new.item_id AND revision_number = new.revision_number) <> 'published'
            THEN RAISE(ABORT, 'development sessions can pin only a published task workflow') END;
        END;
      CREATE TRIGGER development_session_workflow_refs_immutable_update
        BEFORE UPDATE ON development_session_workflow_refs
        BEGIN SELECT RAISE(ABORT, 'session workflow references are immutable'); END;
      CREATE TRIGGER development_session_workflow_refs_immutable_delete
        BEFORE DELETE ON development_session_workflow_refs
        BEGIN SELECT RAISE(ABORT, 'session workflow references are immutable'); END;

      CREATE TRIGGER task_workflow_revisions_validate_publish
        BEFORE UPDATE OF status ON task_workflow_revisions
        WHEN old.status = 'draft' AND new.status = 'published'
        BEGIN
          SELECT CASE WHEN (SELECT COUNT(*) FROM task_workflow_steps
            WHERE project_id = old.project_id AND item_id = old.item_id AND revision_number = old.revision_number) NOT BETWEEN 1 AND 50
            THEN RAISE(ABORT, 'task workflow must contain 1-50 steps') END;
          SELECT CASE WHEN (SELECT COALESCE(SUM(effort_basis_points), 0) FROM task_workflow_steps
            WHERE project_id = old.project_id AND item_id = old.item_id AND revision_number = old.revision_number) <> 10000
            THEN RAISE(ABORT, 'task workflow effort weights must total 100.00 percent') END;
          SELECT CASE WHEN (SELECT type FROM work_items
            WHERE project_id = old.project_id AND item_id = old.item_id) <> 'task'
            THEN RAISE(ABORT, 'task workflows may only be attached to task work items') END;
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM development_sessions
            WHERE project_id = old.project_id AND item_id = old.item_id AND status IN ('active', 'paused')
          ) THEN RAISE(ABORT, 'close open development sessions before publishing a workflow') END;
        END;
      CREATE TRIGGER task_workflow_revisions_validate_update
        BEFORE UPDATE ON task_workflow_revisions
        WHEN old.revision_id IS NOT new.revision_id OR old.project_id IS NOT new.project_id OR old.item_id IS NOT new.item_id
          OR old.revision_number IS NOT new.revision_number OR old.reason IS NOT new.reason
          OR old.created_by_principal_id IS NOT new.created_by_principal_id OR old.created_at IS NOT new.created_at
          OR NOT ((old.status = 'draft' AND new.status IN ('published', 'withdrawn')) OR (old.status = 'published' AND new.status = 'superseded'))
          OR (old.status = 'draft' AND new.status = 'published' AND (new.published_by_principal_id IS NULL OR new.published_at IS NULL))
          OR (old.status = 'published' AND new.status = 'superseded' AND
            (old.published_by_principal_id IS NOT new.published_by_principal_id OR old.published_at IS NOT new.published_at))
        BEGIN SELECT RAISE(ABORT, 'task workflow revision history is immutable'); END;
    `,
  },
  {
    version: 31,
    name: "business-value-and-prioritized-roadmap",
    sql: `
      ALTER TABLE work_items ADD COLUMN business_value_score INTEGER
        CHECK (business_value_score IS NULL OR business_value_score BETWEEN 0 AND 100);
      ALTER TABLE work_items ADD COLUMN business_value_rationale TEXT
        CHECK (business_value_rationale IS NULL OR length(business_value_rationale) <= 1000);
      CREATE INDEX work_items_by_execution_queue
        ON work_items (project_id, type, state, assignee_principal_id, priority, rank, item_key);
    `,
  },
  {
    version: 32,
    name: "withdraw-obsolete-specification-drafts",
    checksumKey: "withdraw-specification-draft-preserving-session-fks-v1",
    disableForeignKeysForRebuild: true,
    sql: `
      CREATE TABLE specification_revisions_v32 (
        revision_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        spec_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        status TEXT NOT NULL CHECK (status IN ('draft', 'in_review', 'published', 'superseded', 'withdrawn')),
        content_json TEXT NOT NULL CHECK (json_valid(content_json)),
        created_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        created_at TEXT NOT NULL,
        published_by_principal_id TEXT REFERENCES principals(principal_id),
        published_at TEXT,
        UNIQUE (project_id, spec_id, revision_number),
        UNIQUE (project_id, spec_id, revision_number, revision_id),
        FOREIGN KEY (project_id, spec_id) REFERENCES specifications(project_id, spec_id),
        CHECK (
          (status IN ('draft', 'in_review', 'withdrawn') AND published_by_principal_id IS NULL AND published_at IS NULL)
          OR
          (status IN ('published', 'superseded') AND published_by_principal_id IS NOT NULL AND published_at IS NOT NULL)
        )
      ) STRICT;

      INSERT INTO specification_revisions_v32
        (revision_id, project_id, spec_id, revision_number, status, content_json,
         created_by_principal_id, created_at, published_by_principal_id, published_at)
      SELECT revision_id, project_id, spec_id, revision_number, status, content_json,
             created_by_principal_id, created_at, published_by_principal_id, published_at
      FROM specification_revisions;

      DROP TRIGGER specification_revisions_immutable_content;
      DROP TRIGGER specification_revisions_no_delete;
      DROP TRIGGER baseline_refs_validate_revision;
      DROP TABLE specification_revisions;
      ALTER TABLE specification_revisions_v32 RENAME TO specification_revisions;

      CREATE UNIQUE INDEX specification_one_published_revision
        ON specification_revisions (project_id, spec_id) WHERE status = 'published';
      CREATE UNIQUE INDEX specification_one_open_draft_revision
        ON specification_revisions (project_id, spec_id) WHERE status IN ('draft', 'in_review');
      CREATE INDEX specification_revisions_by_spec
        ON specification_revisions (project_id, spec_id, revision_number);
      CREATE INDEX specification_revisions_by_item_publication
        ON specification_revisions (project_id, spec_id, published_at DESC, revision_number DESC)
        WHERE published_at IS NOT NULL;

      CREATE TRIGGER specification_revisions_validate_insert
        BEFORE INSERT ON specification_revisions
        WHEN new.status <> 'draft' OR new.published_by_principal_id IS NOT NULL OR new.published_at IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'new specification revisions must start as drafts'); END;

      CREATE TRIGGER specification_revisions_immutable_content
        BEFORE UPDATE ON specification_revisions
        WHEN
          NEW.revision_id IS NOT OLD.revision_id OR NEW.project_id IS NOT OLD.project_id OR
          NEW.spec_id IS NOT OLD.spec_id OR NEW.revision_number IS NOT OLD.revision_number OR
          NEW.content_json IS NOT OLD.content_json OR NEW.created_by_principal_id IS NOT OLD.created_by_principal_id OR
          NEW.created_at IS NOT OLD.created_at OR
          NOT (
            (OLD.status = 'draft' AND NEW.status IN ('in_review', 'published', 'withdrawn')) OR
            (OLD.status = 'in_review' AND NEW.status IN ('draft', 'published', 'withdrawn')) OR
            (OLD.status = 'published' AND NEW.status = 'superseded'
              AND NEW.published_by_principal_id IS OLD.published_by_principal_id
              AND NEW.published_at IS OLD.published_at)
          )
        BEGIN SELECT RAISE(ABORT, 'specification revision content and history are immutable'); END;

      CREATE TRIGGER specification_revisions_no_delete
        BEFORE DELETE ON specification_revisions
        BEGIN SELECT RAISE(ABORT, 'specification revisions are immutable'); END;

      CREATE TRIGGER baseline_refs_validate_revision
        BEFORE INSERT ON baseline_refs
        BEGIN
          SELECT CASE WHEN new.entity_type = 'work_item_revision' AND NOT EXISTS (
            SELECT 1 FROM work_item_revisions r
            WHERE r.project_id = new.project_id AND r.item_id = new.entity_id
              AND r.revision_number = new.revision_number AND r.status = 'published'
          ) THEN RAISE(ABORT, 'baseline work item revision must be published') END;
          SELECT CASE WHEN new.entity_type = 'specification_revision' AND NOT EXISTS (
            SELECT 1 FROM specification_revisions r
            WHERE r.project_id = new.project_id AND r.spec_id = new.entity_id
              AND r.revision_number = new.revision_number AND r.status = 'published'
          ) THEN RAISE(ABORT, 'baseline specification revision must be published') END;
          SELECT CASE WHEN new.entity_type = 'scenario_revision' AND NOT EXISTS (
            SELECT 1 FROM scenario_revisions r
            WHERE r.project_id = new.project_id AND r.scenario_id = new.entity_id
              AND r.revision_number = new.revision_number AND r.status = 'published'
          ) THEN RAISE(ABORT, 'baseline scenario revision must be published') END;
        END;
    `,
    afterApply: verifyMigrationForeignKeys,
  },
  {
    version: 33,
    name: "file-claims-for-parallel-agents",
    sql: `
      CREATE TABLE file_claims (
        claim_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        item_id TEXT,
        principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 500),
        kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
        branch TEXT CHECK (branch IS NULL OR length(branch) BETWEEN 1 AND 200),
        worktree TEXT CHECK (worktree IS NULL OR length(worktree) BETWEEN 1 AND 500),
        created_at TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        released_at TEXT,
        release_reason TEXT CHECK (release_reason IS NULL OR length(release_reason) <= 500),
        released_by_principal_id TEXT REFERENCES principals(principal_id),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id),
        CHECK ((released_at IS NULL AND released_by_principal_id IS NULL) OR (released_at IS NOT NULL AND released_by_principal_id IS NOT NULL))
      ) STRICT;
      CREATE INDEX file_claims_active_by_project ON file_claims (project_id, released_at, lease_expires_at);
      CREATE INDEX file_claims_by_principal ON file_claims (project_id, principal_id, released_at);
    `,
  },
  {
    version: 34,
    name: "structured-acceptance-criteria",
    sql: `
      ALTER TABLE work_item_criteria
        ADD COLUMN structure_json TEXT CHECK (structure_json IS NULL OR json_valid(structure_json));
    `,
  },
  {
    version: 35,
    name: "work-item-open-questions",
    sql: `
      CREATE TABLE work_item_questions (
        question_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        question_key TEXT NOT NULL CHECK (length(question_key) BETWEEN 3 AND 20),
        text TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 2000),
        blocking INTEGER NOT NULL DEFAULT 0 CHECK (blocking IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered')),
        answer TEXT CHECK (answer IS NULL OR length(trim(answer)) BETWEEN 1 AND 4000),
        asked_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        asked_at TEXT NOT NULL,
        answered_by_principal_id TEXT REFERENCES principals(principal_id),
        answered_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        UNIQUE (project_id, question_key),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id),
        CHECK ((status = 'open' AND answer IS NULL AND answered_at IS NULL AND answered_by_principal_id IS NULL)
            OR (status = 'answered' AND answer IS NOT NULL AND answered_at IS NOT NULL AND answered_by_principal_id IS NOT NULL))
      ) STRICT;
      CREATE INDEX work_item_questions_by_item ON work_item_questions (project_id, item_id, status);
    `,
  },
  {
    version: 36,
    name: "task-delivery-reports",
    sql: `
      CREATE TABLE task_delivery_reports (
        report_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        report_number INTEGER NOT NULL CHECK (report_number > 0),
        entries_json TEXT NOT NULL CHECK (json_valid(entries_json)),
        summary TEXT CHECK (summary IS NULL OR length(summary) <= 2000),
        submitted_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        submitted_at TEXT NOT NULL,
        UNIQUE (project_id, item_id, report_number),
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id)
      ) STRICT;
      CREATE TRIGGER task_delivery_reports_no_update BEFORE UPDATE ON task_delivery_reports
      BEGIN SELECT RAISE(ABORT, 'task delivery reports are immutable'); END;
      CREATE TRIGGER task_delivery_reports_no_delete BEFORE DELETE ON task_delivery_reports
      BEGIN SELECT RAISE(ABORT, 'task delivery reports are immutable'); END;
    `,
  },
  {
    version: 37,
    name: "task-reviews",
    sql: `
      CREATE TABLE task_reviews (
        review_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        report_number INTEGER CHECK (report_number IS NULL OR report_number > 0),
        decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
        advisory INTEGER NOT NULL CHECK (advisory IN (0, 1)),
        findings_json TEXT NOT NULL CHECK (json_valid(findings_json)),
        summary TEXT CHECK (summary IS NULL OR length(summary) <= 2000),
        reviewer_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        reviewed_at TEXT NOT NULL,
        FOREIGN KEY (project_id, item_id) REFERENCES work_items(project_id, item_id)
      ) STRICT;
      CREATE INDEX task_reviews_by_item ON task_reviews (project_id, item_id, reviewed_at);
      CREATE TRIGGER task_reviews_no_update BEFORE UPDATE ON task_reviews
      BEGIN SELECT RAISE(ABORT, 'task reviews are immutable'); END;
      CREATE TRIGGER task_reviews_no_delete BEFORE DELETE ON task_reviews
      BEGIN SELECT RAISE(ABORT, 'task reviews are immutable'); END;
    `,
  },
];

export function applyMigrations(
  database: SqliteDatabase,
  migrations: readonly SqliteMigration[] = initialMigrations,
): void {
  validateMigrationList(migrations);

  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const appliedMigrations = database
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all() as AppliedMigration[];

  if (appliedMigrations.length > migrations.length) {
    const highestApplied = appliedMigrations.at(-1)?.version ?? 0;
    throw new Error(
      `Database schema version ${highestApplied} is newer than this application supports (${migrations.length}).`,
    );
  }

  for (const [index, applied] of appliedMigrations.entries()) {
    const expected = migrations[index];
    if (expected === undefined || applied.version !== expected.version) {
      throw new Error("Applied schema migrations are incomplete or out of order.");
    }
    assertMigrationMatches(applied, expected, checksumOf(expected));
  }

  for (const migration of migrations) {
    const checksum = checksumOf(migration);
    const existing = database
      .prepare(
        "SELECT version, name, checksum FROM schema_migrations WHERE version = ?",
      )
      .get(migration.version) as AppliedMigration | undefined;

    if (existing !== undefined) {
      if (existing.name !== migration.name || existing.checksum !== checksum) {
        throw new Error(
          `Migration ${migration.version} (${migration.name}) differs from the version recorded in the database.`,
        );
      }
      continue;
    }

    const applyMigration = database.transaction(() => {
      const concurrent = database
        .prepare(
          "SELECT version, name, checksum FROM schema_migrations WHERE version = ?",
        )
        .get(migration.version) as AppliedMigration | undefined;

      if (concurrent !== undefined) {
        assertMigrationMatches(concurrent, migration, checksum);
        return;
      }

      database.exec(migration.sql);
      migration.afterApply?.(database);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(migration.version, migration.name, checksum, new Date().toISOString());
    });

    const foreignKeysWereEnabled = database.pragma("foreign_keys", { simple: true }) === 1;
    if (migration.disableForeignKeysForRebuild) {
      if (database.inTransaction) {
        throw new Error(`Migration ${migration.version} must start outside an existing transaction.`);
      }
      if (!foreignKeysWereEnabled) {
        throw new Error(`Migration ${migration.version} requires foreign keys to be enabled.`);
      }
      database.pragma("foreign_keys = OFF");
    }
    try {
      applyMigration.immediate();
    } finally {
      if (migration.disableForeignKeysForRebuild && foreignKeysWereEnabled) {
        database.pragma("foreign_keys = ON");
      }
    }
  }
}

export function inspectMigrationHistory(
  database: SqliteDatabase,
  migrations: readonly SqliteMigration[] = initialMigrations,
): MigrationInspection {
  const supportedVersion = migrations.at(-1)?.version ?? 0;
  const tableExists = database.prepare(
    "SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
  ).get() as { found: number } | undefined;
  if (tableExists === undefined) {
    return { status: "missing", appliedVersion: 0, supportedVersion, appliedCount: 0 };
  }

  const applied = database.prepare(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  ).all() as AppliedMigration[];
  const appliedVersion = applied.at(-1)?.version ?? 0;
  if (appliedVersion > supportedVersion) {
    return { status: "ahead", appliedVersion, supportedVersion, appliedCount: applied.length };
  }

  for (const [index, record] of applied.entries()) {
    const expected = migrations[index];
    if (
      expected === undefined ||
      record.version !== expected.version ||
      record.name !== expected.name ||
      record.checksum !== checksumOf(expected)
    ) {
      return { status: "drift", appliedVersion, supportedVersion, appliedCount: applied.length };
    }
  }

  return {
    status: applied.length === migrations.length ? "current" : "behind",
    appliedVersion,
    supportedVersion,
    appliedCount: applied.length,
  };
}

function validateMigrationList(migrations: readonly SqliteMigration[]): void {
  let previousVersion = 0;
  const names = new Set<string>();

  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version !== previousVersion + 1
    ) {
      throw new Error("Migration versions must be positive, consecutive and increasing.");
    }
    if (migration.name.trim().length === 0 || names.has(migration.name)) {
      throw new Error("Migration names must be non-empty and unique.");
    }
    if (migration.sql.trim().length === 0) {
      throw new Error(`Migration ${migration.version} has no SQL statements.`);
    }
    if (
      (migration.afterApply !== undefined || migration.disableForeignKeysForRebuild === true) &&
      (migration.checksumKey === undefined || migration.checksumKey.trim().length === 0)
    ) {
      throw new Error(`Migration ${migration.version} has unversioned post-apply behavior.`);
    }

    names.add(migration.name);
    previousVersion = migration.version;
  }
}

function checksumOf(migration: SqliteMigration): string {
  const checksum = createHash("sha256").update(migration.sql);
  if (migration.checksumKey !== undefined) {
    checksum.update("\n-- behavior checksum key: ").update(migration.checksumKey);
  }
  if (migration.disableForeignKeysForRebuild === true) {
    checksum.update("\n-- disable foreign keys for rebuild: true");
  }
  return checksum.digest("hex");
}

function seedDefaultTeamsAndVerifyForeignKeys(database: SqliteDatabase): void {
  const projects = database.prepare(
    `SELECT project_id FROM projects p
     WHERE NOT EXISTS (SELECT 1 FROM teams t WHERE t.project_id = p.project_id)
     ORDER BY project_id`,
  ).all() as Array<{ project_id: string }>;
  const insert = database.prepare(
    `INSERT INTO teams (team_id, project_id, current_version, current_generation, created_at)
     VALUES (?, ?, 0, 0, ?)`,
  );
  const createdAt = new Date().toISOString();
  for (const project of projects) {
    insert.run(deterministicLegacyTeamId(project.project_id), project.project_id, createdAt);
  }

  const violations = database.pragma("foreign_key_check") as Array<Record<string, unknown>>;
  if (violations.length > 0) {
    throw new Error(`Migration 22 found ${violations.length} foreign key violation(s).`);
  }
}

function verifyMigrationForeignKeys(database: SqliteDatabase): void {
  const violations = database.pragma("foreign_key_check") as Array<Record<string, unknown>>;
  if (violations.length > 0) {
    throw new Error(`Schema migration found ${violations.length} foreign key violation(s).`);
  }
}

function deterministicLegacyTeamId(projectId: string): string {
  const namespace = Buffer.from("e4b58592e06547c28c7633d6e7f10a04", "hex");
  const bytes = createHash("sha1").update(namespace).update(projectId, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertMigrationMatches(
  applied: AppliedMigration,
  expected: SqliteMigration,
  checksum: string,
): void {
  if (applied.name !== expected.name || applied.checksum !== checksum) {
    throw new Error(
      `Migration ${expected.version} (${expected.name}) differs from the version recorded in the database.`,
    );
  }
}
