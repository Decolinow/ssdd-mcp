import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt, type JsonValue } from "./idempotent-command.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { getWorkItem } from "./work-item-queries.js";

/**
 * Delivery report per criterion (SSDD-940, ADR 0027): the executor states, for every PBI criterion and every task
 * checklist item, whether it was met, with evidence, assumptions and scope deviations. Reports are immutable and
 * numbered; a new submission supersedes the previous one without rewriting it.
 */
export const deliveryStatuses = ["met", "partial", "not_met", "not_applicable"] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

export interface DeliveryReportEntry {
  readonly criterionKey: string;
  readonly scope: "pbi" | "task" | "dod";
  readonly status: DeliveryStatus;
  readonly evidence?: string;
  readonly assumptions?: string;
  readonly deviations?: string;
}

export interface DeliveryReport {
  readonly id: string;
  readonly itemKey: string;
  readonly reportNumber: number;
  readonly entries: readonly DeliveryReportEntry[];
  readonly summary: string | null;
  readonly submittedByPrincipalId: string;
  readonly submittedAt: string;
}

interface ReportRow {
  readonly report_id: string; readonly item_key: string; readonly report_number: number; readonly entries_json: string;
  readonly summary: string | null; readonly submitted_by_principal_id: string; readonly submitted_at: string;
}

const selectReports = `
  SELECT r.report_id, wi.item_key, r.report_number, r.entries_json, r.summary, r.submitted_by_principal_id, r.submitted_at
  FROM task_delivery_reports r
  INNER JOIN work_items wi ON wi.project_id = r.project_id AND wi.item_id = r.item_id
  WHERE r.project_id = ? AND r.item_id = ?`;

function toReport(row: ReportRow): DeliveryReport {
  return {
    id: row.report_id, itemKey: row.item_key, reportNumber: row.report_number, entries: JSON.parse(row.entries_json) as DeliveryReportEntry[],
    summary: row.summary, submittedByPrincipalId: row.submitted_by_principal_id, submittedAt: row.submitted_at,
  };
}

/** Criteria the report must cover: the parent PBI's criteria and the task's own checklist. */
export function expectedDeliveryCriteria(database: SqliteDatabase, projectId: string, principalId: string, taskIdOrKey: string): {
  readonly taskId: string; readonly expected: ReadonlyArray<{ readonly key: string; readonly scope: "pbi" | "task" | "dod"; readonly required: boolean }>;
} {
  const task = getWorkItem(database, projectId, principalId, taskIdOrKey);
  if (task.type !== "task") throw new ApplicationError("VALIDATION_FAILED", "Delivery reports belong to tasks.");
  const parent = task.parentId === null ? undefined : getWorkItem(database, projectId, principalId, task.parentId);
  const expected = [
    ...(parent?.criteria ?? []).map((criterion) => ({ key: criterion.key, scope: "pbi" as const, required: criterion.required })),
    ...task.criteria.map((criterion) => ({ key: criterion.key, scope: "task" as const, required: criterion.required })),
    ...(pinnedDefinitionOfDone(database, projectId, task.id)?.criteria ?? []).map((criterion) => ({ key: criterion.id, scope: "dod" as const, required: true })),
  ];
  return { taskId: task.id, expected };
}

export function submitDeliveryReport(database: SqliteDatabase, input: {
  readonly projectId: string; readonly principalId: string; readonly requestId: string; readonly itemIdOrKey: string;
  readonly entries: readonly DeliveryReportEntry[]; readonly summary?: string;
}): CommandReceipt<{ report: DeliveryReport }> {
  const summary = input.summary?.trim() || null;
  if (summary !== null && summary.length > 2_000) throw new ApplicationError("VALIDATION_FAILED", "Summary cannot exceed 2000 characters.");
  const entries = input.entries.map(normalizeEntry);
  return executeIdempotentCommand(database, {
    projectId: input.projectId, principalId: input.principalId, action: "task_delivery_report.submit", requestId: input.requestId,
    payload: { projectId: input.projectId, itemIdOrKey: input.itemIdOrKey, entries, summary } as unknown as JsonValue,
    requiredRoles: ["developer", "qa", "tech_lead"],
    auditEvent: (result) => ({
      projectId: input.projectId, principalId: input.principalId, eventType: "task.delivery_report_submitted", entityType: "task_delivery_report",
      entityId: result.report.id, payload: { itemKey: result.report.itemKey, reportNumber: result.report.reportNumber, entryCount: entries.length },
    }),
    execute: () => {
      const { taskId, expected } = expectedDeliveryCriteria(database, input.projectId, input.principalId, input.itemIdOrKey.trim());
      const task = getWorkItem(database, input.projectId, input.principalId, taskId);
      if (task.state !== "in_progress") {
        throw new ApplicationError("INVALID_TRANSITION", "A delivery report can only be submitted while the task is in progress.");
      }
      const seen = new Set<string>();
      for (const entry of entries) {
        const id = `${entry.scope}:${entry.criterionKey}`;
        if (seen.has(id)) throw new ApplicationError("VALIDATION_FAILED", `Criterion ${id} appears more than once.`);
        seen.add(id);
      }
      const expectedIds = expected.map((entry) => `${entry.scope}:${entry.key}`);
      const missing = expectedIds.filter((id) => !seen.has(id));
      const unknown = [...seen].filter((id) => !expectedIds.includes(id));
      if (missing.length > 0 || unknown.length > 0) {
        throw new ApplicationError("VALIDATION_FAILED", "The report must cover exactly the PBI criteria and the task checklist.", { details: { missing, unknown } });
      }
      const maximum = (database.prepare("SELECT COALESCE(MAX(report_number), 0) AS maximum FROM task_delivery_reports WHERE project_id = ? AND item_id = ?")
        .get(input.projectId, taskId) as { maximum: number }).maximum;
      const id = randomUUID();
      database.prepare(
        `INSERT INTO task_delivery_reports (report_id, project_id, item_id, report_number, entries_json, summary, submitted_by_principal_id, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.projectId, taskId, maximum + 1, JSON.stringify(entries), summary, input.principalId, new Date().toISOString());
      return { report: toReport(database.prepare(`${selectReports} AND r.report_id = ?`).get(input.projectId, taskId, id) as ReportRow) };
    },
  });
}

function normalizeEntry(entry: DeliveryReportEntry): DeliveryReportEntry {
  if (!deliveryStatuses.includes(entry.status)) throw new ApplicationError("VALIDATION_FAILED", "Status must be met, partial, not_met or not_applicable.");
  if (entry.scope !== "pbi" && entry.scope !== "task" && entry.scope !== "dod") throw new ApplicationError("VALIDATION_FAILED", "Scope must be pbi, task or dod.");
  const text = (value: string | undefined, name: string): string | undefined => {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed.length === 0) return undefined;
    if (trimmed.length > 2_000) throw new ApplicationError("VALIDATION_FAILED", `${name} cannot exceed 2000 characters.`);
    return trimmed;
  };
  const evidence = text(entry.evidence, "evidence");
  const assumptions = text(entry.assumptions, "assumptions");
  const deviations = text(entry.deviations, "deviations");
  if ((entry.status === "met" || entry.status === "partial") && evidence === undefined) {
    throw new ApplicationError("VALIDATION_FAILED", `Criterion ${entry.criterionKey} marked ${entry.status} needs evidence.`);
  }
  if (entry.status === "not_applicable" && assumptions === undefined) {
    throw new ApplicationError("VALIDATION_FAILED", `Criterion ${entry.criterionKey} marked not_applicable needs the assumption that justifies it.`);
  }
  return {
    criterionKey: entry.criterionKey.trim(), scope: entry.scope, status: entry.status,
    ...(evidence === undefined ? {} : { evidence }), ...(assumptions === undefined ? {} : { assumptions }),
    ...(deviations === undefined ? {} : { deviations }),
  };
}

export function listDeliveryReports(database: SqliteDatabase, input: {
  readonly projectId: string; readonly principalId: string; readonly itemIdOrKey: string; readonly latestOnly?: boolean;
}): { reports: DeliveryReport[]; expected: Array<{ key: string; scope: "pbi" | "task" | "dod"; required: boolean }> } {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const { taskId, expected } = expectedDeliveryCriteria(database, input.projectId, input.principalId, input.itemIdOrKey.trim());
  const rows = database.prepare(`${selectReports} ORDER BY r.report_number DESC`).all(input.projectId, taskId) as unknown as ReportRow[];
  return { reports: (input.latestOnly === true ? rows.slice(0, 1) : rows).map(toReport), expected: expected.map((entry) => ({ ...entry })) };
}

/**
 * in_progress → in_review gate. A submitted report must cover the current criteria and contain no `not_met`.
 * Without a report the move is allowed unless the host opts in with SSDD_REQUIRE_DELIVERY_REPORT=1 (rollout policy, ADR 0027).
 */
export function assertDeliveryReportForReview(database: SqliteDatabase, projectId: string, principalId: string, taskId: string): void {
  const { expected } = expectedDeliveryCriteria(database, projectId, principalId, taskId);
  const latest = database.prepare(`${selectReports} ORDER BY r.report_number DESC LIMIT 1`).get(projectId, taskId) as ReportRow | undefined;
  if (latest === undefined) {
    if (process.env["SSDD_REQUIRE_DELIVERY_REPORT"] === "1" && expected.length > 0) {
      throw new ApplicationError("GATE_BLOCKED", "Submit a delivery report (task_delivery_report_submit) before moving the task to review.", { details: { expected: expected.map((entry) => `${entry.scope}:${entry.key}`) } });
    }
    return;
  }
  const report = toReport(latest);
  const covered = new Set(report.entries.map((entry) => `${entry.scope}:${entry.criterionKey}`));
  const stale = expected.map((entry) => `${entry.scope}:${entry.key}`).filter((id) => !covered.has(id));
  if (stale.length > 0) {
    throw new ApplicationError("GATE_BLOCKED", "The latest delivery report no longer covers the current criteria; submit a new one.", { details: { missing: stale, reportNumber: report.reportNumber } });
  }
  const notMet = report.entries.filter((entry) => entry.status === "not_met").map((entry) => `${entry.scope}:${entry.criterionKey}`);
  if (notMet.length > 0) {
    throw new ApplicationError("GATE_BLOCKED", "The delivery report has criteria marked not_met; fix them or submit a new report.", { details: { notMet, reportNumber: report.reportNumber } });
  }
}

/** The Definition of Done revision pinned when the task started (SSDD-943), or null when none existed. */
export function pinnedDefinitionOfDone(database: SqliteDatabase, projectId: string, itemId: string): {
  readonly revision: number; readonly criteria: ReadonlyArray<{ readonly id: string; readonly description: string }>;
} | null {
  const row = database.prepare(
    `SELECT p.dod_revision, d.criteria_json FROM task_dod_pins p
     INNER JOIN dod_revisions d ON d.project_id = p.project_id AND d.revision_number = p.dod_revision
     WHERE p.project_id = ? AND p.item_id = ?`,
  ).get(projectId, itemId) as { dod_revision: number; criteria_json: string } | undefined;
  return row === undefined ? null : { revision: row.dod_revision, criteria: JSON.parse(row.criteria_json) as Array<{ id: string; description: string }> };
}

/** Pinned DoD criteria that the latest delivery report did not attest as met or not_applicable. */
export function unattestedDefinitionOfDone(database: SqliteDatabase, projectId: string, itemId: string): string[] {
  const pin = pinnedDefinitionOfDone(database, projectId, itemId);
  if (pin === null || pin.criteria.length === 0) return [];
  const latest = database.prepare(`${selectReports} ORDER BY r.report_number DESC LIMIT 1`).get(projectId, itemId) as ReportRow | undefined;
  if (latest === undefined) return process.env["SSDD_REQUIRE_DELIVERY_REPORT"] === "1" ? pin.criteria.map((criterion) => criterion.id) : [];
  const attested = new Set(toReport(latest).entries
    .filter((entry) => entry.scope === "dod" && (entry.status === "met" || entry.status === "not_applicable"))
    .map((entry) => entry.criterionKey));
  return pin.criteria.map((criterion) => criterion.id).filter((id) => !attested.has(id));
}
