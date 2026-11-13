import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assignWorkItem } from "../../src/application/work-item-commands.js";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createDashboardApiServer, listenDashboardApiServer } from "../../src/dashboard/api.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";

test("dashboard exposes authenticated workflow history, editing, publication and weighted progress", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-dashboard-task-workflow-"));
  const initialized = initializeProject({ workspace, key: "PAY", name: "Payments", productGoal: "Pagamentos confiáveis", timezone: "UTC" });
  const projectId = initialized.project.id;
  const database = openSqliteDatabase(initialized.databasePath);
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
  const task = create("task", "Validar autorização", story.id, "Validar autorização e registrar o resultado.");
  assignWorkItem(database, {
    projectId, principalId, requestId: randomUUID(), itemIdOrKey: task.id,
    assigneeId: principalId, expectedVersion: task.version,
  });
  const now = new Date().toISOString();
  database.prepare("UPDATE work_items SET state = 'ready' WHERE project_id = ? AND item_id = ?").run(projectId, story.id);
  database.prepare(
    `INSERT INTO work_baselines (baseline_id, project_id, item_id, sequence, kind, reason, created_by_principal_id, created_at)
     VALUES (?, ?, ?, 1, 'ready', 'Dashboard workflow fixture baseline', ?, ?)`,
  ).run(randomUUID(), projectId, story.id, principalId, now);
  database.prepare("UPDATE work_items SET state = 'ready' WHERE project_id = ? AND item_id = ?").run(projectId, task.id);
  database.close();

  const dashboard = createDashboardApiServer(workspace);
  const address = await listenDashboardApiServer(dashboard, 0);
  context.after(async () => {
    await dashboard.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const claimResponse = await fetch(`${address.origin}/?token=${encodeURIComponent(dashboard.bootstrapToken)}`);
  assert.equal(claimResponse.status, 200);
  const cookie = claimResponse.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const sessionResponse = await fetch(`${address.origin}/api/v1/session`, { headers: { Cookie: cookie, Origin: address.origin } });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json() as { csrfToken: string };
  const headers = { Cookie: cookie, Origin: address.origin, "X-SSDD-CSRF": session.csrfToken, "Content-Type": "application/json" };
  const post = (path: string, body: unknown, requestHeaders = headers) => fetch(`${address.origin}${path}`, {
    method: "POST", headers: requestHeaders, body: JSON.stringify(body),
  });
  const base = `/api/v1/projects/${projectId}/work-items/${task.key}/task-workflow`;

  const unauthenticatedMutation = await fetch(`${address.origin}${base}/revisions`, {
    method: "POST", headers: { Origin: address.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "dashboard-workflow-no-session", expectedTaskVersion: 1, expectedWorkflowVersion: 0, steps: [], reason: "Sem sessão." }),
  });
  assert.equal(unauthenticatedMutation.status, 401);

  const proposal = await post(`${base}/revisions`, {
    requestId: "dashboard-workflow-propose", expectedTaskVersion: task.version + 1, expectedWorkflowVersion: 0,
    steps: [
      { title: "Implementar regra", description: "Aplicar a regra de autorização e cobrir os testes unitários.", effortPercent: 65 },
      { title: "Validar integração", description: "Executar a validação da integração e conferir o resultado.", effortPercent: 35 },
    ], reason: "Separar implementação e verificação.",
  });
  assert.equal(proposal.status, 200);
  const draft = (await proposal.json()) as { workflow: { revisionNumber: number; taskVersion?: number } };
  const readDraft = await fetch(`${address.origin}${base}`, { headers: { Cookie: cookie, Origin: address.origin } });
  assert.equal(readDraft.status, 200);
  const view = (await readDraft.json()) as { workflow: { workflow: null; draft: { revisionNumber: number }; revisionHistory: Array<{ status: string }> } };
  assert.equal(view.workflow.workflow, null);
  assert.equal(view.workflow.draft.revisionNumber, draft.workflow.revisionNumber);
  assert.equal(view.workflow.revisionHistory[0]?.status, "draft");

  const beforePublishResponse = await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${task.key}`,
    { headers: { Cookie: cookie, Origin: address.origin } });
  const beforePublish = (await beforePublishResponse.json()) as { workItem: { version: number } };
  const publish = await post(`${base}/revisions/${draft.workflow.revisionNumber}/publish`, {
    requestId: "dashboard-workflow-publish", expectedTaskVersion: beforePublish.workItem.version,
    reason: "Tech Lead humano aprovou a decomposição.",
  });
  assert.equal(publish.status, 200);
  const published = (await publish.json()) as { workflow: { progressPercent: number; steps: Array<{ id: string }> } };
  assert.equal(published.workflow.progressPercent, 0);

  const ready = await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${task.key}/start-readiness`,
    { headers: { Cookie: cookie, Origin: address.origin } });
  assert.equal(((await ready.json()) as { readiness: { canStart: boolean } }).readiness.canStart, true);
  const currentAfterPublish = await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${task.key}`,
    { headers: { Cookie: cookie, Origin: address.origin } });
  const taskAfterPublish = (await currentAfterPublish.json()) as { workItem: { version: number } };
  const startedResponse = await post(`/api/v1/projects/${projectId}/work-items/${task.key}/start`, {
    requestId: "dashboard-workflow-start", expectedVersion: taskAfterPublish.workItem.version,
    reason: "Iniciar sessão sobre a revisão de workflow publicada.",
  });
  assert.equal(startedResponse.status, 200);
  const started = (await startedResponse.json()) as { task: { version: number }; session: { taskWorkflowRevisionNumber: number } };
  assert.equal(started.session.taskWorkflowRevisionNumber, draft.workflow.revisionNumber);

  const firstStepId = published.workflow.steps[0]!.id;
  const stepStarted = await post(`${base}/steps/${firstStepId}/status`, {
    requestId: "dashboard-workflow-step-start", revisionNumber: draft.workflow.revisionNumber,
    expectedTaskVersion: started.task.version, targetStatus: "in_progress", reason: "Iniciar etapa no dashboard.",
  });
  assert.equal(stepStarted.status, 200);
  const startedStepTransition = (await stepStarted.json()) as { transition: { taskVersion: number; progressPercent: number } };
  assert.equal(startedStepTransition.transition.progressPercent, 0);
  const stepResult = await post(`${base}/steps/${firstStepId}/status`, {
    requestId: "dashboard-workflow-step-done", revisionNumber: draft.workflow.revisionNumber,
    expectedTaskVersion: startedStepTransition.transition.taskVersion, targetStatus: "done", reason: "Etapa validada no dashboard.",
  });
  assert.equal(stepResult.status, 200);
  assert.equal(((await stepResult.json()) as { transition: { progressPercent: number } }).transition.progressPercent, 65);

  const taskList = await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items?type=task&parentId=${story.id}`,
    { headers: { Cookie: cookie, Origin: address.origin } });
  assert.equal(taskList.status, 200);
  const listed = (await taskList.json()) as { items: Array<{ taskWorkflowRevisionNumber: number; taskWorkflowProgressPercent: number; taskWorkflowCompletedSteps: number }> };
  assert.equal(listed.items[0]?.taskWorkflowRevisionNumber, draft.workflow.revisionNumber);
  assert.equal(listed.items[0]?.taskWorkflowProgressPercent, 65);
  assert.equal(listed.items[0]?.taskWorkflowCompletedSteps, 1);

  const workflowScript = await fetch(`${address.origin}/js/task-workflow.js`);
  assert.match(await workflowScript.text(), /workflowEditorRow/u);
});
