import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ensureBootstrapAdministrator, createManagedUser, revokeManagedUserAuthKeys } from "../../src/application/user-management.js";
import { confirmWorkItemEstimate, proposeWorkItemEstimate } from "../../src/application/work-item-commands.js";
import { getWorkItem } from "../../src/application/work-item-queries.js";
import { setDefinitionOfDone } from "../../src/application/definition-of-done.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createMilestone } from "../../src/application/milestones.js";
import { createScenario, publishScenarioRevision } from "../../src/application/scenario-commands.js";
import {
  createSpecification,
  proposeSpecificationRevision,
  publishSpecificationRevision,
} from "../../src/application/specification-commands.js";
import { setSprintRetrospective } from "../../src/application/sprint-retrospectives.js";
import { setTeamCapacityConfiguration } from "../../src/application/team-capacity.js";
import { addTraceLink } from "../../src/application/trace-commands.js";
import { transitionWorkItem } from "../../src/application/work-item-workflow.js";
import { createDashboardApiServer, listenDashboardApiServer } from "../../src/dashboard/api.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";

test("dashboard API sessions and project authorization match MCP access", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-dashboard-api-"));
  const initialized = initializeProject({
    workspace,
    key: "PAY",
    name: "Payments",
    productGoal: "Pagamentos confiáveis",
    timezone: "America/Sao_Paulo",
  });
  const projectId = initialized.project.id;
  const database = openSqliteDatabase(initialized.databasePath);
  const principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
    .get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
  ensureBootstrapAdministrator(database, principalId);
  const dashboardUser = createManagedUser(database, {
    actorPrincipalId: principalId,
    requestId: "dashboard-login-user",
    displayName: "Dashboard Login Developer",
    principalType: "human",
    projects: [{ projectId, roles: ["developer"] }],
    reason: "Validar login autenticado do dashboard.",
  });
  assert.ok(dashboardUser.authKey);
  const taskDeveloper = createManagedUser(database, {
    actorPrincipalId: principalId,
    requestId: "dashboard-task-developer",
    displayName: "Dashboard Task Developer",
    principalType: "human",
    projects: [{ projectId, roles: ["developer"] }],
    reason: "Validar início de tarefa pelo responsável autenticado.",
  });
  assert.ok(taskDeveloper.authKey);
  const restrictedProjectId = randomUUID();
  database.prepare(
    `INSERT INTO projects
      (project_id, project_key, name, product_goal, timezone, created_at, created_by_principal_id)
     VALUES (?, 'HIDDEN', 'Restricted project', 'No membership is granted', 'UTC', ?, ?)`,
  ).run(restrictedProjectId, new Date().toISOString(), principalId);
  const epic = createWorkItem(database, {
    projectId,
    principalId,
    requestId: randomUUID(),
    type: "epic",
    title: "Payments",
  }).value;
  const feature = createWorkItem(database, {
    projectId,
    principalId,
    requestId: randomUUID(),
    type: "feature",
    parentId: epic.id,
    title: "Checkout",
  }).value;
  const story = createWorkItem(database, {
    projectId,
    principalId,
    requestId: randomUUID(),
    type: "story",
    parentId: feature.id,
    title: "Confirm the purchase",
  }).value;
  const task = createWorkItem(database, {
    projectId,
    principalId,
    requestId: randomUUID(),
    type: "task",
    parentId: story.id,
    title: "Implement purchase confirmation",
    description: "Persist the purchase confirmation result.",
  }).value;
  const claimableTask = createWorkItem(database, {
    projectId,
    principalId,
    requestId: randomUUID(),
    type: "task",
    parentId: story.id,
    title: "Add purchase confirmation audit event",
    description: "Record the confirmation in the purchase audit log.",
  }).value;
  const gatedTask = createWorkItem(database, {
    projectId,
    principalId,
    requestId: randomUUID(),
    type: "task",
    parentId: story.id,
    title: "Task missing its expected output",
  }).value;
  const draftSpecification = createSpecification(database, {
    projectId,
    principalId,
    requestId: "dashboard-draft-specification",
    key: "PAY-ADR-DRAFT",
    kind: "adr",
    title: "Unpublished payment decision",
    content: { decision: "DRAFT_DECISION_MUST_NOT_BE_EXPOSED" },
  }).value;
  createSpecification(database, {
    projectId,
    principalId,
    requestId: "dashboard-historical-specification",
    key: "PAY-ADR-HISTORY",
    kind: "adr",
    title: "Replaced payment decision",
    content: { decision: "FIRST_PUBLISHED_DECISION" },
  });
  publishSpecificationRevision(database, {
    projectId,
    principalId,
    requestId: "dashboard-historical-specification-publish-1",
    specIdOrKey: "PAY-ADR-HISTORY",
    revisionNumber: 1,
    expectedVersion: 1,
  });
  proposeSpecificationRevision(database, {
    projectId,
    principalId,
    requestId: "dashboard-historical-specification-revision",
    specIdOrKey: "PAY-ADR-HISTORY",
    expectedVersion: 2,
    content: { decision: "CURRENT_PUBLISHED_DECISION" },
  });
  publishSpecificationRevision(database, {
    projectId,
    principalId,
    requestId: "dashboard-historical-specification-publish-2",
    specIdOrKey: "PAY-ADR-HISTORY",
    revisionNumber: 2,
    expectedVersion: 3,
  });
  const draftSpecificationLink = addTraceLink(database, {
    projectId,
    principalId,
    requestId: "dashboard-draft-specification-link",
    sourceIdOrKey: task.id,
    targetIdOrKey: draftSpecification.specId,
    type: "relates_to",
  }).value;
  const capacity = setTeamCapacityConfiguration(database, {
    projectId,
    principalId,
    requestId: "dashboard-retro-capacity",
    expectedVersion: 0,
    teamName: "Payments team",
    timezone: "America/Sao_Paulo",
    hoursPerDay: 6,
    workingDays: [1, 2, 3, 4, 5],
    members: [{ principalId, dedicationPercent: 100 }],
    reason: "Configurar capacidade para a sprint de teste.",
  }).value;
  const definition = setDefinitionOfDone(database, {
    projectId,
    principalId,
    requestId: "dashboard-retro-dod",
    expectedVersion: 0,
    criteria: [{ description: "Entrega revisada e documentada." }],
    reason: "Configurar DoD para a sprint de teste.",
  }).value;
  const metricStory = createWorkItem(database, {
    projectId,
    principalId,
    requestId: "dashboard-metric-story",
    type: "story",
    parentId: feature.id,
    title: "Expose dashboard metrics",
    description: "Publish metrics linked to the project history.",
    criteria: [{ description: "Drill-down totals match the selected series." }],
  }).value;
  const metricScenario = createScenario(database, {
    projectId,
    principalId,
    requestId: "dashboard-metric-scenario",
    key: "PAY-TC-METRICS",
    kind: "acceptance",
    title: "Validate metrics drill-down",
    steps: [{ action: "Open the dashboard", expected: "Metric totals match the listed PBI." }],
    coverage: [{ targetType: "criterion", reference: metricStory.criteria[0]!.id }],
  }).value;
  publishScenarioRevision(database, {
    projectId,
    principalId,
    requestId: "dashboard-metric-scenario-publish",
    scenarioIdOrKey: metricScenario.scenarioId,
    revisionNumber: 1,
    expectedVersion: 1,
  });
  const estimate = proposeWorkItemEstimate(database, {
    projectId,
    principalId,
    requestId: "dashboard-metric-estimate",
    itemIdOrKey: metricStory.id,
    unit: "points",
    value: 5,
    rationale: "Fixar a estimativa usada no drill-down.",
    expectedVersion: metricStory.version,
  }).value;
  const metricStoryAfterProposal = getWorkItem(database, projectId, principalId, metricStory.id);
  confirmWorkItemEstimate(database, {
    projectId,
    principalId,
    requestId: "dashboard-metric-estimate-confirm",
    itemIdOrKey: metricStory.id,
    proposalId: estimate.id,
    expectedVersion: metricStoryAfterProposal.version,
  });
  const metricStoryAfterEstimate = getWorkItem(database, projectId, principalId, metricStory.id);
  transitionWorkItem(database, {
    projectId,
    principalId,
    requestId: "dashboard-metric-ready",
    itemIdOrKey: metricStory.id,
    targetState: "ready",
    expectedVersion: metricStoryAfterEstimate.version,
    reason: "Validar a projeção auditável no dashboard.",
  });
  const metricMilestone = createMilestone(database, {
    projectId,
    principalId,
    requestId: "dashboard-metric-milestone",
    milestoneKey: "PAY-METRICS",
    title: "Dashboard metrics",
    goal: "Reconcile indicators with approved PBI scope.",
    targetDate: addDays(projectToday(), 30),
    itemIdsOrKeys: [metricStory.id],
    reason: "Fixar o escopo da visão de métricas.",
  }).value;
  const sprintId = randomUUID();
  const sprintCreatedAt = new Date().toISOString();
  const sprintClosedAt = new Date().toISOString();
  database.prepare(
    `INSERT INTO sprints
      (sprint_id, project_id, sprint_key, title, goal, starts_on, ends_on, status, team_id,
       capacity_config_version, dod_revision_number, version, created_by_principal_id, created_at,
       closed_at, reason, review_summary)
     VALUES (?, ?, 'PAY-CLOSED', 'Closed test sprint', 'Exercise retrospective reading',
       '2026-11-02', '2026-11-06', 'closed', ?, ?, ?, 1, ?, ?, ?, 'Test close', 'Review saved')`,
  ).run(
    sprintId, projectId, capacity.teamId, capacity.version, definition.revisionNumber,
    principalId, sprintCreatedAt, sprintClosedAt,
  );
  setSprintRetrospective(database, {
    projectId,
    principalId,
    requestId: "dashboard-retro-record",
    sprintIdOrKey: sprintId,
    expectedVersion: 0,
    summary: "A equipe compartilhou os aprendizados do ciclo.",
    keepDoing: ["Revisar os riscos diariamente."],
    stopDoing: [],
    tryNext: ["Validar dependências cedo."],
    actions: [{ title: "Revisar dependências", ownerPrincipalId: principalId, linkedWorkItemIdOrKey: story.id }],
    reason: "Registrar acordo da equipe de teste.",
  });
  const parentBaselineId = randomUUID();
  const baselineCreatedAt = new Date().toISOString();
  database.prepare("UPDATE work_items SET state = 'in_progress', version = version + 1 WHERE project_id = ? AND item_id = ?")
    .run(projectId, story.id);
  database.prepare(
    `INSERT INTO work_baselines (baseline_id, project_id, item_id, sequence, kind, reason, created_by_principal_id, created_at)
     VALUES (?, ?, ?, 1, 'ready', 'Dashboard task-start fixture baseline', ?, ?)`,
  ).run(parentBaselineId, projectId, story.id, principalId, baselineCreatedAt);
  database.prepare("UPDATE work_items SET state = 'ready', assignee_principal_id = ?, version = version + 1 WHERE project_id = ? AND item_id = ?")
    .run(taskDeveloper.principalId, projectId, task.id);
  database.prepare("UPDATE work_items SET state = 'ready', version = version + 1 WHERE project_id = ? AND item_id IN (?, ?)")
    .run(projectId, claimableTask.id, gatedTask.id);
  database.close();

  const dashboard = createDashboardApiServer(workspace);
  const address = await listenDashboardApiServer(dashboard, 0);
  const client = new Client({ name: "ssdd-dashboard-parity-test", version: "0.1.0" });
  const cliPath = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "stdio", "--workspace", workspace],
    stderr: "ignore",
  });

  context.after(async () => {
    await client.close();
    await dashboard.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const unauthenticated = await fetch(`${address.origin}/api/v1/projects`);
  assert.equal(unauthenticated.status, 401);
  assert.equal(((await unauthenticated.json()) as { code: string }).code, "SESSION_REQUIRED");

  const landingPage = await fetch(`${address.origin}/`);
  assert.equal(landingPage.status, 200);
  assert.match(landingPage.headers.get("content-type") ?? "", /text\/html/u);
  const dashboardHtml = await landingPage.text();
  assert.match(dashboardHtml, /Product Backlog/u);
  assert.match(dashboardHtml, /quick-access-view/u);
  assert.match(dashboardHtml, /id="home-tab"[^>]*aria-selected="true"/u);
  assert.match(dashboardHtml, /A seleção muda a visão\. Suas permissões permanecem as mesmas\./u);
  assert.match(dashboardHtml, /Retrato do projeto em uma data/u);
  assert.match(dashboardHtml, /Criar rascunho/u);
  assert.match(dashboardHtml, /Registrar execução/u);
  assert.match(dashboardHtml, /AuthKey do MCP/u);
  assert.match(dashboardHtml, /login-form/u);
  assert.match(dashboardHtml, /method="post" action="\/api\/v1\/session\/login"/u);
  assert.match(dashboardHtml, /autocomplete="off"/u);
  const dashboardIds = [...dashboardHtml.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]!);
  assert.equal(new Set(dashboardIds).size, dashboardIds.length, "dashboard element IDs must be unique");
  const dashboardIdSet = new Set(dashboardIds);
  for (const match of dashboardHtml.matchAll(/<label\b[^>]*\bfor="([^"]+)"/gu)) {
    assert.ok(dashboardIdSet.has(match[1]!), `label target ${match[1]} must exist`);
  }
  assert.match(dashboardHtml, /metrics-effort-from/u);
  assert.match(dashboardHtml, /metrics-effort-to/u);
  assert.match(dashboardHtml, /metrics-developer/u);
  assert.match(dashboardHtml, /first-use-guidance/u);
  assert.match(dashboardHtml, /Especificações/u);
  assert.match(dashboardHtml, /specifications-view/u);
  assert.match(dashboardHtml, /id="specification-kind"/u);
  assert.match(dashboardHtml, /id="specification-search"/u);
  assert.match(dashboardHtml, /id="create-specification"/u);
  assert.match(dashboardHtml, /id="specification-form-dialog"/u);
  const dashboardScript = await fetch(`${address.origin}/dashboard.js`);
  assert.equal(dashboardScript.status, 200);
  assert.match(dashboardScript.headers.get("content-type") ?? "", /javascript/u);
  const moduleNames = readdirSync(resolve(process.cwd(), "src/dashboard/public/js")).filter((name) => name.endsWith(".js"));
  const served = await Promise.all(moduleNames.map(async (name) => (await fetch(`${address.origin}/js/${name}`)).text()));
  const dashboardJavascript = [await dashboardScript.text(), ...served].join("\n");
  assert.match(dashboardJavascript, /initialize/u);
  for (const listener of ["elements.createWorkItem.addEventListener", "elements.transitionForm.addEventListener", "elements.specificationForm.addEventListener"]) {
    assert.equal(dashboardJavascript.split(listener).length - 1, 1, `${listener} must be registered exactly once across the dashboard modules`);
  }
  const sessionModule = await fetch(`${address.origin}/js/session.js`);
  assert.equal(sessionModule.status, 200);
  assert.match(await sessionModule.text(), /X-SSDD-CSRF/u);
  const historyModule = await fetch(`${address.origin}/js/history.js`);
  assert.match(await historyModule.text(), /loadProjectHistory/u);
  assert.notEqual((await fetch(`${address.origin}/js/..%2fapi.js`)).status, 200);
  assert.match(dashboardJavascript, /submitTestRun/u);
  assert.match(dashboardJavascript, /publishWorkItemRevision/u);
  assert.match(dashboardJavascript, /loadChildTasks/u);
  assert.match(dashboardJavascript, /renderTaskContext/u);
  assert.match(dashboardJavascript, /api\/v1\/session\/login/u);
  assert.match(dashboardJavascript, /api\/v1\/session\/logout/u);
  assert.match(dashboardJavascript, /event\.entityReference/u);
  assert.match(dashboardJavascript, /event\.relatedEntities/u);
  assert.match(dashboardJavascript, /renderSprintComparison/u);
  assert.match(dashboardJavascript, /metrics-velocity-window/u);
  assert.match(dashboardJavascript, /developerMetricsRangeCustomized/u);
  assert.match(dashboardJavascript, /activeHoursOnEstimatedCompletedTasks/u);
  assert.match(dashboardJavascript, /elements\.metricsDate\.value = model\.selectedMetricsDate \?\? data\.asOfDate/u);
  assert.match(dashboardJavascript, /renderFirstUseGuidance/u);
  assert.match(dashboardJavascript, /const homeViewButton = event\.target\.closest\("\[data-home-view\]"\)/u);
  assert.match(dashboardJavascript, /function openSpecification\(key\)/u);
  assert.match(dashboardJavascript, /renderSpecificationValue/u);
  assert.match(dashboardJavascript, /data-open-specification/u);
  assert.match(dashboardJavascript, /Revisão não publicada/u);
  assert.match(dashboardJavascript, /ainda não tem revisão publicada/u);
  assert.match(dashboardJavascript, /Revisão histórica \(substituída\)/u);
  assert.match(dashboardJavascript, /já foi publicada e depois substituída/u);
  assert.match(dashboardJavascript, /Revisão retirada/u);
  assert.match(dashboardJavascript, /Sem publicação vigente/u);
  assert.match(dashboardJavascript, /specification\.latestStatus/u);
  assert.match(dashboardJavascript, /última revisão substituída/u);
  assert.match(dashboardJavascript, /última revisão retirada/u);
  assert.match(dashboardJavascript, /specificationKindLabel\(specification\.kind\)/u);
  assert.match(dashboardJavascript, /function scenarioKindLabel\(kind\)/u);
  assert.match(dashboardJavascript, /scenarioKindLabel\(scenario\.kind\)/u);
  assert.match(dashboardJavascript, /start-readiness/u);
  assert.match(dashboardJavascript, /Iniciar e abrir sessão/u);
  assert.match(dashboardHtml, /Tarefas verificadas/u);
  const dashboardStyles = await fetch(`${address.origin}/dashboard.css`);
  assert.equal(dashboardStyles.status, 200);
  assert.match(dashboardStyles.headers.get("content-type") ?? "", /text\/css/u);

  const invalidLogin = await fetch(`${address.origin}/api/v1/session/login`, {
    method: "POST",
    headers: { Origin: address.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ authKey: "ssdd_invalid" }),
  });
  assert.equal(invalidLogin.status, 401);
  assert.equal(invalidLogin.headers.get("set-cookie"), null);
  const crossOriginLogin = await fetch(`${address.origin}/api/v1/session/login`, {
    method: "POST",
    headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ authKey: dashboardUser.authKey }),
  });
  assert.equal(crossOriginLogin.status, 403);

  const userLogin = await fetch(`${address.origin}/api/v1/session/login`, {
    method: "POST",
    headers: { Origin: address.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ authKey: dashboardUser.authKey }),
  });
  assert.equal(userLogin.status, 200);
  const userCookieHeader = userLogin.headers.get("set-cookie");
  assert.ok(userCookieHeader);
  assert.match(userCookieHeader, /HttpOnly/u);
  assert.match(userCookieHeader, /SameSite=Strict/u);
  const userCookie = userCookieHeader.split(";", 1)[0];
  assert.ok(userCookie);
  const userSession = await userLogin.json() as {
    principal: { id: string; displayName: string };
    projects: Array<{ id: string }>;
    csrfToken: string;
  };
  assert.equal(userSession.principal.id, dashboardUser.principalId);
  assert.equal(userSession.principal.displayName, "Dashboard Login Developer");
  assert.deepEqual(userSession.projects.map((project) => project.id), [projectId]);
  assert.equal(JSON.stringify(userSession).includes(dashboardUser.authKey!), false);
  const userProject = await fetch(`${address.origin}/api/v1/projects/${projectId}`, {
    headers: { Cookie: userCookie, Origin: address.origin },
  });
  assert.equal(userProject.status, 200);
  const forbiddenUserProject = await fetch(`${address.origin}/api/v1/projects/${restrictedProjectId}`, {
    headers: { Cookie: userCookie, Origin: address.origin },
  });
  assert.equal(forbiddenUserProject.status, 403);

  const logout = await fetch(`${address.origin}/api/v1/session/logout`, {
    method: "POST",
    headers: {
      Cookie: userCookie,
      Origin: address.origin,
      "X-SSDD-CSRF": userSession.csrfToken,
    },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  const loggedOutSession = await fetch(`${address.origin}/api/v1/session`, {
    headers: { Cookie: userCookie, Origin: address.origin },
  });
  assert.equal(loggedOutSession.status, 401);

  const secondLogin = await fetch(`${address.origin}/api/v1/session/login`, {
    method: "POST",
    headers: { Origin: address.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ authKey: dashboardUser.authKey }),
  });
  assert.equal(secondLogin.status, 200);
  const secondLoginCookie = secondLogin.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(secondLoginCookie);
  const revokeDatabase = openSqliteDatabase(initialized.databasePath);
  try {
    revokeManagedUserAuthKeys(revokeDatabase, {
      actorPrincipalId: principalId,
      targetPrincipalId: dashboardUser.principalId,
      requestId: "dashboard-login-revoke-key",
      reason: "Validar invalidação imediata de sessões.",
    });
  } finally {
    revokeDatabase.close();
  }
  const revokedSession = await fetch(`${address.origin}/api/v1/session`, {
    headers: { Cookie: secondLoginCookie, Origin: address.origin },
  });
  assert.equal(revokedSession.status, 401);
  assert.equal(((await revokedSession.json()) as { code: string }).code, "SESSION_INVALID");

  const claim = await fetch(`${address.origin}/?token=${encodeURIComponent(dashboard.bootstrapToken)}`);
  assert.equal(claim.status, 200);
  assert.match(await claim.text(), /dashboard\.js/u);
  const setCookie = claim.headers.get("set-cookie");
  assert.ok(setCookie);
  const cookie = setCookie.split(";", 1)[0];
  assert.ok(cookie);

  const session = await fetch(`${address.origin}/api/v1/session`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(session.status, 200);
  const sessionBody = await session.json() as {
    principal: { id: string };
    projects: Array<{ id: string }>;
    csrfToken: string;
  };
  assert.equal(sessionBody.principal.id, principalId);
  assert.deepEqual(sessionBody.projects.map((project) => project.id), [projectId]);
  assert.ok(sessionBody.csrfToken.length >= 32);
  const activityResponse = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/audit?entityType=trace_link&entityId=${draftSpecificationLink.id}`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(activityResponse.status, 200);
  const activityBody = await activityResponse.json() as {
    events: Array<{
      entityReference: { label: string };
      relatedEntities: Array<{ key: string; title: string; label: string }>;
    }>;
  };
  assert.equal(activityBody.events[0]?.entityReference.label, "Vínculo de contexto");
  assert.deepEqual(activityBody.events[0]?.relatedEntities.map(({ key, title }) => ({ key, title })).sort((left, right) => left.key.localeCompare(right.key)), [
    { key: task.key, title: "Implement purchase confirmation" },
    { key: draftSpecification.key, title: "Unpublished payment decision" },
  ].sort((left, right) => left.key.localeCompare(right.key)));
  const postMutation = (path: string, body: unknown) => fetch(`${address.origin}${path}`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: address.origin,
      "X-SSDD-CSRF": sessionBody.csrfToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const taskDeveloperLogin = await fetch(`${address.origin}/api/v1/session/login`, {
    method: "POST",
    headers: { Origin: address.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ authKey: taskDeveloper.authKey }),
  });
  assert.equal(taskDeveloperLogin.status, 200);
  const taskDeveloperCookie = taskDeveloperLogin.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(taskDeveloperCookie);
  const taskDeveloperSession = await taskDeveloperLogin.json() as { csrfToken: string };
  const postAsTaskDeveloper = (path: string, body: unknown) => fetch(`${address.origin}${path}`, {
    method: "POST",
    headers: {
      Cookie: taskDeveloperCookie,
      Origin: address.origin,
      "X-SSDD-CSRF": taskDeveloperSession.csrfToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const quickAccessResponse = await fetch(`${address.origin}/api/v1/projects/${projectId}/quick-access`, {
    headers: { Cookie: taskDeveloperCookie, Origin: address.origin },
  });
  assert.equal(quickAccessResponse.status, 200);
  const quickAccess = await quickAccessResponse.json() as {
    roles: string[];
    developer: {
      startableTasks: Array<{ key: string }>;
      claimableTasks: Array<{ id: string; key: string; version: number }>;
      blockedTasks: Array<{ key: string }>;
    } | null;
  };
  assert.ok(quickAccess.roles.includes("developer"));
  assert.ok(quickAccess.developer);
  assert.ok(quickAccess.developer.claimableTasks.some((candidate) => candidate.id === claimableTask.id));
  assert.ok(!quickAccess.developer.claimableTasks.some((candidate) => candidate.id === gatedTask.id), "tasks with unresolved gates must not be offered for claiming");
  const claimCandidate = quickAccess.developer.claimableTasks.find((candidate) => candidate.id === claimableTask.id)!;
  const claimedTaskResponse = await postAsTaskDeveloper(`/api/v1/projects/${projectId}/work-items/${claimCandidate.key}/claim`, {
    requestId: "dashboard-claimable-task",
    expectedVersion: claimCandidate.version,
    reason: "Assumir pela visão inicial do dashboard.",
  });
  assert.equal(claimedTaskResponse.status, 200);
  const claimedTaskBody = await claimedTaskResponse.json() as { task: { id: string; assigneeId: string; state: string; version: number }; auditEventIds: string[] };
  assert.equal(claimedTaskBody.task.id, claimableTask.id);
  assert.equal(claimedTaskBody.task.assigneeId, taskDeveloper.principalId);
  assert.equal(claimedTaskBody.task.state, "ready");
  assert.equal(claimedTaskBody.task.version, claimCandidate.version + 1);
  assert.ok(claimedTaskBody.auditEventIds.length > 0);
  const taskClaimReplay = await postAsTaskDeveloper(`/api/v1/projects/${projectId}/work-items/${claimCandidate.key}/claim`, {
    requestId: "dashboard-claimable-task",
    expectedVersion: claimCandidate.version,
    reason: "Assumir pela visão inicial do dashboard.",
  });
  assert.equal(taskClaimReplay.status, 200);
  assert.deepEqual(await taskClaimReplay.json(), claimedTaskBody, "replaying a claim must not create a second assignment");
  const blockedClaim = await postAsTaskDeveloper(`/api/v1/projects/${projectId}/work-items/${gatedTask.key}/claim`, {
    requestId: "dashboard-blocked-claim",
    expectedVersion: gatedTask.version + 1,
    reason: "Tentativa para confirmar bloqueio dos gates.",
  });
  assert.equal(blockedClaim.status, 409);
  const blockedClaimError = await blockedClaim.json() as { code: string; retryable: boolean };
  assert.equal(blockedClaimError.code, "TASK_NOT_STARTABLE");
  assert.equal(blockedClaimError.retryable, false);
  const staleClaim = await postAsTaskDeveloper(`/api/v1/projects/${projectId}/work-items/${claimCandidate.key}/claim`, {
    requestId: "dashboard-stale-claim",
    expectedVersion: claimCandidate.version,
    reason: "A versão anterior precisa ser reconciliada.",
  });
  assert.equal(staleClaim.status, 409);
  const staleClaimError = await staleClaim.json() as { code: string; retryable: boolean };
  assert.equal(staleClaimError.code, "VERSION_CONFLICT");
  assert.equal(staleClaimError.retryable, false);
  const alreadyAssignedClaim = await postAsTaskDeveloper(`/api/v1/projects/${projectId}/work-items/${claimCandidate.key}/claim`, {
    requestId: "dashboard-already-assigned-claim",
    expectedVersion: claimedTaskBody.task.version,
    reason: "A tarefa já está atribuída.",
  });
  assert.equal(alreadyAssignedClaim.status, 409);
  assert.equal(((await alreadyAssignedClaim.json()) as { code: string }).code, "TASK_ALREADY_ASSIGNED");
  const startReadiness = await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${task.key}/start-readiness`, {
    headers: { Cookie: taskDeveloperCookie, Origin: address.origin },
  });
  assert.equal(startReadiness.status, 200);
  const startReadinessBody = await startReadiness.json() as { readiness: { canStart: boolean; version: number } };
  assert.equal(startReadinessBody.readiness.canStart, true);
  const bypassStart = await postAsTaskDeveloper(`/api/v1/projects/${projectId}/work-items/${task.key}/transition`, {
    requestId: "dashboard-direct-task-start", targetState: "in_progress",
    expectedVersion: startReadinessBody.readiness.version, reason: "A transição direta deve ser recusada.",
  });
  assert.notEqual(bypassStart.status, 200);
  assert.equal(((await bypassStart.json()) as { code: string }).code, "USE_TASK_START");
  const taskStart = await postAsTaskDeveloper(`/api/v1/projects/${projectId}/work-items/${task.key}/start`, {
    requestId: "dashboard-atomic-task-start", expectedVersion: startReadinessBody.readiness.version,
    reason: "Início via fluxo atômico do dashboard.",
  });
  assert.equal(taskStart.status, 200);
  const taskStartBody = await taskStart.json() as {
    task: { state: string };
    session: { status: string };
    auditEventIds: string[];
  };
  assert.equal(taskStartBody.task.state, "in_progress");
  assert.equal(taskStartBody.session.status, "active");
  assert.ok(taskStartBody.auditEventIds.length >= 3);

  const scenarioCreate = await postMutation(`/api/v1/projects/${projectId}/scenarios`, {
    requestId: "dashboard-task-linked-scenario",
    key: "PAY-TC-TASK",
    kind: "acceptance",
    title: "Verify task implementation",
    steps: [{ action: "Run the task test", expected: "The task behavior passes." }],
    workItemIdOrKeys: [task.key],
  });
  assert.equal(scenarioCreate.status, 201);
  const scenarioRevision = (await scenarioCreate.json()) as { revision: { scenarioId: string; key: string; revisionNumber: number } };
  const linkedScenarioTasks = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/scenarios/${scenarioRevision.revision.key}/revisions/${scenarioRevision.revision.revisionNumber}/work-items`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(linkedScenarioTasks.status, 200);
  assert.deepEqual(((await linkedScenarioTasks.json()) as { workItems: Array<{ key: string }> }).workItems.map((item) => item.key), [task.key]);
  const scenarioPublish = await postMutation(
    `/api/v1/projects/${projectId}/scenarios/${scenarioRevision.revision.key}/revisions/${scenarioRevision.revision.revisionNumber}/publish`,
    { requestId: "dashboard-task-linked-scenario-publish", expectedVersion: 1 },
  );
  assert.equal(scenarioPublish.status, 200);
  const scenarioAfterPublish = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/scenarios/${scenarioRevision.revision.key}`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(scenarioAfterPublish.status, 200);
  const publishedScenario = (await scenarioAfterPublish.json()) as { scenario: { version: number } };
  const scenarioRevisionProposal = await postMutation(
    `/api/v1/projects/${projectId}/scenarios/${scenarioRevision.revision.key}/revisions`,
    {
      requestId: "dashboard-task-linked-scenario-revision",
      expectedVersion: publishedScenario.scenario.version,
      title: "Verify task implementation, revision 2",
      steps: [{ action: "Run the task test again", expected: "The task behavior still passes." }],
      workItemIdOrKeys: [task.key],
    },
  );
  assert.equal(scenarioRevisionProposal.status, 200);
  const linkedScenarioTasksAfterEdit = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/scenarios/${scenarioRevision.revision.key}/revisions/2/work-items`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(linkedScenarioTasksAfterEdit.status, 200);
  assert.deepEqual(((await linkedScenarioTasksAfterEdit.json()) as { workItems: Array<{ key: string }> }).workItems.map((item) => item.key), [task.key]);
  const testRunResponse = await postMutation(`/api/v1/projects/${projectId}/scenarios/${scenarioRevision.revision.key}/test-runs`, {
    requestId: "dashboard-task-linked-run",
    revisionNumber: scenarioRevision.revision.revisionNumber,
    buildId: "dashboard-task-build-1",
    result: "passed",
    workItemIdOrKeys: [task.key],
  });
  assert.equal(testRunResponse.status, 201);
  const projectHistoryResponse = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/history?asOfDate=${projectToday()}`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(projectHistoryResponse.status, 200);
  const projectHistory = await projectHistoryResponse.json() as {
    asOfDate: string;
    timezone: string;
    cutoffAt: string;
    summary: {
      workItemsTotal: number;
      workItemsByState: { ready: number };
      testRunsTotal: number;
      testRunsByResult: { passed: number };
      sprintsTotal: number;
      sprintsByStatus: { closed: number };
      milestonesTotal: number;
    };
    workItems: { items: Array<{ key: string; state: string; revisionNumber: number }>; nextCursor: string | null };
    testRuns: Array<{ workItemKeys: string[] }>;
    activity: Array<{ sequence: number }>;
  };
  assert.equal(projectHistory.asOfDate, projectToday());
  assert.equal(projectHistory.timezone, "America/Sao_Paulo");
  assert.equal(projectHistory.summary.workItemsTotal, 7);
  assert.equal(projectHistory.summary.workItemsByState.ready, 1);
  assert.equal(projectHistory.summary.testRunsTotal, 1);
  assert.equal(projectHistory.summary.testRunsByResult.passed, 1);
  assert.equal(projectHistory.summary.sprintsTotal, 1);
  assert.equal(projectHistory.summary.sprintsByStatus.closed, 1);
  assert.equal(projectHistory.summary.milestonesTotal, 1);
  assert.equal(projectHistory.workItems.nextCursor, null);
  const historicalMetricStory = projectHistory.workItems.items.find((item) => item.key === metricStory.key);
  assert.deepEqual(historicalMetricStory && {
    key: historicalMetricStory.key,
    state: historicalMetricStory.state,
    revisionNumber: historicalMetricStory.revisionNumber,
  }, { key: metricStory.key, state: "ready", revisionNumber: 1 });
  assert.deepEqual(projectHistory.testRuns[0]?.workItemKeys, [task.key]);
  assert.ok(projectHistory.activity.length > 0);
  assert.equal(projectHistory.cutoffAt, `${addDays(projectToday(), 1)}T02:59:59.999Z`);
  const beforeProjectHistory = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/history?asOfDate=2018-11-04`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(beforeProjectHistory.status, 200);
  const beforeProjectSnapshot = await beforeProjectHistory.json() as {
    cutoffAt: string;
    summary: { workItemsTotal: number; testRunsTotal: number };
  };
  assert.equal(beforeProjectSnapshot.cutoffAt, "2018-11-05T01:59:59.999Z");
  assert.equal(beforeProjectSnapshot.summary.workItemsTotal, 0);
  assert.equal(beforeProjectSnapshot.summary.testRunsTotal, 0);
  const futureHistory = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/history?asOfDate=${addDays(projectToday(), 1)}`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.notEqual(futureHistory.status, 200);
  assert.equal(((await futureHistory.json()) as { code: string }).code, "VALIDATION_FAILED");
  const invalidHistoryDate = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/history?asOfDate=2026-02-30`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.notEqual(invalidHistoryDate.status, 200);
  assert.equal(((await invalidHistoryDate.json()) as { code: string }).code, "VALIDATION_FAILED");
  const taskContextResponse = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/work-items/${task.key}/context?profile=dev&include=hierarchy&include=acceptanceCriteria&include=businessRules&include=technicalDecisions&include=scenarios&include=testRuns&include=baseline&maxChars=30000`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(taskContextResponse.status, 200);
  const taskContext = await taskContextResponse.json() as {
    sections: {
      hierarchy: Array<{ key: string }>;
      technicalDecisions: Array<{ key: string; content: unknown }>;
      scenarios: Array<{ key: string; source: { relationship?: string } }>;
      testRuns: Array<{ content: { buildId: string }; source: { relationship?: string } }> };
    warnings: Array<{ code: string; key?: string }>;
  };
  assert.ok(taskContext.sections.hierarchy.some((entry) => entry.key === story.key));
  assert.ok(taskContext.sections.scenarios.some((entry) => entry.key === scenarioRevision.revision.key && entry.source.relationship === "task_direct_link"));
  assert.ok(taskContext.sections.testRuns.some((entry) => entry.content.buildId === "dashboard-task-build-1" && entry.source.relationship === "task_run_link"));
  assert.equal(JSON.stringify(taskContext.sections.technicalDecisions).includes("DRAFT_DECISION_MUST_NOT_BE_EXPOSED"), false);
  assert.ok(taskContext.warnings.some((warning) => warning.code === "SPEC_LINK_AFTER_BASELINE" && warning.key === "PAY-ADR-DRAFT"));

  const ownProject = await fetch(`${address.origin}/api/v1/projects/${projectId}`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(ownProject.status, 200);
  assert.equal(((await ownProject.json()) as { project: { id: string } }).project.id, projectId);

  const projectTeams = await fetch(`${address.origin}/api/v1/projects/${projectId}/teams`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(projectTeams.status, 200);
  assert.deepEqual(((await projectTeams.json()) as { teams: Array<{ teamId: string; name: string }> }).teams.map((team) => ({
    teamId: team.teamId,
    name: team.name,
  })), [{ teamId: capacity.teamId, name: "Payments team" }]);

  const dashboardMetrics = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/dashboard-metrics?milestoneId=${metricMilestone.id}`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(dashboardMetrics.status, 200);
  const dashboardMetricsBody = await dashboardMetrics.json() as {
    projectId: string;
    selectedTeamId: string | null;
    selectedTeamGenerationNumber: number | null;
    asOfDate: string;
    watermarkSequence: number;
    selectedMilestoneId: string | null;
    selectedSprintId: string | null;
    milestoneMetrics: { items: Array<{ points: number }>; series: Array<{ scopePoints: number }> } | null;
    forecast: {
      status: string;
      algorithmVersion: string;
      seed: number;
      simulationCount: number;
      probabilityOnTime: number | null;
      targetDateWithinHorizon: boolean;
    } | null;
    sprintMetrics: { asOfDate: string; items: unknown[] } | null;
    velocity: { watermarkSequence: number };
    wip: { watermarkSequence: number };
    coverage: { watermarkSequence: number };
  };
  assert.equal(dashboardMetricsBody.projectId, projectId);
  assert.equal(dashboardMetricsBody.selectedTeamId, capacity.teamId);
  assert.equal(dashboardMetricsBody.selectedTeamGenerationNumber, 1);
  assert.equal(dashboardMetricsBody.asOfDate, projectToday());
  assert.equal(dashboardMetricsBody.selectedMilestoneId, metricMilestone.id);
  assert.equal(dashboardMetricsBody.selectedSprintId, sprintId);
  assert.equal(dashboardMetricsBody.milestoneMetrics?.items.reduce((total, item) => total + item.points, 0), 5);
  assert.equal(dashboardMetricsBody.milestoneMetrics?.series.at(-1)?.scopePoints, 5);
  assert.equal(dashboardMetricsBody.forecast?.status, "insufficient_data");
  assert.equal(dashboardMetricsBody.forecast?.algorithmVersion, "2.0.0");
  assert.ok(Number.isSafeInteger(dashboardMetricsBody.forecast?.seed));
  assert.equal(dashboardMetricsBody.forecast?.simulationCount, 10_000);
  assert.equal(dashboardMetricsBody.forecast?.probabilityOnTime, null);
  assert.equal(dashboardMetricsBody.forecast?.targetDateWithinHorizon, true);
  assert.equal(dashboardMetricsBody.sprintMetrics?.asOfDate, projectToday());
  assert.deepEqual(dashboardMetricsBody.sprintMetrics?.items, []);
  assert.equal(dashboardMetricsBody.watermarkSequence, dashboardMetricsBody.velocity.watermarkSequence);
  assert.equal(dashboardMetricsBody.watermarkSequence, dashboardMetricsBody.wip.watermarkSequence);
  assert.equal(dashboardMetricsBody.watermarkSequence, dashboardMetricsBody.coverage.watermarkSequence);

  const invalidMetricDate = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/dashboard-metrics?asOfDate=2026-02-30`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(invalidMetricDate.status, 400);
  const invalidMetricDateError = await invalidMetricDate.json() as { code: string };
  assert.equal(invalidMetricDateError.code, "VALIDATION_FAILED");

  const developerMetrics = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/developer-execution-metrics?from=${projectToday().slice(0, 7)}-01&to=${projectToday()}`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(developerMetrics.status, 200);
  const developerMetricsBody = await developerMetrics.json() as {
    projectId: string; period: { from: string; to: string }; minimumSampleTasks: number; developers: unknown[];
  };
  assert.equal(developerMetricsBody.projectId, projectId);
  assert.equal(developerMetricsBody.period.to, projectToday());
  assert.equal(developerMetricsBody.minimumSampleTasks, 5);
  assert.deepEqual(developerMetricsBody.developers, []);
  const emptyTaskSessions = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/development-sessions?itemIdOrKey=${metricStory.id}`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(emptyTaskSessions.status, 200);
  assert.deepEqual(((await emptyTaskSessions.json()) as { sessions: unknown[] }).sessions, []);
  const emptyTaskDeploymentEvents = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/deployment-events?itemIdOrKey=${metricStory.id}`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(emptyTaskDeploymentEvents.status, 200);
  assert.deepEqual(((await emptyTaskDeploymentEvents.json()) as { events: unknown[] }).events, []);
  const invalidDeploymentFilter = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/deployment-events?environment=staging`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(invalidDeploymentFilter.status, 400);
  assert.equal(((await invalidDeploymentFilter.json()) as { code: string }).code, "VALIDATION_FAILED");
  const invalidDeveloperMetrics = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/developer-execution-metrics?from=2026-02-30`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(invalidDeveloperMetrics.status, 400);
  assert.equal(((await invalidDeveloperMetrics.json()) as { code: string }).code, "VALIDATION_FAILED");

  await client.connect(transport);
  const mcpMetrics = await client.callTool({
    name: "metrics_get",
    arguments: {
      projectId,
      milestoneId: metricMilestone.id,
      sprintId,
      asOfDate: dashboardMetricsBody.asOfDate,
    },
  });
  assert.notEqual(mcpMetrics.isError, true);
  assert.ok(mcpMetrics.structuredContent);
  assert.deepEqual(
    withoutObservedAt(mcpMetrics.structuredContent),
    withoutObservedAt(dashboardMetricsBody),
  );
  const mcpInvalidMetricDate = await client.callTool({
    name: "metrics_get",
    arguments: { projectId, milestoneId: metricMilestone.id, asOfDate: "2026-02-30" },
  });
  assert.equal(mcpInvalidMetricDate.isError, true);
  const mcpInvalidMetricDateText = mcpInvalidMetricDate.content.find((content) => content.type === "text");
  assert.ok(mcpInvalidMetricDateText && mcpInvalidMetricDateText.type === "text");
  assert.equal((JSON.parse(mcpInvalidMetricDateText.text) as { code: string }).code, invalidMetricDateError.code);

  const beforeMilestone = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/dashboard-metrics?milestoneId=${metricMilestone.id}&asOfDate=${addDays(projectToday(), -1)}`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(beforeMilestone.status, 200);
  const beforeMilestoneBody = await beforeMilestone.json() as {
    forecastUnavailableReason: string | null;
    milestoneMetrics: unknown;
    forecast: unknown;
  };
  assert.equal(beforeMilestoneBody.forecastUnavailableReason, "before_milestone_created");
  assert.equal(beforeMilestoneBody.milestoneMetrics, null);
  assert.equal(beforeMilestoneBody.forecast, null);

  const qualitySummary = await fetch(`${address.origin}/api/v1/projects/${projectId}/quality`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(qualitySummary.status, 200);
  assert.equal(((await qualitySummary.json()) as { items: Array<{ itemId: string }> }).items.length, 2);
  const qualityFirstPageResponse = await fetch(`${address.origin}/api/v1/projects/${projectId}/quality?limit=1`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  const qualityFirstPage = await qualityFirstPageResponse.json() as {
    items: Array<{ itemKey: string }>;
    nextCursor: string | null;
    watermark: number;
  };
  assert.equal(qualityFirstPageResponse.status, 200);
  assert.equal(qualityFirstPage.items.length, 1);
  assert.ok(qualityFirstPage.nextCursor);
  assert.ok(qualityFirstPage.watermark > 0);
  const qualitySecondPageResponse = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/quality?limit=1&cursor=${encodeURIComponent(qualityFirstPage.nextCursor!)}`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  const qualitySecondPage = await qualitySecondPageResponse.json() as {
    items: Array<{ itemKey: string }>;
    nextCursor: string | null;
  };
  assert.equal(qualitySecondPageResponse.status, 200);
  assert.equal(qualitySecondPage.items.length, 1);
  assert.notEqual(qualitySecondPage.items[0]?.itemKey, qualityFirstPage.items[0]?.itemKey);
  assert.equal(qualitySecondPage.nextCursor, null);

  const scenarioList = await fetch(`${address.origin}/api/v1/projects/${projectId}/scenarios`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(scenarioList.status, 200);
  assert.ok(((await scenarioList.json()) as { scenarios: Array<{ key: string; publishedRevision: number | null }> }).scenarios
    .some((scenario) => scenario.key === "PAY-TC-METRICS" && scenario.publishedRevision === 1));
  const scenarioFirstPageResponse = await fetch(`${address.origin}/api/v1/projects/${projectId}/scenarios?limit=1`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  const scenarioFirstPage = await scenarioFirstPageResponse.json() as {
    scenarios: Array<{ key: string }>;
    nextCursor: string | null;
  };
  assert.equal(scenarioFirstPageResponse.status, 200);
  assert.equal(scenarioFirstPage.scenarios.length, 1);
  assert.ok(scenarioFirstPage.nextCursor);
  const scenarioSecondPageResponse = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/scenarios?limit=1&cursor=${encodeURIComponent(scenarioFirstPage.nextCursor!)}`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  const scenarioSecondPage = await scenarioSecondPageResponse.json() as {
    scenarios: Array<{ key: string }>;
    nextCursor: string | null;
  };
  assert.equal(scenarioSecondPageResponse.status, 200);
  assert.equal(scenarioSecondPage.scenarios.length, 1);
  assert.notEqual(scenarioSecondPage.scenarios[0]?.key, scenarioFirstPage.scenarios[0]?.key);

  const specificationListResponse = await fetch(`${address.origin}/api/v1/projects/${projectId}/specifications`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(specificationListResponse.status, 200);
  const specificationPage = await specificationListResponse.json() as {
    specifications: Array<{
      key: string;
      kind: string;
      latestRevision: number;
      latestStatus: string | null;
      publishedRevision: number | null;
    }>;
    watermark: number;
  };
  assert.ok(specificationPage.specifications.some((specification) => (
    specification.key === "PAY-ADR-DRAFT"
    && specification.kind === "adr"
    && specification.latestRevision === 1
    && specification.latestStatus === "draft"
    && specification.publishedRevision === null
  )));
  assert.ok(specificationPage.specifications.some((specification) => (
    specification.key === "PAY-ADR-HISTORY"
    && specification.latestRevision === 2
    && specification.latestStatus === "published"
    && specification.publishedRevision === 2
  )));
  assert.ok(specificationPage.watermark > 0);

  const filteredSpecificationsResponse = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/specifications?kind=adr&search=payment`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(filteredSpecificationsResponse.status, 200);
  const filteredSpecifications = await filteredSpecificationsResponse.json() as {
    specifications: Array<{ key: string; kind: string }>;
  };
  assert.ok(filteredSpecifications.specifications.length > 0);
  assert.ok(filteredSpecifications.specifications.every((specification) => specification.kind === "adr"));
  assert.ok(filteredSpecifications.specifications.some((specification) => specification.key === "PAY-ADR-DRAFT"));

  const specificationDetailResponse = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/specifications/PAY-ADR-DRAFT`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(specificationDetailResponse.status, 200);
  const specificationDetail = await specificationDetailResponse.json() as {
    specification: {
      key: string;
      publishedRevision: number | null;
      revisions: Array<{ revisionNumber: number; status: string; content: { decision?: string } }>;
    };
  };
  assert.equal(specificationDetail.specification.key, "PAY-ADR-DRAFT");
  assert.equal(specificationDetail.specification.publishedRevision, null);
  assert.equal(specificationDetail.specification.revisions.length, 1);
  assert.equal(specificationDetail.specification.revisions[0]?.status, "draft");
  assert.equal(specificationDetail.specification.revisions[0]?.content.decision, "DRAFT_DECISION_MUST_NOT_BE_EXPOSED");

  const historicalSpecificationResponse = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/specifications/PAY-ADR-HISTORY`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(historicalSpecificationResponse.status, 200);
  const historicalSpecification = await historicalSpecificationResponse.json() as {
    specification: {
      publishedRevision: number | null;
      revisions: Array<{ revisionNumber: number; status: string }>;
    };
  };
  assert.equal(historicalSpecification.specification.publishedRevision, 2);
  assert.deepEqual(
    historicalSpecification.specification.revisions.map(({ revisionNumber, status }) => ({ revisionNumber, status })),
    [
      { revisionNumber: 1, status: "superseded" },
      { revisionNumber: 2, status: "published" },
    ],
  );

  const missingSpecificationResponse = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/specifications/PAY-ADR-MISSING`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(missingSpecificationResponse.status, 404);
  assert.equal(((await missingSpecificationResponse.json()) as { code: string }).code, "NOT_FOUND");

  const invalidSpecificationFilterResponse = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/specifications?kind=unknown`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(invalidSpecificationFilterResponse.status, 400);
  assert.equal(((await invalidSpecificationFilterResponse.json()) as { code: string }).code, "VALIDATION_FAILED");

  const invalidScenarioResponse = await postMutation(`/api/v1/projects/${projectId}/scenarios`, {
    requestId: "dashboard-api-invalid-scenario",
    key: "PAY-TC-INVALID",
    kind: "acceptance",
    title: "Invalid scenario",
    steps: [],
  });
  assert.equal(invalidScenarioResponse.status, 400);
  assert.equal(((await invalidScenarioResponse.json()) as { code: string }).code, "VALIDATION_FAILED");

  const scenarioDraftResponse = await postMutation(`/api/v1/projects/${projectId}/scenarios`, {
    requestId: "dashboard-api-scenario-create",
    key: "PAY-TC-DASHBOARD",
    kind: "acceptance",
    title: "Create a scenario in the dashboard",
    preconditions: ["A project is available."],
    steps: [{ action: "Open the quality view", expected: "The scenario is listed." }],
    coverage: [{ targetType: "criterion", reference: metricStory.criteria[0]!.id }],
  });
  assert.equal(scenarioDraftResponse.status, 201);
  const scenarioDraft = (await scenarioDraftResponse.json()) as { revision: { scenarioId: string; revisionNumber: number; status: string } };
  assert.equal(scenarioDraft.revision.revisionNumber, 1);
  assert.equal(scenarioDraft.revision.status, "draft");

  const draftRunResponse = await postMutation(`/api/v1/projects/${projectId}/scenarios/PAY-TC-DASHBOARD/test-runs`, {
    requestId: "dashboard-api-run-draft-denied",
    revisionNumber: 1,
    buildId: "dashboard-build-1",
    result: "passed",
  });
  assert.equal(draftRunResponse.status, 400);
  assert.equal(((await draftRunResponse.json()) as { code: string }).code, "VALIDATION_FAILED");

  const scenarioPublishedResponse = await postMutation(
    `/api/v1/projects/${projectId}/scenarios/PAY-TC-DASHBOARD/revisions/1/publish`,
    { requestId: "dashboard-api-scenario-publish", expectedVersion: 1 },
  );
  assert.equal(scenarioPublishedResponse.status, 200);
  assert.equal(((await scenarioPublishedResponse.json()) as { revision: { status: string } }).revision.status, "published");

  const runResponse = await postMutation(`/api/v1/projects/${projectId}/scenarios/PAY-TC-DASHBOARD/test-runs`, {
    requestId: "dashboard-api-run-record",
    revisionNumber: 1,
    buildId: "dashboard-build-1",
    result: "passed",
    notes: "Executed from the dashboard API.",
    evidenceUri: "https://example.test/evidence/1",
  });
  assert.equal(runResponse.status, 201);
  const recordedRun = (await runResponse.json()) as { run: { id: string; scenarioId: string; scenarioKey: string; revisionNumber: number; buildId: string; result: string; evidenceUri: string | null } };
  assert.equal(recordedRun.run.scenarioId, scenarioDraft.revision.scenarioId);
  assert.equal(recordedRun.run.scenarioKey, "PAY-TC-DASHBOARD");
  assert.equal(recordedRun.run.revisionNumber, 1);
  assert.equal(recordedRun.run.buildId, "dashboard-build-1");
  assert.equal(recordedRun.run.result, "passed");
  assert.equal(recordedRun.run.evidenceUri, "https://example.test/evidence/1");

  const runHistory = await fetch(`${address.origin}/api/v1/projects/${projectId}/test-runs?scenario=PAY-TC-DASHBOARD`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(runHistory.status, 200);
  assert.deepEqual(((await runHistory.json()) as { runs: Array<{ id: string; scenarioKey: string; revisionNumber: number }> }).runs.map((run) => ({
    id: run.id,
    scenarioKey: run.scenarioKey,
    revisionNumber: run.revisionNumber,
  })), [{ id: recordedRun.run.id, scenarioKey: "PAY-TC-DASHBOARD", revisionNumber: 1 }]);

  const secondRunResponse = await postMutation(`/api/v1/projects/${projectId}/scenarios/PAY-TC-DASHBOARD/test-runs`, {
    requestId: "dashboard-api-run-record-2",
    revisionNumber: 1,
    buildId: "dashboard-build-2",
    result: "failed",
  });
  assert.equal(secondRunResponse.status, 201);
  const secondRun = (await secondRunResponse.json()) as { run: { id: string } };
  type RunPage = { runs: Array<{ id: string }>; nextCursor: string | null; watermark: number };
  const runPageUrl = `${address.origin}/api/v1/projects/${projectId}/test-runs?scenario=PAY-TC-DASHBOARD&limit=1`;
  const firstRunPage = (await (await fetch(runPageUrl, { headers: { Cookie: cookie, Origin: address.origin } })).json()) as RunPage;
  assert.deepEqual(firstRunPage.runs.map((run) => run.id), [secondRun.run.id]);
  assert.notEqual(firstRunPage.nextCursor, null);
  const secondRunPage = (await (await fetch(`${runPageUrl}&cursor=${encodeURIComponent(firstRunPage.nextCursor ?? "")}`, {
    headers: { Cookie: cookie, Origin: address.origin },
  })).json()) as RunPage;
  assert.deepEqual(secondRunPage.runs.map((run) => run.id), [recordedRun.run.id]);
  assert.equal(secondRunPage.nextCursor, null);
  const failedOnly = (await (await fetch(`${address.origin}/api/v1/projects/${projectId}/test-runs?result=failed`, {
    headers: { Cookie: cookie, Origin: address.origin },
  })).json()) as RunPage;
  assert.deepEqual(failedOnly.runs.map((run) => run.id), [secondRun.run.id]);
  const invalidResult = await fetch(`${address.origin}/api/v1/projects/${projectId}/test-runs?result=unknown`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(invalidResult.status, 400);

  const createdItemResponse = await postMutation(`/api/v1/projects/${projectId}/work-items`, {
    requestId: "dashboard-api-work-item-create",
    type: "story",
    parentId: feature.id,
    title: "Created from the dashboard",
    description: "Initial dashboard copy.",
    priority: 2,
    criteria: [{ description: "The created item is visible in the backlog." }],
  });
  assert.equal(createdItemResponse.status, 201);
  const createdItem = (await createdItemResponse.json()) as { workItem: { id: string; key: string; version: number; criteria: Array<{ id: string; key: string }> } };
  assert.ok(createdItem.workItem.key.startsWith("PAY-"));

  const proposedItemRevisionResponse = await postMutation(`/api/v1/projects/${projectId}/work-items/${createdItem.workItem.key}/revisions`, {
    requestId: "dashboard-api-work-item-revision",
    expectedVersion: createdItem.workItem.version,
    title: "Edited from the dashboard",
    description: "Proposed revised content.",
    priority: 1,
    criteria: [{ id: createdItem.workItem.criteria[0]!.id, description: "The edited item is visible in the backlog." }],
  });
  assert.equal(proposedItemRevisionResponse.status, 200);
  assert.equal(((await proposedItemRevisionResponse.json()) as { revision: { revisionNumber: number; status: string } }).revision.revisionNumber, 2);

  const itemRevisionsResponse = await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${createdItem.workItem.key}/revisions`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(itemRevisionsResponse.status, 200);
  assert.ok(((await itemRevisionsResponse.json()) as { revisions: Array<{ revisionNumber: number; status: string }> }).revisions
    .some((revision) => revision.revisionNumber === 2 && revision.status === "draft"));
  const proposedItemResponse = await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${createdItem.workItem.key}`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(proposedItemResponse.status, 200);
  const proposedItem = (await proposedItemResponse.json()) as { workItem: { version: number } };
  const itemPublishedResponse = await postMutation(
    `/api/v1/projects/${projectId}/work-items/${createdItem.workItem.key}/revisions/2/publish`,
    { requestId: "dashboard-api-work-item-publish", expectedVersion: proposedItem.workItem.version },
  );
  assert.equal(itemPublishedResponse.status, 200);
  assert.equal(((await itemPublishedResponse.json()) as { revision: { status: string } }).revision.status, "published");
  const publishedItemResponse = await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${createdItem.workItem.key}`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(((await publishedItemResponse.json()) as { workItem: { title: string } }).workItem.title, "Edited from the dashboard");

  const qualityDetail = await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${story.key}/quality`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(qualityDetail.status, 200);
  const qualityBody = await qualityDetail.json() as { quality: { mode: string; baseline: { id: string } | null } };
  assert.equal(qualityBody.quality.mode, "pinned");
  assert.equal(qualityBody.quality.baseline?.id, parentBaselineId);
  const baselineResponse = await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${story.key}/baseline`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(baselineResponse.status, 200);
  const baselineBody = await baselineResponse.json() as { baseline: { id: string; sequence: number; references: Array<{ snapshot?: unknown }> } };
  assert.equal(baselineBody.baseline.id, parentBaselineId);
  assert.ok(baselineBody.baseline.references.every((reference) => reference.snapshot === undefined), "the dashboard lists pinned revisions without their snapshots");
  const impactsResponse = await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${story.key}/impacts?status=open`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(impactsResponse.status, 200);
  assert.ok(Array.isArray(((await impactsResponse.json()) as { impacts: unknown[] }).impacts));
  // SSDD-97 AC-1: revalidation is refused without PO/Tech Lead (positive flow: backlog-operations.test.ts).
  const currentStory = await (await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${story.key}`, { headers: { Cookie: cookie, Origin: address.origin } })).json() as { workItem: { version: number } };
  const revalidateBody = { requestId: "dashboard-revalidate", itemIdOrKey: story.key, expectedVersion: currentStory.workItem.version, reason: "Revalidação pelo dashboard" };
  const developerRevalidate = await postAsTaskDeveloper(`/api/v1/projects/${projectId}/backlog/baseline_revalidate`, { ...revalidateBody, requestId: "dashboard-revalidate-dev" });
  assert.equal(developerRevalidate.status, 403);
  assert.equal(((await developerRevalidate.json()) as { code: string }).code, "FORBIDDEN");
  const unchangedBaseline = await (await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${story.key}/baseline`, { headers: { Cookie: cookie, Origin: address.origin } })).json() as { baseline: { sequence: number } };
  assert.equal(unchangedBaseline.baseline.sequence, baselineBody.baseline.sequence, "a refused revalidation has no effect");
  const revalidateWithoutImpact = await postMutation(`/api/v1/projects/${projectId}/backlog/baseline_revalidate`, revalidateBody);
  assert.equal(revalidateWithoutImpact.status, 400, "revalidation needs an open impact");
  assert.equal(((await revalidateWithoutImpact.json()) as { code: string }).code, "VALIDATION_FAILED");
  const itemTimeline = await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${story.key}/timeline`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(itemTimeline.status, 200);
  assert.ok(((await itemTimeline.json()) as { events: Array<{ eventType: string }> }).events
    .some((event) => event.eventType === "work_item.created"));

  const retrospectiveRead = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/sprints/PAY-CLOSED/retrospective`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(retrospectiveRead.status, 200);
  const retrospectiveBody = await retrospectiveRead.json() as {
    retrospective: { version: number; retrospective: { summary: string; actions: Array<{ linkedWorkItemKey: string | null }> } };
  };
  assert.equal(retrospectiveBody.retrospective.version, 1);
  assert.equal(retrospectiveBody.retrospective.retrospective.summary, "A equipe compartilhou os aprendizados do ciclo.");
  assert.equal(retrospectiveBody.retrospective.retrospective.actions[0]?.linkedWorkItemKey, story.key);

  const apiDenied = await fetch(`${address.origin}/api/v1/projects/${restrictedProjectId}`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(apiDenied.status, 403);
  const apiError = await apiDenied.json() as { code: string };

  const mcpDenied = await client.callTool({ name: "project_get", arguments: { projectId: restrictedProjectId } });
  assert.equal(mcpDenied.isError, true);
  const mcpErrorText = mcpDenied.content.find((content) => content.type === "text");
  assert.ok(mcpErrorText && mcpErrorText.type === "text");
  const mcpError = JSON.parse(mcpErrorText.text) as { code: string };
  assert.equal(mcpError.code, apiError.code);
  assert.equal(apiError.code, "FORBIDDEN");
  const mcpMetricsDenied = await client.callTool({
    name: "metrics_get",
    arguments: { projectId: restrictedProjectId },
  });
  assert.equal(mcpMetricsDenied.isError, true);
  const mcpMetricsDeniedText = mcpMetricsDenied.content.find((content) => content.type === "text");
  assert.ok(mcpMetricsDeniedText && mcpMetricsDeniedText.type === "text");
  assert.equal((JSON.parse(mcpMetricsDeniedText.text) as { code: string }).code, apiError.code);

  const restrictedQuality = await fetch(`${address.origin}/api/v1/projects/${restrictedProjectId}/quality`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(restrictedQuality.status, 403);
  assert.equal(((await restrictedQuality.json()) as { code: string }).code, "FORBIDDEN");
  const restrictedAudit = await fetch(`${address.origin}/api/v1/projects/${restrictedProjectId}/audit`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(restrictedAudit.status, 403);
  assert.equal(((await restrictedAudit.json()) as { code: string }).code, "FORBIDDEN");
  const restrictedSpecifications = await fetch(`${address.origin}/api/v1/projects/${restrictedProjectId}/specifications`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(restrictedSpecifications.status, 403);
  assert.equal(((await restrictedSpecifications.json()) as { code: string }).code, "FORBIDDEN");
  const restrictedMetrics = await fetch(`${address.origin}/api/v1/projects/${restrictedProjectId}/dashboard-metrics`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(restrictedMetrics.status, 403);
  assert.equal(((await restrictedMetrics.json()) as { code: string }).code, "FORBIDDEN");
  const restrictedHistory = await fetch(`${address.origin}/api/v1/projects/${restrictedProjectId}/history`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(restrictedHistory.status, 403);
  assert.equal(((await restrictedHistory.json()) as { code: string }).code, "FORBIDDEN");
  const restrictedRetrospective = await fetch(
    `${address.origin}/api/v1/projects/${restrictedProjectId}/sprints/hidden-sprint/retrospective`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(restrictedRetrospective.status, 403);
  assert.equal(((await restrictedRetrospective.json()) as { code: string }).code, "FORBIDDEN");

  const crossOrigin = await fetch(`${address.origin}/api/v1/projects`, {
    headers: { Cookie: cookie, Origin: "https://attacker.example" },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(((await crossOrigin.json()) as { code: string }).code, "ORIGIN_NOT_ALLOWED");
  assert.equal(crossOrigin.headers.get("access-control-allow-origin"), null);

  const csrfDenied = await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/PAY-404/transition`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: address.origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requestId: "missing-csrf",
      targetState: "ready",
      expectedVersion: 1,
      reason: "Missing CSRF token must block the command.",
    }),
  });
  assert.equal(csrfDenied.status, 403);
  assert.equal(((await csrfDenied.json()) as { code: string }).code, "CSRF_INVALID");

  const validCsrfNotFound = await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/PAY-404/transition`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: address.origin,
      "X-SSDD-CSRF": sessionBody.csrfToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requestId: "valid-csrf-not-found",
      targetState: "ready",
      expectedVersion: 1,
      reason: "CSRF passed; the work item reference is intentionally missing.",
    }),
  });
  assert.equal(validCsrfNotFound.status, 404);
  assert.equal(((await validCsrfNotFound.json()) as { code: string }).code, "NOT_FOUND");

  const staleVersion = await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${story.key}/transition`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: address.origin,
      "X-SSDD-CSRF": sessionBody.csrfToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requestId: "stale-dashboard-version",
      targetState: "in_review",
      expectedVersion: story.version + 2,
      reason: "Confirme que um card desatualizado não altera o item.",
    }),
  });
  assert.equal(staleVersion.status, 409);
  assert.equal(((await staleVersion.json()) as { code: string }).code, "VERSION_CONFLICT");

  const claimReplay = await fetch(
    `${address.origin}/api/v1/session/claim?token=${encodeURIComponent(dashboard.bootstrapToken)}`,
  );
  assert.equal(claimReplay.status, 401);

  const historySeedDatabase = openSqliteDatabase(initialized.databasePath);
  try {
    for (let index = 0; index < 201; index += 1) {
      createWorkItem(historySeedDatabase, {
        projectId,
        principalId,
        requestId: randomUUID(),
        type: "task",
        parentId: story.id,
        title: `History page item ${String(index + 1).padStart(3, "0")}`,
      });
    }
  } finally {
    historySeedDatabase.close();
  }
  const paginationDate = projectToday();
  const firstHistoryPageResponse = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/history?asOfDate=${paginationDate}`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(firstHistoryPageResponse.status, 200);
  const firstHistoryPage = await firstHistoryPageResponse.json() as {
    capturedAt: string;
    sourceWatermark: number;
    summary: { workItemsTotal: number };
    workItems: { items: Array<{ key: string }>; nextCursor: string | null };
  };
  assert.equal(firstHistoryPage.workItems.items.length, 200);
  assert.ok(firstHistoryPage.workItems.nextCursor);
  const secondHistoryPageResponse = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/history?asOfDate=${paginationDate}&cursor=${encodeURIComponent(firstHistoryPage.workItems.nextCursor)}`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(secondHistoryPageResponse.status, 200);
  const secondHistoryPage = await secondHistoryPageResponse.json() as {
    capturedAt: string;
    sourceWatermark: number;
    summary: { workItemsTotal: number };
    workItems: { items: Array<{ key: string }>; nextCursor: string | null };
  };
  const pagedKeys = [...firstHistoryPage.workItems.items, ...secondHistoryPage.workItems.items].map((item) => item.key);
  assert.equal(secondHistoryPage.workItems.nextCursor, null);
  assert.equal(secondHistoryPage.capturedAt, firstHistoryPage.capturedAt);
  assert.equal(secondHistoryPage.sourceWatermark, firstHistoryPage.sourceWatermark);
  assert.equal(new Set(pagedKeys).size, pagedKeys.length);
  assert.equal(pagedKeys.length, firstHistoryPage.summary.workItemsTotal);
  assert.equal(secondHistoryPage.summary.workItemsTotal, firstHistoryPage.summary.workItemsTotal);

  const concurrentMutationDatabase = openSqliteDatabase(initialized.databasePath);
  try {
    createWorkItem(concurrentMutationDatabase, {
      projectId,
      principalId,
      requestId: randomUUID(),
      type: "task",
      parentId: story.id,
      title: "History item added after the page snapshot",
    });
  } finally {
    concurrentMutationDatabase.close();
  }
  const staleHistoryPageResponse = await fetch(
    `${address.origin}/api/v1/projects/${projectId}/history?asOfDate=${paginationDate}&cursor=${encodeURIComponent(firstHistoryPage.workItems.nextCursor!)}`,
    { headers: { Cookie: cookie, Origin: address.origin } },
  );
  assert.equal(staleHistoryPageResponse.status, 409);
  assert.equal(((await staleHistoryPageResponse.json()) as { code: string }).code, "STALE_CURSOR");
});

function projectToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year")!.value}-${parts.find((part) => part.type === "month")!.value}-${parts.find((part) => part.type === "day")!.value}`;
}

function withoutObservedAt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutObservedAt);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "observedAt")
    .map(([key, nested]) => [key, withoutObservedAt(nested)]));
}

function addDays(date: string, amount: number): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + amount);
  return result.toISOString().slice(0, 10);
}
