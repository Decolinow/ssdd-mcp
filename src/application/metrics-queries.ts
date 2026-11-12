import type {
  MetricWipState,
  MilestoneBurnupMetrics,
  PbiCoverageMetric,
  ProjectCoverageMetrics,
  ProjectVelocityMetrics,
  ProjectWipMetrics,
  ScopeMetricItem,
  ScopeMetricPoint,
  SprintDeliveryMetrics,
  SprintMetricPoint,
  SprintVelocityEntry,
  TeamGenerationVelocity,
  WipItemMetric,
} from "../domain/metrics.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { findSprintTarget } from "./sprint-queries.js";

const wipStates: readonly MetricWipState[] = ["ready", "in_progress", "in_review", "in_validation"];
const estimateAuditEventType = "work_item.estimate_confirmed";

interface ScopeEventRow {
  readonly sequence: number;
  readonly item_id: string;
  readonly item_key: string;
  readonly item_title: string;
  readonly item_state: string;
  readonly action: "add" | "remove";
  readonly points: number;
  readonly changed_at: string;
}

interface WorkItemTransitionRow {
  readonly item_id: string;
  readonly from_state: string;
  readonly to_state: string;
  readonly item_version: number;
  readonly transitioned_at: string;
}

interface PointEstimateEvent {
  readonly itemId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly value: number;
}

type ScopeMetricEvent =
  | {
      readonly kind: "scope";
      readonly itemId: string;
      readonly at: string;
      readonly priority: number;
      readonly ordinal: number;
      readonly action: "add" | "remove";
      readonly itemKey: string;
      readonly title: string;
      readonly state: string;
      readonly points: number;
    }
  | {
      readonly kind: "transition";
      readonly itemId: string;
      readonly at: string;
      readonly priority: number;
      readonly ordinal: number;
      readonly fromState: string;
      readonly toState: string;
    }
  | {
      readonly kind: "estimate";
      readonly itemId: string;
      readonly at: string;
      readonly priority: number;
      readonly ordinal: number;
      readonly value: number;
    };

type TimedScopeMetricEvent = ScopeMetricEvent & { readonly localDate: string };

interface MutableScopeMetricItem {
  active: boolean;
  itemKey: string;
  title: string;
  points: number;
  state: string;
}

interface ScopeMetricDeltas {
  addedPoints: number;
  removedPoints: number;
  reestimatedPoints: number;
  deliveryEventsPoints: number;
  reopenedPoints: number;
  reopenedItemCount: number;
}

interface WorkCalendar {
  readonly workingDays: ReadonlySet<number>;
  readonly holidays: ReadonlySet<string>;
}

interface ProjectMetricsRow {
  readonly timezone: string;
}

export function getSprintDeliveryMetrics(
  database: SqliteDatabase,
  input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly sprintIdOrKey: string;
    readonly asOfDate?: string;
  },
): SprintDeliveryMetrics {
  return withReadSnapshot(database, () => {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const watermarkSequence = readProjectWatermark(database, input.projectId);
  const sprint = findSprintTarget(database, input.projectId, input.sprintIdOrKey.trim());
  const timezone = readProjectTimezone(database, input.projectId);
  const asOfDate = normalizeMetricsAsOfDate(input.asOfDate, timezone);
  const effectiveEndDate = sprint.closed_at !== null
    ? minDate(asOfDate, localDate(sprint.closed_at, timezone))
    : sprint.cancelled_at !== null
      ? minDate(asOfDate, localDate(sprint.cancelled_at, timezone))
      : minDate(asOfDate, sprint.ends_on);
  const scopeEvents = database.prepare(
    `SELECT sequence, item_id, item_key, item_title, item_state, action, points, changed_at
     FROM sprint_scope_events WHERE project_id = ? AND sprint_id = ? ORDER BY changed_at, sequence`,
  ).all(input.projectId, sprint.sprint_id) as ScopeEventRow[];
  const metricEvents = createScopeMetricEvents(database, input.projectId, scopeEvents, timezone);
  const calendar = readWorkCalendar(database, input.projectId, sprint.team_id, sprint.capacity_config_version);
  const plannedScopePoints = sprint.started_snapshot_json === null
    ? currentScopePoints(scopeEvents)
    : snapshotCommitmentPoints(sprint.started_snapshot_json);
  const scopeSeries = sprint.starts_on > effectiveEndDate
    ? []
    : buildScopeMetricSeries(metricEvents, sprint.starts_on, effectiveEndDate);
  const series: SprintMetricPoint[] = scopeSeries.map((point) => ({
    ...point,
    idealRemainingPoints: calculateIdealRemainingPoints(
      point.date,
      sprint.starts_on,
      sprint.ends_on,
      calendar,
      plannedScopePoints,
    ),
  }));
  const generation = database.prepare(
    `SELECT generation_number FROM team_config_versions
     WHERE project_id = ? AND team_id = ? AND version = ?`,
  ).get(input.projectId, sprint.team_id, sprint.capacity_config_version) as { generation_number: number } | undefined;

  return {
    projectId: input.projectId,
    asOfDate,
    watermarkSequence,
    sprintId: sprint.sprint_id,
    sprintKey: sprint.sprint_key,
    status: sprint.status,
    startsOn: sprint.starts_on,
    endsOn: sprint.ends_on,
    timezone,
    teamGenerationNumber: generation?.generation_number ?? 0,
    plannedScopePoints,
    series,
    items: sprint.starts_on > effectiveEndDate ? [] : buildScopeMetricItems(metricEvents, effectiveEndDate),
  };
  });
}

export function getMilestoneBurnupMetrics(
  database: SqliteDatabase,
  input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly milestoneIdOrKey: string;
    readonly asOfDate?: string;
  },
): MilestoneBurnupMetrics {
  return withReadSnapshot(database, () => {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const watermarkSequence = readProjectWatermark(database, input.projectId);
  const milestone = database.prepare(
    `SELECT milestone_id, milestone_key, target_date, created_at
     FROM milestones WHERE project_id = ? AND
       (milestone_id = ? OR milestone_key = ? COLLATE NOCASE)`,
  ).get(input.projectId, input.milestoneIdOrKey.trim(), input.milestoneIdOrKey.trim()) as {
    milestone_id: string;
    milestone_key: string;
    target_date: string;
    created_at: string;
  } | undefined;
  if (milestone === undefined) throw new ApplicationError("NOT_FOUND", "Milestone was not found in this project.");
  const timezone = readProjectTimezone(database, input.projectId);
  const startDate = localDate(milestone.created_at, timezone);
  const asOfDate = normalizeMetricsAsOfDate(input.asOfDate, timezone);
  const scopeEvents = database.prepare(
    `SELECT sequence, item_id, item_key, item_title, item_state, action, points, changed_at
     FROM milestone_scope_events WHERE project_id = ? AND milestone_id = ? ORDER BY changed_at, sequence`,
  ).all(input.projectId, milestone.milestone_id) as ScopeEventRow[];
  const metricEvents = createScopeMetricEvents(database, input.projectId, scopeEvents, timezone);

  return {
    projectId: input.projectId,
    asOfDate,
    watermarkSequence,
    milestoneId: milestone.milestone_id,
    milestoneKey: milestone.milestone_key,
    targetDate: milestone.target_date,
    timezone,
    series: startDate > asOfDate ? [] : buildScopeMetricSeries(metricEvents, startDate, asOfDate),
    items: startDate > asOfDate ? [] : buildScopeMetricItems(metricEvents, asOfDate),
  };
  });
}

export function getProjectVelocityMetrics(
  database: SqliteDatabase,
  input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly limit?: number;
    readonly team?: { readonly teamId: string; readonly generationNumber: number };
    readonly teamId?: string;
    readonly closedBefore?: string;
  },
): ProjectVelocityMetrics {
  return withReadSnapshot(database, () => {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const observedAt = new Date().toISOString();
  const watermarkSequence = readProjectWatermark(database, input.projectId);
  const limit = input.limit ?? 12;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new ApplicationError("VALIDATION_FAILED", "Velocity sample size must be an integer between 1 and 50.");
  }
  if (input.team !== undefined && (input.team.teamId.trim().length === 0 ||
      !Number.isSafeInteger(input.team.generationNumber) || input.team.generationNumber < 0)) {
    throw new ApplicationError("VALIDATION_FAILED", "Velocity team and generation filter is invalid.");
  }
  if (input.closedBefore !== undefined && !Number.isFinite(Date.parse(input.closedBefore))) {
    throw new ApplicationError("VALIDATION_FAILED", "Velocity closedBefore filter must be a valid timestamp.");
  }
  const filters = ["sprint.project_id = ?", "sprint.status = 'closed'"];
  const parameters: unknown[] = [input.projectId];
  const selectedTeamId = input.team?.teamId ?? input.teamId;
  if (selectedTeamId !== undefined) {
    filters.push("sprint.team_id = ?");
    parameters.push(selectedTeamId);
  }
  if (input.team !== undefined) {
    filters.push("config.generation_number = ?");
    parameters.push(input.team.generationNumber);
  }
  if (input.closedBefore !== undefined) {
    filters.push("sprint.closed_at < ?");
    parameters.push(input.closedBefore);
  }
  parameters.push(limit);
  const rows = database.prepare(
    `SELECT sprint.sprint_id, sprint.sprint_key, sprint.closed_at, sprint.team_id,
            sprint.capacity_config_version, sprint.started_snapshot_json, sprint.closed_snapshot_json,
            config.generation_number
     FROM sprints sprint
     INNER JOIN team_config_versions config ON config.project_id = sprint.project_id
       AND config.team_id = sprint.team_id AND config.version = sprint.capacity_config_version
     WHERE ${filters.join(" AND ")}
     ORDER BY sprint.closed_at DESC, sprint.sprint_key COLLATE NOCASE LIMIT ?`,
  ).all(...parameters) as Array<{
    sprint_id: string;
    sprint_key: string;
    closed_at: string;
    team_id: string;
    capacity_config_version: number;
    started_snapshot_json: string | null;
    closed_snapshot_json: string | null;
    generation_number: number;
  }>;
  const parsed = rows.map((row) => ({
    row,
    closedSnapshot: parseJsonObject(row.closed_snapshot_json),
    startSnapshot: parseJsonObject(row.started_snapshot_json),
  }));
  const acceptedIds = unique(
    parsed.flatMap(({ closedSnapshot }) => arrayFromObject(closedSnapshot, "acceptedItems")
      .map((item) => stringProperty(item, "itemId"))
      .filter((itemId): itemId is string => itemId !== null)),
  );
  const transitions = readItemTransitions(database, input.projectId, acceptedIds);
  const estimates = readPointEstimateEvents(database, input.projectId, acceptedIds);
  const entries: SprintVelocityEntry[] = parsed.map(({ row, closedSnapshot, startSnapshot }) => {
    const acceptedItems = arrayFromObject(closedSnapshot, "acceptedItems");
    let deliveredPoints = 0;
    let deliveredCount = 0;
    for (const accepted of acceptedItems) {
      const itemId = stringProperty(accepted, "itemId");
      const fallbackPoints = numberProperty(accepted, "points") ?? 0;
      if (itemId === null) continue;
      const completionAt = finalDoneTransitionAt(transitions.get(itemId) ?? [], row.closed_at);
      if (completionAt === null) {
        const itemTransitions = transitions.get(itemId) ?? [];
        if (itemTransitions.length > 0) continue;
        deliveredPoints += fallbackPoints;
        deliveredCount += 1;
        continue;
      }
      const completionPoints = latestPointsAt(estimates.get(itemId) ?? [], completionAt) ?? fallbackPoints;
      deliveredPoints += completionPoints;
      deliveredCount += 1;
    }
    const startSnapshotValue = objectProperty(startSnapshot, "capacity");
    const capacityHours = numberProperty(startSnapshotValue, "totalHours") ?? 0;
    return {
      sprintId: row.sprint_id,
      sprintKey: row.sprint_key,
      closedAt: row.closed_at,
      teamId: row.team_id,
      teamGenerationNumber: row.generation_number,
      capacityHours,
      deliveredPoints,
      acceptedPbiCount: deliveredCount,
      pointsPerHour: capacityHours <= 0 ? null : roundMetric(deliveredPoints / capacityHours),
    };
  });
  entries.sort((left, right) => left.closedAt.localeCompare(right.closedAt) || left.sprintKey.localeCompare(right.sprintKey));

  const generationGroups = new Map<string, SprintVelocityEntry[]>();
  for (const entry of entries) {
    const groupKey = `${entry.teamId}:${entry.teamGenerationNumber}`;
    const group = generationGroups.get(groupKey) ?? [];
    group.push(entry);
    generationGroups.set(groupKey, group);
  }
  const byTeamGeneration: TeamGenerationVelocity[] = [...generationGroups.entries()]
    .map(([, generationEntries]) => ({
      teamId: generationEntries[0]!.teamId,
      generationNumber: generationEntries[0]!.teamGenerationNumber,
      entries: generationEntries,
    }))
    .sort((left, right) => left.teamId.localeCompare(right.teamId) || left.generationNumber - right.generationNumber)
    .map(({ teamId, generationNumber, entries: generationEntries }) => {
      const points = generationEntries.map((entry) => entry.deliveredPoints).sort((left, right) => left - right);
      return {
        teamId,
        generationNumber,
        sprintCount: points.length,
        totalDeliveredPoints: sum(points),
        averagePointsPerSprint: roundMetric(sum(points) / points.length),
        medianPointsPerSprint: median(points),
      };
    });
  return {
    projectId: input.projectId,
    observedAt,
    watermarkSequence,
    sampleSize: entries.length,
    sprints: entries,
    byTeamGeneration,
  };
  });
}

export function getProjectWipMetrics(
  database: SqliteDatabase,
  input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly itemLimit?: number;
  },
): ProjectWipMetrics {
  return withReadSnapshot(database, () => {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const observedAt = new Date().toISOString();
  const watermarkSequence = readProjectWatermark(database, input.projectId);
  const itemLimit = input.itemLimit ?? 1_000;
  if (!Number.isSafeInteger(itemLimit) || itemLimit < 1 || itemLimit > 5_000) {
    throw new ApplicationError("VALIDATION_FAILED", "WIP item limit must be an integer between 1 and 5000.");
  }
  const timezone = readProjectTimezone(database, input.projectId);
  const observedDate = localDate(observedAt, timezone);
  const countsByState = emptyWipCounts();
  const countRows = database.prepare(
    `SELECT state, COUNT(*) AS count FROM work_items
     WHERE project_id = ? AND type IN ('story', 'bug', 'task')
       AND state IN ('ready', 'in_progress', 'in_review', 'in_validation')
     GROUP BY state`,
  ).all(input.projectId) as Array<{ state: MetricWipState; count: number }>;
  for (const row of countRows) countsByState[row.state] = row.count;
  const totalWipCount = sum(Object.values(countsByState));
  const blockedRow = database.prepare(
    `SELECT COUNT(DISTINCT wi.item_id) AS count FROM work_items wi
     WHERE wi.project_id = ? AND wi.type IN ('story', 'bug', 'task')
       AND wi.state IN ('ready', 'in_progress', 'in_review', 'in_validation')
       AND EXISTS (SELECT 1 FROM impact_flags impact
                   WHERE impact.project_id = wi.project_id AND impact.item_id = wi.item_id AND impact.status = 'open')`,
  ).get(input.projectId) as { count: number };
  const itemRows = database.prepare(
    `SELECT wi.item_id, wi.item_key, wi.title, wi.type, wi.state, wi.assignee_principal_id,
            COALESCE((SELECT transition.transitioned_at FROM work_item_state_transitions transition
                      WHERE transition.project_id = wi.project_id AND transition.item_id = wi.item_id
                        AND transition.to_state = wi.state
                      ORDER BY transition.item_version DESC LIMIT 1), wi.created_at) AS entered_state_at,
            (SELECT COUNT(*) FROM impact_flags impact
             WHERE impact.project_id = wi.project_id AND impact.item_id = wi.item_id AND impact.status = 'open') AS open_impact_count
     FROM work_items wi
     WHERE wi.project_id = ? AND wi.type IN ('story', 'bug', 'task')
       AND wi.state IN ('ready', 'in_progress', 'in_review', 'in_validation')
     ORDER BY CASE wi.state WHEN 'in_validation' THEN 1 WHEN 'in_review' THEN 2
                            WHEN 'in_progress' THEN 3 ELSE 4 END,
              wi.updated_at, wi.item_key COLLATE NOCASE
     LIMIT ?`,
  ).all(input.projectId, itemLimit + 1) as Array<{
    item_id: string;
    item_key: string;
    title: string;
    type: "story" | "bug" | "task";
    state: MetricWipState;
    assignee_principal_id: string | null;
    entered_state_at: string;
    open_impact_count: number;
  }>;
  const itemsTruncated = itemRows.length > itemLimit;
  const items: WipItemMetric[] = itemRows.slice(0, itemLimit).map((row) => ({
    itemId: row.item_id,
    itemKey: row.item_key,
    title: row.title,
    type: row.type,
    state: row.state,
    assigneeId: row.assignee_principal_id,
    enteredStateAt: row.entered_state_at,
    ageDays: Math.max(0, daysBetween(localDate(row.entered_state_at, timezone), observedDate)),
    openImpactCount: row.open_impact_count,
  }));
  return {
    projectId: input.projectId,
    observedAt,
    watermarkSequence,
    timezone,
    totalWipCount,
    blockedByOpenImpactCount: blockedRow.count,
    countsByState,
    items,
    itemsTruncated,
  };
  });
}

export function getProjectCoverageMetrics(
  database: SqliteDatabase,
  input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly buildId?: string;
  },
): ProjectCoverageMetrics {
  return withReadSnapshot(database, () => {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const observedAt = new Date().toISOString();
  const watermarkSequence = readProjectWatermark(database, input.projectId);
  const buildId = input.buildId?.trim() || null;
  if (input.buildId !== undefined && (buildId === null || buildId.length > 128)) {
    throw new ApplicationError("VALIDATION_FAILED", "Build ID must contain 1-128 characters.");
  }
  const latestRunBuildFilter = buildId === null ? "" : "AND build_id = ?";
  const itemLimit = 20;
  const rows = database.prepare(
    `WITH current_items AS (
       SELECT wi.project_id, wi.item_id, wi.item_key, wi.title, wi.type, wi.state,
              (SELECT baseline.baseline_id FROM work_baselines baseline
               WHERE baseline.project_id = wi.project_id AND baseline.item_id = wi.item_id
               ORDER BY baseline.sequence DESC LIMIT 1) AS baseline_id
       FROM work_items wi WHERE wi.project_id = ? AND wi.type IN ('story', 'bug')
     ), criteria AS (
       SELECT item.project_id, item.item_id, item.baseline_id,
              json_extract(criterion.value, '$.id') AS criterion_id,
              CASE WHEN json_extract(criterion.value, '$.required') THEN 1 ELSE 0 END AS is_required
       FROM current_items item
       INNER JOIN baseline_refs item_ref ON item_ref.project_id = item.project_id
         AND item_ref.baseline_id = item.baseline_id AND item_ref.entity_type = 'work_item_revision'
       INNER JOIN work_item_revisions revision ON revision.project_id = item_ref.project_id
         AND revision.item_id = item_ref.entity_id AND revision.revision_number = item_ref.revision_number
       JOIN json_each(revision.snapshot_json, '$.criteria') criterion
       WHERE item.baseline_id IS NOT NULL
       UNION ALL
       SELECT item.project_id, item.item_id, NULL, criterion.criterion_id, criterion.is_required
       FROM current_items item
       INNER JOIN work_item_criteria criterion ON criterion.project_id = item.project_id
         AND criterion.item_id = item.item_id AND criterion.is_active = 1
       WHERE item.baseline_id IS NULL
     ), eligible_scenarios AS (
       SELECT criterion.project_id, criterion.item_id, criterion.baseline_id, criterion.criterion_id,
              coverage.scenario_id, coverage.revision_number
       FROM criteria criterion
       INNER JOIN scenario_revision_coverage coverage ON coverage.project_id = criterion.project_id
         AND coverage.target_type = 'criterion' AND coverage.target_id = criterion.criterion_id
       INNER JOIN scenario_revisions revision ON revision.project_id = coverage.project_id
         AND revision.scenario_id = coverage.scenario_id AND revision.revision_number = coverage.revision_number
       WHERE (criterion.baseline_id IS NULL AND revision.status = 'published')
          OR (criterion.baseline_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM baseline_refs scenario_ref
            WHERE scenario_ref.project_id = criterion.project_id
              AND scenario_ref.baseline_id = criterion.baseline_id
              AND scenario_ref.entity_type = 'scenario_revision'
              AND scenario_ref.entity_id = coverage.scenario_id
              AND scenario_ref.revision_number = coverage.revision_number
          ))
     ), latest_runs AS (
       SELECT run.project_id, run.run_id, run.scenario_id, run.revision_number, run.build_id, run.result,
              ROW_NUMBER() OVER (
                PARTITION BY run.project_id, run.scenario_id, run.revision_number, run.build_id
                ORDER BY run.sequence DESC
              ) AS run_rank
       FROM test_runs run WHERE run.project_id = ? ${latestRunBuildFilter}
     ), quality_by_criterion AS (
       SELECT criterion.project_id, criterion.item_id, criterion.baseline_id,
              criterion.criterion_id, criterion.is_required,
              EXISTS (SELECT 1 FROM eligible_scenarios eligible
                      WHERE eligible.project_id = criterion.project_id
                        AND eligible.item_id = criterion.item_id
                        AND eligible.criterion_id = criterion.criterion_id) AS is_covered,
              EXISTS (
                SELECT 1 FROM eligible_scenarios eligible
                INNER JOIN latest_runs latest ON latest.project_id = eligible.project_id
                  AND latest.scenario_id = eligible.scenario_id
                  AND latest.revision_number = eligible.revision_number
                  AND latest.run_rank = 1 AND latest.result = 'passed'
                INNER JOIN test_run_certifications certification ON certification.project_id = eligible.project_id
                  AND certification.item_id = eligible.item_id AND certification.baseline_id = eligible.baseline_id
                  AND certification.run_id = latest.run_id
                WHERE eligible.project_id = criterion.project_id
                  AND eligible.item_id = criterion.item_id
                  AND eligible.criterion_id = criterion.criterion_id
                  AND eligible.baseline_id IS NOT NULL
              ) AS is_certified
       FROM criteria criterion
     ), coverage_rows AS (
       SELECT item.item_id, item.item_key, item.title, item.type, item.state, item.baseline_id,
              EXISTS (SELECT 1 FROM impact_flags impact
                      WHERE impact.project_id = item.project_id AND impact.item_id = item.item_id
                        AND impact.status = 'open') AS has_open_impact,
              COALESCE(SUM(CASE WHEN quality.is_required = 1 THEN 1 ELSE 0 END), 0) AS required_criteria,
              COALESCE(SUM(CASE WHEN quality.is_required = 1 AND quality.is_covered THEN 1 ELSE 0 END), 0) AS covered_criteria,
              COALESCE(SUM(CASE WHEN quality.is_required = 1 AND quality.is_certified THEN 1 ELSE 0 END), 0) AS certified_criteria
       FROM current_items item LEFT JOIN quality_by_criterion quality
         ON quality.project_id = item.project_id AND quality.item_id = item.item_id
       GROUP BY item.project_id, item.item_id
     )
     SELECT coverage_rows.*,
            COUNT(*) OVER () AS items_total,
            COALESCE(SUM(required_criteria) OVER (), 0) AS total_required_criteria,
            COALESCE(SUM(covered_criteria) OVER (), 0) AS total_covered_criteria,
            COALESCE(SUM(certified_criteria) OVER (), 0) AS total_certified_criteria,
            COALESCE(SUM(CASE WHEN baseline_id IS NOT NULL THEN 1 ELSE 0 END) OVER (), 0) AS total_pinned_count,
            COALESCE(SUM(CASE WHEN baseline_id IS NULL THEN 1 ELSE 0 END) OVER (), 0) AS total_preview_count
     FROM coverage_rows
     ORDER BY item_key COLLATE NOCASE, item_id
     LIMIT ?`,
  );
  const parameters: unknown[] = [input.projectId, input.projectId];
  if (buildId !== null) parameters.push(buildId);
  parameters.push(itemLimit);
  const rowsForProject = rows.all(...parameters) as Array<{
    item_id: string;
    item_key: string;
    title: string;
    type: "story" | "bug";
    state: string;
    baseline_id: string | null;
    has_open_impact: number;
    required_criteria: number;
    covered_criteria: number;
    certified_criteria: number;
    items_total: number;
    total_required_criteria: number;
    total_covered_criteria: number;
    total_certified_criteria: number;
    total_pinned_count: number;
    total_preview_count: number;
  }>;
  const items: PbiCoverageMetric[] = rowsForProject.map((row) => ({
    itemId: row.item_id,
    itemKey: row.item_key,
    title: row.title,
    type: row.type,
    state: row.state,
    baselineId: row.baseline_id,
    hasOpenImpact: row.has_open_impact === 1,
    requiredCriteria: row.required_criteria,
    coveredRequiredCriteria: row.covered_criteria,
    certifiedRequiredCriteria: row.certified_criteria,
    coveragePercent: percentage(row.covered_criteria, row.required_criteria),
    certifiedCoveragePercent: percentage(row.certified_criteria, row.required_criteria),
  }));
  const summary = rowsForProject[0];
  const itemsTotal = summary?.items_total ?? 0;
  const requiredCriteria = summary?.total_required_criteria ?? 0;
  const coveredRequiredCriteria = summary?.total_covered_criteria ?? 0;
  const certifiedRequiredCriteria = summary?.total_certified_criteria ?? 0;
  return {
    projectId: input.projectId,
    observedAt,
    watermarkSequence,
    buildId,
    requiredCriteria,
    coveredRequiredCriteria,
    certifiedRequiredCriteria,
    coveragePercent: percentage(coveredRequiredCriteria, requiredCriteria),
    certifiedCoveragePercent: percentage(certifiedRequiredCriteria, requiredCriteria),
    pinnedPbiCount: summary?.total_pinned_count ?? 0,
    previewPbiCount: summary?.total_preview_count ?? 0,
    itemsTotal,
    itemsTruncated: itemsTotal > itemLimit,
    items,
  };
  });
}

function createScopeMetricEvents(
  database: SqliteDatabase,
  projectId: string,
  scopeRows: readonly ScopeEventRow[],
  timezone: string,
): TimedScopeMetricEvent[] {
  const itemIds = unique(scopeRows.map((row) => row.item_id));
  if (itemIds.length === 0) return [];
  const scopeEvents: ScopeMetricEvent[] = scopeRows.map((row) => ({
    kind: "scope",
    itemId: row.item_id,
    at: row.changed_at,
    priority: row.action === "add" ? 2 : 3,
    ordinal: row.sequence,
    action: row.action,
    itemKey: row.item_key,
    title: row.item_title,
    state: row.item_state,
    points: row.points,
  }));
  const transitions = readItemTransitions(database, projectId, itemIds);
  const transitionEvents: ScopeMetricEvent[] = [...transitions.entries()].flatMap(([itemId, rows]) => rows.map((row) => ({
    kind: "transition" as const,
    itemId,
    at: row.transitioned_at,
    priority: 1,
    ordinal: row.item_version,
    fromState: row.from_state,
    toState: row.to_state,
  })));
  const estimateEvents: ScopeMetricEvent[] = [...readPointEstimateEvents(database, projectId, itemIds).entries()]
    .flatMap(([itemId, rows]) => rows.map((row) => ({
      kind: "estimate" as const,
      itemId,
      at: row.occurredAt,
      priority: 0,
      ordinal: row.sequence,
      value: row.value,
    })));
  return [...scopeEvents, ...transitionEvents, ...estimateEvents].map((event) => ({
    ...event,
    localDate: localDate(event.at, timezone),
  })).sort((left, right) => left.at.localeCompare(right.at) || left.priority - right.priority || left.ordinal - right.ordinal);
}

function buildScopeMetricSeries(
  events: readonly TimedScopeMetricEvent[],
  startDate: string,
  endDate: string,
): readonly ScopeMetricPoint[] {
  const records = new Map<string, MutableScopeMetricItem>();
  const deltasByDate = new Map<string, ScopeMetricDeltas>();
  let eventIndex = 0;
  const series: ScopeMetricPoint[] = [];
  for (const date of enumerateDates(startDate, endDate)) {
    while (eventIndex < events.length && events[eventIndex]!.localDate <= date) {
      const event = events[eventIndex]!;
      const record = records.get(event.itemId);
      if (event.kind === "scope") {
        if (event.action === "add") {
          records.set(event.itemId, {
            active: true, itemKey: event.itemKey, title: event.title, points: event.points, state: event.state,
          });
          changeOnDate(deltasByDate, event.localDate, startDate).addedPoints += event.points;
        } else {
          const removedPoints = record?.active === true ? record.points : event.points;
          if (record !== undefined) records.set(event.itemId, { ...record, active: false });
          changeOnDate(deltasByDate, event.localDate, startDate).removedPoints += removedPoints;
        }
      } else if (event.kind === "estimate") {
        if (record?.active === true) {
          const delta = event.value - record.points;
          records.set(event.itemId, { ...record, points: event.value });
          changeOnDate(deltasByDate, event.localDate, startDate).reestimatedPoints += delta;
        }
      } else if (record?.active === true) {
        const changes = changeOnDate(deltasByDate, event.localDate, startDate);
        if (record.state === "done" && event.toState !== "done") {
          changes.reopenedPoints += record.points;
          changes.reopenedItemCount += 1;
        }
        if (record.state !== "done" && event.toState === "done") {
          changes.deliveryEventsPoints += record.points;
        }
        records.set(event.itemId, { ...record, state: event.toState });
      }
      eventIndex += 1;
    }
    const totals = aggregateScope(records);
    const changes = deltasByDate.get(date) ?? emptyScopeMetricDeltas();
    series.push({
      date,
      ...totals,
      ...changes,
    });
  }
  return series;
}

function buildScopeMetricItems(
  events: readonly TimedScopeMetricEvent[],
  asOfDate: string,
): readonly ScopeMetricItem[] {
  const records = new Map<string, MutableScopeMetricItem>();
  for (const event of events) {
    if (event.localDate > asOfDate) break;
    const record = records.get(event.itemId);
    if (event.kind === "scope") {
      if (event.action === "add") {
        records.set(event.itemId, {
          active: true, itemKey: event.itemKey, title: event.title, points: event.points, state: event.state,
        });
      } else if (record !== undefined) {
        records.set(event.itemId, { ...record, active: false });
      }
    } else if (event.kind === "estimate") {
      if (record?.active === true) records.set(event.itemId, { ...record, points: event.value });
    } else if (record?.active === true) {
      records.set(event.itemId, { ...record, state: event.toState });
    }
  }
  return [...records.entries()]
    .filter(([, item]) => item.active)
    .map(([itemId, item]) => ({
      itemId,
      itemKey: item.itemKey,
      title: item.title,
      state: item.state,
      points: item.points,
    }));
}

function currentScopePoints(scopeEvents: readonly ScopeEventRow[]): number {
  const current = new Map<string, number>();
  for (const event of scopeEvents) {
    if (event.action === "add") current.set(event.item_id, event.points);
    else current.delete(event.item_id);
  }
  return sum([...current.values()]);
}

function snapshotCommitmentPoints(snapshotJson: string): number {
  const snapshot = parseJsonObject(snapshotJson);
  return sum(arrayFromObject(snapshot, "commitments")
    .map((commitment) => numberProperty(commitment, "points") ?? 0));
}

function aggregateScope(records: ReadonlyMap<string, MutableScopeMetricItem>): Pick<ScopeMetricPoint,
  "scopePoints" | "remainingPoints" | "completedPoints" | "cancelledPoints" | "wipByState"> {
  const totals = {
    scopePoints: 0,
    remainingPoints: 0,
    completedPoints: 0,
    cancelledPoints: 0,
    wipByState: emptyWipCounts(),
  };
  for (const record of records.values()) {
    if (!record.active) continue;
    totals.scopePoints += record.points;
    if (record.state === "done") totals.completedPoints += record.points;
    else if (record.state === "cancelled") totals.cancelledPoints += record.points;
    else totals.remainingPoints += record.points;
    if (isWipState(record.state)) totals.wipByState[record.state] += 1;
  }
  return totals;
}

function changeOnDate(
  deltas: Map<string, ScopeMetricDeltas>,
  date: string,
  startDate: string,
): ScopeMetricDeltas {
  if (date < startDate) return emptyScopeMetricDeltas();
  let value = deltas.get(date);
  if (value === undefined) {
    value = emptyScopeMetricDeltas();
    deltas.set(date, value);
  }
  return value;
}

function emptyScopeMetricDeltas(): ScopeMetricDeltas {
  return {
    addedPoints: 0,
    removedPoints: 0,
    reestimatedPoints: 0,
    deliveryEventsPoints: 0,
    reopenedPoints: 0,
    reopenedItemCount: 0,
  };
}

function readWorkCalendar(
  database: SqliteDatabase,
  projectId: string,
  teamId: string,
  version: number,
): WorkCalendar {
  const config = database.prepare(
    `SELECT working_days_json FROM team_config_versions
     WHERE project_id = ? AND team_id = ? AND version = ?`,
  ).get(projectId, teamId, version) as { working_days_json: string } | undefined;
  if (config === undefined) throw new ApplicationError("NOT_FOUND", "Sprint capacity configuration was not found.");
  const workingDays = JSON.parse(config.working_days_json) as number[];
  const holidays = database.prepare(
    `SELECT holiday_date FROM team_holidays WHERE project_id = ? AND team_id = ? AND config_version = ?`,
  ).all(projectId, teamId, version) as Array<{ holiday_date: string }>;
  return {
    workingDays: new Set(workingDays),
    holidays: new Set(holidays.map((holiday) => holiday.holiday_date)),
  };
}

function calculateIdealRemainingPoints(
  date: string,
  startsOn: string,
  endsOn: string,
  calendar: WorkCalendar,
  plannedPoints: number,
): number | null {
  const totalWorkdays = enumerateDates(startsOn, endsOn).filter((value) => isWorkingDate(value, calendar)).length;
  if (totalWorkdays === 0) return null;
  let elapsedWorkdays = 0;
  for (const value of enumerateDates(startsOn, minDate(date, endsOn))) {
    if (isWorkingDate(value, calendar)) elapsedWorkdays += 1;
  }
  return roundMetric(plannedPoints * Math.max(0, totalWorkdays - elapsedWorkdays) / totalWorkdays);
}

function isWorkingDate(date: string, calendar: WorkCalendar): boolean {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  const isoDay = day === 0 ? 7 : day;
  return calendar.workingDays.has(isoDay) && !calendar.holidays.has(date);
}

function readItemTransitions(
  database: SqliteDatabase,
  projectId: string,
  itemIds: readonly string[],
): Map<string, WorkItemTransitionRow[]> {
  const grouped = new Map<string, WorkItemTransitionRow[]>();
  for (const itemBatch of chunks(unique(itemIds), 500)) {
    if (itemBatch.length === 0) continue;
    const placeholders = itemBatch.map(() => "?").join(",");
    const rows = database.prepare(
      `SELECT item_id, from_state, to_state, item_version, transitioned_at
       FROM work_item_state_transitions WHERE project_id = ? AND item_id IN (${placeholders})
       ORDER BY item_id, transitioned_at, item_version`,
    ).all(projectId, ...itemBatch) as WorkItemTransitionRow[];
    for (const row of rows) {
      const group = grouped.get(row.item_id) ?? [];
      group.push(row);
      grouped.set(row.item_id, group);
    }
  }
  return grouped;
}

function readPointEstimateEvents(
  database: SqliteDatabase,
  projectId: string,
  itemIds: readonly string[],
): Map<string, PointEstimateEvent[]> {
  const grouped = new Map<string, PointEstimateEvent[]>();
  for (const itemBatch of chunks(unique(itemIds), 500)) {
    if (itemBatch.length === 0) continue;
    const placeholders = itemBatch.map(() => "?").join(",");
    const rows = database.prepare(
      `SELECT sequence, entity_id, occurred_at, payload_json FROM audit_events
       WHERE project_id = ? AND event_type = ? AND entity_id IN (${placeholders})
       ORDER BY entity_id, occurred_at, sequence`,
    ).all(projectId, estimateAuditEventType, ...itemBatch) as Array<{
      sequence: number;
      entity_id: string;
      occurred_at: string;
      payload_json: string;
    }>;
    for (const row of rows) {
      const payload = parseJsonObject(row.payload_json);
      if (stringProperty(payload, "unit") !== "points") continue;
      const value = numberProperty(payload, "value");
      if (value === null || !Number.isSafeInteger(value) || value < 1) continue;
      const events = grouped.get(row.entity_id) ?? [];
      events.push({ itemId: row.entity_id, sequence: row.sequence, occurredAt: row.occurred_at, value });
      grouped.set(row.entity_id, events);
    }
  }
  return grouped;
}

function finalDoneTransitionAt(transitions: readonly WorkItemTransitionRow[], closedAt: string): string | null {
  const latest = transitions.filter((transition) => transition.transitioned_at <= closedAt)
    .at(-1);
  return latest?.to_state === "done" ? latest.transitioned_at : null;
}

function latestPointsAt(events: readonly PointEstimateEvent[], at: string): number | null {
  const event = events.filter((estimate) => estimate.occurredAt <= at).at(-1);
  return event?.value ?? null;
}

function readProjectTimezone(database: SqliteDatabase, projectId: string): string {
  const row = database.prepare("SELECT timezone FROM projects WHERE project_id = ?")
    .get(projectId) as ProjectMetricsRow | undefined;
  if (row === undefined) throw new ApplicationError("NOT_FOUND", "Project was not found.");
  return row.timezone;
}

function readProjectWatermark(database: SqliteDatabase, projectId: string): number {
  const row = database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM audit_events WHERE project_id = ?")
    .get(projectId) as { sequence: number };
  return row.sequence;
}

function withReadSnapshot<T>(database: SqliteDatabase, read: () => T): T {
  return database.transaction(read)();
}

export function normalizeMetricsAsOfDate(value: string | undefined, timezone: string): string {
  if (value === undefined) return localDate(new Date(), timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "Metrics asOfDate must use YYYY-MM-DD format.");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApplicationError("VALIDATION_FAILED", "Metrics asOfDate must be a valid calendar date.");
  }
  return value;
}

function localDate(value: string | Date, timezone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApplicationError("VALIDATION_FAILED", "Metric event timestamp is invalid.");
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
    throw new ApplicationError("VALIDATION_FAILED", "Project timezone could not format metric dates.");
  }
  return `${year}-${month}-${day}`;
}

function enumerateDates(startDate: string, endDate: string): string[] {
  if (startDate > endDate) return [];
  const dayCount = daysBetween(startDate, endDate) + 1;
  if (dayCount > 3_660) throw new ApplicationError("VALIDATION_FAILED", "Metric series cannot exceed ten years.");
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  for (let index = 0; index < dayCount; index += 1) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function daysBetween(startDate: string, endDate: string): number {
  return Math.floor((Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86_400_000);
}

function minDate(left: string, right: string): string {
  return left <= right ? left : right;
}

function isWipState(state: string): state is MetricWipState {
  return (wipStates as readonly string[]).includes(state);
}

function emptyWipCounts(): Record<MetricWipState, number> {
  return { ready: 0, in_progress: 0, in_review: 0, in_validation: 0 };
}

function percentage(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round(numerator / denominator * 100);
}

function roundMetric(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function median(sortedValues: readonly number[]): number {
  if (sortedValues.length === 0) return 0;
  const middle = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 0
    ? roundMetric((sortedValues[middle - 1]! + sortedValues[middle]!) / 2)
    : sortedValues[middle]!;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
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
  if (value === null) return null;
  const property = value[key];
  return typeof property === "string" ? property : null;
}

function numberProperty(value: Record<string, unknown> | null, key: string): number | null {
  const property = value?.[key];
  return typeof property === "number" && Number.isFinite(property) ? property : null;
}
