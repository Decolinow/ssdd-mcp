import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { listAuditEvents } from "../../src/application/audit-queries.js";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("audit timeline queries", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let adminId: string;
  let developerId: string;
  let approvalId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-audit-"));
    const initialized = initializeProject({
      workspace, key: "AUD", name: "Audit", productGoal: "Rastrear mudanças", timezone: "America/Sao_Paulo",
    });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    adminId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
      .get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    developerId = randomUUID();
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
       VALUES (?, 'agent', ?, 'Dev agent', ?)`,
    ).run(developerId, `test-agent:${developerId}`, now);
    database.prepare(
      "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, 'developer', ?)",
    ).run(projectId, developerId, now);
    approvalId = randomUUID();
    database.prepare(
      `INSERT INTO audit_events
        (event_id, project_id, principal_id, event_type, entity_type, entity_id, correlation_id, reason, occurred_at, payload_json)
       VALUES (?, ?, ?, 'tool_approval.issued', 'tool_approval', ?, ?, NULL, ?, ?)`,
    ).run(randomUUID(), projectId, developerId, approvalId, approvalId, now, JSON.stringify({ argumentsHash: "abc" }));
    for (let index = 1; index <= 3; index += 1) {
      createWorkItem(database, {
        projectId, principalId: adminId, requestId: `audit-epic-${index}`, type: "epic", title: `Épico ${index}`,
      });
    }
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("filters the timeline by the principal that executed each event", () => {
    const byDeveloper = listAuditEvents(database, { projectId, principalId: adminId, actorPrincipalId: developerId });
    assert.deepEqual(byDeveloper.events.map((event) => event.principalId), [developerId]);
    const byAdmin = listAuditEvents(database, { projectId, principalId: adminId, actorPrincipalId: adminId });
    assert.ok(byAdmin.events.length >= 3);
    assert.ok(byAdmin.events.every((event) => event.principalId === adminId));
  });

  it("rejects a malformed actor filter and binds the cursor to it", () => {
    assert.throws(
      () => listAuditEvents(database, { projectId, principalId: adminId, actorPrincipalId: "not-a-uuid" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
    const page = listAuditEvents(database, { projectId, principalId: adminId, actorPrincipalId: adminId, limit: 1 });
    assert.ok(page.nextCursor);
    assert.throws(
      () => listAuditEvents(database, { projectId, principalId: adminId, limit: 1, cursor: page.nextCursor! }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
  });

  it("hides approval payloads from non-administrators and refuses non-members", () => {
    const asDeveloper = listAuditEvents(database, { projectId, principalId: developerId, entityType: "tool_approval" });
    assert.equal(asDeveloper.events.length, 1);
    assert.equal(asDeveloper.events[0]?.payload, null);
    assert.equal(asDeveloper.events[0]?.payloadRedacted, true);
    const asAdmin = listAuditEvents(database, { projectId, principalId: adminId, entityType: "tool_approval" });
    assert.deepEqual(asAdmin.events[0]?.payload, { argumentsHash: "abc" });
    assert.equal(asAdmin.events[0]?.payloadRedacted, false);
    assert.throws(
      () => listAuditEvents(database, { projectId, principalId: randomUUID() }),
      (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN",
    );
  });
});
