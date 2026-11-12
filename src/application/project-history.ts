import type { ScenarioKind, TestRunResult } from "../domain/scenarios.js";
import type { WorkItemState, WorkItemType } from "../domain/work-items.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { assertProjectAuthorization } from "./local-identity.js";

const workItemStates: readonly WorkItemState[] = [
  "draft", "ready", "in_progress", "in_review", "in_validation", "done", "cancelled",
];
const testRunResults: readonly TestRunResult[] = ["passed", "failed", "blocked", "skipped"];
const historyListLimit = 200;
const activityLimit = 30;

export interface HistoricalWorkItem {
  readonly id: string;
  readonly key: string;
  readonly type: WorkItemType;
  readonly parentId: string | null;
  readonly relatedStoryId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly state: WorkItemState;
  readonly priority: number;
  readonly revisionNumber: number;
  readonly criteria: readonly {
    readonly id: string;
    readonly key: string;
    readonly description: string;
    readonly required: boolean;
    readonly position: number;
  }[];
  readonly createdAt: string;
  readonly contentUnavailable: boolean;
}

export interface ProjectHistorySnapshot {
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly timezone: string;
  readonly asOfDate: string;
  readonly cutoffAt: string;
  readonly capturedAt: string;
  readonly historyFromDate: string;
  readonly latestActivityDate: string | null;
  readonly sourceWatermark: number;
  readonly asOfWatermark: number;
  readonly summary: {
    readonly workItemsTotal: number;
    readonly workItemsByState: Readonly<Record<WorkItemState, number>>;
    readonly specificationsTotal: number;
    readonly specificationsPublished: number;
    readonly scenariosTotal: number;
    readonly scenariosPublished: number;
    readonly testRunsTotal: number;
    readonly testRunsByResult: Readonly<Record<TestRunResult, number>>;
    readonly developmentSessionsTotal: number;
    readonly developmentSessionsActive: number;
    readonly deploymentsTotal: number;
    readonly deploymentsByEnvironment: Readonly<Record<"homologation" | "production", number>>;
    readonly deploymentsByOutcome: Readonly<Record<"succeeded" | "failed" | "rolled_back", number>>;
    readonly sprintsTotal: number;
    readonly sprintsByStatus: Readonly<Record<"draft" | "active" | "closed" | "cancelled", number>>;
    readonly milestonesTotal: number;
  };
  readonly workItems: {
    readonly items: readonly HistoricalWorkItem[];
    readonly nextCursor: string | null;
  };
  readonly specifications: readonly HistoricalSpecification[];
  readonly specificationsTruncated: boolean;
  readonly scenarios: readonly HistoricalScenario[];
  readonly scenariosTruncated: boolean;
  readonly testRuns: readonly HistoricalTestRun[];
  readonly testRunsTruncated: boolean;
  readonly activity: readonly HistoricalActivity[];
  readonly developmentSessions: readonly HistoricalDevelopmentSession[];
  readonly developmentSessionsTruncated: boolean;
  readonly deployments: readonly HistoricalDeployment[];
  readonly deploymentsTruncated: boolean;
  readonly sprints: readonly HistoricalSprint[];
  readonly sprintsTruncated: boolean;
  readonly milestones: readonly HistoricalMilestone[];
  readonly milestonesTruncated: boolean;
}

export interface HistoricalSpecification {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly title: string;
  readonly revisionNumber: number | null;
  readonly createdAt: string;
}

export interface HistoricalScenario {
  readonly id: string;
  readonly key: string;
  readonly kind: ScenarioKind;
  readonly title: string;
  readonly revisionNumber: number | null;
  readonly createdAt: string;
}

export interface HistoricalTestRun {
  readonly id: string;
  readonly scenarioKey: string;
  readonly scenarioTitle: string;
  readonly revisionNumber: number;
  readonly buildId: string;
  readonly result: TestRunResult;
  readonly executedBy: string;
  readonly executedAt: string;
  readonly workItemKeys: readonly string[];
}

export interface HistoricalActivity {
  readonly sequence: number;
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly principalName: string;
  readonly reason: string | null;
  readonly occurredAt: string;
}

export interface HistoricalDevelopmentSession {
  readonly id: string;
  readonly itemKey: string;
  readonly developerName: string;
  readonly reference: string | null;
  readonly status: "active" | "paused" | "completed" | "cancelled";
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly activeSeconds: number;
}

export interface HistoricalDeployment {
  readonly id: string;
  readonly environment: "homologation" | "production";
  readonly buildId: string;
  readonly outcome: "succeeded" | "failed" | "rolled_back";
  readonly deployedAt: string;
  readonly principalName: string;
  readonly itemKeys: readonly string[];
  readonly notes: string | null;
}

export interface HistoricalSprint {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly status: "draft" | "active" | "closed" | "cancelled";
  readonly startsOn: string;
  readonly endsOn: string;
  readonly scopeItemCount: number;
  readonly createdAt: string;
}

export interface HistoricalMilestone {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly targetDate: string;
  readonly scopeItemCount: number;
  readonly createdAt: string;
}

interface ProjectHistoryRow {
  readonly project_id: string;
  readonly project_key: string;
  readonly name: string;
  readonly timezone: string;
  readonly created_at: string;
}

interface HistoricalWorkItemRow {
  readonly item_id: string;
  readonly item_key: string;
  readonly type: WorkItemType;
  readonly created_at: string;
  readonly state: WorkItemState;
  readonly revision_number: number | null;
  readonly snapshot_json: string | null;
}

interface ProjectHistoryCursor {
  readonly version: 1;
  readonly projectId: string;
  readonly asOfDate: string;
  readonly sourceWatermark: number;
  readonly capturedAt: string;
  readonly afterKey: string;
}

export function getProjectHistorySnapshot(
  database: SqliteDatabase,
  input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly asOfDate?: string;
    readonly workItemCursor?: string;
  },
): ProjectHistorySnapshot {
  return database.transaction(() => {
    assertProjectAuthorization(database, input.projectId, input.principalId);
    const project = database.prepare(
      `SELECT project_id, project_key, name, timezone, created_at FROM projects WHERE project_id = ?`,
    ).get(input.projectId) as ProjectHistoryRow | undefined;
    if (project === undefined) throw new ApplicationError("NOT_FOUND", "Project was not found.");

    const requestTime = new Date();
    const asOfDate = input.asOfDate === undefined
      ? formatProjectDate(requestTime, project.timezone)
      : validateCalendarDate(input.asOfDate);
    const cutoffAt = endOfProjectDate(asOfDate, project.timezone);
    const today = formatProjectDate(requestTime, project.timezone);
    if (asOfDate > today) {
      throw new ApplicationError("VALIDATION_FAILED", "History asOfDate cannot be in the future.");
    }
    const cursorValue = input.workItemCursor?.trim();
    const cursor = cursorValue ? decodeHistoryCursor(cursorValue) : null;
    if (cursor !== null && (cursor.projectId !== input.projectId || cursor.asOfDate !== asOfDate)) {
      throw new ApplicationError("VALIDATION_FAILED", "History cursor does not match this project and date.");
    }
    const auditWatermarks = database.prepare(
      `SELECT COALESCE(MAX(sequence), 0) AS source_watermark,
              COALESCE(MAX(CASE WHEN occurred_at <= ? THEN sequence END), 0) AS as_of_watermark,
              MAX(occurred_at) AS latest_activity_at
       FROM audit_events WHERE project_id = ?`,
    ).get(cutoffAt, input.projectId) as {
      source_watermark: number;
      as_of_watermark: number;
      latest_activity_at: string | null;
    };
    if (cursor !== null && cursor.sourceWatermark !== auditWatermarks.source_watermark) {
      throw new ApplicationError("STALE_CURSOR", "The project changed after this historical snapshot was read. Restart without a cursor.");
    }
    const capturedAt = cursor === null ? requestTime : new Date(cursor.capturedAt);

    const workItemSummary = summarizeWorkItems(database, input.projectId, cutoffAt);
    const specifications = readSpecifications(database, input.projectId, cutoffAt);
    const scenarios = readScenarios(database, input.projectId, cutoffAt);
    const testRunSummary = summarizeTestRuns(database, input.projectId, cutoffAt);
    const workItems = readWorkItems(database, input.projectId, cutoffAt, cursor?.afterKey ?? null);
    const testRuns = readTestRuns(database, input.projectId, cutoffAt);
    const activity = readActivity(database, input.projectId, project.timezone, cutoffAt);
    const developmentSessions = readDevelopmentSessions(database, input.projectId, cutoffAt, capturedAt);
    const deployments = readDeployments(database, input.projectId, cutoffAt);
    const sprints = readSprints(database, input.projectId, cutoffAt);
    const milestones = readMilestones(database, input.projectId, cutoffAt);
    const nextCursor = workItems.nextCursor === null ? null : encodeHistoryCursor({
      version: 1,
      projectId: input.projectId,
      asOfDate,
      sourceWatermark: auditWatermarks.source_watermark,
      capturedAt: capturedAt.toISOString(),
      afterKey: workItems.nextCursor,
    });

    return {
      projectId: project.project_id,
      projectKey: project.project_key,
      projectName: project.name,
      timezone: project.timezone,
      asOfDate,
      cutoffAt,
      capturedAt: capturedAt.toISOString(),
      historyFromDate: formatProjectDate(new Date(project.created_at), project.timezone),
      latestActivityDate: auditWatermarks.latest_activity_at === null
        ? null
        : formatProjectDate(new Date(auditWatermarks.latest_activity_at), project.timezone),
      sourceWatermark: auditWatermarks.source_watermark,
      asOfWatermark: auditWatermarks.as_of_watermark,
      summary: {
        workItemsTotal: workItemSummary.total,
        workItemsByState: workItemSummary.byState,
        specificationsTotal: specifications.total,
        specificationsPublished: specifications.published,
        scenariosTotal: scenarios.total,
        scenariosPublished: scenarios.published,
        testRunsTotal: testRunSummary.total,
        testRunsByResult: testRunSummary.byResult,
        developmentSessionsTotal: developmentSessions.total,
        developmentSessionsActive: developmentSessions.active,
        deploymentsTotal: deployments.total,
        deploymentsByEnvironment: deployments.byEnvironment,
        deploymentsByOutcome: deployments.byOutcome,
        sprintsTotal: sprints.total,
        sprintsByStatus: sprints.byStatus,
        milestonesTotal: milestones.total,
      },
      workItems: { items: workItems.items, nextCursor },
      specifications: specifications.items,
      specificationsTruncated: specifications.truncated,
      scenarios: scenarios.items,
      scenariosTruncated: scenarios.truncated,
      testRuns: testRuns.items,
      testRunsTruncated: testRuns.truncated,
      activity,
      developmentSessions: developmentSessions.items,
      developmentSessionsTruncated: developmentSessions.truncated,
      deployments: deployments.items,
      deploymentsTruncated: deployments.truncated,
      sprints: sprints.items,
      sprintsTruncated: sprints.truncated,
      milestones: milestones.items,
      milestonesTruncated: milestones.truncated,
    };
  })();
}

function summarizeWorkItems(
  database: SqliteDatabase,
  projectId: string,
  cutoffAt: string,
): { readonly total: number; readonly byState: Record<WorkItemState, number> } {
  const byState = emptyWorkItemCounts();
  const rows = database.prepare(
    `SELECT historical.state, COUNT(*) AS count
     FROM (
       SELECT item.item_id,
         COALESCE((SELECT transition.to_state FROM work_item_state_transitions transition
                   WHERE transition.project_id = item.project_id AND transition.item_id = item.item_id
                     AND transition.transitioned_at <= ?
                   ORDER BY transition.transitioned_at DESC, transition.item_version DESC LIMIT 1), 'draft') AS state
       FROM work_items item WHERE item.project_id = ? AND item.created_at <= ?
     ) historical GROUP BY historical.state`,
  ).all(cutoffAt, projectId, cutoffAt) as Array<{ state: WorkItemState; count: number }>;
  for (const row of rows) if (workItemStates.includes(row.state)) byState[row.state] = row.count;
  return { total: Object.values(byState).reduce((total, count) => total + count, 0), byState };
}

function readWorkItems(
  database: SqliteDatabase,
  projectId: string,
  cutoffAt: string,
  cursor: string | null,
): { readonly items: readonly HistoricalWorkItem[]; readonly nextCursor: string | null } {
  const rows = database.prepare(
    `SELECT item.item_id, item.item_key, item.type, item.created_at,
       COALESCE((SELECT transition.to_state FROM work_item_state_transitions transition
                 WHERE transition.project_id = item.project_id AND transition.item_id = item.item_id
                   AND transition.transitioned_at <= ?
                 ORDER BY transition.transitioned_at DESC, transition.item_version DESC LIMIT 1), 'draft') AS state,
       (SELECT revision.revision_number FROM work_item_revisions revision
        WHERE revision.project_id = item.project_id AND revision.item_id = item.item_id
          AND revision.published_at <= ? ORDER BY revision.published_at DESC, revision.revision_number DESC LIMIT 1) AS revision_number,
       (SELECT revision.snapshot_json FROM work_item_revisions revision
        WHERE revision.project_id = item.project_id AND revision.item_id = item.item_id
          AND revision.published_at <= ? ORDER BY revision.published_at DESC, revision.revision_number DESC LIMIT 1) AS snapshot_json
     FROM work_items item
     WHERE item.project_id = ? AND item.created_at <= ? AND (? IS NULL OR item.item_key COLLATE NOCASE > ? COLLATE NOCASE)
     ORDER BY item.item_key COLLATE NOCASE LIMIT ?`,
  ).all(cutoffAt, cutoffAt, cutoffAt, projectId, cutoffAt, cursor, cursor, historyListLimit + 1) as HistoricalWorkItemRow[];
  const hasMore = rows.length > historyListLimit;
  const page = rows.slice(0, historyListLimit);
  const items = page.map(toHistoricalWorkItem);
  return { items, nextCursor: hasMore ? page.at(-1)?.item_key ?? null : null };
}

function toHistoricalWorkItem(row: HistoricalWorkItemRow): HistoricalWorkItem {
  const snapshot = row.snapshot_json === null ? null : parseObject(row.snapshot_json);
  const criteria = Array.isArray(snapshot?.criteria) ? snapshot.criteria.flatMap((value) => {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.key !== "string" ||
        typeof value.description !== "string" || typeof value.required !== "boolean" ||
        typeof value.position !== "number") return [];
    return [{ id: value.id, key: value.key, description: value.description, required: value.required, position: value.position }];
  }) : [];
  const contentUnavailable = snapshot === null || row.revision_number === null;
  return {
    id: row.item_id,
    key: row.item_key,
    type: row.type,
    parentId: contentUnavailable ? null : nullableString(snapshot.parentId),
    relatedStoryId: contentUnavailable ? null : nullableString(snapshot.relatedStoryId),
    title: contentUnavailable ? "Conteúdo versionado indisponível" : stringValue(snapshot.title, "Conteúdo sem título"),
    description: contentUnavailable ? null : nullableString(snapshot.description),
    state: row.state,
    priority: contentUnavailable ? 0 : numericValue(snapshot.priority, 0),
    revisionNumber: row.revision_number ?? 0,
    criteria,
    createdAt: row.created_at,
    contentUnavailable,
  };
}

function readSpecifications(
  database: SqliteDatabase,
  projectId: string,
  cutoffAt: string,
): { readonly items: readonly HistoricalSpecification[]; readonly total: number; readonly published: number; readonly truncated: boolean } {
  const rows = database.prepare(
    `SELECT specification.spec_id, specification.spec_key, specification.kind, specification.title, specification.created_at,
       (SELECT revision.revision_number FROM specification_revisions revision
        WHERE revision.project_id = specification.project_id AND revision.spec_id = specification.spec_id
          AND revision.published_at <= ? ORDER BY revision.published_at DESC, revision.revision_number DESC LIMIT 1) AS revision_number
     FROM specifications specification
     WHERE specification.project_id = ? AND specification.created_at <= ?
     ORDER BY specification.spec_key COLLATE NOCASE LIMIT ?`,
  ).all(cutoffAt, projectId, cutoffAt, historyListLimit + 1) as Array<{
    spec_id: string; spec_key: string; kind: string; title: string; created_at: string; revision_number: number | null;
  }>;
  const items = rows.slice(0, historyListLimit).map((row): HistoricalSpecification => ({
    id: row.spec_id, key: row.spec_key, kind: row.kind, title: row.title,
    revisionNumber: row.revision_number, createdAt: row.created_at,
  }));
  const counts = countRows(database, "specifications", projectId, cutoffAt);
  return { items, total: counts.total, published: counts.published, truncated: rows.length > historyListLimit };
}

function readScenarios(
  database: SqliteDatabase,
  projectId: string,
  cutoffAt: string,
): { readonly items: readonly HistoricalScenario[]; readonly total: number; readonly published: number; readonly truncated: boolean } {
  const rows = database.prepare(
    `SELECT scenario.scenario_id, scenario.scenario_key, scenario.kind, scenario.created_at,
       (SELECT revision.revision_number FROM scenario_revisions revision
        WHERE revision.project_id = scenario.project_id AND revision.scenario_id = scenario.scenario_id
          AND revision.published_at <= ? ORDER BY revision.published_at DESC, revision.revision_number DESC LIMIT 1) AS revision_number
       ,COALESCE(
         (SELECT revision.snapshot_json FROM scenario_revisions revision
          WHERE revision.project_id = scenario.project_id AND revision.scenario_id = scenario.scenario_id
            AND revision.published_at <= ? ORDER BY revision.published_at DESC, revision.revision_number DESC LIMIT 1),
         (SELECT revision.snapshot_json FROM scenario_revisions revision
          WHERE revision.project_id = scenario.project_id AND revision.scenario_id = scenario.scenario_id
            AND revision.revision_number = 1 AND revision.created_at <= ? LIMIT 1)
       ) AS snapshot_json
     FROM scenarios scenario
     WHERE scenario.project_id = ? AND scenario.created_at <= ?
     ORDER BY scenario.scenario_key COLLATE NOCASE LIMIT ?`,
  ).all(cutoffAt, cutoffAt, cutoffAt, projectId, cutoffAt, historyListLimit + 1) as Array<{
    scenario_id: string; scenario_key: string; kind: ScenarioKind; created_at: string; revision_number: number | null; snapshot_json: string | null;
  }>;
  const items = rows.slice(0, historyListLimit).map((row): HistoricalScenario => ({
    id: row.scenario_id, key: row.scenario_key, kind: row.kind,
    title: scenarioTitle(row.snapshot_json, "Cenário sem revisão publicada no corte"),
    revisionNumber: row.revision_number, createdAt: row.created_at,
  }));
  const counts = countRows(database, "scenarios", projectId, cutoffAt);
  return { items, total: counts.total, published: counts.published, truncated: rows.length > historyListLimit };
}

function countRows(
  database: SqliteDatabase,
  table: "specifications" | "scenarios",
  projectId: string,
  cutoffAt: string,
): { readonly total: number; readonly published: number } {
  const revisionTable = table === "specifications" ? "specification_revisions" : "scenario_revisions";
  const entityId = table === "specifications" ? "spec_id" : "scenario_id";
  const row = database.prepare(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN EXISTS (
         SELECT 1 FROM ${revisionTable} revision
         WHERE revision.project_id = entity.project_id AND revision.${entityId} = entity.${entityId}
           AND revision.published_at <= ?
       ) THEN 1 ELSE 0 END) AS published
     FROM ${table} entity WHERE entity.project_id = ? AND entity.created_at <= ?`,
  ).get(cutoffAt, projectId, cutoffAt) as { total: number; published: number | null };
  return { total: row.total, published: row.published ?? 0 };
}

function summarizeTestRuns(
  database: SqliteDatabase,
  projectId: string,
  cutoffAt: string,
): { readonly total: number; readonly byResult: Record<TestRunResult, number> } {
  const byResult = emptyTestRunCounts();
  const rows = database.prepare(
    `SELECT result, COUNT(*) AS count FROM test_runs WHERE project_id = ? AND executed_at <= ? GROUP BY result`,
  ).all(projectId, cutoffAt) as Array<{ result: TestRunResult; count: number }>;
  for (const row of rows) if (testRunResults.includes(row.result)) byResult[row.result] = row.count;
  return { total: Object.values(byResult).reduce((total, count) => total + count, 0), byResult };
}

function readTestRuns(
  database: SqliteDatabase,
  projectId: string,
  cutoffAt: string,
): { readonly items: readonly HistoricalTestRun[]; readonly truncated: boolean } {
  const rows = database.prepare(
    `SELECT run.run_id, scenario.scenario_key, revision.snapshot_json, run.revision_number,
            run.build_id, run.result, principal.display_name, run.executed_at
     FROM test_runs run
     INNER JOIN scenarios scenario ON scenario.project_id = run.project_id AND scenario.scenario_id = run.scenario_id
     INNER JOIN scenario_revisions revision ON revision.project_id = run.project_id
       AND revision.scenario_id = run.scenario_id AND revision.revision_number = run.revision_number
     INNER JOIN principals principal ON principal.principal_id = run.executed_by_principal_id
     WHERE run.project_id = ? AND run.executed_at <= ?
     ORDER BY run.executed_at DESC, run.sequence DESC LIMIT ?`,
  ).all(projectId, cutoffAt, historyListLimit + 1) as Array<{
    run_id: string; scenario_key: string; snapshot_json: string; revision_number: number; build_id: string;
    result: TestRunResult; display_name: string; executed_at: string;
  }>;
  const page = rows.slice(0, historyListLimit);
  const links = readTestRunWorkItemKeys(database, projectId, page.map((row) => row.run_id), cutoffAt);
  return {
    items: page.map((row): HistoricalTestRun => ({
      id: row.run_id, scenarioKey: row.scenario_key,
      scenarioTitle: scenarioTitle(row.snapshot_json, "Cenário"),
      revisionNumber: row.revision_number, buildId: row.build_id, result: row.result,
      executedBy: row.display_name, executedAt: row.executed_at, workItemKeys: links.get(row.run_id) ?? [],
    })),
    truncated: rows.length > historyListLimit,
  };
}

function readTestRunWorkItemKeys(
  database: SqliteDatabase,
  projectId: string,
  runIds: readonly string[],
  cutoffAt: string,
): Map<string, string[]> {
  const byRun = new Map<string, string[]>();
  for (const batch of chunks(runIds, 400)) {
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => "?").join(",");
    const rows = database.prepare(
      `SELECT link.run_id, item.item_key FROM test_run_work_items link
       INNER JOIN work_items item ON item.project_id = link.project_id AND item.item_id = link.item_id
       INNER JOIN test_runs run ON run.run_id = link.run_id
       WHERE link.project_id = ? AND link.run_id IN (${placeholders}) AND link.linked_at <= ?
       ORDER BY link.run_id, item.item_key COLLATE NOCASE`,
    ).all(projectId, ...batch, cutoffAt) as Array<{ run_id: string; item_key: string }>;
    for (const row of rows) {
      const keys = byRun.get(row.run_id) ?? [];
      keys.push(row.item_key);
      byRun.set(row.run_id, keys);
    }
  }
  return byRun;
}

function readActivity(
  database: SqliteDatabase,
  projectId: string,
  timezone: string,
  cutoffAt: string,
): readonly HistoricalActivity[] {
  const rows = database.prepare(
    `SELECT event.sequence, event.event_type, event.entity_type, event.entity_id, principal.display_name,
            event.reason, event.occurred_at
     FROM audit_events event INNER JOIN principals principal ON principal.principal_id = event.principal_id
     WHERE event.project_id = ? AND event.occurred_at <= ?
     ORDER BY event.occurred_at DESC, event.sequence DESC LIMIT ?`,
  ).all(projectId, cutoffAt, activityLimit) as Array<{
    sequence: number; event_type: string; entity_type: string; entity_id: string; display_name: string;
    reason: string | null; occurred_at: string;
  }>;
  return rows.map((row) => ({
    sequence: row.sequence, eventType: row.event_type, entityType: row.entity_type,
    entityId: row.entity_id, principalName: row.display_name, reason: row.reason, occurredAt: row.occurred_at,
  }));
}

function readDevelopmentSessions(
  database: SqliteDatabase,
  projectId: string,
  cutoffAt: string,
  capturedAt: Date,
): {
  readonly total: number;
  readonly active: number;
  readonly items: readonly HistoricalDevelopmentSession[];
  readonly truncated: boolean;
} {
  const sessions = database.prepare(
    `SELECT session.session_id, item.item_key, principal.display_name, session.session_reference, session.started_at
     FROM development_sessions session
     INNER JOIN work_items item ON item.project_id = session.project_id AND item.item_id = session.item_id
     INNER JOIN principals principal ON principal.principal_id = session.developer_principal_id
     WHERE session.project_id = ? AND session.started_at <= ?
     ORDER BY session.started_at DESC, session.session_id`,
  ).all(projectId, cutoffAt) as Array<{
    session_id: string; item_key: string; display_name: string; session_reference: string | null; started_at: string;
  }>;
  const events = database.prepare(
    `SELECT event.session_id, event.event_type, event.occurred_at
     FROM development_session_events event
     INNER JOIN development_sessions session ON session.project_id = event.project_id AND session.session_id = event.session_id
     WHERE event.project_id = ? AND event.occurred_at <= ? AND session.started_at <= ?
     ORDER BY event.occurred_at, event.sequence`,
  ).all(projectId, cutoffAt, cutoffAt) as Array<{
    session_id: string;
    event_type: "started" | "paused" | "resumed" | "completed" | "cancelled";
    occurred_at: string;
  }>;
  const eventsBySession = new Map<string, typeof events>();
  for (const event of events) {
    const group = eventsBySession.get(event.session_id) ?? [];
    group.push(event);
    eventsBySession.set(event.session_id, group);
  }
  const effectiveCutoff = Math.min(Date.parse(cutoffAt), capturedAt.getTime());
  const items = sessions.map((session): HistoricalDevelopmentSession => {
    let status: HistoricalDevelopmentSession["status"] = "active";
    let activeFrom: string | null = session.started_at;
    let endedAt: string | null = null;
    let activeSeconds = 0;
    for (const event of eventsBySession.get(session.session_id) ?? []) {
      if (event.event_type === "started" || event.event_type === "resumed") {
        status = "active";
        activeFrom = event.occurred_at;
        endedAt = null;
      } else if (event.event_type === "paused") {
        if (status === "active" && activeFrom !== null) activeSeconds += elapsedSeconds(activeFrom, event.occurred_at);
        status = "paused";
        activeFrom = null;
      } else {
        if (status === "active" && activeFrom !== null) activeSeconds += elapsedSeconds(activeFrom, event.occurred_at);
        status = event.event_type === "completed" ? "completed" : "cancelled";
        activeFrom = null;
        endedAt = event.occurred_at;
      }
    }
    if (status === "active" && activeFrom !== null) activeSeconds += elapsedSeconds(activeFrom, new Date(effectiveCutoff).toISOString());
    return {
      id: session.session_id,
      itemKey: session.item_key,
      developerName: session.display_name,
      reference: session.session_reference,
      status,
      startedAt: session.started_at,
      endedAt,
      activeSeconds,
    };
  });
  const active = items.filter((session) => session.status === "active").length;
  return {
    total: items.length,
    active,
    items: items.slice(0, historyListLimit),
    truncated: items.length > historyListLimit,
  };
}

function readDeployments(
  database: SqliteDatabase,
  projectId: string,
  cutoffAt: string,
): {
  readonly total: number;
  readonly byEnvironment: Record<"homologation" | "production", number>;
  readonly byOutcome: Record<"succeeded" | "failed" | "rolled_back", number>;
  readonly items: readonly HistoricalDeployment[];
  readonly truncated: boolean;
} {
  const byEnvironment = { homologation: 0, production: 0 };
  const byOutcome = { succeeded: 0, failed: 0, rolled_back: 0 };
  const counts = database.prepare(
    `SELECT environment, outcome, COUNT(*) AS count FROM deployment_events
     WHERE project_id = ? AND deployed_at <= ? GROUP BY environment, outcome`,
  ).all(projectId, cutoffAt) as Array<{
    environment: "homologation" | "production";
    outcome: "succeeded" | "failed" | "rolled_back";
    count: number;
  }>;
  for (const row of counts) {
    byEnvironment[row.environment] += row.count;
    byOutcome[row.outcome] += row.count;
  }
  const rows = database.prepare(
    `SELECT event.event_id, event.environment, event.build_id, event.outcome, event.deployed_at,
            event.notes, principal.display_name
     FROM deployment_events event INNER JOIN principals principal ON principal.principal_id = event.principal_id
     WHERE event.project_id = ? AND event.deployed_at <= ?
     ORDER BY event.deployed_at DESC, event.event_id LIMIT ?`,
  ).all(projectId, cutoffAt, historyListLimit + 1) as Array<{
    event_id: string; environment: "homologation" | "production"; build_id: string;
    outcome: "succeeded" | "failed" | "rolled_back"; deployed_at: string; notes: string | null; display_name: string;
  }>;
  const page = rows.slice(0, historyListLimit);
  const itemKeys = readDeploymentWorkItemKeys(database, projectId, page.map((event) => event.event_id));
  return {
    total: Object.values(byOutcome).reduce((total, count) => total + count, 0),
    byEnvironment,
    byOutcome,
    items: page.map((row): HistoricalDeployment => ({
      id: row.event_id,
      environment: row.environment,
      buildId: row.build_id,
      outcome: row.outcome,
      deployedAt: row.deployed_at,
      principalName: row.display_name,
      itemKeys: itemKeys.get(row.event_id) ?? [],
      notes: row.notes,
    })),
    truncated: rows.length > historyListLimit,
  };
}

function readSprints(
  database: SqliteDatabase,
  projectId: string,
  cutoffAt: string,
): {
  readonly total: number;
  readonly byStatus: Record<"draft" | "active" | "closed" | "cancelled", number>;
  readonly items: readonly HistoricalSprint[];
  readonly truncated: boolean;
} {
  const rows = database.prepare(
    `SELECT sprint_id, sprint_key, title, starts_on, ends_on, created_at, started_at, closed_at, cancelled_at FROM sprints
     WHERE project_id = ? AND created_at <= ? ORDER BY starts_on DESC, sprint_key COLLATE NOCASE LIMIT ?`,
  ).all(projectId, cutoffAt, historyListLimit + 1) as Array<{
    sprint_id: string; sprint_key: string; title: string; starts_on: string; ends_on: string; created_at: string;
    started_at: string | null; closed_at: string | null; cancelled_at: string | null;
  }>;
  const transitions = database.prepare(
    `SELECT sprint_id, to_state FROM sprint_state_transitions
     WHERE project_id = ? AND transitioned_at <= ? ORDER BY transitioned_at, sprint_version`,
  ).all(projectId, cutoffAt) as Array<{
    sprint_id: string; to_state: "draft" | "active" | "closed" | "cancelled";
  }>;
  const states = new Map<string, "draft" | "active" | "closed" | "cancelled">();
  for (const transition of transitions) states.set(transition.sprint_id, transition.to_state);
  const scopeEvents = database.prepare(
    `SELECT sprint_id, item_id, item_key, action FROM sprint_scope_events
     WHERE project_id = ? AND changed_at <= ? ORDER BY changed_at, sequence`,
  ).all(projectId, cutoffAt) as Array<{
    sprint_id: string; item_id: string; item_key: string; action: "add" | "remove";
  }>;
  const scope = new Map<string, Map<string, string>>();
  for (const event of scopeEvents) {
    const items = scope.get(event.sprint_id) ?? new Map<string, string>();
    if (event.action === "add") items.set(event.item_id, event.item_key);
    else items.delete(event.item_id);
    scope.set(event.sprint_id, items);
  }
  const total = countRowsByDate(database, "sprints", projectId, cutoffAt);
  const byStatus = { draft: 0, active: 0, closed: 0, cancelled: 0 };
  const allSprints = database.prepare(
    `SELECT sprint_id, started_at, closed_at, cancelled_at FROM sprints WHERE project_id = ? AND created_at <= ?`,
  ).all(projectId, cutoffAt) as Array<{
    sprint_id: string; started_at: string | null; closed_at: string | null; cancelled_at: string | null;
  }>;
  for (const sprint of allSprints) {
    byStatus[states.get(sprint.sprint_id) ?? sprintStatusFromTimestamps(sprint, cutoffAt)] += 1;
  }
  const page = rows.slice(0, historyListLimit);
  return {
    total,
    byStatus,
    items: page.map((row): HistoricalSprint => ({
      id: row.sprint_id,
      key: row.sprint_key,
      title: row.title,
      status: states.get(row.sprint_id) ?? sprintStatusFromTimestamps(row, cutoffAt),
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      scopeItemCount: scope.get(row.sprint_id)?.size ?? 0,
      createdAt: row.created_at,
    })),
    truncated: rows.length > historyListLimit,
  };
}

function sprintStatusFromTimestamps(
  sprint: { readonly started_at: string | null; readonly closed_at: string | null; readonly cancelled_at: string | null },
  cutoffAt: string,
): "draft" | "active" | "closed" | "cancelled" {
  if (sprint.cancelled_at !== null && sprint.cancelled_at <= cutoffAt) return "cancelled";
  if (sprint.closed_at !== null && sprint.closed_at <= cutoffAt) return "closed";
  if (sprint.started_at !== null && sprint.started_at <= cutoffAt) return "active";
  return "draft";
}

function readMilestones(
  database: SqliteDatabase,
  projectId: string,
  cutoffAt: string,
): { readonly total: number; readonly items: readonly HistoricalMilestone[]; readonly truncated: boolean } {
  const rows = database.prepare(
    `SELECT milestone_id, milestone_key, title, target_date, created_at FROM milestones
     WHERE project_id = ? AND created_at <= ? ORDER BY target_date, milestone_key COLLATE NOCASE LIMIT ?`,
  ).all(projectId, cutoffAt, historyListLimit + 1) as Array<{
    milestone_id: string; milestone_key: string; title: string; target_date: string; created_at: string;
  }>;
  const scopeEvents = database.prepare(
    `SELECT milestone_id, item_id, action FROM milestone_scope_events
     WHERE project_id = ? AND changed_at <= ? ORDER BY changed_at, sequence`,
  ).all(projectId, cutoffAt) as Array<{ milestone_id: string; item_id: string; action: "add" | "remove" }>;
  const scope = new Map<string, Set<string>>();
  for (const event of scopeEvents) {
    const items = scope.get(event.milestone_id) ?? new Set<string>();
    if (event.action === "add") items.add(event.item_id);
    else items.delete(event.item_id);
    scope.set(event.milestone_id, items);
  }
  const total = countRowsByDate(database, "milestones", projectId, cutoffAt);
  const page = rows.slice(0, historyListLimit);
  return {
    total,
    items: page.map((row): HistoricalMilestone => ({
      id: row.milestone_id,
      key: row.milestone_key,
      title: row.title,
      targetDate: row.target_date,
      scopeItemCount: scope.get(row.milestone_id)?.size ?? 0,
      createdAt: row.created_at,
    })),
    truncated: rows.length > historyListLimit,
  };
}

function countRowsByDate(
  database: SqliteDatabase,
  table: "sprints" | "milestones",
  projectId: string,
  cutoffAt: string,
): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ? AND created_at <= ?`)
    .get(projectId, cutoffAt) as { count: number };
  return row.count;
}

function readDeploymentWorkItemKeys(database: SqliteDatabase, projectId: string, eventIds: readonly string[]): Map<string, string[]> {
  const byEvent = new Map<string, string[]>();
  for (const batch of chunks(eventIds, 400)) {
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => "?").join(",");
    const rows = database.prepare(
      `SELECT link.event_id, item.item_key FROM deployment_event_work_items link
       INNER JOIN work_items item ON item.project_id = link.project_id AND item.item_id = link.item_id
       WHERE link.project_id = ? AND link.event_id IN (${placeholders}) ORDER BY link.event_id, item.item_key COLLATE NOCASE`,
    ).all(projectId, ...batch) as Array<{ event_id: string; item_key: string }>;
    for (const row of rows) {
      const keys = byEvent.get(row.event_id) ?? [];
      keys.push(row.item_key);
      byEvent.set(row.event_id, keys);
    }
  }
  return byEvent;
}

function elapsedSeconds(start: string, end: string): number {
  return Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / 1_000));
}

function encodeHistoryCursor(cursor: ProjectHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeHistoryCursor(value: string): ProjectHistoryCursor {
  if (value.length > 4_096 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "History work item cursor is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new ApplicationError("VALIDATION_FAILED", "History work item cursor is invalid.");
  }
  if (!isProjectHistoryCursor(parsed)) {
    throw new ApplicationError("VALIDATION_FAILED", "History work item cursor is invalid.");
  }
  const capturedAt = new Date(parsed.capturedAt);
  if (parsed.sourceWatermark < 0 || parsed.afterKey.length === 0 || parsed.afterKey.length > 200 ||
      [...parsed.afterKey].some((character) => character.charCodeAt(0) < 32) ||
      Number.isNaN(capturedAt.getTime()) || capturedAt.toISOString() !== parsed.capturedAt ||
      capturedAt.getTime() > Date.now()) {
    throw new ApplicationError("VALIDATION_FAILED", "History work item cursor is invalid.");
  }
  return parsed;
}

function isProjectHistoryCursor(value: unknown): value is ProjectHistoryCursor {
  if (!isRecord(value)) return false;
  return value.version === 1 && typeof value.projectId === "string" &&
    typeof value.asOfDate === "string" && typeof value.sourceWatermark === "number" &&
    Number.isSafeInteger(value.sourceWatermark) && typeof value.capturedAt === "string" &&
    typeof value.afterKey === "string";
}

function validateCalendarDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "History asOfDate must use YYYY-MM-DD format.");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApplicationError("VALIDATION_FAILED", "History asOfDate must be a valid calendar date.");
  }
  return value;
}

function endOfProjectDate(date: string, timezone: string): string {
  const nextDate = addCalendarDays(date, 1);
  const targetUtc = Date.parse(`${nextDate}T00:00:00.000Z`);
  let guess = targetUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const localAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day),
      Number(values.hour), Number(values.minute), Number(values.second));
    const adjustment = targetUtc - localAsUtc;
    if (adjustment === 0) break;
    guess += adjustment;
  }
  return new Date(guess - 1).toISOString();
}

function formatProjectDate(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function emptyWorkItemCounts(): Record<WorkItemState, number> {
  return { draft: 0, ready: 0, in_progress: 0, in_review: 0, in_validation: 0, done: 0, cancelled: 0 };
}

function emptyTestRunCounts(): Record<TestRunResult, number> {
  return { passed: 0, failed: 0, blocked: 0, skipped: 0 };
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  return isRecord(parsed) ? parsed : {};
}

function scenarioTitle(snapshotJson: string | null, fallback: string): string {
  if (snapshotJson === null) return fallback;
  return stringValue(parseObject(snapshotJson).title, fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numericValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
