import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { assignWorkItem } from "../../src/application/work-item-commands.js";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";

test("MCP proposes, publishes, pins and tracks a weighted task workflow", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-task-workflow-stdio-"));
  const initialized = initializeProject({ workspace, key: "PAY", name: "Payments", productGoal: "Pagamentos confiáveis", timezone: "UTC" });
  const database = openSqliteDatabase(initialized.databasePath);
  applyMigrations(database);
  const projectId = initialized.project.id;
  const principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
    .get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
  const create = (type: "epic" | "feature" | "story" | "task", title: string, parentId?: string, description?: string) => createWorkItem(database, {
    projectId, principalId, requestId: randomUUID(), type, title,
    ...(parentId === undefined ? {} : { parentId }),
    ...(description === undefined ? {} : { description }),
  }).value;
  const epic = create("epic", "Pagamentos");
  const feature = create("feature", "Checkout", epic.id);
  const story = create("story", "Confirmar pedido", feature.id);
  const task = create("task", "Validar autorização", story.id, "Validar a autorização do pagamento e gravar auditoria.");
  const assigned = assignWorkItem(database, {
    projectId, principalId, requestId: randomUUID(), itemIdOrKey: task.id,
    assigneeId: principalId, expectedVersion: task.version,
  }).value;
  const now = new Date().toISOString();
  database.prepare("UPDATE work_items SET state = 'ready' WHERE project_id = ? AND item_id = ?").run(projectId, story.id);
  database.prepare(
    `INSERT INTO work_baselines (baseline_id, project_id, item_id, sequence, kind, reason, created_by_principal_id, created_at)
     VALUES (?, ?, ?, 1, 'ready', 'MCP workflow test baseline', ?, ?)`,
  ).run(randomUUID(), projectId, story.id, principalId, now);
  database.prepare("UPDATE work_items SET state = 'ready' WHERE project_id = ? AND item_id = ?").run(projectId, task.id);
  database.close();

  const client = new Client({ name: "ssdd-task-workflow-stdio-tests", version: "0.2.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../src/cli.js", import.meta.url)), "stdio", "--workspace", workspace],
    stderr: "ignore",
  });
  context.after(async () => {
    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  await client.connect(transport);

  const catalog = await client.listTools();
  const workflowTools = catalog.tools.map((tool) => tool.name).filter((name) => name.startsWith("task_workflow_"));
  assert.deepEqual(workflowTools.sort(), ["task_workflow_get", "task_workflow_propose", "task_workflow_publish", "task_workflow_step_transition"].sort());
  const draftResult = await client.callTool({ name: "task_workflow_propose", arguments: {
    projectId, requestId: "mcp-workflow-propose", taskIdOrKey: task.key,
    expectedTaskVersion: assigned.version, expectedWorkflowVersion: 0,
    steps: [
      { title: "Implementar autorização", description: "Adicionar a regra de autorização e cobertura unitária.", effortPercent: 70 },
      { title: "Validar integração", description: "Verificar integração e registrar o resultado esperado.", effortPercent: 30 },
    ], reason: "Decompor o esforço em resultados verificáveis.",
  } });
  assert.notEqual(draftResult.isError, true);
  const draft = (draftResult.structuredContent as { workflow: { revisionNumber: number; status: string; steps: Array<{ id: string }> } }).workflow;
  assert.equal(draft.status, "draft");
  const draftView = await client.callTool({ name: "task_workflow_get", arguments: { projectId, taskIdOrKey: task.key } });
  assert.notEqual(draftView.isError, true);
  assert.equal((draftView.structuredContent as { selectedRevisionNumber: number; revisionHistory: Array<{ status: string }> }).selectedRevisionNumber, draft.revisionNumber);
  assert.equal((draftView.structuredContent as { revisionHistory: Array<{ status: string }> }).revisionHistory[0]?.status, "draft");

  const publishResult = await client.callTool({ name: "task_workflow_publish", arguments: {
    projectId, requestId: "mcp-workflow-publish", taskIdOrKey: task.key,
    revisionNumber: draft.revisionNumber, expectedTaskVersion: assigned.version + 1,
    reason: "Tech Lead humano publica o plano revisado.",
  } });
  assert.notEqual(publishResult.isError, true);
  const published = (publishResult.structuredContent as { workflow: { revisionNumber: number; progressPercent: number } }).workflow;
  assert.equal(published.progressPercent, 0);

  const startResult = await client.callTool({ name: "task_start", arguments: {
    projectId, requestId: "mcp-workflow-task-start", taskIdOrKey: task.key,
    expectedVersion: assigned.version + 2, reason: "Iniciar a tarefa com a revisão publicada.",
  } });
  assert.notEqual(startResult.isError, true);
  const started = startResult.structuredContent as { task: { version: number }; session: { taskWorkflowRevisionNumber: number } };
  assert.equal(started.session.taskWorkflowRevisionNumber, published.revisionNumber);

  const skippedStep = await client.callTool({ name: "task_workflow_step_transition", arguments: {
    projectId, requestId: "mcp-workflow-step-skip-start", taskIdOrKey: task.key,
    revisionNumber: published.revisionNumber, stepId: draft.steps[0]!.id,
    expectedTaskVersion: started.task.version, targetStatus: "done", reason: "Não pode pular início explícito.",
  } });
  assert.equal(skippedStep.isError, true);
  assert.match(skippedStep.content[0]?.type === "text" ? skippedStep.content[0].text : "", /INVALID_TRANSITION/u);

  const firstStep = await client.callTool({ name: "task_workflow_step_transition", arguments: {
    projectId, requestId: "mcp-workflow-step-progress", taskIdOrKey: task.key,
    revisionNumber: published.revisionNumber, stepId: draft.steps[0]!.id,
    expectedTaskVersion: started.task.version, targetStatus: "in_progress", reason: "Etapa de implementação iniciada.",
  } });
  assert.notEqual(firstStep.isError, true);
  assert.equal((firstStep.structuredContent as { transition: { progressPercent: number } }).transition.progressPercent, 0);
  const completedStep = await client.callTool({ name: "task_workflow_step_transition", arguments: {
    projectId, requestId: "mcp-workflow-step-done", taskIdOrKey: task.key,
    revisionNumber: published.revisionNumber, stepId: draft.steps[0]!.id,
    expectedTaskVersion: (firstStep.structuredContent as { transition: { taskVersion: number } }).transition.taskVersion,
    targetStatus: "done", reason: "A regra e os testes foram concluídos.",
  } });
  assert.notEqual(completedStep.isError, true);
  assert.equal((completedStep.structuredContent as { transition: { progressPercent: number } }).transition.progressPercent, 70);

  const listed = await client.callTool({ name: "work_item_list", arguments: { projectId, types: ["task"], parentId: story.id } });
  assert.notEqual(listed.isError, true);
  const listedTask = (listed.structuredContent as { items: Array<{ taskWorkflowRevisionNumber: number; taskWorkflowProgressPercent: number; taskWorkflowCompletedSteps: number }> }).items[0];
  assert.equal(listedTask?.taskWorkflowRevisionNumber, published.revisionNumber);
  assert.equal(listedTask?.taskWorkflowProgressPercent, 70);
  assert.equal(listedTask?.taskWorkflowCompletedSteps, 1);

  const gate = await client.callTool({ name: "work_item_gate_check", arguments: { projectId, itemIdOrKey: task.key, targetState: "done" } });
  assert.notEqual(gate.isError, true);
  const workflowGate = (gate.structuredContent as { gates: Array<{ id: string; passed: boolean }> }).gates.find((entry) => entry.id === "task-workflow-complete");
  assert.equal(workflowGate?.passed, false);
});
