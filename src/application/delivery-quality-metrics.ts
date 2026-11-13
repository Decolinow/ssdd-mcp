import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { assertProjectAuthorization } from "./local-identity.js";

/**
 * Delivery-quality metrics (SSDD-951): first-pass acceptance, returns by reason, criteria that stayed `partial` or
 * `not_met` in the latest delivery report, and bugs linked to Done stories. Everything is aggregate and segmented by
 * principal type (human/agent/service) of the executor (who moved the task to review); there is no per-person ranking.
 */
export const minimumQualitySample = 5;
const returnStates = ["in_review", "in_validation"] as const;

export interface DeliveryQualityMetrics {
  readonly projectId: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly minimumSample: number;
  readonly acceptance: {
    readonly doneTasks: number; readonly firstPassTasks: number; readonly firstPassRate: number | null;
    readonly bySegment: ReadonlyArray<{ readonly principalType: string; readonly doneTasks: number; readonly firstPassTasks: number; readonly firstPassRate: number | null }>;
  };
  readonly returns: {
    readonly total: number;
    readonly byStage: ReadonlyArray<{ readonly fromState: string; readonly count: number }>;
    readonly topReasons: ReadonlyArray<{ readonly reason: string; readonly count: number }>;
    readonly bySegment: ReadonlyArray<{ readonly principalType: string; readonly count: number }>;
  };
  readonly criteria: {
    readonly reportedTasks: number;
    readonly byStatus: { readonly met: number; readonly partial: number; readonly not_met: number; readonly not_applicable: number };
    readonly unresolvedShare: number | null;
  };
  readonly bugs: { readonly doneStories: number; readonly bugsOnDoneStories: number; readonly bugsPerDoneStory: number | null };
  readonly limitations: readonly string[];
}

const rate = (part: number, whole: number): number | null => (whole < minimumQualitySample ? null : Math.round((part / whole) * 1000) / 10);

export function getDeliveryQualityMetrics(database: SqliteDatabase, input: {
  readonly projectId: string; readonly principalId: string; readonly from?: string; readonly to?: string; readonly now?: Date;
}): DeliveryQualityMetrics {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const to = input.to ?? (input.now ?? new Date()).toISOString();
  const from = input.from ?? new Date(Date.parse(to) - 30 * 86_400_000).toISOString();
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || Date.parse(from) >= Date.parse(to)) {
    throw new ApplicationError("VALIDATION_FAILED", "from and to must be ISO timestamps with from before to.");
  }
  const doneTasks = database.prepare(
    `SELECT wi.item_id AS itemId,
            (SELECT p.principal_type FROM work_item_state_transitions h INNER JOIN principals p ON p.principal_id = h.transitioned_by_principal_id
              WHERE h.project_id = wi.project_id AND h.item_id = wi.item_id AND h.to_state = 'in_review'
              ORDER BY h.item_version DESC LIMIT 1) AS principalType,
            (SELECT COUNT(*) FROM work_item_state_transitions r WHERE r.project_id = wi.project_id AND r.item_id = wi.item_id
              AND r.from_state IN ('in_review', 'in_validation') AND r.to_state = 'in_progress') AS returns
     FROM work_items wi
     WHERE wi.project_id = ? AND wi.type = 'task' AND wi.state = 'done'
       AND (SELECT MAX(d.transitioned_at) FROM work_item_state_transitions d WHERE d.project_id = wi.project_id AND d.item_id = wi.item_id AND d.to_state = 'done') BETWEEN ? AND ?`,
  ).all(input.projectId, from, to) as Array<{ itemId: string; principalType: string | null; returns: number }>;
  const segments = new Map<string, { done: number; firstPass: number }>();
  let firstPass = 0;
  for (const task of doneTasks) {
    const key = task.principalType ?? "unknown";
    const segment = segments.get(key) ?? { done: 0, firstPass: 0 };
    segment.done += 1;
    if (task.returns === 0) { segment.firstPass += 1; firstPass += 1; }
    segments.set(key, segment);
  }
  const returnRows = database.prepare(
    `SELECT t.from_state AS fromState, t.reason AS reason, COALESCE(p.principal_type, 'unknown') AS principalType
     FROM work_item_state_transitions t
     INNER JOIN work_items wi ON wi.project_id = t.project_id AND wi.item_id = t.item_id
     LEFT JOIN principals p ON p.principal_id = (
       SELECT h.transitioned_by_principal_id FROM work_item_state_transitions h
       WHERE h.project_id = t.project_id AND h.item_id = t.item_id AND h.to_state = 'in_review' AND h.item_version < t.item_version
       ORDER BY h.item_version DESC LIMIT 1)
     WHERE t.project_id = ? AND wi.type = 'task' AND t.from_state IN ('in_review', 'in_validation') AND t.to_state = 'in_progress'
       AND t.transitioned_at BETWEEN ? AND ?`,
  ).all(input.projectId, from, to) as Array<{ fromState: string; reason: string; principalType: string }>;
  const count = <T>(values: T[], keyOf: (value: T) => string) => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(keyOf(value), (counts.get(keyOf(value)) ?? 0) + 1);
    return counts;
  };
  const byStage = count(returnRows, (row) => row.fromState);
  const byReason = count(returnRows, (row) => row.reason.trim().toLowerCase().slice(0, 120));
  const bySegment = count(returnRows, (row) => row.principalType);

  const reports = database.prepare(
    `SELECT r.entries_json AS entries FROM task_delivery_reports r
     WHERE r.project_id = ? AND r.report_number = (SELECT MAX(x.report_number) FROM task_delivery_reports x WHERE x.project_id = r.project_id AND x.item_id = r.item_id)
       AND r.submitted_at BETWEEN ? AND ?`,
  ).all(input.projectId, from, to) as Array<{ entries: string }>;
  const byStatus = { met: 0, partial: 0, not_met: 0, not_applicable: 0 };
  for (const report of reports) {
    for (const entry of JSON.parse(report.entries) as Array<{ status: keyof typeof byStatus }>) {
      if (entry.status in byStatus) byStatus[entry.status] += 1;
    }
  }
  const judged = byStatus.met + byStatus.partial + byStatus.not_met;

  const doneStories = (database.prepare(
    `SELECT COUNT(*) AS n FROM work_items wi WHERE wi.project_id = ? AND wi.type = 'story' AND wi.state = 'done'
       AND (SELECT MAX(d.transitioned_at) FROM work_item_state_transitions d WHERE d.project_id = wi.project_id AND d.item_id = wi.item_id AND d.to_state = 'done') BETWEEN ? AND ?`,
  ).get(input.projectId, from, to) as { n: number }).n;
  const bugsOnDoneStories = (database.prepare(
    `SELECT COUNT(*) AS n FROM work_items b INNER JOIN work_items s ON s.project_id = b.project_id AND s.item_id = b.related_story_id
     WHERE b.project_id = ? AND b.type = 'bug' AND s.state = 'done' AND b.created_at BETWEEN ? AND ?`,
  ).get(input.projectId, from, to) as { n: number }).n;

  return {
    projectId: input.projectId, period: { from, to }, minimumSample: minimumQualitySample,
    acceptance: {
      doneTasks: doneTasks.length, firstPassTasks: firstPass, firstPassRate: rate(firstPass, doneTasks.length),
      bySegment: [...segments].sort(([a], [b]) => a.localeCompare(b)).map(([principalType, value]) => ({
        principalType, doneTasks: value.done, firstPassTasks: value.firstPass, firstPassRate: rate(value.firstPass, value.done),
      })),
    },
    returns: {
      total: returnRows.length,
      byStage: returnStates.map((fromState) => ({ fromState, count: byStage.get(fromState) ?? 0 })),
      topReasons: [...byReason].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([reason, total]) => ({ reason, count: total })),
      bySegment: [...bySegment].sort(([a], [b]) => a.localeCompare(b)).map(([principalType, total]) => ({ principalType, count: total })),
    },
    criteria: { reportedTasks: reports.length, byStatus, unresolvedShare: judged < minimumQualitySample ? null : Math.round(((byStatus.partial + byStatus.not_met) / judged) * 1000) / 10 },
    bugs: { doneStories, bugsOnDoneStories, bugsPerDoneStory: doneStories < minimumQualitySample ? null : Math.round((bugsOnDoneStories / doneStories) * 100) / 100 },
    limitations: [
      `Rates are null below ${minimumQualitySample} samples.`,
      "Segments use the principal type of whoever moved the task to review; there is no per-person ranking.",
      "Gate blocks are not recorded as events, so the most-blocking gate cannot be ranked yet; returns by reason are the available proxy.",
    ],
  };
}
