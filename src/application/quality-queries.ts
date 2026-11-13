import type { AcceptanceCriterion } from "../domain/work-items.js";
import type { TestRun, ScenarioCoverageMatch } from "../domain/scenarios.js";
import type { TestRunCertification, WorkItemEvidence } from "../domain/workflow.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { getWorkBaseline } from "./baseline-commands.js";
import { ApplicationError } from "./errors.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { listWorkItemEvidence } from "./work-item-workflow.js";
import { getWorkItem } from "./work-item-queries.js";
import { searchScenariosByCriteria } from "./scenario-queries.js";
import { decodeStableListCursor, encodeStableListCursor, hashListFilters } from "./stable-list-cursor.js";

export interface WorkItemQualityScenario {
  readonly scenario: ScenarioCoverageMatch["scenario"];
  readonly revision: ScenarioCoverageMatch["revision"];
  readonly latestRuns: readonly {
    readonly run: TestRun;
    readonly certification: TestRunCertification | null;
  }[];
}

export interface WorkItemQualityCriterion {
  readonly criterion: AcceptanceCriterion;
  readonly covered: boolean;
  readonly scenarios: readonly WorkItemQualityScenario[];
}

export interface WorkItemQualityReport {
  readonly projectId: string;
  readonly itemId: string;
  readonly itemKey: string;
  readonly state: string;
  readonly version: number;
  readonly mode: "pinned" | "preview";
  readonly baseline: { readonly id: string; readonly sequence: number } | null;
  readonly requiredCriteria: number;
  readonly coveredRequiredCriteria: number;
  readonly coveragePercent: number | null;
  readonly criteria: readonly WorkItemQualityCriterion[];
  readonly evidence: readonly WorkItemEvidence[];
  readonly nextEvidenceCursor: string | null;
}

interface CertificationRow {
  readonly certification_id: string;
  readonly project_id: string;
  readonly item_id: string;
  readonly item_key: string;
  readonly baseline_id: string;
  readonly run_id: string;
  readonly certified_by_principal_id: string;
  readonly reason: string;
  readonly certified_at: string;
}

export function getWorkItemQualityReport(
  database: SqliteDatabase,
  input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly itemIdOrKey: string;
    readonly evidenceCursor?: string;
  },
): WorkItemQualityReport {
  const item = getWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey.trim());
  if (item.type !== "story" && item.type !== "bug") {
    throw new ApplicationError("VALIDATION_FAILED", "Quality reports are available for stories and bugs.");
  }

  let baseline: ReturnType<typeof getWorkBaseline> | null = null;
  try {
    baseline = getWorkBaseline(database, input.projectId, input.principalId, item.id);
  } catch (error) {
    if (!(error instanceof ApplicationError) || error.code !== "NOT_FOUND") throw error;
  }

  const pinnedItemRevision = baseline?.references.find((reference) => reference.entityType === "work_item_revision");
  const baselineSnapshot = pinnedItemRevision?.snapshot as { readonly criteria?: unknown } | undefined;
  const criteria = baselineSnapshot !== undefined && Array.isArray(baselineSnapshot.criteria)
    ? baselineSnapshot.criteria as AcceptanceCriterion[]
    : item.criteria;
  const pinnedScenarioRevisions = new Set(
    baseline?.references
      .filter((reference) => reference.entityType === "scenario_revision")
      .map((reference) => `${reference.entityId}:${reference.revisionNumber}`) ?? [],
  );
  const certifications = readCertifications(database, input.projectId, item.id, baseline?.id ?? null);

  const matchesByCriterion = searchScenariosByCriteria(
    database, input.projectId, input.principalId, criteria.map((criterion) => criterion.id),
  );
  const qualityCriteria = criteria.map((criterion): WorkItemQualityCriterion => {
    const matches = (matchesByCriterion.get(criterion.id) ?? [])
      .filter((match) => baseline === null
        ? match.revision.status === "published"
        : pinnedScenarioRevisions.has(`${match.scenario.id}:${match.revision.revisionNumber}`))
      .map((match) => toQualityScenario(match, certifications));
    return { criterion, covered: matches.length > 0, scenarios: matches };
  });
  const requiredCriteria = qualityCriteria.filter((entry) => entry.criterion.required);
  const coveredRequiredCriteria = requiredCriteria.filter((entry) => entry.covered).length;
  const evidencePage = listWorkItemEvidence(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    itemIdOrKey: item.id,
    limit: 100,
    ...(input.evidenceCursor === undefined ? {} : { cursor: input.evidenceCursor }),
  });

  return {
    projectId: item.projectId,
    itemId: item.id,
    itemKey: item.key,
    state: item.state,
    version: item.version,
    mode: baseline === null ? "preview" : "pinned",
    baseline: baseline === null ? null : { id: baseline.id, sequence: baseline.sequence },
    requiredCriteria: requiredCriteria.length,
    coveredRequiredCriteria,
    coveragePercent: requiredCriteria.length === 0 ? null : Math.round(coveredRequiredCriteria / requiredCriteria.length * 100),
    criteria: qualityCriteria,
    evidence: evidencePage.evidence,
    nextEvidenceCursor: evidencePage.nextCursor,
  };
}

export interface QualitySummaryPage {
  readonly items: readonly {
    readonly itemId: string;
    readonly itemKey: string;
    readonly type: "story" | "bug";
    readonly title: string;
    readonly state: string;
    readonly version: number;
    readonly baselineId: string | null;
    readonly baselineSequence: number | null;
    /** True when a newer PBI revision exists than the one pinned by the current baseline. */
    readonly staleBaseline: boolean;
    /** Certified QA runs recorded against the current baseline; zero means not validated (BR-QA-001). */
    readonly certifiedRuns: number;
    readonly requiredCriteria: number;
    readonly coveredRequiredCriteria: number;
    readonly coveragePercent: number | null;
  }[];
  readonly nextCursor: string | null;
  readonly watermark: number;
}

export function listProjectQualitySummaries(
  database: SqliteDatabase,
  input: { readonly projectId: string; readonly principalId: string; readonly limit?: number; readonly cursor?: string },
): QualitySummaryPage {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "Quality summary page size must be an integer between 1 and 100.");
  }
  const filterHash = hashListFilters({ limit });
  const watermarkRow = database.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS watermark FROM audit_events WHERE project_id = ?",
  ).get(input.projectId) as { watermark: number };
  const watermark = watermarkRow.watermark;
  const cursor = input.cursor === undefined ? undefined : decodeStableListCursor(input.cursor, {
    projectId: input.projectId, principalId: input.principalId, filterHash, watermark,
  });
  const cursorFilter = cursor === undefined ? "" : `
     AND (wi.item_key COLLATE NOCASE > ?
          OR (wi.item_key COLLATE NOCASE = ? AND wi.item_id > ?))`;
  const parameters: Array<string | number> = [input.projectId];
  if (cursor !== undefined) parameters.push(cursor.afterKey, cursor.afterKey, cursor.afterId);
  parameters.push(limit + 1);
  const rows = database.prepare(
    `WITH current_items AS (
       SELECT wi.project_id, wi.item_id, wi.item_key, wi.type, wi.title, wi.state, wi.version,
              (SELECT b.baseline_id FROM work_baselines b
               WHERE b.project_id = wi.project_id AND b.item_id = wi.item_id
               ORDER BY b.sequence DESC LIMIT 1) AS baseline_id
       FROM work_items wi WHERE wi.project_id = ? AND wi.type IN ('story', 'bug') ${cursorFilter}
     ), criteria AS (
       SELECT ci.project_id, ci.item_id, ci.baseline_id,
              json_extract(criterion.value, '$.id') AS criterion_id,
              json_extract(criterion.value, '$.required') AS is_required
       FROM current_items ci
       INNER JOIN baseline_refs item_ref ON item_ref.project_id = ci.project_id
         AND item_ref.baseline_id = ci.baseline_id AND item_ref.entity_type = 'work_item_revision'
       INNER JOIN work_item_revisions revision ON revision.project_id = item_ref.project_id
         AND revision.item_id = item_ref.entity_id AND revision.revision_number = item_ref.revision_number
       JOIN json_each(revision.snapshot_json, '$.criteria') criterion
       WHERE ci.baseline_id IS NOT NULL
       UNION ALL
       SELECT ci.project_id, ci.item_id, NULL, criterion.criterion_id, criterion.is_required
       FROM current_items ci INNER JOIN work_item_criteria criterion
         ON criterion.project_id = ci.project_id AND criterion.item_id = ci.item_id AND criterion.is_active = 1
       WHERE ci.baseline_id IS NULL
     ), criterion_quality AS (
       SELECT criterion.project_id, criterion.item_id, criterion.baseline_id,
              criterion.criterion_id, criterion.is_required,
              EXISTS (
                SELECT 1 FROM scenario_revision_coverage coverage
                INNER JOIN scenario_revisions revision ON revision.project_id = coverage.project_id
                  AND revision.scenario_id = coverage.scenario_id AND revision.revision_number = coverage.revision_number
                WHERE coverage.project_id = criterion.project_id AND coverage.target_type = 'criterion'
                  AND coverage.target_id = criterion.criterion_id
                  AND (
                    (criterion.baseline_id IS NOT NULL AND EXISTS (
                      SELECT 1 FROM baseline_refs scenario_ref
                      WHERE scenario_ref.project_id = criterion.project_id
                        AND scenario_ref.baseline_id = criterion.baseline_id
                        AND scenario_ref.entity_type = 'scenario_revision'
                        AND scenario_ref.entity_id = coverage.scenario_id
                        AND scenario_ref.revision_number = coverage.revision_number
                    ))
                    OR (criterion.baseline_id IS NULL AND revision.status = 'published')
                  )
              ) AS is_covered
       FROM criteria criterion
     )
     SELECT quality.* FROM (
       SELECT ci.item_id, ci.item_key, ci.type, ci.title, ci.state, ci.version, ci.baseline_id,
            (SELECT b.sequence FROM work_baselines b WHERE b.project_id = ci.project_id
             AND b.baseline_id = ci.baseline_id) AS baseline_sequence,
            CASE WHEN ci.baseline_id IS NULL THEN 0 ELSE
              (SELECT MAX(r.revision_number) FROM work_item_revisions r
               WHERE r.project_id = ci.project_id AND r.item_id = ci.item_id AND r.status IN ('published', 'superseded')) >
              COALESCE((SELECT ref.revision_number FROM baseline_refs ref
                WHERE ref.project_id = ci.project_id AND ref.baseline_id = ci.baseline_id
                  AND ref.entity_type = 'work_item_revision' AND ref.entity_id = ci.item_id), 0)
            END AS stale_baseline,
            (SELECT COUNT(*) FROM test_run_certifications cert
             WHERE cert.project_id = ci.project_id AND cert.item_id = ci.item_id
               AND cert.baseline_id = ci.baseline_id) AS certified_runs,
            SUM(CASE WHEN cq.is_required = 1 THEN 1 ELSE 0 END) AS required_criteria,
            SUM(CASE WHEN cq.is_required = 1 AND cq.is_covered THEN 1 ELSE 0 END) AS covered_required_criteria
       FROM current_items ci LEFT JOIN criterion_quality cq
         ON cq.project_id = ci.project_id AND cq.item_id = ci.item_id
       GROUP BY ci.project_id, ci.item_id
     ) AS quality
     ORDER BY quality.item_key COLLATE NOCASE, quality.item_id
     LIMIT ?`,
  ).all(...parameters).map((row) => {
    const result = row as {
      item_id: string; item_key: string; type: "story" | "bug"; title: string; state: string; version: number;
      baseline_id: string | null; baseline_sequence: number | null; required_criteria: number | null;
      covered_required_criteria: number | null; stale_baseline: number; certified_runs: number;
    };
    const requiredCriteria = result.required_criteria ?? 0;
    const coveredRequiredCriteria = result.covered_required_criteria ?? 0;
    return {
      itemId: result.item_id,
      itemKey: result.item_key,
      type: result.type,
      title: result.title,
      state: result.state,
      version: result.version,
      baselineId: result.baseline_id,
      baselineSequence: result.baseline_sequence,
      staleBaseline: result.stale_baseline === 1,
      certifiedRuns: result.certified_runs,
      requiredCriteria,
      coveredRequiredCriteria,
      coveragePercent: requiredCriteria === 0 ? null : Math.round(coveredRequiredCriteria / requiredCriteria * 100),
    };
  }) as QualitySummaryPage["items"];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last !== undefined ? encodeStableListCursor({
      version: 1,
      projectId: input.projectId,
      principalId: input.principalId,
      filterHash,
      watermark,
      afterKey: last.itemKey,
      afterId: last.itemId,
    }) : null,
    watermark,
  };
}

function readCertifications(
  database: SqliteDatabase,
  projectId: string,
  itemId: string,
  baselineId: string | null,
): Map<string, TestRunCertification> {
  if (baselineId === null) return new Map();
  const rows = database.prepare(
    `SELECT c.certification_id, c.project_id, c.item_id, wi.item_key, c.baseline_id, c.run_id,
            c.certified_by_principal_id, c.reason, c.certified_at
     FROM test_run_certifications c INNER JOIN work_items wi
       ON wi.project_id = c.project_id AND wi.item_id = c.item_id
     WHERE c.project_id = ? AND c.item_id = ? AND c.baseline_id = ?`,
  ).all(projectId, itemId, baselineId) as CertificationRow[];
  return new Map(rows.map((row) => [row.run_id, {
    id: row.certification_id,
    projectId: row.project_id,
    itemId: row.item_id,
    itemKey: row.item_key,
    baselineId: row.baseline_id,
    runId: row.run_id,
    certifiedByPrincipalId: row.certified_by_principal_id,
    reason: row.reason,
    certifiedAt: row.certified_at,
  }]));
}

function toQualityScenario(
  match: ScenarioCoverageMatch,
  certifications: ReadonlyMap<string, TestRunCertification>,
): WorkItemQualityScenario {
  return {
    scenario: match.scenario,
    revision: match.revision,
    latestRuns: match.resultsByBuild.map((run) => ({
      run,
      certification: certifications.get(run.id) ?? null,
    })),
  };
}
