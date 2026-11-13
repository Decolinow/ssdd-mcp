import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createDashboardApiServer, listenDashboardApiServer } from "../../src/dashboard/api.js";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createScenario, publishScenarioRevision, recordTestRun } from "../../src/application/scenario-commands.js";
import { createManagedUser, ensureBootstrapAdministrator } from "../../src/application/user-management.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";

/**
 * Browser smoke for the modular dashboard (SSDD-954). Not part of `npm test`: run with `npm run test:browser`
 * (needs Chrome; set SSDD_BROWSER_CHANNEL to override the `chrome` channel, e.g. `msedge`).
 */
test("dashboard smoke: login, backlog and board, gate-refused transition and PBI form", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-dashboard-smoke-"));
  const initialized = initializeProject({ workspace, key: "SMK", name: "Smoke", productGoal: "Exercitar o dashboard", timezone: "UTC" });
  const projectId = initialized.project.id;
  const database = openSqliteDatabase(initialized.databasePath);
  const adminId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?").get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
  ensureBootstrapAdministrator(database, adminId);
  const user = createManagedUser(database, {
    actorPrincipalId: adminId, requestId: "smoke-user", displayName: "Smoke PO", principalType: "human",
    projects: [{ projectId, roles: ["po", "developer"] }], reason: "Usuário do smoke do dashboard.",
  });
  assert.ok(user.authKey);
  const epic = createWorkItem(database, { projectId, principalId: adminId, requestId: "smoke-epic", type: "epic", title: "Épico do smoke" }).value;
  const feature = createWorkItem(database, { projectId, principalId: adminId, requestId: "smoke-feature", type: "feature", title: "Feature do smoke", parentId: epic.id }).value;
  createWorkItem(database, { projectId, principalId: adminId, requestId: "smoke-story", type: "story", title: "História sem critérios", parentId: feature.id });
  // Published scenario with one run per result so the QA chart renders real data for the accessibility audit (SCN-90-AC4).
  createScenario(database, { projectId, principalId: adminId, requestId: "smoke-scenario", key: "SMK-TC-1", kind: "acceptance", title: "Cenário do smoke", steps: [{ action: "Executar", expected: "Passa" }] });
  publishScenarioRevision(database, { projectId, principalId: adminId, requestId: "smoke-scenario-publish", scenarioIdOrKey: "SMK-TC-1", revisionNumber: 1, expectedVersion: 1 });
  for (const result of ["passed", "failed", "blocked", "skipped"] as const) {
    recordTestRun(database, { projectId, principalId: adminId, requestId: `smoke-run-${result}`, scenarioIdOrKey: "SMK-TC-1", revisionNumber: 1, buildId: `smoke-build-${result}`, result });
  }
  database.close();

  const dashboard = createDashboardApiServer(workspace);
  const address = await listenDashboardApiServer(dashboard, 0);
  const browser = await chromium.launch({ channel: process.env.SSDD_BROWSER_CHANNEL ?? "chrome", headless: true });
  context.after(async () => {
    await browser.close();
    await dashboard.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") pageErrors.push(message.text()); });

  await page.goto(address.origin);
  await page.locator("#login-screen").waitFor({ state: "visible" });
  await page.fill("#auth-key", user.authKey!);
  await page.click("#login-submit");
  await page.locator("#app-shell").waitFor({ state: "visible" });

  await page.click("#backlog-tab");
  const storyRow = page.locator("#backlog-list").getByText("História sem critérios").first();
  await storyRow.waitFor({ state: "visible" });
  await page.click("#board-tab");
  await page.locator("#board").waitFor({ state: "visible" });

  await page.click("#backlog-tab");
  await page.locator("#backlog-list .backlog-row").filter({ hasText: "História sem critérios" }).locator(".row-open").click();
  await page.locator("#item-dialog[open]").waitFor();
  await page.click("#detail-move-button");
  await page.locator("#transition-dialog[open]").waitFor();
  await page.selectOption("#target-state", "ready");
  await page.fill("#transition-reason", "Tentar promover sem critérios para exercitar o gate.");
  await page.click("#submit-transition");
  await page.locator("#transition-dialog[open], #toast:not([hidden]), #error:not([hidden])").first().waitFor();
  assert.equal(await page.locator("#toast.is-error:not([hidden])").count() + await page.locator("#transition-dialog[open]").count() > 0, true, "the gate refusal must stay visible");
  await page.keyboard.press("Escape");

  await page.click("#create-work-item");
  await page.locator("#work-item-form-dialog[open]").waitFor();
  await page.selectOption("#work-item-type", "epic");
  await page.fill("#work-item-title", "Épico criado pelo smoke");
  await page.click("#submit-work-item");
  await page.locator("#toast:not([hidden])").filter({ hasText: "criado como rascunho" }).waitFor();

  await page.locator("#item-dialog[open]").waitFor();
  await page.keyboard.press("Escape");
  await page.click("#specifications-tab");
  await page.click("#create-specification");
  await page.locator("#specification-form-dialog[open]").waitFor();
  await page.fill("#specification-form-key", "SMK-RULE-1");
  await page.selectOption("#specification-form-kind", "business_rule");
  await page.fill("#specification-form-title-input", "Regra criada pelo smoke");
  await page.fill("#specification-content", '{"rule": "O smoke cria uma regra em rascunho."}');
  await page.click("#submit-specification");
  await page.locator("#specification-detail").getByText("SMK-RULE-1").first().waitFor({ state: "visible" });
  await page.locator('[data-spec-action="publish"]').waitFor({ state: "visible" });

  await page.click("#quality-tab");
  await page.locator("#qa-coverage table").waitFor({ state: "visible" });
  await page.locator("#qa-run-chart table").waitFor({ state: "visible" });
  // Automated accessibility audit (axe-core) of the QA coverage and results panels. It does not replace a screen-reader pass.
  await page.evaluate(readFileSync(join(process.cwd(), "node_modules", "axe-core", "axe.min.js"), "utf8"));
  const audit = await page.evaluate(async () => {
    const axe = (globalThis as unknown as { axe: { run: (context: unknown) => Promise<{ passes: unknown[]; violations: Array<{ id: string; impact: string; nodes: Array<{ target: string[] }> }> }> } }).axe;
    const result = await axe.run({ include: ["#qa-coverage", "#qa-run-chart"] });
    return { passes: result.passes.length, violations: result.violations.map((violation) => ({ id: violation.id, impact: violation.impact, targets: violation.nodes.map((node) => node.target.join(" ")) })) };
  });
  assert.ok(audit.passes > 0, "the audit must actually evaluate the QA panels");
  assert.deepEqual(audit.violations, [], `QA chart accessibility violations: ${JSON.stringify(audit.violations)}`);
  await page.locator('[data-coverage-bucket]:not([disabled])').first().click();
  await page.locator("[data-coverage-clear]").waitFor({ state: "visible" });
  await page.click("[data-coverage-clear]");
  await page.fill("#qa-filter-build", "build-inexistente");
  await page.locator("#qa-run-chart .empty-state").waitFor({ state: "visible" });

  await page.click("#backlog-tab");
  await page.locator("#backlog-list .backlog-row").filter({ hasText: "História sem critérios" }).locator(".row-open").click();
  await page.locator("#item-dialog[open]").waitFor();
  await page.click("#detail-operations-button");
  await page.locator("#planning-dialog[open]").waitFor();
  await page.selectOption("#planning-operation", "comment_add");
  await page.fill("#planning-payload", '{"itemIdOrKey": "SMK-3", "body": "Comentário pelo smoke"}');
  await page.click("#submit-planning");
  await page.locator("#toast:not([hidden])").filter({ hasText: "concluído" }).waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#planning-dialog[open]").waitFor({ state: "detached" });
  // The operation reloads the item and reopens its dialog once the reload finishes; wait for it, then close it.
  await page.locator("#item-dialog[open]").waitFor({ timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  for (let attempt = 0; attempt < 5 && await page.locator("#item-dialog[open]").count() > 0; attempt += 1) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
  await page.click("#open-planning");
  await page.locator("#planning-dialog[open]").waitFor();
  await page.selectOption("#planning-operation", "definition_of_done_set");
  // A refusal inside a modal must stay visible: the empty reason is caught before the request and the toast sits above the dialog backdrop.
  await page.click("#submit-planning");
  await page.locator("#toast:popover-open").filter({ hasText: "reason" }).waitFor({ state: "visible" });
  assert.equal(await page.locator("#planning-dialog[open]").count(), 1, "the dialog stays open after the refusal");
  await page.fill("#planning-payload", '{"expectedVersion": 0, "criteria": [{"description": "Smoke verde"}], "reason": "DoD criada pelo smoke."}');
  await page.click("#submit-planning");
  await page.locator("#toast:not([hidden])").filter({ hasText: "concluído" }).waitFor();

  assert.deepEqual(pageErrors.filter((message) => !/ERR_|Failed to load resource/u.test(message)), [], "the browser console must stay free of script errors");
});
