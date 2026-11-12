import { randomUUID } from "node:crypto";
import type { TaskWorkflowRevision, TaskWorkflowStepStatus } from "../domain/task-workflow.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { getTaskWorkflow, getCurrentTaskWorkflowProgress } from "./task-workflow-queries.js";
import { getWorkItem } from "./work-item-queries.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface TaskWorkflowStepInput {
  readonly id?: string;
  readonly title: string;
  readonly description: string;
  readonly effortPercent: number;
}

export interface ProposeTaskWorkflowInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly taskIdOrKey: string;
  readonly expectedTaskVersion: number;
  readonly expectedWorkflowVersion: number;
  readonly steps: readonly TaskWorkflowStepInput[];
  readonly reason: string;
}

export interface PublishTaskWorkflowInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly taskIdOrKey: string;
  readonly revisionNumber: number;
  readonly expectedTaskVersion: number;
  readonly reason: string;
}

export interface TransitionTaskWorkflowStepInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly taskIdOrKey: string;
  readonly revisionNumber: number;
  readonly stepId: string;
  readonly expectedTaskVersion: number;
  readonly targetStatus: TaskWorkflowStepStatus;
  readonly reason: string;
}

export interface TaskWorkflowStepTransitionResult {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskKey: string;
  readonly taskVersion: number;
  readonly revisionNumber: number;
  readonly stepId: string;
  readonly fromStatus: TaskWorkflowStepStatus;
  readonly toStatus: TaskWorkflowStepStatus;
  readonly changedAt: string;
  readonly progressPercent: number;
}

export interface TaskWorkflowPublication {
  readonly workflow: TaskWorkflowRevision;
  readonly migration: {
    readonly preservedStepIds: readonly string[];
    readonly resetStepIds: readonly string[];
    readonly previousProgressPercent: number | null;
  };
}

interface NormalizedStep {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly description: string;
  readonly effortBasisPoints: number;
}

export function proposeTaskWorkflow(database: SqliteDatabase, input: ProposeTaskWorkflowInput): CommandReceipt<TaskWorkflowRevision> {
  const item = getWorkItem(database, input.projectId, input.principalId, input.taskIdOrKey.trim());
  if (item.type !== "task") throw new ApplicationError("VALIDATION_FAILED", "Task workflows can only be proposed for task work items.");
  const reason = normalizeRequired(input.reason, 1_000, "A workflow proposal reason must contain 1-1000 characters.");
  assertExpectedVersion(input.expectedTaskVersion, 1, "Task version");
  assertExpectedVersion(input.expectedWorkflowVersion, 0, "Workflow version");
  if (!Number.isSafeInteger(input.expectedWorkflowVersion) || input.expectedWorkflowVersion < 0) {
    throw new ApplicationError("VALIDATION_FAILED", "Expected workflow version must be a non-negative integer.");
  }
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 50) {
    throw new ApplicationError("VALIDATION_FAILED", "A task workflow must contain 1-50 steps.");
  }
  const latestRows = database.prepare(
    `SELECT revision_number FROM task_workflow_revisions WHERE project_id = ? AND item_id = ?
     ORDER BY revision_number DESC LIMIT 1`,
  ).all(input.projectId, item.id) as Array<{ revision_number: number }>;
  const expectedWorkflowVersion = input.expectedWorkflowVersion;
  const normalizedSteps = normalizeSteps(input.steps, latestRows[0]?.revision_number ?? null, database, input.projectId, item.id);
  const totalBasisPoints = normalizedSteps.reduce((sum, step) => sum + step.effortBasisPoints, 0);
  if (totalBasisPoints !== 10_000) {
    throw new ApplicationError("VALIDATION_FAILED", "Task workflow effort percentages must total exactly 100.00%.", {
      details: { totalEffortPercent: totalBasisPoints / 100, requiredEffortPercent: 100 },
    });
  }
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "task_workflow.propose",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId, itemId: item.id, expectedTaskVersion: input.expectedTaskVersion,
      expectedWorkflowVersion, steps: normalizedSteps.map(({ effortBasisPoints, ...step }) => ({ ...step, effortBasisPoints })), reason,
    },
    requiredRoles: ["developer", "tech_lead"],
    auditEvent: (revision) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "task_workflow.revision_proposed",
      entityType: "work_item",
      entityId: item.id,
      reason,
      payload: { taskKey: item.key, revisionNumber: revision.revisionNumber, stepCount: normalizedSteps.length, totalEffortPercent: 100 },
    }),
    execute: () => {
      const current = getWorkItem(database, input.projectId, input.principalId, item.id);
      assertExpectedVersion(current.version, input.expectedTaskVersion, "Task version");
      assertTaskWorkflowEditable(current.state);
      const actualWorkflowVersion = (database.prepare(
        "SELECT COALESCE(MAX(revision_number), 0) AS revision FROM task_workflow_revisions WHERE project_id = ? AND item_id = ?",
      ).get(input.projectId, item.id) as { revision: number }).revision;
      if (actualWorkflowVersion !== expectedWorkflowVersion) {
        throw new ApplicationError("VERSION_CONFLICT", "The task workflow changed after it was read.", {
          details: { expectedWorkflowVersion, actualWorkflowVersion },
        });
      }
      const openDraft = database.prepare(
        `SELECT revision_number FROM task_workflow_revisions
         WHERE project_id = ? AND item_id = ? AND status = 'draft'`,
      ).get(input.projectId, item.id) as { revision_number: number } | undefined;
      if (openDraft !== undefined) {
        database.prepare(
          `UPDATE task_workflow_revisions SET status = 'withdrawn'
           WHERE project_id = ? AND item_id = ? AND revision_number = ? AND status = 'draft'`,
        ).run(input.projectId, item.id, openDraft.revision_number);
      }
      const revisionNumber = actualWorkflowVersion + 1;
      const revisionId = randomUUID();
      const now = new Date().toISOString();
      database.prepare(
        `INSERT INTO task_workflow_revisions
          (revision_id, project_id, item_id, revision_number, status, reason, created_by_principal_id, created_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
      ).run(revisionId, input.projectId, item.id, revisionNumber, reason, input.principalId, now);
      const insertStep = database.prepare(
        `INSERT INTO task_workflow_steps
          (project_id, item_id, revision_number, step_id, position, title, description, effort_basis_points)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const step of normalizedSteps) {
        insertStep.run(input.projectId, item.id, revisionNumber, step.id, step.position, step.title, step.description, step.effortBasisPoints);
      }
      incrementTaskVersion(database, input.projectId, item.id, input.expectedTaskVersion);
      const view = getTaskWorkflow(database, { projectId: input.projectId, principalId: input.principalId, taskIdOrKey: item.id });
      if (view.draft === null) throw new ApplicationError("INTERNAL", "The workflow draft was not visible after creation.");
      return view.draft;
    },
  });
}

export function publishTaskWorkflow(database: SqliteDatabase, input: PublishTaskWorkflowInput): CommandReceipt<TaskWorkflowPublication> {
  const item = getWorkItem(database, input.projectId, input.principalId, input.taskIdOrKey.trim());
  if (item.type !== "task") throw new ApplicationError("VALIDATION_FAILED", "Task workflows can only be published for task work items.");
  const reason = normalizeRequired(input.reason, 1_000, "A workflow publication reason must contain 1-1000 characters.");
  assertExpectedVersion(input.expectedTaskVersion, 1, "Task version");
  assertExpectedVersion(input.revisionNumber, 1, "Workflow revision number");
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "task_workflow.publish",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId, itemId: item.id, revisionNumber: input.revisionNumber,
      expectedTaskVersion: input.expectedTaskVersion, reason,
    },
    requiredRoles: ["tech_lead"],
    auditEvent: (revision) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "task_workflow.revision_published",
      entityType: "work_item",
      entityId: item.id,
      reason,
      payload: {
        taskKey: item.key, revisionNumber: revision.workflow.revisionNumber,
        stepCount: revision.workflow.steps.length, progressPercent: revision.workflow.progressPercent,
        preservedStepIds: revision.migration.preservedStepIds, resetStepIds: revision.migration.resetStepIds,
        previousProgressPercent: revision.migration.previousProgressPercent,
      },
    }),
    execute: () => {
      assertHumanPrincipal(database, input.principalId, "Only a human Tech Lead may publish a task workflow.");
      const current = getWorkItem(database, input.projectId, input.principalId, item.id);
      assertExpectedVersion(current.version, input.expectedTaskVersion, "Task version");
      assertTaskWorkflowEditable(current.state);
      const openSession = database.prepare(
        `SELECT session_id, status FROM development_sessions
         WHERE project_id = ? AND item_id = ? AND status IN ('active', 'paused') LIMIT 1`,
      ).get(input.projectId, item.id) as { session_id: string; status: string } | undefined;
      if (openSession !== undefined) {
        throw new ApplicationError("WORKFLOW_SESSION_OPEN", "Close or cancel every open development session before publishing a task workflow revision.", {
          details: { sessionId: openSession.session_id, status: openSession.status },
        });
      }
      const draft = database.prepare(
        `SELECT revision_id FROM task_workflow_revisions
         WHERE project_id = ? AND item_id = ? AND revision_number = ? AND status = 'draft'`,
      ).get(input.projectId, item.id, input.revisionNumber) as { revision_id: string } | undefined;
      if (draft === undefined) throw new ApplicationError("NOT_FOUND", "The requested Draft task workflow revision was not found.");
      const latestVersion = (database.prepare(
        "SELECT MAX(revision_number) AS revision FROM task_workflow_revisions WHERE project_id = ? AND item_id = ?",
      ).get(input.projectId, item.id) as { revision: number | null }).revision;
      if (latestVersion !== input.revisionNumber) {
        throw new ApplicationError("VERSION_CONFLICT", "Only the latest task workflow revision can be published.", {
          details: { requestedRevision: input.revisionNumber, latestRevision: latestVersion },
        });
      }

      const previous = getCurrentTaskWorkflowProgress(database, input.projectId, item.id);
      const previousView = previous === null ? null : getTaskWorkflow(database, {
        projectId: input.projectId, principalId: input.principalId, taskIdOrKey: item.id,
        revisionNumber: previous.revisionNumber,
      }).selectedRevision;
      const oldStepById = new Map((previousView?.steps ?? []).map((step) => [step.id, step]));
      const newSteps = database.prepare(
        `SELECT step_id, position, title, description FROM task_workflow_steps
         WHERE project_id = ? AND item_id = ? AND revision_number = ? ORDER BY position`,
      ).all(input.projectId, item.id, input.revisionNumber) as Array<{ step_id: string; position: number; title: string; description: string }>;
      const now = new Date().toISOString();
      database.prepare(
        `UPDATE task_workflow_revisions SET status = 'superseded'
         WHERE project_id = ? AND item_id = ? AND status = 'published'`,
      ).run(input.projectId, item.id);
      database.prepare(
        `UPDATE task_workflow_revisions
         SET status = 'published', published_by_principal_id = ?, published_at = ?
         WHERE project_id = ? AND item_id = ? AND revision_number = ? AND status = 'draft'`,
      ).run(input.principalId, now, input.projectId, item.id, input.revisionNumber);

      const insertEvent = database.prepare(
        `INSERT INTO task_workflow_step_events
          (event_id, project_id, item_id, revision_number, step_id, event_type, from_status, to_status,
           principal_id, reason, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const preservedStepIds: string[] = [];
      const resetStepIds: string[] = [];
      let previousStepsComplete = true;
      for (const step of newSteps) {
        const previousStep = oldStepById.get(step.step_id);
        if (previousStep === undefined) {
          previousStepsComplete = false;
          continue;
        }
        const definitionUnchanged = previousStep.title === step.title && previousStep.description === step.description;
        const violatesOrder: boolean = !previousStepsComplete && previousStep.status !== "pending";
        if (definitionUnchanged && !violatesOrder) {
          if (previousStep.status !== "pending") {
            insertEvent.run(randomUUID(), input.projectId, item.id, input.revisionNumber, step.step_id, "carried_forward",
              "pending", previousStep.status, input.principalId, `Preserve completed/in-progress step ${step.step_id} from workflow revision ${previous?.revisionNumber}.`, now);
          }
          preservedStepIds.push(step.step_id);
        } else {
          if (previousStep.status !== "pending") {
            insertEvent.run(randomUUID(), input.projectId, item.id, input.revisionNumber, step.step_id, "reset",
              previousStep.status, "pending", input.principalId,
              `${definitionUnchanged ? "Workflow order changed" : "Step definition changed"} from workflow revision ${previous?.revisionNumber}; progress reset to pending.`, now);
          }
          resetStepIds.push(step.step_id);
        }
        previousStepsComplete = definitionUnchanged && !violatesOrder && previousStep.status === "done";
      }
      incrementTaskVersion(database, input.projectId, item.id, input.expectedTaskVersion);
      const published = getTaskWorkflow(database, { projectId: input.projectId, principalId: input.principalId, taskIdOrKey: item.id }).workflow;
      if (published === null) throw new ApplicationError("INTERNAL", "The published task workflow was not visible after publication.");
      return {
        workflow: published,
        migration: { preservedStepIds, resetStepIds, previousProgressPercent: previous?.progressPercent ?? null },
      };
    },
  });
}

export function transitionTaskWorkflowStep(database: SqliteDatabase, input: TransitionTaskWorkflowStepInput): CommandReceipt<TaskWorkflowStepTransitionResult> {
  const item = getWorkItem(database, input.projectId, input.principalId, input.taskIdOrKey.trim());
  if (item.type !== "task") throw new ApplicationError("VALIDATION_FAILED", "Workflow steps can only be updated on task work items.");
  const reason = normalizeRequired(input.reason, 1_000, "A workflow step update reason must contain 1-1000 characters.");
  assertExpectedVersion(input.expectedTaskVersion, 1, "Task version");
  assertExpectedVersion(input.revisionNumber, 1, "Workflow revision number");
  if (!["pending", "in_progress", "done"].includes(input.targetStatus)) {
    throw new ApplicationError("VALIDATION_FAILED", "Workflow step status must be pending, in_progress, or done.");
  }
  if (!uuidPattern.test(input.stepId)) throw new ApplicationError("VALIDATION_FAILED", "Workflow step ID must be a UUID.");
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "task_workflow.step_transition",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId, itemId: item.id, revisionNumber: input.revisionNumber, stepId: input.stepId,
      expectedTaskVersion: input.expectedTaskVersion, targetStatus: input.targetStatus, reason,
    },
    requiredRoles: ["developer", "tech_lead"],
    auditEvent: (result) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "task_workflow.step_status_changed",
      entityType: "work_item",
      entityId: item.id,
      reason,
      payload: {
        taskKey: item.key, taskVersion: result.taskVersion, revisionNumber: result.revisionNumber,
        stepId: result.stepId, fromStatus: result.fromStatus, toStatus: result.toStatus,
        progressPercent: result.progressPercent,
      },
    }),
    execute: () => {
      const current = getWorkItem(database, input.projectId, input.principalId, item.id);
      assertExpectedVersion(current.version, input.expectedTaskVersion, "Task version");
      if (current.state !== "in_progress") throw new ApplicationError("INVALID_TRANSITION", "Workflow step progress can only change while the task is in progress.");
      const published = database.prepare(
        `SELECT revision_number FROM task_workflow_revisions
         WHERE project_id = ? AND item_id = ? AND status = 'published'`,
      ).get(input.projectId, item.id) as { revision_number: number } | undefined;
      if (published?.revision_number !== input.revisionNumber) {
        throw new ApplicationError("VERSION_CONFLICT", "Workflow step update does not target the current published revision.", {
          details: { requestedRevision: input.revisionNumber, currentRevision: published?.revision_number ?? null },
        });
      }
      const orderedSteps = database.prepare(
        `SELECT s.step_id, s.position,
                (SELECT e.to_status FROM task_workflow_step_events e
                 WHERE e.project_id = s.project_id AND e.item_id = s.item_id
                   AND e.revision_number = s.revision_number AND e.step_id = s.step_id
                 ORDER BY e.sequence DESC LIMIT 1) AS status
         FROM task_workflow_steps s
         WHERE s.project_id = ? AND s.item_id = ? AND s.revision_number = ? ORDER BY s.position`,
      ).all(input.projectId, item.id, input.revisionNumber) as Array<{
        step_id: string; position: number; status: TaskWorkflowStepStatus | null;
      }>;
      const step = orderedSteps.find((candidate) => candidate.step_id === input.stepId);
      if (step === undefined) throw new ApplicationError("NOT_FOUND", "Workflow step was not found in the published revision.");
      const fromStatus = step.status ?? "pending";
      if (fromStatus === input.targetStatus) throw new ApplicationError("VALIDATION_FAILED", "The workflow step already has that status.");
      if (fromStatus === "pending" && input.targetStatus === "done") {
        throw new ApplicationError("INVALID_TRANSITION", "Start a pending workflow step before completing it.");
      }
      if (fromStatus === "done" && input.targetStatus !== "pending") {
        throw new ApplicationError("INVALID_TRANSITION", "A completed workflow step can only be reset to pending by a human Tech Lead.");
      }
      if (fromStatus === "done" && input.targetStatus === "pending") {
        assertHumanPrincipal(database, input.principalId, "Only a human Tech Lead may reset a completed workflow step.");
        assertProjectAuthorization(database, input.projectId, input.principalId, ["tech_lead"]);
        const open = database.prepare(
          `SELECT session_id FROM development_sessions
           WHERE project_id = ? AND item_id = ? AND status IN ('active', 'paused') LIMIT 1`,
        ).get(input.projectId, item.id) as { session_id: string } | undefined;
        if (open !== undefined) throw new ApplicationError("WORKFLOW_SESSION_OPEN", "Close every open development session before correcting completed workflow progress.", { details: open });
      } else {
        if (input.targetStatus === "pending" && fromStatus !== "in_progress") {
          throw new ApplicationError("INVALID_TRANSITION", "Only an in-progress workflow step can return to pending.");
        }
        if (current.assigneeId !== input.principalId) throw new ApplicationError("FORBIDDEN", "Only the task's assigned Developer can update workflow progress.");
        const activeSession = database.prepare(
          `SELECT session_id FROM development_sessions
           WHERE project_id = ? AND item_id = ? AND developer_principal_id = ? AND status = 'active' LIMIT 1`,
        ).get(input.projectId, item.id, input.principalId) as { session_id: string } | undefined;
        if (activeSession === undefined) throw new ApplicationError("FORBIDDEN", "An active development session owned by the assigned Developer is required to update workflow progress.");
        const pinnedRevision = database.prepare(
          `SELECT revision_number FROM development_session_workflow_refs
           WHERE project_id = ? AND session_id = ?`,
        ).get(input.projectId, activeSession.session_id) as { revision_number: number } | undefined;
        if (pinnedRevision?.revision_number !== input.revisionNumber) {
          throw new ApplicationError("VERSION_CONFLICT", "The active development session did not pin this workflow revision.", {
            details: { sessionId: activeSession.session_id, pinnedRevision: pinnedRevision?.revision_number ?? null },
          });
        }
      }
      const blockedEarlierSteps = input.targetStatus === "pending" ? [] : orderedSteps
        .filter((candidate) => candidate.position < step.position && (candidate.status ?? "pending") !== "done")
        .map((candidate) => candidate.step_id);
      if (blockedEarlierSteps.length > 0) {
        throw new ApplicationError("INVALID_TRANSITION", "Complete earlier workflow steps before starting or completing this step.", {
          details: { blockedByStepIds: blockedEarlierSteps },
        });
      }
      const downstreamSteps = input.targetStatus === "pending" ? orderedSteps
        .filter((candidate) => candidate.position > step.position && (candidate.status ?? "pending") !== "pending")
        .map((candidate) => candidate.step_id) : [];
      if (downstreamSteps.length > 0) {
        throw new ApplicationError("INVALID_TRANSITION", "Reopen downstream steps in reverse order before resetting this step.", {
          details: { downstreamStepIds: downstreamSteps },
        });
      }
      const newVersion = incrementTaskVersion(database, input.projectId, item.id, input.expectedTaskVersion);
      const changedAt = new Date().toISOString();
      database.prepare(
        `INSERT INTO task_workflow_step_events
          (event_id, project_id, item_id, revision_number, step_id, event_type, from_status, to_status,
           principal_id, reason, occurred_at)
         VALUES (?, ?, ?, ?, ?, 'status_changed', ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), input.projectId, item.id, input.revisionNumber, input.stepId, fromStatus, input.targetStatus, input.principalId, reason, changedAt);
      const progress = getCurrentTaskWorkflowProgress(database, input.projectId, item.id);
      if (progress === null) throw new ApplicationError("INTERNAL", "Published workflow progress disappeared after update.");
      return {
        projectId: input.projectId, taskId: item.id, taskKey: item.key, taskVersion: newVersion,
        revisionNumber: input.revisionNumber, stepId: input.stepId, fromStatus, toStatus: input.targetStatus,
        changedAt, progressPercent: progress.progressPercent,
      };
    },
  });
}

function normalizeSteps(steps: readonly TaskWorkflowStepInput[], latestRevisionNumber: number | null, database: SqliteDatabase, projectId: string, itemId: string): NormalizedStep[] {
  const previousIds = latestRevisionNumber === null ? new Set<string>() : new Set((database.prepare(
    `SELECT step_id FROM task_workflow_steps WHERE project_id = ? AND item_id = ? AND revision_number = ?`,
  ).all(projectId, itemId, latestRevisionNumber) as Array<{ step_id: string }>).map((row) => row.step_id));
  const ids = new Set<string>();
  const result = steps.map((step, index): NormalizedStep => {
    const id = step.id?.trim() || randomUUID();
    if (!uuidPattern.test(id) || (step.id !== undefined && !previousIds.has(id)) || ids.has(id)) {
      throw new ApplicationError("VALIDATION_FAILED", "Workflow step IDs must be unique UUIDs from the previous revision; omit the ID for a new step.");
    }
    ids.add(id);
    const title = normalizeRequired(step.title, 160, "Workflow step titles must contain 1-160 characters.");
    const description = normalizeRequired(step.description, 4_000, "Workflow step instructions must contain 1-4000 characters.");
    if (!Number.isFinite(step.effortPercent) || step.effortPercent <= 0 || step.effortPercent > 100) {
      throw new ApplicationError("VALIDATION_FAILED", "Workflow step effortPercent must be greater than 0 and no more than 100.");
    }
    const effortBasisPoints = Math.round(step.effortPercent * 100);
    if (Math.abs(step.effortPercent * 100 - effortBasisPoints) > 1e-7) {
      throw new ApplicationError("VALIDATION_FAILED", "Workflow effort percentages support at most two decimal places.");
    }
    return { id, position: index + 1, title, description, effortBasisPoints };
  });
  return result;
}

function assertTaskWorkflowEditable(state: string): void {
  if (state !== "draft" && state !== "ready" && state !== "in_progress") {
    throw new ApplicationError("INVALID_TRANSITION", "Task workflows can only be proposed or published while the task is Draft, Ready, or in progress.");
  }
}

function incrementTaskVersion(database: SqliteDatabase, projectId: string, itemId: string, expectedVersion: number): number {
  const result = database.prepare(
    `UPDATE work_items SET version = version + 1, updated_at = ?
     WHERE project_id = ? AND item_id = ? AND version = ?`,
  ).run(new Date().toISOString(), projectId, itemId, expectedVersion);
  if (result.changes !== 1) throw new ApplicationError("VERSION_CONFLICT", "The task changed while workflow data was being saved.");
  return expectedVersion + 1;
}

function assertExpectedVersion(value: number, minimum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ApplicationError("VALIDATION_FAILED", `${label} must be an integer of at least ${minimum}.`);
  }
}

function normalizeRequired(value: string, max: number, message: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > max) throw new ApplicationError("VALIDATION_FAILED", message);
  return normalized;
}

function assertHumanPrincipal(database: SqliteDatabase, principalId: string, message: string): void {
  const row = database.prepare("SELECT principal_type FROM principals WHERE principal_id = ?")
    .get(principalId) as { principal_type: string } | undefined;
  if (row?.principal_type !== "human") throw new ApplicationError("FORBIDDEN", message);
}
