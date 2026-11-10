import { randomUUID } from "node:crypto";
import type { Milestone, MilestoneScopeEvent, MilestoneScopeItem, MilestoneSummary } from "../domain/milestones.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { assertProjectAuthorization } from "./local-identity.js";

export interface CreateMilestoneInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly milestoneKey: string;
  readonly title: string;
  readonly goal: string;
  readonly targetDate: string;
  readonly itemIdsOrKeys: readonly string[];
  readonly reason: string;
}

export interface ChangeMilestoneScopeInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly milestoneIdOrKey: string;
  readonly expectedVersion: number;
  readonly addItemIdsOrKeys?: readonly string[] | undefined;
  readonly removeItemIdsOrKeys?: readonly string[] | undefined;
  readonly reason: string;
}

interface MilestoneRow {
  readonly milestone_id: string;
  readonly project_id: string;
  readonly milestone_key: string;
  readonly title: string;
  readonly goal: string;
  readonly target_date: string;
  readonly version: number;
  readonly created_by_principal_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly reason: string;
}

interface PbiSnapshot {
  readonly itemId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly stateAtApproval: string;
  readonly currentState: string;
  readonly points: number;
  readonly baselineId: string;
  readonly itemRevisionNumber: number;
}

export function createMilestone(
  database: SqliteDatabase,
  input: CreateMilestoneInput,
): CommandReceipt<Milestone> {
  const key = normalizeKey(input.milestoneKey);
  const title = normalizeText(input.title, 120, "Milestone title must contain 1-120 characters.");
  const goal = normalizeText(input.goal, 1_000, "Milestone goal must contain 1-1000 characters.");
  const targetDate = normalizeDate(input.targetDate, "Milestone target date");
  const references = normalizeReferences(input.itemIdsOrKeys, "Milestone approved scope", 1, 100);
  const reason = normalizeText(input.reason, 1_000, "Milestone reason must contain 1-1000 characters.");

  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "milestone.create",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      milestoneKey: key,
      title,
      goal,
      targetDate,
      itemIdsOrKeys: references,
      reason,
    },
    requiredRoles: ["po"],
    auditEvent: (milestone) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "milestone.created",
      entityType: "milestone",
      entityId: milestone.id,
      reason,
      payload: {
        milestoneKey: milestone.key,
        targetDate: milestone.targetDate,
        version: milestone.version,
        scopeItemIds: milestone.scope.map((item) => item.itemId),
        scopePoints: milestone.scope.reduce((total, item) => total + item.points, 0),
      },
    }),
    execute: () => {
      assertHumanProjectPo(database, input.projectId, input.principalId);
      const conflict = database.prepare(
        "SELECT milestone_id FROM milestones WHERE project_id = ? AND milestone_key = ? COLLATE NOCASE",
      ).get(input.projectId, key);
      if (conflict !== undefined) {
        throw new ApplicationError("MILESTONE_KEY_CONFLICT", `Milestone key '${key}' already exists in this project.`);
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      database.prepare(
        `INSERT INTO milestones
          (milestone_id, project_id, milestone_key, title, goal, target_date, version,
           created_by_principal_id, created_at, updated_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      ).run(id, input.projectId, key, title, goal, targetDate, input.principalId, now, now, reason);

      const snapshots = references.map((reference) => getApprovedPbiSnapshot(database, input.projectId, reference));
      assertUniqueSnapshots(snapshots, "A PBI can appear only once in a milestone's approved scope.");
      for (const snapshot of snapshots) {
        appendScopeEvent(database, {
          projectId: input.projectId,
          milestoneId: id,
          snapshot,
          action: "add",
          reason,
          principalId: input.principalId,
          now,
        });
      }
      return readMilestone(database, input.projectId, id);
    },
  });
}

export function changeMilestoneScope(
  database: SqliteDatabase,
  input: ChangeMilestoneScopeInput,
): CommandReceipt<Milestone> {
  const reference = normalizeText(input.milestoneIdOrKey, 80, "Milestone reference is required.");
  const additions = normalizeReferences(input.addItemIdsOrKeys ?? [], "Scope additions", 0, 100);
  const removals = normalizeReferences(input.removeItemIdsOrKeys ?? [], "Scope removals", 0, 100);
  if (additions.length === 0 && removals.length === 0) {
    throw new ApplicationError("VALIDATION_FAILED", "Add or remove at least one PBI from the milestone scope.");
  }
  const removalReferences = new Set(removals.map((item) => item.toLocaleLowerCase("en-US")));
  if (additions.some((item) => removalReferences.has(item.toLocaleLowerCase("en-US")))) {
    throw new ApplicationError("VALIDATION_FAILED", "The same PBI cannot be added and removed in one milestone scope change.");
  }
  const reason = normalizeText(input.reason, 1_000, "Scope change reason must contain 1-1000 characters.");
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new ApplicationError("VALIDATION_FAILED", "Milestone expectedVersion must be a positive integer.");
  }
  assertProjectAuthorization(database, input.projectId, input.principalId, ["po"]);
  const initial = findMilestone(database, input.projectId, reference);

  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "milestone.scope.change",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      milestoneId: initial.milestone_id,
      expectedVersion: input.expectedVersion,
      additions,
      removals,
      reason,
    },
    requiredRoles: ["po"],
    auditEvent: (milestone) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "milestone.scope_changed",
      entityType: "milestone",
      entityId: milestone.id,
      reason,
      payload: {
        version: milestone.version,
        addedItemIds: additions,
        removedItemIds: removals,
      },
    }),
    execute: () => {
      assertHumanProjectPo(database, input.projectId, input.principalId);
      const current = findMilestone(database, input.projectId, initial.milestone_id);
      if (current.version !== input.expectedVersion) {
        throw new ApplicationError("VERSION_CONFLICT", "Milestone scope changed since it was read.", {
          details: { expectedVersion: input.expectedVersion, actualVersion: current.version },
        });
      }
      const scope = currentMilestoneScope(database, input.projectId, current.milestone_id);
      const byReference = new Map(scope.flatMap((item) => [[item.itemId, item], [item.itemKey.toLocaleLowerCase("en-US"), item]]));
      const removalItems = removals.map((itemReference) => {
        const item = byReference.get(itemReference) ?? byReference.get(itemReference.toLocaleLowerCase("en-US"));
        if (item === undefined) {
          throw new ApplicationError("VALIDATION_FAILED", `PBI '${itemReference}' is not in the milestone's approved scope.`);
        }
        return item;
      });
      assertUniqueSnapshots(removalItems, "A PBI can be removed only once from a milestone scope change.");
      const additionSnapshots = additions.map((itemReference) => getApprovedPbiSnapshot(database, input.projectId, itemReference));
      assertUniqueSnapshots(additionSnapshots, "A PBI can be added only once in a milestone scope change.");
      const removalIds = new Set(removalItems.map((item) => item.itemId));
      if (additionSnapshots.some((snapshot) => removalIds.has(snapshot.itemId))) {
        throw new ApplicationError("VALIDATION_FAILED", "The same PBI cannot be added and removed in one milestone scope change.");
      }
      const now = new Date().toISOString();

      for (const item of removalItems) {
        appendScopeEvent(database, {
          projectId: input.projectId,
          milestoneId: current.milestone_id,
          snapshot: {
            ...item,
            stateAtApproval: item.currentState,
          },
          action: "remove",
          reason,
          principalId: input.principalId,
          now,
        });
        byReference.delete(item.itemId);
        byReference.delete(item.itemKey.toLocaleLowerCase("en-US"));
      }

      for (const snapshot of additionSnapshots) {
        if (byReference.has(snapshot.itemId) || byReference.has(snapshot.itemKey.toLocaleLowerCase("en-US"))) {
          throw new ApplicationError("VALIDATION_FAILED", `PBI '${snapshot.itemKey}' is already in the approved milestone scope.`);
        }
        appendScopeEvent(database, {
          projectId: input.projectId,
          milestoneId: current.milestone_id,
          snapshot,
          action: "add",
          reason,
          principalId: input.principalId,
          now,
        });
        byReference.set(snapshot.itemId, snapshot);
        byReference.set(snapshot.itemKey.toLocaleLowerCase("en-US"), snapshot);
      }

      const updated = database.prepare(
        `UPDATE milestones SET version = version + 1, updated_at = ?
         WHERE project_id = ? AND milestone_id = ? AND version = ?`,
      ).run(now, input.projectId, current.milestone_id, input.expectedVersion);
      if (updated.changes !== 1) {
        throw new ApplicationError("VERSION_CONFLICT", "Milestone scope changed during update.");
      }
      return readMilestone(database, input.projectId, current.milestone_id);
    },
  });
}

export function getMilestone(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  milestoneIdOrKey: string,
): Milestone {
  assertProjectAuthorization(database, projectId, principalId);
  const row = findMilestone(database, projectId, milestoneIdOrKey.trim());
  return readMilestone(database, projectId, row.milestone_id);
}

export function listMilestones(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  limit = 50,
): readonly MilestoneSummary[] {
  assertProjectAuthorization(database, projectId, principalId);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "Milestone page size must be an integer between 1 and 100.");
  }
  const rows = database.prepare(
    `SELECT m.milestone_id, m.project_id, m.milestone_key, m.title, m.goal, m.target_date,
            m.version, m.created_at, m.updated_at,
            COUNT(scope.item_id) AS scope_item_count, COALESCE(SUM(scope.points), 0) AS scope_points
     FROM milestones m
     LEFT JOIN (
       SELECT event.project_id, event.milestone_id, event.item_id, event.points
       FROM milestone_scope_events event
       INNER JOIN (
         SELECT project_id, milestone_id, item_id, MAX(sequence) AS latest_sequence
         FROM milestone_scope_events GROUP BY project_id, milestone_id, item_id
       ) latest ON latest.latest_sequence = event.sequence
       WHERE event.action = 'add'
     ) scope ON scope.project_id = m.project_id AND scope.milestone_id = m.milestone_id
     WHERE m.project_id = ?
     GROUP BY m.project_id, m.milestone_id
     ORDER BY m.target_date, m.milestone_key COLLATE NOCASE LIMIT ?`,
  ).all(projectId, limit) as Array<{
    milestone_id: string;
    project_id: string;
    milestone_key: string;
    title: string;
    goal: string;
    target_date: string;
    version: number;
    created_at: string;
    updated_at: string;
    scope_item_count: number;
    scope_points: number;
  }>;
  return rows.map((row) => ({
    id: row.milestone_id,
    projectId: row.project_id,
    key: row.milestone_key,
    title: row.title,
    goal: row.goal,
    targetDate: row.target_date,
    version: row.version,
    scopeItemCount: row.scope_item_count,
    scopePoints: row.scope_points,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function findMilestone(database: SqliteDatabase, projectId: string, reference: string): MilestoneRow {
  const row = database.prepare(
    `SELECT milestone_id, project_id, milestone_key, title, goal, target_date, version,
            created_by_principal_id, created_at, updated_at, reason
     FROM milestones WHERE project_id = ? AND (milestone_id = ? OR milestone_key = ? COLLATE NOCASE)`,
  ).get(projectId, reference, reference) as MilestoneRow | undefined;
  if (row === undefined) throw new ApplicationError("NOT_FOUND", "Milestone was not found in this project.");
  return row;
}

function readMilestone(database: SqliteDatabase, projectId: string, milestoneId: string): Milestone {
  const row = findMilestone(database, projectId, milestoneId);
  return {
    id: row.milestone_id,
    projectId: row.project_id,
    key: row.milestone_key,
    title: row.title,
    goal: row.goal,
    targetDate: row.target_date,
    version: row.version,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reason: row.reason,
    scope: currentMilestoneScope(database, projectId, milestoneId),
    scopeHistory: readMilestoneScopeHistory(database, projectId, milestoneId),
  };
}

function currentMilestoneScope(database: SqliteDatabase, projectId: string, milestoneId: string): MilestoneScopeItem[] {
  const rows = database.prepare(
    `SELECT event.item_id, event.item_key, event.item_title, event.item_state,
            event.baseline_id, event.item_revision_number, event.points, wi.state AS current_state
     FROM milestone_scope_events event
     INNER JOIN (
       SELECT item_id, MAX(sequence) AS latest_sequence
       FROM milestone_scope_events WHERE project_id = ? AND milestone_id = ? GROUP BY item_id
     ) latest ON latest.latest_sequence = event.sequence
     INNER JOIN work_items wi ON wi.project_id = event.project_id AND wi.item_id = event.item_id
     WHERE event.project_id = ? AND event.milestone_id = ? AND event.action = 'add'
     ORDER BY event.sequence`,
  ).all(projectId, milestoneId, projectId, milestoneId) as Array<{
    item_id: string;
    item_key: string;
    item_title: string;
    item_state: string;
    baseline_id: string;
    item_revision_number: number;
    points: number;
    current_state: string;
  }>;
  return rows.map((row) => ({
    itemId: row.item_id,
    itemKey: row.item_key,
    title: row.item_title,
    stateAtApproval: row.item_state,
    currentState: row.current_state,
    points: row.points,
    baselineId: row.baseline_id,
    itemRevisionNumber: row.item_revision_number,
  }));
}

function readMilestoneScopeHistory(database: SqliteDatabase, projectId: string, milestoneId: string): MilestoneScopeEvent[] {
  const rows = database.prepare(
    `SELECT event.sequence, event.scope_event_id, event.item_id, event.item_key,
            event.item_title, event.item_state, event.action, event.baseline_id,
            event.item_revision_number, event.points, event.reason,
            event.changed_by_principal_id, event.changed_at, wi.state AS current_state
     FROM milestone_scope_events event
     INNER JOIN work_items wi ON wi.project_id = event.project_id AND wi.item_id = event.item_id
     WHERE event.project_id = ? AND event.milestone_id = ? ORDER BY event.sequence`,
  ).all(projectId, milestoneId) as Array<{
    sequence: number;
    scope_event_id: string;
    item_id: string;
    item_key: string;
    item_title: string;
    item_state: string;
    action: "add" | "remove";
    baseline_id: string;
    item_revision_number: number;
    points: number;
    reason: string;
    changed_by_principal_id: string;
    changed_at: string;
    current_state: string;
  }>;
  return rows.map((row) => ({
    id: row.scope_event_id,
    sequence: row.sequence,
    itemId: row.item_id,
    itemKey: row.item_key,
    title: row.item_title,
    stateAtApproval: row.item_state,
    currentState: row.current_state,
    points: row.points,
    baselineId: row.baseline_id,
    itemRevisionNumber: row.item_revision_number,
    action: row.action,
    reason: row.reason,
    changedByPrincipalId: row.changed_by_principal_id,
    changedAt: row.changed_at,
  }));
}

function getApprovedPbiSnapshot(database: SqliteDatabase, projectId: string, reference: string): PbiSnapshot {
  const item = database.prepare(
    `SELECT wi.item_id, wi.item_key, wi.title, wi.state,
            (SELECT MAX(revision_number) FROM work_item_revisions revision
             WHERE revision.project_id = wi.project_id AND revision.item_id = wi.item_id
               AND revision.status = 'published') AS revision
     FROM work_items wi
     WHERE wi.project_id = ? AND (wi.item_id = ? OR wi.item_key = ? COLLATE NOCASE)
       AND wi.type IN ('story', 'bug')`,
  ).get(projectId, reference, reference) as {
    item_id: string; item_key: string; title: string; state: string; revision: number | null;
  } | undefined;
  if (item === undefined) throw new ApplicationError("NOT_FOUND", "PBI was not found in this project.");
  if (!["ready", "in_progress", "in_review", "in_validation", "done"].includes(item.state)) {
    throw new ApplicationError("GATE_BLOCKED", `PBI '${item.item_key}' needs to be Ready or beyond for approved milestone scope.`, {
      details: { itemKey: item.item_key, state: item.state },
    });
  }

  const baseline = database.prepare(
    `SELECT b.baseline_id, br.revision_number
     FROM work_baselines b
     INNER JOIN baseline_refs br ON br.project_id = b.project_id AND br.baseline_id = b.baseline_id
     WHERE b.project_id = ? AND b.item_id = ? AND br.entity_type = 'work_item_revision' AND br.entity_id = ?
     ORDER BY b.sequence DESC LIMIT 1`,
  ).get(projectId, item.item_id, item.item_id) as { baseline_id: string; revision_number: number } | undefined;
  const estimate = database.prepare(
    "SELECT value FROM work_item_estimates WHERE project_id = ? AND item_id = ? AND unit = 'points'",
  ).get(projectId, item.item_id) as { value: number } | undefined;
  const openImpact = database.prepare(
    "SELECT 1 FROM impact_flags WHERE project_id = ? AND item_id = ? AND status = 'open' LIMIT 1",
  ).get(projectId, item.item_id);
  if (baseline === undefined || estimate === undefined || item.revision === null || item.revision !== baseline.revision_number || openImpact !== undefined) {
    throw new ApplicationError("GATE_BLOCKED", `PBI '${item.item_key}' needs a current baseline, confirmed points and no open specification impact.`, {
      details: {
        itemKey: item.item_key,
        hasBaseline: baseline !== undefined,
        hasCurrentBaseline: baseline !== undefined && baseline.revision_number === item.revision,
        hasPointEstimate: estimate !== undefined,
        hasOpenImpact: openImpact !== undefined,
      },
    });
  }
  return {
    itemId: item.item_id,
    itemKey: item.item_key,
    title: item.title,
    stateAtApproval: item.state,
    currentState: item.state,
    points: estimate.value,
    baselineId: baseline.baseline_id,
    itemRevisionNumber: item.revision,
  };
}

function appendScopeEvent(
  database: SqliteDatabase,
  input: {
    readonly projectId: string;
    readonly milestoneId: string;
    readonly snapshot: PbiSnapshot;
    readonly action: "add" | "remove";
    readonly reason: string;
    readonly principalId: string;
    readonly now: string;
  },
): void {
  database.prepare(
    `INSERT INTO milestone_scope_events
      (scope_event_id, project_id, milestone_id, item_id, item_key, item_title, item_state,
       action, baseline_id, item_revision_number, points, reason, changed_by_principal_id, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(), input.projectId, input.milestoneId, input.snapshot.itemId, input.snapshot.itemKey,
    input.snapshot.title, input.snapshot.stateAtApproval, input.action, input.snapshot.baselineId,
    input.snapshot.itemRevisionNumber, input.snapshot.points, input.reason, input.principalId, input.now,
  );
}

function assertHumanProjectPo(database: SqliteDatabase, projectId: string, principalId: string): void {
  const row = database.prepare(
    `SELECT p.principal_type FROM principals p
     INNER JOIN project_memberships pm ON pm.principal_id = p.principal_id
     WHERE p.principal_id = ? AND pm.project_id = ? AND pm.role = 'po'`,
  ).get(principalId, projectId) as { principal_type: string } | undefined;
  if (row?.principal_type !== "human") throw new ApplicationError("FORBIDDEN", "Only a human PO may approve milestone scope.");
}

function normalizeReferences(values: readonly string[], label: string, min: number, max: number): string[] {
  if (!Array.isArray(values) || values.length < min || values.length > max) {
    throw new ApplicationError("VALIDATION_FAILED", `${label} must contain ${min}-${max} references.`);
  }
  const normalized = values.map((value) => normalizeText(value, 80, `${label} references must contain 1-80 characters.`));
  if (new Set(normalized.map((value) => value.toLocaleLowerCase("en-US"))).size !== normalized.length) {
    throw new ApplicationError("VALIDATION_FAILED", `${label} references must be unique.`);
  }
  return normalized;
}

function assertUniqueSnapshots<T extends { readonly itemId: string }>(items: readonly T[], message: string): void {
  if (new Set(items.map((item) => item.itemId)).size !== items.length) {
    throw new ApplicationError("VALIDATION_FAILED", message);
  }
}

function normalizeKey(value: string): string {
  const key = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9._-]{0,31}$/u.test(key)) {
    throw new ApplicationError("VALIDATION_FAILED", "Milestone keys must use 1-32 letters, digits, dots, underscores or dashes.");
  }
  return key;
}

function normalizeDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new ApplicationError("VALIDATION_FAILED", `${label} must use YYYY-MM-DD format.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ApplicationError("VALIDATION_FAILED", `${label} must be a valid calendar date.`);
  }
  return value;
}

function normalizeText(value: string, maximumLength: number, message: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) throw new ApplicationError("VALIDATION_FAILED", message);
  return normalized;
}
