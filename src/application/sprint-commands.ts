import { randomUUID } from "node:crypto";
import type { Sprint, SprintCloseSnapshot, SprintScopeItem, SprintStartSnapshot, SprintState } from "../domain/sprints.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { getDefinitionOfDone } from "./definition-of-done.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { assertProjectAuthorization, type ProjectRole } from "./local-identity.js";
import { getTeamCapacity, getTeamCapacityConfiguration } from "./team-capacity.js";
import {
  currentSprintScope,
  findSprintTarget,
  getPbiScopeSnapshot,
  readSprint,
} from "./sprint-queries.js";

export interface CreateSprintDraftInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly sprintKey: string;
  readonly title: string;
  readonly goal: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly teamId?: string;
  readonly itemIdsOrKeys: readonly string[];
  readonly capacityConfigVersion?: number | undefined;
  readonly definitionOfDoneRevision?: number | undefined;
  readonly reason: string;
}

export interface ChangeSprintScopeInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly sprintIdOrKey: string;
  readonly expectedVersion: number;
  readonly addItemIdsOrKeys?: readonly string[] | undefined;
  readonly removeItemIdsOrKeys?: readonly string[] | undefined;
  readonly reason: string;
}

export interface SprintStateCommandInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly sprintIdOrKey: string;
  readonly expectedVersion: number;
  readonly reason: string;
}

export interface CloseSprintInput extends SprintStateCommandInput {
  readonly acceptedItemIds: readonly string[];
  readonly reviewSummary: string;
}

export function createSprintDraft(
  database: SqliteDatabase,
  input: CreateSprintDraftInput,
): CommandReceipt<Sprint> {
  const sprintKey = normalizeKey(input.sprintKey);
  const title = normalizeText(input.title, 120, "Sprint title must contain 1-120 characters.");
  const goal = normalizeText(input.goal, 1_000, "Sprint Goal must contain 1-1000 characters.");
  const startsOn = normalizeDate(input.startsOn, "Sprint start date");
  const endsOn = normalizeDate(input.endsOn, "Sprint end date");
  if (startsOn > endsOn) throw new ApplicationError("VALIDATION_FAILED", "Sprint start date must be on or before its end date.");
  const sprintLengthDays = (Date.parse(`${endsOn}T00:00:00.000Z`) - Date.parse(`${startsOn}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (sprintLengthDays > 367) throw new ApplicationError("VALIDATION_FAILED", "Sprint length cannot exceed 367 calendar days.");
  const itemReferences = normalizeReferences(input.itemIdsOrKeys, "Sprint scope", 1, 100);
  const reason = normalizeText(input.reason, 1_000, "Sprint draft reason must contain 1-1000 characters.");
  assertProjectAuthorization(database, input.projectId, input.principalId);

  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "sprint.draft.create",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      sprintKey,
      title,
      goal,
      startsOn,
      endsOn,
      teamId: input.teamId ?? null,
      itemIdsOrKeys: itemReferences,
      capacityConfigVersion: input.capacityConfigVersion ?? null,
      definitionOfDoneRevision: input.definitionOfDoneRevision ?? null,
      reason,
    },
    requiredRoles: ["po", "developer", "facilitator"],
    auditEvent: (sprint) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "sprint.drafted",
      entityType: "sprint",
      entityId: sprint.id,
      reason,
      payload: {
        sprintKey: sprint.key,
        startsOn,
        endsOn,
        selectedItemIds: sprint.scope.map((item) => item.itemId),
        capacityConfigVersion: sprint.capacityConfigVersion,
        definitionOfDoneRevision: sprint.definitionOfDoneRevision,
      },
    }),
    execute: () => {
      assertHuman(database, input.principalId, "Only a human project member may draft sprint scope.");
      const keyConflict = database.prepare(
        "SELECT sprint_id FROM sprints WHERE project_id = ? AND sprint_key = ? COLLATE NOCASE",
      ).get(input.projectId, sprintKey);
      if (keyConflict !== undefined) {
        throw new ApplicationError("SPRINT_KEY_CONFLICT", `Sprint key '${sprintKey}' already exists in this project.`);
      }
      const capacityConfig = getTeamCapacityConfiguration(
        database, input.projectId, input.principalId, input.capacityConfigVersion, input.teamId,
      );
      const definitionOfDone = getDefinitionOfDone(
        database, input.projectId, input.principalId, input.definitionOfDoneRevision,
      );
      const sprintId = randomUUID();
      const createdAt = new Date().toISOString();
      database.prepare(
        `INSERT INTO sprints
          (sprint_id, project_id, sprint_key, title, goal, starts_on, ends_on, status, team_id,
           capacity_config_version, dod_revision_number, version, created_by_principal_id, created_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, 1, ?, ?, ?)`,
      ).run(
        sprintId, input.projectId, sprintKey, title, goal, startsOn, endsOn, capacityConfig.teamId,
        capacityConfig.version, definitionOfDone.revisionNumber, input.principalId, createdAt, reason,
      );
      for (const reference of itemReferences) {
        const snapshot = getPbiScopeSnapshot(database, input.projectId, reference);
        assertScopeAvailable(database, input.projectId, snapshot.itemId, sprintId);
        appendScopeEvent(database, {
          projectId: input.projectId,
          sprintId,
          snapshot,
          action: "add",
          reason,
          principalId: input.principalId,
          now: createdAt,
        });
      }
      return readSprint(database, input.projectId, sprintId);
    },
  });
}

export function changeSprintScope(
  database: SqliteDatabase,
  input: ChangeSprintScopeInput,
): CommandReceipt<Sprint> {
  const reference = input.sprintIdOrKey.trim();
  const additions = normalizeReferences(input.addItemIdsOrKeys ?? [], "Sprint scope additions", 0, 100);
  const removals = normalizeReferences(input.removeItemIdsOrKeys ?? [], "Sprint scope removals", 0, 100);
  if (additions.length === 0 && removals.length === 0) {
    throw new ApplicationError("VALIDATION_FAILED", "Add or remove at least one PBI from sprint scope.");
  }
  if (additions.some((id) => removals.includes(id))) {
    throw new ApplicationError("VALIDATION_FAILED", "The same PBI cannot be added and removed in one scope change.");
  }
  const reason = normalizeText(input.reason, 1_000, "Sprint scope change reason must contain 1-1000 characters.");
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const initial = findSprintTarget(database, input.projectId, reference);
  const requiredRoles: readonly ProjectRole[] = ["po", "developer", "facilitator"];
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "sprint.scope.change",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      sprintId: initial.sprint_id,
      expectedVersion: input.expectedVersion,
      additions,
      removals,
      reason,
    },
    requiredRoles,
    auditEvent: (sprint) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "sprint.scope_changed",
      entityType: "sprint",
      entityId: sprint.id,
      reason,
      payload: { addedItemIds: additions, removedItemIds: removals, version: sprint.version },
    }),
    execute: () => {
      const current = findSprintTarget(database, input.projectId, initial.sprint_id);
      assertExpectedVersion(current.version, input.expectedVersion);
      if (current.status !== "draft" && current.status !== "active") {
        throw new ApplicationError("INVALID_TRANSITION", "Scope can change only while a sprint is draft or active.");
      }
      if (current.status === "active") {
        assertProjectAuthorization(database, input.projectId, input.principalId, ["po"]);
        assertHuman(database, input.principalId, "Active sprint scope changes require human PO approval.");
      }
      const existingScope = currentSprintScope(database, input.projectId, current.sprint_id);
      const byId = new Map(existingScope.map((item) => [item.itemId, item]));
      const now = new Date().toISOString();
      for (const itemReference of removals) {
        const existing = existingScope.find((item) => item.itemId === itemReference || item.itemKey.toLowerCase() === itemReference.toLowerCase());
        if (existing === undefined) {
          throw new ApplicationError("VALIDATION_FAILED", `PBI '${itemReference}' is not in the sprint's current scope.`);
        }
        appendScopeEvent(database, {
          projectId: input.projectId,
          sprintId: current.sprint_id,
          snapshot: { ...existing, stateAtSelection: existing.currentState },
          action: "remove",
          reason,
          principalId: input.principalId,
          now,
        });
        byId.delete(existing.itemId);
      }
      for (const itemReference of additions) {
        const snapshot = getPbiScopeSnapshot(database, input.projectId, itemReference);
        if (byId.has(snapshot.itemId)) {
          throw new ApplicationError("VALIDATION_FAILED", `PBI '${snapshot.itemKey}' is already in sprint scope.`);
        }
        assertScopeAvailable(database, input.projectId, snapshot.itemId, current.sprint_id);
        appendScopeEvent(database, {
          projectId: input.projectId,
          sprintId: current.sprint_id,
          snapshot,
          action: "add",
          reason,
          principalId: input.principalId,
          now,
        });
        byId.set(snapshot.itemId, snapshot);
      }
      const updated = database.prepare(
        "UPDATE sprints SET version = version + 1 WHERE project_id = ? AND sprint_id = ? AND version = ?",
      ).run(input.projectId, current.sprint_id, input.expectedVersion);
      if (updated.changes !== 1) throw new ApplicationError("VERSION_CONFLICT", "Sprint changed during scope update.");
      return readSprint(database, input.projectId, current.sprint_id);
    },
  });
}

export function startSprint(
  database: SqliteDatabase,
  input: SprintStateCommandInput,
): CommandReceipt<Sprint> {
  const reason = normalizeText(input.reason, 1_000, "Sprint start reason must contain 1-1000 characters.");
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const initial = findSprintTarget(database, input.projectId, input.sprintIdOrKey.trim());
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "sprint.start",
    requestId: input.requestId,
    payload: { projectId: input.projectId, sprintId: initial.sprint_id, expectedVersion: input.expectedVersion, reason },
    requiredRoles: ["po", "developer", "facilitator"],
    auditEvent: (sprint) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "sprint.started",
      entityType: "sprint",
      entityId: sprint.id,
      reason,
      payload: {
        version: sprint.version,
        scopeCount: sprint.startedSnapshot?.commitments.length ?? 0,
        totalCapacityHours: sprint.startedSnapshot?.capacity.totalHours ?? 0,
        capacityConfigVersion: sprint.capacityConfigVersion,
        definitionOfDoneRevision: sprint.definitionOfDoneRevision,
      },
    }),
    execute: () => {
      assertHuman(database, input.principalId, "Only a human PO may start a sprint.");
      assertProjectAuthorization(database, input.projectId, input.principalId, ["po"]);
      const current = findSprintTarget(database, input.projectId, initial.sprint_id);
      assertExpectedVersion(current.version, input.expectedVersion);
      if (current.status !== "draft") throw new ApplicationError("INVALID_TRANSITION", "Only a draft sprint can start.");
      const active = database.prepare(
        "SELECT sprint_key FROM sprints WHERE project_id = ? AND team_id = ? AND status = 'active' LIMIT 1",
      ).get(input.projectId, current.team_id) as { sprint_key: string } | undefined;
      if (active !== undefined) {
        throw new ApplicationError("GATE_BLOCKED", "Another sprint is already active for this team.", {
          details: { activeSprintKey: active.sprint_key },
        });
      }
      const scope = currentSprintScope(database, input.projectId, current.sprint_id);
      if (scope.length === 0) throw new ApplicationError("GATE_BLOCKED", "Select at least one Ready PBI before starting the sprint.");
      for (const commitment of scope) {
        const latest = getPbiScopeSnapshot(database, input.projectId, commitment.itemId);
        if (
          latest.baselineId !== commitment.baselineId || latest.points !== commitment.points ||
          latest.itemRevisionNumber !== commitment.itemRevisionNumber
        ) {
          throw new ApplicationError("VERSION_CONFLICT", `PBI '${commitment.itemKey}' changed after sprint planning.`, {
            details: {
              itemId: commitment.itemId,
              committedBaselineId: commitment.baselineId,
              currentBaselineId: latest.baselineId,
              committedPoints: commitment.points,
              currentPoints: latest.points,
              committedRevision: commitment.itemRevisionNumber,
              currentRevision: latest.itemRevisionNumber,
            },
          });
        }
      }
      const capacity = getTeamCapacity(database, {
        projectId: input.projectId,
        principalId: input.principalId,
        startDate: current.starts_on,
        endDate: current.ends_on,
        configVersion: current.capacity_config_version,
        teamId: current.team_id,
      });
      if (capacity.totalHours <= 0 || capacity.workdays <= 0) {
        throw new ApplicationError("GATE_BLOCKED", "Sprint calendar has no available team capacity.", {
          details: { totalHours: capacity.totalHours, workdays: capacity.workdays },
        });
      }
      const definitionOfDone = getDefinitionOfDone(database, input.projectId, input.principalId, current.dod_revision_number);
      const startedAt = new Date().toISOString();
      const snapshot: SprintStartSnapshot = {
        startedAt,
        reason,
        capacity,
        definitionOfDone,
        commitments: scope,
      };
      const nextVersion = input.expectedVersion + 1;
      const updated = database.prepare(
        `UPDATE sprints SET status = 'active', started_at = ?, started_snapshot_json = ?, version = ?
         WHERE project_id = ? AND sprint_id = ? AND version = ? AND status = 'draft'`,
      ).run(startedAt, JSON.stringify(snapshot), nextVersion, input.projectId, current.sprint_id, input.expectedVersion);
      if (updated.changes !== 1) throw new ApplicationError("VERSION_CONFLICT", "Sprint changed during start.");
      appendSprintTransition(database, {
        projectId: input.projectId,
        sprintId: current.sprint_id,
        fromState: "draft",
        toState: "active",
        sprintVersion: nextVersion,
        reason,
        principalId: input.principalId,
        transitionedAt: startedAt,
      });
      return readSprint(database, input.projectId, current.sprint_id);
    },
  });
}

export function closeSprint(
  database: SqliteDatabase,
  input: CloseSprintInput,
): CommandReceipt<Sprint> {
  const reason = normalizeText(input.reason, 1_000, "Sprint close reason must contain 1-1000 characters.");
  const reviewSummary = normalizeText(input.reviewSummary, 2_000, "Sprint review summary must contain 1-2000 characters.");
  const acceptedItemIds = normalizeReferences(input.acceptedItemIds, "Accepted PBI IDs", 0, 100);
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const initial = findSprintTarget(database, input.projectId, input.sprintIdOrKey.trim());
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "sprint.close",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      sprintId: initial.sprint_id,
      expectedVersion: input.expectedVersion,
      acceptedItemIds,
      reviewSummary,
      reason,
    },
    requiredRoles: ["po", "facilitator"],
    auditEvent: (sprint) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "sprint.closed",
      entityType: "sprint",
      entityId: sprint.id,
      reason,
      payload: {
        version: sprint.version,
        acceptedItemIds: [...(sprint.closedSnapshot?.acceptedItemIds ?? [])],
        incompleteItemIds: sprint.closedSnapshot?.incompleteItems.map((item) => item.itemId) ?? [],
      },
    }),
    execute: () => {
      assertHuman(database, input.principalId, "Only a human PO or facilitator may close a sprint.");
      const current = findSprintTarget(database, input.projectId, initial.sprint_id);
      assertExpectedVersion(current.version, input.expectedVersion);
      if (current.status !== "active") throw new ApplicationError("INVALID_TRANSITION", "Only an active sprint can close.");
      const startSnapshot = parseRequiredSnapshot<SprintStartSnapshot>(current.started_snapshot_json);
      const scope = currentSprintScope(database, input.projectId, current.sprint_id);
      const byReference = new Map(scope.flatMap((item) => [[item.itemId, item], [item.itemKey.toLowerCase(), item]]));
      const acceptedItems: SprintScopeItem[] = [];
      for (const reference of acceptedItemIds) {
        const item = byReference.get(reference) ?? byReference.get(reference.toLowerCase());
        if (item === undefined) throw new ApplicationError("VALIDATION_FAILED", `PBI '${reference}' is not in the current sprint scope.`);
        if (item.currentState !== "done") {
          throw new ApplicationError("GATE_BLOCKED", `PBI '${item.itemKey}' is not Done and cannot be accepted.`, {
            details: { itemId: item.itemId, currentState: item.currentState },
          });
        }
        acceptedItems.push(item);
      }
      const acceptedSet = new Set(acceptedItems.map((item) => item.itemId));
      const incompleteItems = scope.filter((item) => !acceptedSet.has(item.itemId));
      const definitionOfDone = getDefinitionOfDone(database, input.projectId, input.principalId, current.dod_revision_number);
      const closedAt = new Date().toISOString();
      const snapshot: SprintCloseSnapshot = {
        closedAt,
        reviewSummary,
        acceptedItemIds: acceptedItems.map((item) => item.itemId),
        acceptedItems,
        incompleteItems,
        definitionOfDone,
        start: startSnapshot,
      };
      const nextVersion = input.expectedVersion + 1;
      const updated = database.prepare(
        `UPDATE sprints SET status = 'closed', closed_at = ?, review_summary = ?,
           closed_snapshot_json = ?, version = ?
         WHERE project_id = ? AND sprint_id = ? AND version = ? AND status = 'active'`,
      ).run(
        closedAt, reviewSummary, JSON.stringify(snapshot), nextVersion,
        input.projectId, current.sprint_id, input.expectedVersion,
      );
      if (updated.changes !== 1) throw new ApplicationError("VERSION_CONFLICT", "Sprint changed during close.");
      appendSprintTransition(database, {
        projectId: input.projectId,
        sprintId: current.sprint_id,
        fromState: "active",
        toState: "closed",
        sprintVersion: nextVersion,
        reason,
        principalId: input.principalId,
        transitionedAt: closedAt,
      });
      return readSprint(database, input.projectId, current.sprint_id);
    },
  });
}

export function cancelSprint(
  database: SqliteDatabase,
  input: SprintStateCommandInput,
): CommandReceipt<Sprint> {
  const reason = normalizeText(input.reason, 1_000, "Sprint cancellation reason must contain 1-1000 characters.");
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const initial = findSprintTarget(database, input.projectId, input.sprintIdOrKey.trim());
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "sprint.cancel",
    requestId: input.requestId,
    payload: { projectId: input.projectId, sprintId: initial.sprint_id, expectedVersion: input.expectedVersion, reason },
    requiredRoles: ["po", "facilitator"],
    auditEvent: (sprint) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "sprint.cancelled",
      entityType: "sprint",
      entityId: sprint.id,
      reason,
      payload: { version: sprint.version, releasedScopeItemIds: sprint.scope.map((item) => item.itemId) },
    }),
    execute: () => {
      assertHuman(database, input.principalId, "Only a human PO or facilitator may cancel a sprint.");
      const current = findSprintTarget(database, input.projectId, initial.sprint_id);
      assertExpectedVersion(current.version, input.expectedVersion);
      if (current.status !== "draft" && current.status !== "active") {
        throw new ApplicationError("INVALID_TRANSITION", "Only a draft or active sprint can be cancelled.");
      }
      const cancelledAt = new Date().toISOString();
      const nextVersion = input.expectedVersion + 1;
      const updated = database.prepare(
        `UPDATE sprints SET status = 'cancelled', cancelled_at = ?, version = ?
         WHERE project_id = ? AND sprint_id = ? AND version = ?`,
      ).run(cancelledAt, nextVersion, input.projectId, current.sprint_id, input.expectedVersion);
      if (updated.changes !== 1) throw new ApplicationError("VERSION_CONFLICT", "Sprint changed during cancellation.");
      appendSprintTransition(database, {
        projectId: input.projectId,
        sprintId: current.sprint_id,
        fromState: current.status,
        toState: "cancelled",
        sprintVersion: nextVersion,
        reason,
        principalId: input.principalId,
        transitionedAt: cancelledAt,
      });
      return readSprint(database, input.projectId, current.sprint_id);
    },
  });
}

function appendScopeEvent(
  database: SqliteDatabase,
  input: {
    readonly projectId: string;
    readonly sprintId: string;
    readonly snapshot: SprintScopeItem;
    readonly action: "add" | "remove";
    readonly reason: string;
    readonly principalId: string;
    readonly now: string;
  },
): void {
  database.prepare(
    `INSERT INTO sprint_scope_events
      (scope_event_id, project_id, sprint_id, item_id, item_key, item_title, item_state,
       action, baseline_id, item_revision_number, points, reason, changed_by_principal_id, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(), input.projectId, input.sprintId, input.snapshot.itemId, input.snapshot.itemKey,
    input.snapshot.title, input.snapshot.stateAtSelection, input.action, input.snapshot.baselineId,
    input.snapshot.itemRevisionNumber, input.snapshot.points, input.reason, input.principalId, input.now,
  );
}

function assertScopeAvailable(
  database: SqliteDatabase,
  projectId: string,
  itemId: string,
  exceptSprintId: string,
): void {
  const reservation = database.prepare(
    `SELECT sprint.sprint_id, sprint.sprint_key, sprint.team_id
     FROM sprints sprint
     WHERE sprint.project_id = ? AND sprint.sprint_id <> ? AND sprint.status IN ('draft', 'active')
       AND EXISTS (
         SELECT 1 FROM sprint_scope_events event
         WHERE event.project_id = sprint.project_id AND event.sprint_id = sprint.sprint_id
           AND event.item_id = ?
           AND event.sequence = (
             SELECT MAX(latest.sequence) FROM sprint_scope_events latest
             WHERE latest.project_id = event.project_id AND latest.sprint_id = event.sprint_id
               AND latest.item_id = event.item_id
           )
           AND event.action = 'add'
       )
     LIMIT 1`,
  ).get(projectId, exceptSprintId, itemId) as {
    sprint_id: string;
    sprint_key: string;
    team_id: string;
  } | undefined;
  if (reservation !== undefined) {
    throw new ApplicationError("VALIDATION_FAILED", "A PBI cannot be reserved by more than one draft or active sprint.", {
      details: { itemId, sprintId: reservation.sprint_id, sprintKey: reservation.sprint_key, teamId: reservation.team_id },
    });
  }
}

function appendSprintTransition(
  database: SqliteDatabase,
  input: {
    readonly projectId: string;
    readonly sprintId: string;
    readonly fromState: SprintState;
    readonly toState: SprintState;
    readonly sprintVersion: number;
    readonly reason: string;
    readonly principalId: string;
    readonly transitionedAt: string;
  },
): void {
  database.prepare(
    `INSERT INTO sprint_state_transitions
      (transition_id, project_id, sprint_id, from_state, to_state, sprint_version,
       reason, transitioned_by_principal_id, transitioned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(), input.projectId, input.sprintId, input.fromState, input.toState,
    input.sprintVersion, input.reason, input.principalId, input.transitionedAt,
  );
}

function parseRequiredSnapshot<T>(value: string | null): T {
  if (value === null) throw new ApplicationError("GATE_BLOCKED", "Sprint is missing its start snapshot.");
  return JSON.parse(value) as T;
}

function normalizeReferences(values: readonly string[], label: string, min: number, max: number): string[] {
  if (values.length < min || values.length > max) {
    throw new ApplicationError("VALIDATION_FAILED", `${label} must contain ${min}-${max} references.`);
  }
  const normalized = values.map((value) => normalizeText(value, 80, `${label} references must contain 1-80 characters.`));
  if (new Set(normalized.map((value) => value.toLowerCase())).size !== normalized.length) {
    throw new ApplicationError("VALIDATION_FAILED", `${label} references must be unique.`);
  }
  return normalized;
}

function normalizeKey(value: string): string {
  const key = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9._-]{0,31}$/.test(key)) {
    throw new ApplicationError("VALIDATION_FAILED", "Sprint keys must use 1-32 letters, digits, dots, underscores or dashes.");
  }
  return key;
}

function normalizeDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApplicationError("VALIDATION_FAILED", `${label} must use YYYY-MM-DD format.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ApplicationError("VALIDATION_FAILED", `${label} must be a valid calendar date.`);
  }
  return value;
}

function normalizeText(value: string, maxLength: number, message: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) throw new ApplicationError("VALIDATION_FAILED", message);
  return normalized;
}

function assertHuman(database: SqliteDatabase, principalId: string, message: string): void {
  const row = database.prepare("SELECT principal_type FROM principals WHERE principal_id = ?")
    .get(principalId) as { principal_type: string } | undefined;
  if (row?.principal_type !== "human") throw new ApplicationError("FORBIDDEN", message);
}

function assertExpectedVersion(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new ApplicationError("VALIDATION_FAILED", "Expected sprint version must be a positive integer.");
  }
  if (actual !== expected) {
    throw new ApplicationError("VERSION_CONFLICT", "Sprint changed since it was read.", {
      details: { expectedVersion: expected, actualVersion: actual },
    });
  }
}
