import { createHash, randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { canonicalJson, executeIdempotentCommand, type CommandReceipt, type JsonValue } from "./idempotent-command.js";
import { assertProjectAuthorization } from "./local-identity.js";

export const approvableMcpToolNames = [
  "baseline_fix",
  "baseline_revalidate",
  "work_item_create",
  "work_item_revision_propose",
  "work_item_revision_publish",
  "work_item_assign",
  "work_item_rank",
  "comment_add",
  "work_item_estimate",
  "work_item_estimate_confirm",
  "spec_create",
  "spec_revision_propose",
  "spec_revision_publish",
  "scenario_create",
  "scenario_revision_propose",
  "scenario_revision_publish",
  "test_run_record",
  "test_run_certify",
  "milestone_create",
  "milestone_scope_change",
  "team_create",
  "team_capacity_set",
  "definition_of_done_set",
  "sprint_draft",
  "sprint_scope_change",
  "sprint_start",
  "sprint_close",
  "sprint_cancel",
  "sprint_retrospective_set",
  "work_item_transition",
  "evidence_add",
  "trace_link_add",
  "trace_link_remove",
] as const;

export type ApprovableMcpToolName = (typeof approvableMcpToolNames)[number];

export interface CreateToolApprovalInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly toolName: ApprovableMcpToolName;
  readonly arguments: JsonValue;
  readonly expectedVersion: number | null;
  readonly executorPrincipalId: string;
  readonly expiresInSeconds: number;
  readonly reason: string;
}

export interface ToolApproval {
  readonly approvalId: string;
  readonly projectId: string;
  readonly toolName: ApprovableMcpToolName;
  readonly argumentsHash: string;
  readonly expectedVersion: number | null;
  readonly executorPrincipalId: string;
  readonly approvedByPrincipalId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly status: "pending";
}

export interface RevokeToolApprovalInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly approvalId: string;
  readonly reason: string;
}

export interface MatchingToolApprovalInput {
  readonly approvalId: string;
  readonly projectId: string;
  readonly executorPrincipalId: string;
  readonly toolName: string;
  readonly arguments: JsonValue;
  readonly expectedVersion: number | null;
}

export interface MatchedToolApproval {
  readonly approvalId: string;
  readonly projectId: string;
  readonly toolName: string;
  readonly argumentsHash: string;
  readonly expectedVersion: number | null;
  readonly executorPrincipalId: string;
  readonly approvedByPrincipalId: string;
}

export function issueToolApproval(
  database: SqliteDatabase,
  input: CreateToolApprovalInput,
): CommandReceipt<ToolApproval> {
  const reason = normalizeText(input.reason, 500, "Reason must contain 1-500 characters.");
  validateApprovalBinding(input);
  const argumentsHash = hashArguments(input.arguments);

  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "tool_approval.issue",
    requestId: input.requestId,
    payload: {
      toolName: input.toolName,
      arguments: input.arguments,
      expectedVersion: input.expectedVersion,
      executorPrincipalId: input.executorPrincipalId,
      expiresInSeconds: input.expiresInSeconds,
      reason,
    },
    requiredRoles: ["admin"],
    auditEvent: (approval) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "tool_approval.issued",
      entityType: "tool_approval",
      entityId: approval.approvalId,
      reason,
      payload: {
        toolName: approval.toolName,
        argumentsHash: approval.argumentsHash,
        expectedVersion: approval.expectedVersion,
        executorPrincipalId: approval.executorPrincipalId,
        approvedByPrincipalId: approval.approvedByPrincipalId,
        expiresAt: approval.expiresAt,
      },
    }),
    execute: () => {
      assertHumanProjectAdministrator(database, input.projectId, input.principalId);
      assertExecutorIsProvisionedAgent(database, input.projectId, input.executorPrincipalId);
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + input.expiresInSeconds * 1_000);
      const approval: ToolApproval = {
        approvalId: randomUUID(),
        projectId: input.projectId,
        toolName: input.toolName,
        argumentsHash,
        expectedVersion: input.expectedVersion,
        executorPrincipalId: input.executorPrincipalId,
        approvedByPrincipalId: input.principalId,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        status: "pending",
      };
      database.prepare(
        `INSERT INTO command_approvals
          (approval_id, project_id, tool_name, arguments_hash, expected_version,
           executor_principal_id, approved_by_principal_id, issued_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        approval.approvalId,
        approval.projectId,
        approval.toolName,
        approval.argumentsHash,
        approval.expectedVersion,
        approval.executorPrincipalId,
        approval.approvedByPrincipalId,
        approval.issuedAt,
        approval.expiresAt,
      );
      return approval;
    },
  });
}

export function revokeToolApproval(
  database: SqliteDatabase,
  input: RevokeToolApprovalInput,
): CommandReceipt<{ readonly approvalId: string; readonly status: "revoked"; readonly revokedAt: string }> {
  const reason = normalizeText(input.reason, 500, "Reason must contain 1-500 characters.");
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "tool_approval.revoke",
    requestId: input.requestId,
    payload: { approvalId: input.approvalId, reason },
    requiredRoles: ["admin"],
    auditEvent: (result) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "tool_approval.revoked",
      entityType: "tool_approval",
      entityId: result.approvalId,
      reason,
      payload: { approvalId: result.approvalId },
    }),
    execute: () => {
      assertHumanProjectAdministrator(database, input.projectId, input.principalId);
      const approval = database.prepare(
        `SELECT consumed_at, revoked_at FROM command_approvals
         WHERE approval_id = ? AND project_id = ?`,
      ).get(input.approvalId, input.projectId) as { consumed_at: string | null; revoked_at: string | null } | undefined;
      if (approval === undefined) throw new ApplicationError("NOT_FOUND", "Tool approval was not found.");
      if (approval.consumed_at !== null) throw new ApplicationError("APPROVAL_ALREADY_USED", "A consumed tool approval cannot be revoked.");
      if (approval.revoked_at !== null) throw new ApplicationError("APPROVAL_REVOKED", "Tool approval has already been revoked.");
      const revokedAt = new Date().toISOString();
      database.prepare(
        "UPDATE command_approvals SET revoked_at = ?, revoked_by_principal_id = ? WHERE approval_id = ?",
      ).run(revokedAt, input.principalId, input.approvalId);
      return { approvalId: input.approvalId, status: "revoked" as const, revokedAt };
    },
  });
}

export function assertMatchingToolApproval(
  database: SqliteDatabase,
  input: MatchingToolApprovalInput,
): MatchedToolApproval {
  if (!database.inTransaction) {
    throw new Error("Tool approvals must be validated inside the mutation transaction.");
  }
  const row = database.prepare(
    `SELECT project_id, tool_name, arguments_hash, expected_version,
            executor_principal_id, approved_by_principal_id, expires_at,
            consumed_at, revoked_at
     FROM command_approvals WHERE approval_id = ?`,
  ).get(input.approvalId) as {
    project_id: string;
    tool_name: string;
    arguments_hash: string;
    expected_version: number | null;
    executor_principal_id: string;
    approved_by_principal_id: string;
    expires_at: string;
    consumed_at: string | null;
    revoked_at: string | null;
  } | undefined;
  if (row === undefined) throw new ApplicationError("APPROVAL_NOT_FOUND", "Tool approval was not found.");
  if (row.revoked_at !== null) throw new ApplicationError("APPROVAL_REVOKED", "Tool approval has been revoked.");
  if (row.consumed_at !== null) throw new ApplicationError("APPROVAL_ALREADY_USED", "Tool approval has already been consumed.");
  if (Date.parse(row.expires_at) <= Date.now()) throw new ApplicationError("APPROVAL_EXPIRED", "Tool approval has expired.");

  const argumentsHash = hashArguments(input.arguments);
  if (
    row.project_id !== input.projectId ||
    row.executor_principal_id !== input.executorPrincipalId ||
    row.tool_name !== input.toolName ||
    row.arguments_hash !== argumentsHash ||
    row.expected_version !== input.expectedVersion
  ) {
    throw new ApplicationError("APPROVAL_MISMATCH", "Tool approval does not match this project, executor, tool, arguments, and expected version.");
  }
  return {
    approvalId: input.approvalId,
    projectId: row.project_id,
    toolName: row.tool_name,
    argumentsHash: row.arguments_hash,
    expectedVersion: row.expected_version,
    executorPrincipalId: row.executor_principal_id,
    approvedByPrincipalId: row.approved_by_principal_id,
  };
}

export function consumeToolApproval(
  database: SqliteDatabase,
  approval: MatchedToolApproval,
  mutationAuditEventIds: readonly string[] = [],
): string {
  if (!database.inTransaction) {
    throw new Error("Tool approvals must be consumed inside the mutation transaction.");
  }
  const consumedAt = new Date().toISOString();
  const updated = database.prepare(
    `UPDATE command_approvals
     SET consumed_at = ?, consumed_by_principal_id = ?
     WHERE approval_id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
  ).run(consumedAt, approval.executorPrincipalId, approval.approvalId, consumedAt);
  if (updated.changes !== 1) throw new ApplicationError("APPROVAL_ALREADY_USED", "Tool approval is no longer available.");

  const eventId = randomUUID();
  database.prepare(
    `INSERT INTO audit_events
      (event_id, project_id, principal_id, event_type, entity_type, entity_id,
       correlation_id, reason, occurred_at, payload_json)
     VALUES (?, ?, ?, 'tool_approval.consumed', 'tool_approval', ?, ?, NULL, ?, ?)`,
  ).run(
    eventId,
    approval.projectId,
    approval.executorPrincipalId,
    approval.approvalId,
    approval.approvalId,
    consumedAt,
    canonicalJson({
      toolName: approval.toolName,
      argumentsHash: approval.argumentsHash,
      expectedVersion: approval.expectedVersion,
      approvedByPrincipalId: approval.approvedByPrincipalId,
      executedByPrincipalId: approval.executorPrincipalId,
      mutationAuditEventIds: [...mutationAuditEventIds],
    }),
  );
  return eventId;
}

export function hashArguments(argumentsValue: JsonValue): string {
  return createHash("sha256").update(canonicalJson(argumentsValue)).digest("hex");
}

export function expectedVersionFromArguments(argumentsValue: JsonValue): number | null {
  if (argumentsValue === null || Array.isArray(argumentsValue) || typeof argumentsValue !== "object") {
    throw new ApplicationError("VALIDATION_FAILED", "Approved tool arguments must be an object.");
  }
  const version = argumentsValue.expectedVersion;
  if (version === undefined) return null;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
    throw new ApplicationError("VALIDATION_FAILED", "expectedVersion must be a non-negative integer.");
  }
  return version;
}

function validateApprovalBinding(input: CreateToolApprovalInput): void {
  if (!approvableMcpToolNames.includes(input.toolName)) {
    throw new ApplicationError("VALIDATION_FAILED", "Tool is not eligible for human approval.");
  }
  if (
    !Number.isSafeInteger(input.expiresInSeconds) ||
    input.expiresInSeconds < 30 ||
    input.expiresInSeconds > 600
  ) {
    throw new ApplicationError("VALIDATION_FAILED", "Approval lifetime must be between 30 and 600 seconds.");
  }
  if (input.expectedVersion !== expectedVersionFromArguments(input.arguments)) {
    throw new ApplicationError("VALIDATION_FAILED", "Approval expectedVersion must match the tool arguments.");
  }
  if (input.arguments === null || Array.isArray(input.arguments) || typeof input.arguments !== "object") {
    throw new ApplicationError("VALIDATION_FAILED", "Approved tool arguments must be an object.");
  }
  if (input.arguments.projectId !== input.projectId) {
    throw new ApplicationError("VALIDATION_FAILED", "Approved arguments must target the same project as the approval.");
  }
}

function assertHumanProjectAdministrator(database: SqliteDatabase, projectId: string, principalId: string): void {
  const row = database.prepare("SELECT principal_type FROM principals WHERE principal_id = ?")
    .get(principalId) as { principal_type: string } | undefined;
  if (row?.principal_type !== "human") {
    throw new ApplicationError("FORBIDDEN", "Only a human project administrator may issue or revoke tool approvals.");
  }
  assertProjectAuthorization(database, projectId, principalId, ["admin"]);
}

function assertExecutorIsProvisionedAgent(database: SqliteDatabase, projectId: string, executorPrincipalId: string): void {
  const row = database.prepare(
    `SELECT p.principal_type,
            EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id = ? AND pm.principal_id = p.principal_id) AS is_member
     FROM principals p WHERE p.principal_id = ?`,
  ).get(projectId, executorPrincipalId) as { principal_type: string; is_member: number } | undefined;
  if (row === undefined || row.is_member !== 1 || !["agent", "service"].includes(row.principal_type)) {
    throw new ApplicationError("VALIDATION_FAILED", "Executor must be a provisioned agent or service with project access.");
  }
}

function normalizeText(value: string, maximumLength: number, message: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new ApplicationError("VALIDATION_FAILED", message);
  }
  return normalized;
}
