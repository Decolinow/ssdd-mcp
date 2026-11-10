import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import {
  applyExternalWorkItemImport,
  assertExternalWorkItemImportApplyAuthorization,
  previewExternalWorkItemImport,
  type ExternalWorkItemSource,
} from "../../src/application/external-work-item-imports.js";
import { ApplicationError } from "../../src/application/errors.js";
import { grantExternalIdentity } from "../../src/application/external-identities.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { getWorkItem } from "../../src/application/work-item-queries.js";
import { proposeWorkItemRevision, publishWorkItemRevision } from "../../src/application/work-item-revisions.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("external work item import plans", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let featureId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-external-import-"));
    const initialized = initializeProject({
      workspace,
      key: "PAY",
      name: "Payments",
      productGoal: "Pagamentos confiáveis",
      timezone: "America/Sao_Paulo",
    });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    principalId = (database.prepare(
      "SELECT created_by_principal_id FROM projects WHERE project_id = ?",
    ).get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    const epic = createWorkItem(database, {
      projectId,
      principalId,
      requestId: "external-fixture-epic",
      type: "epic",
      title: "Pagamentos",
    }).value;
    featureId = createWorkItem(database, {
      projectId,
      principalId,
      requestId: "external-fixture-feature",
      type: "feature",
      parentId: epic.id,
      title: "Checkout",
    }).value.id;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("previews the selected issues without writing workspace data", () => {
    const source = githubIssue({
      title: `Issue ${"long ".repeat(50)}`,
      body: "a".repeat(10_001),
    });
    const before = rowCounts();

    const preview = previewExternalWorkItemImport(database, importInput([source]));

    assert.equal(preview.provider, "github");
    assert.equal(preview.externalScope, "acme/payments");
    assert.equal(preview.parentFeatureId, featureId);
    assert.equal(preview.total, 1);
    assert.equal(preview.toCreate, 1);
    assert.equal(preview.items[0]?.titleTruncated, true);
    assert.equal(preview.items[0]?.descriptionTruncated, true);
    assert.match(preview.planHash, /^[a-f0-9]{64}$/u);
    assert.deepEqual(rowCounts(), before);
  });

  it("imports once with immutable source snapshots and never overwrites local edits", () => {
    const originalSource = githubIssue();
    const preview = previewExternalWorkItemImport(database, importInput([originalSource]));
    const applyInput = {
      ...importInput([originalSource]),
      expectedPlanHash: preview.planHash,
      requestId: "github-import-apply-1",
    };
    const imported = applyExternalWorkItemImport(database, applyInput);
    const replayed = applyExternalWorkItemImport(database, applyInput);

    assert.deepEqual(replayed, imported);
    assert.equal(imported.imported.length, 1);
    const item = imported.imported[0]!;
    assert.equal(item.workItemKey, "PAY-3");
    assert.equal(getWorkItem(database, projectId, principalId, item.workItemId).state, "draft");
    assert.equal(getWorkItem(database, projectId, principalId, item.workItemId).title, "Solicitar reembolso");

    const proposal = proposeWorkItemRevision(database, {
      projectId,
      principalId,
      requestId: "github-import-local-revision",
      itemIdOrKey: item.workItemId,
      expectedVersion: 1,
      title: "Título ajustado pelo PO",
    });
    publishWorkItemRevision(database, {
      projectId,
      principalId,
      requestId: "github-import-local-publish",
      itemIdOrKey: item.workItemId,
      revisionNumber: proposal.value.revisionNumber,
      expectedVersion: 2,
    });

    const changedSource = githubIssue({ title: "Título atualizado no GitHub", updatedAt: "2026-11-10T18:00:00.000Z" });
    const refreshedPreview = previewExternalWorkItemImport(database, importInput([changedSource]));
    assert.equal(refreshedPreview.items[0]?.action, "already_imported");
    assert.equal(refreshedPreview.items[0]?.sourceChanged, true);
    const refreshed = applyExternalWorkItemImport(database, {
      ...importInput([changedSource]),
      expectedPlanHash: refreshedPreview.planHash,
      requestId: "github-import-apply-2",
    });

    assert.deepEqual(refreshed.imported, []);
    assert.equal(refreshed.alreadyImported, 1);
    assert.equal(refreshed.sourceSnapshotsAdded, 1);
    assert.equal(getWorkItem(database, projectId, principalId, item.workItemId).title, "Título ajustado pelo PO");
    assert.equal(count("external_work_item_links"), 1);
    assert.equal(count("external_work_item_snapshots"), 2);
    assert.equal(count("external_work_item_import_runs"), 2);
    assert.equal(count("audit_events", "event_type = 'external_work_item.imported'"), 1);
    assert.equal(count("audit_events", "event_type = 'external_work_item.source_observed'"), 1);
  });

  it("rejects stale plans, reused request IDs with another plan, and non-feature parents", () => {
    const originalSource = githubIssue();
    const preview = previewExternalWorkItemImport(database, importInput([originalSource]));
    assert.throws(
      () => applyExternalWorkItemImport(database, {
        ...importInput([githubIssue({ title: "Changed after preview" })]),
        expectedPlanHash: preview.planHash,
        requestId: "stale-github-import",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "IMPORT_PREVIEW_STALE",
    );
    assert.equal(count("external_work_item_links"), 0);

    const firstApply = applyExternalWorkItemImport(database, {
      ...importInput([originalSource]),
      expectedPlanHash: preview.planHash,
      requestId: "reused-github-import",
    });
    assert.equal(firstApply.imported.length, 1);
    const changedPreview = previewExternalWorkItemImport(database, importInput([githubIssue({ title: "Changed source" })]));
    assert.throws(
      () => applyExternalWorkItemImport(database, {
        ...importInput([githubIssue({ title: "Changed source" })]),
        expectedPlanHash: changedPreview.planHash,
        requestId: "reused-github-import",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "IDEMPOTENCY_CONFLICT",
    );

    const story = createWorkItem(database, {
      projectId,
      principalId,
      requestId: "external-fixture-story",
      type: "story",
      parentId: featureId,
      title: "Existing story",
    }).value;
    assert.throws(
      () => previewExternalWorkItemImport(database, importInput([githubIssue()], story.id)),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
  });

  it("maps Azure work item types explicitly and skips missing or unknown source types", () => {
    const sources = [
      azureWorkItem({ externalId: "1001", number: 1001, sourceType: "User Story" }),
      azureWorkItem({ externalId: "1002", number: 1002, sourceType: "Bug" }),
      azureWorkItem({ externalId: "1003", number: 1003, sourceType: null }),
      azureWorkItem({ externalId: "1004", number: 1004, sourceType: "Task" }),
    ];
    const input = {
      projectId,
      principalId,
      provider: "azure-devops" as const,
      externalScope: "acme-dev/Payments Core",
      parentFeatureIdOrKey: featureId,
      workItemType: "story" as const,
      externalWorkItemType: "User Story" as const,
      sources,
    };
    const preview = previewExternalWorkItemImport(database, input);

    assert.equal(preview.externalWorkItemType, "User Story");
    assert.equal(preview.workItemType, "story");
    assert.equal(preview.total, 4);
    assert.equal(preview.toCreate, 1);
    assert.equal(preview.skipped, 3);
    assert.deepEqual(preview.items.map(({ reason }) => reason), [null, "source_type_not_selected", "source_type_missing", "source_type_unmapped"]);
    assert.deepEqual(preview.items.map(({ sourceType }) => sourceType), ["User Story", "Bug", null, "Task"]);

    const result = applyExternalWorkItemImport(database, {
      ...input,
      expectedPlanHash: preview.planHash,
      requestId: "azure-import-type-filter",
    });
    assert.equal(result.imported.length, 1);
    const imported = getWorkItem(database, projectId, principalId, result.imported[0]!.workItemId);
    assert.equal(imported.type, "story");
    assert.equal(imported.state, "draft");
    const snapshot = database.prepare("SELECT source_json FROM external_work_item_snapshots").get() as { source_json: string };
    assert.equal((JSON.parse(snapshot.source_json) as { sourceType: string }).sourceType, "User Story");
  });

  it("requires a human PO before an external import can apply", () => {
    const developer = grantExternalIdentity(database, {
      projectId,
      principalId,
      requestId: "external-import-developer",
      issuer: "https://identity.example",
      subject: "developer-only",
      displayName: "Developer only",
      principalType: "human",
      roles: ["developer"],
      reason: "Test the read-only import authorization boundary.",
    }).value;

    assert.throws(
      () => assertExternalWorkItemImportApplyAuthorization(database, projectId, developer.principalId),
      (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN",
    );
    assert.doesNotThrow(() => assertExternalWorkItemImportApplyAuthorization(database, projectId, principalId));
  });

  function importInput(sources: readonly ExternalWorkItemSource[], parent = featureId) {
    return {
      projectId,
      principalId,
      provider: "github" as const,
      externalScope: "Acme/Payments",
      parentFeatureIdOrKey: parent,
      workItemType: "story" as const,
      sources,
    };
  }

  function githubIssue(overrides: Partial<ExternalWorkItemSource> = {}): ExternalWorkItemSource {
    return {
      externalId: "9001",
      number: 23,
      title: "Solicitar reembolso",
      body: "Uma solicitação de reembolso pode ser criada.",
      state: "open",
      url: "https://github.com/acme/payments/issues/23",
      labels: ["feature"],
      createdAt: "2026-11-01T12:00:00.000Z",
      updatedAt: "2026-11-02T12:00:00.000Z",
      ...overrides,
    };
  }

  function azureWorkItem(overrides: Partial<ExternalWorkItemSource> = {}): ExternalWorkItemSource {
    const number = Number(overrides.number ?? overrides.externalId ?? 1001);
    return {
      externalId: String(number),
      number,
      title: `Azure item ${number}`,
      body: `Azure description ${number}`,
      state: "New",
      url: `https://dev.azure.com/acme-dev/Payments%20Core/_workitems/edit/${number}`,
      labels: ["product"],
      createdAt: "2026-11-01T12:00:00.000Z",
      updatedAt: "2026-11-02T12:00:00.000Z",
      sourceType: "User Story",
      ...overrides,
    };
  }

  function rowCounts() {
    return {
      workItems: count("work_items"),
      links: count("external_work_item_links"),
      snapshots: count("external_work_item_snapshots"),
      runs: count("external_work_item_import_runs"),
    };
  }

  function count(table: string, where = "1 = 1"): number {
    const allowedTables = new Set([
      "work_items", "external_work_item_links", "external_work_item_snapshots",
      "external_work_item_import_runs", "audit_events",
    ]);
    assert.ok(allowedTables.has(table));
    return (database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as { count: number }).count;
  }
});
