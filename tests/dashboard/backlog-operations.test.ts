import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { createSpecification, proposeSpecificationRevision, publishSpecificationRevision } from "../../src/application/specification-commands.js";
import { addTraceLink } from "../../src/application/trace-commands.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createDashboardApiServer, listenDashboardApiServer } from "../../src/dashboard/api.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";

test("dashboard backlog operations reuse MCP commands: assign, comment, estimate, rank and trace links (SSDD-89)", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-dashboard-backlog-"));
  const initialized = initializeProject({ workspace, key: "BLG", name: "Backlog", productGoal: "Operar backlog", timezone: "UTC" });
  const projectId = initialized.project.id;
  const database = openSqliteDatabase(initialized.databasePath);
  const principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?").get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
  const create = (type: "epic" | "feature" | "story" | "task", title: string, parentId?: string) => createWorkItem(database, {
    projectId, principalId, requestId: randomUUID(), type, title, ...(parentId === undefined ? {} : { parentId }),
  }).value;
  const epic = create("epic", "Épico");
  const feature = create("feature", "Feature", epic.id);
  const story = create("story", "História A", feature.id);
  const other = create("story", "História B", feature.id);
  const baselined = create("story", "História com baseline", feature.id);
  const spec = createSpecification(database, { projectId, principalId, requestId: randomUUID(), key: "BR-UI-1", kind: "business_rule", title: "Regra", content: { text: "Primeira versão" } }).value;
  publishSpecificationRevision(database, { projectId, principalId, requestId: randomUUID(), specIdOrKey: spec.specId, revisionNumber: 1, expectedVersion: 1 });
  addTraceLink(database, { projectId, principalId, requestId: randomUUID(), sourceIdOrKey: baselined.id, targetIdOrKey: spec.specId, type: "implements" });
  database.prepare("UPDATE work_items SET state = 'ready' WHERE project_id = ? AND item_id = ?").run(projectId, baselined.id);
  database.close();
  const dashboard = createDashboardApiServer(workspace);
  const address = await listenDashboardApiServer(dashboard, 0);
  context.after(async () => { await dashboard.close(); rmSync(workspace, { recursive: true, force: true }); });
  const claim = await fetch(`${address.origin}/?token=${encodeURIComponent(dashboard.bootstrapToken)}`);
  const cookie = claim.headers.get("set-cookie")?.split(";", 1)[0] as string;
  const session = await (await fetch(`${address.origin}/api/v1/session`, { headers: { Cookie: cookie, Origin: address.origin } })).json() as { csrfToken: string };
  const headers = { Cookie: cookie, Origin: address.origin, "X-SSDD-CSRF": session.csrfToken, "Content-Type": "application/json" };
  const call = (operation: string, body: unknown, requestHeaders: Record<string, string> = headers) =>
    fetch(`${address.origin}/api/v1/projects/${projectId}/backlog/${operation}`, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });
  const getItem = async (key: string) => (await (await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${key}`, { headers })).json() as { workItem: { version: number } }).workItem;

  assert.equal((await call("comment_add", { requestId: "c0", itemIdOrKey: story.key, body: "x" }, { Cookie: cookie, Origin: address.origin, "Content-Type": "application/json" })).status, 403);
  assert.equal((await call("nao_existe", {})).status, 404);
  assert.equal((await call("comment_add", { requestId: "c-bad", itemIdOrKey: story.key, body: "" })).status, 400);
  const comment = await call("comment_add", { requestId: "c1", itemIdOrKey: story.key, body: "Comentário do dashboard" });
  assert.equal(comment.status, 200, await comment.clone().text());
  const comments = await (await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${story.key}/comments`, { headers })).json() as { comments: Array<{ body: string }> };
  assert.deepEqual(comments.comments.map((entry) => entry.body), ["Comentário do dashboard"]);

  const estimate = await call("work_item_estimate", { requestId: "e1", itemIdOrKey: story.key, unit: "points", value: 5, rationale: "Escopo médio", expectedVersion: (await getItem(story.key)).version });
  assert.equal(estimate.status, 200, await estimate.clone().text());
  assert.equal((await call("work_item_estimate", { requestId: "e-stale", itemIdOrKey: story.key, unit: "points", value: 8, rationale: "Versão antiga", expectedVersion: 1 })).status, 409);

  const rank = await call("work_item_rank", { requestId: "r1", itemIdOrKey: other.key, beforeIdOrKey: story.key, expectedVersion: (await getItem(other.key)).version });
  assert.equal(rank.status, 200, await rank.clone().text());
  assert.equal((await call("work_item_rank", { requestId: "r-both", itemIdOrKey: other.key, beforeIdOrKey: story.key, afterIdOrKey: story.key, expectedVersion: 1 })).status, 400);

  const link = await call("trace_link_add", { requestId: "t1", sourceIdOrKey: story.key, targetIdOrKey: other.key, type: "relates_to" });
  assert.equal(link.status, 200, await link.clone().text());
  const linkId = ((await link.json()) as { link: { id: string } }).link.id;
  const trace = await (await fetch(`${address.origin}/api/v1/projects/${projectId}/work-items/${story.key}/trace`, { headers })).json() as { links?: unknown[]; edges?: unknown[] };
  assert.ok(JSON.stringify(trace).includes(other.key), "the trace graph lists the new link");
  assert.equal((await call("trace_link_remove", { requestId: "t2", linkId })).status, 200);
  assert.equal((await call("trace_link_remove", { requestId: "t3", linkId: randomUUID() })).status, 404);
  assert.equal((await call("work_item_assign", { requestId: "a-bad", itemIdOrKey: story.key, assigneeId: "nao-uuid", expectedVersion: 1 })).status, 400);

  // SSDD-93: QA certification goes through the same MCP gate and explains the refusal.
  const noCsrf = await call("test_run_certify", { requestId: "q0", itemIdOrKey: story.key, runId: randomUUID(), expectedVersion: 1, reason: "x" }, { Cookie: cookie, Origin: address.origin, "Content-Type": "application/json" });
  assert.equal(noCsrf.status, 403);
  assert.equal((await call("test_run_certify", { requestId: "q-bad", itemIdOrKey: story.key, runId: "nao-uuid", expectedVersion: 1, reason: "x" })).status, 400);
  const refused = await call("test_run_certify", { requestId: "q1", itemIdOrKey: story.key, runId: randomUUID(), expectedVersion: (await getItem(story.key)).version, reason: "Tentativa sem execução" });
  assert.ok(refused.status >= 400 && refused.status < 500, "an unknown run or a PBI outside validation is refused with a client error");
  const refusal = await refused.json() as { code?: string; message?: string };
  assert.ok(refusal.code, "the refusal carries a code the dashboard can show");

  // SSDD-97 AC-1: baseline, impacts and revalidation share the MCP commands, roles and versions.
  const itemUrl = `${address.origin}/api/v1/projects/${projectId}/work-items/${story.key}`;
  assert.equal((await fetch(`${itemUrl}/baseline`, { headers })).status, 404, "a PBI before Ready has no baseline");
  assert.deepEqual(await (await fetch(`${itemUrl}/impacts`, { headers })).json(), { impacts: [] });
  assert.equal((await fetch(`${itemUrl}/impacts?status=nope`, { headers })).status, 400);
  const noCsrfRevalidate = await call("baseline_revalidate", { requestId: "b0", itemIdOrKey: story.key, expectedVersion: 1, reason: "x" }, { Cookie: cookie, Origin: address.origin, "Content-Type": "application/json" });
  assert.equal(noCsrfRevalidate.status, 403);
  assert.equal((await call("baseline_revalidate", { requestId: "b-bad", itemIdOrKey: story.key, expectedVersion: 1 })).status, 400, "the reason is mandatory");
  const revalidateWithoutBaseline = await call("baseline_revalidate", { requestId: "b1", itemIdOrKey: story.key, expectedVersion: (await getItem(story.key)).version, reason: "Sem baseline" });
  assert.ok(revalidateWithoutBaseline.status >= 400 && revalidateWithoutBaseline.status < 500, "revalidation needs an existing baseline");
  assert.equal((await call("baseline_revalidate", { requestId: "b-stale", itemIdOrKey: story.key, expectedVersion: 1, reason: "Versão antiga" })).status >= 400, true);

  // Positive flow: fix a baseline, republish the rule, see the open impact and revalidate it from the dashboard.
  const baselinedUrl = `${address.origin}/api/v1/projects/${projectId}/work-items/${baselined.key}`;
  const fixed = await call("baseline_fix", { requestId: "bf1", itemIdOrKey: baselined.key, expectedVersion: (await getItem(baselined.key)).version, reason: "PO aceitou o escopo" });
  assert.equal(fixed.status, 200, await fixed.clone().text());
  const pinned = await (await fetch(`${baselinedUrl}/baseline`, { headers })).json() as { baseline: { sequence: number; references: Array<{ key: string; revisionNumber: number; snapshot?: unknown }> } };
  assert.equal(pinned.baseline.sequence, 1);
  assert.ok(pinned.baseline.references.some((reference) => reference.key === "BR-UI-1" && reference.revisionNumber === 1));
  assert.ok(pinned.baseline.references.every((reference) => reference.snapshot === undefined));
  const republishDatabase = openSqliteDatabase(initialized.databasePath);
  proposeSpecificationRevision(republishDatabase, { projectId, principalId, requestId: randomUUID(), specIdOrKey: spec.specId, expectedVersion: 2, content: { text: "Segunda versão" } });
  publishSpecificationRevision(republishDatabase, { projectId, principalId, requestId: randomUUID(), specIdOrKey: spec.specId, revisionNumber: 2, expectedVersion: 3 });
  republishDatabase.close();
  const open = await (await fetch(`${baselinedUrl}/impacts?status=open`, { headers })).json() as { impacts: Array<{ specificationKey: string; baselineRevision: number; publishedRevision: number }> };
  assert.deepEqual(open.impacts.map(({ specificationKey, baselineRevision, publishedRevision }) => ({ specificationKey, baselineRevision, publishedRevision })), [{ specificationKey: "BR-UI-1", baselineRevision: 1, publishedRevision: 2 }]);
  const revalidated = await call("baseline_revalidate", { requestId: "br1", itemIdOrKey: baselined.key, expectedVersion: (await getItem(baselined.key)).version, reason: "PO revisou a regra" });
  assert.equal(revalidated.status, 200, await revalidated.clone().text());
  assert.equal(((await (await fetch(`${baselinedUrl}/baseline`, { headers })).json()) as { baseline: { sequence: number } }).baseline.sequence, 2);
  assert.equal(((await (await fetch(`${baselinedUrl}/impacts?status=open`, { headers })).json()) as { impacts: unknown[] }).impacts.length, 0);
  assert.equal(((await (await fetch(`${baselinedUrl}/impacts?status=revalidated`, { headers })).json()) as { impacts: unknown[] }).impacts.length, 1);});
