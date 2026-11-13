import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { listReviews, recordReview } from "../../src/application/task-reviews.js";
import { createManagedUser, ensureBootstrapAdministrator } from "../../src/application/user-management.js";
import { transitionWorkItem } from "../../src/application/work-item-workflow.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("independent review gate (SSDD-942)", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let executor: string;
  let reviewer: string;
  let agent: string;
  let taskId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-reviews-"));
    const initialized = initializeProject({ workspace, key: "RV", name: "Reviews", productGoal: "Revisar", timezone: "UTC" });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    executor = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?").get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    ensureBootstrapAdministrator(database, executor);
    const user = (name: string, principalType: "human" | "agent") => createManagedUser(database, {
      actorPrincipalId: executor, requestId: `rv-${name}`, displayName: name, principalType,
      projects: [{ projectId, roles: ["developer", "qa"] }], reason: "Acesso de teste",
    }).principalId;
    reviewer = user("bia", "human");
    agent = user("bot", "agent");
    const make = (type: "epic" | "feature" | "story" | "task", title: string, extra: Record<string, unknown> = {}) =>
      createWorkItem(database, { projectId, principalId: executor, requestId: `create-${title}`, type, title, ...extra } as Parameters<typeof createWorkItem>[1]).value;
    const epic = make("epic", "Epic");
    const feature = make("feature", "Feature", { parentId: epic.id });
    const story = make("story", "Story", { parentId: feature.id, criteria: [{ description: "Pedido confirmado" }] });
    taskId = make("task", "Tarefa", { parentId: story.id, description: "Entrega" }).id;
    database.prepare("UPDATE work_items SET state = 'in_review' WHERE project_id = ? AND item_id = ?").run(projectId, taskId);
    database.prepare(
      `INSERT INTO development_sessions (session_id, project_id, item_id, developer_principal_id, status, started_at, ended_at)
       VALUES ('s1', ?, ?, ?, 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z')`,
    ).run(projectId, taskId, executor);
  });

  afterEach(() => {
    delete process.env["SSDD_REQUIRE_INDEPENDENT_REVIEW"];
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const review = (principalId: string, requestId: string, decision: "approved" | "changes_requested", findings?: { message: string; criterionKey?: string }[]) =>
    recordReview(database, { projectId, principalId, requestId, itemIdOrKey: taskId, decision, ...(findings === undefined ? {} : { findings }) });
  const toValidation = (requestId: string) => transitionWorkItem(database, {
    projectId, principalId: executor, requestId, itemIdOrKey: taskId, targetState: "in_validation",
    expectedVersion: (database.prepare("SELECT version FROM work_items WHERE item_id = ?").get(taskId) as { version: number }).version, reason: "self_validation: ok",
  });

  it("rejects the executor as reviewer and requires findings for changes_requested", () => {
    assert.throws(() => review(executor, "self", "approved"), (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN");
    assert.throws(() => review(reviewer, "empty", "changes_requested"), (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED");
  });

  it("blocks validation after changes_requested until a newer approval is recorded", () => {
    review(reviewer, "r1", "changes_requested", [{ criterionKey: "AC-1", message: "falta tratar estoque" }]);
    assert.throws(() => toValidation("v1"), (error: unknown) => error instanceof ApplicationError && error.code === "GATE_BLOCKED");
    const approved = review(reviewer, "r2", "approved");
    assert.equal(approved.value.review.advisory, false);
    assert.deepEqual(listReviews(database, { projectId, principalId: reviewer, itemIdOrKey: taskId }).reviews.map((entry) => entry.decision), ["approved", "changes_requested"]);
    assert.equal(toValidation("v2").value.transition.toState, "in_validation");
    assert.throws(() => database.prepare("UPDATE task_reviews SET summary = 'x'").run(), /immutable/);
  });

  it("requires a human approval for the current report only in strict mode and keeps agent reviews advisory", () => {
    process.env["SSDD_REQUIRE_INDEPENDENT_REVIEW"] = "1";
    assert.throws(() => toValidation("strict-none"), (error: unknown) => error instanceof ApplicationError && error.code === "GATE_BLOCKED");
    const advisory = review(agent, "agent", "approved");
    assert.equal(advisory.value.review.advisory, true);
    assert.throws(() => toValidation("strict-agent"), (error: unknown) => error instanceof ApplicationError && error.code === "GATE_BLOCKED");
    review(reviewer, "human", "approved");
    assert.equal(toValidation("strict-human").value.transition.toState, "in_validation");
  });
});
