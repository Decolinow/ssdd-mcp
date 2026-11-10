import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { getProjectDashboardMetrics } from "../../src/application/dashboard-metrics.js";
import { grantExternalIdentity } from "../../src/application/external-identities.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { packageVersion } from "../../src/package-version.js";
import { createScenario, proposeScenarioRevision, publishScenarioRevision } from "../../src/application/scenario-commands.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import {
  backupWorkspace,
  diagnoseWorkspace,
  exportWorkspace,
  restoreWorkspace,
} from "../../src/operations/workspace-maintenance.js";

describe("workspace backup, restore, export, and diagnostics", () => {
  let root: string;
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let adminPrincipalId: string;
  let epicId: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ssdd-mcp-maintenance-"));
    workspace = join(root, "source");
    const initialized = initializeProject({
      workspace,
      key: "PAY",
      name: "Payments",
      productGoal: "Pagamentos confiáveis",
      timezone: "America/Sao_Paulo",
    });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    adminPrincipalId = (database.prepare(
      "SELECT created_by_principal_id FROM projects WHERE project_id = ?",
    ).get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    const created = createWorkItem(database, {
      projectId,
      principalId: adminPrincipalId,
      requestId: "maintenance-create-epic",
      type: "epic",
      title: "Stable backup of project history",
    });
    epicId = created.value.id;
    grantExternalIdentity(database, {
      projectId,
      principalId: adminPrincipalId,
      requestId: "maintenance-grant-agent",
      issuer: "https://identity.example/tenant",
      subject: "maintenance-agent",
      displayName: "Maintenance agent",
      principalType: "agent",
      roles: ["developer"],
      reason: "Provisioned for export redaction checks.",
    });
    database.prepare(
      `INSERT INTO audit_events
        (event_id, project_id, principal_id, event_type, entity_type, entity_id,
         correlation_id, occurred_at, payload_json)
       VALUES (?, ?, ?, 'maintenance.secret_fixture', 'project', ?, ?, ?, ?)`,
    ).run(
      randomUUID(), projectId, adminPrincipalId, projectId, randomUUID(), new Date().toISOString(),
      JSON.stringify({ access_token: "do-not-export", identityKey: "private-identity-digest" }),
    );
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a verifiable online backup and restores it into an empty workspace", async () => {
    const backupPath = join(root, "safe-copy.sqlite");
    const result = await backupWorkspace(workspace, backupPath);
    assert.equal(result.backupPath, backupPath);
    assert.equal(result.projectKeys[0], "PAY");
    assert.ok(existsSync(result.manifestPath));

    const restoredWorkspace = join(root, "restored");
    const restored = await restoreWorkspace(restoredWorkspace, backupPath);
    assert.equal(restored.restoredSchemaVersion, 23);
    assert.equal(restored.sourceSchemaVersion, 23);
    assert.deepEqual(restored.projectKeys, ["PAY"]);

    const restoredDatabase = openSqliteDatabase(restored.databasePath);
    try {
      const item = restoredDatabase.prepare(
        "SELECT item_id, title FROM work_items WHERE item_id = ? AND project_id = ?",
      ).get(epicId, projectId) as { item_id: string; title: string } | undefined;
      assert.deepEqual(item, { item_id: epicId, title: "Stable backup of project history" });
      const secretFixture = restoredDatabase.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'maintenance.secret_fixture'",
      ).get() as { count: number };
      assert.equal(secretFixture.count, 1);
      const revision = restoredDatabase.prepare(
        "SELECT COUNT(*) AS count FROM work_item_revisions WHERE item_id = ?",
      ).get(epicId) as { count: number };
      assert.ok(revision.count > 0);
      const projection = getProjectDashboardMetrics(restoredDatabase, {
        projectId,
        principalId: adminPrincipalId,
        milestoneId: "none",
        sprintId: "none",
      });
      assert.equal(projection.projectId, projectId);
      assert.ok(projection.coverage);
    } finally {
      restoredDatabase.close();
    }
    assert.equal(diagnoseWorkspace(restoredWorkspace).status, "ok");
  });

  it("rejects a tampered backup and never writes into a non-empty target workspace", async () => {
    const backupPath = join(root, "tampered.sqlite");
    await backupWorkspace(workspace, backupPath);
    appendFileSync(backupPath, "tamper");
    const tamperedTarget = join(root, "tampered-target");
    await assert.rejects(() => restoreWorkspace(tamperedTarget, backupPath), /does not match its manifest/u);
    assert.equal(existsSync(join(tamperedTarget, ".ssdd")), false);

    const blockedTarget = join(root, "non-empty-target");
    mkdirSync(join(blockedTarget, ".ssdd"), { recursive: true });
    writeFileSync(join(blockedTarget, ".ssdd", "keep.txt"), "preserve");
    const cleanBackup = join(root, "clean.sqlite");
    await backupWorkspace(workspace, cleanBackup);
    await assert.rejects(() => restoreWorkspace(blockedTarget, cleanBackup), /clean workspace/u);
    assert.equal(existsSync(join(blockedTarget, ".ssdd", "keep.txt")), true);
  });

  it("reports database health and exports project data without credentials or identity keys", () => {
    const report = diagnoseWorkspace(workspace);
    assert.equal(report.status, "ok");
    assert.equal(report.appVersion, packageVersion);
    assert.equal(report.integrity, "ok");
    assert.equal(report.migrations?.status, "current");
    assert.equal(report.projectCount, 1);
    assert.doesNotMatch(JSON.stringify(report), /maintenance-agent|private-identity-digest|do-not-export|identity_key|access_token/iu);

    const jsonExport = exportWorkspace(workspace, "json");
    assert.deepEqual(jsonExport.projectKeys, ["PAY"]);
    assert.match(jsonExport.content, /Stable backup of project history/u);
    assert.doesNotMatch(jsonExport.content, /private-identity-digest|do-not-export|access_token|identity_key|command_approvals|idempotency_records/iu);
    const exported = JSON.parse(jsonExport.content) as { format: string; tables: Record<string, unknown[]> };
    assert.equal(exported.format, "ssdd-mcp-export");
    assert.ok(exported.tables.work_items);

    const markdownExport = exportWorkspace(workspace, "markdown");
    assert.match(markdownExport.content, /# SSDD MCP project export/u);
    assert.match(markdownExport.content, /PAY · Payments/u);
    assert.match(markdownExport.content, /Stable backup of project history/u);
  });

  it("exports only the current published scenario revision as injection-safe Gherkin", () => {
    const emptyExport = exportWorkspace(workspace, "gherkin");
    const emptyDocument = new Parser(
      new AstBuilder(() => randomUUID()),
      new GherkinClassicTokenMatcher(),
    ).parse(emptyExport.content);
    assert.equal(emptyDocument.feature, undefined);

    const created = createScenario(database, {
      projectId,
      principalId: adminPrincipalId,
      requestId: "maintenance-gherkin-create",
      key: "PAY-AC_1",
      kind: "acceptance",
      title: "Pagamento aprovado",
      preconditions: ["Cliente possui saldo"],
      steps: [{
        action: "Enviar o pedido\nScenario: forged",
        expected: "O pagamento é aprovado\r\n@malicious\u0000status",
      }],
    });
    publishScenarioRevision(database, {
      projectId,
      principalId: adminPrincipalId,
      requestId: "maintenance-gherkin-publish",
      scenarioIdOrKey: created.value.key,
      revisionNumber: 1,
      expectedVersion: 1,
    });
    proposeScenarioRevision(database, {
      projectId,
      principalId: adminPrincipalId,
      requestId: "maintenance-gherkin-draft",
      scenarioIdOrKey: created.value.key,
      expectedVersion: 2,
      title: "Draft-only title",
      preconditions: [],
      steps: [{ action: "draft action", expected: "draft result" }],
    });

    const exported = exportWorkspace(workspace, "gherkin");
    assert.deepEqual(exported.projectKeys, ["PAY"]);
    assert.match(exported.content, /@project_PAY @scenario_PAY-AC_1 @kind_acceptance @revision_1/u);
    assert.match(exported.content, /Feature: Payments/u);
    assert.match(exported.content, /Scenario: Pagamento aprovado/u);
    assert.match(exported.content, /Given Cliente possui saldo/u);
    assert.match(exported.content, /When Enviar o pedido Scenario: forged/u);
    assert.match(exported.content, /Then O pagamento é aprovado @malicious\\u0000status/u);
    assert.doesNotMatch(exported.content, /\n\s*Scenario: forged/u);
    assert.doesNotMatch(exported.content, /\n\s*@malicious/u);
    assert.doesNotMatch(exported.content, /Draft-only title|draft action|draft result/u);
    const gherkinDocument = new Parser(
      new AstBuilder(() => randomUUID()),
      new GherkinClassicTokenMatcher(),
    ).parse(exported.content);
    assert.equal(gherkinDocument.feature?.children.length, 1);
  });

  it("reports missing workspace databases without exposing filesystem details", () => {
    const report = diagnoseWorkspace(join(root, "missing"));
    assert.equal(report.status, "error");
    assert.equal(report.appVersion, packageVersion);
    assert.equal(report.databasePresent, false);
    assert.deepEqual(report.errors, ["Workspace database is missing. Run `ssdd-mcp init` first."]);
    assert.doesNotMatch(JSON.stringify(report), /identity|token|secret|password/iu);
  });
});
