import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { getTaskStartReadiness } from "./work-item-workflow.js";
import { getProject } from "./project-queries.js";
import { listProjectTeams, resolveProjectTeamId } from "./team-directory.js";
import { getProjectVelocityMetrics, normalizeMetricsAsOfDate } from "./metrics-queries.js";
import { nextLocalDayStart } from "./forecast-queries.js";

const minimumVelocitySamples = 3;
const maximumQueueCandidates = 500;
const simulations = 10_000;
const maximumProjectedSprints = 52;

export interface PrioritizedTask {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly state: string;
  readonly assigneeId: string | null;
  readonly priority: number;
  readonly prioritySource: string;
  readonly businessValueScore: number | null;
  readonly businessValueRationale: string | null;
  readonly businessValueSource: string | null;
  readonly featureKey: string | null;
  readonly rank: number;
}

export interface TaskExecutionQueue {
  readonly projectId: string;
  readonly order: readonly ["startable_first", "priority_ascending", "business_value_descending", "feature_rank", "task_rank", "key"];
  readonly assignedToMe: boolean;
  readonly scannedCount: number;
  readonly candidateLimitReached: boolean;
  readonly blockedCount: number;
  readonly businessValueMissingCount: number;
  readonly blocked: readonly (PrioritizedTask & { readonly blockerCodes: readonly string[] })[];
  readonly tasks: readonly PrioritizedTask[];
  readonly emptyReason: "no_ready_tasks" | "ready_tasks_blocked" | null;
  readonly upNext: readonly UpNextTask[];
  readonly awaitingAcceptanceCount: number;
  readonly awaitingAcceptance: readonly string[];
  readonly inFlight: readonly { readonly key: string; readonly state: string; readonly assigneeId: string | null }[];
}

export interface UpNextTask extends PrioritizedTask {
  readonly unmetDependencies: readonly string[];
  readonly dependenciesAwaitingAcceptance: readonly string[];
  readonly missing: readonly ("not_ready_state" | "assignee" | "estimate" | "business_value" | "dependencies")[];
  readonly nextAction: string;
}

export function getTaskExecutionQueue(
  database: SqliteDatabase,
  input: { readonly projectId: string; readonly principalId: string; readonly limit?: number; readonly assignedToMe?: boolean },
): TaskExecutionQueue {
  const queue = getStartableQueue(database, input);
  const startable = queue.tasks.length;
  return {
    ...queue,
    emptyReason: startable > 0 ? null : queue.scannedCount === 0 ? "no_ready_tasks" : "ready_tasks_blocked",
    inFlight: getInFlightTasks(database, input.projectId),
    ...(startable > 0 ? { upNext: [], awaitingAcceptanceCount: 0, awaitingAcceptance: [] } : upNextSummary(getUpNextTasks(database, input.projectId))),
  };
}

function getStartableQueue(
  database: SqliteDatabase,
  input: { readonly projectId: string; readonly principalId: string; readonly limit?: number; readonly assignedToMe?: boolean },
): Omit<TaskExecutionQueue, "emptyReason" | "upNext" | "awaitingAcceptanceCount" | "awaitingAcceptance" | "inFlight"> {
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new ApplicationError("VALIDATION_FAILED", "Execution queue limit must be an integer between 1 and 50.");
  }
  const assignedToMe = input.assignedToMe ?? true;
  const assignedClause = assignedToMe ? "AND task.assignee_principal_id = ?" : "";
  const parameters: Array<string | number> = assignedToMe
    ? [input.projectId, input.principalId, maximumQueueCandidates + 1]
    : [input.projectId, maximumQueueCandidates + 1];
  const rows = database.prepare(
    `SELECT task.item_id, task.item_key, task.title, task.state, task.assignee_principal_id,
            task.priority AS task_priority, task.business_value_score AS task_value,
            task.business_value_rationale AS task_value_rationale, task.rank AS task_rank,
            feature.item_key AS feature_key, feature.rank AS feature_rank,
            feature.priority AS feature_priority, feature.business_value_score AS feature_value,
            feature.business_value_rationale AS feature_value_rationale,
            epic.item_key AS epic_key, epic.priority AS epic_priority,
            epic.business_value_score AS epic_value, epic.business_value_rationale AS epic_value_rationale,
            story.item_key AS story_key, story.priority AS story_priority
     FROM work_items task
     LEFT JOIN work_items story ON story.project_id = task.project_id AND story.item_id = task.parent_id
     LEFT JOIN work_items feature ON feature.project_id = story.project_id AND feature.item_id = story.parent_id
     LEFT JOIN work_items epic ON epic.project_id = feature.project_id AND epic.item_id = feature.parent_id
     WHERE task.project_id = ? AND task.type = 'task' AND task.state IN ('ready', 'in_progress') ${assignedClause}
     ORDER BY MIN(COALESCE(task.priority, 4), COALESCE(story.priority, 4),
                  COALESCE(feature.priority, 4), COALESCE(epic.priority, 4)),
              CASE WHEN COALESCE(task.business_value_score, feature.business_value_score, epic.business_value_score) IS NULL THEN 1 ELSE 0 END,
              COALESCE(task.business_value_score, feature.business_value_score, epic.business_value_score) DESC,
              COALESCE(feature.rank, 2147483647), task.rank, task.item_key COLLATE NOCASE
     LIMIT ?`,
  ).all(...parameters) as Array<{
    item_id: string; item_key: string; title: string; state: string; assignee_principal_id: string | null;
    task_priority: number; task_value: number | null; task_value_rationale: string | null; task_rank: number;
    feature_key: string | null; feature_rank: number | null; feature_priority: number | null;
    feature_value: number | null; feature_value_rationale: string | null;
    epic_key: string | null; epic_priority: number | null; epic_value: number | null; epic_value_rationale: string | null;
    story_key: string | null; story_priority: number | null;
  }>;
  const candidateLimitReached = rows.length > maximumQueueCandidates;
  const candidates = rows.slice(0, maximumQueueCandidates).map((row) => {
    const priorities = [row.task_priority, row.story_priority, row.feature_priority, row.epic_priority]
      .filter((value): value is number => value !== null);
    const priority = Math.min(...priorities);
    const prioritySource = row.task_priority === priority ? row.item_key
      : row.story_priority === priority ? row.story_key ?? row.item_key
      : row.feature_priority === priority ? row.feature_key ?? row.item_key
        : row.epic_priority === priority ? row.epic_key ?? row.item_key
          : row.item_key;
    const businessValueScore = row.task_value ?? row.feature_value ?? row.epic_value;
    const businessValueSource = row.task_value !== null ? row.item_key
      : row.feature_value !== null ? row.feature_key
        : row.epic_value !== null ? row.epic_key
          : null;
    const businessValueRationale = row.task_value !== null ? row.task_value_rationale
      : row.feature_value !== null ? row.feature_value_rationale
        : row.epic_value_rationale;
    return {
      itemIdOrKey: row.item_id,
      queueItem: {
        id: row.item_id,
        key: row.item_key,
        title: row.title,
        state: row.state,
        assigneeId: row.assignee_principal_id,
        priority,
        prioritySource,
        businessValueScore,
        businessValueRationale,
        businessValueSource,
        featureKey: row.feature_key,
        featureRank: row.feature_rank ?? Number.MAX_SAFE_INTEGER,
        rank: row.task_rank,
      },
    };
  });
  const checked = candidates.map(({ itemIdOrKey, queueItem }) => ({
    ...queueItem,
    readiness: getTaskStartReadiness(database, {
      projectId: input.projectId,
      principalId: input.principalId,
      itemIdOrKey,
    }),
  }));
  type CheckedTask = typeof checked[number];
  const order = (left: CheckedTask, right: CheckedTask): number =>
    Number(right.readiness.canStart) - Number(left.readiness.canStart) ||
    left.priority - right.priority ||
    (right.businessValueScore ?? -1) - (left.businessValueScore ?? -1) ||
    left.featureRank - right.featureRank || left.rank - right.rank || left.key.localeCompare(right.key, "en");
  checked.sort(order);
  const startable = checked.filter((item) => item.readiness.canStart);
  const blocked = checked.filter((item) => !item.readiness.canStart).slice(0, 3).map((item) => ({
    ...publicTask(item),
    blockerCodes: item.readiness.blockers.map((blocker) => blocker.code).slice(0, 4),
  }));
  return {
    projectId: input.projectId,
    order: ["startable_first", "priority_ascending", "business_value_descending", "feature_rank", "task_rank", "key"],
    assignedToMe,
    scannedCount: checked.length,
    candidateLimitReached,
    blockedCount: checked.length - startable.length,
    businessValueMissingCount: checked.filter((item) => item.businessValueScore === null).length,
    blocked,
    tasks: startable.slice(0, limit).map(publicTask),
  };
}

interface RoadmapFeature {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly state: string;
  readonly priority: number;
  readonly effectivePriority: number;
  readonly businessValueScore: number | null;
  readonly businessValueRationale: string | null;
  readonly businessValueSource: string | null;
  readonly rank: number;
  readonly completedPoints: number;
  readonly remainingPoints: number;
  readonly cancelledPoints: number;
  readonly unestimatedItemCount: number;
  readonly totalItems: number;
  readonly completedItems: number;
  readonly cancelledItems: number;
  readonly progressPercent: number | null;
  readonly deliveredPercent: number | null;
  readonly taskTotal: number;
  readonly taskDone: number;
  readonly externalBlockers: readonly { readonly key: string; readonly state: string }[];
  readonly forecast: {
    readonly status: "completed" | "forecast_ready" | "insufficient_data" | "incomplete_scope" | "blocked" | "zero_velocity";
    readonly favorableDate: string | null;
    readonly baseDate: string | null;
    readonly cautiousDate: string | null;
    readonly favorableSprint: number | null;
    readonly baseSprint: number | null;
    readonly cautiousSprint: number | null;
  };
}

export interface ProjectFeatureRoadmap {
  readonly projectId: string;
  readonly teamId: string | null;
  readonly teamName: string | null;
  readonly teamGenerationNumber: number | null;
  readonly asOfDate: string;
  readonly timezone: string;
  readonly watermarkSequence: number;
  readonly velocitySampleSize: number;
  readonly minimumVelocitySamples: number;
  readonly forecastBasis: "historical_sprint_velocity_sequential_priority" | "unavailable";
  readonly forecastAssumption: string;
  readonly forecastUnavailableReason: "team_required" | "insufficient_velocity_samples" | "unknown_feature_scope" | "external_dependency" | "zero_velocity" | null;
  readonly features: readonly RoadmapFeature[];
  readonly featuresTruncated: boolean;
  readonly epics: readonly { readonly key: string; readonly title: string | null; readonly featureCount: number; readonly taskTotal: number; readonly taskDone: number; readonly progressPercent: number | null }[];
  readonly sprintTimeline: readonly { readonly index: number; readonly startsOn: string; readonly endsOn: string; readonly source: "planned_sprint" | "historical_median" }[];
}

interface FeatureRow {
  item_id: string; item_key: string; title: string; state: string; priority: number; rank: number;
  business_value_score: number | null; business_value_rationale: string | null;
  epic_priority: number | null; epic_key: string | null; epic_title: string | null; epic_value: number | null; epic_value_rationale: string | null;
}

interface FeatureTaskRow { feature_id: string; state: string }

interface FeatureChildRow {
  item_id: string; item_key: string; parent_id: string; state: string; points: number | null;
}

export function getProjectFeatureRoadmap(
  database: SqliteDatabase,
  input: { readonly projectId: string; readonly principalId: string; readonly teamId?: string; readonly asOfDate?: string },
): ProjectFeatureRoadmap {
  return database.transaction(() => {
    const project = getProject(database, input.principalId, input.projectId);
    const asOfDate = normalizeMetricsAsOfDate(input.asOfDate, project.timezone);
    const teams = listProjectTeams(database, input.projectId, input.principalId);
    const teamId = resolveProjectTeamId(database, input.projectId, input.teamId);
    const team = teamId === null ? undefined : teams.find((candidate) => candidate.teamId === teamId);
    const generation = team?.currentGeneration ?? null;
    const cutoff = nextLocalDayStart(asOfDate, project.timezone);
    const velocity = teamId === null || generation === null
      ? null
      : getProjectVelocityMetrics(database, {
        projectId: input.projectId,
        principalId: input.principalId,
        limit: 12,
        closedBefore: cutoff,
        team: { teamId, generationNumber: generation },
      });
    const velocitySamples = velocity?.sprints ?? [];
    const watermark = database.prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM audit_events WHERE project_id = ?")
      .get(input.projectId) as { value: number };
    const featureRows = database.prepare(
      `SELECT feature.item_id, feature.item_key, feature.title, feature.state, feature.priority, feature.rank,
              feature.business_value_score, feature.business_value_rationale,
              epic.priority AS epic_priority, epic.item_key AS epic_key, epic.title AS epic_title,
              epic.business_value_score AS epic_value, epic.business_value_rationale AS epic_value_rationale
       FROM work_items feature
       LEFT JOIN work_items epic ON epic.project_id = feature.project_id AND epic.item_id = feature.parent_id
       WHERE feature.project_id = ? AND feature.type = 'feature'
       ORDER BY feature.rank, feature.item_key COLLATE NOCASE LIMIT 101`,
    ).all(input.projectId) as FeatureRow[];
    const featuresTruncated = featureRows.length > 100;
    const boundedFeatures = featureRows.slice(0, 100);
    const children = boundedFeatures.length === 0 ? [] : database.prepare(
      `SELECT child.item_id, child.item_key, child.parent_id, child.state, estimate.value AS points
       FROM work_items child
       LEFT JOIN work_item_estimates estimate ON estimate.project_id = child.project_id
         AND estimate.item_id = child.item_id AND estimate.unit = 'points'
       WHERE child.project_id = ? AND child.type IN ('story', 'bug')
         AND child.parent_id IN (${boundedFeatures.map(() => "?").join(", ")})
       ORDER BY child.item_key COLLATE NOCASE`,
    ).all(input.projectId, ...boundedFeatures.map((feature) => feature.item_id)) as FeatureChildRow[];
    const taskRows = boundedFeatures.length === 0 ? [] : database.prepare(
      `SELECT CASE WHEN parent.type = 'feature' THEN parent.item_id ELSE parent.parent_id END AS feature_id, task.state
       FROM work_items task
       INNER JOIN work_items parent ON parent.project_id = task.project_id AND parent.item_id = task.parent_id
       WHERE task.project_id = ? AND task.type = 'task' AND task.state <> 'cancelled'
         AND (parent.item_id IN (${boundedFeatures.map(() => "?").join(", ")})
           OR parent.parent_id IN (${boundedFeatures.map(() => "?").join(", ")}))`,
    ).all(input.projectId, ...boundedFeatures.map((feature) => feature.item_id), ...boundedFeatures.map((feature) => feature.item_id)) as FeatureTaskRow[];
    const tasksByFeature = groupBy(taskRows, (task) => task.feature_id);
    const childrenByFeature = groupBy(children, (child) => child.parent_id);
    const preliminary = boundedFeatures.map((feature) => {
      const featureChildren = childrenByFeature.get(feature.item_id) ?? [];
      const activeChildren = featureChildren.filter((child) => child.state !== "done" && child.state !== "cancelled");
      const completedPoints = sum(featureChildren.filter((child) => child.state === "done").map((child) => child.points ?? 0));
      const remainingPoints = sum(activeChildren.map((child) => child.points ?? 0));
      const cancelledPoints = sum(featureChildren.filter((child) => child.state === "cancelled").map((child) => child.points ?? 0));
      const unestimatedItemCount = activeChildren.filter((child) => child.points === null).length;
      const totalPoints = completedPoints + remainingPoints;
      const completedItems = featureChildren.filter((child) => child.state === "done").length;
      const cancelledItems = featureChildren.filter((child) => child.state === "cancelled").length;
      const featureTasks = tasksByFeature.get(feature.item_id) ?? [];
      const taskTotal = featureTasks.length;
      const taskDone = featureTasks.filter((task) => task.state === "done").length;
      const deliveredPercent = totalPoints === 0 ? null : Math.round((completedPoints / totalPoints) * 1000) / 10;
      const effectivePriority = Math.min(feature.priority, feature.epic_priority ?? 4);
      const businessValueScore = feature.business_value_score ?? feature.epic_value;
      const businessValueSource = feature.business_value_score !== null ? feature.item_key
        : feature.epic_value !== null ? feature.epic_key
          : null;
      return {
        id: feature.item_id,
        key: feature.item_key,
        title: feature.title,
        state: feature.state,
        priority: feature.priority,
        effectivePriority,
        businessValueScore,
        businessValueRationale: feature.business_value_score !== null ? feature.business_value_rationale : feature.epic_value_rationale,
        businessValueSource,
        rank: feature.rank,
        completedPoints,
        remainingPoints,
        cancelledPoints,
        unestimatedItemCount,
        totalItems: featureChildren.length,
        completedItems,
        cancelledItems,
        // Progress follows executed work (tasks); deliveredPercent keeps the validated PBI points measure.
        progressPercent: taskTotal > 0 ? Math.round((taskDone / taskTotal) * 1000) / 10 : deliveredPercent,
        deliveredPercent,
        taskTotal,
        taskDone,
        externalBlockers: getExternalFeatureDependencies(database, input.projectId, feature.item_id),
        forecast: null as RoadmapFeature["forecast"] | null,
      };
    });
    preliminary.sort((left, right) => left.effectivePriority - right.effectivePriority ||
      (right.businessValueScore ?? -1) - (left.businessValueScore ?? -1) || left.rank - right.rank || left.key.localeCompare(right.key));

    const durations = readComparableSprintDates(database, input.projectId, velocitySamples.map((entry) => entry.sprintId));
    const durationDays = median(durations.map((sprint) => daysBetween(sprint.startsOn, sprint.endsOn) + 1));
    const samplesSufficient = velocitySamples.length >= minimumVelocitySamples;
    const timeline = samplesSufficient
      ? buildSprintTimeline(database, input.projectId, teamId, asOfDate, durationDays)
      : [];
    const hasZeroVelocity = velocitySamples.length > 0 && velocitySamples.every((sample) => sample.deliveredPoints === 0);
    const simulationResults = samplesSufficient && !hasZeroVelocity
      ? simulateFeatureCompletionOrdinals(
        preliminary.map((candidate) => ({
          key: candidate.key,
          remainingPoints: candidate.remainingPoints,
          unknown: candidate.unestimatedItemCount > 0 || candidate.totalItems === 0,
          blocked: candidate.externalBlockers.length > 0,
        })),
        velocitySamples.map((sample) => sample.deliveredPoints),
        Number.parseInt(createHash("sha256").update(`${input.projectId}:${teamId}:${watermark.value}:${asOfDate}`).digest("hex").slice(0, 8), 16),
        simulations,
        maximumProjectedSprints,
      )
      : new Map<string, Array<number | null>>();
    let remainingScopeIsKnown = true;
    let blockedByEarlierFeature = false;
    const forecastRows: RoadmapFeature[] = [];
    for (const feature of preliminary) {
      let status: RoadmapFeature["forecast"]["status"];
      let percentiles: [number, number, number] | null = null;
      if (feature.totalItems === 0 || (feature.completedItems === 0 && feature.cancelledItems === feature.totalItems)) status = "incomplete_scope";
      else if (feature.remainingPoints <= 0 && feature.unestimatedItemCount === 0) status = "completed";
      else if (!samplesSufficient) status = "insufficient_data";
      else if (hasZeroVelocity) status = "zero_velocity";
      else if (!remainingScopeIsKnown || feature.unestimatedItemCount > 0) status = "incomplete_scope";
      else if (blockedByEarlierFeature || feature.externalBlockers.length > 0) status = "blocked";
      else if (timeline.length === 0) status = "insufficient_data";
      else {
        const simulationsByOrdinal = simulationResults.get(feature.key) ?? [];
        const ordinals = simulationsByOrdinal.filter((ordinal): ordinal is number => ordinal !== null).sort((a, b) => a - b);
        if (ordinals.length === 0) status = "insufficient_data";
        else {
          const rankFor = (percentile: number): number => Math.ceil(simulations * percentile / 100);
          percentiles = [ordinals[Math.max(0, rankFor(25) - 1)]!, ordinals[Math.max(0, rankFor(50) - 1)]!, ordinals[Math.max(0, rankFor(75) - 1)]!];
          status = percentiles.some((ordinal) => ordinal === undefined) ? "insufficient_data" : "forecast_ready";
        }
      }
      const toDate = (ordinal: number | null | undefined): string | null => ordinal == null ? null : timeline[ordinal - 1]?.endsOn ?? null;
      const forecast: RoadmapFeature["forecast"] = {
        status,
        favorableSprint: status === "forecast_ready" ? percentiles?.[0] ?? null : null,
        baseSprint: status === "forecast_ready" ? percentiles?.[1] ?? null : null,
        cautiousSprint: status === "forecast_ready" ? percentiles?.[2] ?? null : null,
        favorableDate: status === "forecast_ready" ? toDate(percentiles?.[0]) : null,
        baseDate: status === "forecast_ready" ? toDate(percentiles?.[1]) : null,
        cautiousDate: status === "forecast_ready" ? toDate(percentiles?.[2]) : null,
      };
      forecastRows.push({ ...feature, forecast });
      if (feature.unestimatedItemCount > 0) remainingScopeIsKnown = false;
      if (feature.externalBlockers.length > 0) blockedByEarlierFeature = true;
    }
    const firstUnestimated = preliminary.findIndex((feature) => feature.unestimatedItemCount > 0);
    const firstBlocked = preliminary.findIndex((feature) => feature.externalBlockers.length > 0);
    const forecastUnavailableReason: ProjectFeatureRoadmap["forecastUnavailableReason"] = teamId === null ? "team_required"
      : !samplesSufficient ? "insufficient_velocity_samples"
        : hasZeroVelocity ? "zero_velocity"
          : firstUnestimated >= 0 ? "unknown_feature_scope"
            : firstBlocked >= 0 ? "external_dependency"
              : null;
    return {
      projectId: input.projectId,
      teamId,
      teamName: team?.name ?? null,
      teamGenerationNumber: generation,
      asOfDate,
      timezone: project.timezone,
      watermarkSequence: watermark.value,
      velocitySampleSize: velocitySamples.length,
      minimumVelocitySamples,
      forecastBasis: samplesSufficient && teamId !== null
        ? "historical_sprint_velocity_sequential_priority" as const
        : "unavailable" as const,
      forecastAssumption: "Simulação de 10.000 amostras da velocidade histórica (mesmo time/geração), alocando pontos em sequência pela ordem de prioridade; datas usam sprints planejadas e depois a duração mediana histórica. Não é compromisso de entrega.",
      forecastUnavailableReason,
      features: forecastRows,
      featuresTruncated,
      epics: epicRollup(boundedFeatures, forecastRows),
      sprintTimeline: timeline,
    };
  }).immediate();
}

function epicRollup(rows: readonly FeatureRow[], features: readonly RoadmapFeature[]): ProjectFeatureRoadmap["epics"] {
  const epicByFeature = new Map(rows.map((row) => [row.item_key, row.epic_key]));
  const titleByEpic = new Map(rows.map((row) => [row.epic_key, row.epic_title]));
  const totals = new Map<string, { featureCount: number; taskTotal: number; taskDone: number }>();
  for (const feature of features) {
    const epicKey = epicByFeature.get(feature.key);
    if (epicKey === null || epicKey === undefined) continue;
    const entry = totals.get(epicKey) ?? { featureCount: 0, taskTotal: 0, taskDone: 0 };
    entry.featureCount += 1; entry.taskTotal += feature.taskTotal; entry.taskDone += feature.taskDone;
    totals.set(epicKey, entry);
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => ({
    key, title: titleByEpic.get(key) ?? null, ...entry, progressPercent: entry.taskTotal === 0 ? null : Math.round((entry.taskDone / entry.taskTotal) * 1000) / 10,
  }));
}

function getExternalFeatureDependencies(database: SqliteDatabase, projectId: string, featureId: string): Array<{ key: string; state: string }> {
  return database.prepare(
    `WITH RECURSIVE subtree(item_id) AS (
       SELECT item_id FROM work_items WHERE project_id = ? AND type IN ('story', 'bug') AND parent_id = ?
       UNION ALL SELECT child.item_id FROM work_items child INNER JOIN subtree parent ON child.parent_id = parent.item_id
        WHERE child.project_id = ? AND child.type = 'task'
     )
     SELECT DISTINCT target.item_key AS key, target.state FROM trace_links link
     INNER JOIN subtree source ON source.item_id = link.source_id
     INNER JOIN work_items target ON target.project_id = link.project_id AND target.item_id = link.target_id
     WHERE link.project_id = ? AND link.link_type = 'depends_on' AND link.removed_at IS NULL
       AND target.state <> 'done'
       AND target.item_id NOT IN (SELECT item_id FROM subtree)
     ORDER BY target.item_key COLLATE NOCASE LIMIT 20`,
  ).all(projectId, featureId, projectId, projectId) as Array<{ key: string; state: string }>;
}

interface SprintDate { readonly sprintId: string; readonly startsOn: string; readonly endsOn: string; }

function readComparableSprintDates(database: SqliteDatabase, projectId: string, sprintIds: readonly string[]): SprintDate[] {
  if (sprintIds.length === 0) return [];
  return database.prepare(
    `SELECT sprint_id AS sprintId, starts_on AS startsOn, ends_on AS endsOn
     FROM sprints WHERE project_id = ? AND sprint_id IN (${sprintIds.map(() => "?").join(", ")})
     ORDER BY starts_on, sprint_key COLLATE NOCASE`,
  ).all(projectId, ...sprintIds) as SprintDate[];
}

function buildSprintTimeline(
  database: SqliteDatabase,
  projectId: string,
  teamId: string | null,
  asOfDate: string,
  medianDuration: number | null,
): ProjectFeatureRoadmap["sprintTimeline"] {
  if (teamId === null || medianDuration === null || medianDuration < 1) return [];
  const planned = database.prepare(
    `SELECT sprint_id AS sprintId, starts_on AS startsOn, ends_on AS endsOn
     FROM sprints WHERE project_id = ? AND team_id = ? AND status = 'draft' AND starts_on > ?
     ORDER BY starts_on, sprint_key COLLATE NOCASE LIMIT 52`,
  ).all(projectId, teamId, asOfDate) as SprintDate[];
  const active = database.prepare(
    `SELECT sprint_id AS sprintId, starts_on AS startsOn, ends_on AS endsOn
     FROM sprints WHERE project_id = ? AND team_id = ? AND status = 'active'
     ORDER BY ends_on DESC, sprint_key COLLATE NOCASE LIMIT 1`,
  ).get(projectId, teamId) as SprintDate | undefined;
  const timeline: Array<{ index: number; startsOn: string; endsOn: string; source: "planned_sprint" | "historical_median" }> =
    planned.map((sprint, index) => ({ ...sprint, index: index + 1, source: "planned_sprint" as const }));
  const activeEnd = active !== undefined && active.endsOn > asOfDate ? active.endsOn : asOfDate;
  let nextStart = addDays(planned.at(-1)?.endsOn ?? activeEnd, 1);
  while (timeline.length < maximumProjectedSprints) {
    const endsOn = addDays(nextStart, medianDuration - 1);
    timeline.push({ index: timeline.length + 1, startsOn: nextStart, endsOn, source: "historical_median" });
    nextStart = addDays(endsOn, 1);
  }
  return timeline;
}

function simulateFeatureCompletionOrdinals(
  features: readonly { readonly key: string; readonly remainingPoints: number; readonly unknown: boolean; readonly blocked: boolean }[],
  velocities: readonly number[],
  seed: number,
  simulationCount: number,
  horizon: number,
): Map<string, Array<number | null>> {
  const results = new Map(features.map((feature) => [feature.key, Array.from({ length: simulationCount }, () => null as number | null)]));
  let state = seed >>> 0;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
  for (let simulation = 0; simulation < simulationCount; simulation += 1) {
    let activeIndex = 0;
    let remaining = features[0]?.remainingPoints ?? 0;
    let blocked = false;
    for (let ordinal = 1; ordinal <= horizon && activeIndex < features.length; ordinal += 1) {
      let capacity = velocities[Math.floor(random() * velocities.length)] ?? 0;
      while (capacity > 0 && activeIndex < features.length) {
        const feature = features[activeIndex]!;
        if (feature.unknown || feature.blocked || blocked) {
          blocked = true;
          break;
        }
        if (remaining <= 0) {
          activeIndex += 1;
          remaining = features[activeIndex]?.remainingPoints ?? 0;
          continue;
        }
        const consumed = Math.min(capacity, remaining);
        capacity -= consumed;
        remaining -= consumed;
        if (remaining <= 0) {
          results.get(feature.key)![simulation] = ordinal;
          activeIndex += 1;
          remaining = features[activeIndex]?.remainingPoints ?? 0;
        }
      }
      if (blocked) break;
    }
  }
  return results;
}

/**
 * O sincronizador do roadmap grava "Registro factual em docs/status.md (data): <estado>" na descrição.
 * Estados que começam por Concluíd/Implementad indicam entrega local ainda sem aceite formal no MCP.
 */
const deliveredLocallyPattern = /Registro factual em docs\/status\.md \([^)]*\):\s*(Conclu[ií]d|Implementad)/i;

function getInFlightTasks(database: SqliteDatabase, projectId: string): TaskExecutionQueue["inFlight"] {
  const rows = database.prepare(
    `SELECT item_key, state, assignee_principal_id FROM work_items
     WHERE project_id = ? AND type = 'task' AND state IN ('in_progress', 'in_review', 'in_validation')
     ORDER BY item_key COLLATE NOCASE LIMIT 20`,
  ).all(projectId) as Array<{ item_key: string; state: string; assignee_principal_id: string | null }>;
  return rows.map((row) => ({ key: row.item_key, state: row.state, assigneeId: row.assignee_principal_id }));
}

interface UpNextCandidates { readonly pending: UpNextTask[]; readonly awaitingAcceptance: string[]; }

function upNextSummary(candidates: UpNextCandidates): Pick<TaskExecutionQueue, "upNext" | "awaitingAcceptanceCount" | "awaitingAcceptance"> {
  return {
    upNext: candidates.pending.slice(0, 5),
    awaitingAcceptanceCount: candidates.awaitingAcceptance.length,
    awaitingAcceptance: candidates.awaitingAcceptance.slice(0, 10),
  };
}

function getUpNextTasks(database: SqliteDatabase, projectId: string): UpNextCandidates {
  const rows = database.prepare(
    `SELECT task.item_id, task.item_key, task.title, task.state, task.assignee_principal_id, task.description,
            task.priority AS task_priority, task.business_value_score AS task_value,
            task.business_value_rationale AS task_value_rationale, task.rank AS task_rank,
            feature.item_key AS feature_key, feature.rank AS feature_rank,
            feature.priority AS feature_priority, feature.business_value_score AS feature_value,
            feature.business_value_rationale AS feature_value_rationale,
            epic.item_key AS epic_key, epic.priority AS epic_priority,
            epic.business_value_score AS epic_value, epic.business_value_rationale AS epic_value_rationale,
            story.item_key AS story_key, story.priority AS story_priority,
            (SELECT value FROM work_item_estimates e WHERE e.project_id = task.project_id AND e.item_id = task.item_id AND e.unit = 'points') AS points,
            (SELECT GROUP_CONCAT(target.item_key || char(31) || COALESCE(target.description, ''), char(30)) FROM trace_links link
               INNER JOIN work_items target ON target.project_id = link.project_id AND target.item_id = link.target_id
              WHERE link.project_id = task.project_id AND link.source_id = task.item_id
                AND link.link_type = 'depends_on' AND link.removed_at IS NULL AND target.state <> 'done') AS unmet
     FROM work_items task
     LEFT JOIN work_items story ON story.project_id = task.project_id AND story.item_id = task.parent_id
     LEFT JOIN work_items feature ON feature.project_id = story.project_id AND feature.item_id = story.parent_id
     LEFT JOIN work_items epic ON epic.project_id = feature.project_id AND epic.item_id = feature.parent_id
     WHERE task.project_id = ? AND task.type = 'task' AND task.state NOT IN ('ready', 'in_progress', 'in_review', 'in_validation', 'done', 'cancelled')
     LIMIT ?`,
  ).all(projectId, maximumQueueCandidates) as Array<{
    item_id: string; item_key: string; title: string; state: string; assignee_principal_id: string | null;
    task_priority: number; task_value: number | null; task_value_rationale: string | null; task_rank: number;
    feature_key: string | null; feature_rank: number | null; feature_priority: number | null;
    feature_value: number | null; feature_value_rationale: string | null;
    epic_key: string | null; epic_priority: number | null; epic_value: number | null; epic_value_rationale: string | null;
    story_key: string | null; story_priority: number | null; points: number | null; unmet: string | null;
    description: string | null;
  }>;
  const awaitingAcceptance = rows.filter((row) => deliveredLocallyPattern.test(row.description ?? ""))
    .map((row) => row.item_key).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const mapped = rows.filter((row) => !deliveredLocallyPattern.test(row.description ?? "")).map((row) => {
    const priorities = [row.task_priority, row.story_priority, row.feature_priority, row.epic_priority]
      .filter((value): value is number => value !== null);
    const priority = Math.min(...priorities);
    const prioritySource = row.task_priority === priority ? row.item_key
      : row.story_priority === priority ? row.story_key ?? row.item_key
        : row.feature_priority === priority ? row.feature_key ?? row.item_key
          : row.epic_key ?? row.item_key;
    const businessValueScore = row.task_value ?? row.feature_value ?? row.epic_value;
    const openDependencies = (row.unmet === null ? [] : row.unmet.split("")).map((entry) => {
      const [key = "", description = ""] = entry.split("");
      return { key, delivered: deliveredLocallyPattern.test(description) };
    }).sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }));
    const unmetDependencies = openDependencies.filter((dependency) => !dependency.delivered).map((dependency) => dependency.key);
    const dependenciesAwaitingAcceptance = openDependencies.filter((dependency) => dependency.delivered).map((dependency) => dependency.key);
    const missing: UpNextTask["missing"][number][] = ["not_ready_state"];
    if (row.assignee_principal_id === null) missing.push("assignee");
    if (row.points === null) missing.push("estimate");
    if (businessValueScore === null) missing.push("business_value");
    if (unmetDependencies.length > 0 || dependenciesAwaitingAcceptance.length > 0) missing.push("dependencies");
    const nextAction = unmetDependencies.length > 0
      ? `Concluir antes: ${unmetDependencies.slice(0, 5).join(", ")}. Depois refinar, estimar, atribuir e passar nos gates Ready.`
      : dependenciesAwaitingAcceptance.length > 0
        ? `Dependências já entregues localmente, mas sem aceite formal no MCP: ${dependenciesAwaitingAcceptance.slice(0, 5).join(", ")}. Aceitá-las (evidência e revisão) antes de task_start; refinar, estimar e atribuir esta tarefa em paralelo.`
        : `Sem dependência aberta: refinar${row.points === null ? ", estimar" : ""}${row.assignee_principal_id === null ? ", atribuir" : ""} e passar nos gates Ready (work_item_gate_check) antes de task_start.`;
    return {
      sort: { priority, value: businessValueScore ?? -1, featureRank: row.feature_rank ?? Number.MAX_SAFE_INTEGER, rank: row.task_rank, free: unmetDependencies.length === 0 },
      task: {
        id: row.item_id, key: row.item_key, title: row.title, state: row.state, assigneeId: row.assignee_principal_id,
        priority, prioritySource, businessValueScore,
        businessValueRationale: row.task_value !== null ? row.task_value_rationale : row.feature_value !== null ? row.feature_value_rationale : row.epic_value_rationale,
        businessValueSource: row.task_value !== null ? row.item_key : row.feature_value !== null ? row.feature_key : row.epic_value !== null ? row.epic_key : null,
        featureKey: row.feature_key, rank: row.task_rank,
        unmetDependencies, dependenciesAwaitingAcceptance, missing, nextAction,
      } satisfies UpNextTask,
    };
  });
  mapped.sort((l, r) => Number(r.sort.free) - Number(l.sort.free) || l.sort.priority - r.sort.priority ||
    r.sort.value - l.sort.value || l.sort.featureRank - r.sort.featureRank || l.sort.rank - r.sort.rank ||
    l.task.key.localeCompare(r.task.key, "en", { numeric: true }));
  return { pending: mapped.map((entry) => entry.task), awaitingAcceptance };
}

function publicTask(task: PrioritizedTask & { featureRank?: number; readiness?: unknown }): PrioritizedTask {
  return {
    id: task.id,
    key: task.key,
    title: task.title,
    state: task.state,
    assigneeId: task.assigneeId,
    priority: task.priority,
    prioritySource: task.prioritySource,
    businessValueScore: task.businessValueScore,
    businessValueRationale: task.businessValueRationale,
    businessValueSource: task.businessValueSource,
    featureKey: task.featureKey,
    rank: task.rank,
  };
}

function groupBy<T, K>(items: readonly T[], key: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    const group = groups.get(groupKey) ?? [];
    group.push(item);
    groups.set(groupKey, group);
  }
  return groups;
}

function sum(values: readonly (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const result = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  return Math.max(1, Math.round(result));
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}
