import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { setDefinitionOfDone } from "../../src/application/definition-of-done.js";
import { getProjectCoverageMetrics, getProjectVelocityMetrics, getProjectWipMetrics,
  getMilestoneBurnupMetrics, getSprintDeliveryMetrics } from "../../src/application/metrics-queries.js";
import { getProjectDashboardMetrics } from "../../src/application/dashboard-metrics.js";
import { createMilestone } from "../../src/application/milestones.js";
import { createScenario, publishScenarioRevision, recordTestRun } from "../../src/application/scenario-commands.js";
import { closeSprint, createSprintDraft, changeSprintScope, startSprint } from "../../src/application/sprint-commands.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { setTeamCapacityConfiguration } from "../../src/application/team-capacity.js";
import { confirmWorkItemEstimate, proposeWorkItemEstimate } from "../../src/application/work-item-commands.js";
import { getWorkItem } from "../../src/application/work-item-queries.js";
import { addWorkItemEvidence, certifyTestRun, transitionWorkItem } from "../../src/application/work-item-workflow.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import type { WorkItemState } from "../../src/domain/work-items.js";

describe("project metrics projections", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let featureId: string;
  let pbis: Array<{ id: string; key: string; scenarioId: string }>;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-metrics-"));
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
    setTeamCapacityConfiguration(database, {
      projectId,
      principalId,
      requestId: requestId("capacity"),
      expectedVersion: 0,
      teamName: "Payments team",
      timezone: "America/Sao_Paulo",
      hoursPerDay: 6,
      workingDays: [1, 2, 3, 4, 5],
      members: [{ principalId, dedicationPercent: 100 }],
      reason: "Configuração inicial do time.",
    });
    setDefinitionOfDone(database, {
      projectId,
      principalId,
      requestId: requestId("dod"),
      expectedVersion: 0,
      criteria: [{ description: "Critérios aceitos e evidências registradas." }],
      reason: "Definição inicial para as entregas do projeto.",
    });
    pbis = [createReadyPbi("Confirmar pedido", 3, 1), createReadyPbi("Consultar pedido", 5, 2)];
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("rebuilds burndown, burnup, velocity, WIP, and certified coverage from immutable history", () => {
    const [reopenedPbi, deliveredPbi] = pbis;
    assert.ok(reopenedPbi && deliveredPbi);
    const startDate = projectToday();
    const endDate = addDays(startDate, 10);

    const milestone = createMilestone(database, {
      projectId, principalId, requestId: requestId("milestone"), milestoneKey: "PAY-1.0",
      title: "Primeiro lançamento", goal: "Entregar o fluxo de pedidos.", targetDate: addDays(startDate, 30),
      itemIdsOrKeys: [reopenedPbi.id, deliveredPbi.id], reason: "Aprovar o escopo inicial.",
    }).value;

    const firstSprint = createSprintDraft(database, {
      projectId, principalId, requestId: requestId("sprint-draft"), sprintKey: "PAY-S1",
      title: "Sprint com escopo revisado", goal: "Validar a reconstrução do histórico.",
      startsOn: startDate, endsOn: endDate, itemIdsOrKeys: [reopenedPbi.id, deliveredPbi.id],
      reason: "Planejar os dois PBIs.",
    }).value;
    const startedFirstSprint = startSprint(database, {
      projectId, principalId, requestId: requestId("sprint-start"), sprintIdOrKey: firstSprint.id,
      expectedVersion: firstSprint.version, reason: "Iniciar a execução.",
    }).value;

    markDone(reopenedPbi);
    transition(reopenedPbi.id, "in_progress");
    const currentEstimate = getWorkItem(database, projectId, principalId, deliveredPbi.id);
    const proposal = proposeWorkItemEstimate(database, {
      projectId, principalId, requestId: requestId("reestimate"), itemIdOrKey: deliveredPbi.id,
      unit: "points", value: 8, rationale: "A decomposição revelou trabalho adicional.",
      expectedVersion: currentEstimate.version,
    }).value;
    const proposedEstimate = getWorkItem(database, projectId, principalId, deliveredPbi.id);
    confirmWorkItemEstimate(database, {
      projectId, principalId, requestId: requestId("reestimate-confirm"), itemIdOrKey: deliveredPbi.id,
      proposalId: proposal.id, expectedVersion: proposedEstimate.version,
    });
    const afterRemoval = changeSprintScope(database, {
      projectId, principalId, requestId: requestId("sprint-remove"), sprintIdOrKey: firstSprint.id,
      expectedVersion: startedFirstSprint.version, removeItemIdsOrKeys: [reopenedPbi.id, deliveredPbi.id],
      reason: "Retirar os dois PBIs para refletir a mudança do plano.",
    }).value;
    const closedFirstSprint = closeSprint(database, {
      projectId, principalId, requestId: requestId("sprint-close-zero"), sprintIdOrKey: firstSprint.id,
      expectedVersion: afterRemoval.version, acceptedItemIds: [],
      reviewSummary: "Nenhum item permaneceu no escopo aceito.", reason: "Fechar a sprint sem entregas.",
    }).value;
    assert.equal(closedFirstSprint.status, "closed");

    const secondSprint = createSprintDraft(database, {
      projectId, principalId, requestId: requestId("sprint2-draft"), sprintKey: "PAY-S2",
      title: "Sprint de entrega", goal: "Concluir o item reestimado.",
      startsOn: startDate, endsOn: endDate, itemIdsOrKeys: [deliveredPbi.id], reason: "Planejar a entrega.",
    }).value;
    const startedSecondSprint = startSprint(database, {
      projectId, principalId, requestId: requestId("sprint2-start"), sprintIdOrKey: secondSprint.id,
      expectedVersion: secondSprint.version, reason: "Iniciar a segunda sprint.",
    }).value;
    markDone(deliveredPbi);
    const closedSecondSprint = closeSprint(database, {
      projectId, principalId, requestId: requestId("sprint2-close"), sprintIdOrKey: secondSprint.id,
      expectedVersion: startedSecondSprint.version, acceptedItemIds: [deliveredPbi.id],
      reviewSummary: "A história foi aceita pela pessoa PO.", reason: "Aceitar a entrega concluída.",
    }).value;
    assert.equal(closedSecondSprint.status, "closed");

    const burndown = getSprintDeliveryMetrics(database, {
      projectId, principalId, sprintIdOrKey: firstSprint.id, asOfDate: startDate,
    });
    assert.equal(burndown.asOfDate, startDate);
    assert.ok(burndown.watermarkSequence > 0);
    assert.equal(burndown.plannedScopePoints, 8);
    assert.equal(burndown.series.length, 1);
    const totalWorkdays = workdaysInclusive(startDate, endDate);
    const elapsedWorkdays = isWorkday(startDate) ? 1 : 0;
    assert.equal(
      burndown.series[0]?.idealRemainingPoints,
      Math.round(8 * Math.max(0, totalWorkdays - elapsedWorkdays) / totalWorkdays * 100) / 100,
    );
    assert.deepEqual({
      scope: burndown.series[0]?.scopePoints,
      remaining: burndown.series[0]?.remainingPoints,
      completed: burndown.series[0]?.completedPoints,
      added: burndown.series[0]?.addedPoints,
      removed: burndown.series[0]?.removedPoints,
      reestimated: burndown.series[0]?.reestimatedPoints,
      deliveryEvents: burndown.series[0]?.deliveryEventsPoints,
      reopened: burndown.series[0]?.reopenedPoints,
      reopenedCount: burndown.series[0]?.reopenedItemCount,
    }, {
      scope: 0, remaining: 0, completed: 0, added: 8, removed: 11, reestimated: 3,
      deliveryEvents: 3, reopened: 3, reopenedCount: 1,
    });
    const beforeSprint = getSprintDeliveryMetrics(database, {
      projectId, principalId, sprintIdOrKey: firstSprint.id, asOfDate: addDays(startDate, -1),
    });
    assert.deepEqual(beforeSprint.series, []);
    assert.throws(() => getSprintDeliveryMetrics(database, {
      projectId, principalId, sprintIdOrKey: firstSprint.id, asOfDate: "2026-02-30",
    }), /valid calendar date/u);

    const burnup = getMilestoneBurnupMetrics(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: startDate,
    });
    assert.ok(burnup.watermarkSequence > 0);
    assert.equal(burnup.series.at(-1)?.scopePoints, 11);
    assert.equal(burnup.series.at(-1)?.completedPoints, 8);
    assert.equal(burnup.series.at(-1)?.remainingPoints, 3);
    assert.equal(burnup.items.reduce((total, item) => total + item.points, 0), burnup.series.at(-1)?.scopePoints);
    assert.equal(burnup.items.filter((item) => item.state === "done")
      .reduce((total, item) => total + item.points, 0), burnup.series.at(-1)?.completedPoints);
    assert.equal(burnup.items.filter((item) => !["done", "cancelled"].includes(item.state))
      .reduce((total, item) => total + item.points, 0), burnup.series.at(-1)?.remainingPoints);
    assert.deepEqual(burnup.items.map((item) => [item.itemId, item.state, item.points]), [
      [reopenedPbi.id, "in_progress", 3], [deliveredPbi.id, "done", 8],
    ]);

    const velocity = getProjectVelocityMetrics(database, { projectId, principalId });
    assert.equal(velocity.sampleSize, 2);
    assert.ok(velocity.watermarkSequence > 0);
    assert.deepEqual(velocity.sprints.map((sprint) => [sprint.sprintKey, sprint.deliveredPoints, sprint.acceptedPbiCount]), [
      ["PAY-S1", 0, 0], ["PAY-S2", 8, 1],
    ]);
    const teamId = velocity.sprints[0]?.teamId;
    assert.ok(teamId);
    assert.ok(velocity.sprints.every((sprint) => sprint.teamId === teamId));
    assert.deepEqual(velocity.byTeamGeneration.map((generation) => [generation.teamId, generation.generationNumber, generation.sprintCount]), [[teamId, 1, 2]]);

    const historicalDashboard = getProjectDashboardMetrics(database, {
      projectId, principalId, asOfDate: addDays(startDate, -1), milestoneId: "none", sprintId: "none",
    });
    assert.equal(historicalDashboard.selectedTeamGenerationNumber, null);
    assert.equal(historicalDashboard.velocity.sampleSize, 0);

    setTeamCapacityConfiguration(database, {
      projectId, principalId, teamId, requestId: requestId("capacity-generation-change"), expectedVersion: 1,
      teamName: "Payments team", timezone: "America/Sao_Paulo", hoursPerDay: 6, workingDays: [1, 2, 3, 4, 5],
      members: [{ principalId, dedicationPercent: 90 }], reason: "Separar a velocidade após mudança de capacidade do time.",
    });
    const currentGenerationDashboard = getProjectDashboardMetrics(database, {
      projectId, principalId, asOfDate: startDate, milestoneId: "none", sprintId: "none",
    });
    assert.equal(currentGenerationDashboard.selectedTeamGenerationNumber, 2);
    assert.equal(currentGenerationDashboard.velocity.sampleSize, 0);

    const wip = getProjectWipMetrics(database, { projectId, principalId });
    assert.ok(wip.watermarkSequence > 0);
    assert.equal(wip.totalWipCount, 1);
    assert.equal(wip.countsByState.in_progress, 1);
    assert.equal(wip.items[0]?.itemId, reopenedPbi.id);
    assert.equal(wip.items[0]?.ageDays, 0);

    const coverage = getProjectCoverageMetrics(database, { projectId, principalId });
    assert.ok(coverage.watermarkSequence > 0);
    assert.equal(coverage.requiredCriteria, 2);
    assert.equal(coverage.coveredRequiredCriteria, 2);
    assert.equal(coverage.certifiedRequiredCriteria, 2);
    assert.equal(coverage.coveragePercent, 100);
    assert.equal(coverage.certifiedCoveragePercent, 100);
    assert.equal(coverage.itemsTotal, 2);
    assert.equal(coverage.itemsTruncated, false);
    const buildCoverage = getProjectCoverageMetrics(database, {
      projectId, principalId, buildId: `metrics-build-${deliveredPbi.id}`,
    });
    assert.equal(buildCoverage.coveredRequiredCriteria, 2);
    assert.equal(buildCoverage.certifiedRequiredCriteria, 1);
    assert.equal(buildCoverage.coveragePercent, 100);
    assert.equal(buildCoverage.certifiedCoveragePercent, 50);
  });

  it("enforces project access and bounded metric query sizes", () => {
    assert.throws(() => getProjectWipMetrics(database, { projectId, principalId: randomUUID() }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "FORBIDDEN");
    assert.throws(() => getProjectVelocityMetrics(database, { projectId, principalId, limit: 0 }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "VALIDATION_FAILED");
    assert.throws(() => getProjectWipMetrics(database, { projectId, principalId, itemLimit: 5_001 }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "VALIDATION_FAILED");
  });

  it("uses the project, event type, and item index for point estimate history", () => {
    const itemIds = pbis.map((item) => item.id);
    const placeholders = itemIds.map(() => "?").join(",");
    const plan = database.prepare(
      `EXPLAIN QUERY PLAN
       SELECT sequence, entity_id, occurred_at, payload_json FROM audit_events
       WHERE project_id = ? AND event_type = ? AND entity_id IN (${placeholders})
       ORDER BY entity_id, occurred_at, sequence`,
    ).all(projectId, "work_item.estimate_confirmed", ...itemIds) as Array<{ detail: string }>;
    assert.ok(plan.some((entry) => entry.detail.includes("audit_events_by_project_type_entity_time")), JSON.stringify(plan));
  });

  it("limits coverage details while preserving totals for the whole project", () => {
    for (let index = 0; index < 19; index += 1) {
      createWorkItem(database, {
        projectId,
        principalId,
        requestId: requestId(`coverage-preview-${index}`),
        type: "story",
        parentId: featureId,
        title: `PBI de preview ${index + 1}`,
      });
    }

    const coverage = getProjectCoverageMetrics(database, { projectId, principalId });
    assert.equal(coverage.itemsTotal, 21);
    assert.equal(coverage.items.length, 20);
    assert.equal(coverage.itemsTruncated, true);
    assert.equal(coverage.pinnedPbiCount, 2);
    assert.equal(coverage.previewPbiCount, 19);
    assert.equal(coverage.requiredCriteria, 2);
  });

  it("invalidates cached dashboard metrics when an audited project change advances the watermark", () => {
    const input = { projectId, principalId, milestoneId: "none", sprintId: "none" };
    const first = getProjectDashboardMetrics(database, input);
    assert.equal(first.coverage.itemsTotal, 2);
    const cachedCopy = getProjectDashboardMetrics(database, input);
    (cachedCopy.coverage.items as unknown as unknown[]).pop();
    assert.equal(getProjectDashboardMetrics(database, input).coverage.items.length, 2);

    const addedPbi = createWorkItem(database, {
      projectId,
      principalId,
      requestId: requestId("dashboard-cache-invalidation"),
      type: "story",
      parentId: featureId,
      title: "Novo PBI após a primeira leitura",
    }).value;

    const refreshed = getProjectDashboardMetrics(database, input);
    assert.ok(refreshed.watermarkSequence > first.watermarkSequence);
    assert.equal(refreshed.coverage.itemsTotal, 3);
    assert.ok(refreshed.coverage.items.some((item) => item.itemId === addedPbi.id));
  });

  function createReadyPbi(title: string, points: number, sequence: number): { id: string; key: string; scenarioId: string } {
    const pbi = createWorkItem(database, {
      projectId, principalId, requestId: requestId("story"), type: "story", parentId: featureId,
      title, description: `${title} para o cliente.`, criteria: [{ description: `${title} funciona conforme esperado.` }],
    }).value;
    const scenario = createScenario(database, {
      projectId, principalId, requestId: requestId("scenario"), key: `PAY-TC-${sequence}`,
      kind: "acceptance", title: `Validar ${title}`,
      steps: [{ action: title, expected: "A operação conclui com sucesso." }],
      coverage: [{ targetType: "criterion", reference: pbi.criteria[0]!.id }],
    }).value;
    publishScenarioRevision(database, {
      projectId, principalId, requestId: requestId("scenario-publish"),
      scenarioIdOrKey: scenario.scenarioId, revisionNumber: 1, expectedVersion: 1,
    });
    const proposal = proposeWorkItemEstimate(database, {
      projectId, principalId, requestId: requestId("estimate"), itemIdOrKey: pbi.id,
      unit: "points", value: points, rationale: "Estimativa inicial da equipe.", expectedVersion: pbi.version,
    }).value;
    const proposed = getWorkItem(database, projectId, principalId, pbi.id);
    confirmWorkItemEstimate(database, {
      projectId, principalId, requestId: requestId("estimate-confirm"), itemIdOrKey: pbi.id,
      proposalId: proposal.id, expectedVersion: proposed.version,
    });
    const current = getWorkItem(database, projectId, principalId, pbi.id);
    transitionWorkItem(database, {
      projectId, principalId, requestId: requestId("ready"), itemIdOrKey: pbi.id,
      targetState: "ready", expectedVersion: current.version, reason: "PBI aprovado para planejamento.",
    });
    return { id: pbi.id, key: pbi.key, scenarioId: scenario.scenarioId };
  }

  function markDone(pbi: { id: string; scenarioId: string }): void {
    transition(pbi.id, "in_progress");
    transition(pbi.id, "in_review");
    transition(pbi.id, "in_validation");
    const buildId = `metrics-build-${pbi.id}`;
    addWorkItemEvidence(database, {
      projectId, principalId, requestId: requestId("build-evidence"), itemIdOrKey: pbi.id,
      kind: "build", uri: `https://ci.example/builds/${buildId}`, buildId,
      description: "Build candidato validado.",
    });
    const run = recordTestRun(database, {
      projectId, principalId, requestId: requestId("test-run"), scenarioIdOrKey: pbi.scenarioId,
      revisionNumber: 1, buildId, result: "passed",
    }).value;
    const beforeCertification = getWorkItem(database, projectId, principalId, pbi.id);
    certifyTestRun(database, {
      projectId, principalId, requestId: requestId("qa-certification"), itemIdOrKey: pbi.id,
      runId: run.id, expectedVersion: beforeCertification.version, reason: "QA certificou a execução.",
    });
    transition(pbi.id, "done", buildId);
  }

  function transition(itemIdOrKey: string, targetState: WorkItemState, buildId?: string): void {
    const current = getWorkItem(database, projectId, principalId, itemIdOrKey);
    transitionWorkItem(database, {
      projectId, principalId, requestId: requestId(`transition-${targetState}`), itemIdOrKey,
      targetState, expectedVersion: current.version, reason: `Avançar para ${targetState}.`,
      ...(buildId === undefined ? {} : { buildId }),
    });
  }
});

function projectToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year")!.value}-${parts.find((part) => part.type === "month")!.value}-${parts.find((part) => part.type === "day")!.value}`;
}

function addDays(date: string, amount: number): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + amount);
  return result.toISOString().slice(0, 10);
}

function workdaysInclusive(startDate: string, endDate: string): number {
  let workdays = 0;
  const current = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (current <= end) {
    if (isWorkday(current.toISOString().slice(0, 10))) workdays += 1;
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return workdays;
}

function isWorkday(date: string): boolean {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

function requestId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
