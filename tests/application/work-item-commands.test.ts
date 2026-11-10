import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { addWorkItemComment, assignWorkItem, confirmWorkItemEstimate, listWorkItemComments, proposeWorkItemEstimate, rankWorkItem } from "../../src/application/work-item-commands.js";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { getWorkItem, listWorkItems } from "../../src/application/work-item-queries.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("work item ranking, assignment, comments and estimates", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let featureId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-work-item-commands-"));
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
    featureId = createWorkItem(database, command("feature", "Checkout", { parentId: epic.id })).value.id;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("reorders only siblings and uses versions to reject stale ranking", () => {
    const first = createWorkItem(database, command("story", "Primeira história", { parentId: featureId })).value;
    const second = createWorkItem(database, command("story", "Segunda história", { parentId: featureId })).value;

    const moved = rankWorkItem(database, {
      projectId,
      principalId,
      requestId: "rank-second-first",
      itemIdOrKey: second.id,
      beforeIdOrKey: first.id,
      expectedVersion: 1,
    });
    assert.deepEqual(listWorkItems(database, { projectId, principalId, parentId: featureId, types: ["story"] }).items.map((item) => item.id), [second.id, first.id]);
    assert.equal(moved.value.rank, 1024);
    assert.equal(moved.value.version, 2);
    assert.equal(getWorkItem(database, projectId, principalId, first.id).version, 2);
    const unchanged = rankWorkItem(database, {
      projectId,
      principalId,
      requestId: "rank-already-in-place",
      itemIdOrKey: second.id,
      beforeIdOrKey: first.id,
      expectedVersion: 2,
    });
    assert.equal(unchanged.value.version, 2);
    assert.throws(
      () => rankWorkItem(database, {
        projectId,
        principalId,
        requestId: "rank-second-stale",
        itemIdOrKey: second.id,
        afterIdOrKey: first.id,
        expectedVersion: 1,
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VERSION_CONFLICT",
    );

    const otherEpic = createWorkItem(database, command("epic", "Outro épico")).value;
    const otherFeature = createWorkItem(database, command("feature", "Outra feature", { parentId: otherEpic.id })).value;
    const unrelated = createWorkItem(database, command("story", "História externa", { parentId: otherFeature.id })).value;
    assert.throws(
      () => rankWorkItem(database, {
        projectId,
        principalId,
        requestId: "rank-cross-parent",
        itemIdOrKey: first.id,
        beforeIdOrKey: unrelated.id,
        expectedVersion: 2,
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
  });

  it("assigns only eligible project members and rejects a stale item version", () => {
    const story = createWorkItem(database, command("story", "História", { parentId: featureId })).value;
    const stakeholderId = createPrincipal("stakeholder");
    assert.throws(
      () => assignWorkItem(database, {
        projectId,
        principalId,
        requestId: "assign-ineligible",
        itemIdOrKey: story.id,
        assigneeId: stakeholderId,
        expectedVersion: 1,
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );

    const assigned = assignWorkItem(database, {
      projectId,
      principalId,
      requestId: "assign-self",
      itemIdOrKey: story.id,
      assigneeId: principalId,
      expectedVersion: 1,
    });
    assert.equal(assigned.value.assigneeId, principalId);
    assert.equal(getWorkItem(database, projectId, principalId, story.id).version, 2);
    assert.throws(
      () => assignWorkItem(database, {
        projectId,
        principalId,
        requestId: "assign-stale",
        itemIdOrKey: story.id,
        assigneeId: null,
        expectedVersion: 1,
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VERSION_CONFLICT",
    );
  });

  it("keeps comments immutable and detects changes between cursor pages", () => {
    const story = createWorkItem(database, command("story", "História", { parentId: featureId })).value;
    const first = addWorkItemComment(database, {
      projectId, principalId, requestId: "comment-1", itemIdOrKey: story.id, body: "Análise iniciada.",
    }).value;
    addWorkItemComment(database, {
      projectId, principalId, requestId: "comment-2", itemIdOrKey: story.id, body: "Critério validado.",
    });

    const page = listWorkItemComments(database, { projectId, principalId, itemIdOrKey: story.id, limit: 1 });
    assert.deepEqual(page.comments.map((comment) => comment.id), [first.id]);
    assert.ok(page.nextCursor);
    const next = listWorkItemComments(database, {
      projectId, principalId, itemIdOrKey: story.id, limit: 1, cursor: page.nextCursor,
    });
    assert.equal(next.comments[0]?.body, "Critério validado.");
    assert.equal(next.nextCursor, null);

    const stalePage = listWorkItemComments(database, { projectId, principalId, itemIdOrKey: story.id, limit: 1 });
    assert.ok(stalePage.nextCursor);
    addWorkItemComment(database, {
      projectId, principalId, requestId: "comment-3", itemIdOrKey: story.id, body: "Nova atualização.",
    });
    assert.throws(
      () => listWorkItemComments(database, {
        projectId, principalId, itemIdOrKey: story.id, limit: 1, cursor: stalePage.nextCursor!,
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "STALE_CURSOR",
    );
    assert.throws(
      () => database.prepare("UPDATE work_item_comments SET body = 'alterado' WHERE comment_id = ?").run(first.id),
      /immutable/,
    );
  });

  it("proposes and confirms point estimates while preserving superseded history", () => {
    const story = createWorkItem(database, command("story", "História", { parentId: featureId })).value;
    const first = proposeWorkItemEstimate(database, {
      projectId, principalId, requestId: "estimate-1", itemIdOrKey: story.id,
      unit: "points", value: 5, rationale: "Escopo moderado", expectedVersion: 1,
    }).value;
    const second = proposeWorkItemEstimate(database, {
      projectId, principalId, requestId: "estimate-2", itemIdOrKey: story.id,
      unit: "points", value: 8, rationale: "Inclui integração", expectedVersion: 2,
    }).value;
    const confirmed = confirmWorkItemEstimate(database, {
      projectId, principalId, requestId: "estimate-confirm-1", itemIdOrKey: story.id,
      proposalId: first.id, expectedVersion: 3,
    });
    assert.equal(confirmed.value.proposal.status, "confirmed");
    assert.equal(confirmed.value.version, 4);
    assert.deepEqual(getWorkItem(database, projectId, principalId, story.id).estimates.map(({ unit, value }) => ({ unit, value })), [
      { unit: "points", value: 5 },
    ]);
    const statuses = database.prepare(
      "SELECT proposal_id, status FROM work_item_estimate_proposals WHERE item_id = ? ORDER BY proposed_at, proposal_id",
    ).all(story.id) as Array<{ proposal_id: string; status: string }>;
    assert.equal(statuses.find((row) => row.proposal_id === first.id)?.status, "confirmed");
    assert.equal(statuses.find((row) => row.proposal_id === second.id)?.status, "superseded");

    assert.throws(
      () => proposeWorkItemEstimate(database, {
        projectId, principalId, requestId: "estimate-invalid-unit", itemIdOrKey: story.id,
        unit: "hours", value: 2, rationale: "Wrong unit", expectedVersion: 4,
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
  });

  function createPrincipal(role: "stakeholder"): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    database.prepare(
      "INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at) VALUES (?, 'human', ?, ?, ?)",
    ).run(id, `test:${id}`, role, now);
    database.prepare(
      "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)",
    ).run(projectId, id, role, now);
    return id;
  }

  function command(type: "epic" | "feature" | "story", title: string, overrides: { parentId?: string } = {}) {
    return {
      projectId,
      principalId,
      requestId: `command-${randomUUID()}`,
      type,
      title,
      ...(overrides.parentId === undefined ? {} : { parentId: overrides.parentId }),
    };
  }
});
