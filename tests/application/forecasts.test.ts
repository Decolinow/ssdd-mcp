import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { setDefinitionOfDone } from "../../src/application/definition-of-done.js";
import { forecastMilestoneDelivery, listMilestoneForecastHistory, recalculateMilestoneForecast } from "../../src/application/forecast-queries.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createMilestone } from "../../src/application/milestones.js";
import { createScenario, publishScenarioRevision, recordTestRun } from "../../src/application/scenario-commands.js";
import { createSprintDraft, startSprint } from "../../src/application/sprint-commands.js";
import { setTeamCapacityConfiguration } from "../../src/application/team-capacity.js";
import { addTraceLink, removeTraceLink } from "../../src/application/trace-commands.js";
import { confirmWorkItemEstimate, proposeWorkItemEstimate } from "../../src/application/work-item-commands.js";
import { getWorkItem } from "../../src/application/work-item-queries.js";
import { addWorkItemEvidence, certifyTestRun, transitionWorkItem } from "../../src/application/work-item-workflow.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import type { WorkItemState } from "../../src/domain/work-items.js";

describe("milestone delivery forecasts", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let featureId: string;
  let targetPbi: { id: string; key: string; scenarioId: string };

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-forecast-"));
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
      projectId, principalId, requestId: requestId("capacity"), expectedVersion: 0,
      teamName: "Payments team", timezone: "America/Sao_Paulo", hoursPerDay: 10,
      workingDays: [1, 2, 3, 4, 5], members: [{ principalId, dedicationPercent: 100 }],
      reason: "Configuração para a previsão de entrega.",
    });
    setDefinitionOfDone(database, {
      projectId, principalId, requestId: requestId("dod"), expectedVersion: 0,
      criteria: [{ description: "Critérios de entrega aceitos." }], reason: "Definition of Done inicial.",
    });
    targetPbi = createReadyPbi("Concluir pagamentos", 30, 1);
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("runs a seeded Monte Carlo from same-generation sprint outcomes and post-cut capacity", () => {
    const today = projectToday();
    seedClosedSprint("PAY-H1", 10, 1);
    seedClosedSprint("PAY-H2", 15, 2);
    seedClosedSprint("PAY-H3", 20, 3);
    const milestone = createForecastMilestone();
    const futureSprint = createSprintDraft(database, {
      projectId, principalId, requestId: requestId("planned-sprint"), sprintKey: "PAY-FUTURE",
      title: "Sprint planejada", goal: "Reservar capacidade futura.", startsOn: addDays(today, 5),
      endsOn: addDays(today, 14), itemIdsOrKeys: [targetPbi.id], reason: "Planejar capacidade posterior ao corte.",
    }).value;

    const forecast = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: today,
    });
    assert.equal(forecast.status, "forecast_ready");
    assert.equal(forecast.remainingPoints, 30);
    assert.equal(forecast.teamGenerationNumber, 1);
    assert.equal(forecast.sample.length, 3);
    assert.equal(forecast.algorithmVersion, "2.0.0");
    assert.equal(forecast.simulationCount, 10_000);
    assert.ok(Number.isSafeInteger(forecast.seed));
    assert.equal(forecast.typicalSprintDurationCalendarDays, 6);
    assert.deepEqual(forecast.sample.map((sample) => sample.deliveredPoints), [10, 15, 20]);
    assert.ok(forecast.sample.every((sample) => !Object.hasOwn(sample, "pointsPerHour")));
    assert.deepEqual(forecast.scenarios.map((scenario) => [scenario.key, scenario.percentile]), [
      ["cautious", 75], ["base", 50], ["favorable", 25],
    ]);
    const [favorable, base, cautious] = forecast.scenarios.slice().reverse();
    assert.ok(favorable?.estimatedDate && base?.estimatedDate && cautious?.estimatedDate);
    assert.ok(favorable.estimatedDate <= base.estimatedDate);
    assert.ok(base.estimatedDate <= cautious.estimatedDate);
    assert.ok(forecast.probabilityOnTime !== null && forecast.probabilityOnTime > 0.99);
    assert.equal(forecast.targetDateWithinHorizon, true);
    assert.ok(forecast.capacityBases.some((basis) =>
      basis.source === "planned_sprint_configuration" && basis.sprintId === futureSprint.id));
    assert.ok(forecast.capacityBases.some((basis) => basis.source === "team_configuration_assumption"));
    assert.equal(forecast.capacityStartDate, addDays(today, 1));
    assert.equal(forecast.capacityEndDate, addDays(today, 365));

    const repeated = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: today,
    });
    assert.deepEqual(repeated, forecast);
    const history = listMilestoneForecastHistory(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id,
    });
    assert.equal(history.length, 1);
    assert.equal(history[0]?.calculationInput.capacityDays.length, 365);
    const savedInput = history[0]?.calculationInput;
    assert.ok(savedInput !== undefined && "seed" in savedInput);
    assert.equal(savedInput.seed, forecast.seed);
    assert.equal(savedInput.simulationCount, forecast.simulationCount);
    const recalculated = recalculateMilestoneForecast(database, {
      projectId, principalId, forecastId: forecast.forecastId,
    });
    assert.deepEqual(recalculated.scenarios, forecast.scenarios);
    assert.deepEqual(recalculated.percentiles, forecast.percentiles);
    assert.equal(recalculated.probabilityOnTime, forecast.probabilityOnTime);
    assert.equal(recalculated.seed, forecast.seed);
    assert.throws(
      () => database.prepare("UPDATE milestone_forecast_snapshots SET snapshot_json = '{}' WHERE forecast_id = ?")
        .run(forecast.forecastId),
      /immutable/u,
    );
    assert.throws(
      () => database.prepare("DELETE FROM milestone_forecast_snapshots WHERE forecast_id = ?").run(forecast.forecastId),
      /immutable/u,
    );
  });

  it("keeps forecasts and history isolated for a selected team without capacity yet", () => {
    const milestone = createForecastMilestone();
    const primaryTeamId = (database.prepare(
      "SELECT team_id FROM teams WHERE project_id = ? AND current_version > 0",
    ).get(projectId) as { team_id: string }).team_id;
    const unconfiguredTeamId = randomUUID();
    database.prepare(
      `INSERT INTO teams (team_id, project_id, current_version, current_generation, created_at)
       VALUES (?, ?, 0, 0, ?)`,
    ).run(unconfiguredTeamId, projectId, new Date().toISOString());

    const configuredForecast = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, teamId: primaryTeamId, asOfDate: projectToday(),
    });
    const unconfiguredForecast = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, teamId: unconfiguredTeamId, asOfDate: projectToday(),
    });

    assert.equal(configuredForecast.teamId, primaryTeamId);
    assert.equal(unconfiguredForecast.teamId, unconfiguredTeamId);
    assert.equal(unconfiguredForecast.teamGenerationNumber, null);
    assert.equal(listMilestoneForecastHistory(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, teamId: primaryTeamId,
    }).length, 1);
    assert.equal(listMilestoneForecastHistory(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, teamId: unconfiguredTeamId,
    }).length, 1);
    assert.equal((database.prepare(
      "SELECT COUNT(DISTINCT team_id) AS count FROM milestone_forecast_snapshots WHERE milestone_id = ?",
    ).get(milestone.id) as { count: number }).count, 2);
  });

  it("can still recalculate an immutable version 1 forecast snapshot", () => {
    seedClosedSprint("PAY-H1", 10, 1);
    seedClosedSprint("PAY-H2", 15, 2);
    seedClosedSprint("PAY-H3", 20, 3);
    const milestone = createForecastMilestone();
    const forecast = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: projectToday(),
    });
    const history = listMilestoneForecastHistory(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id,
    });
    const currentInput = history[0]?.calculationInput;
    assert.ok(currentInput !== undefined && "seed" in currentInput);
    const legacyInput = {
      asOfDate: currentInput.asOfDate,
      targetDate: currentInput.targetDate,
      remainingPoints: currentInput.remainingPoints,
      unestimatedPbiCount: currentInput.unestimatedPbiCount,
      sample: forecast.sample.map((sample) => ({
        sprintId: sample.sprintId,
        sprintKey: sample.sprintKey,
        closedAt: sample.closedAt,
        deliveredPoints: sample.deliveredPoints,
        capacityHours: sample.capacityHours,
        pointsPerHour: sample.deliveredPoints / sample.capacityHours,
      })),
      capacityDays: currentInput.capacityDays,
      blockers: currentInput.blockers,
    };
    const legacyForecastId = randomUUID();
    database.prepare(
      `INSERT INTO milestone_forecast_snapshots
        (forecast_id, project_id, milestone_id, team_id, algorithm_version, as_of_date, watermark_sequence,
         calculated_at, snapshot_json, calculation_input_json)
       VALUES (?, ?, ?, ?, '1.0.0', ?, ?, ?, ?, ?)`,
    ).run(
      legacyForecastId, projectId, milestone.id, forecast.teamId, forecast.asOfDate,
      forecast.watermarkSequence, new Date().toISOString(),
      JSON.stringify({ forecastId: legacyForecastId, algorithmVersion: "1.0.0" }),
      JSON.stringify(legacyInput),
    );

    const recalculated = recalculateMilestoneForecast(database, {
      projectId, principalId, forecastId: legacyForecastId,
    });
    assert.equal(recalculated.algorithmVersion, "1.0.0");
    assert.equal(recalculated.seed, null);
    assert.equal(recalculated.simulationCount, null);
    assert.equal(recalculated.scenarios[0]?.estimatedDate, dateAfterWorkdays(forecast.asOfDate, 24));
  });

  it("includes zero-delivery sprints in the empirical distribution", () => {
    seedClosedSprint("PAY-Z1", 0, 1);
    seedClosedSprint("PAY-Z2", 0, 2);
    seedClosedSprint("PAY-Z3", 20, 3);
    const milestone = createForecastMilestone();
    const forecast = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: projectToday(),
    });
    assert.equal(forecast.sample.length, 3);
    assert.deepEqual(forecast.sample.map((sample) => sample.deliveredPoints), [0, 0, 20]);
    assert.equal(forecast.status, "forecast_ready");
    assert.ok(forecast.probabilityOnTime !== null && forecast.probabilityOnTime > 0 && forecast.probabilityOnTime < 1);
    assert.ok(forecast.scenarios.every((scenario) => scenario.status === "forecast_ready"));
    assert.ok(forecast.scenarios[2]!.estimatedDate! <= forecast.scenarios[1]!.estimatedDate!);
    assert.ok(forecast.scenarios[1]!.estimatedDate! <= forecast.scenarios[0]!.estimatedDate!);
  });

  it("moves the same seeded trials later when future team capacity is reduced", () => {
    seedClosedSprint("PAY-H1", 10, 1);
    seedClosedSprint("PAY-H2", 15, 2);
    seedClosedSprint("PAY-H3", 20, 3);
    const milestone = createForecastMilestone();
    const initial = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: projectToday(),
    });
    setTeamCapacityConfiguration(database, {
      projectId, principalId, requestId: requestId("reduced-capacity"), expectedVersion: 1,
      teamName: "Payments team", timezone: "America/Sao_Paulo", hoursPerDay: 5,
      workingDays: [1, 2, 3, 4, 5], members: [{ principalId, dedicationPercent: 100 }],
      reason: "Reduzir a capacidade futura sem alterar a composição do time.",
    });
    const reduced = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: projectToday(),
    });
    assert.equal(reduced.seed, initial.seed);
    assert.ok(reduced.probabilityOnTime! <= initial.probabilityOnTime!);
    for (let index = 0; index < initial.scenarios.length; index += 1) {
      const before = initial.scenarios[index]!.estimatedDate;
      const after = reduced.scenarios[index]!.estimatedDate;
      assert.ok(before !== null && after !== null && after >= before);
    }
  });

  it("reports zero velocity when every empirical sprint delivered zero points", () => {
    seedClosedSprint("PAY-Z1", 0, 1);
    seedClosedSprint("PAY-Z2", 0, 2);
    seedClosedSprint("PAY-Z3", 0, 3);
    const milestone = createForecastMilestone();
    const forecast = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: projectToday(),
    });
    assert.equal(forecast.status, "zero_velocity");
    assert.equal(forecast.probabilityOnTime, 0);
    assert.ok(forecast.scenarios.every((scenario) => scenario.status === "zero_velocity" && scenario.estimatedDate === null));
  });

  it("reports no_capacity when comparable velocity exists but all future working days are unavailable", () => {
    seedClosedSprint("PAY-H1", 10, 1);
    seedClosedSprint("PAY-H2", 15, 2);
    seedClosedSprint("PAY-H3", 20, 3);
    const today = projectToday();
    const absences = Array.from({ length: 365 }, (_, index) => addDays(today, index + 1))
      .filter((date) => {
        const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
        return weekday >= 1 && weekday <= 5;
      })
      .map((date) => ({ principalId, date, hours: 10, reason: "Indisponibilidade registrada para a fixture." }));
    setTeamCapacityConfiguration(database, {
      projectId, principalId, requestId: requestId("no-capacity"), expectedVersion: 1,
      teamName: "Payments team", timezone: "America/Sao_Paulo", hoursPerDay: 10,
      workingDays: [1, 2, 3, 4, 5], members: [{ principalId, dedicationPercent: 100 }], absences,
      reason: "Registrar indisponibilidade para todo o horizonte de previsão.",
    });
    const milestone = createForecastMilestone();
    const forecast = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: today,
    });
    assert.equal(forecast.sample.length, 3);
    assert.equal(forecast.status, "no_capacity");
    assert.equal(forecast.probabilityOnTime, null);
    assert.ok(forecast.scenarios.every((scenario) => scenario.status === "no_capacity" && scenario.estimatedDate === null));
  });

  it("recomputes a new immutable snapshot after a confirmed point re-estimate", () => {
    seedClosedSprint("PAY-H1", 10, 1);
    seedClosedSprint("PAY-H2", 15, 2);
    seedClosedSprint("PAY-H3", 20, 3);
    const milestone = createForecastMilestone();
    const initial = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: projectToday(),
    });
    const current = getWorkItem(database, projectId, principalId, targetPbi.id);
    const proposal = proposeWorkItemEstimate(database, {
      projectId, principalId, requestId: requestId("forecast-reestimate"), itemIdOrKey: targetPbi.id,
      unit: "points", value: 32, rationale: "O refinamento acrescentou dois pontos.",
      expectedVersion: current.version,
    }).value;
    const proposed = getWorkItem(database, projectId, principalId, targetPbi.id);
    confirmWorkItemEstimate(database, {
      projectId, principalId, requestId: requestId("forecast-reestimate-confirm"), itemIdOrKey: targetPbi.id,
      proposalId: proposal.id, expectedVersion: proposed.version,
    });
    const revised = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: projectToday(),
    });
    assert.equal(revised.remainingPoints, 32);
    assert.notEqual(revised.watermarkSequence, initial.watermarkSequence);
    assert.notEqual(revised.forecastId, initial.forecastId);
    assert.equal(revised.remainingPoints, 32);
    assert.equal(listMilestoneForecastHistory(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id,
    }).length, 2);
    const old = recalculateMilestoneForecast(database, {
      projectId, principalId, forecastId: initial.forecastId,
    });
    assert.deepEqual(old.scenarios, initial.scenarios);
    assert.equal(old.seed, initial.seed);
  });

  it("marks unresolved out-of-scope dependencies as blockers and versions each changed snapshot", () => {
    seedClosedSprint("PAY-H1", 10, 1);
    seedClosedSprint("PAY-H2", 15, 2);
    seedClosedSprint("PAY-H3", 20, 3);
    const milestone = createForecastMilestone();
    const initial = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: projectToday(),
    });
    const dependency = createReadyPbi("Dependência externa", 2, 2);
    const link = addTraceLink(database, {
      projectId, principalId, requestId: requestId("external-dependency"),
      sourceIdOrKey: targetPbi.id, targetIdOrKey: dependency.id, type: "depends_on",
    }).value;
    const blocked = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: projectToday(),
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.probabilityOnTime, null);
    assert.equal(blocked.blockers.length, 1);
    assert.deepEqual(blocked.blockers[0], {
      kind: "external_dependency",
      itemId: targetPbi.id,
      itemKey: targetPbi.key,
      dependencyItemId: dependency.id,
      dependencyItemKey: dependency.key,
      dependencyState: "ready",
      resolutionDate: null,
    });
    assert.ok(blocked.scenarios.every((scenario) => scenario.status === "blocked" && scenario.estimatedDate === null));
    assert.notEqual(blocked.forecastId, initial.forecastId);

    removeTraceLink(database, {
      projectId, principalId, requestId: requestId("resolve-dependency"), linkId: link.id,
    });
    const unblocked = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: projectToday(),
    });
    assert.equal(unblocked.status, "forecast_ready");
    assert.equal(unblocked.blockers.length, 0);
    assert.equal(listMilestoneForecastHistory(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id,
    }).length, 3);
    const oldRecalculation = recalculateMilestoneForecast(database, {
      projectId, principalId, forecastId: blocked.forecastId,
    });
    assert.equal(oldRecalculation.status, "blocked");
    assert.ok(oldRecalculation.scenarios.every((scenario) => scenario.estimatedDate === null));
  });

  it("returns insufficient_data until three comparable closed sprints exist and rejects future cuts", () => {
    const milestone = createForecastMilestone();
    const insufficient = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id,
    });
    assert.equal(insufficient.status, "insufficient_data");
    assert.equal(insufficient.sample.length, 0);
    assert.ok(insufficient.scenarios.every((scenario) => scenario.status === "insufficient_data"));
    assert.throws(() => forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: addDays(projectToday(), 1),
    }), /cannot be in the future/u);
  });

  it("does not mix velocity from an earlier team generation into the current sample", () => {
    seedClosedSprint("PAY-H1", 10, 1);
    seedClosedSprint("PAY-H2", 15, 2);
    seedClosedSprint("PAY-H3", 20, 3);
    const milestone = createForecastMilestone();
    setTeamCapacityConfiguration(database, {
      projectId, principalId, requestId: requestId("new-team-generation"), expectedVersion: 1,
      teamName: "Payments team", timezone: "America/Sao_Paulo", hoursPerDay: 10,
      workingDays: [1, 2, 3, 4, 5], members: [{ principalId, dedicationPercent: 80 }],
      reason: "A composição do time mudou materialmente.",
    });
    const forecast = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: projectToday(),
    });
    assert.equal(forecast.teamGenerationNumber, 2);
    assert.equal(forecast.sample.length, 0);
    assert.equal(forecast.status, "insufficient_data");
  });

  it("filters the local cutoff before limiting comparable velocity samples", () => {
    seedClosedSprint("PAY-H1", 10, 1);
    seedClosedSprint("PAY-H2", 15, 2);
    seedClosedSprint("PAY-H3", 20, 3);
    const today = projectToday();
    const afterCutoff = `${addDays(today, 2)}T12:00:00.000Z`;
    for (let index = 0; index < 51; index += 1) {
      seedClosedSprint(`PAY-FUTURE-${index.toString().padStart(2, "0")}`, 0, 100 + index, afterCutoff);
    }
    const milestone = createForecastMilestone();
    const forecast = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: today,
    });
    assert.equal(forecast.sample.length, 3);
    assert.deepEqual(forecast.sample.map((sample) => sample.deliveredPoints), [10, 15, 20]);
    assert.equal(forecast.status, "forecast_ready");
  });

  it("reports zero probability when the target date is before simulated completion", () => {
    seedClosedSprint("PAY-H1", 10, 1);
    seedClosedSprint("PAY-H2", 15, 2);
    seedClosedSprint("PAY-H3", 20, 3);
    const today = projectToday();
    const milestone = createForecastMilestone(1);
    const forecast = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: today,
    });
    assert.equal(forecast.targetDateWithinHorizon, true);
    assert.equal(forecast.probabilityOnTime, 0);
    assert.ok(forecast.scenarios.every((scenario) => scenario.estimatedDate! > milestone.targetDate));
    const laterTarget = createForecastMilestone(40);
    const laterForecast = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: laterTarget.id, asOfDate: today,
    });
    assert.equal(laterForecast.seed, forecast.seed);
    assert.deepEqual(laterForecast.percentiles, forecast.percentiles);
    assert.ok(laterForecast.probabilityOnTime! > forecast.probabilityOnTime!);
  });

  it("does not claim a target-date probability beyond the simulated horizon", () => {
    seedClosedSprint("PAY-H1", 10, 1);
    seedClosedSprint("PAY-H2", 15, 2);
    seedClosedSprint("PAY-H3", 20, 3);
    const milestone = createForecastMilestone(400);
    const forecast = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: projectToday(),
    });
    assert.equal(forecast.targetDateWithinHorizon, false);
    assert.equal(forecast.probabilityOnTime, null);
    assert.ok(forecast.scenarios.every((scenario) => scenario.onTime === true));
  });

  it("uses the active sprint capacity snapshot for dates after the cutoff", () => {
    seedClosedSprint("PAY-H1", 10, 1);
    seedClosedSprint("PAY-H2", 15, 2);
    seedClosedSprint("PAY-H3", 20, 3);
    const today = projectToday();
    const milestone = createForecastMilestone();
    const draft = createSprintDraft(database, {
      projectId, principalId, requestId: requestId("active-draft"), sprintKey: "PAY-ACTIVE",
      title: "Sprint ativa", goal: "Usar capacidade congelada.", startsOn: today, endsOn: addDays(today, 10),
      itemIdsOrKeys: [targetPbi.id], reason: "Preparar a sprint corrente.",
    }).value;
    startSprint(database, {
      projectId, principalId, requestId: requestId("active-start"), sprintIdOrKey: draft.id,
      expectedVersion: draft.version, reason: "Iniciar sprint para previsão.",
    });
    const forecast = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: today,
    });
    assert.ok(forecast.capacityBases.some((basis) =>
      basis.source === "active_sprint_snapshot" && basis.sprintId === draft.id));
    assert.ok(forecast.scenarios.every((scenario) => scenario.estimatedDate !== null));
  });

  it("returns complete with a same-day date when the milestone has no open PBIs", () => {
    const milestone = createForecastMilestone();
    markDone(targetPbi);
    const forecast = forecastMilestoneDelivery(database, {
      projectId, principalId, milestoneIdOrKey: milestone.id, asOfDate: projectToday(),
    });
    assert.equal(forecast.status, "complete");
    assert.equal(forecast.remainingPoints, 0);
    assert.equal(forecast.openPbiCount, 0);
    assert.equal(forecast.probabilityOnTime, 1);
    assert.ok(forecast.scenarios.every((scenario) =>
      scenario.status === "complete" && scenario.estimatedDate === forecast.asOfDate));
  });

  function createForecastMilestone(targetOffsetDays = 40) {
    return createMilestone(database, {
      projectId, principalId, requestId: requestId("milestone"), milestoneKey: `PAY-${randomUUID().slice(0, 8)}`,
      title: "Entrega prevista", goal: "Calcular cenários de entrega.", targetDate: addDays(projectToday(), targetOffsetDays),
      itemIdsOrKeys: [targetPbi.id], reason: "Aprovar o escopo da previsão.",
    }).value;
  }

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

  function seedClosedSprint(sprintKey: string, deliveredPoints: number, sequence: number, closedAt?: string): void {
    const teamId = (database.prepare("SELECT team_id FROM teams WHERE project_id = ?")
      .get(projectId) as { team_id: string }).team_id;
    const now = new Date().toISOString();
    const acceptedItems = deliveredPoints === 0
      ? []
      : [{ itemId: randomUUID(), points: deliveredPoints }];
    database.prepare(
      `INSERT INTO sprints
        (sprint_id, project_id, sprint_key, title, goal, starts_on, ends_on, status, team_id,
         capacity_config_version, dod_revision_number, version, created_by_principal_id,
         created_at, started_at, closed_at, reason, review_summary, started_snapshot_json, closed_snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'closed', ?, 1, 1, 3, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), projectId, sprintKey, `Historical ${sprintKey}`, "Forecast sample",
      addDays(projectToday(), -20 - sequence * 10), addDays(projectToday(), -15 - sequence * 10),
      teamId, principalId, now, now, closedAt ?? now, "Historical fixture", "Synthetic accepted sample",
      JSON.stringify({ capacity: { totalHours: 100 }, commitments: [] }),
      JSON.stringify({ acceptedItems }),
    );
  }

  function markDone(pbi: { id: string; scenarioId: string }): void {
    transition(pbi.id, "in_progress");
    transition(pbi.id, "in_review");
    transition(pbi.id, "in_validation");
    const buildId = `forecast-build-${pbi.id}`;
    addWorkItemEvidence(database, {
      projectId, principalId, requestId: requestId("forecast-build"), itemIdOrKey: pbi.id,
      kind: "build", uri: `https://ci.example/builds/${buildId}`, buildId,
      description: "Build candidato válido para previsão.",
    });
    const run = recordTestRun(database, {
      projectId, principalId, requestId: requestId("forecast-run"), scenarioIdOrKey: pbi.scenarioId,
      revisionNumber: 1, buildId, result: "passed",
    }).value;
    const beforeCertification = getWorkItem(database, projectId, principalId, pbi.id);
    certifyTestRun(database, {
      projectId, principalId, requestId: requestId("forecast-certification"), itemIdOrKey: pbi.id,
      runId: run.id, expectedVersion: beforeCertification.version, reason: "QA certificou a entrega.",
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

function dateAfterWorkdays(asOfDate: string, workdayCount: number): string {
  let count = 0;
  let cursor = asOfDate;
  while (count < workdayCount) {
    cursor = addDays(cursor, 1);
    const weekday = new Date(`${cursor}T00:00:00.000Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return cursor;
}

function requestId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
