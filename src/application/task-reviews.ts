import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt, type JsonValue } from "./idempotent-command.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { getWorkItem } from "./work-item-queries.js";

/**
 * Independent review (SSDD-942, ADR 0028). A reviewer who never worked on the task records `approved` or
 * `changes_requested` with findings tied to criteria. Reviews by non-human principals are stored as advisory and do not
 * satisfy the strict gate. Reviews are immutable; the latest one for the task is the current verdict.
 */
export type ReviewDecision = "approved" | "changes_requested";

export interface ReviewFinding {
  readonly criterionKey?: string;
  readonly message: string;
}

export interface TaskReview {
  readonly id: string;
  readonly itemKey: string;
  readonly reportNumber: number | null;
  readonly decision: ReviewDecision;
  readonly advisory: boolean;
  readonly findings: readonly ReviewFinding[];
  readonly summary: string | null;
  readonly reviewerPrincipalId: string;
  readonly reviewedAt: string;
}

interface ReviewRow {
  readonly review_id: string; readonly item_key: string; readonly report_number: number | null; readonly decision: ReviewDecision;
  readonly advisory: number; readonly findings_json: string; readonly summary: string | null;
  readonly reviewer_principal_id: string; readonly reviewed_at: string;
}

const selectReviews = `
  SELECT r.review_id, wi.item_key, r.report_number, r.decision, r.advisory, r.findings_json, r.summary, r.reviewer_principal_id, r.reviewed_at
  FROM task_reviews r
  INNER JOIN work_items wi ON wi.project_id = r.project_id AND wi.item_id = r.item_id
  WHERE r.project_id = ? AND r.item_id = ?`;

function toReview(row: ReviewRow): TaskReview {
  return {
    id: row.review_id, itemKey: row.item_key, reportNumber: row.report_number, decision: row.decision, advisory: row.advisory === 1,
    findings: JSON.parse(row.findings_json) as ReviewFinding[], summary: row.summary,
    reviewerPrincipalId: row.reviewer_principal_id, reviewedAt: row.reviewed_at,
  };
}

function latestReportNumber(database: SqliteDatabase, projectId: string, itemId: string): number | null {
  const row = database.prepare("SELECT MAX(report_number) AS latest FROM task_delivery_reports WHERE project_id = ? AND item_id = ?")
    .get(projectId, itemId) as { latest: number | null };
  return row.latest;
}

export function recordReview(database: SqliteDatabase, input: {
  readonly projectId: string; readonly principalId: string; readonly requestId: string; readonly itemIdOrKey: string;
  readonly decision: ReviewDecision; readonly findings?: readonly ReviewFinding[]; readonly summary?: string;
}): CommandReceipt<{ review: TaskReview }> {
  if (input.decision !== "approved" && input.decision !== "changes_requested") {
    throw new ApplicationError("VALIDATION_FAILED", "Decision must be approved or changes_requested.");
  }
  const findings = (input.findings ?? []).map((finding) => {
    const message = finding.message.trim();
    if (message.length === 0 || message.length > 1_000) throw new ApplicationError("VALIDATION_FAILED", "A finding message must contain 1-1000 characters.");
    const criterionKey = finding.criterionKey?.trim();
    return { ...(criterionKey === undefined || criterionKey.length === 0 ? {} : { criterionKey }), message };
  });
  if (findings.length > 50) throw new ApplicationError("VALIDATION_FAILED", "At most 50 findings per review.");
  if (input.decision === "changes_requested" && findings.length === 0) {
    throw new ApplicationError("VALIDATION_FAILED", "changes_requested needs at least one finding.");
  }
  const summary = input.summary?.trim() || null;
  if (summary !== null && summary.length > 2_000) throw new ApplicationError("VALIDATION_FAILED", "Summary cannot exceed 2000 characters.");
  return executeIdempotentCommand(database, {
    projectId: input.projectId, principalId: input.principalId, action: "task_review.record", requestId: input.requestId,
    payload: { projectId: input.projectId, itemIdOrKey: input.itemIdOrKey, decision: input.decision, findings, summary } as unknown as JsonValue,
    requiredRoles: ["developer", "qa", "tech_lead"],
    auditEvent: (result) => ({
      projectId: input.projectId, principalId: input.principalId, eventType: "task.review_recorded", entityType: "task_review",
      entityId: result.review.id, payload: { itemKey: result.review.itemKey, decision: result.review.decision, advisory: result.review.advisory, reportNumber: result.review.reportNumber },
    }),
    execute: () => {
      const task = getWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey.trim());
      if (task.type !== "task") throw new ApplicationError("VALIDATION_FAILED", "Reviews belong to tasks.");
      if (task.state !== "in_review") throw new ApplicationError("INVALID_TRANSITION", "A review can only be recorded while the task is in review.");
      const worked = database.prepare(
        "SELECT 1 FROM development_sessions WHERE project_id = ? AND item_id = ? AND developer_principal_id = ? LIMIT 1",
      ).get(input.projectId, task.id, input.principalId) !== undefined;
      if (worked) {
        throw new ApplicationError("FORBIDDEN", "The reviewer cannot have a development session on the task; ask another principal to review.");
      }
      const reviewer = database.prepare("SELECT principal_type FROM principals WHERE principal_id = ?").get(input.principalId) as { principal_type: string } | undefined;
      const advisory = reviewer?.principal_type !== "human";
      const id = randomUUID();
      database.prepare(
        `INSERT INTO task_reviews (review_id, project_id, item_id, report_number, decision, advisory, findings_json, summary, reviewer_principal_id, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.projectId, task.id, latestReportNumber(database, input.projectId, task.id), input.decision, advisory ? 1 : 0,
        JSON.stringify(findings), summary, input.principalId, new Date().toISOString());
      return { review: toReview(database.prepare(`${selectReviews} AND r.review_id = ?`).get(input.projectId, task.id, id) as ReviewRow) };
    },
  });
}

export function listReviews(database: SqliteDatabase, input: {
  readonly projectId: string; readonly principalId: string; readonly itemIdOrKey: string;
}): { reviews: TaskReview[] } {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const task = getWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey.trim());
  const rows = database.prepare(`${selectReviews} ORDER BY r.reviewed_at DESC, r.rowid DESC`).all(input.projectId, task.id) as unknown as ReviewRow[];
  return { reviews: rows.map(toReview) };
}

/**
 * in_review → in_validation gate. A latest `changes_requested` always blocks. The strict requirement of a current
 * human `approved` review for the latest report is opt-in via SSDD_REQUIRE_INDEPENDENT_REVIEW=1 (ADR 0028).
 */
export function assertIndependentReviewForValidation(database: SqliteDatabase, projectId: string, taskId: string): void {
  const rows = database.prepare(`${selectReviews} ORDER BY r.reviewed_at DESC, r.rowid DESC`).all(projectId, taskId) as unknown as ReviewRow[];
  const latest = rows[0] === undefined ? undefined : toReview(rows[0]);
  if (latest?.decision === "changes_requested") {
    throw new ApplicationError("GATE_BLOCKED", "The latest review requested changes; address the findings and obtain a new review.", { details: { reviewId: latest.id, findings: latest.findings } });
  }
  if (process.env["SSDD_REQUIRE_INDEPENDENT_REVIEW"] !== "1") return;
  const currentReport = latestReportNumber(database, projectId, taskId);
  const valid = rows.map(toReview).find((review) => review.decision === "approved" && !review.advisory && review.reportNumber === currentReport);
  if (valid === undefined) {
    throw new ApplicationError("GATE_BLOCKED", "An independent human review approving the current delivery report is required before validation (review_record).", { details: { reportNumber: currentReport } });
  }
}
