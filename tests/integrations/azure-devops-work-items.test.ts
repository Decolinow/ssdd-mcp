import assert from "node:assert/strict";
import { test } from "node:test";
import { ApplicationError } from "../../src/application/errors.js";
import {
  fetchAzureDevOpsWorkItems,
  readAzureDevOpsConnectionsFromEnvironment,
  type AzureDevOpsWorkItemImportOptions,
} from "../../src/integrations/azure-devops-work-items.js";

const connection = {
  organization: "acme-dev",
  project: "Payments Core",
  token: "read-only-azure-devops-token-123456",
};

test("Azure DevOps reader runs fixed WIQL and 200-item-bounded read batches", async () => {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = init ?? {};
    requests.push({ url: new URL(input.toString()), init: request });
    if (requests.length === 1) {
      return jsonResponse({ workItems: [{ id: 42, url: "ignored" }, { id: 43, url: "ignored" }] });
    }
    return jsonResponse({ value: [azureItem(42), azureItem(43, { type: "Bug", tags: "security; refund" })] });
  };

  const items = await fetchAzureDevOpsWorkItems({
    ...connection,
    workItemType: "User Story",
    limit: 2,
  }, fetcher);

  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(({ init }) => init.method), ["POST", "POST"]);
  assert.ok(requests.every(({ url }) => url.origin === "https://dev.azure.com"));
  assert.ok(requests.every(({ init }) => init.redirect === "error"));
  assert.equal(requests[0]?.url.pathname, "/acme-dev/Payments%20Core/_apis/wit/wiql");
  assert.equal(requests[0]?.url.searchParams.get("api-version"), "7.1");
  assert.equal(requests[0]?.url.searchParams.get("$top"), "2");
  const expectedAuth = `Basic ${Buffer.from(`:${connection.token}`).toString("base64")}`;
  assert.equal(new Headers(requests[0]?.init.headers).get("authorization"), expectedAuth);
  const wiql = JSON.parse(String(requests[0]?.init.body)) as { query: string };
  assert.match(wiql.query, /\[System\.WorkItemType\] = 'User Story'/u);
  assert.match(wiql.query, /ORDER BY \[System\.ChangedDate\] DESC/u);
  const batch = JSON.parse(String(requests[1]?.init.body)) as { ids: number[]; fields: string[] };
  assert.deepEqual(batch.ids, [42, 43]);
  assert.ok(batch.ids.length <= 200);
  assert.ok(batch.fields.includes("System.WorkItemType"));
  assert.deepEqual(items.map(({ externalId }) => externalId), ["42", "43"]);
  assert.equal(items[0]?.sourceType, "User Story");
  assert.equal(items[1]?.sourceType, "Bug");
  assert.deepEqual(items[1]?.labels, ["security", "refund"]);
  assert.equal(items[0]?.url, "https://dev.azure.com/acme-dev/Payments%20Core/_workitems/edit/42");
});

test("Azure DevOps reader preserves missing and unmapped types for preview filtering", async () => {
  let requestCount = 0;
  const fetcher: typeof fetch = async () => {
    requestCount += 1;
    return requestCount === 1
      ? jsonResponse({ workItems: [{ id: 11 }, { id: 12 }, { id: 13 }] })
      : jsonResponse({ value: [
        azureItem(11, { type: null }),
        azureItem(12, { type: "Task" }),
        azureItem(13, { type: "User Story" }),
      ] });
  };

  const items = await fetchAzureDevOpsWorkItems({ ...connection, workItemType: "User Story" }, fetcher);

  assert.deepEqual(items.map(({ sourceType }) => sourceType), [null, "Task", "User Story"]);
});

test("Azure DevOps reader rejects unsafe connection settings and sanitizes provider errors", async () => {
  assert.throws(
    () => readAzureDevOpsConnectionsFromEnvironment({
      SSDD_AZURE_DEVOPS_ORGANIZATION_PAY: connection.organization,
      SSDD_AZURE_DEVOPS_PROJECT_PAY: connection.project,
    }),
    /requires organization, project, and token/u,
  );
  assert.throws(
    () => readAzureDevOpsConnectionsFromEnvironment({
      SSDD_AZURE_DEVOPS_ORGANIZATION_PAY: "https://attacker.example",
      SSDD_AZURE_DEVOPS_PROJECT_PAY: connection.project,
      SSDD_AZURE_DEVOPS_TOKEN_PAY: connection.token,
    }),
    /organization/u,
  );
  assert.deepEqual(readAzureDevOpsConnectionsFromEnvironment({
    SSDD_AZURE_DEVOPS_ORGANIZATION_PAY: connection.organization,
    SSDD_AZURE_DEVOPS_PROJECT_PAY: connection.project,
    SSDD_AZURE_DEVOPS_TOKEN_PAY: connection.token,
  }), { PAY: connection });

  await assert.rejects(
    fetchAzureDevOpsWorkItems({ ...connection, workItemType: "User Story" }, async () => new Response("private PAT detail", {
      status: 401,
      headers: { "content-type": "application/json" },
    })),
    (error: unknown) => error instanceof ApplicationError && error.code === "AZURE_DEVOPS_AUTH_FAILED" && !error.message.includes("private PAT detail"),
  );
  await assert.rejects(
    fetchAzureDevOpsWorkItems({ ...connection, workItemType: "User Story" }, async () => {
      throw new Error("network exception containing a secret");
    }),
    (error: unknown) => error instanceof ApplicationError && error.code === "AZURE_DEVOPS_UNAVAILABLE" && !error.message.includes("secret"),
  );
});

test("Azure DevOps reader validates page sizes, response types, and short credentials", async () => {
  const invalidLimit = { ...connection, workItemType: "Bug" } as AzureDevOpsWorkItemImportOptions;
  await assert.rejects(
    fetchAzureDevOpsWorkItems({ ...invalidLimit, limit: 101 }, async () => jsonResponse({ workItems: [] })),
    (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
  );
  await assert.rejects(
    fetchAzureDevOpsWorkItems({ ...connection, token: "short", workItemType: "Bug" }, async () => jsonResponse({ workItems: [] })),
    (error: unknown) => error instanceof ApplicationError && error.code === "AZURE_DEVOPS_AUTH_NOT_CONFIGURED",
  );
  await assert.rejects(
    fetchAzureDevOpsWorkItems({ ...connection, workItemType: "Bug" }, async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "text/html" },
    })),
    (error: unknown) => error instanceof ApplicationError && error.code === "AZURE_DEVOPS_INVALID_RESPONSE",
  );
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function azureItem(
  id: number,
  overrides: { readonly type?: string | null; readonly tags?: string } = {},
) {
  const fields: Record<string, unknown> = {
    "System.Id": id,
    "System.Title": `Work item ${id}`,
    "System.Description": `Description ${id}`,
    "System.State": "New",
    "System.CreatedDate": "2026-11-01T12:00:00Z",
    "System.ChangedDate": "2026-11-02T12:00:00Z",
    "System.Tags": overrides.tags ?? "imported; product",
  };
  if (overrides.type !== null) fields["System.WorkItemType"] = overrides.type ?? "User Story";
  return { id, fields };
}
