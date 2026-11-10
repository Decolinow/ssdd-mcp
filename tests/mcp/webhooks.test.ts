import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { listGithubReferences } from "../../src/application/github-webhooks.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";
import {
  createMcpHttpServer,
  listenMcpHttpServer,
} from "../../src/mcp/http-server.js";
import {
  maximumWebhookRequestBytes,
  readWebhookSecretsFromEnvironment,
} from "../../src/mcp/webhook-receiver.js";
import { readGithubRepositoriesFromEnvironment } from "../../src/application/github-webhooks.js";

const providerSecret = "test-only-webhook-secret-with-32-bytes-minimum";

test("GitHub webhook accepts signed deliveries and replays the original receipt", async (context) => {
  const workspace = createWorkspace();
  const handle = createMcpHttpServer(workspace, {
    webhookSecrets: { github: { PAY: providerSecret } },
    githubRepositories: { PAY: "acme/payments" },
  });
  const address = await listenMcpHttpServer(handle, 0);
  context.after(async () => {
    await handle.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const payload = JSON.stringify(githubRepositoryPayload());
  const first = await postGithubWebhook(address.origin, payload, "delivery-001");
  assert.equal(first.status, 202);
  const originalReceipt = await first.text();
  const receipt = JSON.parse(originalReceipt) as {
    receiptId: string;
    provider: string;
    deliveryId: string;
    eventType: string;
    status: string;
  };
  assert.match(receipt.receiptId, /^[0-9a-f-]{36}$/iu);
  assert.equal(receipt.provider, "github");
  assert.equal(receipt.deliveryId, "delivery-001");
  assert.equal(receipt.eventType, "push");
  assert.equal(receipt.status, "accepted");

  const replays = await Promise.all(Array.from({ length: 3 }, () =>
    postGithubWebhook(address.origin, payload, "delivery-001"),
  ));
  for (const replay of replays) {
    assert.equal(replay.status, 202);
    assert.equal(replay.headers.get("x-ssdd-webhook-replay"), "true");
    assert.equal(await replay.text(), originalReceipt);
  }

  const database = openWorkspaceDatabase(workspace);
  try {
    const stored = database.prepare(
      `SELECT receipt_id, provider, delivery_id, event_type, payload_sha256, receipt_json
       FROM webhook_receipts`,
    ).all() as Array<Record<string, string>>;
    const audit = database.prepare(
      `SELECT event_type, entity_type, payload_json, principal.principal_type
       FROM audit_events AS event
       INNER JOIN principals AS principal ON principal.principal_id = event.principal_id
       WHERE event.event_type = 'webhook.received'`,
    ).all() as Array<Record<string, string>>;

    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.receipt_json, originalReceipt);
    assert.match(stored[0]?.payload_sha256 ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.entity_type, "webhook_receipt");
    assert.equal(audit[0]?.principal_type, "service");
    assert.match(audit[0]?.payload_json ?? "", /delivery-001/u);
    assert.doesNotMatch(JSON.stringify({ stored, audit }), new RegExp(providerSecret, "u"));
    assert.doesNotMatch(JSON.stringify({ stored, audit }), /acme\/payments/u);
    assert.throws(
      () => database.prepare("UPDATE webhook_receipts SET event_type = 'push' WHERE receipt_id = ?").run(receipt.receiptId),
      /webhook receipts are immutable/u,
    );
    assert.throws(
      () => database.prepare("DELETE FROM webhook_receipts WHERE receipt_id = ?").run(receipt.receiptId),
      /webhook receipts are immutable/u,
    );
  } finally {
    database.close();
  }
});

test("invalid signatures and payloads do not create receipts, principals, or audit events", async (context) => {
  const workspace = createWorkspace();
  const handle = createMcpHttpServer(workspace, {
    webhookSecrets: { github: { PAY: providerSecret } },
    githubRepositories: { PAY: "acme/payments" },
  });
  const address = await listenMcpHttpServer(handle, 0);
  context.after(async () => {
    await handle.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const validJson = JSON.stringify({ action: "opened" });
  const missingSignatureHeaders = githubHeaders(validJson, "delivery-missing-signature");
  delete missingSignatureHeaders["x-hub-signature-256"];
  const missingSignature = await fetch(`${address.origin}/webhooks/github/PAY`, {
    method: "POST",
    headers: missingSignatureHeaders,
    body: validJson,
  });
  assert.equal(missingSignature.status, 400);

  const badSignature = await fetch(`${address.origin}/webhooks/github/PAY`, {
    method: "POST",
    headers: {
      ...githubHeaders(validJson, "delivery-bad-signature"),
      "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
    },
    body: validJson,
  });
  assert.equal(badSignature.status, 401);

  const invalidJson = "{\"action\":";
  const invalidPayload = await postGithubWebhook(address.origin, invalidJson, "delivery-invalid-json");
  assert.equal(invalidPayload.status, 400);
  const arrayPayload = await postGithubWebhook(address.origin, "[]", "delivery-array-json");
  assert.equal(arrayPayload.status, 400);

  const database = openWorkspaceDatabase(workspace);
  try {
    assert.equal(countRows(database, "webhook_receipts"), 0);
    assert.equal(countRows(database, "audit_events", "event_type = 'webhook.received'"), 0);
    assert.equal(countRows(database, "principals", "principal_type = 'service'"), 0);
  } finally {
    database.close();
  }
});

test("webhook receiver rejects delivery conflicts, unconfigured targets, and oversized bodies", async (context) => {
  const workspace = createWorkspace();
  const handle = createMcpHttpServer(workspace, {
    webhookSecrets: { github: { PAY: providerSecret, NOPE: providerSecret } },
    githubRepositories: { PAY: "acme/payments", NOPE: "acme/nope" },
  });
  const address = await listenMcpHttpServer(handle, 0);
  context.after(async () => {
    await handle.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const foreignOriginBody = JSON.stringify({ action: "opened" });
  const foreignOriginResponse = await fetch(`${address.origin}/webhooks/github/PAY`, {
    method: "POST",
    headers: { ...githubHeaders(foreignOriginBody, "delivery-foreign-origin"), origin: "https://attacker.example" },
    body: foreignOriginBody,
  });
  assert.equal(foreignOriginResponse.status, 403);

  const accepted = await postGithubWebhook(address.origin, JSON.stringify(githubRepositoryPayload()), "delivery-conflict");
  assert.equal(accepted.status, 202);
  const conflictingReplay = await postGithubWebhook(address.origin, JSON.stringify(githubRepositoryPayload("acme/other")), "delivery-conflict");
  assert.equal(conflictingReplay.status, 409);

  const unknownProvider = await fetch(`${address.origin}/webhooks/unknown/PAY`, {
    method: "POST",
    headers: githubHeaders("{}", "delivery-unknown-provider"),
    body: "{}",
  });
  assert.equal(unknownProvider.status, 404);
  const unknownProject = await postGithubWebhook(address.origin, "{}", "delivery-unknown-project", "NOPE");
  assert.equal(unknownProject.status, 404);

  const largeBody = "x".repeat(maximumWebhookRequestBytes + 1);
  const contentLengthExceeded = await fetch(`${address.origin}/webhooks/github/PAY`, {
    method: "POST",
    headers: {
      ...githubHeaders(largeBody, "delivery-large-content-length"),
      "content-type": "application/json",
    },
    body: largeBody,
  });
  assert.equal(contentLengthExceeded.status, 413);

  const chunkedExceeded = await rawChunkedWebhookRequest(address.port, largeBody);
  assert.equal(chunkedExceeded.status, 413);

  const database = openWorkspaceDatabase(workspace);
  try {
    assert.equal(countRows(database, "webhook_receipts"), 1);
    assert.equal(countRows(database, "audit_events", "event_type = 'webhook.received'"), 1);
  } finally {
    database.close();
  }
});

test("GitHub webhook requires an explicit repository mapping before recording a receipt", async (context) => {
  const workspace = createWorkspace();
  const handle = createMcpHttpServer(workspace, { webhookSecrets: { github: { PAY: providerSecret } } });
  const address = await listenMcpHttpServer(handle, 0);
  context.after(async () => {
    await handle.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const response = await postGithubWebhook(
    address.origin,
    JSON.stringify(githubRepositoryPayload()),
    "delivery-without-repository-map",
  );
  assert.equal(response.status, 404);

  const database = openWorkspaceDatabase(workspace);
  try {
    assert.equal(countRows(database, "webhook_receipts"), 0);
    assert.equal(countRows(database, "principals", "principal_type = 'service'"), 0);
    assert.equal(countRows(database, "audit_events", "event_type = 'webhook.received'"), 0);
  } finally {
    database.close();
  }
});

test("GitHub PR and workflow events create linked immutable references without changing QA state", async (context) => {
  const workspace = createWorkspace();
  const handle = createMcpHttpServer(workspace, {
    webhookSecrets: { github: { PAY: providerSecret } },
    githubRepositories: { PAY: "acme/payments" },
  });
  const address = await listenMcpHttpServer(handle, 0);
  context.after(async () => {
    await handle.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const database = openWorkspaceDatabase(workspace);
  const project = database.prepare(
    "SELECT project_id, created_by_principal_id FROM projects WHERE project_key = 'PAY'",
  ).get() as { project_id: string; created_by_principal_id: string };
  const epic = createWorkItem(database, {
    projectId: project.project_id,
    principalId: project.created_by_principal_id,
    requestId: "github-fixture-epic",
    type: "epic",
    title: "Pagamentos",
  }).value;
  const feature = createWorkItem(database, {
    projectId: project.project_id,
    principalId: project.created_by_principal_id,
    requestId: "github-fixture-feature",
    type: "feature",
    parentId: epic.id,
    title: "Checkout",
  }).value;
  const story = createWorkItem(database, {
    projectId: project.project_id,
    principalId: project.created_by_principal_id,
    requestId: "github-fixture-story",
    type: "story",
    parentId: feature.id,
    title: "Reprocessar pagamento",
  }).value;
  const initialState = story.state;
  const initialVersion = story.version;
  database.close();

  const firstPullRequest = makePullRequestPayload({ action: "opened", headSha: "a".repeat(40) });
  const firstDelivery = await postGithubWebhook(
    address.origin,
    JSON.stringify(firstPullRequest),
    "github-pr-opened",
    "PAY",
    "pull_request",
  );
  assert.equal(firstDelivery.status, 202);
  const replay = await postGithubWebhook(
    address.origin,
    JSON.stringify(firstPullRequest),
    "github-pr-opened",
    "PAY",
    "pull_request",
  );
  assert.equal(replay.status, 202);
  assert.equal(replay.headers.get("x-ssdd-webhook-replay"), "true");

  const synchronized = await postGithubWebhook(
    address.origin,
    JSON.stringify(makePullRequestPayload({ action: "synchronize", headSha: "b".repeat(40) })),
    "github-pr-sync",
    "PAY",
    "pull_request",
  );
  assert.equal(synchronized.status, 202);

  const workflow = await postGithubWebhook(
    address.origin,
    JSON.stringify({
      action: "completed",
      repository: { id: 123456, full_name: "acme/payments" },
      workflow_run: {
        id: 99001,
        run_number: 22,
        name: "CI",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/acme/payments/actions/runs/99001",
        head_branch: `feature/${story.key}-checkout`,
        head_sha: "c".repeat(40),
        pull_requests: [{ number: 17 }],
      },
    }),
    "github-workflow-completed",
    "PAY",
    "workflow_run",
  );
  assert.equal(workflow.status, 202);

  const unsupportedAction = await postGithubWebhook(
    address.origin,
    JSON.stringify(makePullRequestPayload({ action: "assigned", headSha: "d".repeat(40) })),
    "github-pr-assigned",
    "PAY",
    "pull_request",
  );
  assert.equal(unsupportedAction.status, 202);

  const unresolvedKey = await postGithubWebhook(
    address.origin,
    JSON.stringify(makePullRequestPayload({
      action: "opened",
      headSha: "9".repeat(40),
      number: 18,
      branch: "feature/PAY-999-external-work",
      title: "External change",
    })),
    "github-pr-unresolved-key",
    "PAY",
    "pull_request",
  );
  assert.equal(unresolvedKey.status, 202);

  const wrongRepository = await postGithubWebhook(
    address.origin,
    JSON.stringify(makePullRequestPayload({ action: "opened", headSha: "f".repeat(40), repository: "attacker/fork" })),
    "github-pr-wrong-repository",
    "PAY",
    "pull_request",
  );
  assert.equal(wrongRepository.status, 404);

  const reopenedDatabase = openWorkspaceDatabase(workspace);
  try {
    const references = listGithubReferences(reopenedDatabase, {
      projectId: project.project_id,
      principalId: project.created_by_principal_id,
      workItemIdOrKey: story.key,
    });
    assert.equal(references.pullRequests.length, 1);
    assert.equal(references.pullRequests[0]?.number, 17);
    assert.equal(references.pullRequests[0]?.headSha, "b".repeat(40));
    assert.equal(references.pullRequests[0]?.workItemId, story.id);
    assert.equal(references.pullRequests[0]?.workItemKey, story.key);
    assert.equal(references.workflowRuns.length, 1);
    assert.equal(references.workflowRuns[0]?.id, "99001");
    assert.equal(references.workflowRuns[0]?.conclusion, "success");
    assert.equal(references.workflowRuns[0]?.pullRequestNumbers[0], 17);
    assert.equal(references.workflowRuns[0]?.workItemId, story.id);
    assert.equal(references.workflowRuns[0]?.workItemKey, story.key);
    const allReferences = listGithubReferences(reopenedDatabase, {
      projectId: project.project_id,
      principalId: project.created_by_principal_id,
    });
    const unresolved = allReferences.pullRequests.find(({ number }) => number === 18);
    assert.equal(unresolved?.workItemId, null);
    assert.equal(unresolved?.workItemKey, "PAY-999");
    assert.throws(
      () => listGithubReferences(reopenedDatabase, {
        projectId: project.project_id,
        principalId: randomUUID(),
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "FORBIDDEN",
    );

    const eventCounts = reopenedDatabase.prepare(
      `SELECT
         (SELECT COUNT(*) FROM github_pull_request_events) AS pull_requests,
         (SELECT COUNT(*) FROM github_workflow_run_events) AS workflow_runs,
         (SELECT COUNT(*) FROM webhook_receipts) AS receipts,
         (SELECT COUNT(*) FROM audit_events WHERE event_type = 'webhook.received') AS receipt_audits,
         (SELECT COUNT(*) FROM audit_events WHERE event_type IN ('github.pull_request.observed', 'github.workflow_run.observed')) AS github_audits,
         (SELECT COUNT(*) FROM test_run_certifications) AS certifications,
         (SELECT state FROM work_items WHERE item_id = ?) AS work_item_state,
         (SELECT version FROM work_items WHERE item_id = ?) AS work_item_version`,
    ).get(story.id, story.id) as {
      pull_requests: number; workflow_runs: number; receipts: number; receipt_audits: number;
      github_audits: number; certifications: number; work_item_state: string; work_item_version: number;
    };
    assert.deepEqual(eventCounts, {
      pull_requests: 3,
      workflow_runs: 1,
      receipts: 5,
      receipt_audits: 5,
      github_audits: 4,
      certifications: 0,
      work_item_state: initialState,
      work_item_version: initialVersion,
    });
    assert.throws(
      () => reopenedDatabase.prepare("UPDATE github_pull_request_events SET title = 'changed'").run(),
      /GitHub pull request events are immutable/u,
    );
    assert.throws(
      () => reopenedDatabase.prepare("DELETE FROM github_workflow_run_events").run(),
      /GitHub workflow run events are immutable/u,
    );
  } finally {
    reopenedDatabase.close();
  }
});

test("webhook secrets are read from provider-specific environment variables without exposing their values", () => {
  const secrets = readWebhookSecretsFromEnvironment({
    SSDD_WEBHOOK_SECRET_GITHUB__PAY: providerSecret,
    SSDD_WEBHOOK_SECRET_AZURE_DEVOPS__PAY: "a".repeat(32),
    OTHER_SECRET: "ignored",
  });
  assert.deepEqual(Object.keys(secrets).sort(), ["azure-devops", "github"]);
  assert.equal(secrets.github?.PAY, providerSecret);
  assert.throws(
    () => readWebhookSecretsFromEnvironment({ SSDD_WEBHOOK_SECRET_GITHUB__PAY: "short" }),
    /between 32 and 4096 UTF-8 bytes/u,
  );
  assert.throws(
    () => readWebhookSecretsFromEnvironment({ SSDD_WEBHOOK_SECRET_GITHUB_PAY: providerSecret }),
    /must end with/u,
  );
  assert.deepEqual(readGithubRepositoriesFromEnvironment({
    SSDD_GITHUB_REPOSITORY_PAY: "acme/payments",
    OTHER_REPOSITORY: "ignored/repo",
  }), { PAY: "acme/payments" });
  assert.throws(
    () => readGithubRepositoriesFromEnvironment({ SSDD_GITHUB_REPOSITORY_PAY: "payments" }),
    /owner\/repository/u,
  );
});

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-webhook-"));
  initializeProject({
    workspace,
    key: "PAY",
    name: "Payments",
    productGoal: "Pagamentos confiáveis",
    timezone: "America/Sao_Paulo",
  });
  return workspace;
}

function openWorkspaceDatabase(workspace: string) {
  const database = openSqliteDatabase(join(workspace, ".ssdd", "ssdd.sqlite"));
  applyMigrations(database);
  return database;
}

function countRows(database: ReturnType<typeof openWorkspaceDatabase>, table: string, where = "1 = 1"): number {
  const allowedTables = new Set(["webhook_receipts", "audit_events", "principals"]);
  assert.ok(allowedTables.has(table));
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as { count: number }).count;
}

function githubHeaders(body: string, deliveryId: string, eventType = "push"): Record<string, string> {
  const signature = createHmac("sha256", providerSecret).update(body).digest("hex");
  return {
    "content-type": "application/json",
    "x-github-delivery": deliveryId,
    "x-github-event": eventType,
    "x-hub-signature-256": `sha256=${signature}`,
  };
}

function postGithubWebhook(
  origin: string,
  body: string,
  deliveryId: string,
  projectKey = "PAY",
  eventType = "push",
): Promise<Response> {
  return fetch(`${origin}/webhooks/github/${projectKey}`, {
    method: "POST",
    headers: githubHeaders(body, deliveryId, eventType),
    body,
  });
}

function githubRepositoryPayload(fullName = "acme/payments") {
  return { repository: { id: 123456, full_name: fullName } };
}

function makePullRequestPayload(input: {
  readonly action: string;
  readonly headSha: string;
  readonly repository?: string;
  readonly number?: number;
  readonly branch?: string;
  readonly title?: string;
}): Record<string, unknown> {
  return {
    action: input.action,
    repository: { id: 123456, full_name: input.repository ?? "acme/payments" },
    pull_request: {
      number: input.number ?? 17,
      html_url: `https://github.com/acme/payments/pull/${input.number ?? 17}`,
      title: input.title ?? "Reprocessar pagamento PAY-3",
      state: "open",
      merged: false,
      draft: false,
      head: { ref: input.branch ?? "feature/PAY-3-checkout", sha: input.headSha },
      base: { ref: "main", sha: "e".repeat(40) },
    },
  };
}

function rawChunkedWebhookRequest(port: number, body: string): Promise<{ readonly status: number }> {
  const headers = githubHeaders(body, "delivery-large-chunked");
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/webhooks/github/PAY",
      method: "POST",
      headers: {
        ...headers,
        "transfer-encoding": "chunked",
      },
    }, (response) => {
      response.resume();
      response.on("end", () => resolveRequest({ status: response.statusCode ?? 0 }));
    });
    request.on("error", rejectRequest);
    request.end(body);
  });
}
