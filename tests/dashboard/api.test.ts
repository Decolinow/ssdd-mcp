import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { confirmWorkItemEstimate, proposeWorkItemEstimate } from "../../src/application/work-item-commands.js";
import { getWorkItem } from "../../src/application/work-item-queries.js";
import { setDefinitionOfDone } from "../../src/application/definition-of-done.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createMilestone } from "../../src/application/milestones.js";
import { createScenario, publishScenarioRevision } from "../../src/application/scenario-commands.js";
import { setSprintRetrospective } from "../../src/application/sprint-retrospectives.js";
import { setTeamCapacityConfiguration } from "../../src/application/team-capacity.js";
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
  database.close();

  const dashboard = createDashboardApiServer(workspace);
  const address = await listenDashboardApiServer(dashboard, 0);
  const client = new Client({ name: "ssdd-dashboard-parity-test", version: "0.1.0" });
  const cliPath = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "stdio", "--workspace", workspace],
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
  assert.match(await landingPage.text(), /Product Backlog/u);
  const dashboardScript = await fetch(`${address.origin}/dashboard.js`);
  assert.equal(dashboardScript.status, 200);
  assert.match(dashboardScript.headers.get("content-type") ?? "", /javascript/u);
  assert.match(await dashboardScript.text(), /X-SSDD-CSRF/u);
  const dashboardStyles = await fetch(`${address.origin}/dashboard.css`);
  assert.equal(dashboardStyles.status, 200);
  assert.match(dashboardStyles.headers.get("content-type") ?? "", /text\/css/u);

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

  const qualityDetail = await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${story.key}/quality`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(qualityDetail.status, 200);
  const qualityBody = await qualityDetail.json() as { quality: { mode: string; baseline: unknown } };
  assert.equal(qualityBody.quality.mode, "preview");
  assert.equal(qualityBody.quality.baseline, null);

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
  const restrictedMetrics = await fetch(`${address.origin}/api/v1/projects/${restrictedProjectId}/dashboard-metrics`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
  assert.equal(restrictedMetrics.status, 403);
  assert.equal(((await restrictedMetrics.json()) as { code: string }).code, "FORBIDDEN");
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
      targetState: "ready",
      expectedVersion: story.version + 1,
      reason: "Confirme que um card desatualizado não altera o item.",
    }),
  });
  assert.equal(staleVersion.status, 409);
  assert.equal(((await staleVersion.json()) as { code: string }).code, "VERSION_CONFLICT");

  const claimReplay = await fetch(
    `${address.origin}/api/v1/session/claim?token=${encodeURIComponent(dashboard.bootstrapToken)}`,
  );
  assert.equal(claimReplay.status, 401);
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
