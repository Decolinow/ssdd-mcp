import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { test } from "node:test";
import { grantExternalIdentity } from "../../src/application/external-identities.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createDashboardApiServer, listenDashboardApiServer } from "../../src/dashboard/api.js";
import { createMcpHttpServer, listenMcpHttpServer } from "../../src/mcp/http-server.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";

test("release E2E delivers a story through distinct OIDC MCP clients and verifies it in the dashboard", async (context) => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const keyId = "ssdd-release-e2e-key";
  let issuer = "";
  const identityProvider = createServer((request, response) => {
    answerIdentityProviderRequest(request, response, {
      issuer,
      jwks: { keys: [{ ...publicJwk, kid: keyId, alg: "RS256", use: "sig" }] },
    });
  });
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-release-e2e-"));
  const clients: Client[] = [];
  const servers: {
    mcp?: ReturnType<typeof createMcpHttpServer>;
    dashboard?: ReturnType<typeof createDashboardApiServer>;
  } = {};
  context.after(async () => {
    await Promise.all(clients.map(async (client) => client.close().catch(() => undefined)));
    await servers.dashboard?.close();
    await servers.mcp?.close();
    await closeServer(identityProvider);
    rmSync(workspace, { recursive: true, force: true });
  });

  await listenLocal(identityProvider);
  const idpAddress = identityProvider.address();
  assert.ok(idpAddress !== null && typeof idpAddress !== "string");
  issuer = `http://127.0.0.1:${idpAddress.port}`;
  const resourceUrl = "https://mcp.example.com/mcp";
  const initialized = initializeProject({
    workspace,
    key: "PAY",
    name: "Payments release",
    productGoal: "Deliver a traceable release across MCP and dashboard",
    timezone: "America/Sao_Paulo",
  });

  const database = openSqliteDatabase(initialized.databasePath);
  try {
    const localAdminId = (database.prepare(
      "SELECT created_by_principal_id FROM projects WHERE project_id = ?",
    ).get(initialized.project.id) as { created_by_principal_id: string }).created_by_principal_id;
    for (const [subject, displayName, roles] of [
      ["release-po", "Release PO", ["po"]],
      ["release-dev", "Release Developer", ["developer"]],
      ["release-qa", "Release QA", ["qa"]],
    ] as const) {
      grantExternalIdentity(database, {
        projectId: initialized.project.id,
        principalId: localAdminId,
        requestId: `release-grant-${subject}`,
        issuer,
        subject,
        displayName,
        principalType: "human",
        roles,
        reason: "Provision identity for the release end-to-end fixture.",
      });
    }
  } finally {
    database.close();
  }

  servers.mcp = createMcpHttpServer(workspace, { issuer, resourceUrl });
  await servers.mcp.ready;
  const mcpAddress = await listenMcpHttpServer(servers.mcp, 0);
  const requestUrl = `${mcpAddress.origin}/mcp`;
  const po = await connectOidcClient(clients, "release-po", await issueToken(privateKey, keyId, issuer, "release-po", resourceUrl), requestUrl);
  const developer = await connectOidcClient(clients, "release-developer", await issueToken(privateKey, keyId, issuer, "release-dev", resourceUrl), requestUrl);
  const qa = await connectOidcClient(clients, "release-qa", await issueToken(privateKey, keyId, issuer, "release-qa", resourceUrl), requestUrl);

  const deniedEpic = await developer.callTool({
    name: "work_item_create",
    arguments: {
      projectId: initialized.project.id,
      requestId: "release-dev-forbidden-epic",
      type: "epic",
      title: "Developer cannot create a PO epic",
    },
  });
  assert.equal(deniedEpic.isError, true);
  assert.equal(readToolErrorCode(deniedEpic), "FORBIDDEN");

  const epic = await callTool<{ workItem: { id: string } }>(po, "work_item_create", {
    projectId: initialized.project.id,
    requestId: "release-epic",
    type: "epic",
    title: "Reliable checkout",
  });
  const feature = await callTool<{ workItem: { id: string } }>(po, "work_item_create", {
    projectId: initialized.project.id,
    requestId: "release-feature",
    type: "feature",
    parentId: epic.workItem.id,
    title: "Order confirmation",
  });
  const storyResult = await callTool<{
    workItem: { id: string; key: string; version: number };
  }>(po, "work_item_create", {
    projectId: initialized.project.id,
    requestId: "release-story",
    type: "story",
    parentId: feature.workItem.id,
    title: "Confirm a valid order",
    description: "Persist the order and return its identifier.",
    criteria: [{ description: "A valid order returns a unique identifier" }],
  });
  const story = storyResult.workItem;

  const scenario = await callTool<{ revision: { scenarioId: string } }>(qa, "scenario_create", {
    projectId: initialized.project.id,
    requestId: "release-scenario-create",
    key: "PAY-RELEASE-01",
    kind: "acceptance",
    title: "Order confirmation returns its identifier",
    steps: [{ action: "Confirm a valid order", expected: "A unique order identifier is returned" }],
    coverage: [{ targetType: "criterion", reference: `${story.key}:AC-1` }],
  });
  await callTool(qa, "scenario_revision_publish", {
    projectId: initialized.project.id,
    requestId: "release-scenario-publish",
    scenarioIdOrKey: scenario.revision.scenarioId,
    revisionNumber: 1,
    expectedVersion: 1,
  });

  const proposal = await callTool<{ proposal: { id: string } }>(developer, "work_item_estimate", {
    projectId: initialized.project.id,
    requestId: "release-estimate-propose",
    itemIdOrKey: story.id,
    unit: "points",
    value: 3,
    rationale: "Small, bounded delivery slice.",
    expectedVersion: 1,
  });
  await callTool(developer, "work_item_estimate_confirm", {
    projectId: initialized.project.id,
    requestId: "release-estimate-confirm",
    itemIdOrKey: story.id,
    proposalId: proposal.proposal.id,
    expectedVersion: 2,
  });
  const ready = await callTool<{ baseline: { id: string; sequence: number } }>(po, "work_item_transition", {
    projectId: initialized.project.id,
    requestId: "release-ready",
    itemIdOrKey: story.id,
    targetState: "ready",
    expectedVersion: 3,
    reason: "PO approved the published criteria and estimate.",
  });
  assert.equal(ready.baseline.sequence, 1);

  await callTool(developer, "work_item_transition", {
    projectId: initialized.project.id,
    requestId: "release-in-progress",
    itemIdOrKey: story.id,
    targetState: "in_progress",
    expectedVersion: 4,
    reason: "Developer started the approved story.",
  });
  const candidateBuild = "release-build-2026.11.09.1";
  const evidence = await callTool<{ evidence: { baselineId: string } }>(developer, "evidence_add", {
    projectId: initialized.project.id,
    requestId: "release-evidence",
    itemIdOrKey: story.id,
    kind: "build",
    uri: "https://ci.example/builds/release-build-2026.11.09.1",
    buildId: candidateBuild,
    description: "Candidate artifact produced by the release pipeline.",
  });
  assert.equal(evidence.evidence.baselineId, ready.baseline.id);
  await callTool(developer, "work_item_transition", {
    projectId: initialized.project.id,
    requestId: "release-in-review",
    itemIdOrKey: story.id,
    targetState: "in_review",
    expectedVersion: 5,
    reason: "Implementation is ready for review.",
  });
  await callTool(developer, "work_item_transition", {
    projectId: initialized.project.id,
    requestId: "release-in-validation",
    itemIdOrKey: story.id,
    targetState: "in_validation",
    expectedVersion: 6,
    reason: "Review passed and the candidate is ready for QA.",
  });

  const run = await callTool<{ run: { id: string } }>(qa, "test_run_record", {
    projectId: initialized.project.id,
    requestId: "release-test-run",
    scenarioIdOrKey: scenario.revision.scenarioId,
    revisionNumber: 1,
    buildId: candidateBuild,
    result: "passed",
    notes: "QA executed the published scenario against the release candidate.",
  });
  await callTool(qa, "test_run_certify", {
    projectId: initialized.project.id,
    requestId: "release-qa-certification",
    itemIdOrKey: story.id,
    runId: run.run.id,
    expectedVersion: 7,
    reason: "QA approved the latest passing run for the candidate build.",
  });
  await callTool(developer, "work_item_transition", {
    projectId: initialized.project.id,
    requestId: "release-done",
    itemIdOrKey: story.id,
    targetState: "done",
    expectedVersion: 8,
    reason: "QA passed and the candidate build has traceable evidence.",
    buildId: candidateBuild,
  });

  servers.dashboard = createDashboardApiServer(workspace);
  const dashboardAddress = await listenDashboardApiServer(servers.dashboard, 0);
  const landingPage = await fetch(`${dashboardAddress.origin}/`);
  assert.equal(landingPage.status, 200);
  assert.match(await landingPage.text(), /Product Backlog/u);
  const claimedPage = await fetch(`${dashboardAddress.origin}/?token=${encodeURIComponent(servers.dashboard.bootstrapToken)}`);
  assert.equal(claimedPage.status, 200);
  const setCookie = claimedPage.headers.get("set-cookie");
  assert.ok(setCookie);
  const cookie = setCookie.split(";", 1)[0];
  assert.ok(cookie);
  const dashboardItemsResponse = await fetch(
    `${dashboardAddress.origin}/api/v1/projects/${initialized.project.id}/work-items?state=done`,
    { headers: { Cookie: cookie, Origin: dashboardAddress.origin } },
  );
  assert.equal(dashboardItemsResponse.status, 200);
  const dashboardItems = await dashboardItemsResponse.json() as { items: Array<{ key: string; state: string }> };
  assert.ok(dashboardItems.items.some((item) => item.key === story.key && item.state === "done"));

  const dashboardQuality = await fetch(
    `${dashboardAddress.origin}/api/v1/projects/${initialized.project.id}/work-items/${story.key}/quality`,
    { headers: { Cookie: cookie, Origin: dashboardAddress.origin } },
  );
  assert.equal(dashboardQuality.status, 200);
  const quality = await dashboardQuality.json() as { quality: { mode: string; baseline: { id: string } | null } };
  assert.equal(quality.quality.mode, "pinned");
  assert.equal(quality.quality.baseline?.id, ready.baseline.id);
});

async function connectOidcClient(
  clients: Client[],
  name: string,
  token: string,
  requestUrl: string,
): Promise<Client> {
  const client = new Client(
    { name, version: "0.1.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(requestUrl), {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    },
  });
  await client.connect(transport);
  return client;
}

async function callTool<T = Record<string, unknown>>(
  client: Client,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: argumentsValue });
  if (result.isError === true) {
    throw new Error(`${name} failed: ${readToolErrorCode(result)} ${result.content.find((block) => block.type === "text")?.text ?? ""}`);
  }
  assert.ok(result.structuredContent, `${name} did not return structured content`);
  return result.structuredContent as T;
}

function readToolErrorCode(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  const content = result.content.find((block) => block.type === "text");
  assert.ok(content?.text);
  return (JSON.parse(content.text) as { code: string }).code;
}

async function issueToken(
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"],
  keyId: string,
  tokenIssuer: string,
  subject: string,
  audience: string,
): Promise<string> {
  return new SignJWT({ scope: "ssdd:mcp" })
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(tokenIssuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
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
