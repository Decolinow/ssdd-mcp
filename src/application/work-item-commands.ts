import { randomUUID } from "node:crypto";
import type {
  WorkItemComment,
  WorkItemEstimateProposal,
  WorkItemEstimateUnit,
  WorkItemType,
} from "../domain/work-items.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { assertProjectAuthorization, type ProjectRole } from "./local-identity.js";

interface WorkItemCommandRow {
  readonly item_id: string;
  readonly project_id: string;
  readonly item_key: string;
  readonly type: WorkItemType;
  readonly parent_id: string | null;
  readonly version: number;
  readonly rank: number;
  readonly assignee_principal_id: string | null;
}

export interface AssignWorkItemInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly itemIdOrKey: string;
  readonly assigneeId: string | null;
  readonly expectedVersion: number;
}

export interface RankWorkItemInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly itemIdOrKey: string;
  readonly beforeIdOrKey?: string;
  readonly afterIdOrKey?: string;
  readonly expectedVersion: number;
}

export interface AddWorkItemCommentInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly itemIdOrKey: string;
  readonly body: string;
}

export interface ListWorkItemCommentsInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly itemIdOrKey: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ProposeWorkItemEstimateInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly itemIdOrKey: string;
  readonly unit: WorkItemEstimateUnit;
  readonly value: number;
  readonly rationale: string;
  readonly expectedVersion: number;
}

export interface ConfirmWorkItemEstimateInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly itemIdOrKey: string;
  readonly proposalId: string;
  readonly expectedVersion: number;
}

export function assignWorkItem(
  database: SqliteDatabase,
  input: AssignWorkItemInput,
): CommandReceipt<{ itemId: string; itemKey: string; assigneeId: string | null; version: number }> {
  const reference = input.itemIdOrKey.trim();
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "work_item.assign",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      itemIdOrKey: reference,
      assigneeId: input.assigneeId,
      expectedVersion: input.expectedVersion,
    },
    requiredRoles: ["developer", "facilitator"],
    auditEvent: (result) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "work_item.assigned",
      entityType: "work_item",
      entityId: result.itemId,
      payload: { assigneeId: result.assigneeId, version: result.version },
    }),
    execute: () => {
      const item = findWorkItem(database, input.projectId, reference);
      assertExpectedVersion(item.version, input.expectedVersion);
      if (input.assigneeId !== null) {
        assertEligibleAssignee(database, input.projectId, item.type, input.assigneeId);
      }
      const now = new Date().toISOString();
      database
        .prepare(
          `UPDATE work_items
           SET assignee_principal_id = ?, version = version + 1, updated_at = ?
           WHERE project_id = ? AND item_id = ? AND version = ?`,
        )
        .run(input.assigneeId, now, input.projectId, item.item_id, input.expectedVersion);
      return {
        itemId: item.item_id,
        itemKey: item.item_key,
        assigneeId: input.assigneeId,
        version: input.expectedVersion + 1,
      };
    },
  });
}

export function rankWorkItem(
  database: SqliteDatabase,
  input: RankWorkItemInput,
): CommandReceipt<{ itemId: string; itemKey: string; rank: number; version: number }> {
  const reference = input.itemIdOrKey.trim();
  const before = input.beforeIdOrKey?.trim() || null;
  const after = input.afterIdOrKey?.trim() || null;
  if ((before === null) === (after === null)) {
    throw new ApplicationError("VALIDATION_FAILED", "Specify exactly one beforeIdOrKey or afterIdOrKey.");
  }

  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "work_item.rank",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      itemIdOrKey: reference,
      beforeIdOrKey: before,
      afterIdOrKey: after,
      expectedVersion: input.expectedVersion,
    },
    requiredRoles: ["developer", "facilitator"],
    auditEvent: (result) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "work_item.ranked",
      entityType: "work_item",
      entityId: result.itemId,
      payload: { rank: result.rank, version: result.version },
    }),
    execute: () => {
      const item = findWorkItem(database, input.projectId, reference);
      assertExpectedVersion(item.version, input.expectedVersion);
      const anchor = findWorkItem(database, input.projectId, before ?? after!);
      if (anchor.item_id === item.item_id) {
        throw new ApplicationError("VALIDATION_FAILED", "A work item cannot be ranked relative to itself.");
      }
      if (anchor.type !== item.type || anchor.parent_id !== item.parent_id) {
        throw new ApplicationError(
          "VALIDATION_FAILED",
          "Work items can only be ranked among siblings of the same type.",
        );
      }

      const siblings = database
        .prepare(
          `SELECT item_id, item_key, rank, version FROM work_items
           WHERE project_id = ? AND type = ? AND parent_id IS ?
           ORDER BY rank, item_key COLLATE NOCASE, item_id`,
        )
        .all(input.projectId, item.type, item.parent_id) as Array<{
        item_id: string;
        item_key: string;
        rank: number;
        version: number;
      }>;
      const reordered = siblings.filter((sibling) => sibling.item_id !== item.item_id);
      const anchorIndex = reordered.findIndex((sibling) => sibling.item_id === anchor.item_id);
      if (anchorIndex < 0) {
        throw new ApplicationError("NOT_FOUND", "The target sibling was not found.");
      }
      reordered.splice(anchorIndex + (after === null ? 0 : 1), 0, {
        item_id: item.item_id,
        item_key: item.item_key,
        rank: item.rank,
        version: item.version,
      });

      const now = new Date().toISOString();
      const updateRank = database.prepare(
        `UPDATE work_items SET rank = ?, version = version + 1, updated_at = ?
         WHERE project_id = ? AND item_id = ? AND version = ? AND rank <> ?`,
      );
      reordered.forEach((sibling, index) => {
        const newRank = (index + 1) * 1024;
        if (newRank !== sibling.rank) {
          const result = updateRank.run(
            newRank,
            now,
            input.projectId,
            sibling.item_id,
            sibling.version,
            newRank,
          );
          if (result.changes !== 1) {
            throw new ApplicationError("VERSION_CONFLICT", "A sibling changed while applying the new order.");
          }
        }
      });
      const movedIndex = reordered.findIndex((sibling) => sibling.item_id === item.item_id);
      const resultingRank = (movedIndex + 1) * 1024;
      return {
        itemId: item.item_id,
        itemKey: item.item_key,
        rank: resultingRank,
        version: item.version + (resultingRank === item.rank ? 0 : 1),
      };
    },
  });
}

export function addWorkItemComment(
  database: SqliteDatabase,
  input: AddWorkItemCommentInput,
): CommandReceipt<WorkItemComment> {
  const reference = input.itemIdOrKey.trim();
  const body = input.body.trim();
  if (body.length === 0 || body.length > 5_000) {
    throw new ApplicationError("VALIDATION_FAILED", "Comments must contain 1-5000 characters.");
  }
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "work_item.comment.add",
    requestId: input.requestId,
    payload: { projectId: input.projectId, itemIdOrKey: reference, body },
    requiredRoles: ["po", "developer", "qa", "tech_lead", "facilitator"],
    auditEvent: (comment) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "work_item.comment_added",
      entityType: "work_item",
      entityId: comment.itemId,
      payload: { commentId: comment.id },
    }),
    execute: () => {
      const item = findWorkItem(database, input.projectId, reference);
      const comment: WorkItemComment = {
        id: randomUUID(),
        projectId: input.projectId,
        itemId: item.item_id,
        authorPrincipalId: input.principalId,
        body,
        createdAt: new Date().toISOString(),
      };
      database
        .prepare(
          `INSERT INTO work_item_comments
            (comment_id, project_id, item_id, author_principal_id, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(comment.id, comment.projectId, comment.itemId, comment.authorPrincipalId, comment.body, comment.createdAt);
      return comment;
    },
  });
}

export interface WorkItemCommentPage {
  readonly comments: readonly WorkItemComment[];
  readonly nextCursor: string | null;
}

interface CommentCursor {
  readonly projectId: string;
  readonly principalId: string;
  readonly itemId: string;
  readonly watermark: number;
  readonly afterSequence: number;
}

export function listWorkItemComments(
  database: SqliteDatabase,
  input: ListWorkItemCommentsInput,
): WorkItemCommentPage {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const item = findWorkItem(database, input.projectId, input.itemIdOrKey.trim());
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "Comment page size must be an integer between 1 and 100.");
  }
  const maxSequence = database
    .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM work_item_comments WHERE project_id = ? AND item_id = ?")
    .get(input.projectId, item.item_id) as { sequence: number };
  const cursor = input.cursor === undefined ? undefined : decodeCommentCursor(input.cursor);
  if (
    cursor !== undefined &&
    (cursor.projectId !== input.projectId ||
      cursor.principalId !== input.principalId ||
      cursor.itemId !== item.item_id)
  ) {
    throw new ApplicationError("VALIDATION_FAILED", "The comment cursor belongs to another query.");
  }
  if (cursor !== undefined && cursor.watermark !== maxSequence.sequence) {
    throw new ApplicationError("STALE_CURSOR", "Comments changed after this page was read; restart the list.");
  }
  const afterSequence = cursor?.afterSequence ?? 0;
  const rows = database
    .prepare(
      `SELECT sequence, comment_id, project_id, item_id, author_principal_id, body, created_at
       FROM work_item_comments
       WHERE project_id = ? AND item_id = ? AND sequence > ? AND sequence <= ?
       ORDER BY sequence LIMIT ?`,
    )
    .all(input.projectId, item.item_id, afterSequence, maxSequence.sequence, limit + 1) as Array<{
    sequence: number;
    comment_id: string;
    project_id: string;
    item_id: string;
    author_principal_id: string;
    body: string;
    created_at: string;
  }>;
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const comments = pageRows.map((row): WorkItemComment => ({
    id: row.comment_id,
    projectId: row.project_id,
    itemId: row.item_id,
    authorPrincipalId: row.author_principal_id,
    body: row.body,
    createdAt: row.created_at,
  }));
  const last = pageRows.at(-1);
  return {
    comments,
    nextCursor:
      hasMore && last !== undefined
        ? Buffer.from(
            JSON.stringify({
              projectId: input.projectId,
              principalId: input.principalId,
              itemId: item.item_id,
              watermark: maxSequence.sequence,
              afterSequence: last.sequence,
            } satisfies CommentCursor),
            "utf8",
          ).toString("base64url")
        : null,
  };
}

export function proposeWorkItemEstimate(
  database: SqliteDatabase,
  input: ProposeWorkItemEstimateInput,
): CommandReceipt<WorkItemEstimateProposal> {
  const reference = input.itemIdOrKey.trim();
  const rationale = input.rationale.trim();
  if (!Number.isSafeInteger(input.value) || input.value < 1 || input.value > 10_000) {
    throw new ApplicationError("VALIDATION_FAILED", "Estimate must be an integer between 1 and 10000.");
  }
  if (rationale.length === 0 || rationale.length > 1_000) {
    throw new ApplicationError("VALIDATION_FAILED", "Estimate rationale must contain 1-1000 characters.");
  }

  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "work_item.estimate.propose",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      itemIdOrKey: reference,
      unit: input.unit,
      value: input.value,
      rationale,
      expectedVersion: input.expectedVersion,
    },
    requiredRoles: ["developer", "qa"],
    auditEvent: (proposal) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "work_item.estimate_proposed",
      entityType: "work_item",
      entityId: proposal.itemId,
      payload: { proposalId: proposal.id, unit: proposal.unit, value: proposal.value },
    }),
    execute: () => {
      const item = findWorkItem(database, input.projectId, reference);
      assertExpectedVersion(item.version, input.expectedVersion);
      assertEstimateUnit(item.type, input.unit);
      const proposal: WorkItemEstimateProposal = {
        id: randomUUID(),
        projectId: input.projectId,
        itemId: item.item_id,
        unit: input.unit,
        value: input.value,
        rationale,
        status: "pending",
        proposedByPrincipalId: input.principalId,
        proposedAt: new Date().toISOString(),
        resolvedByPrincipalId: null,
        resolvedAt: null,
      };
      database
        .prepare(
          `INSERT INTO work_item_estimate_proposals
            (proposal_id, project_id, item_id, unit, value, rationale, status,
             proposed_by_principal_id, proposed_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          proposal.id,
          proposal.projectId,
          proposal.itemId,
          proposal.unit,
          proposal.value,
          proposal.rationale,
          proposal.proposedByPrincipalId,
          proposal.proposedAt,
        );
      incrementWorkItemVersion(database, input.projectId, item.item_id, input.expectedVersion);
      return proposal;
    },
  });
}

export function confirmWorkItemEstimate(
  database: SqliteDatabase,
  input: ConfirmWorkItemEstimateInput,
): CommandReceipt<{ proposal: WorkItemEstimateProposal; version: number }> {
  const reference = input.itemIdOrKey.trim();
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "work_item.estimate.confirm",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      itemIdOrKey: reference,
      proposalId: input.proposalId,
      expectedVersion: input.expectedVersion,
    },
    requiredRoles: ["developer"],
    auditEvent: (result) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "work_item.estimate_confirmed",
      entityType: "work_item",
      entityId: result.proposal.itemId,
      payload: {
        proposalId: result.proposal.id,
        unit: result.proposal.unit,
        value: result.proposal.value,
        version: result.version,
      },
    }),
    execute: () => {
      const item = findWorkItem(database, input.projectId, reference);
      assertExpectedVersion(item.version, input.expectedVersion);
      const proposal = database
        .prepare(
          `SELECT proposal_id, project_id, item_id, unit, value, rationale, status,
                  proposed_by_principal_id, proposed_at, resolved_by_principal_id, resolved_at
           FROM work_item_estimate_proposals
           WHERE project_id = ? AND item_id = ? AND proposal_id = ?`,
        )
        .get(input.projectId, item.item_id, input.proposalId) as EstimateProposalRow | undefined;
      if (proposal === undefined) {
        throw new ApplicationError("NOT_FOUND", "Estimate proposal was not found for this work item.");
      }
      if (proposal.status !== "pending") {
        throw new ApplicationError("VALIDATION_FAILED", "Only a pending estimate proposal can be confirmed.");
      }
      assertEstimateUnit(item.type, proposal.unit);
      const principal = database
        .prepare("SELECT principal_type FROM principals WHERE principal_id = ?")
        .get(input.principalId) as { principal_type: string } | undefined;
      if (principal?.principal_type !== "human") {
        throw new ApplicationError("FORBIDDEN", "Only a human developer may confirm an estimate.");
      }

      const now = new Date().toISOString();
      database
        .prepare(
          `UPDATE work_item_estimate_proposals
           SET status = 'superseded', resolved_by_principal_id = ?, resolved_at = ?
           WHERE project_id = ? AND item_id = ? AND unit = ? AND status = 'pending' AND proposal_id <> ?`,
        )
        .run(input.principalId, now, input.projectId, item.item_id, proposal.unit, proposal.proposal_id);
      database
        .prepare(
          `UPDATE work_item_estimate_proposals SET status = 'superseded'
           WHERE project_id = ? AND item_id = ? AND unit = ? AND status = 'confirmed'`,
        )
        .run(input.projectId, item.item_id, proposal.unit);
      database
        .prepare(
          `UPDATE work_item_estimate_proposals
           SET status = 'confirmed', resolved_by_principal_id = ?, resolved_at = ?
           WHERE project_id = ? AND item_id = ? AND proposal_id = ? AND status = 'pending'`,
        )
        .run(input.principalId, now, input.projectId, item.item_id, proposal.proposal_id);
      database
        .prepare(
          `INSERT INTO work_item_estimates
            (project_id, item_id, unit, value, proposal_id, confirmed_by_principal_id, confirmed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, item_id, unit) DO UPDATE SET
             value = excluded.value,
             proposal_id = excluded.proposal_id,
             confirmed_by_principal_id = excluded.confirmed_by_principal_id,
             confirmed_at = excluded.confirmed_at`,
        )
        .run(input.projectId, item.item_id, proposal.unit, proposal.value, proposal.proposal_id, input.principalId, now);
      incrementWorkItemVersion(database, input.projectId, item.item_id, input.expectedVersion);

      return {
        proposal: toEstimateProposal({
          ...proposal,
          status: "confirmed",
          resolved_by_principal_id: input.principalId,
          resolved_at: now,
        }),
        version: input.expectedVersion + 1,
      };
    },
  });
}

interface EstimateProposalRow {
  readonly proposal_id: string;
  readonly project_id: string;
  readonly item_id: string;
  readonly unit: WorkItemEstimateUnit;
  readonly value: number;
  readonly rationale: string;
  readonly status: WorkItemEstimateProposal["status"];
  readonly proposed_by_principal_id: string;
  readonly proposed_at: string;
  readonly resolved_by_principal_id: string | null;
  readonly resolved_at: string | null;
}

function toEstimateProposal(row: EstimateProposalRow): WorkItemEstimateProposal {
  return {
    id: row.proposal_id,
    projectId: row.project_id,
    itemId: row.item_id,
    unit: row.unit,
    value: row.value,
    rationale: row.rationale,
    status: row.status,
    proposedByPrincipalId: row.proposed_by_principal_id,
    proposedAt: row.proposed_at,
    resolvedByPrincipalId: row.resolved_by_principal_id,
    resolvedAt: row.resolved_at,
  };
}

function assertExpectedVersion(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new ApplicationError("VALIDATION_FAILED", "Expected version must be a positive integer.");
  }
  if (actual !== expected) {
    throw new ApplicationError(
      "VERSION_CONFLICT",
      "The work item changed since it was read.",
      { details: { expectedVersion: expected, actualVersion: actual } },
    );
  }
}

function incrementWorkItemVersion(
  database: SqliteDatabase,
  projectId: string,
  itemId: string,
  expectedVersion: number,
): void {
  const now = new Date().toISOString();
  const result = database
    .prepare(
      `UPDATE work_items SET version = version + 1, updated_at = ?
       WHERE project_id = ? AND item_id = ? AND version = ?`,
    )
    .run(now, projectId, itemId, expectedVersion);
  if (result.changes !== 1) {
    const current = database
      .prepare("SELECT version FROM work_items WHERE project_id = ? AND item_id = ?")
      .get(projectId, itemId) as { version: number } | undefined;
    if (current === undefined) {
      throw new ApplicationError("NOT_FOUND", "Work item was not found.");
    }
    assertExpectedVersion(current.version, expectedVersion);
  }
}

function findWorkItem(database: SqliteDatabase, projectId: string, reference: string): WorkItemCommandRow {
  if (reference.length === 0) {
    throw new ApplicationError("VALIDATION_FAILED", "A work item ID or key is required.");
  }
  const item = database
    .prepare(
      `SELECT item_id, project_id, item_key, type, parent_id, version, rank, assignee_principal_id
       FROM work_items WHERE project_id = ? AND (item_id = ? OR item_key = ? COLLATE NOCASE)`,
    )
    .get(projectId, reference, reference) as WorkItemCommandRow | undefined;
  if (item === undefined) {
    throw new ApplicationError("NOT_FOUND", "Work item was not found.");
  }
  return item;
}

function assertEligibleAssignee(
  database: SqliteDatabase,
  projectId: string,
  type: WorkItemType,
  principalId: string,
): void {
  const eligibleRoles: Readonly<Record<WorkItemType, readonly ProjectRole[]>> = {
    epic: ["po"],
    feature: ["po", "developer", "tech_lead"],
    story: ["developer", "qa"],
    bug: ["developer", "qa"],
    task: ["developer", "qa"],
  };
  const placeholders = eligibleRoles[type].map(() => "?").join(", ");
  const membership = database
    .prepare(
      `SELECT 1 FROM project_memberships WHERE project_id = ? AND principal_id = ?
       AND role IN (${placeholders}) LIMIT 1`,
    )
    .get(projectId, principalId, ...eligibleRoles[type]);
  if (membership === undefined) {
    throw new ApplicationError(
      "VALIDATION_FAILED",
      "The assignee must have an eligible role in this project for the work item type.",
      { details: { type, eligibleRoles: eligibleRoles[type] } },
    );
  }
}

function assertEstimateUnit(type: WorkItemType, unit: WorkItemEstimateUnit): void {
  if ((unit === "points" && (type === "story" || type === "bug")) || (unit === "hours" && type === "task")) {
    return;
  }
  throw new ApplicationError(
    "VALIDATION_FAILED",
    "Points estimates apply to stories and bugs; hour estimates apply to tasks.",
    { details: { type, unit } },
  );
}

function decodeCommentCursor(value: string): CommentCursor {
  if (value.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "The comment cursor is invalid.");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("Invalid cursor shape");
    }
    const cursor = parsed as Record<string, unknown>;
    if (
      typeof cursor.projectId !== "string" ||
      typeof cursor.principalId !== "string" ||
      typeof cursor.itemId !== "string" ||
      typeof cursor.watermark !== "number" ||
      !Number.isSafeInteger(cursor.watermark) ||
      typeof cursor.afterSequence !== "number" ||
      !Number.isSafeInteger(cursor.afterSequence)
    ) {
      throw new Error("Invalid cursor fields");
    }
    return cursor as unknown as CommentCursor;
  } catch {
    throw new ApplicationError("VALIDATION_FAILED", "The comment cursor is invalid.");
  }
}
