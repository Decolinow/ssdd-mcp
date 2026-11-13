import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { acceptTask } from "../../src/application/task-accept.js";
import { getWorkItem } from "../../src/application/work-item-queries.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("task_accept composite command (U11/U18)", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let storyId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-task-accept-"));
    const initialized = initializeProject({ workspace, key: "ACC", name: "Accept", productGoal: "Fechar tarefas", timezone: "UTC" });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
      .get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    const epic = item("epic", "Épico");
    const feature = item("feature", "Feature", epic.id);
    storyId = item("story", "História", feature.id).id;
    database.prepare("UPDATE work_items SET state = 'ready' WHERE project_id = ? AND item_id = ?").run(projectId, storyId);
    database.prepare(
      `INSERT INTO work_baselines (baseline_id, project_id, item_id, sequence, kind, reason, created_by_principal_id, created_at)
       VALUES (?, ?, ?, 1, 'ready', 'Baseline de fixture', ?, ?)`,
    ).run(randomUUID(), projectId, storyId, principalId, new Date().toISOString());
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const evidence = { kind: "commit" as const, uri: "git:abc123", description: "Entrega verificada" };

  it("closes a draft task through every gate in one call and replays idempotently", () => {
    const task = item("task", "Entregar", storyId);
    const input = { projectId, principalId, requestId: "accept-1", itemIdOrKey: task.key, reason: "Aceite retroativo", estimateHours: 3, evidence };
    const receipt = acceptTask(database, input);
    assert.equal(receipt.value.state, "done");
    assert.deepEqual(receipt.value.steps, ["assign", "estimate", "ready", "start", "evidence", "session", "in_review", "in_validation", "done"]);
    assert.equal(getWorkItem(database, projectId, principalId, task.id).state, "done");
    const again = acceptTask(database, input);
    assert.equal(again.value.alreadyDone, true);
    assert.equal(again.value.steps.length, 0);
  });

  it("rolls everything back when a gate fails", () => {
    database.prepare("UPDATE work_items SET state = 'draft' WHERE project_id = ? AND item_id = ?").run(projectId, storyId);
    const task = item("task", "Bloqueada", storyId);
    assert.throws(
      () => acceptTask(database, { projectId, principalId, requestId: "accept-2", itemIdOrKey: task.key, reason: "Aceite", estimateHours: 2, evidence }),
      (error: unknown) => error instanceof ApplicationError,
    );
    const after = getWorkItem(database, projectId, principalId, task.id);
    assert.equal(after.state, "draft");
    assert.equal(after.assigneeId, null);
    assert.equal(after.estimates.length, 0);
  });

  it("requires estimateHours when no estimate exists and rejects non-tasks", () => {
    const task = item("task", "Sem estimativa", storyId);
    assert.throws(() => acceptTask(database, { projectId, principalId, requestId: "accept-3", itemIdOrKey: task.key, reason: "Aceite", evidence }), /estimateHours/);
    assert.throws(() => acceptTask(database, { projectId, principalId, requestId: "accept-4", itemIdOrKey: storyId, reason: "Aceite", estimateHours: 1, evidence }), /Only task/);
  });

  function item(type: "epic" | "feature" | "story" | "task", title: string, parentId?: string) {
    const description = type === "task" ? `Entregar ${title} com saída verificável.` : undefined;
    return createWorkItem(database, {
      projectId, principalId, requestId: `acc-create-${randomUUID()}`, type, title, ...(parentId === undefined ? {} : { parentId }), ...(description === undefined ? {} : { description }),
    }).value;
  }
});
