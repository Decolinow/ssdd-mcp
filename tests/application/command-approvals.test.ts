import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ApplicationError } from "../../src/application/errors.js";
import {
  assertMatchingToolApproval,
  consumeToolApproval,
  expectedVersionFromArguments,
  issueToolApproval,
  revokeToolApproval,
} from "../../src/application/command-approvals.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import type { JsonValue } from "../../src/application/idempotent-command.js";

describe("single-use tool approvals", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let adminPrincipalId: string;
  let executorPrincipalId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-approvals-"));
    const initialized = initializeProject({
      workspace,
      key: "PAY",
      name: "Payments",
      productGoal: "Pagamentos confiáveis",
      timezone: "America/Sao_Paulo",
    });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    adminPrincipalId = (database.prepare(
      "SELECT created_by_principal_id FROM projects WHERE project_id = ?",
    ).get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    executorPrincipalId = randomUUID();
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
       VALUES (?, 'agent', ?, 'Build agent', ?)`,
    ).run(executorPrincipalId, `test-agent:${executorPrincipalId}`, now);
    database.prepare(
      "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, 'developer', ?)",
    ).run(projectId, executorPrincipalId, now);
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("binds project, tool, canonical arguments, version, executor, approver, and one-time consumption", () => {
    const args = {
      projectId,
      requestId: "agent-work-item-create-1",
      expectedVersion: 0,
      type: "story",
      title: "Persist secure approval",
    } satisfies JsonValue;
    const input = {
      projectId,
      principalId: adminPrincipalId,
      requestId: "approve-create-1",
      toolName: "work_item_create" as const,
      arguments: args,
      expectedVersion: 0,
      executorPrincipalId,
      expiresInSeconds: 120,
      reason: "Aprovado após revisar os critérios.",
    };
    const approval = issueToolApproval(database, input);
    assert.deepEqual(issueToolApproval(database, input), approval);
    assert.equal(approval.value.approvedByPrincipalId, adminPrincipalId);
    assert.equal(approval.value.executorPrincipalId, executorPrincipalId);

    const reorderedArguments = {
      title: "Persist secure approval",
      type: "story",
      expectedVersion: 0,
      requestId: "agent-work-item-create-1",
      projectId,
    } satisfies JsonValue;
    const matchInput = {
      approvalId: approval.value.approvalId,
      projectId,
      executorPrincipalId,
      toolName: "work_item_create",
      arguments: reorderedArguments,
      expectedVersion: 0,
    };
    const matched = database.transaction(() => assertMatchingToolApproval(database, matchInput)).immediate();
    const consumptionAuditId = database.transaction(() => consumeToolApproval(database, matched)).immediate();
    assert.ok(consumptionAuditId.length > 0);
    assert.throws(
      () => database.transaction(() => assertMatchingToolApproval(database, matchInput)).immediate(),
      (error: unknown) => error instanceof ApplicationError && error.code === "APPROVAL_ALREADY_USED",
    );

    const audit = database.prepare(
      `SELECT principal_id, payload_json FROM audit_events WHERE event_type = 'tool_approval.consumed'`,
    ).get() as { principal_id: string; payload_json: string };
    assert.equal(audit.principal_id, executorPrincipalId);
    assert.deepEqual(JSON.parse(audit.payload_json), {
      toolName: "work_item_create",
      argumentsHash: approval.value.argumentsHash,
      expectedVersion: 0,
      approvedByPrincipalId: adminPrincipalId,
      executedByPrincipalId: executorPrincipalId,
      mutationAuditEventIds: [],
    });
  });

  it("rejects changed arguments, project, executor, tool, and expected version without consuming approval", () => {
    const args = { projectId, requestId: "approved", expectedVersion: 3, reason: "Review" } satisfies JsonValue;
    const approval = createApproval(args);
    const correctInput = {
      approvalId: approval.value.approvalId,
      projectId,
      executorPrincipalId,
      toolName: "team_capacity_set",
      arguments: args,
      expectedVersion: expectedVersionFromArguments(args),
    };
    const mismatches = [
      { ...correctInput, arguments: { ...args, reason: "Changed" } },
      { ...correctInput, projectId: randomUUID() },
      { ...correctInput, executorPrincipalId: randomUUID() },
      { ...correctInput, toolName: "sprint_start" },
      { ...correctInput, expectedVersion: 4 },
    ];
    for (const mismatch of mismatches) {
      assert.throws(
        () => database.transaction(() => assertMatchingToolApproval(database, mismatch)).immediate(),
        (error: unknown) => error instanceof ApplicationError && error.code === "APPROVAL_MISMATCH",
      );
    }
    assert.doesNotThrow(() => database.transaction(() => assertMatchingToolApproval(database, correctInput)).immediate());
  });

  it("rejects expired, revoked, unauthorized, and non-agent approvals", () => {
    const args = { projectId, requestId: "approved-expiring" } satisfies JsonValue;
    const expiredApprovalId = randomUUID();
    database.prepare(
      `INSERT INTO command_approvals
        (approval_id, project_id, tool_name, arguments_hash, expected_version, executor_principal_id,
         approved_by_principal_id, issued_at, expires_at)
       VALUES (?, ?, 'work_item_create', ?, NULL, ?, ?, ?, ?)`,
    ).run(expiredApprovalId, projectId, "0".repeat(64), executorPrincipalId, adminPrincipalId,
      new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 1_000).toISOString());
    assert.throws(
      () => database.transaction(() => assertMatchingToolApproval(database, {
        approvalId: expiredApprovalId,
        projectId,
        executorPrincipalId,
        toolName: "work_item_create",
        arguments: args,
        expectedVersion: null,
      })).immediate(),
      (error: unknown) => error instanceof ApplicationError && error.code === "APPROVAL_EXPIRED",
    );

    const approval = createApproval(args);
    revokeToolApproval(database, {
      projectId,
      principalId: adminPrincipalId,
      requestId: "revoke-approved-expiring",
      approvalId: approval.value.approvalId,
      reason: "Mudança na janela de deploy.",
    });
    assert.throws(
      () => database.transaction(() => assertMatchingToolApproval(database, {
        approvalId: approval.value.approvalId,
        projectId,
        executorPrincipalId,
        toolName: "work_item_create",
        arguments: args,
        expectedVersion: null,
      })).immediate(),
      (error: unknown) => error instanceof ApplicationError && error.code === "APPROVAL_REVOKED",
    );
    database.prepare(
      "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, 'admin', ?)",
    ).run(projectId, executorPrincipalId, new Date().toISOString());
    assert.throws(() => issueToolApproval(database, {
      projectId,
      principalId: executorPrincipalId,
      requestId: "agent-cannot-approve",
      toolName: "work_item_create",
      arguments: args,
      expectedVersion: null,
      executorPrincipalId,
      expiresInSeconds: 60,
      reason: "Não pode aprovar a própria ação.",
    }), (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN");
  });

  it("rejects invalid lifetime, version bindings, and executors without project membership", () => {
    const args = { projectId, requestId: "invalid-binding", expectedVersion: 2 } satisfies JsonValue;
    assert.throws(() => createApproval(args, { expiresInSeconds: 601 }), (error: unknown) =>
      error instanceof ApplicationError && error.code === "VALIDATION_FAILED");
    assert.throws(() => createApproval(args, { expectedVersion: 1 }), (error: unknown) =>
      error instanceof ApplicationError && error.code === "VALIDATION_FAILED");
    assert.throws(() => createApproval(args, { executorPrincipalId: randomUUID() }), (error: unknown) =>
      error instanceof ApplicationError && error.code === "VALIDATION_FAILED");
    assert.throws(() => createApproval(args, { executorPrincipalId: adminPrincipalId }), (error: unknown) =>
      error instanceof ApplicationError && error.code === "VALIDATION_FAILED");
  });

  function createApproval(
    args: JsonValue,
    overrides: Partial<Parameters<typeof issueToolApproval>[1]> = {},
  ) {
    return issueToolApproval(database, {
      projectId,
      principalId: adminPrincipalId,
      requestId: randomUUID(),
      toolName: "team_capacity_set",
      arguments: args,
      expectedVersion: expectedVersionFromArguments(args),
      executorPrincipalId,
      expiresInSeconds: 90,
      reason: "Aprovação temporária de teste.",
      ...overrides,
    });
  }
});
