import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fixWorkItemBaseline, getWorkBaseline, listImpactFlags, revalidateWorkItemBaseline } from "../../src/application/baseline-commands.js";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ApplicationError } from "../../src/application/errors.js";
import { proposeWorkItemRevision, publishWorkItemRevision } from "../../src/application/work-item-revisions.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { publishSpecificationRevision, createSpecification, proposeSpecificationRevision } from "../../src/application/specification-commands.js";
import { addTraceLink } from "../../src/application/trace-commands.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("work item baselines and specification impacts", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let storyId: string;
  let specId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-baselines-"));
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
    principalId = (database
      .prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
      .get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    const epic = createWorkItem(database, {
      projectId, principalId, requestId: `epic-${randomUUID()}`, type: "epic", title: "Pagamentos",
    }).value;
    const feature = createWorkItem(database, {
      projectId, principalId, requestId: `feature-${randomUUID()}`, type: "feature", parentId: epic.id, title: "Checkout",
    }).value;
    storyId = createWorkItem(database, {
      projectId,
      principalId,
      requestId: `story-${randomUUID()}`,
      type: "story",
      parentId: feature.id,
      title: "Confirmar compra",
    }).value.id;
    specId = createSpecification(database, {
      projectId,
      principalId,
      requestId: `spec-${randomUUID()}`,
      key: "BR-01",
      kind: "business_rule",
      title: "Confirmação",
      content: { text: "O pedido confirmado recebe um identificador." },
    }).value.specId;
    publishSpecificationRevision(database, {
      projectId, principalId, requestId: `spec-publish-${randomUUID()}`,
      specIdOrKey: specId, revisionNumber: 1, expectedVersion: 1,
    });
    addTraceLink(database, {
      projectId, principalId, requestId: `link-${randomUUID()}`,
      sourceIdOrKey: storyId, targetIdOrKey: specId, type: "implements",
    });
    database.prepare("UPDATE work_items SET state = 'ready' WHERE project_id = ? AND item_id = ?")
      .run(projectId, storyId);
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("captures a ready baseline, flags a later rule revision and resolves it into a new baseline", () => {
    const baseline = fixWorkItemBaseline(database, {
      projectId,
      principalId,
      requestId: "baseline-fix",
      itemIdOrKey: storyId,
      expectedVersion: 1,
      reason: "PO aceitou o escopo para implementação",
    }).value;
    assert.equal(baseline.sequence, 1);
    assert.deepEqual(baseline.references.map(({ entityType, key, revisionNumber }) => ({ entityType, key, revisionNumber })), [
      { entityType: "specification_revision", key: "BR-01", revisionNumber: 1 },
      { entityType: "work_item_revision", key: "PAY-3", revisionNumber: 1 },
    ]);

    proposeSpecificationRevision(database, {
      projectId,
      principalId,
      requestId: "spec-propose-2",
      specIdOrKey: specId,
      expectedVersion: 2,
      content: { text: "A confirmação registra o identificador no mesmo instante do pagamento." },
    });
    publishSpecificationRevision(database, {
      projectId,
      principalId,
      requestId: "spec-publish-2",
      specIdOrKey: specId,
      revisionNumber: 2,
      expectedVersion: 3,
    });
    const impacts = listImpactFlags(database, projectId, principalId, storyId);
    assert.equal(impacts.length, 1);
    assert.equal(impacts[0]?.status, "open");
    assert.equal(impacts[0]?.baselineRevision, 1);
    assert.equal(impacts[0]?.publishedRevision, 2);
    assert.equal(getWorkBaseline(database, projectId, principalId, storyId, 1).references[0]?.revisionNumber, 1);

    assert.throws(
      () => revalidateWorkItemBaseline(database, {
        projectId, principalId, requestId: "baseline-stale", itemIdOrKey: storyId,
        expectedVersion: 2, reason: "Versão vencida",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VERSION_CONFLICT",
    );
    const revalidated = revalidateWorkItemBaseline(database, {
      projectId,
      principalId,
      requestId: "baseline-revalidate",
      itemIdOrKey: storyId,
      expectedVersion: 3,
      reason: "PO revisou a alteração e aprovou a nova baseline",
    }).value;
    assert.equal(revalidated.baseline.sequence, 2);
    assert.equal(revalidated.resolvedImpactIds[0], impacts[0]?.id);
    assert.equal(listImpactFlags(database, projectId, principalId, storyId, "open").length, 0);
    assert.equal(listImpactFlags(database, projectId, principalId, storyId, "revalidated").length, 1);
    const oldBaseline = getWorkBaseline(database, projectId, principalId, storyId, 1);
    const newBaseline = getWorkBaseline(database, projectId, principalId, storyId, 2);
    assert.equal(oldBaseline.references.find((reference) => reference.entityType === "specification_revision")?.revisionNumber, 1);
    assert.equal(newBaseline.references.find((reference) => reference.entityType === "specification_revision")?.revisionNumber, 2);
    assert.throws(
      () => database.prepare("UPDATE work_baselines SET reason = 'alterado' WHERE baseline_id = ?").run(oldBaseline.id),
      /immutable/,
    );
  });

  it("revalidates a baseline that drifted from newly published content without any open impact", () => {
    const version = (): number => (database
      .prepare("SELECT version FROM work_items WHERE project_id = ? AND item_id = ?")
      .get(projectId, storyId) as { version: number }).version;
    fixWorkItemBaseline(database, {
      projectId, principalId, requestId: "drift-fix", itemIdOrKey: storyId,
      expectedVersion: version(), reason: "Baseline inicial",
    });
    assert.throws(
      () => revalidateWorkItemBaseline(database, {
        projectId, principalId, requestId: "drift-none", itemIdOrKey: storyId,
        expectedVersion: version(), reason: "Nada mudou",
      }),
      (error: unknown) => error instanceof ApplicationError && /Nothing to revalidate/u.test(error.message),
    );

    proposeWorkItemRevision(database, {
      projectId, principalId, requestId: "drift-propose", itemIdOrKey: storyId, expectedVersion: version(),
      criteria: [{ description: "Pedido confirmado recebe identificador", required: true }],
    });
    publishWorkItemRevision(database, {
      projectId, principalId, requestId: "drift-publish", itemIdOrKey: storyId,
      revisionNumber: 2, expectedVersion: version(),
    });
    assert.equal(listImpactFlags(database, projectId, principalId, storyId, "open").length, 0);

    const revalidated = revalidateWorkItemBaseline(database, {
      projectId, principalId, requestId: "drift-revalidate", itemIdOrKey: storyId,
      expectedVersion: version(), reason: "Critério obrigatório adicionado após a baseline",
    }).value;
    assert.equal(revalidated.baseline.sequence, 2);
    assert.equal(revalidated.baseline.kind, "revalidation");
    assert.deepEqual(revalidated.resolvedImpactIds, []);
    assert.equal(
      revalidated.baseline.references.find((reference) => reference.entityType === "work_item_revision")?.revisionNumber,
      2,
    );
    assert.throws(
      () => revalidateWorkItemBaseline(database, {
        projectId, principalId, requestId: "drift-again", itemIdOrKey: storyId,
        expectedVersion: version(), reason: "Repetir",
      }),
      (error: unknown) => error instanceof ApplicationError && /Nothing to revalidate/u.test(error.message),
    );
  });
});
