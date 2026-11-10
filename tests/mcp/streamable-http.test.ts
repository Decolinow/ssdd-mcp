import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { request as httpRequest } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";
import { createMcpHttpServer, listenMcpHttpServer, maximumMcpHttpRequestBytes } from "../../src/mcp/http-server.js";

const cliWebhookSecret = "cli-test-webhook-secret-with-at-least-32-bytes";

test("Streamable HTTP negotiates MCP and serves the same project tools as stdio", async (context) => {
  const workspace = createWorkspace();
  const handle = createMcpHttpServer(workspace);
  const address = await listenMcpHttpServer(handle, 0);
  const url = `${address.origin}/mcp`;
  let sessionId: string | undefined;
  const client = new Client({ name: "ssdd-http-tests", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      sessionId = response.headers.get("mcp-session-id") ?? sessionId;
      return response;
    },
  });

  context.after(async () => {
    await client.close();
    await handle.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  await client.connect(transport);
  assert.ok(sessionId, "initialize response should create an MCP session");
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "project_list"));
  assert.ok(tools.tools.some((tool) => tool.name === "metrics_get"));
  assert.ok(tools.tools.some((tool) => tool.name === "github_issue_import_preview"));
  assert.ok(tools.tools.some((tool) => tool.name === "github_issue_import_apply"));
  assert.ok(tools.tools.some((tool) => tool.name === "azure_work_item_import_preview"));
  assert.ok(tools.tools.some((tool) => tool.name === "azure_work_item_import_apply"));
  assert.ok(tools.tools.some((tool) => tool.name === "github_reference_list"));

  const projects = await client.callTool({ name: "project_list", arguments: {} });
  assert.notEqual(projects.isError, true);
  const content = projects.structuredContent as { projects: Array<{ id: string; key: string }> };
  assert.equal(content.projects.length, 1);
  assert.equal(content.projects[0]?.key, "PAY");
  const githubReferences = await client.callTool({
    name: "github_reference_list",
    arguments: { projectId: content.projects[0]!.id },
  });
  assert.notEqual(githubReferences.isError, true);
  assert.deepEqual(githubReferences.structuredContent, { pullRequests: [], workflowRuns: [] });

  const unsupportedVersion = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2099-01-01",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }),
  });
  assert.equal(unsupportedVersion.status, 400);
});

test("Streamable HTTP supports the MCP 2026-07-28 stateless protocol era", async (context) => {
  const workspace = createWorkspace();
  const handle = createMcpHttpServer(workspace);
  const address = await listenMcpHttpServer(handle, 0);
  const protocolVersions: string[] = [];
  const client = new Client(
    { name: "ssdd-http-modern-tests", version: "0.1.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${address.origin}/mcp`), {
    fetch: async (input, init) => {
      const version = new Headers(init?.headers).get("mcp-protocol-version");
      if (version !== null) protocolVersions.push(version);
      return fetch(input, init);
    },
  });

  context.after(async () => {
    await client.close();
    await handle.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "project_list"));
  const prompts = await client.listPrompts();
  assert.equal(prompts.prompts.length, 4);
  const skillClient = new SkillsClient(client);
  assert.equal(skillClient.supported, true);
  const skillListing = await skillClient.list();
  assert.equal(skillListing.skills.length, 4);
  const qualitySkill = await skillClient.read(
    skillListing.skills.find((skill) => skill.frontmatter.name === "ssdd-quality-assurance")!,
  );
  assert.equal(qualitySkill.verified, true);
  assert.match(qualitySkill.body ?? "", /Never invent a run/);
  const result = await client.callTool({ name: "project_list", arguments: {} });
  assert.notEqual(result.isError, true);
  assert.equal((result.structuredContent as { projects: Array<{ key: string }> }).projects[0]?.key, "PAY");
  assert.ok(protocolVersions.includes("2026-07-28"), "client should use the modern protocol after discovery");
});

test("GitHub issue import preview and apply work through an MCP HTTP client", async (context) => {
  const workspace = createWorkspace();
  const setupDatabase = openSqliteDatabase(join(workspace, ".ssdd", "ssdd.sqlite"));
  applyMigrations(setupDatabase);
  const project = setupDatabase.prepare(
    "SELECT project_id, created_by_principal_id FROM projects WHERE project_key = 'PAY'",
  ).get() as { project_id: string; created_by_principal_id: string };
  const epic = createWorkItem(setupDatabase, {
    projectId: project.project_id,
    principalId: project.created_by_principal_id,
    requestId: "http-import-epic",
    type: "epic",
    title: "Payments",
  }).value;
  const feature = createWorkItem(setupDatabase, {
    projectId: project.project_id,
    principalId: project.created_by_principal_id,
    requestId: "http-import-feature",
    type: "feature",
    parentId: epic.id,
    title: "Refunds",
  }).value;
  setupDatabase.close();

  const handle = createMcpHttpServer(workspace, {
    githubRepositories: { PAY: "acme/payments" },
    githubIssueTokens: { PAY: "readonly-github-import-token-123456" },
  });
  const address = await listenMcpHttpServer(handle, 0);
  const client = new Client({ name: "ssdd-github-import-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${address.origin}/mcp`));
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input.toString());
    if (url.origin !== "https://api.github.com") return originalFetch(input, init);
    methods.push(init?.method ?? "GET");
    return new Response(JSON.stringify([{
      id: 987654,
      number: 7,
      title: "Import refund support",
      body: "A refund request can be created.",
      state: "open",
      html_url: "https://github.com/acme/payments/issues/7",
      labels: [{ name: "feature" }],
      created_at: "2026-11-01T12:00:00Z",
      updated_at: "2026-11-02T12:00:00Z",
    }]), { status: 200, headers: { "content-type": "application/json" } });
  };

  context.after(async () => {
    globalThis.fetch = originalFetch;
    await client.close();
    await handle.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  await client.connect(transport);
  const argumentsBase = {
    projectId: project.project_id,
    parentFeatureIdOrKey: feature.id,
    workItemType: "story",
    limit: 10,
  };
  const previewResult = await client.callTool({ name: "github_issue_import_preview", arguments: argumentsBase });
  assert.notEqual(previewResult.isError, true);
  const preview = previewResult.structuredContent as { planHash: string; toCreate: number; skipped: number };
  assert.equal(preview.toCreate, 1);
  assert.equal(preview.skipped, 0);
  assert.match(preview.planHash, /^[a-f0-9]{64}$/u);

  const applyResult = await client.callTool({
    name: "github_issue_import_apply",
    arguments: {
      ...argumentsBase,
      requestId: "http-github-import-001",
      expectedPlanHash: preview.planHash,
    },
  });
  assert.notEqual(applyResult.isError, true);
  const applied = applyResult.structuredContent as {
    imported: Array<{ workItemId: string; workItemKey: string }>;
    alreadyImported: number;
  };
  assert.equal(applied.imported[0]?.workItemKey, "PAY-3");
  assert.equal(applied.alreadyImported, 0);
  assert.deepEqual(methods, ["GET", "GET"]);

  const importedItem = await client.callTool({
    name: "work_item_get",
    arguments: { projectId: project.project_id, itemIdOrKey: "PAY-3" },
  });
  assert.notEqual(importedItem.isError, true);
  assert.equal((importedItem.structuredContent as { workItem: { state: string } }).workItem.state, "draft");
});

test("Azure Boards preview and apply are read-only at the provider and flow through an MCP client", async (context) => {
  const workspace = createWorkspace();
  const setupDatabase = openSqliteDatabase(join(workspace, ".ssdd", "ssdd.sqlite"));
  applyMigrations(setupDatabase);
  const project = setupDatabase.prepare(
    "SELECT project_id, created_by_principal_id FROM projects WHERE project_key = 'PAY'",
  ).get() as { project_id: string; created_by_principal_id: string };
  const epic = createWorkItem(setupDatabase, {
    projectId: project.project_id,
    principalId: project.created_by_principal_id,
    requestId: "http-azure-import-epic",
    type: "epic",
    title: "Payments",
  }).value;
  const feature = createWorkItem(setupDatabase, {
    projectId: project.project_id,
    principalId: project.created_by_principal_id,
    requestId: "http-azure-import-feature",
    type: "feature",
    parentId: epic.id,
    title: "Refunds",
  }).value;
  setupDatabase.close();

  const handle = createMcpHttpServer(workspace, {
    azureDevOpsConnections: {
      PAY: {
        organization: "acme-dev",
        project: "Payments Core",
        token: "readonly-azure-devops-token-123456",
      },
    },
  });
  const address = await listenMcpHttpServer(handle, 0);
  const client = new Client({ name: "ssdd-azure-import-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${address.origin}/mcp`));
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; path: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input.toString());
    if (url.origin !== "https://dev.azure.com") return originalFetch(input, init);
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname });
    if (url.pathname.endsWith("/_apis/wit/wiql")) {
      return new Response(JSON.stringify({ workItems: [{ id: 781 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/_apis/wit/workitemsbatch")) {
      return new Response(JSON.stringify({ value: [{
        id: 781,
        fields: {
          "System.Id": 781,
          "System.Title": "Refund request support",
          "System.Description": "A refund request can be created.",
          "System.State": "New",
          "System.WorkItemType": "User Story",
          "System.CreatedDate": "2026-11-01T12:00:00Z",
          "System.ChangedDate": "2026-11-02T12:00:00Z",
          "System.Tags": "payments; refunds",
        },
      }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected Azure DevOps endpoint ${url.pathname}`);
  };

  context.after(async () => {
    globalThis.fetch = originalFetch;
    await client.close();
    await handle.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  await client.connect(transport);
  const argumentsBase = {
    projectId: project.project_id,
    parentFeatureIdOrKey: feature.id,
    azureWorkItemType: "User Story",
    limit: 10,
  };
  const previewResult = await client.callTool({ name: "azure_work_item_import_preview", arguments: argumentsBase });
  assert.notEqual(previewResult.isError, true);
  const preview = previewResult.structuredContent as {
    planHash: string;
    toCreate: number;
    provider: string;
    workItemType: string;
    externalWorkItemType: string | null;
  };
  assert.equal(preview.toCreate, 1);
  assert.equal(preview.provider, "azure-devops");
  assert.equal(preview.workItemType, "story");
  assert.equal(preview.externalWorkItemType, "User Story");
  assert.match(preview.planHash, /^[a-f0-9]{64}$/u);

  const applyResult = await client.callTool({
    name: "azure_work_item_import_apply",
    arguments: {
      ...argumentsBase,
      requestId: "http-azure-import-001",
      expectedPlanHash: preview.planHash,
    },
  });
  assert.notEqual(applyResult.isError, true);
  const applied = applyResult.structuredContent as { imported: Array<{ workItemId: string; workItemKey: string }> };
  assert.equal(applied.imported[0]?.workItemKey, "PAY-3");
  assert.deepEqual(requests.map(({ method }) => method), ["POST", "POST", "POST", "POST"]);
  assert.ok(requests.every(({ path }) => path.endsWith("/_apis/wit/wiql") || path.endsWith("/_apis/wit/workitemsbatch")));

  const importedItem = await client.callTool({
    name: "work_item_get",
    arguments: { projectId: project.project_id, itemIdOrKey: "PAY-3" },
  });
  assert.notEqual(importedItem.isError, true);
  const item = (importedItem.structuredContent as { workItem: { type: string; state: string } }).workItem;
  assert.equal(item.type, "story");
  assert.equal(item.state, "draft");
});

test("Streamable HTTP rejects remote origins/hosts, oversized bodies, and unknown sessions", async (context) => {
  const workspace = createWorkspace();
  const handle = createMcpHttpServer(workspace);
  const address = await listenMcpHttpServer(handle, 0);
  const url = `${address.origin}/mcp`;

  context.after(async () => {
    await handle.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const invalidOrigin = await fetch(url, {
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(invalidOrigin.status, 403);

  const invalidHost = await rawHttpRequest(address.port, {
    method: "GET",
    headers: { host: "attacker.example" },
  });
  assert.equal(invalidHost.status, 403);

  const oversizedBody = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(maximumMcpHttpRequestBytes + 1),
  });
  assert.equal(oversizedBody.status, 413);

  const chunkedOversizedBody = await rawHttpRequest(address.port, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "transfer-encoding": "chunked",
    },
    body: "x".repeat(maximumMcpHttpRequestBytes + 1),
  });
  assert.equal(chunkedOversizedBody.status, 413);

  const unknownSession = await fetch(url, {
    headers: { "mcp-session-id": "not-a-session" },
  });
  assert.equal(unknownSession.status, 404);
});

test("serve CLI accepts a real Streamable HTTP client in a separate process", async (context) => {
  const workspace = createWorkspace();
  const port = await findFreePort();
  const cliPath = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const processHandle = spawn(process.execPath, [
    cliPath,
    "serve",
    "--workspace",
    workspace,
    "--port",
    String(port),
  ], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      SSDD_WEBHOOK_SECRET_GITHUB__PAY: cliWebhookSecret,
      SSDD_GITHUB_REPOSITORY_PAY: "acme/payments",
    },
  });
  const client = new Client({ name: "ssdd-http-process-tests", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

  context.after(async () => {
    await client.close();
    if (processHandle.exitCode === null) {
      processHandle.kill("SIGTERM");
      await once(processHandle, "exit");
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  const startupOutput = await waitForOutput(processHandle, "Recepção de webhooks autenticada");
  assert.doesNotMatch(startupOutput, new RegExp(cliWebhookSecret, "u"));
  await client.connect(transport);
  const result = await client.callTool({ name: "project_list", arguments: {} });
  assert.notEqual(result.isError, true);
  assert.equal((result.structuredContent as { projects: Array<{ key: string }> }).projects[0]?.key, "PAY");

  const webhookBody = JSON.stringify({ repository: { id: 123456, full_name: "acme/payments" } });
  const webhookSignature = createHmac("sha256", cliWebhookSecret).update(webhookBody).digest("hex");
  const webhookResponse = await fetch(`http://127.0.0.1:${port}/webhooks/github/PAY`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "cli-delivery-001",
      "x-github-event": "ping",
      "x-hub-signature-256": `sha256=${webhookSignature}`,
    },
    body: webhookBody,
  });
  assert.equal(webhookResponse.status, 202);
});

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-http-"));
  initializeProject({
    workspace,
    key: "PAY",
    name: "Payments",
    productGoal: "Pagamentos confiáveis",
    timezone: "America/Sao_Paulo",
  });
  return workspace;
}

function rawHttpRequest(
  port: number,
  options: { readonly method: string; readonly headers: Record<string, string>; readonly body?: string },
): Promise<{ readonly status: number }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/mcp",
      method: options.method,
      headers: options.headers,
    }, (response) => {
      response.resume();
      response.on("end", () => resolveRequest({ status: response.statusCode ?? 0 }));
    });
    request.on("error", rejectRequest);
    request.end(options.body);
  });
}

function findFreePort(): Promise<number> {
  const server = createTcpServer();
  return new Promise((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectPort(new Error("Could not reserve a local TCP port for the CLI test."));
        return;
      }
      server.close((error) => {
        if (error !== undefined) rejectPort(error);
        else resolvePort(address.port);
      });
    });
  });
}

function waitForOutput(
  child: ReturnType<typeof spawn>,
  expectedText: string,
): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      rejectOutput(new Error(`Timed out waiting for CLI output. Received: ${output}`));
    }, 5_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      if (!output.includes(expectedText)) return;
      cleanup();
      resolveOutput(output);
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectOutput(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      rejectOutput(new Error(`MCP serve exited before readiness (code ${code}). ${output}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stderr?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}
