import type {
  MilestoneBurnupMetrics,
  ProjectCoverageMetrics,
  ProjectVelocityMetrics,
  ProjectWipMetrics,
  SprintDeliveryMetrics,
} from "../domain/metrics.js";
import type { MilestoneSummary } from "../domain/milestones.js";
import type { SprintOption } from "./sprint-queries.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { forecastMilestoneDelivery } from "./forecast-queries.js";
import { ApplicationError } from "./errors.js";
import { getMilestoneBurnupMetrics, getProjectCoverageMetrics, getProjectVelocityMetrics,
  getProjectWipMetrics, getSprintDeliveryMetrics, normalizeMetricsAsOfDate } from "./metrics-queries.js";
import { getMilestone, listMilestones } from "./milestones.js";
import { getProject } from "./project-queries.js";
import { listSprintOptions } from "./sprint-queries.js";
import { listProjectTeams, resolveProjectTeamId, type TeamSummary } from "./team-directory.js";

export interface ProjectDashboardMetricsInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly teamId?: string;
  readonly milestoneId?: string;
  readonly sprintId?: string;
  readonly asOfDate?: string;
}

export interface ProjectDashboardMetrics {
  readonly projectId: string;
  readonly teams: readonly TeamSummary[];
  readonly selectedTeamId: string | null;
  readonly asOfDate: string;
  readonly observedAt: string;
  readonly watermarkSequence: number;
  readonly selectedMilestoneId: string | null;
  readonly selectedSprintId: string | null;
  readonly forecastUnavailableReason: "before_milestone_created" | null;
  readonly milestones: readonly MilestoneSummary[];
  readonly sprints: readonly SprintOption[];
  readonly milestoneMetrics: MilestoneBurnupMetrics | null;
  readonly forecast: ReturnType<typeof forecastMilestoneDelivery> | null;
  readonly sprintMetrics: SprintDeliveryMetrics | null;
  readonly velocity: ProjectVelocityMetrics;
  readonly wip: ProjectWipMetrics;
  readonly coverage: ProjectCoverageMetrics;
}

interface CachedDashboardMetrics {
  readonly watermarkSequence: number;
  readonly expiresAt: number;
  readonly value: ProjectDashboardMetrics;
}

const dashboardMetricsCache = new WeakMap<SqliteDatabase, Map<string, CachedDashboardMetrics>>();
const dashboardMetricsCacheTtlMs = 1_000;
const dashboardMetricsCacheMaxEntries = 32;

/**
 * Produces the shared, authorized dashboard/MCP metrics projection. The outer
 * transaction gives every nested projection the same SQLite read snapshot.
 */
export function getProjectDashboardMetrics(
  database: SqliteDatabase,
  input: ProjectDashboardMetricsInput,
): ProjectDashboardMetrics {
  return database.transaction(() => {
    const project = getProject(database, input.principalId, input.projectId);
    const asOfDate = normalizeMetricsAsOfDate(input.asOfDate, project.timezone);
    const teams = listProjectTeams(database, input.projectId, input.principalId);
    const selectedTeamId = resolveProjectTeamId(database, input.projectId, input.teamId);
    const cacheKey = JSON.stringify([
      input.projectId,
      input.principalId,
      selectedTeamId,
      asOfDate,
      input.milestoneId ?? null,
      input.sprintId ?? null,
    ]);
    const cache = getDashboardMetricsCache(database);
    const cached = cache.get(cacheKey);
    const watermarkSequence = readProjectWatermark(database, input.projectId);
    const now = Date.now();
    if (cached !== undefined && cached.watermarkSequence === watermarkSequence && cached.expiresAt > now) {
      return structuredClone(cached.value);
    }

    const milestones = listMilestones(database, input.projectId, input.principalId, 100);
    const sprints = listSprintOptions(database, input.projectId, input.principalId, 30, selectedTeamId ?? undefined);
    const milestoneReference = input.milestoneId === "none"
      ? null
      : input.milestoneId ?? milestones[0]?.id ?? null;
    const selectedMilestone = milestoneReference === null
      ? null
      : getMilestone(database, input.projectId, input.principalId, milestoneReference);
    const sprintReference = input.sprintId === "none"
      ? null
      : input.sprintId ?? sprints.find((sprint) => sprint.status === "active")?.id ??
        sprints.find((sprint) => sprint.status === "closed")?.id ??
        sprints.find((sprint) => sprint.status === "draft")?.id ?? null;
    const requestedSprintId = input.sprintId;
    if (requestedSprintId !== undefined && requestedSprintId !== "none" &&
        !sprints.some((sprint) => sprint.id === requestedSprintId || sprint.key.toLowerCase() === requestedSprintId.toLowerCase())) {
      throw new ApplicationError("VALIDATION_FAILED", "The selected sprint does not belong to the selected team.", {
        details: { selectedTeamId, sprintId: requestedSprintId, sprintOptions: sprints },
      });
    }
    const milestoneExistsAtCutoff = selectedMilestone !== null &&
      localDate(selectedMilestone.createdAt, project.timezone) <= asOfDate;
    const milestoneMetrics = selectedMilestone === null || !milestoneExistsAtCutoff
      ? null
      : getMilestoneBurnupMetrics(database, {
        projectId: input.projectId,
        principalId: input.principalId,
        milestoneIdOrKey: selectedMilestone.id,
        asOfDate,
        ...(selectedTeamId === null ? {} : { teamId: selectedTeamId }),
      });
    const forecast = selectedMilestone === null || !milestoneExistsAtCutoff
      ? null
      : forecastMilestoneDelivery(database, {
        projectId: input.projectId,
        principalId: input.principalId,
        milestoneIdOrKey: selectedMilestone.id,
        asOfDate,
        ...(selectedTeamId === null ? {} : { teamId: selectedTeamId }),
      });
    const sprintMetrics = sprintReference === null
      ? null
      : getSprintDeliveryMetrics(database, {
        projectId: input.projectId,
        principalId: input.principalId,
        sprintIdOrKey: sprintReference,
        asOfDate,
      });
    const velocity = getProjectVelocityMetrics(database, {
      projectId: input.projectId,
      principalId: input.principalId,
      limit: 12,
      ...(selectedTeamId === null ? {} : { teamId: selectedTeamId }),
    });
    const wip = getProjectWipMetrics(database, { projectId: input.projectId, principalId: input.principalId, itemLimit: 200 });
    const coverage = getProjectCoverageMetrics(database, { projectId: input.projectId, principalId: input.principalId });
    const observedAt = new Date().toISOString();

    const result: ProjectDashboardMetrics = {
      projectId: input.projectId,
      teams,
      selectedTeamId,
      asOfDate,
      observedAt,
      watermarkSequence: wip.watermarkSequence,
      selectedMilestoneId: selectedMilestone?.id ?? null,
      selectedSprintId: sprintMetrics?.sprintId ?? null,
      forecastUnavailableReason: selectedMilestone !== null && !milestoneExistsAtCutoff
        ? "before_milestone_created" as const
        : null,
      milestones,
      sprints,
      milestoneMetrics,
      forecast,
      sprintMetrics,
      velocity,
      wip,
      coverage,
    };
    cache.set(cacheKey, {
      watermarkSequence,
      expiresAt: now + dashboardMetricsCacheTtlMs,
      value: structuredClone(result),
    });
    pruneDashboardMetricsCache(cache, now);
    return result;
  })();
}

function getDashboardMetricsCache(database: SqliteDatabase): Map<string, CachedDashboardMetrics> {
  let cache = dashboardMetricsCache.get(database);
  if (cache === undefined) {
    cache = new Map();
    dashboardMetricsCache.set(database, cache);
  }
  return cache;
}

function pruneDashboardMetricsCache(cache: Map<string, CachedDashboardMetrics>, now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > dashboardMetricsCacheMaxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) return;
    cache.delete(oldestKey);
  }
}

function readProjectWatermark(database: SqliteDatabase, projectId: string): number {
  const row = database.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM audit_events WHERE project_id = ?",
  ).get(projectId) as { sequence: number };
  return row.sequence;
}

function localDate(value: string | Date, timezone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("Project timezone could not format a metric date.");
  }
  return `${year}-${month}-${day}`;
}
