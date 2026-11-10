import { randomUUID } from "node:crypto";
import type {
  SprintRetrospectiveAction,
  SprintRetrospectiveRead,
  SprintRetrospectiveRevision,
} from "../domain/sprints.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { findSprintTarget } from "./sprint-queries.js";

export interface SprintRetrospectiveActionInput {
  readonly id?: string | undefined;
  readonly title: string;
  readonly ownerPrincipalId: string;
  readonly linkedWorkItemIdOrKey?: string | undefined;
}

export interface SetSprintRetrospectiveInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly sprintIdOrKey: string;
  readonly expectedVersion: number;
  readonly summary: string;
  readonly keepDoing: readonly string[];
  readonly stopDoing: readonly string[];
  readonly tryNext: readonly string[];
  readonly actions: readonly SprintRetrospectiveActionInput[];
  readonly reason: string;
}

interface NormalizedAction {
  readonly id: string | null;
  readonly title: string;
  readonly ownerPrincipalId: string;
  readonly linkedWorkItemIdOrKey: string | null;
}

interface RetrospectiveHeadRow {
  readonly current_version: number;
}

interface RevisionRow {
  readonly revision_number: number;
  readonly summary: string;
  readonly keep_doing_json: string;
  readonly stop_doing_json: string;
  readonly try_next_json: string;
  readonly reason: string;
  readonly created_by_principal_id: string;
  readonly created_at: string;
}

export function setSprintRetrospective(
  database: SqliteDatabase,
  input: SetSprintRetrospectiveInput,
): CommandReceipt<SprintRetrospectiveRevision> {
  const sprintReference = normalizeText(input.sprintIdOrKey, 80, "Sprint reference is required.");
  const summary = normalizeText(input.summary, 2_000, "Retrospective summary must contain 1-2000 characters.");
  const keepDoing = normalizeTextList(input.keepDoing, "Keep doing", 20, 500);
  const stopDoing = normalizeTextList(input.stopDoing, "Stop doing", 20, 500);
  const tryNext = normalizeTextList(input.tryNext, "Try next", 20, 500);
  const reason = normalizeText(input.reason, 1_000, "Retrospective reason must contain 1-1000 characters.");
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new ApplicationError("VALIDATION_FAILED", "Retrospective expectedVersion must be a non-negative integer.");
  }
  const actions = normalizeActions(input.actions);

  assertProjectAuthorization(database, input.projectId, input.principalId, ["facilitator"]);
  assertHumanFacilitator(database, input.projectId, input.principalId);
  const initialSprint = findSprintTarget(database, input.projectId, sprintReference);

  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "sprint.retrospective.set",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      sprintId: initialSprint.sprint_id,
      expectedVersion: input.expectedVersion,
      summary,
      keepDoing: [...keepDoing],
      stopDoing: [...stopDoing],
      tryNext: [...tryNext],
      actions: actions.map((action) => ({ ...action })),
      reason,
    },
    requiredRoles: ["facilitator"],
    auditEvent: (retrospective) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: input.expectedVersion === 0 ? "sprint.retrospective_recorded" : "sprint.retrospective_revised",
      entityType: "sprint",
      entityId: retrospective.sprintId,
      reason,
      payload: {
        version: retrospective.version,
        actionCount: retrospective.actions.length,
        keepDoingCount: retrospective.keepDoing.length,
        stopDoingCount: retrospective.stopDoing.length,
        tryNextCount: retrospective.tryNext.length,
      },
    }),
    execute: () => {
      assertHumanFacilitator(database, input.projectId, input.principalId);
      const sprint = findSprintTarget(database, input.projectId, initialSprint.sprint_id);
      if (sprint.status !== "closed") {
        throw new ApplicationError("INVALID_TRANSITION", "A retrospective can be recorded only after the sprint is closed.");
      }

      const head = database.prepare(
        "SELECT current_version FROM sprint_retrospectives WHERE project_id = ? AND sprint_id = ?",
      ).get(input.projectId, sprint.sprint_id) as RetrospectiveHeadRow | undefined;
      const currentVersion = head?.current_version ?? 0;
      if (currentVersion !== input.expectedVersion) {
        throw new ApplicationError("VERSION_CONFLICT", "Retrospective changed since it was read.", {
          details: { expectedVersion: input.expectedVersion, currentVersion },
        });
      }
      const nextVersion = currentVersion + 1;
      const now = new Date().toISOString();

      if (head === undefined) {
        database.prepare(
          `INSERT INTO sprint_retrospectives (project_id, sprint_id, current_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(input.projectId, sprint.sprint_id, nextVersion, now, now);
      } else {
        const changed = database.prepare(
          `UPDATE sprint_retrospectives SET current_version = ?, updated_at = ?
           WHERE project_id = ? AND sprint_id = ? AND current_version = ?`,
        ).run(nextVersion, now, input.projectId, sprint.sprint_id, input.expectedVersion);
        if (changed.changes !== 1) {
          throw new ApplicationError("VERSION_CONFLICT", "Retrospective changed during update.", {
            details: { expectedVersion: input.expectedVersion },
          });
        }
      }

      const previousActionIds = currentVersion === 0
        ? new Set<string>()
        : new Set((database.prepare(
          `SELECT action_id FROM sprint_retrospective_actions
           WHERE project_id = ? AND sprint_id = ? AND revision_number = ?`,
        ).all(input.projectId, sprint.sprint_id, currentVersion) as Array<{ action_id: string }>).map((row) => row.action_id));

      const resolvedActions = actions.map((action) => {
        if (action.id !== null && !previousActionIds.has(action.id)) {
          throw new ApplicationError("VALIDATION_FAILED", "Action IDs on a new revision must come from the current retrospective revision.", {
            details: { actionId: action.id, currentVersion },
          });
        }
        assertHumanProjectMember(database, input.projectId, action.ownerPrincipalId);
        return {
          ...action,
          id: action.id ?? randomUUID(),
          linkedWorkItemId: action.linkedWorkItemIdOrKey === null
            ? null
            : resolveLinkedPbi(database, input.projectId, action.linkedWorkItemIdOrKey),
        };
      });

      database.prepare(
        `INSERT INTO sprint_retrospective_revisions
          (project_id, sprint_id, revision_number, summary, keep_doing_json, stop_doing_json,
           try_next_json, reason, created_by_principal_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.projectId,
        sprint.sprint_id,
        nextVersion,
        summary,
        JSON.stringify(keepDoing),
        JSON.stringify(stopDoing),
        JSON.stringify(tryNext),
        reason,
        input.principalId,
        now,
      );

      const insertAction = database.prepare(
        `INSERT INTO sprint_retrospective_actions
          (project_id, sprint_id, revision_number, action_id, position, title, owner_principal_id, linked_work_item_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const [index, action] of resolvedActions.entries()) {
        insertAction.run(
          input.projectId,
          sprint.sprint_id,
          nextVersion,
          action.id,
          index + 1,
          action.title,
          action.ownerPrincipalId,
          action.linkedWorkItemId,
        );
      }

      return readRevision(database, input.projectId, sprint.sprint_id, nextVersion);
    },
  });
}

export function getSprintRetrospective(
  database: SqliteDatabase,
  input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly sprintIdOrKey: string;
    readonly revisionNumber?: number;
  },
): SprintRetrospectiveRead {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const sprint = findSprintTarget(database, input.projectId, input.sprintIdOrKey.trim());
  const head = database.prepare(
    "SELECT current_version FROM sprint_retrospectives WHERE project_id = ? AND sprint_id = ?",
  ).get(input.projectId, sprint.sprint_id) as RetrospectiveHeadRow | undefined;
  const version = head?.current_version ?? 0;
  const selectedRevisionNumber = input.revisionNumber ?? (version === 0 ? null : version);
  if (selectedRevisionNumber !== null && (!Number.isSafeInteger(selectedRevisionNumber) || selectedRevisionNumber < 1)) {
    throw new ApplicationError("VALIDATION_FAILED", "Retrospective revisionNumber must be a positive integer.");
  }

  let retrospective: SprintRetrospectiveRevision | null = null;
  if (selectedRevisionNumber !== null) {
    const exists = database.prepare(
      `SELECT revision_number FROM sprint_retrospective_revisions
       WHERE project_id = ? AND sprint_id = ? AND revision_number = ?`,
    ).get(input.projectId, sprint.sprint_id, selectedRevisionNumber);
    if (exists === undefined) throw new ApplicationError("NOT_FOUND", "Retrospective revision was not found for this sprint.");
    retrospective = readRevision(database, input.projectId, sprint.sprint_id, selectedRevisionNumber);
  }

  const history = database.prepare(
    `SELECT revision_number, summary, reason, created_by_principal_id, created_at
     FROM sprint_retrospective_revisions
     WHERE project_id = ? AND sprint_id = ? ORDER BY revision_number DESC`,
  ).all(input.projectId, sprint.sprint_id) as RevisionRow[];

  return {
    sprint: {
      id: sprint.sprint_id,
      key: sprint.sprint_key,
      title: sprint.title,
      status: sprint.status,
      closedAt: sprint.closed_at,
    },
    version,
    selectedRevisionNumber,
    retrospective,
    history: history.map((row) => ({
      revisionNumber: row.revision_number,
      summary: row.summary,
      reason: row.reason,
      createdByPrincipalId: row.created_by_principal_id,
      createdAt: row.created_at,
    })),
  };
}

function readRevision(
  database: SqliteDatabase,
  projectId: string,
  sprintId: string,
  revisionNumber: number,
): SprintRetrospectiveRevision {
  const row = database.prepare(
    `SELECT revision_number, summary, keep_doing_json, stop_doing_json, try_next_json,
            reason, created_by_principal_id, created_at
     FROM sprint_retrospective_revisions
     WHERE project_id = ? AND sprint_id = ? AND revision_number = ?`,
  ).get(projectId, sprintId, revisionNumber) as RevisionRow | undefined;
  if (row === undefined) throw new ApplicationError("NOT_FOUND", "Retrospective revision was not found for this sprint.");

  const actionRows = database.prepare(
    `SELECT a.action_id, a.position, a.title, a.owner_principal_id, p.display_name AS owner_display_name,
            a.linked_work_item_id, wi.item_key AS linked_work_item_key, wi.title AS linked_work_item_title
     FROM sprint_retrospective_actions a
     INNER JOIN principals p ON p.principal_id = a.owner_principal_id
     LEFT JOIN work_items wi ON wi.project_id = a.project_id AND wi.item_id = a.linked_work_item_id
     WHERE a.project_id = ? AND a.sprint_id = ? AND a.revision_number = ?
     ORDER BY a.position`,
  ).all(projectId, sprintId, revisionNumber) as Array<{
    action_id: string;
    position: number;
    title: string;
    owner_principal_id: string;
    owner_display_name: string;
    linked_work_item_id: string | null;
    linked_work_item_key: string | null;
    linked_work_item_title: string | null;
  }>;

  const actions: readonly SprintRetrospectiveAction[] = actionRows.map((action) => ({
    id: action.action_id,
    position: action.position,
    title: action.title,
    ownerPrincipalId: action.owner_principal_id,
    ownerDisplayName: action.owner_display_name,
    linkedWorkItemId: action.linked_work_item_id,
    linkedWorkItemKey: action.linked_work_item_key,
    linkedWorkItemTitle: action.linked_work_item_title,
  }));

  return {
    sprintId,
    revisionNumber: row.revision_number,
    version: row.revision_number,
    summary: row.summary,
    keepDoing: parseStringArray(row.keep_doing_json),
    stopDoing: parseStringArray(row.stop_doing_json),
    tryNext: parseStringArray(row.try_next_json),
    actions,
    reason: row.reason,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at,
  };
}

function normalizeActions(actions: readonly SprintRetrospectiveActionInput[]): readonly NormalizedAction[] {
  if (!Array.isArray(actions) || actions.length > 50) {
    throw new ApplicationError("VALIDATION_FAILED", "Retrospective actions must contain at most 50 entries.");
  }
  const ids = new Set<string>();
  return actions.map((action) => {
    const id = action.id === undefined ? null : normalizeUuid(action.id, "Action ID must be a UUID.");
    if (id !== null && ids.has(id)) throw new ApplicationError("VALIDATION_FAILED", "Retrospective action IDs must be unique.");
    if (id !== null) ids.add(id);
    const ownerPrincipalId = normalizeUuid(action.ownerPrincipalId, "Action owner must be a principal UUID.");
    return {
      id,
      title: normalizeText(action.title, 300, "Action title must contain 1-300 characters."),
      ownerPrincipalId,
      linkedWorkItemIdOrKey: action.linkedWorkItemIdOrKey === undefined
        ? null
        : normalizeText(action.linkedWorkItemIdOrKey, 80, "Linked PBI reference must contain 1-80 characters."),
    };
  });
}

function normalizeTextList(values: readonly string[], label: string, maxItems: number, maxLength: number): readonly string[] {
  if (!Array.isArray(values) || values.length > maxItems) {
    throw new ApplicationError("VALIDATION_FAILED", `${label} must contain at most ${maxItems} entries.`);
  }
  const normalized = values.map((value) => normalizeText(value, maxLength, `${label} entries must contain 1-${maxLength} characters.`));
  const unique = new Set(normalized.map((value) => value.toLocaleLowerCase("en-US")));
  if (unique.size !== normalized.length) throw new ApplicationError("VALIDATION_FAILED", `${label} entries must be unique.`);
  return normalized;
}

function normalizeText(value: string, maximumLength: number, message: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) throw new ApplicationError("VALIDATION_FAILED", message);
  return normalized;
}

function normalizeUuid(value: string, message: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new ApplicationError("VALIDATION_FAILED", message);
  }
  return normalized;
}

function assertHumanFacilitator(database: SqliteDatabase, projectId: string, principalId: string): void {
  const row = database.prepare(
    `SELECT p.principal_type FROM principals p
     INNER JOIN project_memberships pm ON pm.principal_id = p.principal_id
     WHERE p.principal_id = ? AND pm.project_id = ? AND pm.role = 'facilitator'`,
  ).get(principalId, projectId) as { principal_type: string } | undefined;
  if (row?.principal_type !== "human") {
    throw new ApplicationError("FORBIDDEN", "Only a human facilitator may record a sprint retrospective.");
  }
}

function assertHumanProjectMember(database: SqliteDatabase, projectId: string, principalId: string): void {
  const row = database.prepare(
    `SELECT p.principal_type FROM principals p
     INNER JOIN project_memberships pm ON pm.principal_id = p.principal_id
     WHERE p.principal_id = ? AND pm.project_id = ?`,
  ).get(principalId, projectId) as { principal_type: string } | undefined;
  if (row?.principal_type !== "human") {
    throw new ApplicationError("VALIDATION_FAILED", "Retrospective action owner must be a human member of this project.", {
      details: { ownerPrincipalId: principalId },
    });
  }
}

function resolveLinkedPbi(database: SqliteDatabase, projectId: string, reference: string): string {
  const row = database.prepare(
    `SELECT item_id FROM work_items
     WHERE project_id = ? AND (item_id = ? OR item_key = ? COLLATE NOCASE) AND type IN ('story', 'bug')`,
  ).get(projectId, reference, reference) as { item_id: string } | undefined;
  if (row === undefined) {
    throw new ApplicationError("VALIDATION_FAILED", "Retrospective action links must reference a story or bug in the same project.", {
      details: { reference },
    });
  }
  return row.item_id;
}

function parseStringArray(value: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new ApplicationError("INTERNAL_ERROR", "Stored retrospective list has an invalid shape.");
  }
  return parsed;
}
