import type { Sprint, SprintScopeEvent, SprintScopeItem, SprintState, SprintStateTransition } from "../domain/sprints.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { resolveProjectTeamId } from "./team-directory.js";

export interface SprintTargetRow {
  readonly sprint_id: string;
  readonly project_id: string;
  readonly sprint_key: string;
  readonly title: string;
  readonly goal: string;
  readonly starts_on: string;
  readonly ends_on: string;
  readonly status: SprintState;
  readonly team_id: string;
  readonly capacity_config_version: number;
  readonly dod_revision_number: number;
  readonly version: number;
  readonly created_by_principal_id: string;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly closed_at: string | null;
  readonly cancelled_at: string | null;
  readonly reason: string;
  readonly review_summary: string | null;
  readonly started_snapshot_json: string | null;
  readonly closed_snapshot_json: string | null;
}

export interface SprintOption {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly status: SprintState;
  readonly startsOn: string;
  readonly endsOn: string;
}

export interface PbiScopeSnapshot {
  readonly itemId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly stateAtSelection: string;
  readonly currentState: string;
  readonly points: number;
  readonly baselineId: string;
  readonly itemRevisionNumber: number;
}

export function getSprint(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  sprintIdOrKey: string,
): Sprint {
  assertProjectAuthorization(database, projectId, principalId);
  const target = findSprintTarget(database, projectId, sprintIdOrKey.trim());
  return readSprint(database, projectId, target.sprint_id);
}

export function listSprints(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  filters: { readonly statuses?: readonly SprintState[]; readonly limit?: number; readonly teamId?: string } = {},
): readonly Sprint[] {
  assertProjectAuthorization(database, projectId, principalId);
  const limit = filters.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "Sprint page size must be an integer between 1 and 100.");
  }
  const statuses = [...new Set(filters.statuses ?? [])];
  const teamId = resolveProjectTeamId(database, projectId, filters.teamId);
  if (teamId === null) return [];
  const rows = statuses.length === 0
    ? database.prepare(
      `SELECT sprint_id FROM sprints WHERE project_id = ? AND team_id = ?
       ORDER BY starts_on DESC, sprint_key COLLATE NOCASE LIMIT ?`,
    ).all(projectId, teamId, limit) as Array<{ sprint_id: string }>
    : database.prepare(
      `SELECT sprint_id FROM sprints WHERE project_id = ? AND team_id = ? AND status IN (${statuses.map(() => "?").join(",")})
       ORDER BY starts_on DESC, sprint_key COLLATE NOCASE LIMIT ?`,
    ).all(projectId, teamId, ...statuses, limit) as Array<{ sprint_id: string }>;
  return rows.map((row) => readSprint(database, projectId, row.sprint_id));
}

export function listSprintOptions(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  limit = 30,
  teamId?: string,
): readonly SprintOption[] {
  assertProjectAuthorization(database, projectId, principalId);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "Sprint option limit must be an integer between 1 and 100.");
  }
  const selectedTeamId = resolveProjectTeamId(database, projectId, teamId);
  if (selectedTeamId === null) return [];
  const rows = database.prepare(
    `SELECT sprint_id, sprint_key, title, status, starts_on, ends_on
     FROM sprints WHERE project_id = ? AND team_id = ?
     ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 WHEN 'closed' THEN 2 ELSE 3 END,
              starts_on DESC, sprint_key COLLATE NOCASE LIMIT ?`,
  ).all(projectId, selectedTeamId, limit) as Array<{
    sprint_id: string;
    sprint_key: string;
    title: string;
    status: SprintState;
    starts_on: string;
    ends_on: string;
  }>;
  return rows.map((row) => ({
    id: row.sprint_id,
    key: row.sprint_key,
    title: row.title,
    status: row.status,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
  }));
}

export function findSprintTarget(database: SqliteDatabase, projectId: string, reference: string): SprintTargetRow {
  const row = database.prepare(
    `SELECT sprint_id, project_id, sprint_key, title, goal, starts_on, ends_on, status,
            team_id, capacity_config_version, dod_revision_number, version,
            created_by_principal_id, created_at, started_at, closed_at, cancelled_at,
            reason, review_summary, started_snapshot_json, closed_snapshot_json
     FROM sprints WHERE project_id = ? AND (sprint_id = ? OR sprint_key = ? COLLATE NOCASE)`,
  ).get(projectId, reference, reference) as SprintTargetRow | undefined;
  if (row === undefined) throw new ApplicationError("NOT_FOUND", "Sprint was not found in this project.");
  return row;
}

export function readSprint(database: SqliteDatabase, projectId: string, sprintId: string): Sprint {
  const row = database.prepare(
    `SELECT sprint_id, project_id, sprint_key, title, goal, starts_on, ends_on, status,
            team_id, capacity_config_version, dod_revision_number, version,
            created_by_principal_id, created_at, started_at, closed_at, cancelled_at,
            reason, review_summary, started_snapshot_json, closed_snapshot_json
     FROM sprints WHERE project_id = ? AND sprint_id = ?`,
  ).get(projectId, sprintId) as SprintTargetRow | undefined;
  if (row === undefined) throw new ApplicationError("NOT_FOUND", "Sprint was not found in this project.");
  const scopeHistory = readSprintScopeHistory(database, projectId, sprintId);
  const scope = currentSprintScope(database, projectId, sprintId);
  const transitions = database.prepare(
    `SELECT transition_id, project_id, sprint_id, from_state, to_state, sprint_version,
            reason, transitioned_by_principal_id, transitioned_at
     FROM sprint_state_transitions WHERE project_id = ? AND sprint_id = ?
     ORDER BY sprint_version`,
  ).all(projectId, sprintId) as Array<{
    transition_id: string;
    project_id: string;
    sprint_id: string;
    from_state: SprintState;
    to_state: SprintState;
    sprint_version: number;
    reason: string;
    transitioned_by_principal_id: string;
    transitioned_at: string;
  }>;
  return {
    id: row.sprint_id,
    projectId: row.project_id,
    key: row.sprint_key,
    title: row.title,
    goal: row.goal,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    status: row.status,
    teamId: row.team_id,
    capacityConfigVersion: row.capacity_config_version,
    definitionOfDoneRevision: row.dod_revision_number,
    version: row.version,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    closedAt: row.closed_at,
    cancelledAt: row.cancelled_at,
    reason: row.reason,
    reviewSummary: row.review_summary,
    startedSnapshot: row.started_snapshot_json === null
      ? null
      : JSON.parse(row.started_snapshot_json) as Sprint["startedSnapshot"],
    closedSnapshot: row.closed_snapshot_json === null
      ? null
      : JSON.parse(row.closed_snapshot_json) as Sprint["closedSnapshot"],
    scope,
    scopeHistory,
    transitions: transitions.map((transition): SprintStateTransition => ({
      id: transition.transition_id,
      projectId: transition.project_id,
      sprintId: transition.sprint_id,
      fromState: transition.from_state,
      toState: transition.to_state,
      sprintVersion: transition.sprint_version,
      reason: transition.reason,
      transitionedByPrincipalId: transition.transitioned_by_principal_id,
      transitionedAt: transition.transitioned_at,
    })),
  };
}

export function currentSprintScope(database: SqliteDatabase, projectId: string, sprintId: string): SprintScopeItem[] {
  const rows = database.prepare(
    `SELECT event.scope_event_id, event.item_id, event.item_key, event.item_title, event.item_state,
            event.baseline_id, event.item_revision_number, event.points, wi.state AS current_state
     FROM sprint_scope_events event
     INNER JOIN (
       SELECT item_id, MAX(sequence) AS latest_sequence
       FROM sprint_scope_events WHERE project_id = ? AND sprint_id = ? GROUP BY item_id
     ) latest ON latest.latest_sequence = event.sequence
     INNER JOIN work_items wi ON wi.project_id = event.project_id AND wi.item_id = event.item_id
     WHERE event.project_id = ? AND event.sprint_id = ? AND event.action = 'add'
     ORDER BY event.sequence`,
  ).all(projectId, sprintId, projectId, sprintId) as Array<{
    item_id: string;
    item_key: string;
    item_title: string;
    item_state: string;
    baseline_id: string;
    item_revision_number: number;
    points: number;
    current_state: string;
  }>;
  return rows.map((row): SprintScopeItem => ({
    itemId: row.item_id,
    itemKey: row.item_key,
    title: row.item_title,
    stateAtSelection: row.item_state,
    currentState: row.current_state,
    points: row.points,
    baselineId: row.baseline_id,
    itemRevisionNumber: row.item_revision_number,
  }));
}

export function getPbiScopeSnapshot(database: SqliteDatabase, projectId: string, reference: string): PbiScopeSnapshot {
  const item = database.prepare(
    `SELECT item_id, item_key, title, state,
            (SELECT MAX(revision_number) FROM work_item_revisions revision
             WHERE revision.project_id = work_items.project_id AND revision.item_id = work_items.item_id
               AND revision.status = 'published') AS revision
     FROM work_items
     WHERE project_id = ? AND (item_id = ? OR item_key = ? COLLATE NOCASE) AND type IN ('story', 'bug')`,
  ).get(projectId, reference, reference) as {
    item_id: string; item_key: string; title: string; state: string; revision: number;
  } | undefined;
  if (item === undefined) throw new ApplicationError("NOT_FOUND", "PBI was not found in this project.");
  const baseline = database.prepare(
    `SELECT baseline_id FROM work_baselines WHERE project_id = ? AND item_id = ?
     ORDER BY sequence DESC LIMIT 1`,
  ).get(projectId, item.item_id) as { baseline_id: string } | undefined;
  const estimate = database.prepare(
    "SELECT value FROM work_item_estimates WHERE project_id = ? AND item_id = ? AND unit = 'points'",
  ).get(projectId, item.item_id) as { value: number } | undefined;
  if (item.state !== "ready") {
    throw new ApplicationError("GATE_BLOCKED", `PBI '${item.item_key}' must be Ready for sprint commitment.`, {
      details: { itemKey: item.item_key, state: item.state },
    });
  }
  if (baseline === undefined || estimate === undefined) {
    throw new ApplicationError("GATE_BLOCKED", `PBI '${item.item_key}' needs a Ready baseline and confirmed point estimate.`, {
      details: { itemKey: item.item_key, hasBaseline: baseline !== undefined, hasPointEstimate: estimate !== undefined },
    });
  }
  return {
    itemId: item.item_id,
    itemKey: item.item_key,
    title: item.title,
    stateAtSelection: item.state,
    currentState: item.state,
    points: estimate.value,
    baselineId: baseline.baseline_id,
    itemRevisionNumber: item.revision,
  };
}

function readSprintScopeHistory(database: SqliteDatabase, projectId: string, sprintId: string): SprintScopeEvent[] {
  const rows = database.prepare(
    `SELECT event.sequence, event.scope_event_id, event.item_id, event.item_key, event.item_title,
            event.item_state, event.baseline_id, event.item_revision_number, event.points,
            event.action, event.reason, event.changed_by_principal_id, event.changed_at,
            wi.state AS current_state
     FROM sprint_scope_events event
     INNER JOIN work_items wi ON wi.project_id = event.project_id AND wi.item_id = event.item_id
     WHERE event.project_id = ? AND event.sprint_id = ? ORDER BY event.sequence`,
  ).all(projectId, sprintId) as Array<{
    sequence: number;
    scope_event_id: string;
    item_id: string;
    item_key: string;
    item_title: string;
    item_state: string;
    baseline_id: string;
    item_revision_number: number;
    points: number;
    action: "add" | "remove";
    reason: string;
    changed_by_principal_id: string;
    changed_at: string;
    current_state: string;
  }>;
  return rows.map((row): SprintScopeEvent => ({
    id: row.scope_event_id,
    sequence: row.sequence,
    itemId: row.item_id,
    itemKey: row.item_key,
    title: row.item_title,
    stateAtSelection: row.item_state,
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
