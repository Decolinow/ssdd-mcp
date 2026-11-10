import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ApplicationError } from "../application/errors.js";
import { getOrCreateLocalPrincipal } from "../application/local-identity.js";
import { getProject, listProjects } from "../application/project-queries.js";
import { listAuditEvents } from "../application/audit-queries.js";
import { getProjectDashboardMetrics } from "../application/dashboard-metrics.js";
import { listProjectTeams } from "../application/team-directory.js";
import { getWorkItemQualityReport, listProjectQualitySummaries } from "../application/quality-queries.js";
import { getSprint, listSprints } from "../application/sprint-queries.js";
import { getSprintRetrospective, setSprintRetrospective } from "../application/sprint-retrospectives.js";
import { getWorkItem, listWorkItems } from "../application/work-item-queries.js";
import { transitionWorkItem } from "../application/work-item-workflow.js";
import { sprintStates } from "../domain/sprints.js";
import { workItemStates, workItemTypes } from "../domain/work-items.js";
import { applyMigrations } from "../storage-sqlite/migrations.js";
import { openSqliteDatabase, type SqliteDatabase } from "../storage-sqlite/database.js";

const sessionCookieName = "ssdd_session";
const sessionLifetimeMs = 12 * 60 * 60 * 1_000;
const maximumRequestBytes = 128 * 1_024;

interface LocalSession {
  readonly id: string;
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
    const principal = getOrCreateLocalPrincipal(database);
    const bootstrapToken = randomBytes(32).toString("base64url");
    let bootstrapClaimed = false;
    let localSession: LocalSession | undefined;
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
      const isBootstrapRoute = route === "/api/v1/session/claim" || (route === "/" && requestUrl.searchParams.has("token"));
      validateOrigin(request, origin, isBootstrapRoute);

      if (request.method === "GET" && route === "/") {
        if (requestUrl.searchParams.has("token")) {
          const session = claimLocalSession(requestUrl, bootstrapToken, bootstrapClaimed, (claimedSession) => {
            localSession = claimedSession;
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
      if (request.method === "GET" && route === "/dashboard.css") {
        await sendStaticFile(response, "dashboard.css", "text/css; charset=utf-8");
        return;
      }
      if (request.method === "GET" && route === "/api/v1/session/claim") {
        const session = claimLocalSession(requestUrl, bootstrapToken, bootstrapClaimed, (claimedSession) => {
          localSession = claimedSession;
          bootstrapClaimed = true;
        });
        setSessionCookie(response, session);
        sendJson(response, 200, { csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() });
        return;
      }

      const session = requireLocalSession(request, localSession);
      if (request.method === "GET" && route === "/api/v1/session") {
        sendJson(response, 200, {
          principal: { id: principal.id, displayName: principal.displayName },
          projects: listProjects(database, principal.id),
          csrfToken: session.csrfToken,
          expiresAt: new Date(session.expiresAt).toISOString(),
        });
        return;
      }
      if (request.method === "GET" && route === "/api/v1/projects") {
        sendJson(response, 200, { projects: listProjects(database, principal.id) });
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

      const projectTeamsMatch = /^\/api\/v1\/projects\/([^/]+)\/teams$/.exec(route);
      if (request.method === "GET" && projectTeamsMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectTeamsMatch[1]));
        sendJson(response, 200, { teams: listProjectTeams(database, projectId, principal.id) });
        return;
      }

      const projectQualityMatch = /^\/api\/v1\/projects\/([^/]+)\/quality$/.exec(route);
      if (request.method === "GET" && projectQualityMatch !== null) {
        const projectId = parseUuid(decodePathSegment(projectQualityMatch[1]));
        sendJson(response, 200, { items: listProjectQualitySummaries(database, { projectId, principalId: principal.id }) });
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

export function startDashboardServer(
  workspace: string,
  port = 4318,
  writeLine: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): DashboardApiServer {
  const handle = createDashboardApiServer(workspace);
  void listenDashboardApiServer(handle, port).then(({ origin }) => {
    writeLine(`Dashboard: ${origin}/?token=${encodeURIComponent(handle.bootstrapToken)}`);
    writeLine(`Dashboard API: ${origin}/api/v1`);
  }).catch((error: unknown) => {
    writeLine(`Dashboard API error: ${error instanceof Error ? error.message : "Erro inesperado."}`);
    void handle.close();
  });
  return handle;
}

const transitionBodySchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  targetState: z.enum(workItemStates),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1_000),
  buildId: z.string().trim().min(1).max(128).optional(),
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
  storeSession: (session: LocalSession) => void,
): LocalSession {
  const suppliedToken = requestUrl.searchParams.get("token") ?? "";
  if (bootstrapClaimed || !safeTokenMatches(bootstrapToken, suppliedToken)) {
    throw new ApplicationError("SESSION_INVALID", "Dashboard session bootstrap token is invalid or already used.");
  }
  const session: LocalSession = {
    id: randomBytes(32).toString("base64url"),
    csrfToken: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + sessionLifetimeMs,
  };
  storeSession(session);
  return session;
}

function setSessionCookie(response: ServerResponse, session: LocalSession): void {
  response.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=${session.id}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(sessionLifetimeMs / 1_000)}`,
  );
}

function requireLocalSession(request: IncomingMessage, session: LocalSession | undefined): LocalSession {
  const cookie = request.headers.cookie?.split(";").map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${sessionCookieName}=`));
  const suppliedId = cookie?.slice(sessionCookieName.length + 1);
  if (session === undefined || session.expiresAt <= Date.now() || suppliedId !== session.id) {
    throw new ApplicationError("SESSION_REQUIRED", "Claim a local dashboard session before using this API.");
  }
  return session;
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
  if (["GATE_BLOCKED", "INVALID_TRANSITION", "VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "STALE_CURSOR"].includes(code)) return 409;
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
