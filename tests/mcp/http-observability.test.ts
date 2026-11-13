import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeProject } from "../../src/application/initialize-project.js";
import {
  classifyRoute, createHttpObservability, validateObservabilityOptions, type AccessLogEntry,
} from "../../src/mcp/http-observability.js";
import { createMcpHttpServer, listenMcpHttpServer } from "../../src/mcp/http-server.js";

function workspaceWithProject(): string {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-observability-"));
  initializeProject({ workspace, key: "OBS", name: "Observability", productGoal: "Operar o servidor", timezone: "UTC" });
  return workspace;
}

test("route classification and option validation keep metric cardinality bounded", () => {
  assert.equal(classifyRoute("/mcp"), "mcp");
  assert.equal(classifyRoute("/healthz"), "health");
  assert.equal(classifyRoute("/webhooks/github/ABC"), "webhook");
  assert.equal(classifyRoute("/anything/with/user-controlled/segments"), "other");
  assert.throws(() => validateObservabilityOptions({ rateLimit: { requestsPerMinute: 0 } }));
  assert.throws(() => validateObservabilityOptions({ rateLimit: { requestsPerMinute: 1.5 } }));
  assert.doesNotThrow(() => createHttpObservability());
});

test("structured access logs, loopback metrics and rate limiting never expose credentials or query strings", async (context) => {
  const workspace = workspaceWithProject();
  const entries: AccessLogEntry[] = [];
  const handle = createMcpHttpServer(workspace, {
    observability: { accessLog: (entry) => entries.push(entry), metrics: true, rateLimit: { requestsPerMinute: 3 } },
  });
  const address = await listenMcpHttpServer(handle, 0);
  context.after(async () => {
    await handle.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  // Health probes are exempt from the limit, so they can be polled freely.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    assert.equal((await fetch(`${address.origin}/healthz`, { headers: { authorization: "Bearer secret-token-value" } })).status, 200);
  }
  // Only the first three non-health requests are allowed in the window.
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${address.origin}/nope?token=query-secret`);
    statuses.push(response.status);
    if (response.status === 429) {
      assert.equal(response.headers.get("retry-after"), "60");
      assert.ok(response.headers.get("x-correlation-id"));
    }
  }
  assert.deepEqual(statuses.filter((status) => status === 429).length, 2);

  const exported = await fetch(`${address.origin}/metrics`);
  assert.equal(exported.status, 200, "metrics scraping is not throttled by the request limit");
  assert.match(await exported.text(), /ssdd_http_rate_limited_total 2/);
  assert.ok(entries.some((entry) => entry.rateLimited && entry.status === 429 && entry.level === "warn"));

  const serialized = JSON.stringify(entries);
  assert.ok(!serialized.includes("secret-token-value"));
  assert.ok(!serialized.includes("query-secret"));
  assert.ok(entries.every((entry) => entry.correlationId.length === 36 && entry.durationMs >= 0));
});

test("metrics export is opt-in and renders counters, rate-limit total and duration histogram", async (context) => {
  const workspace = workspaceWithProject();
  const disabled = createMcpHttpServer(workspace);
  const disabledAddress = await listenMcpHttpServer(disabled, 0);
  assert.equal((await fetch(`${disabledAddress.origin}/metrics`)).status, 404);
  await disabled.close();

  const handle = createMcpHttpServer(workspace, { observability: { metrics: true } });
  const address = await listenMcpHttpServer(handle, 0);
  context.after(async () => {
    await handle.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  await fetch(`${address.origin}/healthz`);
  await fetch(`${address.origin}/readyz`);
  await fetch(`${address.origin}/missing`);
  const metrics = await fetch(`${address.origin}/metrics`);
  assert.equal(metrics.status, 200);
  assert.match(metrics.headers.get("content-type") ?? "", /text\/plain/);
  const text = await metrics.text();
  assert.match(text, /ssdd_http_requests_total\{route="health",status_class="2xx"\} 2/);
  assert.match(text, /ssdd_http_requests_total\{route="other",status_class="4xx"\} 1/);
  assert.match(text, /ssdd_http_rate_limited_total 0/);
  assert.match(text, /ssdd_http_request_duration_ms_count\{route="health"\} 2/);
  assert.ok(!text.includes("missing"), "unbounded path segments must not become labels");
});
