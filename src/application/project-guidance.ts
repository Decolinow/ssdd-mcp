import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt, type JsonValue } from "./idempotent-command.js";
import { assertProjectAuthorization } from "./local-identity.js";

/**
 * Versioned project guidance (SSDD-948): repository conventions and verification commands that agents receive in the
 * task context. Revisions are immutable and carry author and reason (provenance).
 */
export interface GuidanceContent {
  readonly conventions: ReadonlyArray<{ readonly title: string; readonly text: string }>;
  readonly verificationCommands: readonly string[];
}

export interface ProjectGuidance {
  readonly revisionNumber: number | null;
  readonly content: GuidanceContent;
  readonly reason: string | null;
  readonly setByPrincipalId: string | null;
  readonly setAt: string | null;
}

const emptyGuidance: ProjectGuidance = { revisionNumber: null, content: { conventions: [], verificationCommands: [] }, reason: null, setByPrincipalId: null, setAt: null };

export function getProjectGuidance(database: SqliteDatabase, projectId: string): ProjectGuidance {
  const row = database.prepare(
    "SELECT revision_number, content_json, reason, created_by_principal_id, created_at FROM project_guidance_revisions WHERE project_id = ? ORDER BY revision_number DESC LIMIT 1",
  ).get(projectId) as { revision_number: number; content_json: string; reason: string; created_by_principal_id: string; created_at: string } | undefined;
  return row === undefined
    ? emptyGuidance
    : { revisionNumber: row.revision_number, content: JSON.parse(row.content_json) as GuidanceContent, reason: row.reason, setByPrincipalId: row.created_by_principal_id, setAt: row.created_at };
}

export function readProjectGuidance(database: SqliteDatabase, projectId: string, principalId: string): ProjectGuidance {
  assertProjectAuthorization(database, projectId, principalId);
  return getProjectGuidance(database, projectId);
}

export function setProjectGuidance(database: SqliteDatabase, input: {
  readonly projectId: string; readonly principalId: string; readonly requestId: string; readonly expectedRevision: number;
  readonly content: GuidanceContent; readonly reason: string;
}): CommandReceipt<ProjectGuidance> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new ApplicationError("VALIDATION_FAILED", "Expected revision must be a non-negative integer (0 creates the first revision).");
  }
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 1_000) throw new ApplicationError("VALIDATION_FAILED", "A reason of 10-1000 characters is required.");
  const conventions = input.content.conventions.map((entry) => {
    const title = entry.title.trim();
    const text = entry.text.trim();
    if (title.length === 0 || title.length > 120 || text.length === 0 || text.length > 1_000) {
      throw new ApplicationError("VALIDATION_FAILED", "Each convention needs a title (1-120) and a text (1-1000 characters).");
    }
    return { title, text };
  });
  const verificationCommands = input.content.verificationCommands.map((command) => {
    const value = command.trim();
    if (value.length === 0 || value.length > 300 || /\p{Cc}/u.test(value)) {
      throw new ApplicationError("VALIDATION_FAILED", "Verification commands must have 1-300 printable characters.");
    }
    return value;
  });
  if (conventions.length > 30 || verificationCommands.length > 20) {
    throw new ApplicationError("VALIDATION_FAILED", "At most 30 conventions and 20 verification commands.");
  }
  if (conventions.length === 0 && verificationCommands.length === 0) {
    throw new ApplicationError("VALIDATION_FAILED", "Guidance needs at least one convention or verification command.");
  }
  const content: GuidanceContent = { conventions, verificationCommands };
  return executeIdempotentCommand(database, {
    projectId: input.projectId, principalId: input.principalId, action: "project.guidance.set", requestId: input.requestId,
    payload: { projectId: input.projectId, expectedRevision: input.expectedRevision, content, reason } as unknown as JsonValue,
    requiredRoles: ["po", "tech_lead"],
    auditEvent: (guidance) => ({
      projectId: input.projectId, principalId: input.principalId, eventType: "project.guidance_set", entityType: "project",
      entityId: input.projectId, reason, payload: { revisionNumber: guidance.revisionNumber },
    }),
    execute: () => {
      const principal = database.prepare("SELECT principal_type FROM principals WHERE principal_id = ?").get(input.principalId) as { principal_type: string } | undefined;
      if (principal?.principal_type !== "human") throw new ApplicationError("FORBIDDEN", "Only a human PO or Tech Lead may change the project guidance.");
      const current = getProjectGuidance(database, input.projectId);
      if ((current.revisionNumber ?? 0) !== input.expectedRevision) {
        throw new ApplicationError("VERSION_CONFLICT", `Guidance is at revision ${current.revisionNumber ?? 0}, expected ${input.expectedRevision}.`);
      }
      database.prepare(
        "INSERT INTO project_guidance_revisions (project_id, revision_number, content_json, reason, created_by_principal_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(input.projectId, input.expectedRevision + 1, JSON.stringify(content), reason, input.principalId, new Date().toISOString());
      return getProjectGuidance(database, input.projectId);
    },
  });
}

/** Reasons recorded when this PBI (or its tasks) went back from review/validation, newest first. */
export function recentReturnReasons(database: SqliteDatabase, projectId: string, pbiId: string, limit = 5): Array<{ itemKey: string; fromState: string; reason: string; at: string }> {
  return (database.prepare(
    `SELECT wi.item_key AS itemKey, t.from_state AS fromState, t.reason AS reason, t.transitioned_at AS at
     FROM work_item_state_transitions t
     INNER JOIN work_items wi ON wi.project_id = t.project_id AND wi.item_id = t.item_id
     WHERE t.project_id = ? AND (t.item_id = ? OR wi.parent_id = ?)
       AND t.from_state IN ('in_review', 'in_validation') AND t.to_state = 'in_progress'
     ORDER BY t.transitioned_at DESC LIMIT ?`,
  ).all(projectId, pbiId, pbiId, limit)) as Array<{ itemKey: string; fromState: string; reason: string; at: string }>;
}

/** Actions of the most recently updated sprint retrospective (current revision), with owner and linked PBI. */
export function currentRetrospectiveActions(database: SqliteDatabase, projectId: string): { sprintKey: string; revisionNumber: number; actions: Array<{ title: string; ownerPrincipalId: string }> } | null {
  const head = database.prepare(
    `SELECT r.sprint_id, r.current_version, s.sprint_key FROM sprint_retrospectives r
     INNER JOIN sprints s ON s.project_id = r.project_id AND s.sprint_id = r.sprint_id
     WHERE r.project_id = ? ORDER BY r.updated_at DESC LIMIT 1`,
  ).get(projectId) as { sprint_id: string; current_version: number; sprint_key: string } | undefined;
  if (head === undefined) return null;
  const actions = database.prepare(
    "SELECT title, owner_principal_id AS ownerPrincipalId FROM sprint_retrospective_actions WHERE project_id = ? AND sprint_id = ? AND revision_number = ? ORDER BY position",
  ).all(projectId, head.sprint_id, head.current_version) as Array<{ title: string; ownerPrincipalId: string }>;
  return actions.length === 0 ? null : { sprintKey: head.sprint_key, revisionNumber: head.current_version, actions };
}
