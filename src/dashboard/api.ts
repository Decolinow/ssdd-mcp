import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ApplicationError } from "../application/errors.js";
import { getOrCreateLocalPrincipal } from "../application/local-identity.js";
import { isAuthKeySessionActive, resolveAuthKeySessionIdentity } from "../application/user-management.js";
import { getProject, listProjects } from "../application/project-queries.js";
import { listAuditEvents } from "../application/audit-queries.js";
import { getProjectDashboardMetrics } from "../application/dashboard-metrics.js";
import { getProjectHistorySnapshot } from "../application/project-history.js";
import { getProjectFeatureRoadmap } from "../application/prioritized-roadmap.js";
import { getDashboardQuickAccess } from "../application/dashboard-quick-access.js";
import { getDeveloperExecutionMetrics, listDeploymentEvents, listDevelopmentSessions } from "../application/development-lifecycle.js";
import { listProjectTeams } from "../application/team-directory.js";
import { getWorkItemQualityReport, listProjectQualitySummaries } from "../application/quality-queries.js";
import { getTaskContext, taskContextProfiles, taskContextSections } from "../application/task-context.js";
import { getSprint, listSprints } from "../application/sprint-queries.js";
import { getSprintRetrospective, setSprintRetrospective } from "../application/sprint-retrospectives.js";
import { startTaskDevelopment } from "../application/task-development-start.js";
import { claimTaskForDevelopment } from "../application/task-development-claim.js";
import { getTaskWorkflow } from "../application/task-workflow-queries.js";
import { proposeTaskWorkflow, publishTaskWorkflow, transitionTaskWorkflowStep } from "../application/task-workflow-commands.js";
import { getWorkItem, listWorkItemRevisions, listWorkItems } from "../application/work-item-queries.js";
import { createWorkItem } from "../application/create-work-item.js";
import { proposeWorkItemRevision, publishWorkItemRevision } from "../application/work-item-revisions.js";
import { createScenario, proposeScenarioRevision, publishScenarioRevision, recordTestRun } from "../application/scenario-commands.js";
import type { ListTestRunsInput } from "../application/scenario-queries.js";
import { getScenario, listScenarioRevisionWorkItems, listScenarios, listTestRunPage } from "../application/scenario-queries.js";
import { getSpecification, listSpecifications } from "../application/specification-queries.js";
import { certifyTestRun, getTaskStartReadiness, transitionWorkItem } from "../application/work-item-workflow.js";
import { scenarioKinds, testRunResults } from "../domain/scenarios.js";
import { specificationKinds } from "../domain/specifications.js";
import { linkTaskToAdr } from "../application/adr-commands.js";
import { createSpecification, proposeSpecificationRevision, publishSpecificationRevision, withdrawSpecificationRevision } from "../application/specification-commands.js";
import { sprintStates } from "../domain/sprints.js";
import { addWorkItemComment, assignWorkItem, confirmWorkItemEstimate, listWorkItemComments, proposeWorkItemEstimate, rankWorkItem } from "../application/work-item-commands.js";
import { addTraceLink, removeTraceLink } from "../application/trace-commands.js";
import { queryTraceGraph } from "../application/trace-queries.js";
import { traceLinkTypes } from "../domain/trace.js";
import { createTeamCapacityConfiguration, setTeamCapacityConfiguration } from "../application/team-capacity.js";
import { setDefinitionOfDone } from "../application/definition-of-done.js";
import { changeMilestoneScope, createMilestone } from "../application/milestones.js";
import { cancelSprint, changeSprintScope, closeSprint, createSprintDraft, startSprint } from "../application/sprint-commands.js";
import { workItemStates, workItemTypes } from "../domain/work-items.js";
import { applyMigrations } from "../storage-sqlite/migrations.js";
import { openSqliteDatabase, type SqliteDatabase } from "../storage-sqlite/database.js";

const sessionCookieName = "ssdd_session";
const sessionLifetimeMs = 12 * 60 * 60 * 1_000;
const maximumRequestBytes = 128 * 1_024;

interface LocalSession {
  readonly id: string;
  readonly principalId: string;
  readonly authKeyId: string | null;
  readonly csrfToken: string;
  readonly expiresAt: number;
}

export interface DashboardApiServer {
  readonly server: Server;
  readonly bootstrapToken: string;
  readonly close: () => Promise<void>;
}

export interface DashboardApiAddress {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly origin: string;
}

export function createDashboardApiServer(workspace: string): DashboardApiServer {
  const databasePath = join(resolve(workspace), ".ssdd", "ssdd.sqlite");
  if (!existsSync(databasePath)) {
    throw new Error(`No SSDD workspace found at '${databasePath}'. Run 'ssdd-mcp init' first.`);
  }

  const database = openSqliteDatabase(databasePath);
  try {
    applyMigrations(database);
    const bootstrapPrincipal = getOrCreateLocalPrincipal(database);
    const bootstrapToken = randomBytes(32).toString("base64url");
    let bootstrapClaimed = false;
    const localSessions = new Map<string, LocalSession>();
    let origin: string | undefined;

    const server = createServer((request, response) => {
      void handleRequest(request, response).catch((error: unknown) => {
        sendApplicationError(response, error);
      });
    });

    async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
      setSecurityHeaders(response);
      const requestUrl = new URL(request.url ?? "/", origin ?? "http://127.0.0.1");
      const route = requestUrl.pathname;
      if (request.method === "GET" && route === "/api/v1/health") {
        sendJson(response, 200, { status: "ready" });
        return;
      }
      if (origin === undefined || !isAllowedHost(request.headers.host, origin)) {
        throw new ApplicationError("ORIGIN_NOT_ALLOWED", "The dashboard API accepts loopback hosts only.");
      }
      const isBootstrapRoute = route === "/api/v1/session/claim" ||
        (route === "/" && requestUrl.searchParams.has("token"));
      validateOrigin(request, origin, isBootstrapRoute);

      if (request.method === "GET" && route === "/") {
        if (requestUrl.searchParams.has("token")) {
          const session = claimLocalSession(requestUrl, bootstrapToken, bootstrapClaimed, bootstrapPrincipal.id, (claimedSession) => {
            localSessions.set(claimedSession.id, claimedSession);
            bootstrapClaimed = true;
          });
          setSessionCookie(response, session);
        }
        await sendStaticFile(response, "index.html", "text/html; charset=utf-8");
        return;
      }
      if (request.method === "GET" && route === "/dashboard.js") {
        await sendStaticFile(response, "dashboard.js", "text/javascript; charset=utf-8");
        return;
      }
      const moduleMatch = request.method === "GET" ? /^\/js\/([a-z][a-z-]*)\.js$/u.exec(route) : null;
      if (moduleMatch !== null) {
        await sendStaticFile(response, `js/${moduleMatch[1]}.js`, "text/javascript; charset=utf-8");
        return;
      }
      if (request.method === "GET" && route === "/dashboard.css") {
        await sendStaticFile(response, "dashboard.css", "text/css; charset=utf-8");
        return;
      }
      if (request.method === "GET" && route === "/api/v1/session/claim") {
        const session = claimLocalSession(requestUrl, bootstrapToken, bootstrapClaimed, bootstrapPrincipal.id, (claimedSession) => {
          localSessions.set(claimedSession.id, claimedSession);
          bootstrapClaimed = true;
        });
        setSessionCookie(response, session);
        sendJson(response, 200, { csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() });
        return;
      }

      if (request.method === "POST" && route === "/api/v1/session/login") {
        const input = dashboardLoginBodySchema.parse(await readJsonBody(request));
        const identity = resolveAuthKeySessionIdentity(database, input.authKey);
        if (identity === undefined) {
          throw new ApplicationError("SESSION_INVALID", "The supplied SSDD credential is invalid or revoked.");
        }
        const session = createDashboardSession(identity.principalId, identity.keyId);
        storeDashboardSession(localSessions, session);
        setSessionCookie(response, session);
        const authenticatedPrincipal = getDashboardPrincipal(database, identity.principalId);
        sendJson(response, 200, {
          principal: authenticatedPrincipal,
          projects: listProjects(database, identity.principalId),
          csrfToken: session.csrfToken,
          expiresAt: new Date(session.expiresAt).toISOString(),
        });
        return;
      }

      const session = requireLocalSession(request, localSessions, database);
      const principal = getDashboardPrincipal(database, session.principalId);
      if (request.method === "POST" && route === "/api/v1/session/logout") {
        assertSameOriginMutation(request, origin, session);
        localSessions.delete(session.id);
        clearSessionCookie(response);
        sendJson(response, 200, { loggedOut: true });
        return;
      }
      if (request.method === "GET" && route === "/api/v1/session") {
        sendJson(response, 200, {
          principal: getDashboardPrincipal(database, session.principalId),
          projects: listProjects(database, session.principalId),
          csrfToken: session.csrfToken,
          expiresAt: new Date(session.expiresAt).toISOString(),
        });
        return;
      }
      if (request.method === "GET" && route === "/api/v1/projects") {
        sendJson(response, 200, { projects: listProjects(database, session.principalId) });
        return;
      }

      const quickAccessMatch = /^\/api\/v1\/projects\/([^/]+)\/quick-access$/.exec(route);
      if (request.method === "GET" && quickAccessMatch !== null) {
        const projectId = parseUuid(decodePathSegment(quickAccessMatch[1]));
        sendJson(response, 200, getDashboardQuickAccess(database, { projectId, principalId: principal.id }));
        return;
      }

      const projectHistoryMatch = /^\/api\/v1\/projects\/([^/]+)\/history$/.exec(route);
      if (request.method === "GET" && projectHistoryMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectHistoryMatch[1]));
        const filters = parseProjectHistoryFilters(requestUrl.searchParams);
        sendJson(response, 200, getProjectHistorySnapshot(database, {
          projectId,
          principalId: principal.id,
          ...filters,
        }));
        return;
      }

      const dashboardMetricsMatch = /^\/api\/v1\/projects\/([^/]+)\/dashboard-metrics$/.exec(route);
      if (request.method === "GET" && dashboardMetricsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(dashboardMetricsMatch[1]));
        const filters = parseDashboardMetricsFilters(requestUrl.searchParams);
        const result = getProjectDashboardMetrics(database, {
          projectId,
          principalId: principal.id,
          ...filters,
        });
        sendJson(response, 200, result);
        return;
      }

      const featureRoadmapMatch = /^\/api\/v1\/projects\/([^/]+)\/feature-roadmap$/.exec(route);
      if (request.method === "GET" && featureRoadmapMatch !== null) {
        const projectId = parseUuid(decodePathSegment(featureRoadmapMatch[1]));
        const teamIdValue = requestUrl.searchParams.get("teamId") ?? undefined;
        const asOfDateValue = requestUrl.searchParams.get("asOfDate") ?? undefined;
        if (teamIdValue !== undefined && !z.string().uuid().safeParse(teamIdValue).success) {
          throw new ApplicationError("VALIDATION_FAILED", "Team ID must be a UUID.");
        }
        if (asOfDateValue !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(asOfDateValue)) {
          throw new ApplicationError("VALIDATION_FAILED", "Roadmap cutoff must use YYYY-MM-DD.");
        }
        sendJson(response, 200, getProjectFeatureRoadmap(database, {
          projectId,
          principalId: principal.id,
          ...(teamIdValue === undefined ? {} : { teamId: teamIdValue }),
          ...(asOfDateValue === undefined ? {} : { asOfDate: asOfDateValue }),
        }));
        return;
      }

      const developerMetricsMatch = /^\/api\/v1\/projects\/([^/]+)\/developer-execution-metrics$/.exec(route);
      if (request.method === "GET" && developerMetricsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(developerMetricsMatch[1]));
        const filters = parseDeveloperExecutionMetricFilters(requestUrl.searchParams);
        sendJson(response, 200, getDeveloperExecutionMetrics(database, { projectId, principalId: principal.id, ...filters }));
        return;
      }

      const developmentSessionsMatch = /^\/api\/v1\/projects\/([^/]+)\/development-sessions$/.exec(route);
      if (request.method === "GET" && developmentSessionsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(developmentSessionsMatch[1]));
        const filters = parseDevelopmentSessionFilters(requestUrl.searchParams);
        sendJson(response, 200, { sessions: listDevelopmentSessions(database, { projectId, principalId: principal.id, ...filters }) });
        return;
      }

      const deploymentEventsMatch = /^\/api\/v1\/projects\/([^/]+)\/deployment-events$/.exec(route);
      if (request.method === "GET" && deploymentEventsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(deploymentEventsMatch[1]));
        const filters = parseDeploymentEventFilters(requestUrl.searchParams);
        sendJson(response, 200, { events: listDeploymentEvents(database, { projectId, principalId: principal.id, ...filters }) });
        return;
      }

      const projectTeamsMatch = /^\/api\/v1\/projects\/([^/]+)\/teams$/.exec(route);
      if (request.method === "GET" && projectTeamsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectTeamsMatch[1]));
        sendJson(response, 200, { teams: listProjectTeams(database, projectId, principal.id) });
        return;
      }

      const projectQualityMatch = /^\/api\/v1\/projects\/([^/]+)\/quality$/.exec(route);
      if (request.method === "GET" && projectQualityMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectQualityMatch[1]));
        const page = parseListPageFilters(requestUrl.searchParams);
        sendJson(response, 200, listProjectQualitySummaries(database, { projectId, principalId: principal.id, ...page }));
        return;
      }

      const projectAuditMatch = /^\/api\/v1\/projects\/([^/]+)\/audit$/.exec(route);
      if (request.method === "GET" && projectAuditMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectAuditMatch[1]));
        sendJson(response, 200, listAuditEvents(database, {
          projectId,
          principalId: principal.id,
          ...parseAuditFilters(requestUrl.searchParams),
        }));
        return;
      }

      const projectSpecificationsMatch = /^\/api\/v1\/projects\/([^/]+)\/specifications$/.exec(route);
      if (request.method === "GET" && projectSpecificationsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectSpecificationsMatch[1]));
        const filters = parseSpecificationFilters(requestUrl.searchParams);
        sendJson(response, 200, listSpecifications(database, projectId, principal.id, filters));
        return;
      }

      const projectSpecificationMatch = /^\/api\/v1\/projects\/([^/]+)\/specifications\/([^/]+)$/.exec(route);
      if (request.method === "GET" && projectSpecificationMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectSpecificationMatch[1]));
        const specIdOrKey = decodePathSegment(projectSpecificationMatch[2]);
        sendJson(response, 200, { specification: getSpecification(database, projectId, principal.id, specIdOrKey) });
        return;
      }

      if (request.method === "POST" && projectSpecificationsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectSpecificationsMatch[1]));
        assertSameOriginMutation(request, origin, session);
        const input = createSpecificationBodySchema.parse(await readJsonBody(request));
        const receipt = createSpecification(database, { projectId, principalId: principal.id, ...input });
        sendJson(response, 201, { revision: receipt.value, auditEventIds: receipt.auditEventIds });
        return;
      }

      const specificationRevisionsMatch = /^\/api\/v1\/projects\/([^/]+)\/specifications\/([^/]+)\/revisions$/.exec(route);
      if (request.method === "POST" && specificationRevisionsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(specificationRevisionsMatch[1]));
        const specIdOrKey = decodePathSegment(specificationRevisionsMatch[2]);
        assertSameOriginMutation(request, origin, session);
        const input = proposeSpecificationBodySchema.parse(await readJsonBody(request));
        const receipt = proposeSpecificationRevision(database, { projectId, principalId: principal.id, specIdOrKey, ...input });
        sendJson(response, 200, { revision: receipt.value, auditEventIds: receipt.auditEventIds });
        return;
      }

      const specificationRevisionActionMatch = /^\/api\/v1\/projects\/([^/]+)\/specifications\/([^/]+)\/revisions\/(\d+)\/(publish|withdraw)$/.exec(route);
      if (request.method === "POST" && specificationRevisionActionMatch !== null) {
        const projectId = parseUuid(decodePathSegment(specificationRevisionActionMatch[1]));
        const specIdOrKey = decodePathSegment(specificationRevisionActionMatch[2]);
        const revisionNumber = Number(specificationRevisionActionMatch[3]);
        assertSameOriginMutation(request, origin, session);
        const body = await readJsonBody(request);
        const receipt = specificationRevisionActionMatch[4] === "publish"
          ? publishSpecificationRevision(database, { projectId, principalId: principal.id, specIdOrKey, revisionNumber, ...publishWorkItemRevisionBodySchema.parse(body) })
          : withdrawSpecificationRevision(database, { projectId, principalId: principal.id, specIdOrKey, revisionNumber, ...withdrawSpecificationBodySchema.parse(body) });
        sendJson(response, 200, { revision: receipt.value, auditEventIds: receipt.auditEventIds });
        return;
      }

      const adrLinkMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)\/adr-links$/.exec(route);
      if (request.method === "POST" && adrLinkMatch !== null) {
        const projectId = parseUuid(decodePathSegment(adrLinkMatch[1]));
        const taskIdOrKey = decodePathSegment(adrLinkMatch[2]);
        assertSameOriginMutation(request, origin, session);
        const input = linkAdrBodySchema.parse(await readJsonBody(request));
        const receipt = linkTaskToAdr(database, { projectId, principalId: principal.id, taskIdOrKey, ...input });
        sendJson(response, 201, { ...receipt.value, auditEventIds: receipt.auditEventIds });
        return;
      }

      const projectMatch = /^\/api\/v1\/projects\/([^/]+)$/.exec(route);
      if (request.method === "GET" && projectMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectMatch[1]));
        sendJson(response, 200, { project: getProject(database, principal.id, projectId) });
        return;
      }

      const projectWorkItemsMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items$/.exec(route);
      if (request.method === "GET" && projectWorkItemsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectWorkItemsMatch[1]));
        const filters = parseWorkItemFilters(requestUrl.searchParams);
        const page = listWorkItems(database, { projectId, principalId: principal.id, ...filters });
        sendJson(response, 200, page);
        return;
      }
      if (request.method === "POST" && projectWorkItemsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectWorkItemsMatch[1]));
        assertSameOriginMutation(request, origin, session);
        const input = createWorkItemBodySchema.parse(await readJsonBody(request));
        const receipt = createWorkItem(database, {
          projectId,
          principalId: principal.id,
          requestId: input.requestId,
          type: input.type,
          title: input.title,
          ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
          ...(input.relatedStoryId === undefined ? {} : { relatedStoryId: input.relatedStoryId }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.businessValueScore === undefined ? {} : { businessValueScore: input.businessValueScore }),
          ...(input.businessValueRationale === undefined ? {} : { businessValueRationale: input.businessValueRationale }),
          ...(input.criteria === undefined ? {} : { criteria: input.criteria.map((criterion) => ({
            description: criterion.description,
            ...(criterion.id === undefined ? {} : { id: criterion.id }),
            ...(criterion.required === undefined ? {} : { required: criterion.required }),
          })) }),
        });
        sendJson(response, 201, { workItem: receipt.value, auditEventIds: receipt.auditEventIds });
        return;
      }

      const projectScenariosMatch = /^\/api\/v1\/projects\/([^/]+)\/scenarios$/.exec(route);
      if (request.method === "GET" && projectScenariosMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectScenariosMatch[1]));
        const page = parseListPageFilters(requestUrl.searchParams);
        sendJson(response, 200, listScenarios(database, projectId, principal.id, page));
        return;
      }
      if (request.method === "POST" && projectScenariosMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectScenariosMatch[1]));
        assertSameOriginMutation(request, origin, session);
        const input = createScenarioBodySchema.parse(await readJsonBody(request));
        const receipt = createScenario(database, {
          projectId,
          principalId: principal.id,
          requestId: input.requestId,
          key: input.key,
          kind: input.kind,
          title: input.title,
          steps: input.steps,
          ...(input.preconditions === undefined ? {} : { preconditions: input.preconditions }),
          ...(input.coverage === undefined ? {} : { coverage: input.coverage }),
          ...(input.workItemIdOrKeys === undefined ? {} : { workItemIdOrKeys: input.workItemIdOrKeys }),
        });
        sendJson(response, 201, { revision: receipt.value, auditEventIds: receipt.auditEventIds });
        return;
      }

      const projectTestRunsMatch = /^\/api\/v1\/projects\/([^/]+)\/test-runs$/.exec(route);
      if (request.method === "GET" && projectTestRunsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectTestRunsMatch[1]));
        const filters = parseTestRunFilters(requestUrl.searchParams);
        sendJson(response, 200, listTestRunPage(database, projectId, principal.id, filters));
        return;
      }

      const projectScenarioMatch = /^\/api\/v1\/projects\/([^/]+)\/scenarios\/([^/]+)$/.exec(route);
      if (request.method === "GET" && projectScenarioMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectScenarioMatch[1]));
        const scenarioIdOrKey = decodePathSegment(projectScenarioMatch[2]);
        sendJson(response, 200, { scenario: getScenario(database, projectId, principal.id, scenarioIdOrKey) });
        return;
      }

      const scenarioRevisionWorkItemsMatch = /^\/api\/v1\/projects\/([^/]+)\/scenarios\/([^/]+)\/revisions\/(\d+)\/work-items$/.exec(route);
      if (request.method === "GET" && scenarioRevisionWorkItemsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(scenarioRevisionWorkItemsMatch[1]));
        const scenarioIdOrKey = decodePathSegment(scenarioRevisionWorkItemsMatch[2]);
        const revisionNumber = Number(scenarioRevisionWorkItemsMatch[3]);
        sendJson(response, 200, { workItems: listScenarioRevisionWorkItems(database, projectId, principal.id, scenarioIdOrKey, revisionNumber) });
        return;
      }

      const scenarioRevisionMatch = /^\/api\/v1\/projects\/([^/]+)\/scenarios\/([^/]+)\/revisions$/.exec(route);
      if (request.method === "POST" && scenarioRevisionMatch !== null) {
        const projectId = parseUuid(decodePathSegment(scenarioRevisionMatch[1]));
        const scenarioIdOrKey = decodePathSegment(scenarioRevisionMatch[2]);
        assertSameOriginMutation(request, origin, session);
        const input = proposeScenarioRevisionBodySchema.parse(await readJsonBody(request));
        const receipt = proposeScenarioRevision(database, {
          projectId,
          principalId: principal.id,
          scenarioIdOrKey,
          requestId: input.requestId,
          expectedVersion: input.expectedVersion,
          title: input.title,
          steps: input.steps,
          ...(input.preconditions === undefined ? {} : { preconditions: input.preconditions }),
          ...(input.coverage === undefined ? {} : { coverage: input.coverage }),
          ...(input.workItemIdOrKeys === undefined ? {} : { workItemIdOrKeys: input.workItemIdOrKeys }),
        });
        sendJson(response, 200, { revision: receipt.value, auditEventIds: receipt.auditEventIds });
        return;
      }

      const scenarioPublishMatch = /^\/api\/v1\/projects\/([^/]+)\/scenarios\/([^/]+)\/revisions\/(\d+)\/publish$/.exec(route);
      if (request.method === "POST" && scenarioPublishMatch !== null) {
        const projectId = parseUuid(decodePathSegment(scenarioPublishMatch[1]));
        const scenarioIdOrKey = decodePathSegment(scenarioPublishMatch[2]);
        assertSameOriginMutation(request, origin, session);
        const input = publishScenarioRevisionBodySchema.parse(await readJsonBody(request));
        const revisionNumber = Number(scenarioPublishMatch[3]);
        const receipt = publishScenarioRevision(database, {
          projectId, principalId: principal.id, scenarioIdOrKey, revisionNumber, ...input,
        });
        sendJson(response, 200, { revision: receipt.value, auditEventIds: receipt.auditEventIds });
        return;
      }

      const scenarioTestRunsMatch = /^\/api\/v1\/projects\/([^/]+)\/scenarios\/([^/]+)\/test-runs$/.exec(route);
      if (request.method === "POST" && scenarioTestRunsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(scenarioTestRunsMatch[1]));
        const scenarioIdOrKey = decodePathSegment(scenarioTestRunsMatch[2]);
        assertSameOriginMutation(request, origin, session);
        const input = recordTestRunBodySchema.parse(await readJsonBody(request));
        const receipt = recordTestRun(database, {
          projectId,
          principalId: principal.id,
          scenarioIdOrKey,
          requestId: input.requestId,
          revisionNumber: input.revisionNumber,
          buildId: input.buildId,
          result: input.result,
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          ...(input.evidenceUri === undefined ? {} : { evidenceUri: input.evidenceUri }),
          ...(input.workItemIdOrKeys === undefined ? {} : { workItemIdOrKeys: input.workItemIdOrKeys }),
        });
        sendJson(response, 201, { run: receipt.value, auditEventIds: receipt.auditEventIds });
        return;
      }

      const workItemRevisionsMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)\/revisions$/.exec(route);
      if (request.method === "GET" && workItemRevisionsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(workItemRevisionsMatch[1]));
        const itemIdOrKey = decodePathSegment(workItemRevisionsMatch[2]);
        sendJson(response, 200, { revisions: listWorkItemRevisions(database, projectId, principal.id, itemIdOrKey) });
        return;
      }

      const workItemRevisionProposalMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)\/revisions$/.exec(route);
      if (request.method === "POST" && workItemRevisionProposalMatch !== null) {
        const projectId = parseUuid(decodePathSegment(workItemRevisionProposalMatch[1]));
        const itemIdOrKey = decodePathSegment(workItemRevisionProposalMatch[2]);
        assertSameOriginMutation(request, origin, session);
        const input = proposeWorkItemRevisionBodySchema.parse(await readJsonBody(request));
        const receipt = proposeWorkItemRevision(database, {
          projectId,
          principalId: principal.id,
          itemIdOrKey,
          requestId: input.requestId,
          expectedVersion: input.expectedVersion,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.businessValueScore === undefined ? {} : { businessValueScore: input.businessValueScore }),
          ...(input.businessValueRationale === undefined ? {} : { businessValueRationale: input.businessValueRationale }),
          ...(input.criteria === undefined ? {} : { criteria: input.criteria.map((criterion) => ({
            description: criterion.description,
            ...(criterion.id === undefined ? {} : { id: criterion.id }),
            ...(criterion.required === undefined ? {} : { required: criterion.required }),
          })) }),
        });
        sendJson(response, 200, { revision: receipt.value, auditEventIds: receipt.auditEventIds });
        return;
      }

      const workItemRevisionPublishMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)\/revisions\/(\d+)\/publish$/.exec(route);
      if (request.method === "POST" && workItemRevisionPublishMatch !== null) {
        const projectId = parseUuid(decodePathSegment(workItemRevisionPublishMatch[1]));
        const itemIdOrKey = decodePathSegment(workItemRevisionPublishMatch[2]);
        assertSameOriginMutation(request, origin, session);
        const input = publishWorkItemRevisionBodySchema.parse(await readJsonBody(request));
        const revisionNumber = Number(workItemRevisionPublishMatch[3]);
        const receipt = publishWorkItemRevision(database, { projectId, principalId: principal.id, itemIdOrKey, revisionNumber, ...input });
        sendJson(response, 200, { revision: receipt.value, auditEventIds: receipt.auditEventIds });
        return;
      }

      const workItemQualityMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)\/quality$/.exec(route);
      if (request.method === "GET" && workItemQualityMatch !== null) {
        const projectId = parseUuid(decodePathSegment(workItemQualityMatch[1]));
        const itemIdOrKey = decodePathSegment(workItemQualityMatch[2]);
        const filters = parseEvidenceFilters(requestUrl.searchParams);
        sendJson(response, 200, { quality: getWorkItemQualityReport(database, {
          projectId,
          principalId: principal.id,
          itemIdOrKey,
          ...filters,
        }) });
        return;
      }

      const workItemContextMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)\/context$/.exec(route);
      if (request.method === "GET" && workItemContextMatch !== null) {
        const projectId = parseUuid(decodePathSegment(workItemContextMatch[1]));
        const taskIdOrKey = decodePathSegment(workItemContextMatch[2]);
        sendJson(response, 200, getTaskContext(database, {
          projectId,
          principalId: principal.id,
          taskIdOrKey,
          ...parseTaskContextFilters(requestUrl.searchParams),
        }));
        return;
      }

      const workItemTimelineMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)\/timeline$/.exec(route);
      if (request.method === "GET" && workItemTimelineMatch !== null) {
        const projectId = parseUuid(decodePathSegment(workItemTimelineMatch[1]));
        const itemIdOrKey = decodePathSegment(workItemTimelineMatch[2]);
        const item = getWorkItem(database, projectId, principal.id, itemIdOrKey);
        const filters = parseAuditFilters(requestUrl.searchParams);
        const page = listAuditEvents(database, {
          projectId,
          principalId: principal.id,
          entityType: "work_item",
          entityId: item.id,
          ...(filters.limit === undefined ? {} : { limit: filters.limit }),
          ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
        });
        sendJson(response, 200, page);
        return;
      }

      const projectWorkItemMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)$/.exec(route);
      if (request.method === "GET" && projectWorkItemMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectWorkItemMatch[1]));
        const itemIdOrKey = decodePathSegment(projectWorkItemMatch[2]);
        sendJson(response, 200, { workItem: getWorkItem(database, projectId, principal.id, itemIdOrKey) });
        return;
      }

      const backlogOperationMatch = /^\/api\/v1\/projects\/([^/]+)\/backlog\/([a-z_]+)$/.exec(route);
      if (request.method === "POST" && backlogOperationMatch !== null) {
        const projectId = parseUuid(decodePathSegment(backlogOperationMatch[1]));
        const handler = backlogOperations[backlogOperationMatch[2] ?? ""];
        if (handler === undefined) throw new ApplicationError("NOT_FOUND", "Unknown backlog operation.");
        assertSameOriginMutation(request, origin, session);
        sendJson(response, 200, handler(database, projectId, principal.id, await readJsonBody(request)));
        return;
      }

      const commentsMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)\/comments$/.exec(route);
      if (request.method === "GET" && commentsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(commentsMatch[1]));
        const page = parseListPageFilters(requestUrl.searchParams);
        sendJson(response, 200, listWorkItemComments(database, { projectId, principalId: principal.id, itemIdOrKey: decodePathSegment(commentsMatch[2]), ...page }));
        return;
      }

      const traceMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)\/trace$/.exec(route);
      if (request.method === "GET" && traceMatch !== null) {
        const projectId = parseUuid(decodePathSegment(traceMatch[1]));
        sendJson(response, 200, queryTraceGraph(database, { projectId, principalId: principal.id, nodeIdOrKey: decodePathSegment(traceMatch[2]) }));
        return;
      }

      const planningMatch = /^\/api\/v1\/projects\/([^/]+)\/planning\/([a-z_]+)$/.exec(route);
      if (request.method === "POST" && planningMatch !== null) {
        const projectId = parseUuid(decodePathSegment(planningMatch[1]));
        const operation = planningMatch[2] ?? "";
        const handler = planningOperations[operation];
        if (handler === undefined) throw new ApplicationError("NOT_FOUND", "Unknown planning operation.");
        assertSameOriginMutation(request, origin, session);
        const body = await readJsonBody(request);
        const result = handler(database, projectId, principal.id, body);
        sendJson(response, 200, result);
        return;
      }

      const projectSprintsMatch = /^\/api\/v1\/projects\/([^/]+)\/sprints$/.exec(route);
      if (request.method === "GET" && projectSprintsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectSprintsMatch[1]));
        const filters = parseSprintFilters(requestUrl.searchParams);
        sendJson(response, 200, { sprints: listSprints(database, projectId, principal.id, filters) });
        return;
      }

      const sprintRetrospectiveMatch = /^\/api\/v1\/projects\/([^/]+)\/sprints\/([^/]+)\/retrospective$/.exec(route);
      if (request.method === "GET" && sprintRetrospectiveMatch !== null) {
        const projectId = parseUuid(decodePathSegment(sprintRetrospectiveMatch[1]));
        const sprintIdOrKey = decodePathSegment(sprintRetrospectiveMatch[2]);
        const revisionParameter = requestUrl.searchParams.get("revisionNumber");
        const revisionNumber = revisionParameter === null ? undefined : Number(revisionParameter);
        sendJson(response, 200, { retrospective: getSprintRetrospective(database, {
          projectId,
          principalId: principal.id,
          sprintIdOrKey,
          ...(revisionNumber === undefined ? {} : { revisionNumber }),
        }) });
        return;
      }
      if (request.method === "POST" && sprintRetrospectiveMatch !== null) {
        const projectId = parseUuid(decodePathSegment(sprintRetrospectiveMatch[1]));
        const sprintIdOrKey = decodePathSegment(sprintRetrospectiveMatch[2]);
        assertSameOriginMutation(request, origin, session);
        const body = await readJsonBody(request);
        const input = sprintRetrospectiveBodySchema.parse(body);
        const receipt = setSprintRetrospective(database, {
          projectId,
          principalId: principal.id,
          sprintIdOrKey,
          ...input,
        });
        sendJson(response, 200, { retrospective: receipt.value, auditEventIds: receipt.auditEventIds });
        return;
      }

      const sprintMatch = /^\/api\/v1\/projects\/([^/]+)\/sprints\/([^/]+)$/.exec(route);
      if (request.method === "GET" && sprintMatch !== null) {
        const projectId = parseUuid(decodePathSegment(sprintMatch[1]));
        const sprintIdOrKey = decodePathSegment(sprintMatch[2]);
        sendJson(response, 200, { sprint: getSprint(database, projectId, principal.id, sprintIdOrKey) });
        return;
      }

      const transitionMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)\/transition$/.exec(route);
      const taskWorkflowMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)\/task-workflow$/.exec(route);
      if (request.method === "GET" && taskWorkflowMatch !== null) {
        const projectId = parseUuid(decodePathSegment(taskWorkflowMatch[1]));
        const taskIdOrKey = decodePathSegment(taskWorkflowMatch[2]);
        const revisionValue = requestUrl.searchParams.get("revisionNumber");
        const revisionNumber = revisionValue === null ? undefined : Number(revisionValue);
        const workflow = getTaskWorkflow(database, {
          projectId, principalId: principal.id, taskIdOrKey,
          ...(revisionNumber === undefined ? {} : { revisionNumber }),
        });
        sendJson(response, 200, { workflow });
        return;
      }

      const taskWorkflowRevisionsMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)\/task-workflow\/revisions$/.exec(route);
      if (request.method === "POST" && taskWorkflowRevisionsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(taskWorkflowRevisionsMatch[1]));
        const taskIdOrKey = decodePathSegment(taskWorkflowRevisionsMatch[2]);
        assertSameOriginMutation(request, origin, session);
        const input = taskWorkflowProposalBodySchema.parse(await readJsonBody(request));
        const receipt = proposeTaskWorkflow(database, {
          projectId, principalId: principal.id, taskIdOrKey,
          requestId: input.requestId, expectedTaskVersion: input.expectedTaskVersion,
          expectedWorkflowVersion: input.expectedWorkflowVersion, reason: input.reason,
          steps: input.steps.map((step) => ({
            title: step.title, description: step.description, effortPercent: step.effortPercent,
            ...(step.id === undefined ? {} : { id: step.id }),
          })),
        });
        sendJson(response, 200, { workflow: receipt.value, auditEventIds: receipt.auditEventIds });
        return;
      }

      const taskWorkflowPublishMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)\/task-workflow\/revisions\/(\d+)\/publish$/.exec(route);
      if (request.method === "POST" && taskWorkflowPublishMatch !== null) {
        const projectId = parseUuid(decodePathSegment(taskWorkflowPublishMatch[1]));
        const taskIdOrKey = decodePathSegment(taskWorkflowPublishMatch[2]);
        const revisionNumber = Number(taskWorkflowPublishMatch[3]);
        assertSameOriginMutation(request, origin, session);
        const input = taskWorkflowPublishBodySchema.parse(await readJsonBody(request));
        const receipt = publishTaskWorkflow(database, {
          projectId, principalId: principal.id, taskIdOrKey, revisionNumber,
          requestId: input.requestId, expectedTaskVersion: input.expectedTaskVersion, reason: input.reason,
        });
        sendJson(response, 200, { ...receipt.value, auditEventIds: receipt.auditEventIds });
        return;
      }

      const taskWorkflowStepMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)\/task-workflow\/steps\/([^/]+)\/status$/.exec(route);
      if (request.method === "POST" && taskWorkflowStepMatch !== null) {
        const projectId = parseUuid(decodePathSegment(taskWorkflowStepMatch[1]));
        const taskIdOrKey = decodePathSegment(taskWorkflowStepMatch[2]);
        const stepId = parseUuid(decodePathSegment(taskWorkflowStepMatch[3]));
        assertSameOriginMutation(request, origin, session);
        const input = taskWorkflowStepBodySchema.parse(await readJsonBody(request));
        const receipt = transitionTaskWorkflowStep(database, {
          projectId, principalId: principal.id, taskIdOrKey, stepId,
          requestId: input.requestId, revisionNumber: input.revisionNumber,
          expectedTaskVersion: input.expectedTaskVersion, targetStatus: input.targetStatus, reason: input.reason,
        });
        sendJson(response, 200, { transition: receipt.value, auditEventIds: receipt.auditEventIds });
        return;
      }

      const taskStartReadinessMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)\/start-readiness$/.exec(route);
      if (request.method === "GET" && taskStartReadinessMatch !== null) {
        const projectId = parseUuid(decodePathSegment(taskStartReadinessMatch[1]));
        const itemIdOrKey = decodePathSegment(taskStartReadinessMatch[2]);
        sendJson(response, 200, { readiness: getTaskStartReadiness(database, {
          projectId, principalId: principal.id, itemIdOrKey,
        }) });
        return;
      }

      const taskClaimMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)\/claim$/.exec(route);
      if (request.method === "POST" && taskClaimMatch !== null) {
        const projectId = parseUuid(decodePathSegment(taskClaimMatch[1]));
        const itemIdOrKey = decodePathSegment(taskClaimMatch[2]);
        assertSameOriginMutation(request, origin, session);
        const input = taskClaimBodySchema.parse(await readJsonBody(request));
        const receipt = claimTaskForDevelopment(database, {
          projectId,
          principalId: principal.id,
          itemIdOrKey,
          requestId: input.requestId,
          expectedVersion: input.expectedVersion,
          reason: input.reason,
        });
        sendJson(response, 200, { task: receipt.value, auditEventIds: receipt.auditEventIds });
        return;
      }

      const taskStartMatch = /^\/api\/v1\/projects\/([^/]+)\/work-items\/([^/]+)\/start$/.exec(route);
      if (request.method === "POST" && taskStartMatch !== null) {
        const projectId = parseUuid(decodePathSegment(taskStartMatch[1]));
        const itemIdOrKey = decodePathSegment(taskStartMatch[2]);
        assertSameOriginMutation(request, origin, session);
        const body = await readJsonBody(request);
        const input = taskStartBodySchema.parse(body);
        const receipt = startTaskDevelopment(database, {
          projectId, principalId: principal.id, itemIdOrKey,
          requestId: input.requestId, expectedVersion: input.expectedVersion, reason: input.reason,
          ...(input.sessionReference === undefined ? {} : { sessionReference: input.sessionReference }),
        });
        const { operationAuditEventIds, ...result } = receipt.value;
        sendJson(response, 200, { ...result, auditEventIds: [...operationAuditEventIds, ...receipt.auditEventIds] });
        return;
      }

      if (request.method === "POST" && transitionMatch !== null) {
        const projectId = parseUuid(decodePathSegment(transitionMatch[1]));
        const itemIdOrKey = decodePathSegment(transitionMatch[2]);
        assertSameOriginMutation(request, origin, session);
        const body = await readJsonBody(request);
        const input = transitionBodySchema.parse(body);
        const receipt = transitionWorkItem(database, {
          projectId,
          principalId: principal.id,
          itemIdOrKey,
          requestId: input.requestId,
          targetState: input.targetState,
          expectedVersion: input.expectedVersion,
          reason: input.reason,
          ...(input.buildId === undefined ? {} : { buildId: input.buildId }),
        });
        sendJson(response, 200, { transition: receipt.value, auditEventIds: receipt.auditEventIds });
        return;
      }

      if (request.method !== "GET" && request.method !== "POST") {
        throw new ApplicationError("METHOD_NOT_ALLOWED", "The dashboard API method is not supported.");
      }
      throw new ApplicationError("NOT_FOUND", "The dashboard API route was not found.");
    }

    const handle: DashboardApiServer = {
      server,
      bootstrapToken,
      close: () => closeServer(server, database),
    };
    server.on("listening", () => {
      const address = server.address();
      if (address !== null && typeof address !== "string") origin = `http://127.0.0.1:${address.port}`;
    });
    return handle;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function listenDashboardApiServer(
  handle: DashboardApiServer,
  port = 4318,
): Promise<DashboardApiAddress> {
  return new Promise((resolveAddress, reject) => {
    const onError = (error: Error): void => reject(error);
    handle.server.once("error", onError);
    handle.server.listen(port, "127.0.0.1", () => {
      handle.server.off("error", onError);
      const address = handle.server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Dashboard API did not bind to a TCP port."));
        return;
      }
      resolveAddress({ host: "127.0.0.1", port: address.port, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

export async function startDashboardServer(
  workspace: string,
  port = 4318,
  writeLine: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): Promise<DashboardApiServer> {
  const handle = createDashboardApiServer(workspace);
  try {
    const { origin } = await listenDashboardApiServer(handle, port);
    writeLine(`Dashboard: ${origin}/?token=${encodeURIComponent(handle.bootstrapToken)}`);
    writeLine(`Dashboard API: ${origin}/api/v1`);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

const transitionBodySchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  targetState: z.enum(workItemStates),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1_000),
  buildId: z.string().trim().min(1).max(128).optional(),
});

const taskStartBodySchema = z.object({
  requestId: z.string().trim().min(1).max(100),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1_000),
  sessionReference: z.string().trim().min(1).max(160).optional(),
});

const taskClaimBodySchema = z.object({
  requestId: z.string().trim().min(1).max(100),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1_000),
});

const taskWorkflowProposalBodySchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  expectedTaskVersion: z.number().int().positive(),
  expectedWorkflowVersion: z.number().int().nonnegative(),
  steps: z.array(z.object({ id: z.string().uuid().optional(), title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(4_000), effortPercent: z.number().positive().max(100) })).min(1).max(50),
  reason: z.string().trim().min(1).max(1_000),
});

const taskWorkflowPublishBodySchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  expectedTaskVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1_000),
});

const taskWorkflowStepBodySchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  revisionNumber: z.number().int().positive(),
  expectedTaskVersion: z.number().int().positive(),
  targetStatus: z.enum(["pending", "in_progress", "done"]),
  reason: z.string().trim().min(1).max(1_000),
});

const dashboardLoginBodySchema = z.object({
  authKey: z.string().trim().min(1).max(64),
});

const sprintRetrospectiveBodySchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  expectedVersion: z.number().int().nonnegative(),
  summary: z.string().trim().min(1).max(2_000),
  keepDoing: z.array(z.string().trim().min(1).max(500)).max(20),
  stopDoing: z.array(z.string().trim().min(1).max(500)).max(20),
  tryNext: z.array(z.string().trim().min(1).max(500)).max(20),
  actions: z.array(z.object({
    id: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(300),
    ownerPrincipalId: z.string().uuid(),
    linkedWorkItemIdOrKey: z.string().trim().min(1).max(80).optional(),
  })).max(50),
  reason: z.string().trim().min(1).max(1_000),
});

const workItemCriteriaBodySchema = z.array(z.object({
  id: z.string().uuid().optional(),
  description: z.string().trim().min(1).max(1_000),
  required: z.boolean().optional(),
})).max(100);

const createWorkItemBodySchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  type: z.enum(workItemTypes),
  parentId: z.string().trim().min(1).max(80).optional(),
  relatedStoryId: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).optional(),
  priority: z.number().int().min(1).max(4).optional(),
  businessValueScore: z.number().int().min(0).max(100).nullable().optional(),
  businessValueRationale: z.string().trim().max(1000).nullable().optional(),
  criteria: workItemCriteriaBodySchema.optional(),
});

const proposeWorkItemRevisionBodySchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  expectedVersion: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10_000).nullable().optional(),
  priority: z.number().int().min(1).max(4).optional(),
  businessValueScore: z.number().int().min(0).max(100).nullable().optional(),
  businessValueRationale: z.string().trim().max(1000).nullable().optional(),
  criteria: workItemCriteriaBodySchema.optional(),
});

const specificationContentBodySchema = z.record(z.string(), z.json()).refine((content) => Object.keys(content).length > 0, "Specification content must be a non-empty JSON object.");
const createSpecificationBodySchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  key: z.string().trim().min(1).max(32),
  kind: z.enum(specificationKinds),
  title: z.string().trim().min(1).max(200),
  content: specificationContentBodySchema,
});
const proposeSpecificationBodySchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  expectedVersion: z.number().int().positive(),
  content: specificationContentBodySchema,
});
const withdrawSpecificationBodySchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1000),
});
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const requestIdField = z.string().trim().min(1).max(128);
const reasonField = z.string().trim().min(1).max(1_000);
const references = z.array(z.string().trim().min(1).max(80)).max(100);
const teamCapacityBody = z.object({
  requestId: requestIdField,
  teamName: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).max(100),
  hoursPerDay: z.number().positive().max(24),
  workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  members: z.array(z.object({
    principalId: z.string().uuid(),
    dedicationPercent: z.number().min(0).max(100),
    activeFrom: isoDate.optional(),
    activeUntil: isoDate.optional(),
  })).min(1).max(100),
  holidays: z.array(z.object({ date: isoDate, label: z.string().trim().min(1).max(200) })).max(500).optional(),
  absences: z.array(z.object({ principalId: z.string().uuid(), date: isoDate, hours: z.number().min(0).max(24), reason: z.string().trim().min(1).max(200) })).max(5_000).optional(),
  reason: reasonField,
}).strict();
const sprintStateBody = z.object({ requestId: requestIdField, sprintIdOrKey: z.string().trim().min(1).max(80), expectedVersion: z.number().int().positive(), reason: reasonField }).strict();
/** Drops undefined optionals so parsed bodies satisfy exactOptionalPropertyTypes inputs. */
function compact<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}
type PlanningHandler = (database: SqliteDatabase, projectId: string, principalId: string, body: unknown) => unknown;
const receiptJson = (value: unknown, key: string, auditEventIds: readonly string[]) => ({ [key]: value, auditEventIds });
const planningOperations: Record<string, PlanningHandler> = {
  team_create: (database, projectId, principalId, body) => {
    const input = teamCapacityBody.parse(body);
    const receipt = createTeamCapacityConfiguration(database, compact({ projectId, principalId, ...input }));
    return receiptJson(receipt.value, "configuration", receipt.auditEventIds);
  },
  team_capacity_set: (database, projectId, principalId, body) => {
    const input = teamCapacityBody.extend({ expectedVersion: z.number().int().min(0), teamId: z.string().uuid().optional() }).parse(body);
    const receipt = setTeamCapacityConfiguration(database, compact({ projectId, principalId, ...input }));
    return receiptJson(receipt.value, "configuration", receipt.auditEventIds);
  },
  definition_of_done_set: (database, projectId, principalId, body) => {
    const input = z.object({
      requestId: requestIdField, expectedVersion: z.number().int().min(0), reason: reasonField,
      criteria: z.array(z.object({ id: z.string().uuid().optional(), description: z.string().trim().min(1).max(500) })).min(1).max(50),
    }).strict().parse(body);
    const receipt = setDefinitionOfDone(database, { projectId, principalId, ...input });
    return receiptJson(receipt.value, "revision", receipt.auditEventIds);
  },
  milestone_create: (database, projectId, principalId, body) => {
    const input = z.object({
      requestId: requestIdField, milestoneKey: z.string().trim().min(1).max(32), title: z.string().trim().min(1).max(120),
      goal: z.string().trim().min(1).max(1_000), targetDate: isoDate, itemIdsOrKeys: references.min(1), reason: reasonField,
    }).strict().parse(body);
    const receipt = createMilestone(database, { projectId, principalId, ...input });
    return receiptJson(receipt.value, "milestone", receipt.auditEventIds);
  },
  milestone_scope_change: (database, projectId, principalId, body) => {
    const input = z.object({
      requestId: requestIdField, milestoneIdOrKey: z.string().trim().min(1).max(80), expectedVersion: z.number().int().positive(),
      addItemIdsOrKeys: references.optional(), removeItemIdsOrKeys: references.optional(), reason: reasonField,
    }).strict().parse(body);
    const receipt = changeMilestoneScope(database, { projectId, principalId, ...input });
    return receiptJson(receipt.value, "milestone", receipt.auditEventIds);
  },
  sprint_draft: (database, projectId, principalId, body) => {
    const input = z.object({
      requestId: requestIdField, teamId: z.string().uuid().optional(), sprintKey: z.string().trim().min(1).max(32),
      title: z.string().trim().min(1).max(120), goal: reasonField, startsOn: isoDate, endsOn: isoDate,
      itemIdsOrKeys: references.min(1), capacityConfigVersion: z.number().int().positive().optional(),
      definitionOfDoneRevision: z.number().int().positive().optional(), reason: reasonField,
    }).strict().parse(body);
    const receipt = createSprintDraft(database, compact({ projectId, principalId, ...input }));
    return receiptJson(receipt.value, "sprint", receipt.auditEventIds);
  },
  sprint_scope_change: (database, projectId, principalId, body) => {
    const input = z.object({
      requestId: requestIdField, sprintIdOrKey: z.string().trim().min(1).max(80), expectedVersion: z.number().int().positive(),
      addItemIdsOrKeys: references.optional(), removeItemIdsOrKeys: references.optional(), reason: reasonField,
    }).strict().parse(body);
    const receipt = changeSprintScope(database, { projectId, principalId, ...input });
    return receiptJson(receipt.value, "sprint", receipt.auditEventIds);
  },
  sprint_start: (database, projectId, principalId, body) => {
    const receipt = startSprint(database, { projectId, principalId, ...sprintStateBody.parse(body) });
    return receiptJson(receipt.value, "sprint", receipt.auditEventIds);
  },
  sprint_cancel: (database, projectId, principalId, body) => {
    const receipt = cancelSprint(database, { projectId, principalId, ...sprintStateBody.parse(body) });
    return receiptJson(receipt.value, "sprint", receipt.auditEventIds);
  },
  sprint_close: (database, projectId, principalId, body) => {
    const input = sprintStateBody.extend({ acceptedItemIds: z.array(z.string().uuid()).max(100), reviewSummary: z.string().trim().min(1).max(2_000) }).parse(body);
    const receipt = closeSprint(database, { projectId, principalId, ...input });
    return receiptJson(receipt.value, "sprint", receipt.auditEventIds);
  },
};

const itemRef = z.string().trim().min(1).max(80);
const backlogOperations: Record<string, PlanningHandler> = {
  work_item_assign: (database, projectId, principalId, body) => {
    const input = z.object({ requestId: requestIdField, itemIdOrKey: itemRef, assigneeId: z.string().uuid().nullable(), expectedVersion: z.number().int().positive() }).strict().parse(body);
    const receipt = assignWorkItem(database, { projectId, principalId, ...input });
    return receiptJson(receipt.value, "assignment", receipt.auditEventIds);
  },
  work_item_rank: (database, projectId, principalId, body) => {
    const input = z.object({ requestId: requestIdField, itemIdOrKey: itemRef, beforeIdOrKey: itemRef.optional(), afterIdOrKey: itemRef.optional(), expectedVersion: z.number().int().positive() }).strict()
      .refine((value) => (value.beforeIdOrKey === undefined) !== (value.afterIdOrKey === undefined), { message: "Specify exactly one beforeIdOrKey or afterIdOrKey." }).parse(body);
    const receipt = rankWorkItem(database, compact({ projectId, principalId, ...input }));
    return receiptJson(receipt.value, "rank", receipt.auditEventIds);
  },
  comment_add: (database, projectId, principalId, body) => {
    const input = z.object({ requestId: requestIdField, itemIdOrKey: itemRef, body: z.string().trim().min(1).max(5_000) }).strict().parse(body);
    const receipt = addWorkItemComment(database, { projectId, principalId, ...input });
    return receiptJson(receipt.value, "comment", receipt.auditEventIds);
  },
  work_item_estimate: (database, projectId, principalId, body) => {
    const input = z.object({
      requestId: requestIdField, itemIdOrKey: itemRef, unit: z.enum(["points", "hours"]), value: z.number().int().min(1).max(10_000),
      rationale: reasonField, expectedVersion: z.number().int().positive(),
    }).strict().parse(body);
    const receipt = proposeWorkItemEstimate(database, { projectId, principalId, ...input });
    return receiptJson(receipt.value, "proposal", receipt.auditEventIds);
  },
  work_item_estimate_confirm: (database, projectId, principalId, body) => {
    const input = z.object({ requestId: requestIdField, itemIdOrKey: itemRef, proposalId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict().parse(body);
    const receipt = confirmWorkItemEstimate(database, { projectId, principalId, ...input });
    return { ...receipt.value, auditEventIds: receipt.auditEventIds };
  },
  test_run_certify: (database, projectId, principalId, body) => {
    const input = z.object({ requestId: requestIdField, itemIdOrKey: itemRef, runId: z.string().uuid(), expectedVersion: z.number().int().positive(), reason: reasonField }).strict().parse(body);
    const receipt = certifyTestRun(database, { projectId, principalId, ...input });
    return receiptJson(receipt.value, "certification", receipt.auditEventIds);
  },
  trace_link_add: (database, projectId, principalId, body) => {
    const input = z.object({ requestId: requestIdField, sourceIdOrKey: itemRef, targetIdOrKey: itemRef, type: z.enum(traceLinkTypes) }).strict().parse(body);
    const receipt = addTraceLink(database, { projectId, principalId, ...input });
    return receiptJson(receipt.value, "link", receipt.auditEventIds);
  },
  trace_link_remove: (database, projectId, principalId, body) => {
    const input = z.object({ requestId: requestIdField, linkId: z.string().uuid() }).strict().parse(body);
    const receipt = removeTraceLink(database, { projectId, principalId, ...input });
    return receiptJson(receipt.value, "link", receipt.auditEventIds);
  },
};

const linkAdrBodySchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  adrIdOrKey: z.string().trim().min(1).max(80),
  relationship: z.enum(["implements", "relates_to"]).default("implements"),
});

const publishWorkItemRevisionBodySchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  expectedVersion: z.number().int().positive(),
});

const scenarioContentBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  preconditions: z.array(z.string().trim().min(1).max(1_000)).max(100).optional(),
  steps: z.array(z.object({
    action: z.string().trim().min(1).max(1_000),
    expected: z.string().trim().min(1).max(1_000),
  })).min(1).max(100),
  coverage: z.array(z.object({
    targetType: z.enum(["criterion", "specification"]),
    reference: z.string().trim().min(1).max(128),
  })).max(100).optional(),
  workItemIdOrKeys: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
});

const createScenarioBodySchema = scenarioContentBodySchema.extend({
  requestId: z.string().trim().min(1).max(128),
  key: z.string().trim().min(1).max(32),
  kind: z.enum(scenarioKinds),
});

const proposeScenarioRevisionBodySchema = scenarioContentBodySchema.extend({
  requestId: z.string().trim().min(1).max(128),
  expectedVersion: z.number().int().positive(),
});

const publishScenarioRevisionBodySchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  expectedVersion: z.number().int().positive(),
});

const recordTestRunBodySchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  revisionNumber: z.number().int().positive(),
  buildId: z.string().trim().min(1).max(128),
  result: z.enum(testRunResults),
  notes: z.string().max(2_000).optional(),
  evidenceUri: z.string().trim().min(1).max(2_048).optional(),
  workItemIdOrKeys: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
});

function parseTaskContextFilters(searchParams: URLSearchParams): {
  readonly profile?: typeof taskContextProfiles[number];
  readonly include?: typeof taskContextSections[number][];
  readonly maxChars?: number;
  readonly cursor?: string;
} {
  const parsed = z.object({
    profile: z.enum(taskContextProfiles).optional(),
    include: z.array(z.enum(taskContextSections)).max(taskContextSections.length).optional(),
    maxChars: z.coerce.number().int().min(2_000).max(30_000).optional(),
    cursor: z.string().min(1).max(4_096).optional(),
  }).safeParse({
    ...(searchParams.has("profile") ? { profile: searchParams.get("profile") } : {}),
    ...(searchParams.has("include") ? { include: searchParams.getAll("include") } : {}),
    ...(searchParams.has("maxChars") ? { maxChars: searchParams.get("maxChars") } : {}),
    ...(searchParams.has("cursor") ? { cursor: searchParams.get("cursor") } : {}),
  });
  if (!parsed.success) throw new ApplicationError("VALIDATION_FAILED", "Dashboard task context filters are invalid.");
  return {
    ...(parsed.data.profile === undefined ? {} : { profile: parsed.data.profile }),
    ...(parsed.data.include === undefined ? {} : { include: parsed.data.include }),
    ...(parsed.data.maxChars === undefined ? {} : { maxChars: parsed.data.maxChars }),
    ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
  };
}

function parseTestRunFilters(searchParams: URLSearchParams): ListTestRunsInput {
  const parsed = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    scenario: z.string().trim().min(1).max(80).optional(),
    build: z.string().trim().min(1).max(128).optional(),
    result: z.enum(testRunResults).optional(),
    cursor: z.string().min(1).max(4_096).optional(),
  }).safeParse(Object.fromEntries(
    ["limit", "scenario", "build", "result", "cursor"]
      .filter((name) => searchParams.has(name))
      .map((name) => [name, searchParams.get(name)]),
  ));
  if (!parsed.success) throw new ApplicationError("VALIDATION_FAILED", "Dashboard test run filters are invalid.");
  return {
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    ...(parsed.data.scenario === undefined ? {} : { scenarioIdOrKey: parsed.data.scenario }),
    ...(parsed.data.build === undefined ? {} : { buildId: parsed.data.build }),
    ...(parsed.data.result === undefined ? {} : { result: parsed.data.result }),
    ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
  };
}

function parseDashboardMetricsFilters(searchParams: URLSearchParams): {
  readonly teamId?: string;
  readonly asOfDate?: string;
  readonly milestoneId?: string;
  readonly sprintId?: string;
} {
  const parsed = z.object({
    teamId: z.string().uuid().optional(),
    asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
    milestoneId: z.string().trim().min(1).max(80).optional(),
    sprintId: z.string().trim().min(1).max(80).optional(),
  }).safeParse({
    ...(searchParams.has("teamId") ? { teamId: searchParams.get("teamId") ?? "" } : {}),
    ...(searchParams.has("asOfDate") ? { asOfDate: searchParams.get("asOfDate") ?? "" } : {}),
    ...(searchParams.has("milestoneId") ? { milestoneId: searchParams.get("milestoneId") ?? "" } : {}),
    ...(searchParams.has("sprintId") ? { sprintId: searchParams.get("sprintId") ?? "" } : {}),
  });
  if (!parsed.success) throw new ApplicationError("VALIDATION_FAILED", "Dashboard metric filters are invalid.");
  if (parsed.data.asOfDate !== undefined) {
    const date = new Date(`${parsed.data.asOfDate}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== parsed.data.asOfDate) {
      throw new ApplicationError("VALIDATION_FAILED", "Dashboard asOfDate must be a valid calendar date.");
    }
  }
  return {
    ...(parsed.data.teamId === undefined ? {} : { teamId: parsed.data.teamId }),
    ...(parsed.data.asOfDate === undefined ? {} : { asOfDate: parsed.data.asOfDate }),
    ...(parsed.data.milestoneId === undefined ? {} : { milestoneId: parsed.data.milestoneId }),
    ...(parsed.data.sprintId === undefined ? {} : { sprintId: parsed.data.sprintId }),
  };
}

function parseProjectHistoryFilters(searchParams: URLSearchParams): {
  readonly asOfDate?: string;
  readonly workItemCursor?: string;
} {
  const parsed = z.object({
    asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
    cursor: z.string().trim().min(1).max(4_096).optional(),
  }).safeParse({
    ...(searchParams.has("asOfDate") ? { asOfDate: searchParams.get("asOfDate") ?? "" } : {}),
    ...(searchParams.has("cursor") ? { cursor: searchParams.get("cursor") ?? "" } : {}),
  });
  if (!parsed.success) throw new ApplicationError("VALIDATION_FAILED", "Dashboard history filters are invalid.");
  return {
    ...(parsed.data.asOfDate === undefined ? {} : { asOfDate: parsed.data.asOfDate }),
    ...(parsed.data.cursor === undefined ? {} : { workItemCursor: parsed.data.cursor }),
  };
}

function parseDeveloperExecutionMetricFilters(searchParams: URLSearchParams): {
  readonly from?: string;
  readonly to?: string;
  readonly developerPrincipalId?: string;
} {
  const parsed = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
    developerPrincipalId: z.string().uuid().optional(),
  }).safeParse({
    ...(searchParams.has("from") ? { from: searchParams.get("from") ?? "" } : {}),
    ...(searchParams.has("to") ? { to: searchParams.get("to") ?? "" } : {}),
    ...(searchParams.has("developerPrincipalId") ? { developerPrincipalId: searchParams.get("developerPrincipalId") ?? "" } : {}),
  });
  if (!parsed.success) throw new ApplicationError("VALIDATION_FAILED", "Developer execution metric filters are invalid.");
  for (const date of [parsed.data.from, parsed.data.to]) {
    if (date !== undefined) {
      const parsedDate = new Date(`${date}T00:00:00.000Z`);
      if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
        throw new ApplicationError("VALIDATION_FAILED", "Developer execution metric dates must be valid calendar dates.");
      }
    }
  }
  return {
    ...(parsed.data.from === undefined ? {} : { from: parsed.data.from }),
    ...(parsed.data.to === undefined ? {} : { to: parsed.data.to }),
    ...(parsed.data.developerPrincipalId === undefined ? {} : { developerPrincipalId: parsed.data.developerPrincipalId }),
  };
}

function parseDevelopmentSessionFilters(searchParams: URLSearchParams): {
  readonly itemIdOrKey?: string;
  readonly developerPrincipalId?: string;
  readonly status?: "active" | "paused" | "completed" | "cancelled";
  readonly limit?: number;
} {
  const parsed = z.object({
    itemIdOrKey: z.string().trim().min(1).max(80).optional(),
    developerPrincipalId: z.string().uuid().optional(),
    status: z.enum(["active", "paused", "completed", "cancelled"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }).safeParse({
    ...(searchParams.has("itemIdOrKey") ? { itemIdOrKey: searchParams.get("itemIdOrKey") ?? "" } : {}),
    ...(searchParams.has("developerPrincipalId") ? { developerPrincipalId: searchParams.get("developerPrincipalId") ?? "" } : {}),
    ...(searchParams.has("status") ? { status: searchParams.get("status") ?? "" } : {}),
    ...(searchParams.has("limit") ? { limit: searchParams.get("limit") ?? "" } : {}),
  });
  if (!parsed.success) throw new ApplicationError("VALIDATION_FAILED", "Development session filters are invalid.");
  return {
    ...(parsed.data.itemIdOrKey === undefined ? {} : { itemIdOrKey: parsed.data.itemIdOrKey }),
    ...(parsed.data.developerPrincipalId === undefined ? {} : { developerPrincipalId: parsed.data.developerPrincipalId }),
    ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
  };
}

function parseDeploymentEventFilters(searchParams: URLSearchParams): {
  readonly itemIdOrKey?: string;
  readonly environment?: "homologation" | "production";
  readonly limit?: number;
} {
  const parsed = z.object({
    itemIdOrKey: z.string().trim().min(1).max(80).optional(),
    environment: z.enum(["homologation", "production"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }).safeParse({
    ...(searchParams.has("itemIdOrKey") ? { itemIdOrKey: searchParams.get("itemIdOrKey") ?? "" } : {}),
    ...(searchParams.has("environment") ? { environment: searchParams.get("environment") ?? "" } : {}),
    ...(searchParams.has("limit") ? { limit: searchParams.get("limit") ?? "" } : {}),
  });
  if (!parsed.success) throw new ApplicationError("VALIDATION_FAILED", "Deployment event filters are invalid.");
  return {
    ...(parsed.data.itemIdOrKey === undefined ? {} : { itemIdOrKey: parsed.data.itemIdOrKey }),
    ...(parsed.data.environment === undefined ? {} : { environment: parsed.data.environment }),
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
  };
}

function parseWorkItemFilters(searchParams: URLSearchParams): {
  readonly types?: typeof workItemTypes[number][];
  readonly states?: typeof workItemStates[number][];
  readonly parentId?: string;
  readonly search?: string;
  readonly limit?: number;
  readonly cursor?: string;
} {
  const parsed = z.object({
    types: z.array(z.enum(workItemTypes)).optional(),
    states: z.array(z.enum(workItemStates)).optional(),
    parentId: z.string().trim().min(1).max(80).optional(),
    search: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(4_096).optional(),
  }).safeParse({
    ...(searchParams.has("type") ? { types: searchParams.getAll("type") } : {}),
    ...(searchParams.has("state") ? { states: searchParams.getAll("state") } : {}),
    ...(searchParams.has("parentId") ? { parentId: searchParams.get("parentId") ?? "" } : {}),
    ...(searchParams.has("search") ? { search: searchParams.get("search") ?? "" } : {}),
    ...(searchParams.has("limit") ? { limit: searchParams.get("limit") } : {}),
    ...(searchParams.has("cursor") ? { cursor: searchParams.get("cursor") } : {}),
  });
  if (!parsed.success) throw new ApplicationError("VALIDATION_FAILED", "Dashboard work item filters are invalid.");
  return {
    ...(parsed.data.types === undefined ? {} : { types: parsed.data.types }),
    ...(parsed.data.states === undefined ? {} : { states: parsed.data.states }),
    ...(parsed.data.parentId === undefined ? {} : { parentId: parsed.data.parentId }),
    ...(parsed.data.search === undefined ? {} : { search: parsed.data.search }),
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
  };
}

function parseSprintFilters(searchParams: URLSearchParams): {
  readonly statuses?: typeof sprintStates[number][];
  readonly limit?: number;
  readonly teamId?: string;
} {
  const parsed = z.object({
    teamId: z.string().uuid().optional(),
    statuses: z.array(z.enum(sprintStates)).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }).safeParse({
    ...(searchParams.has("teamId") ? { teamId: searchParams.get("teamId") ?? "" } : {}),
    ...(searchParams.has("status") ? { statuses: searchParams.getAll("status") } : {}),
    ...(searchParams.has("limit") ? { limit: searchParams.get("limit") } : {}),
  });
  if (!parsed.success) throw new ApplicationError("VALIDATION_FAILED", "Dashboard sprint filters are invalid.");
  return {
    ...(parsed.data.teamId === undefined ? {} : { teamId: parsed.data.teamId }),
    ...(parsed.data.statuses === undefined ? {} : { statuses: parsed.data.statuses }),
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
  };
}

function parseEvidenceFilters(searchParams: URLSearchParams): { readonly evidenceCursor?: string } {
  const parsed = z.object({ cursor: z.string().min(1).max(4_096).optional() }).safeParse({
    ...(searchParams.has("cursor") ? { cursor: searchParams.get("cursor") } : {}),
  });
  if (!parsed.success) throw new ApplicationError("VALIDATION_FAILED", "Dashboard evidence filters are invalid.");
  return parsed.data.cursor === undefined ? {} : { evidenceCursor: parsed.data.cursor };
}

function parseListPageFilters(searchParams: URLSearchParams): { readonly limit?: number; readonly cursor?: string } {
  const parsed = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(4_096).optional(),
  }).safeParse({
    ...(searchParams.has("limit") ? { limit: searchParams.get("limit") } : {}),
    ...(searchParams.has("cursor") ? { cursor: searchParams.get("cursor") } : {}),
  });
  if (!parsed.success) throw new ApplicationError("VALIDATION_FAILED", "Dashboard list page filters are invalid.");
  return {
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
  };
}

function parseSpecificationFilters(searchParams: URLSearchParams): {
  readonly kind?: typeof specificationKinds[number];
  readonly search?: string;
  readonly limit?: number;
  readonly cursor?: string;
} {
  const parsed = z.object({
    kind: z.enum(specificationKinds).optional(),
    search: z.string().trim().min(2).max(160).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(4_096).optional(),
  }).safeParse({
    ...(searchParams.has("kind") ? { kind: searchParams.get("kind") ?? "" } : {}),
    ...(searchParams.has("search") ? { search: searchParams.get("search") ?? "" } : {}),
    ...(searchParams.has("limit") ? { limit: searchParams.get("limit") } : {}),
    ...(searchParams.has("cursor") ? { cursor: searchParams.get("cursor") } : {}),
  });
  if (!parsed.success) throw new ApplicationError("VALIDATION_FAILED", "Dashboard specification filters are invalid.");
  return {
    ...(parsed.data.kind === undefined ? {} : { kind: parsed.data.kind }),
    ...(parsed.data.search === undefined ? {} : { search: parsed.data.search }),
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
  };
}

function parseAuditFilters(searchParams: URLSearchParams): {
  readonly entityType?: string;
  readonly entityId?: string;
  readonly limit?: number;
  readonly cursor?: string;
} {
  const parsed = z.object({
    entityType: z.string().trim().min(1).max(80).optional(),
    entityId: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(4_096).optional(),
  }).safeParse({
    ...(searchParams.has("entityType") ? { entityType: searchParams.get("entityType") } : {}),
    ...(searchParams.has("entityId") ? { entityId: searchParams.get("entityId") } : {}),
    ...(searchParams.has("limit") ? { limit: searchParams.get("limit") } : {}),
    ...(searchParams.has("cursor") ? { cursor: searchParams.get("cursor") } : {}),
  });
  if (!parsed.success) throw new ApplicationError("VALIDATION_FAILED", "Dashboard audit filters are invalid.");
  return {
    ...(parsed.data.entityType === undefined ? {} : { entityType: parsed.data.entityType }),
    ...(parsed.data.entityId === undefined ? {} : { entityId: parsed.data.entityId }),
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApplicationError("VALIDATION_FAILED", "Request body must use application/json.");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maximumRequestBytes) {
      throw new ApplicationError("REQUEST_TOO_LARGE", "Dashboard request body exceeds 128 KiB.");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ApplicationError("VALIDATION_FAILED", "Request body must contain valid JSON.");
  }
}

function claimLocalSession(
  requestUrl: URL,
  bootstrapToken: string,
  bootstrapClaimed: boolean,
  principalId: string,
  storeSession: (session: LocalSession) => void,
): LocalSession {
  const suppliedToken = requestUrl.searchParams.get("token") ?? "";
  if (bootstrapClaimed || !safeTokenMatches(bootstrapToken, suppliedToken)) {
    throw new ApplicationError("SESSION_INVALID", "Dashboard session bootstrap token is invalid or already used.");
  }
  const session = createDashboardSession(principalId, null);
  storeSession(session);
  return session;
}

function createDashboardSession(principalId: string, authKeyId: string | null): LocalSession {
  return {
    id: randomBytes(32).toString("base64url"),
    principalId,
    authKeyId,
    csrfToken: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + sessionLifetimeMs,
  };
}

function storeDashboardSession(sessions: Map<string, LocalSession>, session: LocalSession): void {
  const now = Date.now();
  for (const [id, current] of sessions) {
    if (current.expiresAt <= now) sessions.delete(id);
  }
  sessions.set(session.id, session);
}

function setSessionCookie(response: ServerResponse, session: LocalSession): void {
  response.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=${session.id}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(sessionLifetimeMs / 1_000)}`,
  );
}

function requireLocalSession(
  request: IncomingMessage,
  sessions: Map<string, LocalSession>,
  database: SqliteDatabase,
): LocalSession {
  const cookie = request.headers.cookie?.split(";").map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${sessionCookieName}=`));
  const suppliedId = cookie?.slice(sessionCookieName.length + 1);
  const session = suppliedId === undefined ? undefined : sessions.get(suppliedId);
  if (session === undefined || session.expiresAt <= Date.now()) {
    if (session !== undefined) sessions.delete(session.id);
    throw new ApplicationError("SESSION_REQUIRED", "Claim a local dashboard session before using this API.");
  }
  if (session.authKeyId !== null && !isAuthKeySessionActive(database, session.principalId, session.authKeyId)) {
    sessions.delete(session.id);
    throw new ApplicationError("SESSION_INVALID", "The SSDD credential for this session has been revoked.");
  }
  return session;
}

function clearSessionCookie(response: ServerResponse): void {
  response.setHeader("Set-Cookie", `${sessionCookieName}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
}

function getDashboardPrincipal(database: SqliteDatabase, principalId: string): { id: string; displayName: string } {
  const principal = database.prepare(
    "SELECT principal_id AS id, display_name AS displayName FROM principals WHERE principal_id = ?",
  ).get(principalId) as { id: string; displayName: string } | undefined;
  if (principal === undefined) {
    throw new ApplicationError("SESSION_INVALID", "The dashboard principal no longer exists.");
  }
  return principal;
}

function assertSameOriginMutation(request: IncomingMessage, origin: string, session: LocalSession): void {
  if (request.headers.origin !== origin) {
    throw new ApplicationError("ORIGIN_NOT_ALLOWED", "Dashboard mutations require the local dashboard origin.");
  }
  if (request.headers["x-ssdd-csrf"] !== session.csrfToken) {
    throw new ApplicationError("CSRF_INVALID", "Dashboard mutation is missing a valid CSRF token.");
  }
}

function validateOrigin(request: IncomingMessage, origin: string, bootstrapRoute: boolean): void {
  const requestOrigin = request.headers.origin;
  if (requestOrigin !== undefined && requestOrigin !== origin) {
    throw new ApplicationError("ORIGIN_NOT_ALLOWED", "Cross-origin dashboard requests are not allowed.");
  }
  if (!bootstrapRoute && request.method !== "GET" && request.method !== "HEAD" && requestOrigin !== origin) {
    throw new ApplicationError("ORIGIN_NOT_ALLOWED", "Dashboard requests require the local origin.");
  }
}

function isAllowedHost(host: string | undefined, origin: string): boolean {
  if (host === undefined) return false;
  const expected = new URL(origin);
  return host === expected.host;
}

function safeTokenMatches(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function parseUuid(value: string): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new ApplicationError("VALIDATION_FAILED", "Project ID must be a UUID.");
  return parsed.data;
}

function decodePathSegment(value: string | undefined): string {
  if (value === undefined) throw new ApplicationError("VALIDATION_FAILED", "Route parameter is missing.");
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApplicationError("VALIDATION_FAILED", "Route parameter encoding is invalid.");
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function sendStaticFile(response: ServerResponse, filename: string, contentType: string): Promise<void> {
  const content = await readFile(new URL(`./public/${filename}`, import.meta.url));
  response.writeHead(200, { "Content-Type": contentType });
  response.end(content);
}

function sendApplicationError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  const applicationError = error instanceof ApplicationError
    ? error
    : error instanceof z.ZodError
      ? new ApplicationError("VALIDATION_FAILED", "Dashboard request data is invalid.", {
          details: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        })
      : new ApplicationError("INTERNAL_ERROR", "An unexpected server error occurred.");
  const status = statusForError(applicationError.code);
  sendJson(response, status, {
    code: applicationError.code,
    message: applicationError.message,
    details: applicationError.details,
    retryable: applicationError.retryable,
    correlationId: randomUUID(),
  });
}

function statusForError(code: string): number {
  if (code === "FORBIDDEN" || code === "ORIGIN_NOT_ALLOWED" || code === "CSRF_INVALID") return 403;
  if (code === "SESSION_REQUIRED" || code === "SESSION_INVALID") return 401;
  if (code === "NOT_FOUND") return 404;
  if (code === "METHOD_NOT_ALLOWED") return 405;
  if (code === "REQUEST_TOO_LARGE") return 413;
  if ([
    "GATE_BLOCKED", "INVALID_TRANSITION", "VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "STALE_CURSOR",
    "TASK_NOT_STARTABLE", "TASK_ALREADY_ASSIGNED",
  ].includes(code)) return 409;
  if (code === "INTERNAL_ERROR") return 500;
  return 400;
}

function closeServer(server: Server, database: SqliteDatabase): Promise<void> {
  return new Promise((resolveClose, reject) => {
    const closeDatabase = (): void => {
      if (database.open) database.close();
    };
    if (!server.listening) {
      closeDatabase();
      resolveClose();
      return;
    }
    server.close((error) => {
      closeDatabase();
      if (error !== undefined) reject(error);
      else resolveClose();
    });
  });
}
