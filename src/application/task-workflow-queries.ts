import type { TaskWorkflowRevision, TaskWorkflowRevisionHistoryEntry, TaskWorkflowRevisionStatus, TaskWorkflowStepStatus, TaskWorkflowView } from "../domain/task-workflow.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { getWorkItem } from "./work-item-queries.js";

interface RevisionRow {
  readonly revision_id: string;
  readonly project_id: string;
  readonly item_id: string;
  readonly item_key: string;
  readonly revision_number: number;
  readonly status: TaskWorkflowRevisionStatus;
  readonly reason: string;
  readonly created_by_principal_id: string;
  readonly created_at: string;
  readonly published_by_principal_id: string | null;
  readonly published_at: string | null;
}

interface StepRow {
  readonly step_id: string;
  readonly position: number;
  readonly title: string;
  readonly description: string;
  readonly effort_basis_points: number;
  readonly status: TaskWorkflowStepStatus | null;
  readonly status_changed_at: string | null;
  readonly status_changed_by_principal_id: string | null;
  readonly status_reason: string | null;
}

export function getTaskWorkflow(
  database: SqliteDatabase,
  input: { readonly projectId: string; readonly principalId: string; readonly taskIdOrKey: string; readonly revisionNumber?: number },
): TaskWorkflowView {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  if (input.revisionNumber !== undefined && (!Number.isSafeInteger(input.revisionNumber) || input.revisionNumber < 1)) {
    throw new ApplicationError("VALIDATION_FAILED", "Workflow revision number must be a positive integer.");
  }
  const task = getWorkItem(database, input.projectId, input.principalId, input.taskIdOrKey.trim());
  if (task.type !== "task") throw new ApplicationError("VALIDATION_FAILED", "Task workflows can only be read for task work items.");
  const versions = database.prepare(
    `SELECT MAX(revision_number) AS latest_revision_number,
            MAX(CASE WHEN status = 'published' THEN revision_number END) AS published_revision_number,
            MAX(CASE WHEN status = 'draft' THEN revision_number END) AS draft_revision_number
     FROM task_workflow_revisions WHERE project_id = ? AND item_id = ?`,
  ).get(input.projectId, task.id) as {
    latest_revision_number: number | null;
    published_revision_number: number | null;
    draft_revision_number: number | null;
  };
  const revisionHistory = database.prepare(
    `SELECT revision_number, status, reason, created_at, published_at
     FROM task_workflow_revisions WHERE project_id = ? AND item_id = ?
     ORDER BY revision_number DESC LIMIT 51`,
  ).all(input.projectId, task.id) as Array<{
    revision_number: number; status: TaskWorkflowRevisionStatus; reason: string; created_at: string; published_at: string | null;
  }>;
  const historyTruncated = revisionHistory.length > 50;
  const history = revisionHistory.slice(0, 50).map((row): TaskWorkflowRevisionHistoryEntry => ({
    revisionNumber: row.revision_number, status: row.status, reason: row.reason,
    createdAt: row.created_at, publishedAt: row.published_at,
  }));
  const workflow = versions.published_revision_number === null
    ? null
    : readRevision(database, input.projectId, task.id, versions.published_revision_number);
  const draft = versions.draft_revision_number === null
    ? null
    : readRevision(database, input.projectId, task.id, versions.draft_revision_number);
  const selectedRevision = input.revisionNumber === undefined ? (workflow ?? draft) : readRevision(database, input.projectId, task.id, input.revisionNumber);
  if (input.revisionNumber !== undefined && selectedRevision === null) {
    throw new ApplicationError("NOT_FOUND", "Task workflow revision was not found.");
  }
  return {
    projectId: input.projectId,
    taskId: task.id,
    taskKey: task.key,
    taskState: task.state,
    taskVersion: task.version,
    latestRevisionNumber: versions.latest_revision_number ?? 0,
    revisionHistory: history,
    revisionHistoryTruncated: historyTruncated,
    workflow,
    draft,
    selectedRevision,
    selectedRevisionNumber: selectedRevision?.revisionNumber ?? null,
    selectedRevisionIsCurrent: selectedRevision !== null && selectedRevision.revisionNumber === workflow?.revisionNumber,
  };
}

export function getCurrentTaskWorkflowProgress(
  database: SqliteDatabase,
  projectId: string,
  itemId: string,
): { readonly revisionNumber: number; readonly progressPercent: number; readonly completedEffortPercent: number; readonly remainingEffortPercent: number; readonly allStepsDone: boolean; readonly totalSteps: number; readonly completedSteps: number } | null {
  const row = database.prepare(
    `SELECT revision_number FROM task_workflow_revisions
     WHERE project_id = ? AND item_id = ? AND status = 'published' LIMIT 1`,
  ).get(projectId, itemId) as { revision_number: number } | undefined;
  if (row === undefined) return null;
  const revision = readRevision(database, projectId, itemId, row.revision_number);
  if (revision === null || revision.progressPercent === null || revision.completedEffortPercent === null
      || revision.remainingEffortPercent === null || revision.allStepsDone === null) return null;
  return {
    revisionNumber: revision.revisionNumber,
    progressPercent: revision.progressPercent,
    completedEffortPercent: revision.completedEffortPercent,
    remainingEffortPercent: revision.remainingEffortPercent,
    allStepsDone: revision.allStepsDone,
    totalSteps: revision.steps.length,
    completedSteps: revision.steps.filter((step) => step.status === "done").length,
  };
}

export function hasUnpublishedTaskWorkflow(database: SqliteDatabase, projectId: string, itemId: string): boolean {
  return database.prepare(
    `SELECT 1 FROM task_workflow_revisions
     WHERE project_id = ? AND item_id = ? AND status = 'draft'
       AND NOT EXISTS (SELECT 1 FROM task_workflow_revisions p
         WHERE p.project_id = task_workflow_revisions.project_id AND p.item_id = task_workflow_revisions.item_id
           AND p.status = 'published') LIMIT 1`,
  ).get(projectId, itemId) !== undefined;
}

function readRevision(database: SqliteDatabase, projectId: string, itemId: string, revisionNumber: number): TaskWorkflowRevision | null {
  const row = database.prepare(
    `SELECT r.revision_id, r.project_id, r.item_id, wi.item_key, r.revision_number, r.status, r.reason,
            r.created_by_principal_id, r.created_at, r.published_by_principal_id, r.published_at
     FROM task_workflow_revisions r INNER JOIN work_items wi ON wi.project_id = r.project_id AND wi.item_id = r.item_id
     WHERE r.project_id = ? AND r.item_id = ? AND r.revision_number = ?`,
  ).get(projectId, itemId, revisionNumber) as RevisionRow | undefined;
  if (row === undefined) return null;
  const stepRows = database.prepare(
    `SELECT s.step_id, s.position, s.title, s.description, s.effort_basis_points,
            latest.to_status AS status, latest.occurred_at AS status_changed_at,
            latest.principal_id AS status_changed_by_principal_id, latest.reason AS status_reason
     FROM task_workflow_steps s
     LEFT JOIN task_workflow_step_events latest ON latest.sequence = (
       SELECT MAX(e.sequence) FROM task_workflow_step_events e
       WHERE e.project_id = s.project_id AND e.item_id = s.item_id
         AND e.revision_number = s.revision_number AND e.step_id = s.step_id
     )
     WHERE s.project_id = ? AND s.item_id = ? AND s.revision_number = ? ORDER BY s.position`,
  ).all(projectId, itemId, revisionNumber) as StepRow[];
  const steps = stepRows.map((step) => ({
    id: step.step_id,
    position: step.position,
    title: step.title,
    description: step.description,
    effortPercent: step.effort_basis_points / 100,
    status: step.status ?? "pending" as const,
    statusChangedAt: step.status_changed_at,
    statusChangedByPrincipalId: step.status_changed_by_principal_id,
    statusReason: step.status_reason,
  }));
  if (row.status !== "published" && row.status !== "superseded") {
    return {
      id: row.revision_id, projectId: row.project_id, taskId: row.item_id, taskKey: row.item_key,
      revisionNumber: row.revision_number, status: row.status, reason: row.reason,
      createdByPrincipalId: row.created_by_principal_id, createdAt: row.created_at,
      publishedByPrincipalId: row.published_by_principal_id, publishedAt: row.published_at,
      steps, progressPercent: null, completedEffortPercent: null, remainingEffortPercent: null, allStepsDone: null,
    };
  }
  const completedBasisPoints = stepRows.reduce((sum, step) => sum + (step.status === "done" ? step.effort_basis_points : 0), 0);
  const totalBasisPoints = stepRows.reduce((sum, step) => sum + step.effort_basis_points, 0);
  const percent = (basisPoints: number): number => Math.round(basisPoints) / 100;
  return {
    id: row.revision_id, projectId: row.project_id, taskId: row.item_id, taskKey: row.item_key,
    revisionNumber: row.revision_number, status: row.status, reason: row.reason,
    createdByPrincipalId: row.created_by_principal_id, createdAt: row.created_at,
    publishedByPrincipalId: row.published_by_principal_id, publishedAt: row.published_at,
    steps, progressPercent: percent(completedBasisPoints), completedEffortPercent: percent(completedBasisPoints),
    remainingEffortPercent: percent(totalBasisPoints - completedBasisPoints),
    allStepsDone: steps.length > 0 && steps.every((step) => step.status === "done"),
  };
}
