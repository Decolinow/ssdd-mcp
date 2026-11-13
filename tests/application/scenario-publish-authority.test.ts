import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createScenario, publishScenarioRevision } from "../../src/application/scenario-commands.js";
import { createManagedUser, ensureBootstrapAdministrator } from "../../src/application/user-management.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("who may publish a scenario revision (SCN-90-AC1, human QA rule)", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let adminId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-scenario-authority-"));
    const initialized = initializeProject({ workspace, key: "QA", name: "QA", productGoal: "Publicar cenários com QA humano", timezone: "UTC" });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    adminId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?").get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    ensureBootstrapAdministrator(database, adminId);
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const user = (name: string, principalType: "human" | "agent", roles: Array<"developer" | "qa">) => createManagedUser(database, {
    actorPrincipalId: adminId, requestId: `user-${name}`, displayName: name, principalType,
    projects: [{ projectId, roles }], reason: "Principal de teste da autoridade de publicação.",
  }).principalId;
  const draftScenario = (key: string) => {
    const created = createScenario(database, {
      projectId, principalId: adminId, requestId: `scenario-${key}`, key, kind: "acceptance", title: `Cenário ${key}`,
      steps: [{ action: "Executar", expected: "Resultado esperado" }],
    });
    return created.value;
  };
  const publishAs = (principalId: string, key: string, version: number) => publishScenarioRevision(database, {
    projectId, principalId, requestId: `publish-${key}-${principalId}`, scenarioIdOrKey: key, revisionNumber: 1, expectedVersion: version,
  });
  const scenarioStatus = (key: string) => (database.prepare(
    "SELECT r.status FROM scenario_revisions r INNER JOIN scenarios s ON s.project_id = r.project_id AND s.scenario_id = r.scenario_id WHERE s.scenario_key = ? AND r.revision_number = 1",
  ).get(key) as { status: string }).status;

  it("refuses an agent with the QA role and a human without it, then accepts a human QA", () => {
    draftScenario("SCN-AUTH-1");
    const agentQa = user("agent-qa", "agent", ["qa"]);
    const humanDeveloper = user("human-dev", "human", ["developer"]);
    const humanQa = user("human-qa", "human", ["qa"]);

    assert.throws(() => publishAs(agentQa, "SCN-AUTH-1", 1),
      (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN" && /human QA/u.test(error.message));
    assert.throws(() => publishAs(humanDeveloper, "SCN-AUTH-1", 1),
      (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN");
    assert.equal(scenarioStatus("SCN-AUTH-1"), "draft", "refused publications leave the revision as a draft");

    const published = publishAs(humanQa, "SCN-AUTH-1", 1);
    assert.equal(published.value.status, "published");
    assert.equal(scenarioStatus("SCN-AUTH-1"), "published");
  });
});
