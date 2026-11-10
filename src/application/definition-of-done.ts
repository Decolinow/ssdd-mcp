import { randomUUID } from "node:crypto";
import type { DefinitionOfDoneCriterion, DefinitionOfDoneRevision } from "../domain/definition-of-done.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { assertProjectAuthorization } from "./local-identity.js";

export interface SetDefinitionOfDoneInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly criteria: readonly { readonly id?: string | undefined; readonly description: string }[];
  readonly reason: string;
}

export function setDefinitionOfDone(
  database: SqliteDatabase,
  input: SetDefinitionOfDoneInput,
): CommandReceipt<DefinitionOfDoneRevision> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new ApplicationError("VALIDATION_FAILED", "Expected version must be a non-negative integer (0 creates the first revision).");
  }
  if (input.criteria.length < 1 || input.criteria.length > 50) {
    throw new ApplicationError("VALIDATION_FAILED", "Definition of Done must contain 1-50 criteria.");
  }
  const criteriaPayload = input.criteria.map((criterion) => {
    const description = criterion.description.trim();
    if (description.length === 0 || description.length > 500) {
      throw new ApplicationError("VALIDATION_FAILED", "Definition of Done criteria must contain 1-500 characters.");
    }
    const id = criterion.id?.trim() || null;
    if (id !== null && !/^[0-9a-f-]{36}$/i.test(id)) {
      throw new ApplicationError("VALIDATION_FAILED", "Definition of Done criterion IDs must be UUIDs.");
    }
    return { id, description };
  });
  const criteria: DefinitionOfDoneCriterion[] = criteriaPayload.map((criterion) => {
    const id = criterion.id ?? randomUUID();
    return { id, description: criterion.description };
  });
  if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) {
    throw new ApplicationError("VALIDATION_FAILED", "Definition of Done criterion IDs must be unique within a revision.");
  }
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 1_000) {
    throw new ApplicationError("VALIDATION_FAILED", "Definition of Done reason must contain 1-1000 characters.");
  }
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "project.definition_of_done.set",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      expectedVersion: input.expectedVersion,
      criteria: criteriaPayload,
      reason,
    },
    requiredRoles: ["po", "facilitator"],
    auditEvent: (revision) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "project.definition_of_done_revised",
      entityType: "project",
      entityId: input.projectId,
      reason,
      payload: { revisionNumber: revision.revisionNumber, criterionCount: revision.criteria.length },
    }),
    execute: () => {
      assertHuman(database, input.principalId);
      const current = database.prepare(
        "SELECT MAX(revision_number) AS version FROM dod_revisions WHERE project_id = ?",
      ).get(input.projectId) as { version: number | null };
      const currentVersion = current.version ?? 0;
      if (currentVersion !== input.expectedVersion) {
        throw new ApplicationError("VERSION_CONFLICT", "Definition of Done changed since it was read.", {
          details: { expectedVersion: input.expectedVersion, actualVersion: currentVersion },
        });
      }
      const revision: DefinitionOfDoneRevision = {
        projectId: input.projectId,
        revisionNumber: currentVersion + 1,
        criteria,
        reason,
        createdByPrincipalId: input.principalId,
        createdAt: new Date().toISOString(),
      };
      database.prepare(
        `INSERT INTO dod_revisions
          (project_id, revision_number, criteria_json, reason, created_by_principal_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        revision.projectId, revision.revisionNumber, JSON.stringify(revision.criteria), revision.reason,
        revision.createdByPrincipalId, revision.createdAt,
      );
      return revision;
    },
  });
}

export function getDefinitionOfDone(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  revisionNumber?: number,
): DefinitionOfDoneRevision {
  assertProjectAuthorization(database, projectId, principalId);
  if (revisionNumber !== undefined && (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1)) {
    throw new ApplicationError("VALIDATION_FAILED", "Definition of Done revision must be a positive integer.");
  }
  const row = database.prepare(
    `SELECT project_id, revision_number, criteria_json, reason, created_by_principal_id, created_at
     FROM dod_revisions WHERE project_id = ? AND (? IS NULL OR revision_number = ?)
     ORDER BY revision_number DESC LIMIT 1`,
  ).get(projectId, revisionNumber ?? null, revisionNumber ?? null) as {
    project_id: string;
    revision_number: number;
    criteria_json: string;
    reason: string;
    created_by_principal_id: string;
    created_at: string;
  } | undefined;
  if (row === undefined) throw new ApplicationError("NOT_FOUND", "Definition of Done is not configured for this project.");
  return {
    projectId: row.project_id,
    revisionNumber: row.revision_number,
    criteria: JSON.parse(row.criteria_json) as DefinitionOfDoneCriterion[],
    reason: row.reason,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at,
  };
}

function assertHuman(database: SqliteDatabase, principalId: string): void {
  const row = database.prepare("SELECT principal_type FROM principals WHERE principal_id = ?")
    .get(principalId) as { principal_type: string } | undefined;
  if (row?.principal_type !== "human") {
    throw new ApplicationError("FORBIDDEN", "Only a human PO or facilitator may revise the Definition of Done.");
  }
}
