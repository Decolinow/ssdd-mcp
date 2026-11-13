import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { getWorkItem, listWorkItemRevisions } from "../../src/application/work-item-queries.js";
import { proposeWorkItemRevision, publishWorkItemRevision } from "../../src/application/work-item-revisions.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("versioned work item content", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let storyId: string;
  let criteria: Array<{ id: string; key: string; description: string; required: boolean; position: number }>;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-work-item-revisions-"));
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
    const epic = createWorkItem(database, command("epic", "Pagamentos")).value;
    const feature = createWorkItem(database, command("feature", "Checkout", { parentId: epic.id })).value;
    const story = createWorkItem(database, command("story", "Finalizar compra", {
      parentId: feature.id,
      description: "Permitir confirmar o pedido.",
      priority: 2,
      criteria: [
        { description: "Pedido válido é confirmado" },
        { description: "Estoque insuficiente bloqueia a compra", required: false },
      ],
    })).value;
    storyId = story.id;
    criteria = [...story.criteria];
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("keeps a proposed snapshot separate from published item content", () => {
    const proposed = proposeWorkItemRevision(database, {
      projectId,
      principalId,
      requestId: "revision-propose-2",
      itemIdOrKey: storyId,
      expectedVersion: 1,
      title: "Finalizar e acompanhar compra",
      criteria: [
        { id: criteria[0]!.id, description: criteria[0]!.description, required: true },
        { description: "A confirmação retorna número do pedido" },
      ],
    });

    assert.equal(proposed.value.revisionNumber, 2);
    assert.equal(proposed.value.status, "draft");
    assert.equal(getWorkItem(database, projectId, principalId, storyId).title, "Finalizar compra");
    assert.equal(getWorkItem(database, projectId, principalId, storyId).revision, 1);
    assert.deepEqual(listWorkItemRevisions(database, projectId, principalId, storyId).map(({ status }) => status), ["published", "draft"]);
    assert.throws(
      () => proposeWorkItemRevision(database, {
        projectId,
        principalId,
        requestId: "revision-propose-while-open",
        itemIdOrKey: storyId,
        expectedVersion: 2,
        title: "Outro título",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
    assert.throws(
      () => database.prepare("UPDATE work_item_revisions SET snapshot_json = '{}' WHERE revision_id = ?").run(proposed.value.id),
      /immutable/,
    );
  });

  it("publishes the latest draft, preserves criterion IDs and retires removed criteria", () => {
    const originalCriterion = criteria[0]!;
    const removedCriterion = criteria[1]!;
    const proposed = proposeWorkItemRevision(database, {
      projectId,
      principalId,
      requestId: "revision-publish-proposal",
      itemIdOrKey: storyId,
      expectedVersion: 1,
      title: "Finalizar e acompanhar compra",
      description: null,
      priority: 1,
      criteria: [
        { id: originalCriterion.id, description: "Pedido válido gera um pedido rastreável", required: true },
        { description: "A confirmação retorna número do pedido" },
      ],
    });
    const newCriterionId = proposed.value.snapshot.criteria[1]!.id;
    const published = publishWorkItemRevision(database, {
      projectId,
      principalId,
      requestId: "revision-publish-2",
      itemIdOrKey: storyId,
      revisionNumber: 2,
      expectedVersion: 2,
    });

    assert.equal(published.value.status, "published");
    assert.equal(published.value.publishedByPrincipalId, principalId);
    const current = getWorkItem(database, projectId, principalId, storyId);
    assert.equal(current.title, "Finalizar e acompanhar compra");
    assert.equal(current.description, null);
    assert.equal(current.priority, 1);
    assert.equal(current.revision, 2);
    assert.deepEqual(current.criteria.map(({ id }) => id), [originalCriterion.id, newCriterionId]);
    assert.equal(current.criteria[0]?.key, originalCriterion.key);
    assert.equal(current.criteria[0]?.description, "Pedido válido gera um pedido rastreável");
    const retired = database
      .prepare("SELECT is_active FROM work_item_criteria WHERE project_id = ? AND item_id = ? AND criterion_id = ?")
      .get(projectId, storyId, removedCriterion.id) as { is_active: number };
    assert.equal(retired.is_active, 0);

    const history = listWorkItemRevisions(database, projectId, principalId, storyId);
    assert.deepEqual(history.map(({ revisionNumber, status }) => ({ revisionNumber, status })), [
      { revisionNumber: 1, status: "superseded" },
      { revisionNumber: 2, status: "published" },
    ]);
    assert.equal(history[0]?.snapshot.criteria[0]?.description, "Pedido válido é confirmado");
    assert.throws(
      () => database.prepare("UPDATE work_item_revisions SET snapshot_json = '{}' WHERE revision_id = ?").run(history[0]!.id),
      /immutable/,
    );
    const auditCount = database
      .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE entity_id = ? AND event_type LIKE 'work_item.revision_%'")
      .get(storyId) as { count: number };
    assert.equal(auditCount.count, 2);
  });

  it("rejects stale versions, unchanged snapshots and publication without a human PO", () => {
    assert.throws(
      () => proposeWorkItemRevision(database, {
        projectId,
        principalId,
        requestId: "revision-stale",
        itemIdOrKey: storyId,
        expectedVersion: 4,
        title: "Título conflitante",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VERSION_CONFLICT",
    );
    assert.throws(
      () => proposeWorkItemRevision(database, {
        projectId,
        principalId,
        requestId: "revision-no-change",
        itemIdOrKey: storyId,
        expectedVersion: 1,
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );

    const proposed = proposeWorkItemRevision(database, {
      projectId,
      principalId,
      requestId: "revision-propose-for-role",
      itemIdOrKey: storyId,
      expectedVersion: 1,
      title: "Novo título",
    }).value;
    const developerId = createPrincipal("human", "developer");
    assert.throws(
      () => publishWorkItemRevision(database, {
        projectId,
        principalId: developerId,
        requestId: "revision-publish-non-po",
        itemIdOrKey: storyId,
        revisionNumber: proposed.revisionNumber,
        expectedVersion: 2,
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN",
    );
    assert.equal(getWorkItem(database, projectId, principalId, storyId).revision, 1);
  });

  function createPrincipal(type: "human", role: "developer"): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    database.prepare(
      "INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, type, `test:${id}`, role, now);
    database.prepare(
      "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)",
    ).run(projectId, id, role, now);
    return id;
  }

  it("stores structured criterion fields, keeps them on re-proposal and stays backward compatible", () => {
    const first = criteria[0]!;
    proposeWorkItemRevision(database, {
      projectId, principalId, requestId: "structured-propose", itemIdOrKey: storyId, expectedVersion: 1,
      criteria: [
        { id: first.id, description: first.description, given: "um pedido válido", when: "o cliente confirma", then: "o pedido é criado", verification: "automated", example: "pedido #1" },
        { id: criteria[1]!.id, description: criteria[1]!.description },
      ],
    });
    publishWorkItemRevision(database, { projectId, principalId, requestId: "structured-publish", itemIdOrKey: storyId, revisionNumber: 2, expectedVersion: 2 });
    let current = getWorkItem(database, projectId, principalId, storyId);
    assert.equal(current.criteria[0]?.given, "um pedido válido");
    assert.equal(current.criteria[0]?.verification, "automated");
    assert.equal(current.criteria[1]?.given, undefined);

    // Re-proposing without structured fields keeps the previous structure.
    proposeWorkItemRevision(database, {
      projectId, principalId, requestId: "structured-reuse", itemIdOrKey: storyId, expectedVersion: 3,
      criteria: [{ id: first.id, description: "Pedido válido é confirmado (reescrito)" }],
    });
    publishWorkItemRevision(database, { projectId, principalId, requestId: "structured-reuse-publish", itemIdOrKey: storyId, revisionNumber: 3, expectedVersion: 4 });
    current = getWorkItem(database, projectId, principalId, storyId);
    assert.equal(current.criteria[0]?.then, "o pedido é criado");
    assert.equal(current.criteria[0]?.description, "Pedido válido é confirmado (reescrito)");

    assert.throws(
      () => proposeWorkItemRevision(database, {
        projectId, principalId, requestId: "structured-invalid", itemIdOrKey: storyId, expectedVersion: 5,
        criteria: [{ id: first.id, description: "x", verification: "magic" as unknown as "manual" }],
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
  });

  function command(type: "epic" | "feature" | "story", title: string, overrides: {
    parentId?: string;
    description?: string;
    priority?: number;
    criteria?: readonly { description: string; required?: boolean }[];
  } = {}) {
    return {
      projectId,
      principalId,
      requestId: `create-${randomUUID()}`,
      type,
      title,
      ...(overrides.parentId === undefined ? {} : { parentId: overrides.parentId }),
      ...(overrides.description === undefined ? {} : { description: overrides.description }),
      ...(overrides.priority === undefined ? {} : { priority: overrides.priority }),
      ...(overrides.criteria === undefined ? {} : { criteria: overrides.criteria }),
    };
  }
});
