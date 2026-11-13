import type { EvidenceKind } from "../domain/workflow.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { transitionDevelopmentSession } from "./development-lifecycle.js";
import { ApplicationError } from "./errors.js";
import type { CommandReceipt } from "./idempotent-command.js";
import { startTaskDevelopment } from "./task-development-start.js";
import { assignWorkItem, confirmWorkItemEstimate, proposeWorkItemEstimate } from "./work-item-commands.js";
import { getWorkItem } from "./work-item-queries.js";
import { addWorkItemEvidence, transitionWorkItem } from "./work-item-workflow.js";

export interface AcceptTaskInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly itemIdOrKey: string;
  readonly expectedVersion?: number;
  readonly reason: string;
  readonly estimateHours?: number;
  readonly evidence: {
    readonly kind: EvidenceKind;
    readonly uri: string;
    readonly description: string;
    readonly buildId?: string;
  };
}

export interface AcceptTaskResult {
  readonly key: string;
  readonly state: "done";
  readonly version: number;
  readonly steps: readonly string[];
  readonly evidenceId: string | null;
  readonly sessionId: string | null;
  readonly alreadyDone: boolean;
  readonly auditEventIds: readonly string[];
}

/**
 * Closes a task through the same gated services a manual chain would use (assign → estimate → Ready →
 * task_start → evidence → complete session → in_review → in_validation → done). Everything runs in one
 * transaction, so a failing gate (parent PBI, baseline, dependencies, RBAC) rolls the whole chain back, and
 * each step has a request ID derived from the caller's, so retrying the call replays instead of duplicating.
 */
export function acceptTask(database: SqliteDatabase, input: AcceptTaskInput): CommandReceipt<AcceptTaskResult> {
  const requestId = input.requestId.trim();
  if (requestId.length === 0 || requestId.length > 90) {
    throw new ApplicationError("VALIDATION_FAILED", "Request ID must contain 1-90 characters.");
  }
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 500) {
    throw new ApplicationError("VALIDATION_FAILED", "A reason of 1-500 characters is required.");
  }
  const base = { projectId: input.projectId, principalId: input.principalId };

  const run = database.transaction((): CommandReceipt<AcceptTaskResult> => {
    let item = getWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey.trim());
    if (item.type !== "task") throw new ApplicationError("VALIDATION_FAILED", "Only task work items can be accepted with this command.");
    if (input.expectedVersion !== undefined && input.expectedVersion !== item.version) {
      throw new ApplicationError("VERSION_CONFLICT", `Task is at version ${item.version}, expected ${input.expectedVersion}.`);
    }
    if (item.state === "done") {
      return { value: { key: item.key, state: "done", version: item.version, steps: [], evidenceId: null, sessionId: null, alreadyDone: true, auditEventIds: [] }, auditEventIds: [] };
    }
    if (item.state !== "draft" && item.state !== "ready") {
      throw new ApplicationError("VALIDATION_FAILED", `Task is ${item.state}; accept only starts from draft or ready. Finish it with the individual tools.`);
    }
    if (item.assigneeId !== null && item.assigneeId !== input.principalId) {
      throw new ApplicationError("FORBIDDEN", "Task is assigned to someone else; only its assignee can accept it.");
    }

    const steps: string[] = [];
    const audit: string[] = [];
    const collect = (receipt: CommandReceipt<unknown>): void => { audit.push(...receipt.auditEventIds); };
    const refresh = (): void => { item = getWorkItem(database, input.projectId, input.principalId, item.id); };

    if (item.assigneeId === null) {
      collect(assignWorkItem(database, { ...base, requestId: `${requestId}:assign`, itemIdOrKey: item.id, assigneeId: input.principalId, expectedVersion: item.version }));
      steps.push("assign");
      refresh();
    }
    if (!item.estimates.some((estimate) => estimate.unit === "hours")) {
      if (input.estimateHours === undefined) {
        throw new ApplicationError("VALIDATION_FAILED", "The task has no confirmed hours estimate; provide estimateHours.");
      }
      const proposal = proposeWorkItemEstimate(database, {
        ...base, requestId: `${requestId}:estimate`, itemIdOrKey: item.id, unit: "hours", value: input.estimateHours,
        rationale: reason, expectedVersion: item.version,
      });
      collect(proposal);
      refresh();
      collect(confirmWorkItemEstimate(database, {
        ...base, requestId: `${requestId}:confirm`, itemIdOrKey: item.id, proposalId: proposal.value.id, expectedVersion: item.version,
      }));
      steps.push("estimate");
      refresh();
    }
    const move = (targetState: "ready" | "in_review" | "in_validation" | "done", label: string, buildId?: string): void => {
      collect(transitionWorkItem(database, {
        ...base, requestId: `${requestId}:${label}`, itemIdOrKey: item.id, targetState, expectedVersion: item.version,
        reason: `self_validation: ${reason}`.slice(0, 1_000), ...(buildId === undefined ? {} : { buildId }),
      }));
      steps.push(label);
      refresh();
    };
    if (item.state === "draft") move("ready", "ready");

    const started = startTaskDevelopment(database, {
      ...base, requestId: `${requestId}:start`, itemIdOrKey: item.id, expectedVersion: item.version, reason,
    });
    audit.push(...started.value.operationAuditEventIds, ...started.auditEventIds);
    steps.push("start");
    refresh();

    const evidence = addWorkItemEvidence(database, {
      ...base, requestId: `${requestId}:evidence`, itemIdOrKey: item.id, kind: input.evidence.kind, uri: input.evidence.uri,
      description: input.evidence.description, ...(input.evidence.buildId === undefined ? {} : { buildId: input.evidence.buildId }),
    });
    collect(evidence);
    steps.push("evidence");

    collect(transitionDevelopmentSession(database, {
      ...base, requestId: `${requestId}:session`, sessionId: started.value.session.id, action: "complete",
      expectedVersion: started.value.session.version, reason: reason.slice(0, 500),
    }));
    steps.push("session");

    move("in_review", "in_review");
    move("in_validation", "in_validation");
    move("done", "done", input.evidence.buildId);

    return {
      value: {
        key: item.key, state: "done", version: item.version, steps, evidenceId: evidence.value.id,
        sessionId: started.value.session.id, alreadyDone: false, auditEventIds: audit,
      },
      auditEventIds: audit,
    };
  });
  return run.immediate();
}
