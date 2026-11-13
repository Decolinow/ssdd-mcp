import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { assertProjectAuthorization } from "./local-identity.js";

/**
 * Project gate policy (SSDD-947, ADR 0029). Versioned and audited. `standard` is the default and equals the behavior
 * before the policy existed. See the ADR for what each level relaxes or adds.
 */
export const gatePolicyLevels = ["lite", "standard", "strict"] as const;
export type GatePolicyLevel = (typeof gatePolicyLevels)[number];

export interface GatePolicy {
  readonly level: GatePolicyLevel;
  /** null while no revision was ever set (implicit standard). */
  readonly revisionNumber: number | null;
  readonly reason: string | null;
  readonly setByPrincipalId: string | null;
  readonly setAt: string | null;
}

export function getGatePolicy(database: SqliteDatabase, projectId: string): GatePolicy {
  const row = database.prepare(
    "SELECT revision_number, level, reason, created_by_principal_id, created_at FROM gate_policy_revisions WHERE project_id = ? ORDER BY revision_number DESC LIMIT 1",
  ).get(projectId) as { revision_number: number; level: GatePolicyLevel; reason: string; created_by_principal_id: string; created_at: string } | undefined;
  return row === undefined
    ? { level: "standard", revisionNumber: null, reason: null, setByPrincipalId: null, setAt: null }
    : { level: row.level, revisionNumber: row.revision_number, reason: row.reason, setByPrincipalId: row.created_by_principal_id, setAt: row.created_at };
}

export function readGatePolicy(database: SqliteDatabase, projectId: string, principalId: string): { policy: GatePolicy; history: GatePolicy[] } {
  assertProjectAuthorization(database, projectId, principalId);
  const history = (database.prepare(
    "SELECT revision_number, level, reason, created_by_principal_id, created_at FROM gate_policy_revisions WHERE project_id = ? ORDER BY revision_number DESC LIMIT 20",
  ).all(projectId) as Array<{ revision_number: number; level: GatePolicyLevel; reason: string; created_by_principal_id: string; created_at: string }>)
    .map((row) => ({ level: row.level, revisionNumber: row.revision_number, reason: row.reason, setByPrincipalId: row.created_by_principal_id, setAt: row.created_at }));
  return { policy: getGatePolicy(database, projectId), history };
}

export function setGatePolicy(database: SqliteDatabase, input: {
  readonly projectId: string; readonly principalId: string; readonly requestId: string;
  readonly level: GatePolicyLevel; readonly reason: string; readonly expectedRevision: number;
}): CommandReceipt<GatePolicy> {
  if (!gatePolicyLevels.includes(input.level)) throw new ApplicationError("VALIDATION_FAILED", "Level must be lite, standard or strict.");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new ApplicationError("VALIDATION_FAILED", "Expected revision must be a non-negative integer (0 creates the first revision).");
  }
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 1_000) {
    throw new ApplicationError("VALIDATION_FAILED", "A reason of 10-1000 characters is required to change the gate policy.");
  }
  return executeIdempotentCommand(database, {
    projectId: input.projectId, principalId: input.principalId, action: "project.gate_policy.set", requestId: input.requestId,
    payload: { projectId: input.projectId, level: input.level, reason, expectedRevision: input.expectedRevision },
    requiredRoles: ["po", "tech_lead"],
    auditEvent: (policy) => ({
      projectId: input.projectId, principalId: input.principalId, eventType: "project.gate_policy_set", entityType: "project",
      entityId: input.projectId, reason, payload: { level: policy.level, revisionNumber: policy.revisionNumber },
    }),
    execute: () => {
      const principal = database.prepare("SELECT principal_type FROM principals WHERE principal_id = ?").get(input.principalId) as { principal_type: string } | undefined;
      if (principal?.principal_type !== "human") throw new ApplicationError("FORBIDDEN", "Only a human PO or Tech Lead may change the gate policy.");
      const current = getGatePolicy(database, input.projectId);
      if ((current.revisionNumber ?? 0) !== input.expectedRevision) {
        throw new ApplicationError("VERSION_CONFLICT", `Gate policy is at revision ${current.revisionNumber ?? 0}, expected ${input.expectedRevision}.`);
      }
      const next = input.expectedRevision + 1;
      database.prepare(
        "INSERT INTO gate_policy_revisions (project_id, revision_number, level, reason, created_by_principal_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(input.projectId, next, input.level, reason, input.principalId, new Date().toISOString());
      return getGatePolicy(database, input.projectId);
    },
  });
}
