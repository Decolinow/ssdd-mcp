import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { applyItemTemplate, listItemTemplates, setItemTemplate } from "../../src/application/item-templates.js";
import { getTaskWorkflow } from "../../src/application/task-workflow-queries.js";
import { listWorkItemRevisions } from "../../src/application/work-item-queries.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("item and workflow templates (SSDD-949)", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let taskId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-templates-"));
    const initialized = initializeProject({ workspace, key: "TP", name: "Templates", productGoal: "Modelar", timezone: "UTC" });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?").get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    const make = (type: "epic" | "feature" | "story" | "task", title: string, extra: Record<string, unknown> = {}) =>
      createWorkItem(database, { projectId, principalId, requestId: `create-${title}`, type, title, ...extra } as Parameters<typeof createWorkItem>[1]).value;
    const epic = make("epic", "Epic");
    const feature = make("feature", "Feature", { parentId: epic.id });
    const story = make("story", "Story", { parentId: feature.id, criteria: [{ description: "Pedido confirmado" }] });
    taskId = make("task", "Tarefa", { parentId: story.id, description: "Entrega" }).id;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const define = (requestId: string, expectedRevision: number, extra: { steps?: Array<{ title: string; description: string; effortPercent: number }> } = {}) => setItemTemplate(database, {
    projectId, principalId, requestId, key: "endpoint", name: "Novo endpoint", expectedRevision, reason: "Modelo para endpoints HTTP",
    checklist: ["Contrato documentado", "Teste de integração"],
    steps: extra.steps ?? [
      { title: "Implementar", description: "Escrever o handler.", effortPercent: 60 },
      { title: "Testar", description: "Cobrir erros e sucesso.", effortPercent: 40 },
    ],
  });

  it("versions templates and validates effort, conflicts and empty content", () => {
    assert.equal(define("t1", 0).value.template.revisionNumber, 1);
    assert.equal(define("t2", 1).value.template.revisionNumber, 2);
    assert.throws(() => define("stale", 1), (error: unknown) => error instanceof ApplicationError && error.code === "VERSION_CONFLICT");
    assert.throws(() => define("bad-effort", 2, { steps: [{ title: "Só", description: "x", effortPercent: 50 }] }), (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED");
    assert.deepEqual(listItemTemplates(database, { projectId, principalId }).templates.map((template) => [template.key, template.revisionNumber]), [["endpoint", 2]]);
    assert.equal(listItemTemplates(database, { projectId, principalId, key: "ENDPOINT" }).templates.length, 2);
    assert.throws(() => database.prepare("UPDATE item_template_revisions SET name = 'x'").run(), /immutable/);
  });

  it("applies a template as Drafts of the checklist and the weighted workflow, idempotently", () => {
    define("t1", 0);
    const first = applyItemTemplate(database, { projectId, principalId, requestId: "apply-1", taskIdOrKey: taskId, templateKey: "endpoint" });
    assert.equal(first.value.checklistDraftRevision, 2);
    assert.equal(first.value.workflowDraftRevision, 1);
    const replay = applyItemTemplate(database, { projectId, principalId, requestId: "apply-1", taskIdOrKey: taskId, templateKey: "endpoint" });
    assert.deepEqual(replay.value, first.value);
    const revisions = listWorkItemRevisions(database, projectId, principalId, taskId);
    assert.deepEqual(revisions.at(-1)?.snapshot.criteria.map((criterion) => criterion.description), ["Contrato documentado", "Teste de integração"]);
    assert.equal(getTaskWorkflow(database, { projectId, principalId, taskIdOrKey: taskId }).draft?.steps.length, 2);
    assert.throws(() => applyItemTemplate(database, { projectId, principalId, requestId: "apply-missing", taskIdOrKey: taskId, templateKey: "nao-existe" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "NOT_FOUND");
  });
});
