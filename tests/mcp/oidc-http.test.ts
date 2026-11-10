import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { test } from "node:test";
import { grantExternalIdentity } from "../../src/application/external-identities.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";
import { createMcpHttpServer, listenMcpHttpServer } from "../../src/mcp/http-server.js";

const oidcWebhookSecret = "oidc-webhook-test-secret-with-at-least-32-bytes";

test("OIDC protects both MCP eras and publishes provisioned project access", async (context) => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const testKeyId = "ssdd-test-key";
  let testIssuer = "";
  const identityProvider = createServer((request, response) => {
    answerIdentityProviderRequest(request, response, {
      issuer: testIssuer,
      jwks: { keys: [{ ...publicJwk, kid: testKeyId, alg: "RS256", use: "sig" }] },
    });
  });
  await listenLocal(identityProvider);
  const identityAddress = identityProvider.address();
  assert.ok(identityAddress !== null && typeof identityAddress !== "string");
  const issuer = `http://127.0.0.1:${identityAddress.port}`;
  testIssuer = issuer;
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-oidc-http-"));
  const initialized = initializeProject({
    workspace,
    key: "PAY",
    name: "Payments",
    productGoal: "Pagamentos confiáveis",
    timezone: "America/Sao_Paulo",
  });
  const database = openSqliteDatabase(initialized.databasePath);
  const admin = database.prepare(
    "SELECT created_by_principal_id FROM projects WHERE project_id = ?",
  ).get(initialized.project.id) as { created_by_principal_id: string };
  for (const [subject, displayName, roles] of [
    ["alice", "Alice", ["admin", "stakeholder"]],
    ["bob", "Bob", ["stakeholder"]],
  ] as const) {
    grantExternalIdentity(database, {
      projectId: initialized.project.id,
      principalId: admin.created_by_principal_id,
      requestId: `grant-${subject}`,
      issuer,
      subject,
      displayName,
      principalType: "human",
      roles,
      reason: "Acesso remoto autorizado para validar o transporte.",
    });
  }
  const agentPrincipalId = grantExternalIdentity(database, {
    projectId: initialized.project.id,
    principalId: admin.created_by_principal_id,
    requestId: "grant-deployment-agent",
    issuer,
    subject: "deployment-agent",
    displayName: "Deployment agent",
    principalType: "agent",
    roles: ["po"],
    reason: "Automação de entrega provisionada para testar aprovação delegada.",
  }).value.principalId;
  database.close();

  const mcpPort = await findFreePort();
  const resourceUrl = "https://mcp.example.com/mcp";
  const handle = createMcpHttpServer(workspace, {
    issuer,
    resourceUrl,
    allowedOrigins: ["client.example.com"],
    webhookSecrets: { github: { PAY: oidcWebhookSecret } },
    githubRepositories: { PAY: "acme/payments" },
  });
  const address = await listenMcpHttpServer(handle, mcpPort);
  const requestUrl = `${address.origin}/mcp`;
  const webhookBody = JSON.stringify({
    action: "opened",
    repository: { id: 123456, full_name: "acme/payments" },
    pull_request: {
      number: 17,
      html_url: "https://github.com/acme/payments/pull/17",
      title: "PAY-1 Add payment retry",
      state: "open",
      merged: false,
      draft: false,
      head: { ref: "feature/PAY-1-retry", sha: "a".repeat(40) },
      base: { ref: "main", sha: "b".repeat(40) },
    },
  });
  const webhookSignature = createHmac("sha256", oidcWebhookSecret).update(webhookBody).digest("hex");
  const webhookResponse = await fetch(`${address.origin}/webhooks/github/PAY`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "oidc-webhook-001",
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${webhookSignature}`,
    },
    body: webhookBody,
  });
  assert.equal(webhookResponse.status, 202, "a valid webhook signature authenticates without a Bearer token");
  let legacySessionId: string | undefined;
  const aliceToken = await issueToken(privateKey, testKeyId, issuer, "alice", resourceUrl);
  const bobToken = await issueToken(privateKey, testKeyId, issuer, "bob", resourceUrl);
  const agentToken = await issueToken(privateKey, testKeyId, issuer, "deployment-agent", resourceUrl);
  const client = new Client({ name: "ssdd-oidc-legacy-tests", version: "0.1.0" });
  const legacyTransport = new StreamableHTTPClientTransport(new URL(requestUrl), {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${aliceToken}`);
      const response = await fetch(input, { ...init, headers });
      legacySessionId = response.headers.get("mcp-session-id") ?? legacySessionId;
      return response;
    },
  });
  const modernClient = new Client(
    { name: "ssdd-oidc-modern-tests", version: "0.1.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const agentLegacyClient = new Client({ name: "ssdd-oidc-agent-legacy-tests", version: "0.1.0" });
  const agentLegacyTransport = new StreamableHTTPClientTransport(new URL(requestUrl), {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${agentToken}`);
      return fetch(input, { ...init, headers });
    },
  });
  const agentModernClient = new Client(
    { name: "ssdd-oidc-agent-modern-tests", version: "0.1.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const agentModernTransport = new StreamableHTTPClientTransport(new URL(requestUrl), {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${agentToken}`);
      return fetch(input, { ...init, headers });
    },
  });
  const modernTransport = new StreamableHTTPClientTransport(new URL(requestUrl), {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${aliceToken}`);
      return fetch(input, { ...init, headers });
    },
  });

  context.after(async () => {
    await client.close();
    await modernClient.close();
    await agentLegacyClient.close();
    await agentModernClient.close();
    await handle.close();
    await closeServer(identityProvider);
    rmSync(workspace, { recursive: true, force: true });
  });

  const discovery = await fetch(`${address.origin}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(discovery.status, 200);
  const metadata = await discovery.json() as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
  assert.equal(metadata.resource, resourceUrl);
  assert.deepEqual(metadata.authorization_servers, [issuer]);
  assert.deepEqual(metadata.scopes_supported, ["ssdd:mcp"]);

  const missingToken = await postInitialize(requestUrl);
  assert.equal(missingToken.status, 401);
  assert.match(missingToken.headers.get("www-authenticate") ?? "", /resource_metadata=/u);
  assert.match(missingToken.headers.get("www-authenticate") ?? "", /scope="ssdd:mcp"/u);

  const badIssuer = await issueToken(privateKey, testKeyId, issuer, "alice", resourceUrl, { issuer: "http://127.0.0.1:1" });
  assert.equal((await postInitialize(requestUrl, badIssuer)).status, 401);
  const badAudience = await issueToken(privateKey, testKeyId, issuer, "alice", "http://127.0.0.1:4319/mcp");
  assert.equal((await postInitialize(requestUrl, badAudience)).status, 401);
  const noExpiry = await issueToken(privateKey, testKeyId, issuer, "alice", resourceUrl, { expiration: false });
  assert.equal((await postInitialize(requestUrl, noExpiry)).status, 401);
  const expired = await issueToken(privateKey, testKeyId, issuer, "alice", resourceUrl, { expiration: "-1m" });
  assert.equal((await postInitialize(requestUrl, expired)).status, 401);
  const notYetValid = await issueToken(privateKey, testKeyId, issuer, "alice", resourceUrl, { notBefore: "10m" });
  assert.equal((await postInitialize(requestUrl, notYetValid)).status, 401);
  const missingScope = await issueToken(privateKey, testKeyId, issuer, "alice", resourceUrl, { scope: "openid" });
  const scopeResponse = await postInitialize(requestUrl, missingScope);
  assert.equal(scopeResponse.status, 403);
  assert.match(scopeResponse.headers.get("www-authenticate") ?? "", /insufficient_scope/u);
  const unprovisioned = await issueToken(privateKey, testKeyId, issuer, "unprovisioned-user", resourceUrl);
  assert.equal((await postInitialize(requestUrl, unprovisioned)).status, 403);

  const canonicalHostRequest = await requestWithHostHeader(mcpPort, "mcp.example.com", aliceToken);
  assert.equal(canonicalHostRequest.status, 400);
  const allowedBrowserOrigin = await fetch(requestUrl, {
    headers: { origin: "https://client.example.com", authorization: `Bearer ${aliceToken}` },
  });
  assert.equal(allowedBrowserOrigin.status, 400);
  const rejectedBrowserOrigin = await fetch(requestUrl, {
    headers: { origin: "https://attacker.example", authorization: `Bearer ${aliceToken}` },
  });
  assert.equal(rejectedBrowserOrigin.status, 403);

  await client.connect(legacyTransport);
  const legacyProjects = await client.callTool({ name: "project_list", arguments: {} });
  assert.notEqual(legacyProjects.isError, true);
  assert.equal((legacyProjects.structuredContent as { projects: Array<{ key: string }> }).projects[0]?.key, "PAY");
  assert.ok(legacySessionId);

  const legacyArguments = {
    projectId: initialized.project.id,
    requestId: "oidc-agent-legacy-create",
    type: "epic",
    title: "Legacy approved automation",
  };
  const legacyApproval = await issueApproval(client, initialized.project.id, agentPrincipalId, "oidc-approval-legacy", legacyArguments);
  await agentLegacyClient.connect(agentLegacyTransport);
  const legacyMutation = await agentLegacyClient.callTool({
    name: "work_item_create",
    arguments: legacyArguments,
    _meta: { "com.ssdd-mcp/approval-id": legacyApproval },
  });
  assert.notEqual(legacyMutation.isError, true);

  const sessionHijack = await fetch(requestUrl, {
    headers: { "mcp-session-id": legacySessionId, authorization: `Bearer ${bobToken}` },
  });
  assert.equal(sessionHijack.status, 403);
  assert.equal((await sessionHijack.json() as { code: string }).code, "SESSION_PRINCIPAL_MISMATCH");

  await modernClient.connect(modernTransport);
  const modernProjects = await modernClient.callTool({ name: "project_list", arguments: {} });
  assert.notEqual(modernProjects.isError, true);
  assert.equal((modernProjects.structuredContent as { projects: Array<{ key: string }> }).projects[0]?.key, "PAY");

  const modernArguments = {
    projectId: initialized.project.id,
    requestId: "oidc-agent-modern-create",
    type: "epic",
    title: "Modern approved automation",
  };
  const modernApproval = await issueApproval(client, initialized.project.id, agentPrincipalId, "oidc-approval-modern", modernArguments);
  await agentModernClient.connect(agentModernTransport);
  const modernMutation = await agentModernClient.callTool({
    name: "work_item_create",
    arguments: modernArguments,
    _meta: { "com.ssdd-mcp/approval-id": modernApproval },
  });
  assert.notEqual(modernMutation.isError, true);
});

async function issueApproval(
  adminClient: Client,
  projectId: string,
  executorPrincipalId: string,
  requestId: string,
  argumentsValue: Record<string, string>,
): Promise<string> {
  const result = await adminClient.callTool({
    name: "approval_issue",
    arguments: {
      projectId,
      requestId,
      toolName: "work_item_create",
      arguments: argumentsValue,
      expectedVersion: null,
      executorPrincipalId,
      expiresInSeconds: 120,
      reason: "A chamada foi revisada por um admin humano.",
    },
  });
  assert.notEqual(result.isError, true);
  const content = result.structuredContent as { approval?: { approvalId?: string } } | undefined;
  assert.equal(typeof content?.approval?.approvalId, "string");
  return content?.approval?.approvalId as string;
}

async function issueToken(
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"],
  keyId: string,
  issuer: string,
  subject: string,
  audience: string,
  options: {
    readonly issuer?: string;
    readonly scope?: string;
    readonly expiration?: string | false;
    readonly notBefore?: string;
  } = {},
): Promise<string> {
  const token = new SignJWT(options.scope === undefined ? { scope: "ssdd:mcp" } : { scope: options.scope })
    .setProtectedHeader({ alg: "RS256", kid: keyId });
  token.setIssuer(options.issuer ?? issuer);
  token.setAudience(audience).setSubject(subject).setIssuedAt();
  if (options.expiration !== false) token.setExpirationTime(options.expiration ?? "5m");
  if (options.notBefore !== undefined) token.setNotBefore(options.notBefore);
  return token.sign(privateKey);
}

function answerIdentityProviderRequest(
  request: IncomingMessage,
  response: ServerResponse,
  values: { readonly issuer: string; readonly jwks: { readonly keys: readonly Record<string, unknown>[] } },
): void {
  if (request.url === "/.well-known/openid-configuration") {
    sendJson(response, 200, {
      issuer: values.issuer,
      authorization_endpoint: `${values.issuer}/authorize`,
      token_endpoint: `${values.issuer}/token`,
      jwks_uri: `${values.issuer}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "ssdd:mcp"],
    });
    return;
  }
  if (request.url === "/jwks") {
    sendJson(response, 200, values.jwks);
    return;
  }
  sendJson(response, 404, { error: "not_found" });
}

async function postInitialize(url: string, token?: string): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "ssdd-http-auth-test", version: "0.1.0" },
      },
    }),
  });
}

function requestWithHostHeader(port: number, host: string, token: string): Promise<{ readonly status: number }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/mcp",
      method: "GET",
      headers: { host, authorization: `Bearer ${token}` },
    }, (response) => {
      response.resume();
      response.on("end", () => resolveRequest({ status: response.statusCode ?? 0 }));
    });
    request.once("error", rejectRequest);
    request.end();
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function listenLocal(server: Server): Promise<void> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

function findFreePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectPort(new Error("Could not reserve a local port for the OIDC test."));
        return;
      }
      server.close((error) => {
        if (error !== undefined) rejectPort(error);
        else resolvePort(address.port);
      });
    });
  });
}

