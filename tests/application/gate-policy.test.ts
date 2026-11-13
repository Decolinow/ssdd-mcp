import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ApplicationError } from "../../src/application/errors.js";
import { getGatePolicy, readGatePolicy, setGatePolicy } from "../../src/application/gate-policy.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { transitionWorkItem, getWorkItemGateReport } from "../../src/application/work-item-workflow.js";
import { createManagedUser, ensureBootstrapAdministrator } from "../../src/application/user-management.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("project gate policy (SSDD-947)", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let storyId: string;
  let taskId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-policy-"));
    const initialized = initializeProject({ workspace, key: "GP", name: "Policy", productGoal: "Politicar", timezone: "UTC" });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?").get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    const make = (type: "epic" | "feature" | "story" | "task", title: string, extra: Record<string, unknown> = {}) =>
      createWorkItem(database, { projectId, principalId, requestId: `create-${title}`, type, title, ...extra } as Parameters<typeof createWorkItem>[1]).value;
    const epic = make("epic", "Epic");
    const feature = make("feature", "Feature", { parentId: epic.id });
    storyId = make("story", "Story", { parentId: feature.id, criteria: [{ description: "Pedido confirmado" }] }).id;
    taskId = make("task", "Tarefa", { parentId: storyId, description: "Entrega" }).id;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const readyGate = () => getWorkItemGateReport(database, { projectId, principalId, itemIdOrKey: storyId, targetState: "ready" });

  it("defaults to standard, versions revisions and rejects stale revisions, short reasons and non-humans", () => {
    assert.deepEqual(getGatePolicy(database, projectId), { level: "standard", revisionNumber: null, reason: null, setByPrincipalId: null, setAt: null });
    assert.throws(() => setGatePolicy(database, { projectId, principalId, requestId: "short", level: "lite", reason: "curto", expectedRevision: 0 }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED");
    const first = setGatePolicy(database, { projectId, principalId, requestId: "p1", level: "lite", reason: "Projeto piloto em fase de descoberta", expectedRevision: 0 });
    assert.equal(first.value.revisionNumber, 1);
    assert.throws(() => setGatePolicy(database, { projectId, principalId, requestId: "stale", level: "strict", reason: "Endurecer o processo agora", expectedRevision: 0 }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VERSION_CONFLICT");
    setGatePolicy(database, { projectId, principalId, requestId: "p2", level: "standard", reason: "Voltar ao padrão do time", expectedRevision: 1 });
    assert.deepEqual(readGatePolicy(database, projectId, principalId).history.map((entry) => entry.level), ["standard", "lite"]);
    assert.throws(() => database.prepare("UPDATE gate_policy_revisions SET level = 'strict'").run(), /immutable/);

    const adminId = principalId;
    ensureBootstrapAdministrator(database, adminId);
    const bot = createManagedUser(database, {
      actorPrincipalId: adminId, requestId: "bot", displayName: "bot", principalType: "agent",
      projects: [{ projectId, roles: ["po", "tech_lead"] }], reason: "Acesso de teste",
    }).principalId;
    assert.throws(() => setGatePolicy(database, { projectId, principalId: bot, requestId: "agent", level: "lite", reason: "Agente tentando mudar a política", expectedRevision: 2 }),
      (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN");
  });

  it("lite dispenses the published-scenario gate for Ready and every gate report shows the policy", () => {
    const standard = readyGate();
    assert.equal(standard.policy.level, "standard");
    assert.equal(standard.gates.find((gate) => gate.id === "required-criterion-coverage")?.passed, false);
    setGatePolicy(database, { projectId, principalId, requestId: "lite", level: "lite", reason: "Projeto piloto em fase de descoberta", expectedRevision: 0 });
    const lite = readyGate();
    assert.equal(lite.policy.level, "lite");
    assert.equal(lite.policy.revisionNumber, 1);
    assert.equal(lite.gates.find((gate) => gate.id === "required-criterion-coverage")?.passed, true);
  });

  it("strict requires the delivery report and an independent human review", () => {
    setGatePolicy(database, { projectId, principalId, requestId: "strict", level: "strict", reason: "Endurecer o processo para a release", expectedRevision: 0 });
    database.prepare("UPDATE work_items SET state = 'in_progress' WHERE project_id = ? AND item_id = ?").run(projectId, taskId);
    const version = () => (database.prepare("SELECT version FROM work_items WHERE item_id = ?").get(taskId) as { version: number }).version;
    assert.throws(
      () => transitionWorkItem(database, { projectId, principalId, requestId: "to-review", itemIdOrKey: taskId, targetState: "in_review", expectedVersion: version(), reason: "self_validation: ok" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "GATE_BLOCKED",
    );
    database.prepare("UPDATE work_items SET state = 'in_review' WHERE project_id = ? AND item_id = ?").run(projectId, taskId);
    assert.throws(
      () => transitionWorkItem(database, { projectId, principalId, requestId: "to-validation", itemIdOrKey: taskId, targetState: "in_validation", expectedVersion: version(), reason: "self_validation: ok" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "GATE_BLOCKED",
    );
  });
});
