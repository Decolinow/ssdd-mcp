import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { listDevelopmentSessions } from "../../src/application/development-lifecycle.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { listStaleDevelopmentSessions, recoverDevelopmentSession } from "../../src/application/session-recovery.js";
import { createManagedUser, ensureBootstrapAdministrator } from "../../src/application/user-management.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("abandoned development session recovery (SSDD-928)", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let adminId: string;
  let developerId: string;
  let developerOnlyId: string;
  let sessionId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-session-recovery-"));
    const initialized = initializeProject({ workspace, key: "REC", name: "Recovery", productGoal: "Recuperar", timezone: "UTC" });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    adminId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
      .get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    ensureBootstrapAdministrator(database, adminId);
    developerId = createManagedUser(database, {
      actorPrincipalId: adminId, requestId: "rec-dev", displayName: "Dev Ausente", principalType: "human",
      projects: [{ projectId, roles: ["developer"] }], reason: "Acesso de desenvolvimento",
    }).principalId;
    developerOnlyId = developerId;
    const make = (type: "epic" | "feature" | "story" | "task", title: string, parentId?: string) => createWorkItem(database, {
      projectId, principalId: adminId, requestId: randomUUID(), type, title, ...(parentId === undefined ? {} : { parentId }),
    }).value;
    const task = make("task", "Tarefa", make("story", "História", make("feature", "Feature", make("epic", "Épico").id).id).id);
    sessionId = randomUUID();
    const started = "2026-11-10T08:00:00.000Z";
    database.prepare(
      `INSERT INTO development_sessions (session_id, project_id, item_id, developer_principal_id, status, started_at, last_resumed_at, active_seconds, version)
       VALUES (?, ?, ?, ?, 'active', ?, ?, 600, 3)`,
    ).run(sessionId, projectId, task.id, developerId, started, started);
    database.prepare(
      `INSERT INTO development_session_events (event_id, project_id, session_id, event_type, principal_id, occurred_at, reason)
       VALUES (?, ?, ?, 'started', ?, ?, 'início')`,
    ).run(randomUUID(), projectId, sessionId, developerId, started);
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("lists only sessions idle past the threshold, for admin or tech lead only", () => {
    const stale = listStaleDevelopmentSessions(database, { projectId, principalId: adminId });
    assert.equal(stale.sessions.length, 1);
    assert.equal(stale.sessions[0]?.developerName, "Dev Ausente");
    assert.equal(stale.sessions[0]?.recordedActiveSeconds, 600);
    assert.ok((stale.sessions[0]?.unreliableSeconds ?? 0) > 3_600, "elapsed time since resume is reported as unreliable");
    assert.equal(listStaleDevelopmentSessions(database, { projectId, principalId: adminId, staleAfterHours: 2_000 }).sessions.length, 0);
    assert.throws(() => listStaleDevelopmentSessions(database, { projectId, principalId: developerOnlyId }), (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN");
  });

  it("recovers with an audited, idempotent command that preserves authorship and never credits offline time", () => {
    const input = { projectId, principalId: adminId, requestId: "recover-1", sessionId, action: "cancel" as const, expectedVersion: 3, reason: "Desenvolvedor ausente; sessão órfã confirmada." };
    const receipt = recoverDevelopmentSession(database, input);
    assert.equal(receipt.value.status, "cancelled");
    assert.equal(receipt.value.recordedActiveSeconds, 600);
    assert.ok(receipt.value.discardedUnreliableSeconds > 3_600);
    assert.equal(receipt.value.developerPrincipalId, developerId);
    assert.equal(receipt.value.recoveredByPrincipalId, adminId);
    const session = listDevelopmentSessions(database, { projectId, principalId: adminId, status: "cancelled" })[0]!;
    assert.equal(session.developerPrincipalId, developerId);
    assert.equal(session.activeSeconds, 600);
    const event = database.prepare("SELECT principal_id, reason FROM development_session_events WHERE session_id = ? ORDER BY sequence DESC LIMIT 1")
      .get(sessionId) as { principal_id: string; reason: string };
    assert.equal(event.principal_id, adminId);
    assert.match(event.reason, /^\[recovery\]/);
    assert.ok(receipt.auditEventIds.length > 0);
    assert.deepEqual(recoverDevelopmentSession(database, input).value, receipt.value, "same requestId replays");
    assert.throws(() => recoverDevelopmentSession(database, { ...input, requestId: "recover-2" }), (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_TRANSITION");
  });

  it("refuses fresh sessions, wrong versions, short reasons and non-privileged callers", () => {
    const base = { projectId, principalId: adminId, requestId: "recover-x", sessionId, action: "complete" as const, expectedVersion: 3, reason: "Motivo suficientemente longo." };
    assert.throws(() => recoverDevelopmentSession(database, { ...base, staleAfterHours: 2_000 }), (error: unknown) => error instanceof ApplicationError && error.code === "SESSION_NOT_STALE");
    assert.throws(() => recoverDevelopmentSession(database, { ...base, requestId: "recover-v", expectedVersion: 9 }), (error: unknown) => error instanceof ApplicationError && error.code === "VERSION_CONFLICT");
    assert.throws(() => recoverDevelopmentSession(database, { ...base, requestId: "recover-s", reason: "curto" }), (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED");
    assert.throws(() => recoverDevelopmentSession(database, { ...base, requestId: "recover-f", principalId: developerId }), (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN");
    assert.equal(listDevelopmentSessions(database, { projectId, principalId: adminId, status: "active" }).length, 1);
  });
});
