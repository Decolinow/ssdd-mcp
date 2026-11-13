import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createDashboardApiServer, listenDashboardApiServer } from "../../src/dashboard/api.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";

test("dashboard manages specifications, revisions, withdrawal and ADR links with CSRF and versions (SSDD-98)", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-dashboard-specs-"));
  const initialized = initializeProject({ workspace, key: "SPC", name: "Specs", productGoal: "Gerir especificações", timezone: "UTC" });
  const projectId = initialized.project.id;
  const database = openSqliteDatabase(initialized.databasePath);
  const principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?").get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
  const create = (type: "epic" | "feature" | "story" | "task", title: string, parentId?: string) => createWorkItem(database, {
    projectId, principalId, requestId: randomUUID(), type, title, ...(parentId === undefined ? {} : { parentId }),
  }).value;
  const task = create("task", "Tarefa de ADR", create("story", "História", create("feature", "Feature", create("epic", "Épico").id).id).id);
  database.close();

  const dashboard = createDashboardApiServer(workspace);
  const address = await listenDashboardApiServer(dashboard, 0);
  context.after(async () => {
    await dashboard.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  const claim = await fetch(`${address.origin}/?token=${encodeURIComponent(dashboard.bootstrapToken)}`);
  const cookie = claim.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const session = await (await fetch(`${address.origin}/api/v1/session`, { headers: { Cookie: cookie, Origin: address.origin } })).json() as { csrfToken: string };
  const headers = { Cookie: cookie, Origin: address.origin, "X-SSDD-CSRF": session.csrfToken, "Content-Type": "application/json" };
  const post = (path: string, body: unknown, requestHeaders: Record<string, string> = headers) => fetch(`${address.origin}${path}`, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });
  const base = `/api/v1/projects/${projectId}/specifications`;
  const specVersion = async (key: string) => ((await (await fetch(`${address.origin}${base}/${key}`, { headers })).json()) as { specification: { version: number } }).specification.version;

  const noCsrf = await post(base, { requestId: "no-csrf", key: "ADR-1", kind: "adr", title: "Usar SQLite", content: { decision: "SQLite" } }, { Cookie: cookie, Origin: address.origin, "Content-Type": "application/json" });
  assert.equal(noCsrf.status, 403);
  const invalid = await post(base, { requestId: "bad", key: "ADR-1", kind: "adr", title: "Usar SQLite", content: {} });
  assert.equal(invalid.status, 400);

  const created = await post(base, { requestId: "spec-create", key: "ADR-1", kind: "adr", title: "Usar SQLite", content: { decision: "SQLite local", context: "Sem servidor" } });
  assert.equal(created.status, 201);
  const replay = await post(base, { requestId: "spec-create", key: "ADR-1", kind: "adr", title: "Usar SQLite", content: { decision: "SQLite local", context: "Sem servidor" } });
  assert.equal(replay.status, 201);

  const publishRevision = (number: number, requestId: string, version: number) => post(`${base}/ADR-1/revisions/${number}/publish`, { requestId, expectedVersion: version });
  const firstPublished = await publishRevision(1, "spec-publish-1", await specVersion("ADR-1"));
  assert.equal(firstPublished.status, 200);
  assert.equal(((await firstPublished.json()) as { revision: { status: string } }).revision.status, "published");

  const stale = await post(`${base}/ADR-1/revisions`, { requestId: "stale", expectedVersion: 99, content: { decision: "x" } });
  assert.equal(stale.status, 409);
  const proposed = await post(`${base}/ADR-1/revisions`, { requestId: "spec-propose", expectedVersion: await specVersion("ADR-1"), content: { decision: "Obsoleta" } });
  assert.equal(proposed.status, 200, await proposed.clone().text());
  const draftNumber = ((await proposed.json()) as { revision: { revisionNumber: number } }).revision.revisionNumber;

  const withdrawNoReason = await post(`${base}/ADR-1/revisions/${draftNumber}/withdraw`, { requestId: "w0", expectedVersion: await specVersion("ADR-1") });
  assert.equal(withdrawNoReason.status, 400);
  const withdrawn = await post(`${base}/ADR-1/revisions/${draftNumber}/withdraw`, { requestId: "w1", expectedVersion: await specVersion("ADR-1"), reason: "Proposta obsoleta." });
  assert.equal(withdrawn.status, 200, await withdrawn.clone().text());

  const next = await post(`${base}/ADR-1/revisions`, { requestId: "spec-propose-2", expectedVersion: await specVersion("ADR-1"), content: { decision: "SQLite com WAL" } });
  assert.equal(next.status, 200, await next.clone().text());
  const nextNumber = ((await next.json()) as { revision: { revisionNumber: number } }).revision.revisionNumber;
  assert.equal((await publishRevision(nextNumber, "spec-publish-2", await specVersion("ADR-1"))).status, 200);

  const link = await post(`/api/v1/projects/${projectId}/work-items/${task.key}/adr-links`, { requestId: "adr-link", adrIdOrKey: "ADR-1", relationship: "implements" });
  assert.equal(link.status, 201);
});
