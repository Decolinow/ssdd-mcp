import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { getTaskBriefing } from "../../src/application/task-briefing.js";
import { openQuestion } from "../../src/application/work-item-questions.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("task briefing in one call (SSDD-945)", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let taskId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-briefing-"));
    const initialized = initializeProject({ workspace, key: "BR", name: "Briefing", productGoal: "Briefar", timezone: "UTC" });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?").get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    const make = (type: "epic" | "feature" | "story" | "task", title: string, extra: Record<string, unknown> = {}) =>
      createWorkItem(database, { projectId, principalId, requestId: `create-${title}`, type, title, ...extra } as Parameters<typeof createWorkItem>[1]).value;
    const epic = make("epic", "Epic");
    const feature = make("feature", "Feature", { parentId: epic.id });
    const story = make("story", "Story", { parentId: feature.id, criteria: [{ description: "O Carrinho aceita cupom" }] });
    taskId = make("task", "Tarefa", { parentId: story.id, description: "Implementar o cupom" }).id;
    database.prepare(
      `INSERT INTO specifications (spec_id, project_id, spec_key, kind, title, created_by_principal_id, created_at)
       VALUES ('g1', ?, 'GLOSS-CART', 'glossary', 'Carrinho', ?, '2026-01-01T00:00:00.000Z')`,
    ).run(projectId, principalId);
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("gathers context, gates, questions and glossary terms and recommends the next action", () => {
    const first = getTaskBriefing(database, { projectId, principalId, taskIdOrKey: taskId });
    assert.equal(first.context.task.id, taskId);
    assert.deepEqual(first.glossaryTerms, [{ key: "GLOSS-CART", title: "Carrinho" }]);
    assert.equal(first.startReadiness.canStart, false);
    assert.match(first.nextAction, /bloqueio de início/u);
    assert.equal(first.workflow.published, false);

    openQuestion(database, { projectId, principalId, requestId: "bq", itemIdOrKey: taskId, text: "Cupom acumula?", blocking: true });
    const second = getTaskBriefing(database, { projectId, principalId, taskIdOrKey: taskId });
    assert.deepEqual(second.openQuestions.map((question) => question.key), ["Q-1"]);
    assert.match(second.nextAction, /Q-1/u);
    assert.ok(second.context.warnings.some((warning) => warning.code === "BLOCKING_QUESTION_OPEN"));
  });
});
