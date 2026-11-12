import {
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  oauthMetadataResponse,
  originValidationResponse,
  validateHostHeader,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { join, resolve } from "node:path";
import { applyMigrations } from "../storage-sqlite/migrations.js";
import { findExternalPrincipalId } from "../application/external-identities.js";
import { getOrCreateLocalPrincipal } from "../application/local-identity.js";
import { ensureBootstrapAdministrator, resolvePrincipalFromAuthKey } from "../application/user-management.js";
import { openSqliteDatabase, type SqliteDatabase } from "../storage-sqlite/database.js";
import { createMcpServer } from "./server.js";
import { parseMcpProfile, type McpProfile } from "./profiles.js";
import { createOidcHttpAuth, validateOidcHttpAuthOptions, type OidcHttpAuth, type OidcHttpAuthOptions } from "./oidc-auth.js";
import { receiveWebhookRequest, validateWebhookSecrets, type WebhookSecrets } from "./webhook-receiver.js";
import { readGithubRepositoriesFromEnvironment, validateGithubRepositoryMappings, type GithubRepositoryMappings } from "../application/github-webhooks.js";
import { readGithubIssueTokensFromEnvironment, validateGithubIssueTokens, type GithubIssueTokens } from "../integrations/github-issues.js";
import {
  readAzureDevOpsConnectionsFromEnvironment,
  validateAzureDevOpsConnections,
  type AzureDevOpsConnections,
} from "../integrations/azure-devops-work-items.js";
import { readTextEmbeddingProviderFromEnvironment, type TextEmbeddingProvider } from "../integrations/embeddings.js";

export const maximumMcpHttpRequestBytes = 1_048_576;

const mcpPath = "/mcp";
const allowedHostnames = localhostAllowedHostnames();
const allowedOriginHostnamesDefault = localhostAllowedOrigins();
const allowedMethods = new Set(["POST", "GET", "DELETE"]);
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface McpSession {
  readonly server: ReturnType<typeof createMcpServer>;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly principalId: string;
  readonly profile: McpProfile;
  sessionId: string | undefined;
  disposed: boolean;
}

export interface McpHttpServer {
  readonly server: Server;
  readonly ready: Promise<void>;
  readonly bootstrapAuthKey: string | undefined;
  readonly close: () => Promise<void>;
}

export interface McpHttpAddress {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
}

export interface McpHttpServerOptions extends Partial<Pick<OidcHttpAuthOptions, "issuer" | "resourceUrl">> {
  readonly allowedOrigins?: readonly string[];
  readonly webhookSecrets?: WebhookSecrets;
  readonly githubRepositories?: GithubRepositoryMappings;
  readonly githubIssueTokens?: GithubIssueTokens;
  readonly azureDevOpsConnections?: AzureDevOpsConnections;
  readonly embeddingProvider?: TextEmbeddingProvider;
}

export function createMcpHttpServer(workspace: string, options: McpHttpServerOptions = {}): McpHttpServer {
  const hasIssuer = options.issuer !== undefined;
  const hasResourceUrl = options.resourceUrl !== undefined;
  if (hasIssuer !== hasResourceUrl) {
    throw new Error("OIDC mode requires both an issuer and an MCP resource URL.");
  }
  if (!hasIssuer && (options.allowedOrigins?.length ?? 0) > 0) {
    throw new Error("Additional allowed origins require OIDC mode.");
  }
  if (hasIssuer) {
    validateOidcHttpAuthOptions({ issuer: options.issuer!, resourceUrl: options.resourceUrl! });
  }
  validateWebhookSecrets(options.webhookSecrets ?? {});
  const githubRepositories = options.githubRepositories ?? readGithubRepositoriesFromEnvironment();
  validateGithubRepositoryMappings(githubRepositories);
  const githubIssueTokens = options.githubIssueTokens ?? readGithubIssueTokensFromEnvironment();
  validateGithubIssueTokens(githubIssueTokens);
  const azureDevOpsConnections = options.azureDevOpsConnections ?? readAzureDevOpsConnectionsFromEnvironment();
  validateAzureDevOpsConnections(azureDevOpsConnections);
  const embeddingProvider = options.embeddingProvider ?? readTextEmbeddingProviderFromEnvironment();
  const integrations = {
    githubRepositories,
    githubIssueTokens,
    azureDevOpsConnections,
    ...(embeddingProvider === undefined ? {} : { embeddingProvider }),
  };
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins ?? []);
  const databasePath = join(resolve(workspace), ".ssdd", "ssdd.sqlite");
  if (!existsSync(databasePath)) {
    throw new Error(`No SSDD workspace found at '${databasePath}'. Run 'ssdd-mcp init' first.`);
  }

  const database = openSqliteDatabase(databasePath);
  try {
    applyMigrations(database);
    const principal = getOrCreateLocalPrincipal(database);
    const bootstrapAdministrator = ensureBootstrapAdministrator(database, principal.id);
    const sessions = new Map<string, McpSession>();
    const oidcAuthPromise: Promise<OidcHttpAuth | undefined> = hasIssuer
      ? createOidcHttpAuth({ issuer: options.issuer!, resourceUrl: options.resourceUrl! })
      : Promise.resolve(undefined);
    const ready = oidcAuthPromise.then(() => undefined);
    const modernHandler = createMcpHandler(
      (context) => createMcpServer(
        database,
        principalIdFromAuthInfo(context.authInfo, principal.id),
        integrations,
        profileFromAuthInfo(context.authInfo),
      ),
      {
        legacy: "reject",
        maxRequestBodySize: maximumMcpHttpRequestBytes,
      },
    );
    const server = createServer((request, response) => {
      void handleRequest(
        request,
        response,
        database,
        principal.id,
        sessions,
        modernHandler,
        oidcAuthPromise,
        allowedOrigins,
        options.webhookSecrets ?? {},
        githubRepositories,
        integrations,
      ).catch((error: unknown) => {
        sendBridgeError(response, error);
      });
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;

    return {
      server,
      ready,
      bootstrapAuthKey: bootstrapAdministrator.authKey ?? undefined,
      close: async () => {
        const stopped = stopHttpServer(server);
        await modernHandler.close();
        await Promise.all([...sessions.values()].map((session) => disposeSession(sessions, session)));
        await stopped;
        await ready.catch(() => undefined);
        if (database.open) database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export function listenMcpHttpServer(handle: McpHttpServer, port = 4319): Promise<McpHttpAddress> {
  return new Promise((resolveAddress, reject) => {
    const onError = (error: Error): void => reject(error);
    handle.server.once("error", onError);
    void handle.ready.then(() => handle.server.listen(port, "127.0.0.1", () => {
      handle.server.off("error", onError);
      const address = handle.server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("MCP HTTP server did not bind to a TCP port."));
        return;
      }
      resolveAddress({ host: "127.0.0.1", port: address.port, origin: `http://127.0.0.1:${address.port}` });
    })).catch((error: unknown) => {
      handle.server.off("error", onError);
      reject(error);
    });
  });
}

export function startMcpHttpServer(
  workspace: string,
  port = 4319,
  writeLine: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
  options: McpHttpServerOptions = {},
): McpHttpServer {
  const handle = createMcpHttpServer(workspace, options);
  if (handle.bootstrapAuthKey !== undefined) {
    writeLine(`Administrador inicial SSDD. Guarde esta authKey; ela será exibida uma única vez: ${handle.bootstrapAuthKey}`);
  }
  void listenMcpHttpServer(handle, port).then(({ origin }) => {
    writeLine(`MCP Streamable HTTP: ${options.resourceUrl ?? `${origin}${mcpPath}`}`);
    writeLine(options.issuer === undefined
      ? "Acesso por authKey SSDD ou identidade local de loopback."
      : `OAuth/OIDC ativo com emissor ${options.issuer}, escopo ssdd:mcp e suporte a authKey SSDD.`);
    if (Object.keys(options.webhookSecrets ?? {}).length > 0) {
      writeLine("Recepção de webhooks autenticada por assinatura está ativa.");
    }
    const shutdown = (signal: "SIGINT" | "SIGTERM"): void => {
      writeLine(`Recebido ${signal}; encerrando o servidor MCP e fechando sessões.`);
      void handle.close().then(() => {
        writeLine("Servidor MCP encerrado.");
      }).catch((error: unknown) => {
        writeLine(`Falha ao encerrar o servidor MCP: ${error instanceof Error ? error.message : "Erro inesperado."}`);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  }).catch((error: unknown) => {
    writeLine(`MCP HTTP error: ${error instanceof Error ? error.message : "Erro inesperado."}`);
    process.exitCode = 1;
    void handle.close();
  });
  return handle;
}

async function handleRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  database: SqliteDatabase,
  localPrincipalId: string,
  sessions: Map<string, McpSession>,
  modernHandler: ReturnType<typeof createMcpHandler>,
  oidcAuthPromise: Promise<OidcHttpAuth | undefined>,
  configuredAllowedOrigins: readonly string[],
  webhookSecrets: WebhookSecrets,
  githubRepositories: GithubRepositoryMappings,
  integrations: {
    readonly githubRepositories: GithubRepositoryMappings;
    readonly githubIssueTokens: GithubIssueTokens;
    readonly azureDevOpsConnections: AzureDevOpsConnections;
    readonly embeddingProvider?: TextEmbeddingProvider;
  },
): Promise<void> {
  const oidcAuth = await oidcAuthPromise;
  const hostHeader = incoming.headers.host;
  const allowedHosts = oidcAuth === undefined
    ? allowedHostnames
    : [...allowedHostnames, oidcAuth.resourceUrl.hostname];
  const allowedOriginHostnames = oidcAuth === undefined
    ? allowedOriginHostnamesDefault
    : [...allowedOriginHostnamesDefault, oidcAuth.resourceUrl.hostname, ...configuredAllowedOrigins];
  const hostValidation = validateHostHeader(hostHeader, allowedHosts);
  if (!hostValidation.ok) {
    await closeConnectionForUnreadBody(incoming, outgoing);
    sendJson(outgoing, 403, { code: "ORIGIN_NOT_ALLOWED", message: "The request Host is not configured for this MCP server." });
    return;
  }

  const requestTarget = incoming.url ?? "/";
  if (!requestTarget.startsWith("/") || requestTarget.startsWith("//")) {
    await closeConnectionForUnreadBody(incoming, outgoing);
    sendJson(outgoing, 400, { code: "INVALID_REQUEST", message: "An origin-form request target is required." });
    return;
  }

  let requestUrl: URL;
  try {
    requestUrl = new URL(requestTarget, `http://${hostHeader}`);
  } catch {
    await closeConnectionForUnreadBody(incoming, outgoing);
    sendJson(outgoing, 400, { code: "INVALID_REQUEST", message: "The request target is invalid." });
    return;
  }
  if (requestUrl.pathname === "/healthz" || requestUrl.pathname === "/readyz") {
    if (incoming.method !== "GET") {
      await closeConnectionForUnreadBody(incoming, outgoing);
      outgoing.setHeader("Allow", "GET");
      sendJson(outgoing, 405, { code: "METHOD_NOT_ALLOWED", message: "Health endpoints accept GET only." });
      return;
    }
    const healthRequest = toWebRequest(incoming, requestUrl, false);
    const healthOriginRejection = originValidationResponse(healthRequest, allowedOriginHostnames);
    if (healthOriginRejection !== undefined) {
      await closeConnectionForUnreadBody(incoming, outgoing);
      await writeWebResponse(healthOriginRejection, outgoing);
      return;
    }
    if (requestUrl.pathname === "/healthz") {
      sendJson(outgoing, 200, { status: "ok" });
      return;
    }
    try {
      database.prepare("SELECT 1").get();
      sendJson(outgoing, 200, { status: "ready" });
    } catch {
      sendJson(outgoing, 503, { status: "not_ready" });
    }
    return;
  }
  const webhookRoute = /^\/webhooks\/([a-z][a-z0-9-]{0,63})\/([A-Za-z][A-Za-z0-9]{0,9})$/u.exec(requestUrl.pathname);
  if (webhookRoute !== null) {
    if (incoming.method !== "POST") {
      await closeConnectionForUnreadBody(incoming, outgoing);
      outgoing.setHeader("Allow", "POST");
      sendJson(outgoing, 405, { code: "METHOD_NOT_ALLOWED", message: "Webhook endpoint accepts POST only." });
      return;
    }
    const webhookRequest = toWebRequest(incoming, requestUrl, false);
    const originRejection = originValidationResponse(webhookRequest, allowedOriginHostnames);
    if (originRejection !== undefined) {
      await closeConnectionForUnreadBody(incoming, outgoing);
      await writeWebResponse(originRejection, outgoing);
      return;
    }
    await receiveWebhookRequest(
      incoming,
      outgoing,
      database,
      webhookSecrets,
      githubRepositories,
      webhookRoute[1]!,
      webhookRoute[2]!,
    );
    return;
  }
  if (requestUrl.pathname.startsWith("/webhooks/")) {
    await closeConnectionForUnreadBody(incoming, outgoing);
    sendJson(outgoing, 404, { code: "NOT_FOUND", message: "Webhook endpoint not found." });
    return;
  }
  if (requestUrl.pathname !== mcpPath && oidcAuth === undefined) {
    await closeConnectionForUnreadBody(incoming, outgoing);
    sendJson(outgoing, 404, { code: "NOT_FOUND", message: "MCP endpoint not found." });
    return;
  }
  const isMetadataRequest = oidcAuth !== undefined && requestUrl.pathname.startsWith("/.well-known/");
  const metadataMethods = new Set(["GET", "OPTIONS"]);
  if (!(isMetadataRequest ? metadataMethods : allowedMethods).has(incoming.method ?? "")) {
    await closeConnectionForUnreadBody(incoming, outgoing);
    outgoing.setHeader("Allow", isMetadataRequest ? "GET, OPTIONS" : "POST, GET, DELETE");
    sendJson(outgoing, 405, { code: "METHOD_NOT_ALLOWED", message: "The HTTP method is not allowed on this endpoint." });
    return;
  }
  if (!isMetadataRequest && requestUrl.pathname !== mcpPath) {
    await closeConnectionForUnreadBody(incoming, outgoing);
    sendJson(outgoing, 404, { code: "NOT_FOUND", message: "MCP endpoint not found." });
    return;
  }
  const contentLength = incoming.headers["content-length"];
  if (requestUrl.pathname === mcpPath && incoming.method === "POST" && contentLength !== undefined && Number(contentLength) > maximumMcpHttpRequestBytes) {
    await closeConnectionForUnreadBody(incoming, outgoing);
    sendJson(outgoing, 413, { code: "REQUEST_TOO_LARGE", message: "MCP request body exceeds the 1 MiB limit." });
    return;
  }

  const headerRequest = toWebRequest(incoming, requestUrl, false);
  if (oidcAuth !== undefined && requestUrl.pathname.startsWith("/.well-known/")) {
    const metadataResponse = oauthMetadataResponse(headerRequest, oidcAuth.metadataOptions);
    if (metadataResponse !== undefined) {
      await writeWebResponse(metadataResponse, outgoing);
      return;
    }
    await closeConnectionForUnreadBody(incoming, outgoing);
    sendJson(outgoing, 404, { code: "NOT_FOUND", message: "OAuth metadata endpoint not found." });
    return;
  }
  const originRejection = originValidationResponse(headerRequest, allowedOriginHostnames);
  if (originRejection !== undefined) {
    await closeConnectionForUnreadBody(incoming, outgoing);
    await writeWebResponse(originRejection, outgoing);
    return;
  }

  let profile: McpProfile;
  try {
    profile = readProfileHeader(incoming);
  } catch (error) {
    await closeConnectionForUnreadBody(incoming, outgoing);
    sendJson(outgoing, 400, {
      code: "PROFILE_INVALID",
      message: error instanceof Error ? error.message : "The MCP profile is invalid.",
    });
    return;
  }

  const authorization = readAuthorizationHeader(incoming);
  let authInfo: AuthInfo | undefined;
  let principalId: string | undefined;
  if (authorization?.startsWith("ssdd_")) {
    principalId = resolvePrincipalFromAuthKey(database, authorization);
    if (principalId === undefined) {
      await closeConnectionForUnreadBody(incoming, outgoing);
      sendAuthKeyUnauthorized(outgoing);
      return;
    }
    authInfo = syntheticAuthInfo(principalId, profile);
  } else if (oidcAuth !== undefined) {
    const authResult = await oidcAuth.authenticate(headerRequest);
    if (authResult instanceof Response) {
      await closeConnectionForUnreadBody(incoming, outgoing);
      await writeWebResponse(authResult, outgoing);
      return;
    }
    authInfo = authResult;
    principalId = resolveExternalPrincipal(database, authInfo);
  } else if (authorization !== undefined) {
    await closeConnectionForUnreadBody(incoming, outgoing);
    sendAuthKeyUnauthorized(outgoing);
    return;
  } else {
    principalId = localPrincipalId;
  }
  if (principalId === undefined) {
    await closeConnectionForUnreadBody(incoming, outgoing);
    sendJson(outgoing, 403, {
      error: "identity_not_provisioned",
      error_description: "Ask a project administrator to provision this OIDC identity.",
    });
    return;
  }
  if (authInfo !== undefined) {
    const extra = authInfo.extra ?? {};
    authInfo.extra = { ...extra, principalId, ssddProfile: profile };
  } else if (profile !== "full") {
    authInfo = syntheticAuthInfo(principalId, profile);
  }

  const webRequest = toWebRequest(incoming, requestUrl);

  if (
    incoming.method === "POST" &&
    !(await isLegacyRequest(webRequest, undefined, { maxRequestBodySize: maximumMcpHttpRequestBytes }))
  ) {
    const result = await modernHandler.fetch(webRequest, authInfo === undefined ? undefined : { authInfo });
    await writeWebResponse(result, outgoing);
    return;
  }

  const sessionId = readSessionId(incoming);
  if (sessionId === null) {
    await closeConnectionForUnreadBody(incoming, outgoing);
    sendJson(outgoing, 400, { code: "SESSION_INVALID", message: "The MCP session header is invalid." });
    return;
  }
  let session: McpSession | undefined;
  if (sessionId === undefined) {
    if (incoming.method !== "POST") {
      await closeConnectionForUnreadBody(incoming, outgoing);
      sendJson(outgoing, 400, { code: "SESSION_REQUIRED", message: "Initialize an MCP session before using this method." });
      return;
    }
    session = await createSession(database, principalId, profile, sessions, integrations);
  } else {
    session = sessions.get(sessionId);
    if (session === undefined) {
      await closeConnectionForUnreadBody(incoming, outgoing);
      sendJson(outgoing, 404, { code: "SESSION_INVALID", message: "The MCP session does not exist or has expired." });
      return;
    }
    if (session.principalId !== principalId) {
      await closeConnectionForUnreadBody(incoming, outgoing);
      sendJson(outgoing, 403, { code: "SESSION_PRINCIPAL_MISMATCH", message: "This MCP session belongs to another principal." });
      return;
    }
    if (session.profile !== profile) {
      await closeConnectionForUnreadBody(incoming, outgoing);
      sendJson(outgoing, 403, { code: "SESSION_PROFILE_MISMATCH", message: "This MCP session is bound to a different profile." });
      return;
    }
  }

  let result: Response;
  try {
    result = await session.transport.handleRequest(webRequest, authInfo === undefined ? undefined : { authInfo });
  } catch (error) {
    if (session.sessionId === undefined) await disposeSession(sessions, session);
    throw error;
  }
  try {
    await writeWebResponse(result, outgoing);
  } catch (error) {
    if (session.sessionId === undefined) await disposeSession(sessions, session);
    throw error;
  }
  if (session.sessionId === undefined && result.status >= 400) {
    await disposeSession(sessions, session);
  }
}

async function createSession(
  database: SqliteDatabase,
  principalId: string,
  profile: McpProfile,
  sessions: Map<string, McpSession>,
  integrations: {
    readonly githubRepositories: GithubRepositoryMappings;
    readonly githubIssueTokens: GithubIssueTokens;
    readonly azureDevOpsConnections: AzureDevOpsConnections;
    readonly embeddingProvider?: TextEmbeddingProvider;
  },
): Promise<McpSession> {
  const mcpServer = createMcpServer(database, principalId, integrations, profile);
  const session: McpSession = {
    server: mcpServer,
    principalId,
    profile,
    get transport() {
      return transport;
    },
    sessionId: undefined,
    disposed: false,
  };
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
    maxRequestBodySize: maximumMcpHttpRequestBytes,
    onsessioninitialized: (sessionId) => {
      session.sessionId = sessionId;
      sessions.set(sessionId, session);
    },
    onsessionclosed: async (sessionId) => {
      const closedSession = sessions.get(sessionId);
      if (closedSession !== undefined) await disposeSession(sessions, closedSession);
    },
  });
  try {
    await mcpServer.connect(transport);
  } catch (error) {
    await mcpServer.close();
    throw error;
  }
  return session;
}

async function disposeSession(sessions: Map<string, McpSession>, session: McpSession): Promise<void> {
  if (session.disposed) return;
  session.disposed = true;
  if (session.sessionId !== undefined) sessions.delete(session.sessionId);
  await session.server.close();
}

function toWebRequest(incoming: IncomingMessage, url: URL, includeBody = true): Request {
  const headers = new Headers();
  const connectionTokens = (incoming.headers.connection ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter((header) => header.length > 0);
  const excludedHeaders = new Set([...hopByHopHeaders, ...connectionTokens]);
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index];
    const value = incoming.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined && !excludedHeaders.has(name.toLowerCase())) {
      headers.append(name, value);
    }
  }

  const method = incoming.method ?? "GET";
  if (!includeBody || method === "GET" || method === "DELETE") {
    return new Request(url, { method, headers });
  }
  return new Request(url, {
    method,
    headers,
    body: Readable.toWeb(incoming),
    duplex: "half",
  });
}

async function writeWebResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  const connectionTokens = (response.headers.get("connection") ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter((header) => header.length > 0);
  const excludedHeaders = new Set([...hopByHopHeaders, ...connectionTokens]);
  response.headers.forEach((value, name) => {
    if (!excludedHeaders.has(name.toLowerCase())) outgoing.setHeader(name, value);
  });
  outgoing.statusCode = response.status;
  if (response.body === null) {
    outgoing.end();
    return;
  }
  const body = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  await pipeline(body, outgoing);
}

function readSessionId(request: IncomingMessage): string | undefined | null {
  const value = request.headers["mcp-session-id"];
  if (Array.isArray(value)) return null;
  if (value === undefined) return undefined;
  const sessionId = value?.trim();
  return sessionId.length === 0 ? null : sessionId;
}

async function closeConnectionForUnreadBody(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  const contentLength = Number(incoming.headers["content-length"] ?? 0);
  if (incoming.headers["transfer-encoding"] !== undefined || contentLength > 0) {
    if (!incoming.complete && !incoming.destroyed) {
      await new Promise<void>((resolveBody) => {
        const finish = (): void => resolveBody();
        incoming.once("end", finish);
        incoming.once("aborted", finish);
        incoming.once("close", finish);
        incoming.resume();
      });
    }
    outgoing.setHeader("Connection", "close");
  }
}

function sendBridgeError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  const correlationId = randomUUID();
  const errorType = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(`MCP HTTP bridge failure ${correlationId} (${errorType}).\n`);
  sendJson(response, 500, {
    code: "INTERNAL_ERROR",
    message: "Unexpected MCP transport error.",
    correlationId,
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function resolveExternalPrincipal(database: SqliteDatabase, authInfo: AuthInfo): string | undefined {
  const issuer = authInfo.extra?.issuer;
  const subject = authInfo.extra?.subject;
  if (typeof issuer !== "string" || typeof subject !== "string") return undefined;
  return findExternalPrincipalId(database, issuer, subject);
}

function principalIdFromAuthInfo(authInfo: AuthInfo | undefined, localPrincipalId: string): string {
  if (authInfo === undefined) return localPrincipalId;
  const principalId = authInfo.extra?.principalId;
  if (typeof principalId !== "string") throw new Error("Authenticated MCP request has no provisioned principal.");
  return principalId;
}

function profileFromAuthInfo(authInfo: AuthInfo | undefined): McpProfile {
  const profile = authInfo?.extra?.ssddProfile;
  return parseMcpProfile(typeof profile === "string" ? profile : undefined);
}

function readProfileHeader(request: IncomingMessage): McpProfile {
  const value = request.headers["x-ssdd-profile"];
  if (Array.isArray(value)) throw new Error("Send only one X-SSDD-Profile header.");
  return parseMcpProfile(value);
}

function readAuthorizationHeader(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined) return undefined;
  if (Array.isArray(header)) return "invalid-authorization-header";
  const match = /^Bearer\s+([^\s]+)$/iu.exec(header.trim());
  return match?.[1] ?? "invalid-authorization-header";
}

function syntheticAuthInfo(principalId: string, profile: McpProfile): AuthInfo {
  return {
    token: "ssdd-authenticated-context",
    clientId: "ssdd-auth-key",
    scopes: ["ssdd:mcp"],
    extra: { principalId, ssddProfile: profile },
  };
}

function sendAuthKeyUnauthorized(response: ServerResponse): void {
  response.setHeader("WWW-Authenticate", 'Bearer realm="ssdd-mcp"');
  sendJson(response, 401, {
    error: "invalid_auth_key",
    error_description: "A valid SSDD authKey is required for this request.",
  });
}

function normalizeAllowedOrigins(values: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    const hostname = value.trim().toLowerCase();
    if (
      hostname.length === 0 ||
      hostname.includes("://") ||
      hostname.includes("/") ||
      hostname.includes("@") ||
      hostname.includes("?") ||
      hostname.includes("#")
    ) {
      throw new Error("Allowed origins must be hostnames without scheme, port, or path.");
    }
    try {
      const parsed = new URL(`http://${hostname}`);
      if (parsed.hostname !== hostname || parsed.port.length > 0) throw new Error("invalid hostname");
    } catch {
      throw new Error(`Allowed origin hostname '${value}' is invalid.`);
    }
    normalized.add(hostname);
  }
  return [...normalized];
}

function stopHttpServer(server: Server): Promise<void> {
  return new Promise((resolveStop, rejectStop) => {
    if (!server.listening) {
      resolveStop();
      return;
    }
    server.close((error) => {
      if (error !== undefined) rejectStop(error);
      else resolveStop();
    });
  });
}
