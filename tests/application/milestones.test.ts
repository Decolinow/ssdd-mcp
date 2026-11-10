import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { changeMilestoneScope, createMilestone, getMilestone, listMilestones } from "../../src/application/milestones.js";
import { ApplicationError } from "../../src/application/errors.js";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createScenario, publishScenarioRevision } from "../../src/application/scenario-commands.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { confirmWorkItemEstimate, proposeWorkItemEstimate } from "../../src/application/work-item-commands.js";
import { getWorkItem } from "../../src/application/work-item-queries.js";
import { transitionWorkItem } from "../../src/application/work-item-workflow.js";

describe("approved milestone scope", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let featureId: string;
  let pbis: Array<{ id: string; key: string }>;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-milestone-"));
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
    principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
      .get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    const epic = createWorkItem(database, {
      projectId, principalId, requestId: requestId("epic"), type: "epic", title: "Pagamentos",
    }).value;
    featureId = createWorkItem(database, {
      projectId, principalId, requestId: requestId("feature"), type: "feature", parentId: epic.id, title: "Checkout",
    }).value.id;
    pbis = [createReadyPbi("Confirmar pedido", 3, 1), createReadyPbi("Consultar pedido", 5, 2)];
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("creates an approved baseline scope and preserves each add/remove as an immutable event", () => {
    const [first, second] = pbis;
    assert.ok(first && second);
    const createInput = {
      projectId,
      principalId,
      requestId: "milestone-create-replay",
      milestoneKey: "PAY-1.0",
      title: "Primeiro lançamento",
      goal: "Entregar o fluxo mínimo de pagamentos.",
      targetDate: "2026-12-15",
      itemIdsOrKeys: [first.id],
      reason: "Aprovar o escopo inicial do lançamento.",
    };
    const created = createMilestone(database, createInput);
    const replayed = createMilestone(database, createInput);
    assert.equal(created.value.id, replayed.value.id);
    assert.deepEqual(created.auditEventIds, replayed.auditEventIds);
    assert.equal(created.value.version, 1);
    assert.deepEqual(created.value.scope.map((item) => ({
      itemId: item.itemId,
      stateAtApproval: item.stateAtApproval,
      points: item.points,
    })), [{ itemId: first.id, stateAtApproval: "ready", points: 3 }]);
    assert.equal(created.value.scope[0]?.baselineId.length, 36);
    assert.deepEqual(created.value.scopeHistory.map((event) => event.action), ["add"]);

    assert.throws(
      () => changeMilestoneScope(database, {
        projectId, principalId, requestId: requestId("same-item-change"), milestoneIdOrKey: created.value.id,
        expectedVersion: 1, addItemIdsOrKeys: [first.id], removeItemIdsOrKeys: [first.key.toLowerCase()],
        reason: "Tentar alternar o mesmo item em uma alteração.",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
    assert.equal(getMilestone(database, projectId, principalId, created.value.key).version, 1);

    const changed = changeMilestoneScope(database, {
      projectId, principalId, requestId: "milestone-scope-v2", milestoneIdOrKey: created.value.key,
      expectedVersion: 1, addItemIdsOrKeys: [second.key], removeItemIdsOrKeys: [first.id],
      reason: "Repriorizar a entrega após a revisão do plano.",
    }).value;
    assert.equal(changed.version, 2);
    assert.deepEqual(changed.scope.map((item) => item.itemId), [second.id]);
    assert.deepEqual(changed.scopeHistory.map((event) => [event.action, event.itemId]), [
      ["add", first.id], ["remove", first.id], ["add", second.id],
    ]);
    assert.equal(changed.scopeHistory[1]?.stateAtApproval, "ready");
    assert.equal(changed.scopeHistory[1]?.reason, "Repriorizar a entrega após a revisão do plano.");

    const addBack = changeMilestoneScope(database, {
      projectId, principalId, requestId: "milestone-scope-v3", milestoneIdOrKey: created.value.id,
      expectedVersion: 2, addItemIdsOrKeys: [first.key],
      reason: "Trazer o fluxo de confirmação de volta ao escopo.",
    });
    assert.equal(addBack.value.version, 3);
    assert.deepEqual(addBack.value.scope.map((item) => item.itemId), [second.id, first.id]);
    assert.deepEqual(listMilestones(database, projectId, principalId).map((item) => ({
      key: item.key,
      scopeItemCount: item.scopeItemCount,
      scopePoints: item.scopePoints,
    })), [{ key: "PAY-1.0", scopeItemCount: 2, scopePoints: 8 }]);
    assert.throws(
      () => database.prepare("UPDATE milestone_scope_events SET reason = 'mutada' WHERE milestone_id = ?").run(created.value.id),
      /immutable/,
    );
    assert.throws(
      () => database.prepare("DELETE FROM milestone_scope_events WHERE milestone_id = ?").run(created.value.id),
      /immutable/,
    );
  });

  it("rejects stale versions, non-PO scope changes, duplicate aliases and PBIs without a current approval snapshot", () => {
    const [first] = pbis;
    assert.ok(first);
    const milestone = createMilestone(database, {
      projectId, principalId, requestId: requestId("milestone"), milestoneKey: "PAY-1.1",
      title: "Entrega seguinte", goal: "Entregar a próxima evolução.", targetDate: "2027-01-15",
      itemIdsOrKeys: [first.key], reason: "Escopo aprovado pelo PO.",
    }).value;
    assert.throws(
      () => changeMilestoneScope(database, {
        projectId, principalId, requestId: requestId("stale"), milestoneIdOrKey: milestone.id,
        expectedVersion: 2, removeItemIdsOrKeys: [first.id], reason: "Versão desatualizada.",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VERSION_CONFLICT",
    );
    const developerId = addProjectMember("developer");
    assert.throws(
      () => changeMilestoneScope(database, {
        projectId, principalId: developerId, requestId: requestId("developer"), milestoneIdOrKey: milestone.id,
        expectedVersion: 1, removeItemIdsOrKeys: [first.id], reason: "Tentativa sem papel PO.",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN",
    );
    assert.throws(
      () => createMilestone(database, {
        projectId, principalId, requestId: requestId("duplicate-alias"), milestoneKey: "PAY-DUP",
        title: "Duplicado", goal: "Não duplicar PBIs por chave e ID.", targetDate: "2027-01-20",
        itemIdsOrKeys: [first.id, first.key], reason: "Referências equivalentes.",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
    assert.throws(
      () => createMilestone(database, {
        projectId, principalId, requestId: requestId("unready"), milestoneKey: "PAY-DRAFT",
        title: "Sem aprovação", goal: "PBI Draft não pode ser aprovado.", targetDate: "2027-01-20",
        itemIdsOrKeys: [createDraftPbi()], reason: "Validar gate.",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "GATE_BLOCKED",
    );
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM milestones WHERE project_id = ?")
      .get(projectId) as { count: number }).count, 1);
  });

  function createDraftPbi(): string {
    return createWorkItem(database, {
      projectId, principalId, requestId: requestId("draft-story"), type: "story", parentId: featureId,
      title: "História ainda em refinamento", criteria: [{ description: "Critério ainda sem cenário publicado." }],
    }).value.id;
  }

  function createReadyPbi(title: string, points: number, sequence: number): { id: string; key: string } {
    const item = createWorkItem(database, {
      projectId, principalId, requestId: requestId("story"), type: "story", parentId: featureId,
      title, description: `${title} para o cliente.`, criteria: [{ description: `${title} funciona conforme esperado.` }],
    }).value;
    const scenario = createScenario(database, {
      projectId, principalId, requestId: requestId("scenario"), key: `PAY-TC-${sequence}`,
      kind: "acceptance", title: `Validar ${title}`,
      steps: [{ action: title, expected: "A operação conclui com sucesso." }],
      coverage: [{ targetType: "criterion", reference: item.criteria[0]!.id }],
    }).value;
    publishScenarioRevision(database, {
      projectId, principalId, requestId: requestId("scenario-publish"),
      scenarioIdOrKey: scenario.scenarioId, revisionNumber: 1, expectedVersion: 1,
    });
    const proposal = proposeWorkItemEstimate(database, {
      projectId, principalId, requestId: requestId("estimate"), itemIdOrKey: item.id,
      unit: "points", value: points, rationale: "Estimativa da equipe.", expectedVersion: item.version,
    }).value;
    const proposed = getWorkItem(database, projectId, principalId, item.id);
    confirmWorkItemEstimate(database, {
      projectId, principalId, requestId: requestId("estimate-confirm"), itemIdOrKey: item.id,
      proposalId: proposal.id, expectedVersion: proposed.version,
    });
    const current = getWorkItem(database, projectId, principalId, item.id);
    transitionWorkItem(database, {
      projectId, principalId, requestId: requestId("ready"), itemIdOrKey: item.id,
      targetState: "ready", expectedVersion: current.version, reason: "PBI aprovado para planejamento.",
    });
    return { id: item.id, key: item.key };
  }

  function addProjectMember(role: "developer"): string {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    database.prepare(
      `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
       VALUES (?, 'human', ?, 'Milestone developer', ?)`,
    ).run(id, `milestone-test:${id}`, createdAt);
    database.prepare(
      "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)",
    ).run(projectId, id, role, createdAt);
    return id;
  }
});

function requestId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
