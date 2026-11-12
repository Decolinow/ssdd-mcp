import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { getWorkItem } from "./work-item-queries.js";
import { getTaskClaimReadiness } from "./work-item-workflow.js";

export interface ClaimTaskForDevelopmentInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly itemIdOrKey: string;
  readonly expectedVersion: number;
  readonly reason: string;
}

export interface ClaimedTask {
  readonly id: string;
  readonly key: string;
  readonly assigneeId: string;
  readonly state: "ready";
  readonly version: number;
}

/** Claims a Ready task only when all development gates except assignment already pass. */
export function claimTaskForDevelopment(
  database: SqliteDatabase,
  input: ClaimTaskForDevelopmentInput,
): CommandReceipt<ClaimedTask> {
  const reference = input.itemIdOrKey.trim();
  const reason = input.reason.trim();
  if (reference.length === 0 || reference.length > 120) {
    throw new ApplicationError("VALIDATION_FAILED", "Task reference must contain 1-120 characters.");
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new ApplicationError("VALIDATION_FAILED", "Expected task version must be a positive integer.");
  }
  if (reason.length === 0 || reason.length > 1_000) {
    throw new ApplicationError("VALIDATION_FAILED", "A reason of 1-1000 characters is required.");
  }

  const initial = getWorkItem(database, input.projectId, input.principalId, reference);
  if (initial.type !== "task") {
    throw new ApplicationError("VALIDATION_FAILED", "Only task work items can be claimed for development.");
  }

  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "task.development.claim",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      itemId: initial.id,
      expectedVersion: input.expectedVersion,
      reason,
    },
    requiredRoles: ["developer"],
    auditEvent: (task) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "work_item.assigned",
      entityType: "work_item",
      entityId: task.id,
      reason,
      payload: { assigneeId: task.assigneeId, version: task.version, source: "dashboard_quick_access" },
    }),
    execute: () => {
      const task = getWorkItem(database, input.projectId, input.principalId, initial.id);
      if (task.version !== input.expectedVersion) {
        throw new ApplicationError("VERSION_CONFLICT", "The task changed before it could be claimed.", {
          details: { expectedVersion: input.expectedVersion, currentVersion: task.version },
        });
      }
      if (task.state !== "ready") {
        throw new ApplicationError("TASK_NOT_STARTABLE", "Only a Ready task can be claimed.", {
          details: { state: task.state },
        });
      }
      if (task.assigneeId !== null) {
        throw new ApplicationError("TASK_ALREADY_ASSIGNED", "The task is no longer available to claim.", {
          details: { assigneeId: task.assigneeId },
        });
      }

      const readiness = getTaskClaimReadiness(database, {
        projectId: input.projectId,
        principalId: input.principalId,
        itemIdOrKey: task.id,
      });
      if (!readiness.canStart) {
        throw new ApplicationError("TASK_NOT_STARTABLE", "The task has development gates that must be resolved before it can be claimed.", {
          details: { blockers: readiness.blockers.map(({ code, message }) => ({ code, message })) },
        });
      }

      const result = database.prepare(
        `UPDATE work_items
         SET assignee_principal_id = ?, version = version + 1, updated_at = ?
         WHERE project_id = ? AND item_id = ? AND state = 'ready'
           AND assignee_principal_id IS NULL AND version = ?`,
      ).run(input.principalId, new Date().toISOString(), input.projectId, task.id, input.expectedVersion);
      if (result.changes !== 1) {
        throw new ApplicationError("VERSION_CONFLICT", "The task changed before it could be claimed.");
      }
      return {
        id: task.id,
        key: task.key,
        assigneeId: input.principalId,
        state: "ready",
        version: input.expectedVersion + 1,
      };
    },
  });
}
