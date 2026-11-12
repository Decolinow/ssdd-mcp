import { createHash, randomUUID } from "node:crypto";
import type {
  ForecastBlocker,
  ForecastCalculationInput,
  ForecastCalculationInputV1,
  ForecastCapacityBasis,
  ForecastCapacityDay,
  ForecastInternalDependencyRisk,
  ForecastScenario,
  ForecastScenarioV1,
  ForecastScenarioKey,
  ForecastStatus,
  ForecastVelocitySample,
  MilestoneForecastHistoryEntry,
  MilestoneForecastRecalculation,
  MilestoneForecastSnapshot,
  MilestoneForecastSnapshotV1,
} from "../domain/metrics.js";
import type { TeamCapacityReport } from "../domain/teams.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { getProjectVelocityMetrics } from "./metrics-queries.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { getTeamCapacity } from "./team-capacity.js";
import { resolveProjectTeamId } from "./team-directory.js";

const forecastAlgorithmVersion = "2.0.0";
const minimumSampleSize = 3;
const maxSampleSprints = 6;
const simulationCount = 10_000;
const horizonCalendarDays = 365;
const activeStates = new Set(["ready", "in_progress", "in_review", "in_validation"]);

interface MilestoneForecastRow {
  readonly milestone_id: string;
  readonly milestone_key: string;
  readonly target_date: string;
  readonly created_at: string;
}

interface ForecastScopeEventRow {
  readonly sequence: number;
  readonly item_id: string;
  readonly item_key: string;
  readonly item_title: string;
  readonly item_state: string;
  readonly action: "add" | "remove";
  readonly baseline_id: string;
  readonly item_revision_number: number;
  readonly points: number;
  readonly changed_at: string;
}

interface StateTransitionRow {
  readonly item_id: string;
  readonly from_state: string;
  readonly to_state: string;
  readonly item_version: number;
  readonly transitioned_at: string;
}

interface EstimateRow {
  readonly entity_id: string;
  readonly occurred_at: string;
  readonly sequence: number;
  readonly payload_json: string;
}

interface TeamAtCutoff {
  readonly teamId: string;
  readonly configVersion: number | null;
  readonly generationNumber: number | null;
}

interface SprintCapacityRow {
  readonly sprint_id: string;
  readonly sprint_key: string;
  readonly starts_on: string;
  readonly ends_on: string;
  readonly team_id: string;
  readonly capacity_config_version: number;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly closed_at: string | null;
  readonly cancelled_at: string | null;
  readonly started_snapshot_json: string | null;
}

interface CapacitySchedule {
  readonly startDate: string;
  readonly endDate: string;
  readonly days: readonly ForecastCapacityDay[];
  readonly bases: readonly ForecastCapacityBasis[];
  readonly totalHours: number;
}

interface ForecastSimulationWindow {
  readonly startDate: string;
  readonly endDate: string;
  readonly capacityHours: number;
}

interface ForecastAlgorithmResult {
  readonly status: ForecastStatus;
  readonly percentiles: MilestoneForecastSnapshot["percentiles"];
  readonly scenarios: readonly ForecastScenario[];
  readonly probabilityOnTime: number | null;
}

interface ForecastAlgorithmResultV1 {
  readonly status: ForecastStatus;
  readonly percentiles: MilestoneForecastSnapshotV1["percentiles"];
  readonly scenarios: readonly ForecastScenarioV1[];
}

interface DependencyRow {
  readonly link_id: string;
  readonly source_id: string;
  readonly source_key: string;
  readonly target_id: string;
  readonly target_key: string;
  readonly created_at: string;
  readonly removed_at: string | null;
}

interface ImpactRow {
  readonly impact_id: string;
  readonly item_id: string;
  readonly item_key: string;
  readonly specification_key: string;
  readonly published_revision: number;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

export interface ForecastMilestoneDeliveryInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly milestoneIdOrKey: string;
  readonly teamId?: string;
  readonly asOfDate?: string;
}

export interface ListMilestoneForecastHistoryInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly milestoneIdOrKey: string;
  readonly teamId?: string;
  readonly limit?: number;
}

export interface RecalculateMilestoneForecastInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly forecastId: string;
}

export function forecastMilestoneDelivery(
  database: SqliteDatabase,
  input: ForecastMilestoneDeliveryInput,
): MilestoneForecastSnapshot {
  const reference = input.milestoneIdOrKey.trim();
  if (reference.length === 0 || reference.length > 80) {
    throw new ApplicationError("VALIDATION_FAILED", "A milestone ID or key is required.");
  }
  const calculate = database.transaction(() => {
    assertProjectAuthorization(database, input.projectId, input.principalId);
    const milestone = findMilestone(database, input.projectId, reference);
    const timezone = readProjectTimezone(database, input.projectId);
    const asOfDate = normalizeAsOfDate(input.asOfDate, timezone);
    const today = localDate(new Date(), timezone);
    if (asOfDate > today) {
      throw new ApplicationError("VALIDATION_FAILED", "Forecast asOfDate cannot be in the future.");
    }
    if (localDate(milestone.created_at, timezone) > asOfDate) {
      throw new ApplicationError("VALIDATION_FAILED", "Forecast asOfDate must be on or after milestone creation.");
    }
    const watermarkSequence = readProjectWatermark(database, input.projectId);
    const allScopeEvents = readMilestoneScopeEvents(database, input.projectId, milestone.milestone_id);
    const scopeAtCutoff = currentScopeAtCutoff(allScopeEvents, asOfDate, timezone);
    const scopeIds = scopeAtCutoff.map((item) => item.item_id);
    const estimates = readPointEstimates(database, input.projectId, scopeIds, asOfDate, timezone);
    const stateFallbacks = new Map(scopeAtCutoff.map((item) => [item.item_id, item.item_state]));
    const scopeStates = readWorkItemStates(database, input.projectId, scopeIds, asOfDate, timezone, stateFallbacks);
    const openScope = scopeAtCutoff
      .map((item) => ({
        item,
        state: scopeStates.get(item.item_id) ?? item.item_state,
        points: pointsAtCutoff(item, estimates.get(item.item_id) ?? []),
      }))
      .filter((entry) => activeStates.has(entry.state));
    const unestimatedPbiCount = openScope.filter((entry) => entry.points === null).length;
    const remainingPoints = roundMetric(sum(openScope.map((entry) => entry.points ?? 0)));
    const team = teamAtCutoff(database, input.projectId, asOfDate, timezone, input.teamId);
    const sample = team === null || team.generationNumber === null
      ? []
      : readForecastSample(database, input.projectId, input.principalId, {
        teamId: team.teamId,
        generationNumber: team.generationNumber,
      }, asOfDate, timezone);
    const { blockers, risks } = readDependencySignals(
      database,
      input.projectId,
      openScope.map((entry) => ({ id: entry.item.item_id, key: entry.item.item_key, state: entry.state })),
      new Set(scopeIds),
      asOfDate,
      timezone,
    );
    const capacity = team === null || team.configVersion === null
      ? emptyCapacitySchedule(asOfDate)
      : buildCapacitySchedule(database, input.projectId, input.principalId, {
        teamId: team.teamId,
        configVersion: team.configVersion,
      }, asOfDate, timezone);
    const typicalSprintDurationCalendarDays = getTypicalSprintDuration(sample);
    const seedInput = {
      asOfDate,
      targetDate: milestone.target_date,
      remainingPoints,
      unestimatedPbiCount,
      teamId: team?.teamId ?? null,
      teamGenerationNumber: team?.generationNumber ?? null,
      sample,
      capacityDays: capacity.days,
      blockers,
    };
    const calculationInput: ForecastCalculationInput = {
      ...seedInput,
      seed: createForecastSeed(forecastAlgorithmVersion, seedInput),
      simulationCount,
      typicalSprintDurationCalendarDays,
    };
    const algorithm = calculateForecastV2(calculationInput);
    const calculatedAt = new Date().toISOString();
    const proposedSnapshot: MilestoneForecastSnapshot = {
      forecastId: randomUUID(),
      projectId: input.projectId,
      milestoneId: milestone.milestone_id,
      milestoneKey: milestone.milestone_key,
      targetDate: milestone.target_date,
      asOfDate,
      watermarkSequence,
      calculatedAt,
      algorithmVersion: forecastAlgorithmVersion,
      status: algorithm.status,
      remainingPoints,
      openPbiCount: openScope.length,
      unestimatedPbiCount,
      teamId: team?.teamId ?? null,
      teamGenerationNumber: team?.generationNumber ?? null,
      minimumSampleSize,
      sample,
      seed: calculationInput.seed,
      simulationCount: calculationInput.simulationCount,
      typicalSprintDurationCalendarDays,
      targetDateWithinHorizon: milestone.target_date <= capacity.endDate,
      probabilityOnTime: algorithm.probabilityOnTime,
      percentiles: algorithm.percentiles,
      capacityStartDate: capacity.startDate,
      capacityEndDate: capacity.endDate,
      capacityHoursInHorizon: capacity.totalHours,
      capacityBases: capacity.bases,
      blockers,
      risks,
      scenarios: algorithm.scenarios,
    };
    database.prepare(
      `INSERT OR IGNORE INTO milestone_forecast_snapshots
        (forecast_id, project_id, milestone_id, team_id, algorithm_version, as_of_date, watermark_sequence,
         calculated_at, snapshot_json, calculation_input_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      proposedSnapshot.forecastId,
      proposedSnapshot.projectId,
      proposedSnapshot.milestoneId,
      proposedSnapshot.teamId,
      proposedSnapshot.algorithmVersion,
      proposedSnapshot.asOfDate,
      proposedSnapshot.watermarkSequence,
      proposedSnapshot.calculatedAt,
      JSON.stringify(proposedSnapshot),
      JSON.stringify(calculationInput),
    );
    const persisted = database.prepare(
      `SELECT snapshot_json FROM milestone_forecast_snapshots
       WHERE project_id = ? AND milestone_id = ? AND algorithm_version = ?
         AND team_id IS ? AND as_of_date = ? AND watermark_sequence = ?`,
    ).get(
      input.projectId, milestone.milestone_id, forecastAlgorithmVersion, proposedSnapshot.teamId,
      asOfDate, watermarkSequence,
    ) as { snapshot_json: string } | undefined;
    if (persisted === undefined) throw new ApplicationError("INTERNAL_ERROR", "Forecast snapshot was not persisted.");
    return JSON.parse(persisted.snapshot_json) as MilestoneForecastSnapshot;
  });
  return calculate.immediate();
}

export function listMilestoneForecastHistory(
  database: SqliteDatabase,
  input: ListMilestoneForecastHistoryInput,
): readonly MilestoneForecastHistoryEntry[] {
  return database.transaction(() => {
    assertProjectAuthorization(database, input.projectId, input.principalId);
    const milestone = findMilestone(database, input.projectId, input.milestoneIdOrKey.trim());
    const teamId = resolveProjectTeamId(database, input.projectId, input.teamId);
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ApplicationError("VALIDATION_FAILED", "Forecast history limit must be an integer between 1 and 100.");
    }
    const rows = database.prepare(
      `SELECT snapshot_json, calculation_input_json FROM milestone_forecast_snapshots
       WHERE project_id = ? AND milestone_id = ? AND team_id IS ?
       ORDER BY as_of_date DESC, watermark_sequence DESC, calculated_at DESC LIMIT ?`,
    ).all(input.projectId, milestone.milestone_id, teamId, limit) as Array<{
      snapshot_json: string;
      calculation_input_json: string;
    }>;
    return rows.map((row) => ({
      forecast: JSON.parse(row.snapshot_json) as MilestoneForecastSnapshot | MilestoneForecastSnapshotV1,
      calculationInput: JSON.parse(row.calculation_input_json) as ForecastCalculationInput | ForecastCalculationInputV1,
    }));
  })();
}

export function recalculateMilestoneForecast(
  database: SqliteDatabase,
  input: RecalculateMilestoneForecastInput,
): MilestoneForecastRecalculation {
  return database.transaction(() => {
    assertProjectAuthorization(database, input.projectId, input.principalId);
    const row = database.prepare(
      `SELECT forecast_id, algorithm_version, snapshot_json, calculation_input_json
       FROM milestone_forecast_snapshots WHERE project_id = ? AND forecast_id = ?`,
    ).get(input.projectId, input.forecastId) as {
      forecast_id: string;
      algorithm_version: string;
      snapshot_json: string;
      calculation_input_json: string;
    } | undefined;
    if (row === undefined) throw new ApplicationError("NOT_FOUND", "Forecast snapshot was not found in this project.");
    const calculationInput = JSON.parse(row.calculation_input_json) as ForecastCalculationInput | ForecastCalculationInputV1;
    const result = calculateForecast(row.algorithm_version, calculationInput);
    return {
      forecastId: row.forecast_id,
      algorithmVersion: row.algorithm_version,
      recalculatedAt: new Date().toISOString(),
      status: result.status,
      percentiles: result.percentiles,
      scenarios: result.scenarios,
      probabilityOnTime: "probabilityOnTime" in result ? result.probabilityOnTime : null,
      seed: "seed" in calculationInput ? calculationInput.seed : null,
      simulationCount: "simulationCount" in calculationInput ? calculationInput.simulationCount : null,
    };
  })();
}

function calculateForecast(
  version: string,
  input: ForecastCalculationInput | ForecastCalculationInputV1,
): ForecastAlgorithmResult | ForecastAlgorithmResultV1 {
  if (version === "1.0.0" && !("seed" in input)) return calculateForecastV1(input);
  if (version === "2.0.0" && "seed" in input) return calculateForecastV2(input);
  throw new ApplicationError("NOT_SUPPORTED", `Forecast algorithm '${version}' is not available for recalculation.`);
}

function getTypicalSprintDuration(sample: readonly ForecastVelocitySample[]): number | null {
  if (sample.length === 0) return null;
  const durations = sample.map((entry) => {
    const start = Date.parse(`${entry.startsOn}T00:00:00.000Z`);
    const end = Date.parse(`${entry.endsOn}T00:00:00.000Z`);
    return Math.max(1, Math.floor((end - start) / 86_400_000) + 1);
  }).sort((left, right) => left - right);
  const middle = Math.floor(durations.length / 2);
  const medianDuration = durations.length % 2 === 0
    ? (durations[middle - 1]! + durations[middle]!) / 2
    : durations[middle]!;
  return Math.max(1, Math.ceil(medianDuration));
}

function createForecastSeed(
  version: string,
  input: Omit<ForecastCalculationInput, "seed" | "simulationCount" | "typicalSprintDurationCalendarDays">,
): number {
  const sampleSpace = input.sample.map((sample) => ({
    sprintId: sample.sprintId,
    deliveredPoints: sample.deliveredPoints,
    capacityHours: sample.capacityHours,
  }));
  return createHash("sha256").update(JSON.stringify({
    version,
    asOfDate: input.asOfDate,
    remainingPoints: input.remainingPoints,
    teamId: input.teamId,
    teamGenerationNumber: input.teamGenerationNumber,
    sampleSpace,
  })).digest().readUInt32BE(0);
}

function calculateForecastV1(input: ForecastCalculationInputV1): ForecastAlgorithmResultV1 {
  const sampleRates = input.sample.map((sample) => sample.pointsPerHour).filter(Number.isFinite);
  const percentiles = sampleRates.length < minimumSampleSize
    ? emptyPercentilesV1()
    : {
        cautious: { percentile: 25 as const, pointsPerHour: percentile(sampleRates, 0.25) },
        base: { percentile: 50 as const, pointsPerHour: percentile(sampleRates, 0.5) },
        favorable: { percentile: 75 as const, pointsPerHour: percentile(sampleRates, 0.75) },
      };
  const capacityHours = roundMetric(sum(input.capacityDays.map((day) => day.hours)));
  const status: ForecastStatus = input.remainingPoints <= 0 && input.unestimatedPbiCount === 0
    ? "complete"
    : input.unestimatedPbiCount > 0
      ? "incomplete_scope"
      : input.blockers.length > 0
        ? "blocked"
        : sampleRates.length < minimumSampleSize || capacityHours <= 0
          ? "insufficient_data"
          : "forecast_ready";
  const definitions: readonly {
    readonly key: ForecastScenarioKey;
    readonly percentile: 25 | 50 | 75;
  }[] = [
    { key: "cautious", percentile: 25 },
    { key: "base", percentile: 50 },
    { key: "favorable", percentile: 75 },
  ];
  const scenarios = definitions.map(({ key, percentile: selectedPercentile }): ForecastScenarioV1 => {
    const rate = percentiles[key].pointsPerHour;
    if (status === "complete") {
      return {
        key,
        percentile: selectedPercentile,
        pointsPerHour: rate,
        hoursNeeded: 0,
        workingDaysToComplete: 0,
        estimatedDate: input.asOfDate,
        onTime: input.asOfDate <= input.targetDate,
        status: "complete",
      };
    }
    if (status === "incomplete_scope" || status === "blocked" || status === "insufficient_data") {
      const scenarioStatus = status === "insufficient_data" && sampleRates.length >= minimumSampleSize && capacityHours <= 0
        ? "no_capacity"
        : status;
      return {
        key,
        percentile: selectedPercentile,
        pointsPerHour: rate,
        hoursNeeded: rate === null || rate <= 0 ? null : roundMetric(input.remainingPoints / rate),
        workingDaysToComplete: null,
        estimatedDate: null,
        onTime: null,
        status: scenarioStatus,
      };
    }
    if (rate === null) {
      return {
        key, percentile: selectedPercentile, pointsPerHour: null, hoursNeeded: null,
        workingDaysToComplete: null, estimatedDate: null, onTime: null, status: "insufficient_data",
      };
    }
    if (rate <= 0) {
      return {
        key, percentile: selectedPercentile, pointsPerHour: rate, hoursNeeded: null,
        workingDaysToComplete: null, estimatedDate: null, onTime: null, status: "zero_velocity",
      };
    }
    const hoursNeeded = input.remainingPoints / rate;
    const completion = findCapacityCompletion(input.capacityDays, hoursNeeded);
    if (completion === null) {
      const hasApplicableCapacity = input.capacityDays.some((day) => day.hours > 0);
      return {
        key,
        percentile: selectedPercentile,
        pointsPerHour: rate,
        hoursNeeded: roundMetric(hoursNeeded),
        workingDaysToComplete: null,
        estimatedDate: null,
        onTime: null,
        status: hasApplicableCapacity ? "horizon_exceeded" : "no_capacity",
      };
    }
    return {
      key,
      percentile: selectedPercentile,
      pointsPerHour: rate,
      hoursNeeded: roundMetric(hoursNeeded),
      workingDaysToComplete: completion.workingDays,
      estimatedDate: completion.date,
      onTime: completion.date <= input.targetDate,
      status: "forecast_ready",
    };
  });
  return { status, percentiles, scenarios };
}

function emptyPercentilesV1(): MilestoneForecastSnapshotV1["percentiles"] {
  return {
    cautious: { percentile: 25, pointsPerHour: null },
    base: { percentile: 50, pointsPerHour: null },
    favorable: { percentile: 75, pointsPerHour: null },
  };
}

function calculateForecastV2(input: ForecastCalculationInput): ForecastAlgorithmResult {
  const windows = buildForecastSimulationWindows(input.capacityDays, input.typicalSprintDurationCalendarDays);
  const hasFutureCapacity = windows.some((window) => window.capacityHours > 0);
  const allSampleDeliveriesAreZero = input.sample.length > 0 && input.sample.every((sample) => sample.deliveredPoints === 0);
  const status: ForecastStatus = input.remainingPoints <= 0 && input.unestimatedPbiCount === 0
    ? "complete"
    : input.unestimatedPbiCount > 0
      ? "incomplete_scope"
      : input.blockers.length > 0
        ? "blocked"
        : input.sample.length < minimumSampleSize
          ? "insufficient_data"
          : !hasFutureCapacity
            ? "no_capacity"
            : allSampleDeliveriesAreZero
              ? "zero_velocity"
              : "forecast_ready";

  const capacityHorizonEnd = input.capacityDays.at(-1)?.date;
  const targetDateWithinHorizon = capacityHorizonEnd !== undefined && input.targetDate <= capacityHorizonEnd;
  const completions = status === "forecast_ready"
    ? simulateCompletionDates(input, windows)
    : Array.from({ length: input.simulationCount }, () => null as string | null);
  const completedByTarget = targetDateWithinHorizon
    ? completions.filter((date) => date !== null && date <= input.targetDate).length
    : null;
  const probabilityOnTime = status === "complete"
    ? (input.asOfDate <= input.targetDate ? 1 : 0)
    : completedByTarget === null || status === "blocked" || status === "incomplete_scope" ||
      status === "insufficient_data" || status === "no_capacity"
      ? null
      : roundTo(completedByTarget / input.simulationCount, 4);

  const definitions: readonly { readonly key: ForecastScenarioKey; readonly percentile: 25 | 50 | 75 }[] = [
    { key: "cautious", percentile: 75 },
    { key: "base", percentile: 50 },
    { key: "favorable", percentile: 25 },
  ];
  const scenarios = definitions.map(({ key, percentile: selectedPercentile }): ForecastScenario => {
    if (status === "complete") {
      return {
        key,
        percentile: selectedPercentile,
        estimatedDate: input.asOfDate,
        workingDaysToComplete: 0,
        onTime: input.asOfDate <= input.targetDate,
        status: "complete",
      };
    }
    if (status !== "forecast_ready") {
      return {
        key,
        percentile: selectedPercentile,
        estimatedDate: null,
        workingDaysToComplete: null,
        onTime: null,
        status,
      };
    }
    const estimatedDate = completionDatePercentile(completions, selectedPercentile);
    return {
      key,
      percentile: selectedPercentile,
      estimatedDate,
      workingDaysToComplete: estimatedDate === null
        ? null
        : input.capacityDays.filter((day) => day.date <= estimatedDate && day.hours > 0).length,
      onTime: estimatedDate === null ? null : estimatedDate <= input.targetDate,
      status: estimatedDate === null ? "horizon_exceeded" : "forecast_ready",
    };
  });
  const percentiles = Object.fromEntries(scenarios.map((scenario) => [scenario.key, {
    percentile: scenario.percentile,
    estimatedDate: scenario.estimatedDate,
    workingDaysToComplete: scenario.workingDaysToComplete,
  }])) as MilestoneForecastSnapshot["percentiles"];
  return { status, percentiles, scenarios, probabilityOnTime };
}

function simulateCompletionDates(
  input: ForecastCalculationInput,
  windows: readonly ForecastSimulationWindow[],
): Array<string | null> {
  const nextRandom = createSeededRandom(input.seed);
  return Array.from({ length: input.simulationCount }, () => {
    let remaining = input.remainingPoints;
    for (const window of windows) {
      if (window.capacityHours <= 0) continue;
      const sample = input.sample[Math.floor(nextRandom() * input.sample.length)];
      if (sample === undefined || sample.capacityHours <= 0) break;
      remaining -= sample.deliveredPoints * (window.capacityHours / sample.capacityHours);
      if (remaining <= 0) return window.endDate;
    }
    return null;
  });
}

function buildForecastSimulationWindows(
  days: readonly ForecastCapacityDay[],
  typicalSprintDurationCalendarDays: number | null,
): ForecastSimulationWindow[] {
  if (days.length === 0 || typicalSprintDurationCalendarDays === null || typicalSprintDurationCalendarDays < 1) return [];
  const windows: ForecastSimulationWindow[] = [];
  let index = 0;
  while (index < days.length) {
    const first = days[index]!;
    let endIndex: number;
    if (first.sprintId !== null) {
      endIndex = index;
      while (endIndex + 1 < days.length && days[endIndex + 1]!.sprintId === first.sprintId) endIndex += 1;
    } else {
      const nextPlannedSprint = days.findIndex((day, dayIndex) => dayIndex > index && day.sprintId !== null);
      const assumedEndIndex = Math.min(index + typicalSprintDurationCalendarDays - 1, days.length - 1);
      endIndex = nextPlannedSprint === -1 ? assumedEndIndex : Math.min(assumedEndIndex, nextPlannedSprint - 1);
    }
    const windowDays = days.slice(index, endIndex + 1);
    windows.push({
      startDate: first.date,
      endDate: windowDays.at(-1)!.date,
      capacityHours: roundMetric(sum(windowDays.map((day) => day.hours))),
    });
    index = endIndex + 1;
  }
  return windows;
}

function completionDatePercentile(completions: readonly (string | null)[], percentileValue: 25 | 50 | 75): string | null {
  const completedDates = completions.filter((date): date is string => date !== null).sort();
  const rank = Math.ceil(completions.length * percentileValue / 100);
  return completedDates.length < rank ? null : completedDates[rank - 1] ?? null;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * quantile;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const fraction = position - low;
  return roundTo((sorted[low]! * (1 - fraction)) + (sorted[high]! * fraction), 6);
}

function findCapacityCompletion(
  days: readonly ForecastCapacityDay[],
  hoursNeeded: number,
): { readonly date: string; readonly workingDays: number } | null {
  let available = 0;
  let workingDays = 0;
  for (const day of days) {
    if (day.hours <= 0) continue;
    available += day.hours;
    workingDays += 1;
    if (available + Number.EPSILON >= hoursNeeded) return { date: day.date, workingDays };
  }
  return null;
}

function findMilestone(database: SqliteDatabase, projectId: string, reference: string): MilestoneForecastRow {
  const row = database.prepare(
    `SELECT milestone_id, milestone_key, target_date, created_at FROM milestones
     WHERE project_id = ? AND (milestone_id = ? OR milestone_key = ? COLLATE NOCASE)`,
  ).get(projectId, reference, reference) as MilestoneForecastRow | undefined;
  if (row === undefined) throw new ApplicationError("NOT_FOUND", "Milestone was not found in this project.");
  return row;
}

function readMilestoneScopeEvents(
  database: SqliteDatabase,
  projectId: string,
  milestoneId: string,
): ForecastScopeEventRow[] {
  return database.prepare(
    `SELECT sequence, item_id, item_key, item_title, item_state, action, baseline_id,
            item_revision_number, points, changed_at
     FROM milestone_scope_events WHERE project_id = ? AND milestone_id = ?
     ORDER BY changed_at, sequence`,
  ).all(projectId, milestoneId) as ForecastScopeEventRow[];
}

function currentScopeAtCutoff(
  events: readonly ForecastScopeEventRow[],
  asOfDate: string,
  timezone: string,
): ForecastScopeEventRow[] {
  const active = new Map<string, ForecastScopeEventRow>();
  for (const event of events) {
    if (localDate(event.changed_at, timezone) > asOfDate) break;
    if (event.action === "add") active.set(event.item_id, event);
    else active.delete(event.item_id);
  }
  return [...active.values()];
}

function readPointEstimates(
  database: SqliteDatabase,
  projectId: string,
  itemIds: readonly string[],
  asOfDate: string,
  timezone: string,
): Map<string, EstimateRow[]> {
  const grouped = new Map<string, EstimateRow[]>();
  for (const batch of chunks(itemIds, 500)) {
    if (batch.length === 0) continue;
    const rows = database.prepare(
      `SELECT entity_id, occurred_at, sequence, payload_json FROM audit_events
       WHERE project_id = ? AND event_type = 'work_item.estimate_confirmed'
         AND entity_id IN (${batch.map(() => "?").join(",")})
       ORDER BY occurred_at, sequence`,
    ).all(projectId, ...batch) as EstimateRow[];
    for (const row of rows) {
      if (localDate(row.occurred_at, timezone) > asOfDate) continue;
      const payload = parseJsonObject(row.payload_json);
      if (stringProperty(payload, "unit") !== "points") continue;
      const value = numberProperty(payload, "value");
      if (value === null || !Number.isSafeInteger(value) || value < 1) continue;
      const group = grouped.get(row.entity_id) ?? [];
      group.push(row);
      grouped.set(row.entity_id, group);
    }
  }
  return grouped;
}

function pointsAtCutoff(scopeEvent: ForecastScopeEventRow, estimates: readonly EstimateRow[]): number | null {
  let points: number | null = Number.isSafeInteger(scopeEvent.points) && scopeEvent.points > 0
    ? scopeEvent.points
    : null;
  for (const estimate of estimates) {
    if (estimate.occurred_at < scopeEvent.changed_at) continue;
    const value = numberProperty(parseJsonObject(estimate.payload_json), "value");
    if (value !== null && Number.isSafeInteger(value) && value > 0) points = value;
  }
  return points;
}

function readWorkItemStates(
  database: SqliteDatabase,
  projectId: string,
  itemIds: readonly string[],
  asOfDate: string,
  timezone: string,
  fallbacks: ReadonlyMap<string, string>,
): Map<string, string> {
  const states = new Map<string, string>();
  if (itemIds.length === 0) return states;
  const currentRows = new Map<string, string>();
  for (const batch of chunks(itemIds, 500)) {
    const current = database.prepare(
      `SELECT item_id, state FROM work_items WHERE project_id = ? AND item_id IN (${batch.map(() => "?").join(",")})`,
    ).all(projectId, ...batch) as Array<{ item_id: string; state: string }>;
    for (const row of current) currentRows.set(row.item_id, row.state);
    const rows = database.prepare(
      `SELECT item_id, from_state, to_state, item_version, transitioned_at
       FROM work_item_state_transitions WHERE project_id = ? AND item_id IN (${batch.map(() => "?").join(",")})
       ORDER BY item_id, transitioned_at, item_version`,
    ).all(projectId, ...batch) as StateTransitionRow[];
    const grouped = new Map<string, StateTransitionRow[]>();
    for (const row of rows) {
      const group = grouped.get(row.item_id) ?? [];
      group.push(row);
      grouped.set(row.item_id, group);
    }
    for (const itemId of batch) {
      const transitions = grouped.get(itemId) ?? [];
      let state = transitions[0]?.from_state ?? fallbacks.get(itemId) ?? currentRows.get(itemId) ?? "draft";
      for (const transition of transitions) {
        if (localDate(transition.transitioned_at, timezone) > asOfDate) break;
        state = transition.to_state;
      }
      states.set(itemId, state);
    }
  }
  return states;
}

function teamAtCutoff(
  database: SqliteDatabase,
  projectId: string,
  asOfDate: string,
  timezone: string,
  requestedTeamId?: string,
): TeamAtCutoff | null {
  const teamId = resolveProjectTeamId(database, projectId, requestedTeamId);
  if (teamId === null) return null;
  const versions = database.prepare(
    `SELECT version, generation_number, created_at FROM team_config_versions
     WHERE project_id = ? AND team_id = ? ORDER BY version DESC`,
  ).all(projectId, teamId) as Array<{ version: number; generation_number: number; created_at: string }>;
  const selected = versions.find((version) => localDate(version.created_at, timezone) <= asOfDate);
  return selected === undefined
    ? { teamId, configVersion: null, generationNumber: null }
    : { teamId, configVersion: selected.version, generationNumber: selected.generation_number };
}

function readForecastSample(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  team: { readonly teamId: string; readonly generationNumber: number },
  asOfDate: string,
  timezone: string,
): ForecastVelocitySample[] {
  const velocity = getProjectVelocityMetrics(database, {
    projectId,
    principalId,
    limit: maxSampleSprints,
    team: { teamId: team.teamId, generationNumber: team.generationNumber },
    closedBefore: nextLocalDayStart(asOfDate, timezone),
  });
  const selected = velocity.sprints
    .filter((sprint) => sprint.teamId === team.teamId && sprint.teamGenerationNumber === team.generationNumber)
    .filter((sprint) => localDate(sprint.closedAt, timezone) <= asOfDate && sprint.capacityHours > 0)
    .sort((left, right) => left.closedAt.localeCompare(right.closedAt) || left.sprintKey.localeCompare(right.sprintKey))
    .slice(-maxSampleSprints);
  if (selected.length === 0) return [];
  const dates = database.prepare(
    `SELECT sprint_id, starts_on, ends_on FROM sprints
     WHERE project_id = ? AND sprint_id IN (${selected.map(() => "?").join(",")})`,
  ).all(projectId, ...selected.map((sprint) => sprint.sprintId)) as Array<{
    sprint_id: string;
    starts_on: string;
    ends_on: string;
  }>;
  const dateBySprint = new Map(dates.map((row) => [row.sprint_id, row]));
  return selected.flatMap((sprint) => {
    const dateRange = dateBySprint.get(sprint.sprintId);
    return dateRange === undefined ? [] : [{
      sprintId: sprint.sprintId,
      sprintKey: sprint.sprintKey,
      startsOn: dateRange.starts_on,
      endsOn: dateRange.ends_on,
      closedAt: sprint.closedAt,
      deliveredPoints: sprint.deliveredPoints,
      capacityHours: sprint.capacityHours,
    }];
  });
}

function readDependencySignals(
  database: SqliteDatabase,
  projectId: string,
  openItems: readonly { readonly id: string; readonly key: string; readonly state: string }[],
  activeScopeIds: ReadonlySet<string>,
  asOfDate: string,
  timezone: string,
): { readonly blockers: readonly ForecastBlocker[]; readonly risks: readonly ForecastInternalDependencyRisk[] } {
  const sourceIds = openItems.map((item) => item.id);
  if (sourceIds.length === 0) return { blockers: [], risks: [] };
  const sourceById = new Map(openItems.map((item) => [item.id, item]));
  const dependencyRows: DependencyRow[] = [];
  for (const batch of chunks(sourceIds, 500)) {
    dependencyRows.push(...database.prepare(
      `SELECT link.link_id, link.source_id, source.item_key AS source_key,
              link.target_id, target.item_key AS target_key, link.created_at, link.removed_at
       FROM trace_links link
       INNER JOIN work_items source ON source.project_id = link.project_id AND source.item_id = link.source_id
       INNER JOIN work_items target ON target.project_id = link.project_id AND target.item_id = link.target_id
       WHERE link.project_id = ? AND link.link_type = 'depends_on'
         AND link.source_id IN (${batch.map(() => "?").join(",")})
       ORDER BY link.created_at, link.link_id`,
    ).all(projectId, ...batch) as DependencyRow[]);
  }
  const activeDependencies = dependencyRows.filter((link) =>
    localDate(link.created_at, timezone) <= asOfDate &&
    (link.removed_at === null || localDate(link.removed_at, timezone) > asOfDate));
  const dependencyTargetIds = unique(activeDependencies.map((link) => link.target_id));
  const targetStates = readWorkItemStates(database, projectId, dependencyTargetIds, asOfDate, timezone, new Map());
  const blockers: ForecastBlocker[] = [];
  const risks: ForecastInternalDependencyRisk[] = [];
  for (const link of activeDependencies) {
    const source = sourceById.get(link.source_id);
    if (source === undefined) continue;
    const dependencyState = targetStates.get(link.target_id) ?? "draft";
    if (dependencyState === "done") continue;
    if (activeScopeIds.has(link.target_id)) {
      risks.push({
        kind: "internal_dependency",
        itemId: link.source_id,
        itemKey: source.key,
        dependencyItemId: link.target_id,
        dependencyItemKey: link.target_key,
        dependencyState,
      });
    } else {
      blockers.push({
        kind: "external_dependency",
        itemId: link.source_id,
        itemKey: source.key,
        dependencyItemId: link.target_id,
        dependencyItemKey: link.target_key,
        dependencyState,
        resolutionDate: null,
      });
    }
  }
  const impactRows: ImpactRow[] = [];
  for (const batch of chunks(sourceIds, 500)) {
    impactRows.push(...database.prepare(
      `SELECT impact.impact_id, impact.item_id, item.item_key, specification.spec_key AS specification_key,
              impact.published_revision, impact.created_at, impact.resolved_at
       FROM impact_flags impact
       INNER JOIN work_items item ON item.project_id = impact.project_id AND item.item_id = impact.item_id
       INNER JOIN specifications specification ON specification.project_id = impact.project_id
         AND specification.spec_id = impact.specification_id
       WHERE impact.project_id = ? AND impact.item_id IN (${batch.map(() => "?").join(",")})
       ORDER BY impact.created_at, impact.impact_id`,
    ).all(projectId, ...batch) as ImpactRow[]);
  }
  for (const impact of impactRows) {
    if (localDate(impact.created_at, timezone) > asOfDate ||
        (impact.resolved_at !== null && localDate(impact.resolved_at, timezone) <= asOfDate)) continue;
    blockers.push({
      kind: "open_specification_impact",
      itemId: impact.item_id,
      itemKey: impact.item_key,
      impactId: impact.impact_id,
      specificationKey: impact.specification_key,
      publishedRevision: impact.published_revision,
    });
  }
  return { blockers, risks };
}

function buildCapacitySchedule(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  team: { readonly teamId: string; readonly configVersion: number },
  asOfDate: string,
  timezone: string,
): CapacitySchedule {
  const startDate = addDays(asOfDate, 1);
  const endDate = addDays(startDate, horizonCalendarDays - 1);
  const dates = enumerateDates(startDate, endDate);
  const sprintRows = database.prepare(
    `SELECT sprint_id, sprint_key, starts_on, ends_on, team_id, capacity_config_version,
            created_at, started_at, closed_at, cancelled_at, started_snapshot_json
     FROM sprints WHERE project_id = ? AND team_id = ? AND starts_on <= ? AND ends_on >= ?`,
  ).all(projectId, team.teamId, endDate, startDate) as Array<SprintCapacityRow & { sprint_key: string }>;
  const planned = sprintRows.flatMap((row) => {
    if (localDate(row.created_at, timezone) > asOfDate) return [];
    if (row.closed_at !== null && localDate(row.closed_at, timezone) <= asOfDate) return [];
    if (row.cancelled_at !== null && localDate(row.cancelled_at, timezone) <= asOfDate) return [];
    const isActiveAtCutoff = row.started_at !== null && localDate(row.started_at, timezone) <= asOfDate;
    return [{ row, isActiveAtCutoff }];
  }).sort((left, right) => left.row.starts_on.localeCompare(right.row.starts_on) ||
    left.row.created_at.localeCompare(right.row.created_at) || left.row.sprint_key.localeCompare(right.row.sprint_key));
  const versions = unique([team.configVersion, ...planned
    .filter(({ isActiveAtCutoff }) => !isActiveAtCutoff)
    .map(({ row }) => row.capacity_config_version)]);
  const reports = new Map<number, TeamCapacityReport>();
  for (const version of versions) {
    reports.set(version, getTeamCapacity(database, {
      projectId, principalId, startDate, endDate, configVersion: version, teamId: team.teamId,
    }));
  }
  const reportByVersion = new Map([...reports.entries()].map(([version, report]) => [
    version,
    new Map(report.daily.map((day) => [day.date, day.totalHours])),
  ]));
  const snapshotBySprint = new Map<string, Map<string, number>>();
  for (const { row, isActiveAtCutoff } of planned) {
    if (!isActiveAtCutoff || row.started_snapshot_json === null) continue;
    snapshotBySprint.set(row.sprint_id, readSnapshotCapacityDays(row.started_snapshot_json));
  }
  const days: ForecastCapacityDay[] = dates.map((date): ForecastCapacityDay => {
    const active = planned.find(({ row, isActiveAtCutoff }) => isActiveAtCutoff &&
      date >= row.starts_on && date <= row.ends_on);
    if (active !== undefined) {
      return {
        date,
        hours: snapshotBySprint.get(active.row.sprint_id)?.get(date) ?? 0,
        source: "active_sprint_snapshot",
        sprintId: active.row.sprint_id,
        sprintKey: active.row.sprint_key,
        configVersion: active.row.capacity_config_version,
      };
    }
    const scheduled = planned.find(({ row, isActiveAtCutoff }) => !isActiveAtCutoff &&
      date >= row.starts_on && date <= row.ends_on);
    if (scheduled !== undefined) {
      return {
        date,
        hours: reportByVersion.get(scheduled.row.capacity_config_version)?.get(date) ?? 0,
        source: "planned_sprint_configuration",
        sprintId: scheduled.row.sprint_id,
        sprintKey: scheduled.row.sprint_key,
        configVersion: scheduled.row.capacity_config_version,
      };
    }
    return {
      date,
      hours: reportByVersion.get(team.configVersion)?.get(date) ?? 0,
      source: "team_configuration_assumption",
      sprintId: null,
      sprintKey: null,
      configVersion: team.configVersion,
    };
  }).map((day) => ({ ...day, hours: roundMetric(day.hours) }));
  return {
    startDate,
    endDate,
    days,
    bases: summarizeCapacityBases(days),
    totalHours: roundMetric(sum(days.map((day) => day.hours))),
  };
}

function emptyCapacitySchedule(asOfDate: string): CapacitySchedule {
  const startDate = addDays(asOfDate, 1);
  const endDate = addDays(startDate, horizonCalendarDays - 1);
  return { startDate, endDate, days: [], bases: [], totalHours: 0 };
}

function readSnapshotCapacityDays(snapshotJson: string): Map<string, number> {
  const snapshot = parseJsonObject(snapshotJson);
  const capacity = objectProperty(snapshot, "capacity");
  const days = arrayFromObject(capacity, "daily");
  return new Map(days.flatMap((day) => {
    const date = stringProperty(day, "date");
    const hours = numberProperty(day, "totalHours");
    return date === null || hours === null ? [] : [[date, hours] as const];
  }));
}

function summarizeCapacityBases(days: readonly ForecastCapacityDay[]): ForecastCapacityBasis[] {
  const bases: ForecastCapacityBasis[] = [];
  for (const day of days) {
    const previous = bases.at(-1);
    if (previous !== undefined && previous.source === day.source && previous.sprintId === day.sprintId &&
        previous.configVersion === day.configVersion && addDays(previous.endDate, 1) === day.date) {
      bases[bases.length - 1] = { ...previous, endDate: day.date };
    } else {
      bases.push({
        source: day.source,
        sprintId: day.sprintId,
        sprintKey: day.sprintKey,
        configVersion: day.configVersion,
        startDate: day.date,
        endDate: day.date,
      });
    }
  }
  return bases;
}

function readProjectTimezone(database: SqliteDatabase, projectId: string): string {
  const row = database.prepare("SELECT timezone FROM projects WHERE project_id = ?")
    .get(projectId) as { timezone: string } | undefined;
  if (row === undefined) throw new ApplicationError("NOT_FOUND", "Project was not found.");
  return row.timezone;
}

function readProjectWatermark(database: SqliteDatabase, projectId: string): number {
  const row = database.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM audit_events WHERE project_id = ?",
  ).get(projectId) as { sequence: number };
  return row.sequence;
}

function normalizeAsOfDate(value: string | undefined, timezone: string): string {
  if (value === undefined) return localDate(new Date(), timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "Forecast asOfDate must use YYYY-MM-DD format.");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApplicationError("VALIDATION_FAILED", "Forecast asOfDate must be a valid calendar date.");
  }
  return value;
}

function localDate(value: string | Date, timezone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApplicationError("VALIDATION_FAILED", "Forecast event timestamp is invalid.");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  return `${parts.find((part) => part.type === "year")!.value}-${parts.find((part) => part.type === "month")!.value}-${parts.find((part) => part.type === "day")!.value}`;
}

function enumerateDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function addDays(date: string, amount: number): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + amount);
  return result.toISOString().slice(0, 10);
}

export function nextLocalDayStart(date: string, timezone: string): string {
  return localDayStart(addDays(date, 1), timezone);
}

export function localDayStart(date: string, timezone: string): string {
  const targetLocalTimestamp = Date.parse(`${date}T00:00:00.000Z`);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let candidate = targetLocalTimestamp;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = formatter.formatToParts(new Date(candidate));
    const part = (type: Intl.DateTimeFormatPartTypes): number => {
      const value = parts.find((entry) => entry.type === type)?.value;
      if (value === undefined) throw new ApplicationError("VALIDATION_FAILED", "Project timezone could not format forecast dates.");
      return Number(value);
    };
    const localTimestamp = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    const adjusted = targetLocalTimestamp - (localTimestamp - candidate);
    if (adjusted === candidate) break;
    candidate = adjusted;
  }
  return new Date(candidate).toISOString();
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundMetric(value: number): number {
  return roundTo(value, 2);
}

function roundTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function objectProperty(value: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const property = value?.[key];
  return typeof property === "object" && property !== null && !Array.isArray(property)
    ? property as Record<string, unknown>
    : null;
}

function arrayFromObject(value: Record<string, unknown> | null, key: string): Array<Record<string, unknown>> {
  const property = value?.[key];
  return Array.isArray(property)
    ? property.filter((entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry))
    : [];
}

function stringProperty(value: Record<string, unknown> | null, key: string): string | null {
  const property = value?.[key];
  return typeof property === "string" ? property : null;
}

function numberProperty(value: Record<string, unknown> | null, key: string): number | null {
  const property = value?.[key];
  return typeof property === "number" && Number.isFinite(property) ? property : null;
}
