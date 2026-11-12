import { randomUUID } from "node:crypto";
import type { AcceptanceCriterion, WorkItemContentRevision, WorkItemType } from "../domain/work-items.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { assertProjectAuthorization, type ProjectRole } from "./local-identity.js";
import { resolveWorkItemIdentifier } from "./work-item-reference.js";

export interface ProposeWorkItemRevisionInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly itemIdOrKey: string;
  readonly expectedVersion: number;
  readonly title?: string;
  readonly description?: string | null;
  readonly priority?: number;
  readonly businessValueScore?: number | null;
  readonly businessValueRationale?: string | null;
  readonly criteria?: readonly {
    readonly id?: string;
    readonly description: string;
    readonly required?: boolean;
  }[];
}

export interface PublishWorkItemRevisionInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly itemIdOrKey: string;
  readonly revisionNumber: number;
  readonly expectedVersion: number;
}

interface WorkItemTarget {
  readonly item_id: string;
  readonly project_id: string;
  readonly item_key: string;
  readonly type: WorkItemType;
  readonly parent_id: string | null;
  readonly related_story_id: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly priority: number;
  readonly business_value_score: number | null;
  readonly business_value_rationale: string | null;
  readonly version: number;
}

interface WorkItemSnapshot {
  readonly type: WorkItemType;
  readonly parentId: string | null;
  readonly relatedStoryId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly priority: number;
  readonly businessValueScore: number | null;
  readonly businessValueRationale: string | null;
  readonly criteria: readonly AcceptanceCriterion[];
}

interface RevisionRow {
  readonly revision_id: string;
  readonly project_id: string;
  readonly item_id: string;
  readonly revision_number: number;
  readonly status: WorkItemContentRevision["status"];
  readonly snapshot_json: string;
  readonly created_by_principal_id: string;
  readonly created_at: string;
  readonly published_by_principal_id: string | null;
  readonly published_at: string | null;
}

const proposalRolesByType: Readonly<Record<WorkItemType, readonly ProjectRole[]>> = {
  epic: ["po", "developer"],
  feature: ["po", "developer"],
  story: ["po", "developer", "qa"],
  bug: ["po", "developer", "qa"],
  task: ["po", "developer", "qa"],
};

export function proposeWorkItemRevision(
  database: SqliteDatabase,
  input: ProposeWorkItemRevisionInput,
): CommandReceipt<WorkItemContentRevision> {
  const reference = input.itemIdOrKey.trim();
  const target = findWorkItem(database, input.projectId, input.principalId, reference);
  const requiredRoles = proposalRolesByType[target.type];

  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "work_item.revision.propose",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      itemId: target.item_id,
      expectedVersion: input.expectedVersion,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.businessValueScore === undefined ? {} : { businessValueScore: input.businessValueScore }),
      ...(input.businessValueRationale === undefined ? {} : { businessValueRationale: input.businessValueRationale }),
      ...(input.criteria === undefined
        ? {}
        : {
            criteria: input.criteria.map((criterion) => ({
              ...(criterion.id === undefined ? {} : { id: criterion.id }),
              description: criterion.description,
              ...(criterion.required === undefined ? {} : { required: criterion.required }),
            })),
          }),
    },
    requiredRoles,
    auditEvent: (revision) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "work_item.revision_proposed",
      entityType: "work_item",
      entityId: target.item_id,
      payload: { itemKey: target.item_key, revisionNumber: revision.revisionNumber },
    }),
    execute: () => {
      assertExpectedVersion(target.version, input.expectedVersion);
      const openDraft = database
        .prepare(
          `SELECT revision_number FROM work_item_revisions
           WHERE project_id = ? AND item_id = ? AND status = 'draft'`,
        )
        .get(input.projectId, target.item_id);
      if (openDraft !== undefined) {
        throw new ApplicationError(
          "VALIDATION_FAILED",
          "Publish the open work item revision before proposing another one.",
        );
      }
      const current = database
        .prepare(
          `SELECT snapshot_json FROM work_item_revisions
           WHERE project_id = ? AND item_id = ? AND status = 'published'`,
        )
        .get(input.projectId, target.item_id) as { snapshot_json: string } | undefined;
      if (current === undefined) {
        throw new ApplicationError("VALIDATION_FAILED", "The work item has no published revision.");
      }
      const previousSnapshot = JSON.parse(current.snapshot_json) as WorkItemSnapshot;
      const snapshot = normalizeSnapshot(database, input, target, previousSnapshot);
      if (JSON.stringify(snapshot) === JSON.stringify(previousSnapshot)) {
        throw new ApplicationError("VALIDATION_FAILED", "The proposed revision does not change the published content.");
      }

      const latest = database
        .prepare(
          `SELECT COALESCE(MAX(revision_number), 0) AS revision FROM work_item_revisions
           WHERE project_id = ? AND item_id = ?`,
        )
        .get(input.projectId, target.item_id) as { revision: number };
      const now = new Date().toISOString();
      const revision: WorkItemContentRevision = {
        id: randomUUID(),
        projectId: input.projectId,
        itemId: target.item_id,
        revisionNumber: latest.revision + 1,
        status: "draft",
        snapshot,
        createdByPrincipalId: input.principalId,
        createdAt: now,
        publishedByPrincipalId: null,
        publishedAt: null,
      };
      database
        .prepare(
          `INSERT INTO work_item_revisions
            (revision_id, project_id, item_id, revision_number, snapshot_json, created_by_principal_id, created_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
        )
        .run(
          revision.id,
          revision.projectId,
          revision.itemId,
          revision.revisionNumber,
          JSON.stringify(snapshot),
          revision.createdByPrincipalId,
          revision.createdAt,
        );
      updateWorkItemVersion(database, input.projectId, target.item_id, input.expectedVersion);
      return revision;
    },
  });
}

export function publishWorkItemRevision(
  database: SqliteDatabase,
  input: PublishWorkItemRevisionInput,
): CommandReceipt<WorkItemContentRevision> {
  const reference = input.itemIdOrKey.trim();
  const target = findWorkItem(database, input.projectId, input.principalId, reference);
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "work_item.revision.publish",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      itemId: target.item_id,
      revisionNumber: input.revisionNumber,
      expectedVersion: input.expectedVersion,
    },
    requiredRoles: ["po"],
    auditEvent: (revision) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "work_item.revision_published",
      entityType: "work_item",
      entityId: target.item_id,
      payload: { itemKey: target.item_key, revisionNumber: revision.revisionNumber },
    }),
    execute: () => {
      assertExpectedVersion(target.version, input.expectedVersion);
      const row = database
        .prepare(
          `SELECT revision_id, project_id, item_id, revision_number, status, snapshot_json,
                  created_by_principal_id, created_at, published_by_principal_id, published_at
           FROM work_item_revisions WHERE project_id = ? AND item_id = ? AND revision_number = ?`,
        )
        .get(input.projectId, target.item_id, input.revisionNumber) as RevisionRow | undefined;
      if (row === undefined) {
        throw new ApplicationError("NOT_FOUND", "Work item revision was not found.");
      }
      if (row.status !== "draft") {
        throw new ApplicationError("VALIDATION_FAILED", "Only a draft work item revision can be published.");
      }
      const latest = database
        .prepare(
          `SELECT MAX(revision_number) AS revision FROM work_item_revisions
           WHERE project_id = ? AND item_id = ?`,
        )
        .get(input.projectId, target.item_id) as { revision: number };
      if (latest.revision !== row.revision_number) {
        throw new ApplicationError("VALIDATION_FAILED", "Only the latest work item revision can be published.");
      }
      const principal = database
        .prepare("SELECT principal_type FROM principals WHERE principal_id = ?")
        .get(input.principalId) as { principal_type: string } | undefined;
      if (principal?.principal_type !== "human") {
        throw new ApplicationError("FORBIDDEN", "Only a human principal may publish a work item revision.");
      }

      const snapshot = JSON.parse(row.snapshot_json) as WorkItemSnapshot;
      const now = new Date().toISOString();
      const oldPublished = database
        .prepare(
          `UPDATE work_item_revisions SET status = 'superseded'
           WHERE project_id = ? AND item_id = ? AND status = 'published'`,
        )
        .run(input.projectId, target.item_id);
      if (oldPublished.changes !== 1) {
        throw new ApplicationError("VALIDATION_FAILED", "The work item has no unique current published revision.");
      }
      const publication = database
        .prepare(
          `UPDATE work_item_revisions
           SET status = 'published', published_by_principal_id = ?, published_at = ?
           WHERE project_id = ? AND item_id = ? AND revision_number = ? AND status = 'draft'`,
        )
        .run(input.principalId, now, input.projectId, target.item_id, input.revisionNumber);
      if (publication.changes !== 1) {
        throw new ApplicationError("VALIDATION_FAILED", "The work item revision is no longer a draft.");
      }

      applySnapshotToWorkItem(database, target, snapshot, now);
      updateWorkItemVersion(database, input.projectId, target.item_id, input.expectedVersion);
      return {
        id: row.revision_id,
        projectId: row.project_id,
        itemId: row.item_id,
        revisionNumber: row.revision_number,
        status: "published",
        snapshot,
        createdByPrincipalId: row.created_by_principal_id,
        createdAt: row.created_at,
        publishedByPrincipalId: input.principalId,
        publishedAt: now,
      };
    },
  });
}

function normalizeSnapshot(
  database: SqliteDatabase,
  input: ProposeWorkItemRevisionInput,
  target: WorkItemTarget,
  previous: WorkItemSnapshot,
): WorkItemSnapshot {
  const title = input.title === undefined ? previous.title : input.title.trim();
  const description = input.description === undefined
    ? previous.description
    : (input.description?.trim() || null);
  const priority = input.priority ?? previous.priority;
  const businessValueScore = input.businessValueScore === undefined
    ? (previous.businessValueScore ?? target.business_value_score ?? null)
    : input.businessValueScore;
  const businessValueRationale = input.businessValueRationale === undefined
    ? (previous.businessValueRationale ?? target.business_value_rationale ?? null)
    : (input.businessValueRationale?.trim() || null);
  if (title.length === 0 || title.length > 200) {
    throw new ApplicationError("VALIDATION_FAILED", "Title must contain between 1 and 200 characters.");
  }
  if (description !== null && description.length > 10_000) {
    throw new ApplicationError("VALIDATION_FAILED", "Description cannot exceed 10000 characters.");
  }
  if (!Number.isSafeInteger(priority) || priority < 1 || priority > 4) {
    throw new ApplicationError("VALIDATION_FAILED", "Priority must be an integer between 1 and 4.");
  }
  validateBusinessValue(target.type, businessValueScore, businessValueRationale);

  const criteria = input.criteria === undefined
    ? previous.criteria
    : normalizeCriteria(database, input.projectId, target, input.criteria);
  if (criteria.length > 0 && target.type !== "story" && target.type !== "bug") {
    throw new ApplicationError("VALIDATION_FAILED", "Acceptance criteria can only be added to stories and bugs.");
  }
  return {
    type: previous.type,
    parentId: previous.parentId,
    relatedStoryId: previous.relatedStoryId,
    title,
    description,
    priority,
    businessValueScore,
    businessValueRationale,
    criteria,
  };
}

function validateBusinessValue(type: WorkItemType, score: number | null, rationale: string | null): void {
  if (score !== null && (!Number.isSafeInteger(score) || score < 0 || score > 100)) {
    throw new ApplicationError("VALIDATION_FAILED", "Business value score must be an integer between 0 and 100.");
  }
  if (type !== "epic" && type !== "feature" && type !== "task" && (score !== null || rationale !== null)) {
    throw new ApplicationError("VALIDATION_FAILED", "Business value may only be set on epics, features and tasks.");
  }
  if ((score === null) !== (rationale === null) || (rationale !== null && (rationale.length === 0 || rationale.length > 1000))) {
    throw new ApplicationError("VALIDATION_FAILED", "A business value score requires a rationale of 1-1000 characters; clearing both fields is allowed.");
  }
}

function normalizeCriteria(
  database: SqliteDatabase,
  projectId: string,
  target: WorkItemTarget,
  criteria: readonly {
    readonly id?: string;
    readonly description: string;
    readonly required?: boolean;
  }[],
): readonly AcceptanceCriterion[] {
  if (criteria.length > 50) {
    throw new ApplicationError("VALIDATION_FAILED", "At most 50 acceptance criteria can be included in a revision.");
  }
  const allRows = database
    .prepare("SELECT criterion_id, criterion_key, is_required FROM work_item_criteria WHERE project_id = ? AND item_id = ?")
    .all(projectId, target.item_id) as Array<{
    criterion_id: string;
    criterion_key: string;
    is_required: number;
  }>;
  const byId = new Map(allRows.map((row) => [row.criterion_id, row]));
  let nextNumber = allRows.reduce((maximum, row) => {
    const match = /^AC-(\d+)$/i.exec(row.criterion_key);
    return Math.max(maximum, match === null ? 0 : Number(match[1]));
  }, 0) + 1;
  const seenIds = new Set<string>();
  const seenDescriptions = new Set<string>();
  return criteria.map((criterion, index) => {
    const description = criterion.description.trim();
    const normalizedDescription = description.toLowerCase();
    if (description.length === 0 || description.length > 2_000 || seenDescriptions.has(normalizedDescription)) {
      throw new ApplicationError("VALIDATION_FAILED", "Acceptance criteria must be unique and contain 1-2000 characters.");
    }
    seenDescriptions.add(normalizedDescription);
    let id: string;
    let key: string;
    if (criterion.id !== undefined) {
      const existing = byId.get(criterion.id);
      if (existing === undefined) {
        throw new ApplicationError("VALIDATION_FAILED", "A criterion ID must belong to this work item.");
      }
      id = existing.criterion_id;
      key = existing.criterion_key;
    } else {
      id = randomUUID();
      key = `AC-${nextNumber}`;
      nextNumber += 1;
    }
    if (seenIds.has(id)) {
      throw new ApplicationError("VALIDATION_FAILED", "A criterion ID may only appear once in a revision.");
    }
    seenIds.add(id);
    const existing = byId.get(id);
    return {
      id,
      key,
      description,
      required: criterion.required ?? (existing === undefined || existing.is_required === 1),
      position: index + 1,
    };
  });
}

function applySnapshotToWorkItem(
  database: SqliteDatabase,
  target: WorkItemTarget,
  snapshot: WorkItemSnapshot,
  now: string,
): void {
  database
    .prepare(
      `UPDATE work_items SET title = ?, description = ?, priority = ?,
              business_value_score = ?, business_value_rationale = ?
       WHERE project_id = ? AND item_id = ?`,
    )
    .run(snapshot.title, snapshot.description, snapshot.priority, snapshot.businessValueScore,
      snapshot.businessValueRationale, target.project_id, target.item_id);

  database
    .prepare(
      `UPDATE work_item_criteria SET position = position + 1000000, is_active = 0
       WHERE project_id = ? AND item_id = ?`,
    )
    .run(target.project_id, target.item_id);
  const findCriterion = database.prepare(
    `SELECT criterion_key FROM work_item_criteria
     WHERE project_id = ? AND item_id = ? AND criterion_id = ?`,
  );
  const insertCriterion = database.prepare(
    `INSERT INTO work_item_criteria
      (criterion_id, project_id, item_id, criterion_key, description, is_required, position, created_at, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  const updateCriterion = database.prepare(
    `UPDATE work_item_criteria
     SET description = ?, is_required = ?, position = ?, is_active = 1
     WHERE project_id = ? AND item_id = ? AND criterion_id = ?`,
  );
  for (const criterion of snapshot.criteria) {
    const existing = findCriterion.get(target.project_id, target.item_id, criterion.id) as
      | { criterion_key: string }
      | undefined;
    if (existing === undefined) {
      insertCriterion.run(
        criterion.id,
        target.project_id,
        target.item_id,
        criterion.key,
        criterion.description,
        criterion.required ? 1 : 0,
        criterion.position,
        now,
      );
    } else {
      if (existing.criterion_key !== criterion.key) {
        throw new ApplicationError("VALIDATION_FAILED", "Acceptance criterion keys are immutable.");
      }
      updateCriterion.run(
        criterion.description,
        criterion.required ? 1 : 0,
        criterion.position,
        target.project_id,
        target.item_id,
        criterion.id,
      );
    }
  }
}

function findWorkItem(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  reference: string,
): WorkItemTarget {
  assertProjectAuthorization(database, projectId, principalId);
  if (reference.length === 0) {
    throw new ApplicationError("VALIDATION_FAILED", "A work item ID or key is required.");
  }
  const lookupReference = resolveWorkItemIdentifier(database, projectId, reference);
  const item = database
    .prepare(
      `SELECT item_id, project_id, item_key, type, parent_id, related_story_id,
              title, description, priority, business_value_score, business_value_rationale, version
       FROM work_items WHERE project_id = ? AND (item_id = ? OR item_key = ? COLLATE NOCASE)`,
    )
    .get(projectId, lookupReference, lookupReference) as WorkItemTarget | undefined;
  if (item === undefined) {
    throw new ApplicationError("NOT_FOUND", "Work item was not found.");
  }
  return item;
}

function assertExpectedVersion(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new ApplicationError("VALIDATION_FAILED", "Expected version must be a positive integer.");
  }
  if (actual !== expected) {
    throw new ApplicationError(
      "VERSION_CONFLICT",
      "The work item changed since it was read.",
      { details: { expectedVersion: expected, actualVersion: actual } },
    );
  }
}

function updateWorkItemVersion(
  database: SqliteDatabase,
  projectId: string,
  itemId: string,
  expectedVersion: number,
): void {
  const now = new Date().toISOString();
  const result = database
    .prepare(
      `UPDATE work_items SET version = version + 1, updated_at = ?
       WHERE project_id = ? AND item_id = ? AND version = ?`,
    )
    .run(now, projectId, itemId, expectedVersion);
  if (result.changes !== 1) {
    const current = database
      .prepare("SELECT version FROM work_items WHERE project_id = ? AND item_id = ?")
      .get(projectId, itemId) as { version: number } | undefined;
    if (current === undefined) {
      throw new ApplicationError("NOT_FOUND", "Work item was not found.");
    }
    assertExpectedVersion(current.version, expectedVersion);
  }
}

