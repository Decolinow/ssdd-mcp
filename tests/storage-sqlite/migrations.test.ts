import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import {
  applyMigrations,
  initialMigrations,
  type SqliteMigration,
} from "../../src/storage-sqlite/migrations.js";

describe("schema migrations", () => {
  let database: SqliteDatabase;
  beforeEach(() => {
    database = openSqliteDatabase(":memory:");
  });
  afterEach(() => {
    database.close();
  });

  it("records each migration once and safely reapplies them", () => {
    applyMigrations(database);
    applyMigrations(database);

    const migrationCount = database
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number };
    const projectTable = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'projects'")
      .get() as { name: string } | undefined;

    assert.equal(migrationCount.count, initialMigrations.length);
    assert.equal(projectTable?.name, "projects");
  });

  it("upgrades a version 11 database to the current schema without losing project data", () => {
    applyMigrations(database, initialMigrations.slice(0, 11));
    const projectId = randomUUID();
    const principalId = randomUUID();
    const createdAt = new Date().toISOString();
    database.prepare(
      `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
       VALUES (?, 'human', ?, 'migration-owner', ?)`,
    ).run(principalId, `migration:${principalId}`, createdAt);
    database.prepare(
      `INSERT INTO projects
        (project_id, project_key, name, product_goal, timezone, created_at, created_by_principal_id)
       VALUES (?, 'MIG12', 'Migration owner', 'Preserve existing project', 'UTC', ?, ?)`,
    ).run(projectId, createdAt, principalId);
    database.prepare(
      "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, 'qa', ?)",
    ).run(projectId, principalId, createdAt);

    applyMigrations(database);

    const version = database.prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    const preserved = database.prepare(
      "SELECT project_key, name FROM projects WHERE project_id = ?",
    ).get(projectId) as { project_key: string; name: string } | undefined;
    const sequenceColumn = database.prepare("PRAGMA table_info(evidence)")
      .all() as Array<{ name: string; pk: number }>;
    const evidenceSql = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'evidence'")
      .get() as { sql: string };
    const teamTable = database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'team_config_versions'",
    ).get() as { name: string } | undefined;

    assert.equal(version.version, 43);
    assert.deepEqual(preserved, { project_key: "MIG12", name: "Migration owner" });
    assert.ok(sequenceColumn.some((column) => column.name === "sequence" && column.pk === 1));
    assert.match(evidenceSql.sql, /AUTOINCREMENT/);
    assert.equal(teamTable?.name, "team_config_versions");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'sprints'")
      .get() as { name: string } | undefined)?.name, "sprints");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'dod_revisions'")
      .get() as { name: string } | undefined)?.name, "dod_revisions");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'sprint_retrospective_revisions'")
      .get() as { name: string } | undefined)?.name, "sprint_retrospective_revisions");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'milestones'")
      .get() as { name: string } | undefined)?.name, "milestones");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'milestone_forecast_snapshots'")
      .get() as { name: string } | undefined)?.name, "milestone_forecast_snapshots");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'command_approvals'")
      .get() as { name: string } | undefined)?.name, "command_approvals");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'webhook_receipts'")
      .get() as { name: string } | undefined)?.name, "webhook_receipts");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'webhook_receipts_immutable_delete'")
      .get() as { name: string } | undefined)?.name, "webhook_receipts_immutable_delete");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'principal_api_keys'")
      .get() as { name: string } | undefined)?.name, "principal_api_keys");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'work_item_embeddings'")
      .get() as { name: string } | undefined)?.name, "work_item_embeddings");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'work_items_by_assignee'")
      .get() as { name: string } | undefined)?.name, "work_items_by_assignee");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'github_pull_request_events'")
      .get() as { name: string } | undefined)?.name, "github_pull_request_events");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'github_workflow_run_events'")
      .get() as { name: string } | undefined)?.name, "github_workflow_run_events");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'github_pull_request_events_immutable_delete'")
      .get() as { name: string } | undefined)?.name, "github_pull_request_events_immutable_delete");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'external_work_item_links'")
      .get() as { name: string } | undefined)?.name, "external_work_item_links");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'external_work_item_snapshots'")
      .get() as { name: string } | undefined)?.name, "external_work_item_snapshots");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'external_work_item_import_runs'")
      .get() as { name: string } | undefined)?.name, "external_work_item_import_runs");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'external_work_item_snapshots_immutable_update'")
      .get() as { name: string } | undefined)?.name, "external_work_item_snapshots_immutable_update");
    assert.ok((database.prepare("PRAGMA table_info(teams)").all() as Array<{ name: string }>)
      .some((column) => column.name === "current_generation"));
    assert.ok((database.prepare("PRAGMA table_info(team_config_versions)").all() as Array<{ name: string }>)
      .some((column) => column.name === "generation_number"));
    const testRunIndexes = database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN ('test_runs_by_project_sequence', 'test_runs_by_scenario_sequence') ORDER BY name",
    ).all() as Array<{ name: string }>;
    assert.deepEqual(testRunIndexes.map(({ name }) => name), [
      "test_runs_by_project_sequence",
      "test_runs_by_scenario_sequence",
    ]);
    const projectHistoryIndexes = database.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN (
         'work_item_transitions_by_project_time', 'work_item_transitions_by_item_time', 'work_item_revisions_by_item_publication',
         'specification_revisions_by_item_publication', 'scenario_revisions_by_item_publication',
         'audit_events_by_project_occurred', 'test_runs_by_project_executed',
         'development_sessions_by_project_start', 'development_session_events_by_project_time',
         'deployment_events_by_project_date', 'sprint_state_transitions_by_project_time',
         'sprint_scope_events_by_project_time', 'milestone_scope_events_by_project_time'
       ) ORDER BY name`,
    ).all() as Array<{ name: string }>;
    assert.equal(projectHistoryIndexes.length, 13);
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'development_sessions'")
      .get() as { name: string } | undefined)?.name, "development_sessions");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'deployment_events'")
      .get() as { name: string } | undefined)?.name, "deployment_events");
    assert.equal((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'test_run_work_items'")
      .get() as { name: string } | undefined)?.name, "test_run_work_items");
  });

  it("seeds deterministic version-zero teams for legacy projects without a team", () => {
    const projectId = randomUUID();
    const principalId = randomUUID();
    applyMigrations(database, initialMigrations.slice(0, 21));
    insertMigrationProject(database, "LEGACY", projectId, principalId);

    applyMigrations(database);

    const first = database.prepare(
      "SELECT team_id, current_version, current_generation FROM teams WHERE project_id = ?",
    ).get(projectId) as { team_id: string; current_version: number; current_generation: number };
    assert.match(first.team_id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(first.current_version, 0);
    assert.equal(first.current_generation, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM team_config_versions WHERE project_id = ?")
      .get(projectId) as { count: number }).count, 0);

    const secondDatabase = openSqliteDatabase(":memory:");
    try {
      applyMigrations(secondDatabase, initialMigrations.slice(0, 21));
      insertMigrationProject(secondDatabase, "LEGACY", projectId, principalId);
      applyMigrations(secondDatabase);
      const second = secondDatabase.prepare("SELECT team_id FROM teams WHERE project_id = ?")
        .get(projectId) as { team_id: string };
      assert.equal(second.team_id, first.team_id);
    } finally {
      secondDatabase.close();
    }
  });

  it("preserves configured team history, sprint snapshots and foreign keys while allowing another team", () => {
    applyMigrations(database, initialMigrations.slice(0, 21));
    const { projectId, principalId, createdAt } = insertMigrationProject(database, "TEAMMIG");
    const teamId = randomUUID();
    const sprintId = randomUUID();
    database.prepare(
      "INSERT INTO teams (team_id, project_id, current_version, current_generation, created_at) VALUES (?, ?, 1, 3, ?)",
    ).run(teamId, projectId, createdAt);
    database.prepare(
      `INSERT INTO audit_events
        (event_id, project_id, principal_id, event_type, entity_type, entity_id,
         correlation_id, reason, occurred_at, payload_json)
       VALUES (?, ?, ?, 'team.capacity_configured', 'team', ?, ?, 'Original audit', ?, '{"version":1}')`,
    ).run(randomUUID(), projectId, principalId, teamId, randomUUID(), createdAt);
    database.prepare(
      `INSERT INTO team_config_versions
        (project_id, team_id, version, generation_number, team_name, timezone, hours_per_day, working_days_json,
         reason, created_by_principal_id, created_at)
       VALUES (?, ?, 1, 3, 'Legacy team', 'UTC', 8, '[1,2,3,4,5]', 'Original capacity', ?, ?)`,
    ).run(projectId, teamId, principalId, createdAt);
    database.prepare(
      "INSERT INTO team_member_capacities (project_id, team_id, config_version, principal_id, dedication_percent) VALUES (?, ?, 1, ?, 80)",
    ).run(projectId, teamId, principalId);
    database.prepare(
      "INSERT INTO team_holidays (project_id, team_id, config_version, holiday_date, label) VALUES (?, ?, 1, '2026-12-25', 'Holiday')",
    ).run(projectId, teamId);
    database.prepare(
      `INSERT INTO team_absences
        (project_id, team_id, config_version, principal_id, absence_date, hours, reason)
       VALUES (?, ?, 1, ?, '2026-12-24', 8, 'Leave')`,
    ).run(projectId, teamId, principalId);
    database.prepare(
      `INSERT INTO dod_revisions
        (project_id, revision_number, criteria_json, reason, created_by_principal_id, created_at)
       VALUES (?, 1, '["Reviewed"]', 'Original DoD', ?, ?)`,
    ).run(projectId, principalId, createdAt);
    database.prepare(
      `INSERT INTO sprints
        (sprint_id, project_id, sprint_key, title, goal, starts_on, ends_on, status, team_id,
         capacity_config_version, dod_revision_number, version, created_by_principal_id, created_at,
         started_at, closed_at, reason, review_summary, started_snapshot_json, closed_snapshot_json)
       VALUES (?, ?, 'SPRINT-1', 'Sprint One', 'Preserve its history', '2026-12-01', '2026-12-14', 'closed', ?,
         1, 1, 2, ?, ?, ?, ?, 'Close sprint', 'Delivered', '{"capacity": 40}', '{"delivered": 5}')`,
    ).run(sprintId, projectId, teamId, principalId, createdAt, createdAt, createdAt);

    applyMigrations(database);

    const team = database.prepare(
      "SELECT team_id, current_version, current_generation FROM teams WHERE project_id = ?",
    ).get(projectId) as { team_id: string; current_version: number; current_generation: number };
    const sprint = database.prepare(
      "SELECT team_id, capacity_config_version, started_snapshot_json, closed_snapshot_json FROM sprints WHERE sprint_id = ?",
    ).get(sprintId) as {
      team_id: string; capacity_config_version: number; started_snapshot_json: string; closed_snapshot_json: string;
    };
    const foreignKeyViolations = database.pragma("foreign_key_check") as unknown[];
    const teamsSql = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'teams'")
      .get() as { sql: string };
    const distinctTeam = randomUUID();

    assert.deepEqual(team, { team_id: teamId, current_version: 1, current_generation: 3 });
    assert.equal(sprint.team_id, teamId);
    assert.equal(sprint.capacity_config_version, 1);
    assert.equal(sprint.started_snapshot_json, '{"capacity": 40}');
    assert.equal(sprint.closed_snapshot_json, '{"delivered": 5}');
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM team_member_capacities WHERE project_id = ?")
      .get(projectId) as { count: number }).count, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM team_holidays WHERE project_id = ?")
      .get(projectId) as { count: number }).count, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM team_absences WHERE project_id = ?")
      .get(projectId) as { count: number }).count, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM dod_revisions WHERE project_id = ?")
      .get(projectId) as { count: number }).count, 1);
    assert.equal((database.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE project_id = ? AND entity_id = ? AND event_type = 'team.capacity_configured'",
    ).get(projectId, teamId) as { count: number }).count, 1);
    assert.deepEqual(foreignKeyViolations, []);
    assert.doesNotMatch(teamsSql.sql, /project_id\s+TEXT\s+NOT NULL\s+UNIQUE/i);
    database.prepare(
      "INSERT INTO teams (team_id, project_id, current_version, current_generation, created_at) VALUES (?, ?, 1, 1, ?)",
    ).run(distinctTeam, projectId, createdAt);
    database.prepare(
      `INSERT INTO team_config_versions
        (project_id, team_id, version, generation_number, team_name, timezone, hours_per_day, working_days_json,
         reason, created_by_principal_id, created_at)
       VALUES (?, ?, 1, 1, 'Second team', 'UTC', 8, '[1,2,3,4,5]', 'Second team config', ?, ?)`,
    ).run(projectId, distinctTeam, principalId, createdAt);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM teams WHERE project_id = ?")
      .get(projectId) as { count: number }).count, 2);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM team_config_versions WHERE project_id = ?")
      .get(projectId) as { count: number }).count, 2);
  });

  it("upgrades v22 forecast history and permits one active sprint per team", () => {
    applyMigrations(database, initialMigrations.slice(0, 22));
    const { projectId, principalId, createdAt } = insertMigrationProject(database, "TEAM23");
    const teamIds = [randomUUID(), randomUUID()];
    for (const [index, teamId] of teamIds.entries()) {
      database.prepare(
        "INSERT INTO teams (team_id, project_id, current_version, current_generation, created_at) VALUES (?, ?, 1, 1, ?)",
      ).run(teamId, projectId, createdAt);
      database.prepare(
        `INSERT INTO team_config_versions
          (project_id, team_id, version, generation_number, team_name, timezone, hours_per_day, working_days_json,
           reason, created_by_principal_id, created_at)
         VALUES (?, ?, 1, 1, ?, 'UTC', 8, '[1,2,3,4,5]', 'Migration fixture', ?, ?)`
      ).run(projectId, teamId, `Team ${index + 1}`, principalId, createdAt);
    }
    const milestoneId = randomUUID();
    database.prepare(
      `INSERT INTO milestones
        (milestone_id, project_id, milestone_key, title, goal, target_date, created_by_principal_id,
         created_at, updated_at, reason)
       VALUES (?, ?, 'M1', 'Milestone', 'Preserve forecast history', '2026-12-31', ?, ?, ?, 'Fixture')`,
    ).run(milestoneId, projectId, principalId, createdAt, createdAt);
    const legacyForecastId = randomUUID();
    database.prepare(
      `INSERT INTO milestone_forecast_snapshots
        (forecast_id, project_id, milestone_id, algorithm_version, as_of_date, watermark_sequence,
         calculated_at, snapshot_json, calculation_input_json)
       VALUES (?, ?, ?, '1.0.0', '2026-11-01', 12, ?, ?, '{}')`,
    ).run(legacyForecastId, projectId, milestoneId, createdAt, JSON.stringify({ teamId: teamIds[0] }));
    database.prepare(
      `INSERT INTO dod_revisions
        (project_id, revision_number, criteria_json, reason, created_by_principal_id, created_at)
       VALUES (?, 1, '["Reviewed"]', 'Fixture', ?, ?)`,
    ).run(projectId, principalId, createdAt);

    applyMigrations(database);

    const preserved = database.prepare(
      "SELECT team_id, snapshot_json FROM milestone_forecast_snapshots WHERE forecast_id = ?",
    ).get(legacyForecastId) as { team_id: string; snapshot_json: string };
    assert.equal(preserved.team_id, teamIds[0]);
    assert.equal(JSON.parse(preserved.snapshot_json).teamId, teamIds[0]);
    const secondForecastId = randomUUID();
    database.prepare(
      `INSERT INTO milestone_forecast_snapshots
        (forecast_id, project_id, milestone_id, team_id, algorithm_version, as_of_date, watermark_sequence,
         calculated_at, snapshot_json, calculation_input_json)
       VALUES (?, ?, ?, ?, '1.0.0', '2026-11-01', 12, ?, ?, '{}')`,
    ).run(secondForecastId, projectId, milestoneId, teamIds[1], createdAt, JSON.stringify({ teamId: teamIds[1] }));
    assert.equal((database.prepare(
      `SELECT COUNT(*) AS count FROM milestone_forecast_snapshots
       WHERE project_id = ? AND milestone_id = ? AND as_of_date = '2026-11-01' AND watermark_sequence = 12`,
    ).get(projectId, milestoneId) as { count: number }).count, 2);
    assert.throws(() => database.prepare(
      `INSERT INTO milestone_forecast_snapshots
        (forecast_id, project_id, milestone_id, team_id, algorithm_version, as_of_date, watermark_sequence,
         calculated_at, snapshot_json, calculation_input_json)
       VALUES (?, ?, ?, ?, '1.0.0', '2026-11-01', 12, ?, ?, '{}')`,
    ).run(randomUUID(), projectId, milestoneId, teamIds[1], createdAt, JSON.stringify({ teamId: teamIds[1] })));
    for (const [index, teamId] of teamIds.entries()) {
      database.prepare(
        `INSERT INTO sprints
          (sprint_id, project_id, sprint_key, title, goal, starts_on, ends_on, status, team_id,
           capacity_config_version, dod_revision_number, created_by_principal_id, created_at, reason)
         VALUES (?, ?, ?, 'Sprint', 'Goal', '2026-11-01', '2026-11-14', 'active', ?, 1, 1, ?, ?, 'Fixture')`,
      ).run(randomUUID(), projectId, `ACTIVE-${index + 1}`, teamId, principalId, createdAt);
    }
    assert.throws(() => database.prepare(
      `INSERT INTO sprints
        (sprint_id, project_id, sprint_key, title, goal, starts_on, ends_on, status, team_id,
         capacity_config_version, dod_revision_number, created_by_principal_id, created_at, reason)
       VALUES (?, ?, 'ACTIVE-DUP', 'Sprint', 'Goal', '2026-11-01', '2026-11-14', 'active', ?, 1, 1, ?, ?, 'Fixture')`,
    ).run(randomUUID(), projectId, teamIds[0], principalId, createdAt));
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  });

  it("leaves a v21 backup readable by the previous migration set after upgrading the live database", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-v21-backup-"));
    const backupPath = join(workspace, "before-v22.sqlite");
    const source = openSqliteDatabase(join(workspace, "source.sqlite"));
    try {
      applyMigrations(source, initialMigrations.slice(0, 21));
      insertMigrationProject(source, "BACKUP");
      await source.backup(backupPath);
      applyMigrations(source);

      const previousRelease = openSqliteDatabase(backupPath);
      try {
        applyMigrations(previousRelease, initialMigrations.slice(0, 21));
        const version = previousRelease.prepare("SELECT MAX(version) AS version FROM schema_migrations")
          .get() as { version: number };
        const teamsSql = previousRelease.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'teams'")
          .get() as { sql: string };
        assert.equal(version.version, 21);
        assert.match(teamsSql.sql, /project_id TEXT NOT NULL UNIQUE REFERENCES projects/i);
      } finally {
        previousRelease.close();
      }
    } finally {
      source.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rolls back the v22 table rebuild and default teams when referential verification fails", () => {
    applyMigrations(database, initialMigrations.slice(0, 21));
    const { projectId, principalId, createdAt } = insertMigrationProject(database, "BADFK");
    const missingTeamId = randomUUID();
    database.pragma("foreign_keys = OFF");
    database.prepare(
      `INSERT INTO team_config_versions
        (project_id, team_id, version, generation_number, team_name, timezone, hours_per_day, working_days_json,
         reason, created_by_principal_id, created_at)
       VALUES (?, ?, 1, 0, 'Orphan', 'UTC', 8, '[1,2,3,4,5]', 'Bad fixture', ?, ?)`,
    ).run(projectId, missingTeamId, principalId, createdAt);
    database.pragma("foreign_keys = ON");

    assert.throws(() => applyMigrations(database), /foreign key violation/);

    const schemaVersion = database.prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    const teamsSql = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'teams'")
      .get() as { sql: string };
    assert.equal(schemaVersion.version, 21);
    assert.match(teamsSql.sql, /project_id TEXT NOT NULL UNIQUE REFERENCES projects/i);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM teams WHERE project_id = ?")
      .get(projectId) as { count: number }).count, 0);
  });

  it("keeps legacy team configurations in generation zero when upgrading from v15", () => {
    applyMigrations(database, initialMigrations.slice(0, 15));
    const projectId = randomUUID();
    const principalId = randomUUID();
    const teamId = randomUUID();
    const createdAt = new Date().toISOString();
    database.prepare(
      `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
       VALUES (?, 'human', ?, 'migration-owner', ?)`,
    ).run(principalId, `migration:${principalId}`, createdAt);
    database.prepare(
      `INSERT INTO projects
        (project_id, project_key, name, product_goal, timezone, created_at, created_by_principal_id)
       VALUES (?, 'MIG15', 'Migration owner', 'Preserve existing project', 'UTC', ?, ?)`,
    ).run(projectId, createdAt, principalId);
    database.prepare(
      "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, 'po', ?)",
    ).run(projectId, principalId, createdAt);
    database.prepare(
      "INSERT INTO teams (team_id, project_id, current_version, created_at) VALUES (?, ?, 1, ?)",
    ).run(teamId, projectId, createdAt);
    database.prepare(
      `INSERT INTO team_config_versions
        (project_id, team_id, version, team_name, timezone, hours_per_day, working_days_json,
         reason, created_by_principal_id, created_at)
       VALUES (?, ?, 1, 'Legacy team', 'UTC', 8, '[1,2,3,4,5]', 'Legacy snapshot', ?, ?)`,
    ).run(projectId, teamId, principalId, createdAt);

    applyMigrations(database);

    assert.equal((database.prepare("SELECT current_generation FROM teams WHERE project_id = ?")
      .get(projectId) as { current_generation: number }).current_generation, 0);
    assert.equal((database.prepare("SELECT generation_number FROM team_config_versions WHERE project_id = ?")
      .get(projectId) as { generation_number: number }).generation_number, 0);
  });

  it("rolls back schema changes and does not mark a failed migration applied", () => {
    const brokenMigration: SqliteMigration = {
      version: 1,
      name: "broken-migration",
      sql: "CREATE TABLE partial_migration (id INTEGER PRIMARY KEY); INSERT INTO missing_table VALUES (1);",
    };

    assert.throws(() => applyMigrations(database, [brokenMigration]), /missing_table/);

    const partialTable = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'partial_migration'")
      .get();
    const appliedCount = database
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number };

    assert.equal(partialTable, undefined);
    assert.equal(appliedCount.count, 0);
  });

  it("refuses to apply changed SQL for an already recorded version", () => {
    const original: SqliteMigration = {
      version: 1,
      name: "initial-projects",
      sql: initialMigrations[0]!.sql,
    };
    const changed: SqliteMigration = {
      ...original,
      sql: `${original.sql}\n-- modified after release\n`,
    };
    applyMigrations(database, [original]);

    assert.throws(() => applyMigrations(database, [changed]), /differs from the version recorded/);
  });

  it("includes migration behavior keys in drift detection", () => {
    applyMigrations(database);
    const finalMigration = initialMigrations.at(-1)!;
    const changed = [
      ...initialMigrations.slice(0, -1),
      { ...finalMigration, checksumKey: "changed-post-apply-contract" },
    ];
    const changedRebuildMode = [
      ...initialMigrations.slice(0, 21),
      { ...initialMigrations[21]!, disableForeignKeysForRebuild: false },
      ...initialMigrations.slice(22),
    ];

    assert.throws(() => applyMigrations(database, changed), /differs from the version recorded/);
    assert.throws(() => applyMigrations(database, changedRebuildMode), /differs from the version recorded/);
  });

  it("backfills immutable initial revisions when upgrading a database with existing work items", () => {
    applyMigrations(database, initialMigrations.slice(0, 3));
    const projectId = randomUUID();
    const principalId = randomUUID();
    const itemId = randomUUID();
    const criterionId = randomUUID();
    const createdAt = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
         VALUES (?, 'human', ?, 'migration-test', ?)`,
      )
      .run(principalId, `test:${principalId}`, createdAt);
    database
      .prepare(
        `INSERT INTO projects (project_id, project_key, name, product_goal, timezone, created_at, created_by_principal_id)
         VALUES (?, 'MIG', 'Migration test', 'Migration goal', 'UTC', ?, ?)`,
      )
      .run(projectId, createdAt, principalId);
    database
      .prepare(
        `INSERT INTO work_items
          (item_id, project_id, item_key, type, title, priority, created_by_principal_id, created_at, updated_at)
         VALUES (?, ?, 'MIG-1', 'epic', 'Existing epic', 2, ?, ?, ?)`,
      )
      .run(itemId, projectId, principalId, createdAt, createdAt);
    database
      .prepare(
        `INSERT INTO work_item_criteria
          (criterion_id, project_id, item_id, criterion_key, description, is_required, position, created_at)
         VALUES (?, ?, ?, 'AC-1', 'Existing criterion', 0, 1, ?)`,
      )
      .run(criterionId, projectId, itemId, createdAt);

    applyMigrations(database);
    const row = database
      .prepare(
        `SELECT revision_number, snapshot_json, status, published_by_principal_id, published_at
         FROM work_item_revisions WHERE item_id = ?`,
      )
      .get(itemId) as {
      revision_number: number;
      snapshot_json: string;
      status: string;
      published_by_principal_id: string;
      published_at: string;
    };
    const snapshot = JSON.parse(row.snapshot_json) as {
      title: string;
      criteria: Array<{ id: string; description: string; required: boolean }>;
    };

    assert.equal(row.revision_number, 1);
    assert.equal(row.status, "published");
    assert.equal(row.published_by_principal_id, principalId);
    assert.equal(row.published_at, createdAt);
    assert.equal(snapshot.title, "Existing epic");
    assert.deepEqual(snapshot.criteria, [
      { id: criterionId, description: "Existing criterion", required: false, position: 1, key: "AC-1" },
    ]);
    const indexedItem = database
      .prepare(
        `SELECT wi.item_key FROM work_items_fts
         INNER JOIN work_items AS wi ON wi.rowid = work_items_fts.rowid
         WHERE work_items_fts MATCH 'existing'`,
      )
      .get() as { item_key: string } | undefined;
    assert.equal(indexedItem?.item_key, "MIG-1");
    const indexedNode = database
      .prepare("SELECT node_type, node_key FROM trace_nodes WHERE project_id = ? AND node_id = ?")
      .get(projectId, itemId) as { node_type: string; node_key: string } | undefined;
    assert.deepEqual(indexedNode, { node_type: "work_item", node_key: "MIG-1" });
    assert.throws(() =>
      database
        .prepare("UPDATE work_item_revisions SET snapshot_json = '{}' WHERE item_id = ?")
        .run(itemId),
    );
    const ranked = database
      .prepare("SELECT rank, assignee_principal_id FROM work_items WHERE item_id = ?")
      .get(itemId) as { rank: number; assignee_principal_id: string | null };
    assert.deepEqual(ranked, { rank: 1024, assignee_principal_id: null });
    const feature = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'work_item_estimate_proposals'")
      .get() as { name: string } | undefined;
    const comments = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'work_item_comments'")
      .get() as { name: string } | undefined;
    assert.equal(feature?.name, "work_item_estimate_proposals");
    assert.equal(comments?.name, "work_item_comments");
  });
});

function insertMigrationProject(
  database: SqliteDatabase,
  projectKey: string,
  projectId = randomUUID(),
  principalId = randomUUID(),
): { projectId: string; principalId: string; createdAt: string } {
  const createdAt = new Date().toISOString();
  database.prepare(
    `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
     VALUES (?, 'human', ?, 'Migration owner', ?)`,
  ).run(principalId, `migration:${principalId}`, createdAt);
  database.prepare(
    `INSERT INTO projects
      (project_id, project_key, name, product_goal, timezone, created_at, created_by_principal_id)
     VALUES (?, ?, 'Migration project', 'Preserve project history', 'UTC', ?, ?)`,
  ).run(projectId, projectKey, createdAt, principalId);
  database.prepare(
    "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, 'po', ?)",
  ).run(projectId, principalId, createdAt);
  return { projectId, principalId, createdAt };
}
