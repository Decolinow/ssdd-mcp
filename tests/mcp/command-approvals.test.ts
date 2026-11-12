import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, it } from "node:test";
import { initializeProject } from "../../src/application/initialize-project.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { createMcpServer } from "../../src/mcp/server.js";

describe("approval-bound MCP mutations", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let adminPrincipalId: string;
  let executorPrincipalId: string;
  let adminClient: Client;
  let executorClient: Client;

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-approved-call-"));
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
    database.prepare(
      "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, 'po', ?)",
    ).run(projectId, executorPrincipalId, now);

    const [adminClientTransport, adminServerTransport] = InMemoryTransport.createLinkedPair();
    const [executorClientTransport, executorServerTransport] = InMemoryTransport.createLinkedPair();
    adminClient = new Client({ name: "approval-admin-test", version: "0.1.0" });
    executorClient = new Client({ name: "approval-executor-test", version: "0.1.0" });
    await createMcpServer(database, adminPrincipalId).connect(adminServerTransport);
    await createMcpServer(database, executorPrincipalId).connect(executorServerTransport);
    await adminClient.connect(adminClientTransport);
    await executorClient.connect(executorClientTransport);
  });

  afterEach(async () => {
    await adminClient.close();
    await executorClient.close();
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("requires a bound approval, consumes it once, and rolls back mutation with consumption", async () => {
    const argumentsValue = {
      projectId,
      requestId: "approved-story-1",
      type: "epic",
      title: "Approved story",
    };
    const missing = await executorClient.callTool({ name: "work_item_create", arguments: argumentsValue });
    assert.equal(readErrorCode(missing), "APPROVAL_REQUIRED");

    const issued = await issue("approved-story-1", argumentsValue);
    const approvalId = readApprovalId(issued);
    const changedArguments = await executorClient.callTool({
      name: "work_item_create",
      arguments: { ...argumentsValue, title: "Changed after approval" },
      _meta: approvalMetadata(approvalId),
    });
    assert.equal(readErrorCode(changedArguments), "APPROVAL_MISMATCH");
    assert.equal(countStories("Changed after approval"), 0);

    database.exec(`
      CREATE TRIGGER fail_approval_consume_for_test
      BEFORE INSERT ON audit_events
      WHEN new.event_type = 'tool_approval.consumed'
      BEGIN
        SELECT RAISE(ABORT, 'forced approval audit failure');
      END;
    `);
    const originalStderrWrite = process.stderr.write;
    const diagnosticOutput: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      diagnosticOutput.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    let rollbackResult: Awaited<ReturnType<Client["callTool"]>>;
    try {
      rollbackResult = await executorClient.callTool({
        name: "work_item_create",
        arguments: argumentsValue,
        _meta: approvalMetadata(approvalId),
      });
    } finally {
      process.stderr.write = originalStderrWrite;
    }
    assert.equal(rollbackResult.isError, true);
    assert.equal(rollbackResult.structuredContent, undefined);
    assert.equal(readErrorCode(rollbackResult), "INTERNAL_ERROR", JSON.stringify(rollbackResult));
    const errorText = rollbackResult.content?.find((entry) => entry.type === "text")?.text;
    assert.ok(errorText);
    const error = JSON.parse(errorText) as {
      code: string; message: string; details: unknown; retryable: boolean; correlationId: string;
    };
    assert.equal(error.message, "An unexpected server error occurred.");
    assert.equal(error.details, null);
    assert.equal(error.retryable, false);
    assert.match(error.correlationId, /^[0-9a-f-]{36}$/u);
    assert.match(diagnosticOutput.join(""), new RegExp(`MCP tool failure ${error.correlationId} \\(`));
    assert.doesNotMatch(errorText, /forced approval audit failure/u);
    assert.doesNotMatch(diagnosticOutput.join(""), /forced approval audit failure/u);
    assert.equal(countStories("Approved story"), 0);
    assert.equal(approvalStatus(approvalId), "pending");
    database.exec("DROP TRIGGER fail_approval_consume_for_test");

    const succeeded = await executorClient.callTool({
      name: "work_item_create",
      arguments: argumentsValue,
      _meta: approvalMetadata(approvalId),
    });
    assert.notEqual(succeeded.isError, true);
    assert.equal(countStories("Approved story"), 1);
    assert.equal(approvalStatus(approvalId), "consumed");
    const replay = await executorClient.callTool({
      name: "work_item_create",
      arguments: argumentsValue,
      _meta: approvalMetadata(approvalId),
    });
    assert.equal(readErrorCode(replay), "APPROVAL_ALREADY_USED");
    assert.equal(countStories("Approved story"), 1);
  });

  it("serializes concurrent calls and supports revoking a pending approval", async () => {
    const argumentsValue = {
      projectId,
      requestId: "concurrent-story-1",
      type: "epic",
      title: "Only create once",
    };
    const issued = await issue("approve-concurrent-1", argumentsValue);
    const approvalId = readApprovalId(issued);
    const calls = await Promise.all([
      executorClient.callTool({ name: "work_item_create", arguments: argumentsValue, _meta: approvalMetadata(approvalId) }),
      executorClient.callTool({ name: "work_item_create", arguments: argumentsValue, _meta: approvalMetadata(approvalId) }),
    ]);
    assert.equal(calls.filter((result) => result.isError !== true).length, 1, JSON.stringify(calls));
    assert.equal(calls.filter((result) => readErrorCode(result) === "APPROVAL_ALREADY_USED").length, 1);
    assert.equal(countStories("Only create once"), 1);

    const revokedArguments = {
      projectId,
      requestId: "revoked-story-1",
      type: "epic",
      title: "Revoked story",
    };
    const revocable = await issue("approve-revoked-1", revokedArguments);
    const revokedId = readApprovalId(revocable);
    const revokeResult = await adminClient.callTool({
      name: "approval_revoke",
      arguments: {
        projectId,
        requestId: "revoke-story-1",
        approvalId: revokedId,
        reason: "O escopo mudou antes da execução.",
      },
    });
    assert.notEqual(revokeResult.isError, true);
    const refused = await executorClient.callTool({
      name: "work_item_create",
      arguments: revokedArguments,
      _meta: approvalMetadata(revokedId),
    });
    assert.equal(readErrorCode(refused), "APPROVAL_REVOKED");
    assert.equal(countStories("Revoked story"), 0);
  });

  async function issue(requestId: string, argumentsValue: Record<string, string>) {
    const result = await adminClient.callTool({
      name: "approval_issue",
      arguments: {
        projectId,
        requestId,
        toolName: "work_item_create",
        arguments: argumentsValue,
        expectedVersion: null,
        executorPrincipalId,
        expiresInSeconds: 120,
        reason: "A ação foi revisada por um admin humano.",
      },
    });
    assert.notEqual(result.isError, true);
    return result;
  }

  function countStories(title: string): number {
    return (database.prepare(
      "SELECT COUNT(*) AS count FROM work_items WHERE project_id = ? AND title = ?",
    ).get(projectId, title) as { count: number }).count;
  }

  function approvalStatus(approvalId: string): string {
    const row = database.prepare(
      "SELECT consumed_at, revoked_at FROM command_approvals WHERE approval_id = ?",
    ).get(approvalId) as { consumed_at: string | null; revoked_at: string | null };
    if (row.consumed_at !== null) return "consumed";
    if (row.revoked_at !== null) return "revoked";
    return "pending";
  }
});

function readApprovalId(result: { readonly structuredContent?: unknown }): string {
  const content = result.structuredContent as { approval?: { approvalId?: string } } | undefined;
  const approvalId = content?.approval?.approvalId;
  assert.equal(typeof approvalId, "string");
  return approvalId as string;
}

function readErrorCode(result: {
  readonly isError?: boolean | undefined;
  readonly content?: readonly { readonly type: string; readonly text?: string | undefined }[] | undefined;
}): string | undefined {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (text === undefined) return undefined;
  try {
    return (JSON.parse(text) as { readonly code?: string }).code;
  } catch {
    return undefined;
  }
}

function approvalMetadata(approvalId: string): Record<string, string> {
  return { "com.ssdd-mcp/approval-id": approvalId };
}
