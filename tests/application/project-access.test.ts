import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { initializeProject } from "../../src/application/initialize-project.js";
import { ApplicationError } from "../../src/application/errors.js";
import { executeIdempotentCommand } from "../../src/application/idempotent-command.js";
import { getProject, listProjects } from "../../src/application/project-queries.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("local project access and commands", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-access-"));
    const initialized = initializeProject({
      workspace,
      key: "PAY",
      name: "Payments",
      productGoal: "Pagamentos confiáveis",
      timezone: "America/Sao_Paulo",
    });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    const project = database
      .prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
      .get(projectId) as { created_by_principal_id: string };
    principalId = project.created_by_principal_id;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("audits initialization once and limits project reads to members", () => {
    const secondInit = initializeProject({
      workspace,
      key: "PAY",
      name: "Payments",
      productGoal: "Pagamentos confiáveis",
      timezone: "America/Sao_Paulo",
    });
    const auditCount = database
      .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'project.initialized'")
      .get() as { count: number };
    const visibleProjects = listProjects(database, principalId);

    assert.equal(secondInit.created, false);
    assert.equal(auditCount.count, 1);
    assert.equal(visibleProjects.length, 1);
    assert.equal(getProject(database, principalId, projectId).key, "PAY");

    const outsiderId = randomUUID();
    database
      .prepare(
        `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
         VALUES (?, 'agent', ?, 'unassigned-agent', ?)`,
      )
      .run(outsiderId, `test:${outsiderId}`, new Date().toISOString());

    assert.deepEqual(listProjects(database, outsiderId), []);
    assert.throws(
      () => getProject(database, outsiderId, projectId),
      (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN",
    );
  });

  it("replays an authorized idempotent command without a second write or audit event", () => {
    database.exec(
      "CREATE TABLE command_counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL); INSERT INTO command_counter VALUES (1, 0);",
    );

    const first = executeIdempotentCommand(database, command({ value: 1, label: "rank" }));
    const replay = executeIdempotentCommand(database, command({ label: "rank", value: 1 }));
    const writes = database.prepare("SELECT value FROM command_counter WHERE id = 1").get() as {
      value: number;
    };
    const auditCount = database
      .prepare("SELECT COUNT(*) AS count FROM audit_events")
      .get() as { count: number };

    assert.deepEqual(replay, first);
    assert.equal(writes.value, 1);
    assert.equal(auditCount.count, 2);
  });

  it("rejects a reused request ID with a changed payload and blocks unauthorized commands", () => {
    database.exec(
      "CREATE TABLE command_counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL); INSERT INTO command_counter VALUES (1, 0);",
    );
    executeIdempotentCommand(database, command({ value: 1, label: "rank" }));

    assert.throws(
      () => executeIdempotentCommand(database, command({ value: 2, label: "rank" })),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "IDEMPOTENCY_CONFLICT",
    );

    const outsiderId = randomUUID();
    database
      .prepare(
        `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
         VALUES (?, 'agent', ?, 'unassigned-agent', ?)`,
      )
      .run(outsiderId, `test:${outsiderId}`, new Date().toISOString());

    assert.throws(
      () =>
        executeIdempotentCommand(
          database,
          command({ value: 3, label: "rank" }, outsiderId, "request-outsider"),
        ),
      (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN",
    );

    const writes = database.prepare("SELECT value FROM command_counter WHERE id = 1").get() as {
      value: number;
    };
    const auditCount = database
      .prepare("SELECT COUNT(*) AS count FROM audit_events")
      .get() as { count: number };

    assert.equal(writes.value, 1);
    assert.equal(auditCount.count, 2);
  });

  it("rolls back command data when execution fails before audit and idempotency records", () => {
    database.exec(
      "CREATE TABLE command_counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL); INSERT INTO command_counter VALUES (1, 0);",
    );
    const failing = {
      ...command({ value: 1, label: "rank" }, principalId, "request-fails"),
      execute: () => {
        database.prepare("UPDATE command_counter SET value = 1 WHERE id = 1").run();
        throw new Error("simulated command failure");
      },
    };

    assert.throws(() => executeIdempotentCommand(database, failing), /simulated command failure/);

    const writes = database.prepare("SELECT value FROM command_counter WHERE id = 1").get() as {
      value: number;
    };
    const auditCount = database
      .prepare("SELECT COUNT(*) AS count FROM audit_events")
      .get() as { count: number };
    const idempotencyCount = database
      .prepare("SELECT COUNT(*) AS count FROM idempotency_records")
      .get() as { count: number };

    assert.equal(writes.value, 0);
    assert.equal(auditCount.count, 1);
    assert.equal(idempotencyCount.count, 0);
  });

  it("expires stored responses while keeping a replay-blocking tombstone", () => {
    database.exec(
      "CREATE TABLE command_counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL); INSERT INTO command_counter VALUES (1, 0);",
    );
    const original = command({ value: 1, label: "rank" });
    executeIdempotentCommand(database, original);
    database
      .prepare(
        `UPDATE idempotency_records
         SET created_at = '1999-01-01T00:00:00.000Z', expires_at = '2000-01-01T00:00:00.000Z'
         WHERE request_id = ?`,
      )
      .run(original.requestId);

    assert.throws(
      () => executeIdempotentCommand(database, original),
      (error: unknown) => error instanceof ApplicationError && error.code === "IDEMPOTENCY_EXPIRED",
    );

    const row = database
      .prepare(
        "SELECT payload_hash, response_json FROM idempotency_records WHERE request_id = ?",
      )
      .get(original.requestId) as { payload_hash: string | null; response_json: string | null };
    const writes = database.prepare("SELECT value FROM command_counter WHERE id = 1").get() as {
      value: number;
    };

    assert.equal(row.payload_hash, null);
    assert.equal(row.response_json, null);
    assert.equal(writes.value, 1);
  });

  function command(
    payload: { readonly value: number; readonly label: string },
    actorId = principalId,
    requestId = "request-rank-1",
  ) {
    return {
      projectId,
      principalId: actorId,
      action: "test.rank",
      requestId,
      payload,
      requiredRoles: ["developer"] as const,
      auditEvent: {
        projectId,
        principalId: actorId,
        eventType: "test.ranked",
        entityType: "work_item",
        entityId: "PAY-1",
        payload: { requestedRank: payload.value },
      },
      execute: () => {
        database.prepare("UPDATE command_counter SET value = value + 1 WHERE id = 1").run();
        const result = database
          .prepare("SELECT value FROM command_counter WHERE id = 1")
          .get() as { value: number };
        return { count: result.value };
      },
    };
  }
});
