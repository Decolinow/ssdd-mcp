import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import type { WorkItemTransition } from "../domain/workflow.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import type { DevelopmentSession } from "./development-lifecycle.js";
import { startDevelopmentSession } from "./development-lifecycle.js";
import { getTaskStartReadiness, transitionWorkItem } from "./work-item-workflow.js";
import { getWorkItem } from "./work-item-queries.js";

export interface StartTaskDevelopmentInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly itemIdOrKey: string;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly sessionReference?: string;
}

export interface TaskDevelopmentStartResult {
  readonly task: { readonly id: string; readonly key: string; readonly state: "in_progress"; readonly version: number };
  readonly transition: WorkItemTransition | null;
  readonly session: DevelopmentSession;
  readonly operationAuditEventIds: readonly string[];
}

export function startTaskDevelopment(
  database: SqliteDatabase,
  input: StartTaskDevelopmentInput,
): CommandReceipt<TaskDevelopmentStartResult> {
  const requestId = input.requestId.trim();
  const reference = input.itemIdOrKey.trim();
  const reason = input.reason.trim();
  if (requestId.length === 0 || requestId.length > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "Request ID must contain 1-100 characters.");
  }
  if (reference.length === 0 || reference.length > 120) {
    throw new ApplicationError("VALIDATION_FAILED", "Task reference must contain 1-120 characters.");
  }
  if (reason.length === 0 || reason.length > 1_000) {
    throw new ApplicationError("VALIDATION_FAILED", "A reason of 1-1000 characters is required.");
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new ApplicationError("VALIDATION_FAILED", "Expected task version must be a positive integer.");
  }

  const initial = getWorkItem(database, input.projectId, input.principalId, reference);
  if (initial.type !== "task") throw new ApplicationError("VALIDATION_FAILED", "Only task work items can be started for development.");
  const sessionReference = input.sessionReference?.trim() || undefined;

  const transaction = database.transaction(() => executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "task.development.start",
    requestId,
    payload: {
      projectId: input.projectId,
      itemId: initial.id,
      expectedVersion: input.expectedVersion,
      reason,
      sessionReference: sessionReference ?? null,
    },
    requiredRoles: ["developer"],
    auditEvent: (result) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "task.development_started",
      entityType: "development_session",
      entityId: result.session.id,
      reason,
      payload: {
        itemId: result.task.id,
        itemKey: result.task.key,
        taskVersion: result.task.version,
        transitionId: result.transition?.id ?? null,
        sessionId: result.session.id,
        sessionReference: result.session.sessionReference,
        technicalSpecifications: result.session.technicalSpecifications.map((specification) => ({
          key: specification.key,
          revisionNumber: specification.revisionNumber,
        })),
        scenarios: result.session.scenarios.map((scenario) => ({ key: scenario.key, revisionNumber: scenario.revisionNumber })),
      },
    }),
    execute: () => {
      const current = getWorkItem(database, input.projectId, input.principalId, initial.id);
      if (current.version !== input.expectedVersion) {
        throw new ApplicationError("VERSION_CONFLICT", "The task changed before development could start.", {
          details: { expectedVersion: input.expectedVersion, currentVersion: current.version },
        });
      }
      const readiness = getTaskStartReadiness(database, {
        projectId: input.projectId,
        principalId: input.principalId,
        itemIdOrKey: current.id,
      });
      if (!readiness.canStart) {
        throw new ApplicationError("START_BLOCKED", "The task cannot start development until its blockers are resolved.", { details: readiness });
      }

      let transition: WorkItemTransition | null = null;
      const operationAuditEventIds: string[] = [];
      let sessionTaskVersion = current.version;
      if (current.state === "ready") {
        const transitionReceipt = transitionWorkItem(database, {
          projectId: input.projectId,
          principalId: input.principalId,
          requestId: nestedRequestId(requestId, "state"),
          itemIdOrKey: current.id,
          targetState: "in_progress",
          expectedVersion: current.version,
          reason,
          taskStartCommand: true,
        });
        transition = transitionReceipt.value.transition;
        operationAuditEventIds.push(...transitionReceipt.auditEventIds);
        sessionTaskVersion = transition.itemVersion;
      }

      const sessionReceipt = startDevelopmentSession(database, {
        projectId: input.projectId,
        principalId: input.principalId,
        requestId: nestedRequestId(requestId, "session"),
        itemIdOrKey: current.id,
        expectedVersion: sessionTaskVersion,
        ...(sessionReference === undefined ? {} : { sessionReference }),
      });
      operationAuditEventIds.push(...sessionReceipt.auditEventIds);
      // SSDD-943: pin the Definition of Done in force when work starts; later revisions only warn.
      database.prepare(
        `INSERT OR IGNORE INTO task_dod_pins (project_id, item_id, dod_revision, pinned_at)
         SELECT ?, ?, MAX(revision_number), ? FROM dod_revisions WHERE project_id = ? HAVING MAX(revision_number) IS NOT NULL`,
      ).run(input.projectId, current.id, new Date().toISOString(), input.projectId);
      return {
        task: { id: current.id, key: current.key, state: "in_progress" as const, version: sessionTaskVersion },
        transition,
        session: sessionReceipt.value,
        operationAuditEventIds,
      };
    },
  }));

  return transaction.immediate();
}

function nestedRequestId(requestId: string, operation: "state" | "session"): string {
  const digest = createHash("sha256").update(`${requestId}\0${operation}`).digest("hex").slice(0, 48);
  return `task-start:${digest}`;
}
