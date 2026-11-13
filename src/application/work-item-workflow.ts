import { randomUUID } from "node:crypto";
import { unattestedDefinitionOfDone } from "./task-delivery-reports.js";
import { assertIndependentReviewForValidation } from "./task-reviews.js";
import { assertDeliveryReportForReview } from "./task-delivery-reports.js";
import { openBlockingQuestions } from "./work-item-questions.js";
import type { WorkItemState } from "../domain/work-items.js";
import { workItemStates } from "../domain/work-items.js";
import type {
  EvidenceKind,
  TestRunCertification,
  WorkItemEvidence,
  WorkItemGateReport,
  WorkItemTransition,
  WorkflowGate,
} from "../domain/workflow.js";
import { evidenceKinds } from "../domain/workflow.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { createBaselineForReadyTransition } from "./baseline-commands.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { assertProjectAuthorization, getProjectRoles, type ProjectRole } from "./local-identity.js";
import { getCurrentTaskWorkflowProgress, hasUnpublishedTaskWorkflow } from "./task-workflow-queries.js";
import { getWorkItem } from "./work-item-queries.js";

export interface TaskStartBlocker {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface TaskStartReadinessReport {
  readonly itemId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly state: string;
  readonly version: number;
  readonly assigneeId: string | null;
  readonly parent: { readonly id: string; readonly key: string; readonly state: string; readonly baselineId: string | null } | null;
  readonly dependencies: readonly { readonly id: string; readonly key: string; readonly title: string; readonly state: string; readonly complete: boolean }[];
  readonly openSession: { readonly id: string; readonly status: "active" | "paused"; readonly developerPrincipalId: string } | null;
  readonly blockers: readonly TaskStartBlocker[];
  readonly warnings: readonly { readonly code: string; readonly message: string; readonly keys: readonly string[] }[];
  readonly canStart: boolean;
}

export interface TransitionWorkItemInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly itemIdOrKey: string;
  readonly targetState: WorkItemState;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly buildId?: string;
  /** Internal escape hatch used only by the atomic task-start command. */
  readonly taskStartCommand?: boolean;
}

export interface AddWorkItemEvidenceInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly itemIdOrKey: string;
  readonly kind: EvidenceKind;
  readonly uri: string;
  readonly buildId?: string;
  readonly description: string;
}

export interface ListWorkItemEvidenceInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly itemIdOrKey: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CertifyTestRunInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly itemIdOrKey: string;
  readonly runId: string;
  readonly expectedVersion: number;
  readonly reason: string;
}

interface EvidenceCursor {
  readonly version: 1;
  readonly projectId: string;
  readonly principalId: string;
  readonly itemId: string;
  readonly watermark: number;
  readonly afterSequence: number;
}

interface EvidenceRow {
  readonly evidence_id: string;
  readonly project_id: string;
  readonly item_id: string;
  readonly item_key: string;
  readonly baseline_id: string | null;
  readonly kind: EvidenceKind;
  readonly uri: string;
  readonly build_id: string | null;
  readonly description: string;
  readonly added_by_principal_id: string;
  readonly created_at: string;
}

const allowedTransitions: Readonly<Record<WorkItemState, readonly WorkItemState[]>> = {
  draft: ["ready", "cancelled"],
  ready: ["in_progress", "cancelled"],
  in_progress: ["in_review", "cancelled"],
  in_review: ["in_validation", "in_progress", "cancelled"],
  in_validation: ["done", "in_progress", "cancelled"],
  done: ["in_progress"],
  cancelled: [],
};

const transitionRoles: Readonly<Record<WorkItemState, readonly ProjectRole[]>> = {
  draft: [],
  ready: ["po"],
  in_progress: ["developer", "qa", "po"],
  in_review: ["developer"],
  in_validation: ["developer"],
  done: ["developer"],
  cancelled: ["po"],
};

export function getWorkItemGateReport(
  database: SqliteDatabase,
  input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly itemIdOrKey: string;
    readonly targetState: "ready" | "done";
    readonly buildId?: string;
  },
): WorkItemGateReport {
  const item = getWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey.trim());
  return evaluateGates(database, item, input.principalId, input.targetState, input.buildId?.trim() || null);
}

/** Reports whether this principal may start a task now, including its current dependency and session locks. */
export function getTaskStartReadiness(
  database: SqliteDatabase,
  input: { readonly projectId: string; readonly principalId: string; readonly itemIdOrKey: string },
): TaskStartReadinessReport {
  return evaluateTaskStartReadiness(database, input, false);
}

/** Evaluates an unassigned task's gates as if it were assigned to this Developer. */
export function getTaskClaimReadiness(
  database: SqliteDatabase,
  input: { readonly projectId: string; readonly principalId: string; readonly itemIdOrKey: string },
): TaskStartReadinessReport {
  return evaluateTaskStartReadiness(database, input, true);
}

function evaluateTaskStartReadiness(
  database: SqliteDatabase,
  input: { readonly projectId: string; readonly principalId: string; readonly itemIdOrKey: string },
  allowUnassigned: boolean,
): TaskStartReadinessReport {
  const item = getWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey.trim());
  if (item.type !== "task") {
    throw new ApplicationError("VALIDATION_FAILED", "Only task work items can be checked for development start.");
  }

  const blockers: TaskStartBlocker[] = [];
  if (item.state !== "ready" && item.state !== "in_progress") {
    blockers.push({
      code: "task_not_ready_for_development",
      message: item.state === "draft"
        ? "Prepare and approve the task into Ready before starting development."
        : `A task in '${item.state}' cannot start a new development session.`,
      details: { state: item.state, allowedStates: ["ready", "in_progress"] },
    });
  }

  if (!getProjectRoles(database, input.projectId, input.principalId).includes("developer")) {
    blockers.push({ code: "developer_role_required", message: "The authenticated principal must have the Developer role in this project." });
  }
  if (item.assigneeId === null) {
    if (!allowUnassigned) {
      blockers.push({ code: "task_unassigned", message: "Assign the task to an eligible Developer before starting." });
    }
  } else if (item.assigneeId !== input.principalId) {
    blockers.push({ code: "task_assigned_to_another_user", message: "Only the task's assigned Developer can start it.", details: { assigneeId: item.assigneeId } });
  }
  if (item.description === null || item.description.trim().length === 0) {
    blockers.push({ code: "task_output_missing", message: "Describe the expected task output before starting development." });
  }

  let parent: TaskStartReadinessReport["parent"] = null;
  if (item.parentId === null) {
    blockers.push({ code: "parent_pbi_missing", message: "A task must belong to a parent story or bug before development." });
  } else {
    const parentItem = getWorkItem(database, input.projectId, input.principalId, item.parentId);
    const baseline = database.prepare(
      "SELECT baseline_id FROM work_baselines WHERE project_id = ? AND item_id = ? ORDER BY sequence DESC LIMIT 1",
    ).get(input.projectId, parentItem.id) as { baseline_id: string } | undefined;
    parent = { id: parentItem.id, key: parentItem.key, state: parentItem.state, baselineId: baseline?.baseline_id ?? null };
    if (parentItem.state !== "ready" && parentItem.state !== "in_progress") {
      blockers.push({
        code: "parent_pbi_not_active",
        message: "The parent story or bug must remain Ready or in progress while its task is developed.",
        details: { parentKey: parentItem.key, state: parentItem.state },
      });
    }
    if (baseline === undefined) {
      blockers.push({ code: "parent_baseline_missing", message: "The parent story or bug must have a fixed baseline before development." });
    }
  }

  const dependencyRows = database.prepare(
    `SELECT target.item_id, target.item_key, target.title, target.state
     FROM trace_links l
     INNER JOIN work_items target ON target.project_id = l.project_id AND target.item_id = l.target_id
     WHERE l.project_id = ? AND l.source_id = ? AND l.link_type = 'depends_on' AND l.removed_at IS NULL
     ORDER BY target.item_key COLLATE NOCASE`,
  ).all(input.projectId, item.id) as Array<{ item_id: string; item_key: string; title: string; state: string }>;
  const dependencies = dependencyRows.map((dependency) => ({
    id: dependency.item_id,
    key: dependency.item_key,
    title: dependency.title,
    state: dependency.state,
    complete: dependency.state === "done",
  }));
  const incompleteDependencies = dependencies.filter((dependency) => !dependency.complete);
  if (incompleteDependencies.length > 0) {
    blockers.push({
      code: "dependencies_incomplete",
      message: "Complete or explicitly remove every prerequisite before starting development.",
      details: { dependencies: incompleteDependencies.map(({ key, state }) => ({ key, state })) },
    });
  }

  const openSessionRow = database.prepare(
    `SELECT session_id, status, developer_principal_id FROM development_sessions
     WHERE project_id = ? AND item_id = ? AND status IN ('active', 'paused')
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, started_at DESC, session_id DESC LIMIT 1`,
  ).get(input.projectId, item.id) as { session_id: string; status: "active" | "paused"; developer_principal_id: string } | undefined;
  const openSession = openSessionRow === undefined ? null : {
    id: openSessionRow.session_id,
    status: openSessionRow.status,
    developerPrincipalId: openSessionRow.developer_principal_id,
  };
  if (openSession?.status === "active") {
    blockers.push({
      code: "task_session_already_active",
      message: "The task already has an active development session.",
      details: { sessionId: openSession.id, status: openSession.status, developerPrincipalId: openSession.developerPrincipalId },
    });
  } else if (openSession?.status === "paused") {
    const sameDeveloper = openSession.developerPrincipalId === input.principalId;
    blockers.push({
      code: sameDeveloper ? "task_session_paused" : "task_session_handoff_required",
      message: sameDeveloper
        ? "Resume or close the existing paused session before starting another one."
        : "The previous Developer must complete or cancel the paused session before another Developer can take over.",
      details: { sessionId: openSession.id, status: openSession.status, developerPrincipalId: openSession.developerPrincipalId },
    });
  }

  const unpublishedAdrs = database.prepare(
    `SELECT s.spec_key FROM trace_links l
     INNER JOIN specifications s ON s.project_id = l.project_id AND s.spec_id = l.target_id AND s.kind = 'adr'
     WHERE l.project_id = ? AND l.source_id = ? AND l.link_type = 'implements' AND l.removed_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM specification_revisions r
         WHERE r.project_id = s.project_id AND r.spec_id = s.spec_id AND r.status = 'published'
       ) ORDER BY s.spec_key COLLATE NOCASE`,
  ).all(input.projectId, item.id) as Array<{ spec_key: string }>;
  if (unpublishedAdrs.length > 0) {
    blockers.push({
      code: "implementing_adr_unpublished",
      message: "Publish each ADR linked as implements, or change the relationship to relates_to before development starts.",
      details: { adrKeys: unpublishedAdrs.map((row) => row.spec_key) },
    });
  }

  const warnings: Array<TaskStartReadinessReport["warnings"][number]> = [];
  const workflowProgress = getCurrentTaskWorkflowProgress(database, input.projectId, item.id);
  if (hasUnpublishedTaskWorkflow(database, input.projectId, item.id)) {
    blockers.push({
      code: "task_workflow_unpublished",
      message: "Publish the task workflow before starting development, or withdraw the Draft if no workflow is intended.",
    });
  } else if (workflowProgress === null) {
    warnings.push({
      code: "task_workflow_not_defined",
      message: "No workflow is configured; progress will be reported as unavailable rather than 0%.",
      keys: [],
    });
  }

  return {
    itemId: item.id,
    itemKey: item.key,
    title: item.title,
    state: item.state,
    version: item.version,
    assigneeId: item.assigneeId,
    parent,
    dependencies,
    openSession,
    blockers,
    warnings,
    canStart: blockers.length === 0,
  };
}

export function transitionWorkItem(
  database: SqliteDatabase,
  input: TransitionWorkItemInput,
): CommandReceipt<{
  readonly transition: WorkItemTransition;
  readonly baseline: { readonly id: string; readonly sequence: number } | null;
}> {
  const reference = input.itemIdOrKey.trim();
  const reason = normalizeText(input.reason, 1_000, "A transition reason must contain 1-1000 characters.");
  const buildId = normalizeOptionalText(input.buildId, 128, "Build ID must contain 1-128 characters.");
  if (!workItemStates.includes(input.targetState)) {
    throw new ApplicationError("VALIDATION_FAILED", "The target work item state is invalid.");
  }
  const initialItem = getWorkItem(database, input.projectId, input.principalId, reference);
  const roles = input.targetState === "ready" && initialItem.type === "task"
    ? ["developer", "qa"] as const
    : transitionRoles[input.targetState];
  if (roles.length === 0) {
    throw new ApplicationError("INVALID_TRANSITION", "The requested state has no incoming workflow transition.");
  }

  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "work_item.transition",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      itemId: initialItem.id,
      targetState: input.targetState,
      expectedVersion: input.expectedVersion,
      reason,
      buildId,
    },
    requiredRoles: roles,
    auditEvent: (result) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "work_item.state_transitioned",
      entityType: "work_item",
      entityId: result.transition.itemId,
      reason,
      payload: {
        transitionId: result.transition.id,
        fromState: result.transition.fromState,
        toState: result.transition.toState,
        itemVersion: result.transition.itemVersion,
        baselineId: result.transition.baselineId,
        buildId,
      },
    }),
    execute: () => {
      const item = getWorkItem(database, input.projectId, input.principalId, initialItem.id);
      assertExpectedVersion(item.version, input.expectedVersion);
      const fromState = item.state as WorkItemState;
      if (!allowedTransitions[fromState]?.includes(input.targetState)) {
        throw new ApplicationError("INVALID_TRANSITION", `Transition from '${fromState}' to '${input.targetState}' is not allowed.`, {
          details: { fromState, targetState: input.targetState, allowed: allowedTransitions[fromState] ?? [] },
        });
      }
      if (input.targetState === "in_progress" && fromState === "done") {
        assertProjectAuthorization(database, input.projectId, input.principalId, ["po", "qa"]);
      }
      if (input.targetState === "in_progress" && fromState === "ready" && item.type === "task" && input.taskStartCommand !== true) {
        throw new ApplicationError("USE_TASK_START", "Use task_start to validate the task gates and open its development session atomically.");
      }
      if (["ready", "done", "cancelled"].includes(input.targetState) || fromState === "done") {
        assertHumanPrincipal(database, input.principalId, "Only a human principal may approve this workflow transition.");
      }
      if (input.targetState === "ready" || input.targetState === "done") {
        const report = evaluateGates(database, item, input.principalId, input.targetState, buildId);
        if (!report.canProceed) {
          throw new ApplicationError("GATE_BLOCKED", `The work item cannot transition to '${input.targetState}'.`, { details: report });
        }
      }
      if (input.targetState === "in_progress") {
        assertDependenciesComplete(database, input.projectId, item.id);
      }
      if (input.targetState === "in_validation" && fromState === "in_review" && item.type === "task") {
        assertIndependentReviewForValidation(database, input.projectId, item.id);
      }
      if (input.targetState === "in_review" && fromState === "in_progress" && item.type === "task") {
        assertDeliveryReportForReview(database, input.projectId, input.principalId, item.id);
      }

      const now = new Date().toISOString();
      const update = database.prepare(
        `UPDATE work_items SET state = ?, version = version + 1, updated_at = ?
         WHERE project_id = ? AND item_id = ? AND version = ?`,
      ).run(input.targetState, now, input.projectId, item.id, input.expectedVersion);
      if (update.changes !== 1) {
        throw new ApplicationError("VERSION_CONFLICT", "The work item changed during the transition.");
      }

      let createdBaseline: ReturnType<typeof createBaselineForReadyTransition> | undefined;
      if (input.targetState === "ready" && (item.type === "story" || item.type === "bug")) {
        createdBaseline = createBaselineForReadyTransition(database, {
          projectId: input.projectId,
          principalId: input.principalId,
          itemId: item.id,
          reason,
        });
      }
      const baselineId = createdBaseline?.id ?? baselineIdForItem(database, input.projectId, item.id);
      const transition: WorkItemTransition = {
        id: randomUUID(),
        projectId: input.projectId,
        itemId: item.id,
        itemKey: item.key,
        fromState,
        toState: input.targetState,
        itemVersion: input.expectedVersion + 1,
        baselineId,
        buildId,
        reason,
        transitionedByPrincipalId: input.principalId,
        transitionedAt: now,
      };
      database.prepare(
        `INSERT INTO work_item_state_transitions
          (transition_id, project_id, item_id, from_state, to_state, item_version, baseline_id,
           build_id, reason, transitioned_by_principal_id, transitioned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        transition.id, transition.projectId, transition.itemId, transition.fromState, transition.toState,
        transition.itemVersion, transition.baselineId, transition.buildId, transition.reason,
        transition.transitionedByPrincipalId, transition.transitionedAt,
      );
      return {
        transition,
        baseline: createdBaseline === undefined ? null : { id: createdBaseline.id, sequence: createdBaseline.sequence },
      };
    },
  });
}

export function addWorkItemEvidence(
  database: SqliteDatabase,
  input: AddWorkItemEvidenceInput,
): CommandReceipt<WorkItemEvidence> {
  const item = getWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey.trim());
  if (!evidenceKinds.includes(input.kind)) {
    throw new ApplicationError("VALIDATION_FAILED", "Evidence kind is invalid.");
  }
  const uri = normalizeText(input.uri, 2_048, "Evidence URI must contain 1-2048 characters.");
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(uri)) {
    throw new ApplicationError("VALIDATION_FAILED", "Evidence URI must be an absolute URI with a scheme.");
  }
  const description = normalizeText(input.description, 2_000, "Evidence description must contain 1-2000 characters.");
  const buildId = normalizeOptionalText(input.buildId, 128, "Build ID must contain 1-128 characters.");
  const baselineId = baselineIdForItem(database, input.projectId, item.id);

  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "work_item.evidence.add",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      itemId: item.id,
      kind: input.kind,
      uri,
      buildId,
      description,
      baselineId,
    },
    requiredRoles: ["po", "developer", "qa", "tech_lead"],
    auditEvent: (evidence) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "work_item.evidence_added",
      entityType: "work_item",
      entityId: evidence.itemId,
      reason: description,
      payload: { evidenceId: evidence.id, kind: evidence.kind, buildId: evidence.buildId, baselineId: evidence.baselineId },
    }),
    execute: () => {
      const currentItem = getWorkItem(database, input.projectId, input.principalId, item.id);
      if (currentItem.state === "cancelled") {
        throw new ApplicationError("INVALID_TRANSITION", "Evidence cannot be added to a cancelled work item.");
      }
      const currentBaselineId = baselineIdForItem(database, input.projectId, item.id);
      if (currentBaselineId !== baselineId) {
        throw new ApplicationError("VERSION_CONFLICT", "The work item baseline changed before evidence was recorded.");
      }
      const evidence: WorkItemEvidence = {
        id: randomUUID(),
        projectId: input.projectId,
        itemId: item.id,
        itemKey: item.key,
        baselineId,
        kind: input.kind,
        uri,
        buildId,
        description,
        addedByPrincipalId: input.principalId,
        createdAt: new Date().toISOString(),
      };
      database.prepare(
        `INSERT INTO evidence
          (evidence_id, project_id, item_id, baseline_id, kind, uri, build_id, description,
           added_by_principal_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        evidence.id, evidence.projectId, evidence.itemId, evidence.baselineId, evidence.kind,
        evidence.uri, evidence.buildId, evidence.description, evidence.addedByPrincipalId, evidence.createdAt,
      );
      return evidence;
    },
  });
}

export function listWorkItemEvidence(
  database: SqliteDatabase,
  input: ListWorkItemEvidenceInput,
): { readonly evidence: readonly WorkItemEvidence[]; readonly nextCursor: string | null } {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const item = getWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey.trim());
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "Evidence page size must be an integer between 1 and 100.");
  }
  const watermarkRow = database.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS watermark FROM evidence WHERE project_id = ? AND item_id = ?",
  ).get(input.projectId, item.id) as { watermark: number };
  const cursor = input.cursor === undefined ? undefined : decodeEvidenceCursor(input.cursor);
  if (cursor !== undefined) {
    if (cursor.projectId !== input.projectId || cursor.principalId !== input.principalId || cursor.itemId !== item.id) {
      throw new ApplicationError("VALIDATION_FAILED", "The evidence cursor belongs to another query.");
    }
    if (cursor.watermark !== watermarkRow.watermark) {
      throw new ApplicationError("STALE_CURSOR", "Project data changed after this evidence page was read.");
    }
  }
  const rows = database.prepare(
    `SELECT e.evidence_id, e.project_id, e.item_id, wi.item_key, e.baseline_id, e.kind, e.uri,
            e.build_id, e.description, e.added_by_principal_id, e.created_at, e.sequence
     FROM evidence e INNER JOIN work_items wi ON wi.project_id = e.project_id AND wi.item_id = e.item_id
     WHERE e.project_id = ? AND e.item_id = ? AND e.sequence > ? AND e.sequence <= ?
     ORDER BY e.sequence LIMIT ?`,
  ).all(input.projectId, item.id, cursor?.afterSequence ?? 0, watermarkRow.watermark, limit + 1) as Array<EvidenceRow & { sequence: number }>;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const evidence = page.map(toEvidence);
  const last = page.at(-1);
  return {
    evidence,
    nextCursor: hasMore && last !== undefined
      ? encodeEvidenceCursor({
        version: 1,
        projectId: input.projectId,
        principalId: input.principalId,
        itemId: item.id,
        watermark: watermarkRow.watermark,
        afterSequence: last.sequence,
      })
      : null,
  };
}

export function certifyTestRun(
  database: SqliteDatabase,
  input: CertifyTestRunInput,
): CommandReceipt<TestRunCertification & { readonly version: number }> {
  const item = getWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey.trim());
  const reason = normalizeText(input.reason, 1_000, "Certification reason must contain 1-1000 characters.");
  if (item.type !== "story" && item.type !== "bug") {
    throw new ApplicationError("VALIDATION_FAILED", "QA certification is attached to a story or bug baseline.");
  }
  const runId = input.runId.trim();
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "test_run.certify",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      itemId: item.id,
      runId,
      expectedVersion: input.expectedVersion,
      reason,
    },
    requiredRoles: ["qa"],
    auditEvent: (certification) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "test_run.certified",
      entityType: "test_run",
      entityId: certification.runId,
      reason,
      payload: { itemId: certification.itemId, baselineId: certification.baselineId, certificationId: certification.id },
    }),
    execute: () => {
      const current = getWorkItem(database, input.projectId, input.principalId, item.id);
      assertExpectedVersion(current.version, input.expectedVersion);
      if (current.state !== "in_validation") {
        throw new ApplicationError("INVALID_TRANSITION", "A test run can only be certified while its PBI is in validation.");
      }
      assertHumanPrincipal(database, input.principalId, "Only a human QA principal may certify a test run.");
      const baselineId = baselineIdForItem(database, input.projectId, item.id);
      if (baselineId === null) {
        throw new ApplicationError("GATE_BLOCKED", "A PBI must have a Ready baseline before test runs can be certified.");
      }
      const run = database.prepare(
        `SELECT run_id, scenario_id, revision_number, build_id, result, sequence
         FROM test_runs WHERE project_id = ? AND run_id = ?`,
      ).get(input.projectId, runId) as {
        run_id: string; scenario_id: string; revision_number: number; build_id: string; result: string; sequence: number;
      } | undefined;
      if (run === undefined) throw new ApplicationError("NOT_FOUND", "Test run was not found in this project.");
      if (run.result !== "passed") {
        throw new ApplicationError("GATE_BLOCKED", "Only a passing test run can be certified.", {
          details: { runId, result: run.result },
        });
      }
      const baselineCoverage = database.prepare(
        `SELECT 1 FROM baseline_refs
         WHERE project_id = ? AND baseline_id = ? AND entity_type = 'scenario_revision'
           AND entity_id = ? AND revision_number = ?`,
      ).get(input.projectId, baselineId, run.scenario_id, run.revision_number);
      if (baselineCoverage === undefined) {
        throw new ApplicationError("GATE_BLOCKED", "The test run does not belong to a scenario revision in the current baseline.");
      }
      const latestRun = database.prepare(
        `SELECT MAX(sequence) AS sequence FROM test_runs
         WHERE project_id = ? AND scenario_id = ? AND revision_number = ? AND build_id = ?`,
      ).get(input.projectId, run.scenario_id, run.revision_number, run.build_id) as { sequence: number };
      if (latestRun.sequence !== run.sequence) {
        throw new ApplicationError("VERSION_CONFLICT", "A newer run exists for this scenario revision and build; certify the latest run.");
      }
      const existing = database.prepare(
        `SELECT certification_id FROM test_run_certifications
         WHERE project_id = ? AND item_id = ? AND baseline_id = ? AND run_id = ?`,
      ).get(input.projectId, item.id, baselineId, runId);
      if (existing !== undefined) {
        throw new ApplicationError("VALIDATION_FAILED", "This run is already certified for the current baseline.");
      }
      const certification: TestRunCertification = {
        id: randomUUID(),
        projectId: input.projectId,
        itemId: item.id,
        itemKey: item.key,
        baselineId,
        runId,
        certifiedByPrincipalId: input.principalId,
        reason,
        certifiedAt: new Date().toISOString(),
      };
      database.prepare(
        `INSERT INTO test_run_certifications
          (certification_id, project_id, item_id, baseline_id, run_id, certified_by_principal_id, reason, certified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        certification.id, certification.projectId, certification.itemId, certification.baselineId,
        certification.runId, certification.certifiedByPrincipalId, certification.reason, certification.certifiedAt,
      );
      const updated = database.prepare(
        `UPDATE work_items SET version = version + 1, updated_at = ?
         WHERE project_id = ? AND item_id = ? AND version = ?`,
      ).run(certification.certifiedAt, input.projectId, item.id, input.expectedVersion);
      if (updated.changes !== 1) throw new ApplicationError("VERSION_CONFLICT", "The PBI changed while the run was being certified.");
      return { ...certification, version: input.expectedVersion + 1 };
    },
  });
}

function evaluateGates(
  database: SqliteDatabase,
  item: ReturnType<typeof getWorkItem>,
  principalId: string,
  targetState: "ready" | "done",
  buildId: string | null,
): WorkItemGateReport {
  const gates: WorkflowGate[] = [];
  if (targetState === "ready") {
    evaluateReadyGates(database, item, principalId, gates);
  } else {
    evaluateDoneGates(database, item, buildId, gates);
  }
  if (targetState === "done") {
    evaluateDependencies(database, item.projectId, item.id, gates);
  }
  return {
    itemId: item.id,
    itemKey: item.key,
    itemType: item.type,
    currentState: item.state,
    targetState,
    buildId,
    gates,
    canProceed: gates.every((gate) => gate.passed),
    transitionPath: shortestTransitionPath(item.state as WorkItemState, targetState),
    warnings: independenceWarnings(database, item, principalId, targetState),
  };
}

/**
 * Aviso não bloqueante: o mesmo principal que implementou a tarefa também a revisou/validou.
 * Agentes costumam operar com a identidade do humano; o aviso torna a falta de revisor independente visível.
 */
function independenceWarnings(
  database: SqliteDatabase,
  item: ReturnType<typeof getWorkItem>,
  principalId: string,
  targetState: "ready" | "done",
): WorkItemGateReport["warnings"] {
  if (targetState !== "done" || item.type !== "task") return [];
  const executors = database.prepare(
    `SELECT DISTINCT transitioned_by_principal_id AS principal FROM work_item_state_transitions
     WHERE project_id = ? AND item_id = ? AND to_state = 'in_progress'`,
  ).all(item.projectId, item.id) as Array<{ principal: string }>;
  const executedBySamePrincipal = item.assigneeId === principalId || executors.some((row) => row.principal === principalId);
  return executedBySamePrincipal
    ? [{
        code: "self_validation",
        message: "O principal que conclui a tarefa é o mesmo que a executou; não há revisão ou validação independente. Registre isso no motivo ou peça revisão de outro principal.",
      }]
    : [];
}

/** Estados intermediários e finais a percorrer para chegar ao alvo, sem passar por cancelled. */
export function shortestTransitionPath(from: WorkItemState, to: WorkItemState): WorkItemState[] {
  if (from === to) return [];
  const previous = new Map<WorkItemState, WorkItemState>();
  const queue: WorkItemState[] = [from];
  const seen = new Set<WorkItemState>([from]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of allowedTransitions[current] ?? []) {
      if (next === "cancelled" || seen.has(next)) continue;
      seen.add(next);
      previous.set(next, current);
      if (next === to) {
        const path: WorkItemState[] = [to];
        for (let step = previous.get(to); step !== undefined && step !== from; step = previous.get(step)) path.unshift(step);
        return path;
      }
      queue.push(next);
    }
  }
  return [];
}

function evaluateReadyGates(
  database: SqliteDatabase,
  item: ReturnType<typeof getWorkItem>,
  principalId: string,
  gates: WorkflowGate[],
): void {
  const blockingQuestions = openBlockingQuestions(database, item.projectId, item.id);
  addGate(gates, "no-blocking-questions", blockingQuestions.length === 0, blockingQuestions.length === 0
    ? "No blocking question is open."
    : "Answer the blocking open questions before Ready.", { openQuestions: blockingQuestions.map((question) => question.key) });
  if (item.type === "story" || item.type === "bug") {
    const published = database.prepare(
      `SELECT 1 FROM work_item_revisions
       WHERE project_id = ? AND item_id = ? AND status = 'published'`,
    ).get(item.projectId, item.id) !== undefined;
    addGate(gates, "published-content", published, published ? "A published PBI revision is available." : "Publish PBI content before Ready.");

    addGate(gates, "acceptance-criteria", item.criteria.length > 0, item.criteria.length > 0
      ? "The PBI has acceptance criteria."
      : "Add acceptance criteria before Ready.");
    const missingCoverage = item.criteria
      .filter((criterion) => criterion.required)
      .filter((criterion) => !hasPublishedCriterionScenario(database, item.projectId, criterion.id))
      .map((criterion) => criterion.key);
    addGate(gates, "required-criterion-coverage", missingCoverage.length === 0,
      missingCoverage.length === 0 ? "Every required criterion has a published scenario." : "Required criteria need a published scenario.",
      { uncoveredCriteria: missingCoverage });
    const confirmedPoints = item.estimates.some((estimate) => estimate.unit === "points");
    addGate(gates, "confirmed-estimate", confirmedPoints, confirmedPoints
      ? "The PBI has a confirmed point estimate."
      : "Confirm a point estimate before Ready.");
    const unpublishedSpecs = database.prepare(
      `SELECT s.spec_key FROM trace_links l
       INNER JOIN specifications s ON s.project_id = l.project_id AND s.spec_id = l.target_id
       WHERE l.project_id = ? AND l.source_id = ? AND l.link_type = 'implements' AND l.removed_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM specification_revisions r
           WHERE r.project_id = s.project_id AND r.spec_id = s.spec_id AND r.status = 'published'
         ) ORDER BY s.spec_key COLLATE NOCASE`,
    ).all(item.projectId, item.id) as Array<{ spec_key: string }>;
    addGate(gates, "published-specifications", unpublishedSpecs.length === 0,
      unpublishedSpecs.length === 0 ? "All linked specifications have a published revision." : "Publish linked specifications before Ready.",
      { unpublishedSpecifications: unpublishedSpecs.map((row) => row.spec_key) });
    addGate(gates, "first-baseline", baselineIdForItem(database, item.projectId, item.id) === null,
      "A first Ready transition creates the baseline automatically.");
    return;
  }

  if (item.type === "task") {
    const parent = item.parentId === null ? undefined : getWorkItem(database, item.projectId, principalId, item.parentId);
    const parentReady = parent !== undefined && (parent.state === "ready" || parent.state === "in_progress");
    addGate(gates, "parent-pbi-ready", parentReady, parentReady
      ? "The parent PBI is Ready or in progress."
      : "The parent PBI must be Ready before the task can be prepared.");
    const taskBaseline = parent === undefined ? null : baselineIdForItem(database, item.projectId, parent.id);
    addGate(gates, "parent-baseline", taskBaseline !== null, taskBaseline !== null
      ? "The task inherits its PBI baseline."
      : "The parent PBI must have a fixed baseline.");
    addGate(gates, "task-assignee", item.assigneeId !== null, item.assigneeId !== null
      ? "The task has an eligible assignee."
      : "Assign a Developer or QA before Ready.");
    const hasDescription = item.description !== null && item.description.trim().length > 0;
    addGate(gates, "task-output", hasDescription, hasDescription
      ? "The task describes its expected output."
      : "Describe the task's expected output before Ready.");
    const unpublishedWorkflow = hasUnpublishedTaskWorkflow(database, item.projectId, item.id);
    addGate(gates, "task-workflow-publication", !unpublishedWorkflow,
      unpublishedWorkflow
        ? "Publish or withdraw the task workflow Draft before Ready."
        : "No unapproved task workflow Draft blocks Ready.",
      { hasUnpublishedDraft: unpublishedWorkflow });
    return;
  }
  addGate(gates, "aggregate-item", true, "Aggregate work items do not require PBI or task preparation gates.");
}

function evaluateDoneGates(
  database: SqliteDatabase,
  item: ReturnType<typeof getWorkItem>,
  buildId: string | null,
  gates: WorkflowGate[],
): void {
  if (item.type === "story" || item.type === "bug") {
    const baselineId = baselineIdForItem(database, item.projectId, item.id);
    addGate(gates, "ready-baseline", baselineId !== null, baselineId === null
      ? "A PBI baseline is required before Done."
      : "The PBI has a fixed baseline.");
    if (baselineId === null) return;
    const openImpacts = database.prepare(
      "SELECT impact_id, specification_id, published_revision FROM impact_flags WHERE project_id = ? AND item_id = ? AND status = 'open' ORDER BY created_at",
    ).all(item.projectId, item.id) as Array<{ impact_id: string; specification_id: string; published_revision: number }>;
    addGate(gates, "baseline-impacts", openImpacts.length === 0,
      openImpacts.length === 0 ? "The baseline has no open specification impacts." : "Revalidate open specification impacts before Done.",
      { impacts: openImpacts });

    const incompleteTasks = database.prepare(
      `SELECT item_key, state FROM work_items
       WHERE project_id = ? AND parent_id = ? AND type = 'task' AND state NOT IN ('done', 'cancelled')
       ORDER BY item_key COLLATE NOCASE`,
    ).all(item.projectId, item.id) as Array<{ item_key: string; state: string }>;
    addGate(gates, "required-tasks", incompleteTasks.length === 0,
      incompleteTasks.length === 0 ? "All non-cancelled child tasks are done." : "Complete every active child task before Done.",
      { incompleteTasks });

    const childTasks = database.prepare(
      "SELECT item_id, item_key FROM work_items WHERE project_id = ? AND parent_id = ? AND type = 'task' AND state = 'done' ORDER BY item_key COLLATE NOCASE",
    ).all(item.projectId, item.id) as Array<{ item_id: string; item_key: string }>;
    const unattested = childTasks
      .map((task) => ({ task: task.item_key, criteria: unattestedDefinitionOfDone(database, item.projectId, task.item_id) }))
      .filter((entry) => entry.criteria.length > 0);
    addGate(gates, "definition-of-done-attested", unattested.length === 0,
      unattested.length === 0 ? "Every done task attests its pinned Definition of Done." : "Attest every pinned Definition of Done criterion in the tasks' delivery reports.",
      { unattested });

    if (buildId === null) {
      addGate(gates, "candidate-build", false, "Supply the candidate build ID for the final QA gate.");
    }
    const evidenceCount = buildId === null ? 0 : (database.prepare(
      `SELECT COUNT(*) AS count FROM evidence
       WHERE project_id = ? AND item_id = ? AND baseline_id = ? AND build_id = ?`,
    ).get(item.projectId, item.id, baselineId, buildId) as { count: number }).count;
    addGate(gates, "candidate-build-evidence", evidenceCount > 0,
      evidenceCount > 0 ? "Evidence is attached to the pinned baseline and candidate build." : "Add evidence for this baseline and candidate build.",
      { evidenceCount, buildId });

    const baselineScenarios = database.prepare(
      `SELECT br.entity_id AS scenario_id, br.revision_number, s.scenario_key
       FROM baseline_refs br INNER JOIN scenarios s
         ON s.project_id = br.project_id AND s.scenario_id = br.entity_id
       WHERE br.project_id = ? AND br.baseline_id = ? AND br.entity_type = 'scenario_revision'
       ORDER BY s.scenario_key COLLATE NOCASE`,
    ).all(item.projectId, baselineId) as Array<{ scenario_id: string; revision_number: number; scenario_key: string }>;
    if (baselineScenarios.length === 0) {
      addGate(gates, "qa-coverage", false, "The baseline has no covered scenarios; add published coverage and revalidate.");
    }
    for (const scenario of baselineScenarios) {
      if (buildId === null) continue;
      const latest = database.prepare(
        `SELECT tr.run_id, tr.result, tr.sequence, tr.build_id
         FROM test_runs tr
         WHERE tr.project_id = ? AND tr.scenario_id = ? AND tr.revision_number = ? AND tr.build_id = ?
         ORDER BY tr.sequence DESC LIMIT 1`,
      ).get(item.projectId, scenario.scenario_id, scenario.revision_number, buildId) as {
        run_id: string; result: string; sequence: number; build_id: string;
      } | undefined;
      if (latest === undefined) {
        const otherBuilds = database.prepare(
          `SELECT build_id AS buildId, result FROM test_runs
           WHERE project_id = ? AND scenario_id = ? AND revision_number = ?
           GROUP BY build_id ORDER BY MAX(sequence) DESC LIMIT 5`,
        ).all(item.projectId, scenario.scenario_id, scenario.revision_number) as Array<{ buildId: string; result: string }>;
        addGate(gates, `scenario:${scenario.scenario_key}:build`, false,
          otherBuilds.length > 0 ? "Scenario results exist for a different build." : "Run this scenario against the candidate build.",
          { scenarioKey: scenario.scenario_key, candidateBuildId: buildId, availableBuilds: otherBuilds });
        continue;
      }
      if (latest.result !== "passed") {
        addGate(gates, `scenario:${scenario.scenario_key}:result`, false, "The latest scenario result for the candidate build did not pass.", {
          scenarioKey: scenario.scenario_key, runId: latest.run_id, result: latest.result, buildId,
        });
        continue;
      }
      const certification = database.prepare(
        `SELECT certification_id FROM test_run_certifications
         WHERE project_id = ? AND item_id = ? AND baseline_id = ? AND run_id = ?`,
      ).get(item.projectId, item.id, baselineId, latest.run_id) as { certification_id: string } | undefined;
      addGate(gates, `scenario:${scenario.scenario_key}:certification`, certification !== undefined,
        certification === undefined ? "A human QA member must certify the latest passing run." : "The latest passing run is certified by QA.",
        { scenarioKey: scenario.scenario_key, runId: latest.run_id, buildId, certificationId: certification?.certification_id ?? null });
    }
    return;
  }

  if (item.type === "task") {
    const baselineId = item.parentId === null ? null : baselineIdForItem(database, item.projectId, item.parentId);
    const evidence = baselineId === null ? undefined : database.prepare(
      `SELECT evidence_id, build_id FROM evidence
       WHERE project_id = ? AND item_id = ? AND baseline_id = ?
         AND (? IS NULL OR build_id = ?) ORDER BY sequence LIMIT 1`,
    ).get(item.projectId, item.id, baselineId, buildId, buildId) as { evidence_id: string; build_id: string | null } | undefined;
    addGate(gates, "task-evidence", evidence !== undefined,
      evidence === undefined ? "Attach evidence to the task under its current PBI baseline." : "The task has evidence under its current PBI baseline.",
      { baselineId, evidenceId: evidence?.evidence_id ?? null, buildId });
    const workflow = getCurrentTaskWorkflowProgress(database, item.projectId, item.id);
    const hasDraftWithoutPublished = hasUnpublishedTaskWorkflow(database, item.projectId, item.id);
    addGate(gates, "task-workflow-complete", hasDraftWithoutPublished ? false : workflow === null || workflow.allStepsDone,
      hasDraftWithoutPublished
        ? "Publish or withdraw the Draft task workflow before completing the task."
        : workflow === null
          ? "No workflow is configured; the legacy task completion gates apply."
          : workflow.allStepsDone
            ? "All steps in the published task workflow are complete."
            : "Complete every step in the published task workflow before Done.",
      workflow === null ? { hasUnpublishedDraft: hasDraftWithoutPublished } : {
        revisionNumber: workflow.revisionNumber,
        progressPercent: workflow.progressPercent,
        incompleteSteps: workflow.totalSteps - workflow.completedSteps,
      });
    return;
  }

  const incompleteChildren = database.prepare(
    `SELECT item_key, state FROM work_items
     WHERE project_id = ? AND parent_id = ? AND state NOT IN ('done', 'cancelled')
     ORDER BY item_key COLLATE NOCASE`,
  ).all(item.projectId, item.id) as Array<{ item_key: string; state: string }>;
  addGate(gates, "child-items", incompleteChildren.length === 0,
    incompleteChildren.length === 0 ? "All active child work items are done." : "Complete active child work items before closing the aggregate.",
    { incompleteChildren });
}

function evaluateDependencies(database: SqliteDatabase, projectId: string, itemId: string, gates: WorkflowGate[]): void {
  const dependencies = database.prepare(
    `SELECT target.item_key, target.state FROM trace_links l
     INNER JOIN work_items target ON target.project_id = l.project_id AND target.item_id = l.target_id
     WHERE l.project_id = ? AND l.source_id = ? AND l.link_type = 'depends_on' AND l.removed_at IS NULL
     ORDER BY target.item_key COLLATE NOCASE`,
  ).all(projectId, itemId) as Array<{ item_key: string; state: string }>;
  const incomplete = dependencies.filter((dependency) => dependency.state !== "done");
  addGate(gates, "dependencies", incomplete.length === 0,
    incomplete.length === 0 ? "All prerequisites are done." : "Complete prerequisites before advancing this work item.",
    { incompleteDependencies: incomplete });
}

export function hasPublishedCriterionScenario(database: SqliteDatabase, projectId: string, criterionId: string): boolean {
  return database.prepare(
    `SELECT 1 FROM scenario_revision_coverage c
     INNER JOIN scenario_revisions r ON r.project_id = c.project_id AND r.scenario_id = c.scenario_id
       AND r.revision_number = c.revision_number AND r.status = 'published'
     WHERE c.project_id = ? AND c.target_type = 'criterion' AND c.target_id = ? LIMIT 1`,
  ).get(projectId, criterionId) !== undefined;
}

function assertDependenciesComplete(database: SqliteDatabase, projectId: string, itemId: string): void {
  const gates: WorkflowGate[] = [];
  evaluateDependencies(database, projectId, itemId, gates);
  const failed = gates.filter((gate) => !gate.passed);
  if (failed.length > 0) {
    throw new ApplicationError("GATE_BLOCKED", "The work item cannot start while dependencies are incomplete.", { details: failed });
  }
}

function baselineIdForItem(database: SqliteDatabase, projectId: string, itemId: string): string | null {
  const row = database.prepare(
    `SELECT baseline_id FROM work_baselines
     WHERE project_id = ? AND item_id = ? ORDER BY sequence DESC LIMIT 1`,
  ).get(projectId, itemId) as { baseline_id: string } | undefined;
  if (row !== undefined) return row.baseline_id;
  const item = database.prepare(
    "SELECT parent_id, type FROM work_items WHERE project_id = ? AND item_id = ?",
  ).get(projectId, itemId) as { parent_id: string | null; type: string } | undefined;
  if (item?.type !== "task" || item.parent_id === null) return null;
  const parent = database.prepare(
    `SELECT baseline_id FROM work_baselines
     WHERE project_id = ? AND item_id = ? ORDER BY sequence DESC LIMIT 1`,
  ).get(projectId, item.parent_id) as { baseline_id: string } | undefined;
  return parent?.baseline_id ?? null;
}

function addGate(
  gates: WorkflowGate[],
  id: string,
  passed: boolean,
  message: string,
  details?: unknown,
): void {
  gates.push({ id, passed, message, ...(details === undefined ? {} : { details }) });
}

function assertHumanPrincipal(database: SqliteDatabase, principalId: string, message: string): void {
  const row = database.prepare("SELECT principal_type FROM principals WHERE principal_id = ?")
    .get(principalId) as { principal_type: string } | undefined;
  if (row?.principal_type !== "human") throw new ApplicationError("FORBIDDEN", message);
}

function assertExpectedVersion(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new ApplicationError("VALIDATION_FAILED", "Expected version must be a positive integer.");
  }
  if (actual !== expected) {
    throw new ApplicationError("VERSION_CONFLICT", "The work item changed since it was read.", {
      details: { expectedVersion: expected, actualVersion: actual },
    });
  }
}

function normalizeText(value: string, maxLength: number, message: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) throw new ApplicationError("VALIDATION_FAILED", message);
  return normalized;
}

function normalizeOptionalText(value: string | undefined, maxLength: number, message: string): string | null {
  if (value === undefined) return null;
  return normalizeText(value, maxLength, message);
}

function decodeEvidenceCursor(value: string): EvidenceCursor {
  if (value.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "The evidence cursor is invalid.");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object") throw new Error("Invalid cursor");
    const cursor = parsed as Record<string, unknown>;
    if (
      cursor.version !== 1 || typeof cursor.projectId !== "string" || typeof cursor.principalId !== "string" ||
      typeof cursor.itemId !== "string" || typeof cursor.watermark !== "number" || !Number.isSafeInteger(cursor.watermark) ||
      typeof cursor.afterSequence !== "number" || !Number.isSafeInteger(cursor.afterSequence) || cursor.afterSequence < 0
    ) throw new Error("Invalid cursor shape");
    return cursor as unknown as EvidenceCursor;
  } catch {
    throw new ApplicationError("VALIDATION_FAILED", "The evidence cursor is invalid.");
  }
}

function encodeEvidenceCursor(cursor: EvidenceCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function toEvidence(row: EvidenceRow): WorkItemEvidence {
  return {
    id: row.evidence_id,
    projectId: row.project_id,
    itemId: row.item_id,
    itemKey: row.item_key,
    baselineId: row.baseline_id,
    kind: row.kind,
    uri: row.uri,
    buildId: row.build_id,
    description: row.description,
    addedByPrincipalId: row.added_by_principal_id,
    createdAt: row.created_at,
  };
}
