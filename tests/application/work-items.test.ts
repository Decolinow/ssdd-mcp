import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { bindRoadmapItemId } from "../../src/application/roadmap-identifiers.js";
import { proposeWorkItemRevision } from "../../src/application/work-item-revisions.js";
import { getWorkItem, listWorkItemRevisions, listWorkItems } from "../../src/application/work-item-queries.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("work item hierarchy and acceptance criteria", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-work-items-"));
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
    const project = database
      .prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
      .get(projectId) as { created_by_principal_id: string };
    principalId = project.created_by_principal_id;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("creates and reads an epic, feature and story with ordered criteria", () => {
    const epic = createWorkItem(database, command("epic", "Epic pagamentos")).value;
    const feature = createWorkItem(
      database,
      command("feature", "Autenticação", { parentId: epic.id }),
    ).value;
    const story = createWorkItem(
      database,
      command("story", "Entrar com senha", {
        parentId: feature.id,
        criteria: [
          { description: "Senha válida permite acesso" },
          { description: "Senha incorreta não inicia sessão", required: false },
        ],
      }),
    ).value;

    assert.equal(epic.key, "PAY-1");
    assert.equal(feature.key, "PAY-2");
    assert.equal(story.key, "PAY-3");
    assert.equal(story.parentId, feature.id);
    assert.equal(story.revision, 1);
    assert.deepEqual(
      story.criteria.map(({ key, description, required, position }) => ({
        key,
        description,
        required,
        position,
      })),
      [
        {
          key: "AC-1",
          description: "Senha válida permite acesso",
          required: true,
          position: 1,
        },
        {
          key: "AC-2",
          description: "Senha incorreta não inicia sessão",
          required: false,
          position: 2,
        },
      ],
    );
    assert.equal(getWorkItem(database, projectId, principalId, "PAY-3").id, story.id);
    assert.equal(getWorkItem(database, projectId, principalId, "pay-3").id, story.id);
    const revision = database
      .prepare(
        "SELECT revision_number, snapshot_json FROM work_item_revisions WHERE item_id = ?",
      )
      .get(story.id) as { revision_number: number; snapshot_json: string };
    assert.equal(revision.revision_number, 1);
    assert.match(revision.snapshot_json, /AC-1/);
    assert.throws(() =>
      database
        .prepare("UPDATE work_item_revisions SET snapshot_json = '{}' WHERE item_id = ?")
        .run(story.id),
    );

    const auditRows = database
      .prepare("SELECT entity_id FROM audit_events WHERE event_type = 'work_item.created' ORDER BY sequence")
      .all() as Array<{ entity_id: string }>;
    assert.deepEqual(auditRows.map((row) => row.entity_id), [epic.id, feature.id, story.id]);
  });

  it("stores business value with its rationale in immutable content revisions and leaves legacy values unknown", () => {
    const epic = createWorkItem(database, command("epic", "Epic valor", {
      priority: 1,
      businessValueScore: 72,
      businessValueRationale: "Reduz risco de falha no fluxo de pagamento.",
    })).value;
    const feature = createWorkItem(database, command("feature", "Feature valor", { parentId: epic.id })).value;
    assert.equal(epic.businessValueScore, 72);
    assert.equal(epic.businessValueRationale, "Reduz risco de falha no fluxo de pagamento.");
    assert.equal(feature.businessValueScore, null);
    assert.equal(feature.businessValueRationale, null);
    assert.equal(listWorkItems(database, { projectId, principalId, types: ["epic"] }).items[0]?.businessValueScore, 72);

    const proposed = proposeWorkItemRevision(database, {
      projectId,
      principalId,
      requestId: `value-revision-${randomUUID()}`,
      itemIdOrKey: epic.key,
      expectedVersion: epic.version,
      businessValueScore: 91,
      businessValueRationale: "Remove the highest customer-impacting checkout failure.",
    });
    assert.equal(proposed.value.snapshot.businessValueScore, 91);
    assert.equal(getWorkItem(database, projectId, principalId, epic.id).businessValueScore, 72);
    assert.equal(listWorkItemRevisions(database, projectId, principalId, epic.id)[1]?.snapshot.businessValueScore, 91);
  });

  it("requires a rationale and limits business value to epics, features and tasks", () => {
    assert.throws(
      () => createWorkItem(database, command("epic", "Sem justificativa", { businessValueScore: 50 })),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
    const epic = createWorkItem(database, command("epic", "Epic válido")).value;
    const feature = createWorkItem(database, command("feature", "Feature válida", { parentId: epic.id })).value;
    assert.throws(
      () => createWorkItem(database, command("story", "PBI sem valor", {
        parentId: feature.id,
        businessValueScore: 50,
        businessValueRationale: "A score on a story is outside the value model.",
      })),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
  });

  it("resolves a mapped stable roadmap ID before a generated key with the same spelling", () => {
    const epic = createWorkItem(database, command("epic", "Epic roadmap")).value;
    const feature = createWorkItem(database, command("feature", "Feature roadmap", { parentId: epic.id })).value;
    const story = createWorkItem(database, command("story", "Story roadmap", { parentId: feature.id })).value;
    const stableTask = createWorkItem(database, command("task", "Stable SSDD-101 task", { parentId: story.id })).value;
    const generatedKeyTask = createWorkItem(database, command("task", "Generated SSDD-101 key", { parentId: story.id })).value;
    database.prepare("UPDATE work_items SET item_key = 'SSDD-101' WHERE project_id = ? AND item_id = ?")
      .run(projectId, generatedKeyTask.id);

    const mapping = bindRoadmapItemId(database, {
      projectId,
      principalId,
      requestId: "bind-stable-roadmap-id",
      roadmapId: "SSDD-101",
      itemIdOrKey: stableTask.id,
    }).value;

    assert.equal(mapping.itemId, stableTask.id);
    assert.equal(mapping.itemKey, stableTask.key);
    assert.equal(getWorkItem(database, projectId, principalId, "SSDD-101").id, stableTask.id);
    assert.equal(getWorkItem(database, projectId, principalId, generatedKeyTask.id).id, generatedKeyTask.id);
    assert.equal(listWorkItemRevisions(database, projectId, principalId, "SSDD-101")[0]?.itemId, stableTask.id);
    const proposed = proposeWorkItemRevision(database, {
      projectId,
      principalId,
      requestId: "propose-through-stable-roadmap-alias",
      itemIdOrKey: "SSDD-101",
      expectedVersion: stableTask.version,
      description: "A revisão deve resolver o alias estável.",
    });
    assert.equal(proposed.value.itemId, stableTask.id);
  });

  it("rejects wrong and cross-project parents without consuming a key or writing partial state", () => {
    const otherProject = initializeProject({
      workspace,
      key: "OPS",
      name: "Operations",
      productGoal: "Operações previsíveis",
      timezone: "America/Sao_Paulo",
    });
    const otherEpic = createWorkItem(
      database,
      command("epic", "Operations epic", { projectId: otherProject.project.id }),
    ).value;

    assert.throws(
      () => createWorkItem(database, command("feature", "Sem pai")),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
    assert.throws(
      () =>
        createWorkItem(
          database,
          command("feature", "Pai externo", { parentId: otherEpic.id }),
        ),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );

    const localEpic = createWorkItem(database, command("epic", "Local epic")).value;
    assert.equal(localEpic.key, "PAY-1");

    const payItems = database
      .prepare("SELECT COUNT(*) AS count FROM work_items WHERE project_id = ?")
      .get(projectId) as { count: number };
    const rejectedRequests = database
      .prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE project_id = ?")
      .get(projectId) as { count: number };
    assert.equal(payItems.count, 1);
    assert.equal(rejectedRequests.count, 1);
  });

  it("replays the same create once and rejects changed payload under that request ID", () => {
    const original = command("epic", "Payments epic", { requestId: "create-epic-1" });
    const first = createWorkItem(database, original);
    const replay = createWorkItem(database, { ...original, title: " Payments epic " });

    assert.deepEqual(replay, first);
    assert.equal(replay.auditEventIds.length, 1);
    assert.throws(
      () => createWorkItem(database, { ...original, title: "Changed epic" }),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "IDEMPOTENCY_CONFLICT",
    );

    const count = database
      .prepare("SELECT COUNT(*) AS count FROM work_items WHERE project_id = ?")
      .get(projectId) as { count: number };
    const auditCount = database
      .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'work_item.created'")
      .get() as { count: number };
    assert.equal(count.count, 1);
    assert.equal(auditCount.count, 1);
  });

  it("checks work item creation roles before writing", () => {
    const qaId = randomUUID();
    const createdAt = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
         VALUES (?, 'human', ?, 'qa-only', ?)`,
      )
      .run(qaId, `test:${qaId}`, createdAt);
    database
      .prepare(
        "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, 'qa', ?)",
      )
      .run(projectId, qaId, createdAt);

    assert.throws(
      () => createWorkItem(database, command("epic", "Forbidden epic", { principalId: qaId })),
      (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN",
    );
    const count = database
      .prepare("SELECT COUNT(*) AS count FROM work_items WHERE project_id = ?")
      .get(projectId) as { count: number };
    assert.equal(count.count, 0);
  });

  it("combines list filters with OR inside arrays and searches Portuguese text without accents", () => {
    const epic = createWorkItem(database, command("epic", "Segurança de pagamentos")).value;
    const feature = createWorkItem(
      database,
      command("feature", "Autenticação", { parentId: epic.id }),
    ).value;
    const matched = createWorkItem(
      database,
      command("story", "Validar a senha", {
        parentId: feature.id,
        description: "O segundo fator confiável é enviado ao usuário.",
      }),
    ).value;
    createWorkItem(
      database,
      command("story", "Recuperar acesso", {
        parentId: feature.id,
        description: "Solicita um código de recuperação.",
      }),
    );
    createWorkItem(
      database,
      command("bug", "Falha na senha", {
        parentId: feature.id,
        relatedStoryId: matched.id,
      }),
    );

    const page = listWorkItems(database, {
      projectId,
      principalId,
      types: ["story", "bug"],
      parentId: feature.key,
      search: "confiavel segundo",
    });
    assert.deepEqual(page.items.map((item) => item.id), [matched.id]);
    assert.equal(page.nextCursor, null);
  });

  it("paginates by stable keys, binds cursors to filters and detects changed project data", () => {
    createWorkItem(database, command("epic", "Epic um"));
    createWorkItem(database, command("epic", "Epic dois"));
    createWorkItem(database, command("epic", "Epic três"));

    const firstPage = listWorkItems(database, { projectId, principalId, limit: 1 });
    assert.equal(firstPage.items[0]?.key, "PAY-1");
    assert.ok(firstPage.nextCursor);

    const secondPage = listWorkItems(database, {
      projectId,
      principalId,
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    assert.equal(secondPage.items[0]?.key, "PAY-2");
    assert.ok(secondPage.nextCursor);

    assert.throws(
      () => listWorkItems(database, { projectId, principalId, cursor: "not-a-valid-cursor" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );

    assert.throws(
      () =>
        listWorkItems(database, {
          projectId,
          principalId,
          limit: 1,
          types: ["epic"],
          cursor: firstPage.nextCursor!,
        }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );

    createWorkItem(database, command("epic", "Epic quatro"));
    assert.throws(
      () =>
        listWorkItems(database, {
          projectId,
          principalId,
          limit: 1,
          cursor: firstPage.nextCursor!,
        }),
      (error: unknown) => error instanceof ApplicationError && error.code === "STALE_CURSOR",
    );
  });

  function command(
    type: "epic" | "feature" | "story" | "bug" | "task",
    title: string,
    overrides: {
      projectId?: string;
      principalId?: string;
      parentId?: string;
      relatedStoryId?: string;
      requestId?: string;
      description?: string;
      priority?: number;
      businessValueScore?: number | null;
      businessValueRationale?: string | null;
      criteria?: readonly { description: string; required?: boolean }[];
    } = {},
  ) {
    return {
      projectId: overrides.projectId ?? projectId,
      principalId: overrides.principalId ?? principalId,
      requestId: overrides.requestId ?? `request-${randomUUID()}`,
      type,
      title,
      ...(overrides.parentId === undefined ? {} : { parentId: overrides.parentId }),
      ...(overrides.relatedStoryId === undefined ? {} : { relatedStoryId: overrides.relatedStoryId }),
      ...(overrides.description === undefined ? {} : { description: overrides.description }),
      ...(overrides.priority === undefined ? {} : { priority: overrides.priority }),
      ...(overrides.businessValueScore === undefined ? {} : { businessValueScore: overrides.businessValueScore }),
      ...(overrides.businessValueRationale === undefined ? {} : { businessValueRationale: overrides.businessValueRationale }),
      ...(overrides.criteria === undefined ? {} : { criteria: overrides.criteria }),
    };
  }
});
