import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { assertProjectAuthorization, type ProjectRole } from "./local-identity.js";
import { localDayStart, nextLocalDayStart } from "./forecast-queries.js";
import { getProject } from "./project-queries.js";
import { getWorkItem } from "./work-item-queries.js";
import { getTaskStartReadiness } from "./work-item-workflow.js";
import { getCurrentTaskWorkflowProgress } from "./task-workflow-queries.js";

export type DevelopmentSessionStatus = "active" | "paused" | "completed" | "cancelled";
export type DevelopmentSessionAction = "pause" | "resume" | "complete" | "cancel";
export type DeploymentEnvironment = "homologation" | "production";
export type DeploymentOutcome = "succeeded" | "failed" | "rolled_back";

export interface DevelopmentSession {
  readonly id: string;
  readonly projectId: string;
  readonly itemId: string;
  readonly itemKey: string;
  readonly itemTitle: string;
  readonly developerPrincipalId: string;
  readonly developerName: string;
  readonly sessionReference: string | null;
  readonly status: DevelopmentSessionStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly activeSeconds: number;
  readonly version: number;
  readonly taskWorkflowRevisionNumber: number | null;
  readonly technicalSpecifications: readonly { readonly id: string; readonly key: string; readonly revisionNumber: number }[];
  readonly scenarios: readonly { readonly id: string; readonly key: string; readonly revisionNumber: number }[];
}

export interface StartDevelopmentSessionInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly itemIdOrKey: string;
  readonly expectedVersion: number;
  readonly sessionReference?: string;
}

export interface TransitionDevelopmentSessionInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly action: DevelopmentSessionAction;
  readonly expectedVersion: number;
  readonly reason: string;
}

export interface RecordDeploymentInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly environment: DeploymentEnvironment;
  readonly buildId: string;
  readonly releaseVersion?: string;
  readonly pipelineRunId?: string;
  readonly outcome: DeploymentOutcome;
  readonly occurredAt?: string;
  readonly itemIdOrKeys: readonly string[];
  readonly milestoneIdOrKeys?: readonly string[];
  readonly rollbackOfEventId?: string;
  readonly notes?: string;
}

export interface DeploymentEvent {
  readonly id: string;
  readonly projectId: string;
  readonly environment: DeploymentEnvironment;
  readonly buildId: string;
  readonly releaseVersion: string | null;
  readonly pipelineRunId: string | null;
  readonly outcome: DeploymentOutcome;
  readonly occurredAt: string;
  readonly principalId: string;
  readonly principalName: string;
  readonly rollbackOfEventId: string | null;
  readonly itemIds: readonly string[];
  readonly milestoneIds: readonly string[];
  readonly notes: string | null;
}

interface SessionRow {
  readonly session_id: string;
  readonly project_id: string;
  readonly item_id: string;
  readonly item_key: string;
  readonly item_title: string;
  readonly developer_principal_id: string;
  readonly developer_name: string;
  readonly session_reference: string | null;
  readonly status: DevelopmentSessionStatus;
  readonly started_at: string;
  readonly last_resumed_at: string | null;
  readonly ended_at: string | null;
  readonly active_seconds: number;
  readonly version: number;
}

export function startDevelopmentSession(
  database: SqliteDatabase,
  input: StartDevelopmentSessionInput,
): CommandReceipt<DevelopmentSession> {
  const reference = input.itemIdOrKey.trim();
  const sessionReference = normalizeOptional(input.sessionReference, 160, "Session reference must contain 1-160 characters.");
  const item = getWorkItem(database, input.projectId, input.principalId, reference);
  if (item.type !== "task") throw new ApplicationError("VALIDATION_FAILED", "Development sessions can only be started for task work items.");
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "development_session.start",
    requestId: input.requestId,
    payload: { projectId: input.projectId, itemId: item.id, expectedVersion: input.expectedVersion, sessionReference },
    requiredRoles: ["developer"],
    auditEvent: (session) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "development_session.started",
      entityType: "development_session",
      entityId: session.id,
      payload: { itemId: session.itemId, itemKey: session.itemKey, developerPrincipalId: session.developerPrincipalId, sessionReference },
    }),
    execute: () => {
      const current = getWorkItem(database, input.projectId, input.principalId, item.id);
      assertVersion(current.version, input.expectedVersion);
      if (current.state !== "in_progress") throw new ApplicationError("INVALID_TRANSITION", "The task must be in_progress before a development session starts.");
      if (current.assigneeId !== input.principalId) throw new ApplicationError("FORBIDDEN", "Only the task's assigned developer can start its execution session.");
      const readiness = getTaskStartReadiness(database, {
        projectId: input.projectId,
        principalId: input.principalId,
        itemIdOrKey: current.id,
      });
      if (!readiness.canStart) {
        throw new ApplicationError("START_BLOCKED", "The task no longer meets the development start gates.", { details: readiness });
      }
      const workflowProgress = getCurrentTaskWorkflowProgress(database, input.projectId, current.id);
      const id = randomUUID();
      const now = new Date().toISOString();
      database.prepare(
        `INSERT INTO development_sessions
          (session_id, project_id, item_id, developer_principal_id, session_reference, status, started_at, last_resumed_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(id, input.projectId, current.id, input.principalId, sessionReference, now, now);
      database.prepare(
        `INSERT INTO development_session_events (event_id, project_id, session_id, event_type, principal_id, occurred_at)
         VALUES (?, ?, ?, 'started', ?, ?)`,
      ).run(randomUUID(), input.projectId, id, input.principalId, now);
      if (workflowProgress !== null) {
        database.prepare(
          `INSERT INTO development_session_workflow_refs (project_id, session_id, item_id, revision_number, pinned_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(input.projectId, id, current.id, workflowProgress.revisionNumber, now);
      }
      const specs = database.prepare(
        `SELECT s.spec_id, s.spec_key, r.revision_number
         FROM trace_links l
         INNER JOIN specifications s ON s.project_id = l.project_id AND s.spec_id = l.target_id
         INNER JOIN specification_revisions r ON r.project_id = s.project_id AND r.spec_id = s.spec_id AND r.status = 'published'
         WHERE l.project_id = ? AND l.source_id = ? AND l.link_type = 'implements' AND l.removed_at IS NULL
         ORDER BY s.spec_key COLLATE NOCASE`,
      ).all(input.projectId, current.id) as Array<{ spec_id: string; spec_key: string; revision_number: number }>;
      const insertRef = database.prepare(
        `INSERT INTO development_session_spec_refs (project_id, session_id, item_id, spec_id, revision_number, captured_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const spec of specs) insertRef.run(input.projectId, id, current.id, spec.spec_id, spec.revision_number, now);
      const scenarios = database.prepare(
        `SELECT s.scenario_id, s.scenario_key, r.revision_number
         FROM scenario_revision_work_items link
         INNER JOIN scenarios s ON s.project_id = link.project_id AND s.scenario_id = link.scenario_id
         INNER JOIN scenario_revisions r ON r.project_id = link.project_id AND r.scenario_id = link.scenario_id
           AND r.revision_number = link.revision_number AND r.status = 'published'
         WHERE link.project_id = ? AND link.item_id = ?
         ORDER BY s.scenario_key COLLATE NOCASE, r.revision_number DESC`,
      ).all(input.projectId, current.id) as Array<{ scenario_id: string; scenario_key: string; revision_number: number }>;
      const insertScenario = database.prepare(
        `INSERT OR IGNORE INTO development_session_scenario_refs (project_id, session_id, item_id, scenario_id, revision_number, captured_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const capturedScenarioIds = new Set<string>();
      for (const scenario of scenarios) {
        if (capturedScenarioIds.has(scenario.scenario_id)) continue;
        capturedScenarioIds.add(scenario.scenario_id);
        insertScenario.run(input.projectId, id, current.id, scenario.scenario_id, scenario.revision_number, now);
      }
      return {
        id, projectId: input.projectId, itemId: current.id, itemKey: current.key, itemTitle: current.title,
        developerPrincipalId: input.principalId,
        developerName: readPrincipalName(database, input.principalId),
        sessionReference, status: "active", startedAt: now, endedAt: null, activeSeconds: 0,
        version: 1,
        taskWorkflowRevisionNumber: workflowProgress?.revisionNumber ?? null,
        technicalSpecifications: specs.map((spec) => ({ id: spec.spec_id, key: spec.spec_key, revisionNumber: spec.revision_number })),
        scenarios: scenarios.filter((scenario, index) => scenarios.findIndex((other) => other.scenario_id === scenario.scenario_id) === index)
          .map((scenario) => ({ id: scenario.scenario_id, key: scenario.scenario_key, revisionNumber: scenario.revision_number })),
      };
    },
  });
}

export function transitionDevelopmentSession(
  database: SqliteDatabase,
  input: TransitionDevelopmentSessionInput,
): CommandReceipt<DevelopmentSession> {
  const reason = normalizeRequired(input.reason, 500, "A reason must contain 1-500 characters.");
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "development_session.transition",
    requestId: input.requestId,
    payload: { projectId: input.projectId, sessionId: input.sessionId, action: input.action, expectedVersion: input.expectedVersion, reason },
    requiredRoles: ["developer"],
    auditEvent: (session) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: `development_session.${input.action === "complete" ? "completed" : input.action === "cancel" ? "cancelled" : input.action === "pause" ? "paused" : "resumed"}`,
      entityType: "development_session",
      entityId: session.id,
      reason,
      payload: { itemId: session.itemId, itemKey: session.itemKey, status: session.status, version: session.version, activeSeconds: session.activeSeconds },
    }),
    execute: () => {
      const row = findSession(database, input.projectId, input.sessionId);
      if (row.developer_principal_id !== input.principalId) throw new ApplicationError("FORBIDDEN", "Only the developer who owns this session can change it.");
      assertVersion(row.version, input.expectedVersion);
      if (input.action === "resume" && row.status === "paused") {
        const assignedTask = getWorkItem(database, input.projectId, input.principalId, row.item_id);
        if (assignedTask.assigneeId !== input.principalId) {
          throw new ApplicationError("FORBIDDEN", "Only the currently assigned Developer can resume work on this task.", {
            details: { itemKey: assignedTask.key, assigneeId: assignedTask.assigneeId },
          });
        }
        const activeSession = database.prepare(
          `SELECT session_id FROM development_sessions
           WHERE project_id = ? AND item_id = ? AND status = 'active' AND session_id <> ? LIMIT 1`,
        ).get(input.projectId, row.item_id, row.session_id) as { session_id: string } | undefined;
        if (activeSession !== undefined) {
          throw new ApplicationError("SESSION_CONFLICT", "Another Developer has an active session for this task.", {
            details: { activeSessionId: activeSession.session_id },
          });
        }
      }
      const now = new Date();
      const nowIso = now.toISOString();
      const activeSeconds = row.active_seconds + (row.status === "active" && row.last_resumed_at !== null
        ? Math.max(0, Math.floor((now.getTime() - Date.parse(row.last_resumed_at)) / 1_000))
        : 0);
      let status: DevelopmentSessionStatus;
      let lastResumedAt: string | null;
      let endedAt: string | null = row.ended_at;
      let totalSeconds = row.active_seconds;
      if (input.action === "pause" && row.status === "active") {
        status = "paused"; lastResumedAt = null; totalSeconds = activeSeconds;
      } else if (input.action === "resume" && row.status === "paused") {
        status = "active"; lastResumedAt = nowIso;
      } else if ((input.action === "complete" || input.action === "cancel") && (row.status === "active" || row.status === "paused")) {
        status = input.action === "complete" ? "completed" : "cancelled";
        lastResumedAt = null; endedAt = nowIso; totalSeconds = activeSeconds;
      } else {
        throw new ApplicationError("INVALID_TRANSITION", `Cannot ${input.action} a development session in '${row.status}'.`);
      }
      database.prepare(
        `UPDATE development_sessions SET status = ?, last_resumed_at = ?, ended_at = ?, active_seconds = ?, version = version + 1
         WHERE project_id = ? AND session_id = ? AND version = ?`,
      ).run(status, lastResumedAt, endedAt, totalSeconds, input.projectId, input.sessionId, input.expectedVersion);
      const eventType = input.action === "complete" ? "completed" : input.action === "cancel" ? "cancelled" : input.action === "pause" ? "paused" : "resumed";
      database.prepare(
        `INSERT INTO development_session_events (event_id, project_id, session_id, event_type, principal_id, occurred_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), input.projectId, input.sessionId, eventType, input.principalId, nowIso, reason);
      return sessionFromRow(database, findSession(database, input.projectId, input.sessionId), now.getTime());
    },
  });
}

export function listDevelopmentSessions(database: SqliteDatabase, input: {
  readonly projectId: string;
  readonly principalId: string;
  readonly itemIdOrKey?: string;
  readonly developerPrincipalId?: string;
  readonly status?: DevelopmentSessionStatus;
  readonly limit?: number;
}): DevelopmentSession[] {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ApplicationError("VALIDATION_FAILED", "Session limit must be between 1 and 200.");
  const itemId = input.itemIdOrKey === undefined ? null : getWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey).id;
  const rows = database.prepare(
    `SELECT ds.session_id, ds.project_id, ds.item_id, wi.item_key, wi.title AS item_title,
            ds.developer_principal_id, p.display_name AS developer_name, ds.session_reference, ds.status,
            ds.started_at, ds.last_resumed_at, ds.ended_at, ds.active_seconds, ds.version
     FROM development_sessions ds
     INNER JOIN work_items wi ON wi.project_id = ds.project_id AND wi.item_id = ds.item_id
     INNER JOIN principals p ON p.principal_id = ds.developer_principal_id
     WHERE ds.project_id = ? AND (? IS NULL OR ds.item_id = ?) AND (? IS NULL OR ds.developer_principal_id = ?)
       AND (? IS NULL OR ds.status = ?)
     ORDER BY ds.started_at DESC, ds.session_id DESC LIMIT ?`,
  ).all(input.projectId, itemId, itemId, input.developerPrincipalId ?? null, input.developerPrincipalId ?? null,
    input.status ?? null, input.status ?? null, limit) as SessionRow[];
  return rows.map((row) => sessionFromRow(database, row, Date.now()));
}

export interface DeveloperExecutionMetrics {
  readonly projectId: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly minimumSampleTasks: number;
  readonly developers: readonly {
    readonly principalId: string;
    readonly name: string;
    readonly completedSessions: number;
    readonly completedTasks: number;
    readonly estimatedCompletedTasks: number;
    readonly activeHours: number;
    readonly activeHoursOnCompletedTasks: number;
    readonly activeHoursOnEstimatedCompletedTasks: number;
    readonly estimatedHoursOnCompletedTasks: number;
    readonly estimateVariancePercent: number | null;
    readonly effortCalibrationFactor: number | null;
    readonly sampleSufficient: boolean;
  }[];
}

export function getDeveloperExecutionMetrics(database: SqliteDatabase, input: {
  readonly projectId: string;
  readonly principalId: string;
  readonly from?: string;
  readonly to?: string;
  readonly developerPrincipalId?: string;
}): DeveloperExecutionMetrics {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const to = input.to ?? new Date().toISOString().slice(0, 10);
  const from = input.from ?? `${to.slice(0, 7)}-01`;
  validateDate(from); validateDate(to);
  if (from > to) throw new ApplicationError("VALIDATION_FAILED", "Metric period start must not be after its end.");
  const timezone = getProject(database, input.principalId, input.projectId).timezone;
  const startsAt = localDayStart(from, timezone);
  const endsBefore = nextLocalDayStart(to, timezone);
  const rows = database.prepare(
    `SELECT ds.developer_principal_id, p.display_name, COUNT(*) AS completed_sessions,
            SUM(ds.active_seconds) AS active_seconds
     FROM development_sessions ds INNER JOIN principals p ON p.principal_id = ds.developer_principal_id
     WHERE ds.project_id = ? AND ds.status = 'completed' AND ds.ended_at >= ? AND ds.ended_at < ?
       AND (? IS NULL OR ds.developer_principal_id = ?)
     GROUP BY ds.developer_principal_id, p.display_name ORDER BY p.display_name COLLATE NOCASE`,
  ).all(input.projectId, startsAt, endsBefore, input.developerPrincipalId ?? null, input.developerPrincipalId ?? null) as Array<{
    developer_principal_id: string; display_name: string; completed_sessions: number; active_seconds: number;
  }>;
  const doneRows = database.prepare(
    `WITH latest_done AS (
       SELECT t.item_id, t.transitioned_at,
         ROW_NUMBER() OVER (PARTITION BY t.item_id ORDER BY t.item_version DESC) AS done_rank
       FROM work_item_state_transitions t
       WHERE t.project_id = ? AND t.to_state = 'done' AND t.transitioned_at >= ? AND t.transitioned_at < ?
     ), session_effort AS (
       SELECT ds.item_id, ds.developer_principal_id, SUM(ds.active_seconds) AS seconds
       FROM development_sessions ds INNER JOIN latest_done d ON d.item_id = ds.item_id AND d.done_rank = 1
         AND ds.ended_at <= d.transitioned_at
       WHERE ds.project_id = ? AND ds.status = 'completed'
       GROUP BY ds.item_id, ds.developer_principal_id, d.transitioned_at
     ), attributed AS (
       SELECT e.item_id, e.developer_principal_id, e.seconds,
         e.seconds * 1.0 / NULLIF(SUM(e.seconds) OVER (PARTITION BY e.item_id), 0) AS effort_share
       FROM session_effort e
     )
     SELECT a.developer_principal_id, p.display_name, COUNT(*) AS completed_tasks,
            COUNT(DISTINCT CASE WHEN est.value > 0 THEN a.item_id END) AS estimated_completed_tasks,
            SUM(a.effort_share * COALESCE(est.value, 0)) AS estimated_hours,
            SUM(a.seconds) AS active_seconds_on_completed_tasks,
            SUM(CASE WHEN est.value > 0 THEN a.seconds ELSE 0 END) AS active_seconds_on_estimated_completed_tasks
     FROM latest_done d INNER JOIN attributed a ON a.item_id = d.item_id AND d.done_rank = 1
     INNER JOIN principals p ON p.principal_id = a.developer_principal_id
     LEFT JOIN work_item_estimates est ON est.project_id = ? AND est.item_id = a.item_id AND est.unit = 'hours'
     WHERE (? IS NULL OR a.developer_principal_id = ?)
     GROUP BY a.developer_principal_id, p.display_name`,
  ).all(input.projectId, startsAt, endsBefore, input.projectId, input.projectId,
    input.developerPrincipalId ?? null, input.developerPrincipalId ?? null) as Array<{
    developer_principal_id: string; display_name: string; completed_tasks: number; estimated_completed_tasks: number;
    estimated_hours: number; active_seconds_on_completed_tasks: number; active_seconds_on_estimated_completed_tasks: number;
  }>;
  const doneByDeveloper = new Map(doneRows.map((row) => [row.developer_principal_id, row]));
  const sessionByDeveloper = new Map(rows.map((row) => [row.developer_principal_id, row]));
  const developerIds = [...new Set([...sessionByDeveloper.keys(), ...doneByDeveloper.keys()])];
  const developers = developerIds.map((principalId) => {
    const row = sessionByDeveloper.get(principalId);
    const completed = doneByDeveloper.get(principalId);
    const estimatedHours = completed?.estimated_hours ?? 0;
    const actualHours = (row?.active_seconds ?? 0) / 3_600;
    const actualCompletedHours = (completed?.active_seconds_on_completed_tasks ?? 0) / 3_600;
    const actualEstimatedCompletedHours = (completed?.active_seconds_on_estimated_completed_tasks ?? 0) / 3_600;
    const completedTasks = completed?.completed_tasks ?? 0;
    const estimatedCompletedTasks = completed?.estimated_completed_tasks ?? 0;
    return {
      principalId,
      name: row?.display_name ?? completed?.display_name ?? principalId,
      completedSessions: row?.completed_sessions ?? 0,
      completedTasks,
      estimatedCompletedTasks,
      activeHours: round2(actualHours),
      activeHoursOnCompletedTasks: round2(actualCompletedHours),
      activeHoursOnEstimatedCompletedTasks: round2(actualEstimatedCompletedHours),
      estimatedHoursOnCompletedTasks: round2(estimatedHours),
      estimateVariancePercent: estimatedHours > 0 ? round2(((actualEstimatedCompletedHours - estimatedHours) / estimatedHours) * 100) : null,
      effortCalibrationFactor: estimatedCompletedTasks >= 5 && estimatedHours > 0 ? round2(actualEstimatedCompletedHours / estimatedHours) : null,
      sampleSufficient: estimatedCompletedTasks >= 5,
    };
  });
  return { projectId: input.projectId, period: { from, to }, minimumSampleTasks: 5, developers };
}

export function recordDeployment(database: SqliteDatabase, input: RecordDeploymentInput): CommandReceipt<DeploymentEvent> {
  const buildId = normalizeRequired(input.buildId, 128, "Build ID must contain 1-128 characters.");
  const releaseVersion = normalizeOptional(input.releaseVersion, 128, "Release version must contain 1-128 characters.");
  const pipelineRunId = normalizeOptional(input.pipelineRunId, 160, "Pipeline run ID must contain 1-160 characters.");
  const notes = normalizeOptional(input.notes, 2_000, "Notes must contain at most 2000 characters.");
  const occurredAt = input.occurredAt === undefined ? new Date().toISOString() : normalizeTimestamp(input.occurredAt);
  const itemReferences = [...new Set(input.itemIdOrKeys.map((value) => value.trim()).filter(Boolean))];
  const milestoneReferences = [...new Set((input.milestoneIdOrKeys ?? []).map((value) => value.trim()).filter(Boolean))];
  if (itemReferences.length > 100 || milestoneReferences.length > 50 || itemReferences.length + milestoneReferences.length === 0) {
    throw new ApplicationError("VALIDATION_FAILED", "A deployment must reference 1-100 work items and up to 50 milestones, with at least one total reference.");
  }
  if (input.outcome === "rolled_back" && input.rollbackOfEventId === undefined) throw new ApplicationError("VALIDATION_FAILED", "A rollback event must reference the deployment it rolls back.");
  if (input.outcome !== "rolled_back" && input.rollbackOfEventId !== undefined) throw new ApplicationError("VALIDATION_FAILED", "rollbackOfEventId is only valid for a rolled_back event.");
  const requiredRoles: readonly ProjectRole[] = input.environment === "production" ? ["admin", "po", "tech_lead"] : ["admin", "qa", "po", "tech_lead"];
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "deployment.record",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId, environment: input.environment, buildId, releaseVersion, pipelineRunId,
      outcome: input.outcome, occurredAt, itemReferences, milestoneReferences,
      rollbackOfEventId: input.rollbackOfEventId ?? null, notes,
    },
    requiredRoles,
    auditEvent: (event) => ({
      projectId: input.projectId, principalId: input.principalId, eventType: "deployment.recorded",
      entityType: "deployment_event", entityId: event.id, ...(notes === null ? {} : { reason: notes }),
      payload: { environment: event.environment, buildId: event.buildId, outcome: event.outcome, occurredAt, itemIds: event.itemIds, milestoneIds: event.milestoneIds, rollbackOfEventId: event.rollbackOfEventId },
    }),
    execute: () => {
      const items = itemReferences.map((reference) => getWorkItem(database, input.projectId, input.principalId, reference));
      const itemIds = items.map((item) => item.id);
      const milestones = milestoneReferences.map((reference) => {
        const row = database.prepare(
          "SELECT milestone_id FROM milestones WHERE project_id = ? AND (milestone_id = ? OR milestone_key = ? COLLATE NOCASE)",
        ).get(input.projectId, reference, reference) as { milestone_id: string } | undefined;
        if (row === undefined) throw new ApplicationError("NOT_FOUND", `Milestone '${reference}' was not found in this project.`);
        return row.milestone_id;
      });
      if (input.environment === "production" && input.outcome === "succeeded") {
        for (const item of items) {
          if (item.state !== "done") throw new ApplicationError("GATE_BLOCKED", `Work item ${item.key} must pass QA and be Done before production.`);
          if (database.prepare(
            `SELECT 1 FROM deployment_event_work_items link INNER JOIN deployment_events event
              ON event.project_id = link.project_id AND event.event_id = link.event_id
             WHERE link.project_id = ? AND link.item_id = ? AND event.environment = 'homologation'
               AND event.build_id = ? AND event.outcome = 'succeeded' LIMIT 1`,
          ).get(input.projectId, item.id, buildId) === undefined) {
            throw new ApplicationError("GATE_BLOCKED", `Work item ${item.key} has no successful homologation for build ${buildId}.`);
          }
        }
      }
      if (input.rollbackOfEventId !== undefined) {
        const prior = database.prepare(
          "SELECT environment, outcome FROM deployment_events WHERE project_id = ? AND event_id = ?",
        ).get(input.projectId, input.rollbackOfEventId) as { environment: string; outcome: string } | undefined;
        if (prior === undefined || prior.environment !== input.environment || prior.outcome !== "succeeded") {
          throw new ApplicationError("VALIDATION_FAILED", "A rollback must reference a successful event in the same project and environment.");
        }
      }
      const id = randomUUID();
      database.prepare(
        `INSERT INTO deployment_events
          (event_id, project_id, environment, build_id, release_version, pipeline_run_id, outcome, deployed_at,
           principal_id, notes, rollback_of_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.projectId, input.environment, buildId, releaseVersion, pipelineRunId, input.outcome, occurredAt,
        input.principalId, notes, input.rollbackOfEventId ?? null);
      const linkItem = database.prepare("INSERT INTO deployment_event_work_items (project_id, event_id, item_id) VALUES (?, ?, ?)");
      for (const itemId of itemIds) linkItem.run(input.projectId, id, itemId);
      const linkMilestone = database.prepare("INSERT INTO deployment_event_milestones (project_id, event_id, milestone_id) VALUES (?, ?, ?)");
      for (const milestoneId of milestones) linkMilestone.run(input.projectId, id, milestoneId);
      return {
        id, projectId: input.projectId, environment: input.environment, buildId, releaseVersion, pipelineRunId,
        outcome: input.outcome, occurredAt, principalId: input.principalId, principalName: readPrincipalName(database, input.principalId),
        rollbackOfEventId: input.rollbackOfEventId ?? null, itemIds, milestoneIds: milestones, notes,
      };
    },
  });
}

export function listDeploymentEvents(database: SqliteDatabase, input: {
  readonly projectId: string;
  readonly principalId: string;
  readonly itemIdOrKey?: string;
  readonly environment?: DeploymentEnvironment;
  readonly limit?: number;
}): DeploymentEvent[] {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ApplicationError("VALIDATION_FAILED", "Deployment limit must be between 1 and 200.");
  const itemId = input.itemIdOrKey === undefined ? null : getWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey).id;
  const rows = database.prepare(
    `SELECT DISTINCT e.event_id, e.project_id, e.environment, e.build_id, e.release_version, e.pipeline_run_id,
            e.outcome, e.deployed_at, e.principal_id, p.display_name AS principal_name, e.rollback_of_event_id, e.notes
     FROM deployment_events e INNER JOIN principals p ON p.principal_id = e.principal_id
     LEFT JOIN deployment_event_work_items wi ON wi.project_id = e.project_id AND wi.event_id = e.event_id
     WHERE e.project_id = ? AND (? IS NULL OR e.environment = ?) AND (? IS NULL OR wi.item_id = ?)
     ORDER BY e.deployed_at DESC, e.event_id DESC LIMIT ?`,
  ).all(input.projectId, input.environment ?? null, input.environment ?? null, itemId, itemId, limit) as Array<{
    event_id: string; project_id: string; environment: DeploymentEnvironment; build_id: string; release_version: string | null;
    pipeline_run_id: string | null; outcome: DeploymentOutcome; deployed_at: string; principal_id: string; principal_name: string;
    rollback_of_event_id: string | null; notes: string | null;
  }>;
  return rows.map((row) => ({
    id: row.event_id, projectId: row.project_id, environment: row.environment, buildId: row.build_id,
    releaseVersion: row.release_version, pipelineRunId: row.pipeline_run_id, outcome: row.outcome,
    occurredAt: row.deployed_at, principalId: row.principal_id, principalName: row.principal_name,
    rollbackOfEventId: row.rollback_of_event_id,
    itemIds: (database.prepare("SELECT item_id FROM deployment_event_work_items WHERE project_id = ? AND event_id = ? ORDER BY item_id").all(row.project_id, row.event_id) as Array<{ item_id: string }>).map((item) => item.item_id),
    milestoneIds: (database.prepare("SELECT milestone_id FROM deployment_event_milestones WHERE project_id = ? AND event_id = ? ORDER BY milestone_id").all(row.project_id, row.event_id) as Array<{ milestone_id: string }>).map((item) => item.milestone_id),
    notes: row.notes,
  }));
}

function findSession(database: SqliteDatabase, projectId: string, sessionId: string): SessionRow {
  const row = database.prepare(
    `SELECT ds.session_id, ds.project_id, ds.item_id, wi.item_key, wi.title AS item_title,
            ds.developer_principal_id, p.display_name AS developer_name, ds.session_reference, ds.status,
            ds.started_at, ds.last_resumed_at, ds.ended_at, ds.active_seconds, ds.version
     FROM development_sessions ds INNER JOIN work_items wi ON wi.project_id = ds.project_id AND wi.item_id = ds.item_id
     INNER JOIN principals p ON p.principal_id = ds.developer_principal_id
     WHERE ds.project_id = ? AND ds.session_id = ?`,
  ).get(projectId, sessionId) as SessionRow | undefined;
  if (row === undefined) throw new ApplicationError("NOT_FOUND", "Development session was not found.");
  return row;
}

function sessionFromRow(database: SqliteDatabase, row: SessionRow, nowMs: number): DevelopmentSession {
  const activeNow = row.status === "active" && row.last_resumed_at !== null
    ? Math.max(0, Math.floor((nowMs - Date.parse(row.last_resumed_at)) / 1_000)) : 0;
  const technicalSpecifications = database.prepare(
    `SELECT r.spec_id, s.spec_key, r.revision_number FROM development_session_spec_refs r
     INNER JOIN specifications s ON s.project_id = r.project_id AND s.spec_id = r.spec_id
     WHERE r.project_id = ? AND r.session_id = ? ORDER BY s.spec_key COLLATE NOCASE`,
  ).all(row.project_id, row.session_id).map((value) => {
    const spec = value as { spec_id: string; spec_key: string; revision_number: number };
    return { id: spec.spec_id, key: spec.spec_key, revisionNumber: spec.revision_number };
  });
  const scenarios = database.prepare(
    `SELECT s.scenario_id, s.scenario_key, r.revision_number FROM development_session_scenario_refs ref
     INNER JOIN scenarios s ON s.project_id = ref.project_id AND s.scenario_id = ref.scenario_id
     INNER JOIN scenario_revisions r ON r.project_id = ref.project_id AND r.scenario_id = ref.scenario_id
       AND r.revision_number = ref.revision_number
     WHERE ref.project_id = ? AND ref.session_id = ? ORDER BY s.scenario_key COLLATE NOCASE`,
  ).all(row.project_id, row.session_id).map((value) => {
    const scenario = value as { scenario_id: string; scenario_key: string; revision_number: number };
    return { id: scenario.scenario_id, key: scenario.scenario_key, revisionNumber: scenario.revision_number };
  });
  const workflowReference = database.prepare(
    `SELECT revision_number FROM development_session_workflow_refs
     WHERE project_id = ? AND session_id = ?`,
  ).get(row.project_id, row.session_id) as { revision_number: number } | undefined;
  return {
    id: row.session_id, projectId: row.project_id, itemId: row.item_id, itemKey: row.item_key, itemTitle: row.item_title,
    developerPrincipalId: row.developer_principal_id, developerName: row.developer_name,
    sessionReference: row.session_reference, status: row.status, startedAt: row.started_at, endedAt: row.ended_at,
    activeSeconds: row.active_seconds + activeNow, version: row.version,
    taskWorkflowRevisionNumber: workflowReference?.revision_number ?? null,
    technicalSpecifications, scenarios,
  };
}

function assertVersion(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1) throw new ApplicationError("VALIDATION_FAILED", "Expected version must be a positive integer.");
  if (actual !== expected) throw new ApplicationError("VERSION_CONFLICT", "The record changed since it was read.", { details: { expectedVersion: expected, actualVersion: actual } });
}

function normalizeRequired(value: string, max: number, message: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > max) throw new ApplicationError("VALIDATION_FAILED", message);
  return normalized;
}

function normalizeOptional(value: string | undefined, max: number, message: string): string | null {
  const normalized = value?.trim() || null;
  if (normalized !== null && normalized.length > max) throw new ApplicationError("VALIDATION_FAILED", message);
  return normalized;
}

function normalizeTimestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) throw new ApplicationError("VALIDATION_FAILED", "Deployment occurrence time must be an ISO 8601 timestamp.");
  return new Date(time).toISOString();
}

function validateDate(value: string): void {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApplicationError("VALIDATION_FAILED", "Metric dates must use YYYY-MM-DD.");
  }
}

function readPrincipalName(database: SqliteDatabase, principalId: string): string {
  const row = database.prepare("SELECT display_name FROM principals WHERE principal_id = ?").get(principalId) as { display_name: string } | undefined;
  return row?.display_name ?? principalId;
}

function round2(value: number): number { return Math.round(value * 100) / 100; }
