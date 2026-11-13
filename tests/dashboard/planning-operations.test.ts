import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createDashboardApiServer, listenDashboardApiServer } from "../../src/dashboard/api.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";

test("dashboard planning operations reuse MCP commands with CSRF, versions and validation (SSDD-99)", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-dashboard-planning-"));
  const initialized = initializeProject({ workspace, key: "PLN", name: "Planning", productGoal: "Planejar", timezone: "UTC" });
  const projectId = initialized.project.id;
  const database = openSqliteDatabase(initialized.databasePath);
  const principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?").get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
  database.close();
  const dashboard = createDashboardApiServer(workspace);
  const address = await listenDashboardApiServer(dashboard, 0);
  context.after(async () => { await dashboard.close(); rmSync(workspace, { recursive: true, force: true }); });
  const claim = await fetch(`${address.origin}/?token=${encodeURIComponent(dashboard.bootstrapToken)}`);
  const cookie = claim.headers.get("set-cookie")?.split(";", 1)[0] as string;
  const session = await (await fetch(`${address.origin}/api/v1/session`, { headers: { Cookie: cookie, Origin: address.origin } })).json() as { csrfToken: string };
  const headers = { Cookie: cookie, Origin: address.origin, "X-SSDD-CSRF": session.csrfToken, "Content-Type": "application/json" };
  const call = (operation: string, body: unknown, requestHeaders: Record<string, string> = headers) =>
    fetch(`${address.origin}/api/v1/projects/${projectId}/planning/${operation}`, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });

  assert.equal((await call("definition_of_done_set", { requestId: "dod-0", expectedVersion: 0, criteria: [{ description: "Testes verdes" }], reason: "Primeira DoD" }, { Cookie: cookie, Origin: address.origin, "Content-Type": "application/json" })).status, 403);
  assert.equal((await call("nao_existe", {})).status, 404);
  assert.equal((await call("definition_of_done_set", { requestId: "dod-bad", expectedVersion: 0, criteria: [], reason: "x" })).status, 400);
  const dod = await call("definition_of_done_set", { requestId: "dod-1", expectedVersion: 0, criteria: [{ description: "Testes verdes" }], reason: "Primeira DoD" });
  assert.equal(dod.status, 200, await dod.clone().text());
  assert.equal((await call("definition_of_done_set", { requestId: "dod-stale", expectedVersion: 0, criteria: [{ description: "Outra" }], reason: "Versão antiga" })).status, 409);

  const capacity = { teamName: "Time B", timezone: "UTC", hoursPerDay: 6, workingDays: [1, 2, 3, 4, 5], members: [{ principalId, dedicationPercent: 100 }], reason: "Novo time" };
  const team = await call("team_create", { requestId: "team-1", ...capacity });
  assert.equal(team.status, 200, await team.clone().text());
  const configuration = (await team.json() as { configuration: { teamId: string; version: number } }).configuration;
  const stale = await call("team_capacity_set", { requestId: "cap-stale", expectedVersion: configuration.version + 5, teamId: configuration.teamId, ...capacity });
  assert.equal(stale.status, 409);
  const updated = await call("team_capacity_set", { requestId: "cap-ok", expectedVersion: configuration.version, teamId: configuration.teamId, ...capacity, hoursPerDay: 5 });
  assert.equal(updated.status, 200, await updated.clone().text());
  assert.equal((await call("sprint_start", { requestId: "start-missing", sprintIdOrKey: "NOPE", expectedVersion: 1, reason: "x" })).status, 404);
  assert.equal((await call("sprint_start", { requestId: "start-extra", sprintIdOrKey: "NOPE", expectedVersion: 1, reason: "x", surprise: true })).status, 400);
});
