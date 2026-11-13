import { createHash } from "node:crypto";
import { testRunResults, type TestRunOrigin } from "../domain/scenarios.js";
import type {
  Scenario,
  ScenarioCoverageMatch,
  ScenarioKind,
  ScenarioRevision,
  ScenarioRevisionStatus,
  ScenarioSnapshot,
  ScenarioSummary,
  TestRun,
  TestRunResult,
} from "../domain/scenarios.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { decodeStableListCursor, encodeStableListCursor, hashListFilters } from "./stable-list-cursor.js";

export interface ScenarioPage {
  readonly scenarios: readonly ScenarioSummary[];
  readonly nextCursor: string | null;
  readonly watermark: number;
}

interface ScenarioRow {
  readonly scenario_id: string;
  readonly project_id: string;
  readonly scenario_key: string;
  readonly kind: ScenarioKind;
  readonly title: string;
  readonly version: number;
  readonly created_by_principal_id: string;
  readonly created_at: string;
}

interface ScenarioRevisionRow {
  readonly revision_id: string;
  readonly project_id: string;
  readonly scenario_id: string;
  readonly scenario_key: string;
  readonly kind: ScenarioKind;
  readonly revision_number: number;
  readonly status: ScenarioRevisionStatus;
  readonly snapshot_json: string;
  readonly created_by_principal_id: string;
  readonly created_at: string;
  readonly published_by_principal_id: string | null;
  readonly published_at: string | null;
}

export function getScenario(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  scenarioIdOrKey: string,
): Scenario {
  assertProjectAuthorization(database, projectId, principalId);
  const reference = scenarioIdOrKey.trim();
  const scenario = findScenario(database, projectId, reference);
  if (scenario === undefined) {
    throw new ApplicationError("NOT_FOUND", "Scenario was not found.");
  }
  const revisions = database
    .prepare(
      `SELECT r.revision_id, r.project_id, r.scenario_id, s.scenario_key, s.kind,
              r.revision_number, r.status, r.snapshot_json,
              r.created_by_principal_id, r.created_at,
              r.published_by_principal_id, r.published_at
       FROM scenario_revisions r
       INNER JOIN scenarios s ON s.project_id = r.project_id AND s.scenario_id = r.scenario_id
       WHERE r.project_id = ? AND r.scenario_id = ? ORDER BY r.revision_number`,
    )
    .all(projectId, scenario.scenario_id)
    .map((row) => toRevision(row as ScenarioRevisionRow));
  const latestRevision = revisions.at(-1)?.revisionNumber ?? 0;
  const publishedRevision = revisions.find((revision) => revision.status === "published")?.revisionNumber ?? null;
  return {
    id: scenario.scenario_id,
    projectId: scenario.project_id,
    key: scenario.scenario_key,
    kind: scenario.kind,
    title: scenario.title,
    version: scenario.version,
    latestRevision,
    publishedRevision,
    createdByPrincipalId: scenario.created_by_principal_id,
    createdAt: scenario.created_at,
    revisions,
  };
}

export function listScenarioRevisionWorkItems(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  scenarioIdOrKey: string,
  revisionNumber: number,
): readonly { readonly id: string; readonly key: string; readonly title: string }[] {
  const scenario = getScenario(database, projectId, principalId, scenarioIdOrKey);
  if (!Number.isSafeInteger(revisionNumber) || !scenario.revisions.some((revision) => revision.revisionNumber === revisionNumber)) {
    throw new ApplicationError("NOT_FOUND", "Scenario revision was not found.");
  }
  return database.prepare(
    `SELECT item.item_id, item.item_key, item.title
     FROM scenario_revision_work_items link
     INNER JOIN work_items item ON item.project_id = link.project_id AND item.item_id = link.item_id
     WHERE link.project_id = ? AND link.scenario_id = ? AND link.revision_number = ?
     ORDER BY item.item_key COLLATE NOCASE`,
  ).all(projectId, scenario.id, revisionNumber).map((value) => {
    const row = value as { item_id: string; item_key: string; title: string };
    return { id: row.item_id, key: row.item_key, title: row.title };
  });
}

export function listScenarios(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  input: { readonly kind?: ScenarioKind; readonly limit?: number; readonly cursor?: string } = {},
): ScenarioPage {
  assertProjectAuthorization(database, projectId, principalId);
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "Scenario page size must be an integer between 1 and 100.");
  }
  const kind = input.kind ?? null;
  const filterHash = hashListFilters({ kind, limit });
  const watermarkRow = database.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS watermark FROM audit_events WHERE project_id = ?",
  ).get(projectId) as { watermark: number };
  const watermark = watermarkRow.watermark;
  const cursor = input.cursor === undefined ? undefined : decodeStableListCursor(input.cursor, {
    projectId, principalId, filterHash, watermark,
  });
  const afterClause = cursor === undefined ? "" : `
       AND (s.scenario_key COLLATE NOCASE > ? OR (s.scenario_key COLLATE NOCASE = ? AND s.scenario_id > ?))`;
  const parameters: Array<string | number | null> = [projectId, kind, kind];
  if (cursor !== undefined) parameters.push(cursor.afterKey, cursor.afterKey, cursor.afterId);
  parameters.push(limit + 1);
  const rows = database
    .prepare(
      `SELECT s.scenario_id, s.scenario_key, s.kind, s.title, s.version,
              COALESCE(MAX(r.revision_number), 0) AS latest_revision,
              MAX(CASE WHEN r.status = 'published' THEN r.revision_number END) AS published_revision
       FROM scenarios s LEFT JOIN scenario_revisions r
         ON r.project_id = s.project_id AND r.scenario_id = s.scenario_id
       WHERE s.project_id = ? AND (? IS NULL OR s.kind = ?)
       ${afterClause}
       GROUP BY s.scenario_id ORDER BY s.scenario_key COLLATE NOCASE, s.scenario_id LIMIT ?`,
    )
    .all(...parameters) as Array<{
    scenario_id: string;
    scenario_key: string;
    kind: ScenarioKind;
    title: string;
    version: number;
    latest_revision: number;
    published_revision: number | null;
  }>;
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    scenarios: pageRows.map((row) => ({
      id: row.scenario_id,
      key: row.scenario_key,
      kind: row.kind,
      title: row.title,
      version: row.version,
      latestRevision: row.latest_revision,
      publishedRevision: row.published_revision,
    })),
    nextCursor: hasMore && last !== undefined ? encodeStableListCursor({
      version: 1, projectId, principalId, filterHash, watermark, afterKey: last.scenario_key, afterId: last.scenario_id,
    }) : null,
    watermark,
  };
}

export function listTestRuns(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  options: { readonly limit?: number; readonly scenarioIdOrKey?: string } = {},
): readonly TestRun[] {
  return listTestRunPage(database, projectId, principalId, {
    limit: options.limit ?? 100,
    ...(options.scenarioIdOrKey === undefined ? {} : { scenarioIdOrKey: options.scenarioIdOrKey }),
  }).runs;
}

export interface ListTestRunsInput {
  readonly limit?: number;
  readonly scenarioIdOrKey?: string;
  readonly buildId?: string;
  readonly result?: TestRunResult;
  readonly cursor?: string;
}

export interface TestRunPage {
  readonly runs: readonly TestRun[];
  readonly nextCursor: string | null;
  readonly watermark: number;
}

interface TestRunCursor {
  readonly version: 1;
  readonly projectId: string;
  readonly principalId: string;
  readonly filterHash: string;
  readonly watermark: number;
  readonly beforeSequence: number;
}

export function listTestRunPage(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  input: ListTestRunsInput = {},
): TestRunPage {
  assertProjectAuthorization(database, projectId, principalId);
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "Test run page size must be an integer between 1 and 100.");
  }
  const scenarioReference = input.scenarioIdOrKey?.trim() || null;
  if (scenarioReference !== null && scenarioReference.length > 80) {
    throw new ApplicationError("VALIDATION_FAILED", "Scenario reference must be at most 80 characters.");
  }
  const buildId = input.buildId?.trim() || null;
  if (buildId !== null && buildId.length > 128) {
    throw new ApplicationError("VALIDATION_FAILED", "Build identifier must be at most 128 characters.");
  }
  const result = input.result ?? null;
  if (result !== null && !testRunResults.includes(result)) {
    throw new ApplicationError("VALIDATION_FAILED", "Test run result is invalid.");
  }

  const scenario = scenarioReference === null ? undefined : findScenario(database, projectId, scenarioReference);
  const scenarioId = scenario?.scenario_id ?? null;
  const where = ["tr.project_id = ?"];
  const parameters: Array<string | number> = [projectId];
  if (scenarioReference !== null) {
    if (scenarioId === null) where.push("0 = 1");
    else {
      where.push("tr.scenario_id = ?");
      parameters.push(scenarioId);
    }
  }
  if (buildId !== null) {
    where.push("tr.build_id = ?");
    parameters.push(buildId);
  }
  if (result !== null) {
    where.push("tr.result = ?");
    parameters.push(result);
  }
  const filterHash = createHash("sha256").update(JSON.stringify({
    scenarioId,
    missingScenario: scenarioId === null ? scenarioReference?.toLowerCase() ?? null : null,
    buildId,
    result,
    limit,
  })).digest("hex");
  const watermarkRow = database.prepare(
    `SELECT COALESCE(MAX(tr.sequence), 0) AS watermark FROM test_runs tr WHERE ${where.join(" AND ")}`,
  ).get(...parameters) as { watermark: number };
  const watermark = watermarkRow.watermark;
  const cursor = input.cursor === undefined ? undefined : decodeTestRunCursor(input.cursor);
  if (cursor !== undefined) {
    if (
      cursor.projectId !== projectId || cursor.principalId !== principalId || cursor.filterHash !== filterHash
    ) {
      throw new ApplicationError("VALIDATION_FAILED", "The test run cursor belongs to another project, principal or filter set.");
    }
    if (cursor.watermark !== watermark) {
      throw new ApplicationError("STALE_CURSOR", "Matching test runs changed after this page was read. Restart without a cursor.");
    }
  }

  const pageWhere = [...where, "tr.sequence <= ?"];
  const pageParameters: Array<string | number> = [...parameters, watermark];
  if (cursor !== undefined) {
    pageWhere.push("tr.sequence < ?");
    pageParameters.push(cursor.beforeSequence);
  }
  const rows = database.prepare(
    `SELECT tr.sequence, tr.run_id, tr.project_id, tr.scenario_id, s.scenario_key, tr.revision_number,
            tr.build_id, tr.result, tr.notes, tr.evidence_uri, tr.origin, tr.evidence_sha256,
            tr.executed_by_principal_id, tr.executed_at
     FROM test_runs tr INNER JOIN scenarios s
       ON s.project_id = tr.project_id AND s.scenario_id = tr.scenario_id
     WHERE ${pageWhere.join(" AND ")}
     ORDER BY tr.sequence DESC LIMIT ?`,
  ).all(...pageParameters, limit + 1) as Array<{
    sequence: number;
    run_id: string;
    project_id: string;
    scenario_id: string;
    scenario_key: string;
    revision_number: number;
    build_id: string;
    result: TestRunResult;
    notes: string | null;
    evidence_uri: string | null;
    origin: TestRunOrigin;
    evidence_sha256: string | null;
    executed_by_principal_id: string;
    executed_at: string;
  }>;
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const runs = pageRows.map((row) => ({
    id: row.run_id,
    projectId: row.project_id,
    scenarioId: row.scenario_id,
    scenarioKey: row.scenario_key,
    revisionNumber: row.revision_number,
    buildId: row.build_id,
    result: row.result,
    notes: row.notes,
    evidenceUri: row.evidence_uri,
    origin: row.origin,
    evidenceSha256: row.evidence_sha256,
    executedByPrincipalId: row.executed_by_principal_id,
    executedAt: row.executed_at,
  }));
  const last = pageRows.at(-1);
  return {
    runs,
    nextCursor: hasMore && last !== undefined ? encodeTestRunCursor({
      version: 1,
      projectId,
      principalId,
      filterHash,
      watermark,
      beforeSequence: last.sequence,
    }) : null,
    watermark,
  };
}

function encodeTestRunCursor(cursor: TestRunCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeTestRunCursor(value: string): TestRunCursor {
  if (value.length > 4_096 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "The test run cursor is invalid.");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object") throw new Error("Invalid cursor shape");
    const cursor = parsed as Record<string, unknown>;
    if (
      cursor.version !== 1 || typeof cursor.projectId !== "string" || typeof cursor.principalId !== "string" ||
      typeof cursor.filterHash !== "string" || !/^[a-f0-9]{64}$/u.test(cursor.filterHash) ||
      typeof cursor.watermark !== "number" || !Number.isSafeInteger(cursor.watermark) || cursor.watermark < 0 ||
      typeof cursor.beforeSequence !== "number" || !Number.isSafeInteger(cursor.beforeSequence) || cursor.beforeSequence < 1
    ) throw new Error("Invalid cursor fields");
    return cursor as unknown as TestRunCursor;
  } catch {
    throw new ApplicationError("VALIDATION_FAILED", "The test run cursor is invalid.");
  }
}

export function searchScenariosByCriterion(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  criterionRef: string,
): readonly ScenarioCoverageMatch[] {
  assertProjectAuthorization(database, projectId, principalId);
  const criterionId = resolveCriterion(database, projectId, criterionRef.trim());
  const rows = database
    .prepare(
      `WITH matching AS (
         SELECT s.scenario_id, s.scenario_key, s.kind, s.title, r.revision_id,
                r.revision_number, r.status, r.snapshot_json,
                r.created_by_principal_id, r.created_at,
                r.published_by_principal_id, r.published_at
         FROM scenario_revision_coverage c
         INNER JOIN scenarios s ON s.project_id = c.project_id AND s.scenario_id = c.scenario_id
         INNER JOIN scenario_revisions r
           ON r.project_id = c.project_id AND r.scenario_id = c.scenario_id
          AND r.revision_number = c.revision_number
         WHERE c.project_id = ? AND c.target_type = 'criterion' AND c.target_id = ?
           AND r.status IN ('published', 'superseded')
       ), latest_runs AS (
         SELECT tr.*, ROW_NUMBER() OVER (
           PARTITION BY tr.project_id, tr.scenario_id, tr.revision_number, tr.build_id
           ORDER BY tr.sequence DESC
         ) AS run_rank
         FROM test_runs tr
         INNER JOIN matching m ON m.scenario_id = tr.scenario_id AND m.revision_number = tr.revision_number
         WHERE tr.project_id = ?
       )
       SELECT m.scenario_id, m.scenario_key, m.kind, m.title, m.revision_id, m.revision_number,
              m.status, m.snapshot_json, m.created_by_principal_id, m.created_at,
              m.published_by_principal_id, m.published_at,
              lr.run_id, lr.build_id, lr.result, lr.notes, lr.evidence_uri, lr.origin, lr.evidence_sha256,
              lr.executed_by_principal_id, lr.executed_at
       FROM matching m LEFT JOIN latest_runs lr
         ON lr.project_id = ? AND lr.scenario_id = m.scenario_id
        AND lr.revision_number = m.revision_number AND lr.run_rank = 1
       ORDER BY m.scenario_key COLLATE NOCASE, m.revision_number, lr.build_id`,
    )
    .all(projectId, criterionId, projectId, projectId) as CoverageRow[];
  return collectCoverageMatches(rows, projectId);
}

/**
 * Batch variant of {@link searchScenariosByCriterion}: one query for every criterion id
 * (already resolved). Result per criterion is identical to the single-criterion search.
 */
export function searchScenariosByCriteria(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  criterionIds: readonly string[],
): ReadonlyMap<string, readonly ScenarioCoverageMatch[]> {
  assertProjectAuthorization(database, projectId, principalId);
  const result = new Map<string, readonly ScenarioCoverageMatch[]>();
  if (criterionIds.length === 0) return result;
  const rows = database
    .prepare(
      `WITH matching AS (
         SELECT c.target_id AS criterion_id, s.scenario_id, s.scenario_key, s.kind, s.title, r.revision_id,
                r.revision_number, r.status, r.snapshot_json,
                r.created_by_principal_id, r.created_at,
                r.published_by_principal_id, r.published_at
         FROM scenario_revision_coverage c
         INNER JOIN scenarios s ON s.project_id = c.project_id AND s.scenario_id = c.scenario_id
         INNER JOIN scenario_revisions r
           ON r.project_id = c.project_id AND r.scenario_id = c.scenario_id
          AND r.revision_number = c.revision_number
         WHERE c.project_id = ? AND c.target_type = 'criterion'
           AND c.target_id IN (SELECT value FROM json_each(?))
           AND r.status IN ('published', 'superseded')
       ), latest_runs AS (
         SELECT tr.*, ROW_NUMBER() OVER (
           PARTITION BY tr.project_id, tr.scenario_id, tr.revision_number, tr.build_id
           ORDER BY tr.sequence DESC
         ) AS run_rank
         FROM test_runs tr
         WHERE tr.project_id = ?
           AND EXISTS (SELECT 1 FROM matching m
                       WHERE m.scenario_id = tr.scenario_id AND m.revision_number = tr.revision_number)
       )
       SELECT m.criterion_id, m.scenario_id, m.scenario_key, m.kind, m.title, m.revision_id, m.revision_number,
              m.status, m.snapshot_json, m.created_by_principal_id, m.created_at,
              m.published_by_principal_id, m.published_at,
              lr.run_id, lr.build_id, lr.result, lr.notes, lr.evidence_uri, lr.origin, lr.evidence_sha256,
              lr.executed_by_principal_id, lr.executed_at
       FROM matching m LEFT JOIN latest_runs lr
         ON lr.project_id = ? AND lr.scenario_id = m.scenario_id
        AND lr.revision_number = m.revision_number AND lr.run_rank = 1
       ORDER BY m.criterion_id, m.scenario_key COLLATE NOCASE, m.revision_number, lr.build_id`,
    )
    .all(projectId, JSON.stringify([...new Set(criterionIds)]), projectId, projectId) as Array<CoverageRow & { criterion_id: string }>;
  const byCriterion = new Map<string, CoverageRow[]>();
  for (const row of rows) {
    const group = byCriterion.get(row.criterion_id);
    if (group === undefined) byCriterion.set(row.criterion_id, [row]);
    else group.push(row);
  }
  for (const criterionId of criterionIds) {
    result.set(criterionId, collectCoverageMatches(byCriterion.get(criterionId) ?? [], projectId));
  }
  return result;
}

interface CoverageRow {
  scenario_id: string;
  scenario_key: string;
  kind: ScenarioKind;
  title: string;
  revision_id: string;
  revision_number: number;
  status: ScenarioRevisionStatus;
  snapshot_json: string;
  created_by_principal_id: string;
  created_at: string;
  published_by_principal_id: string | null;
  published_at: string | null;
  run_id: string | null;
  build_id: string | null;
  result: TestRunResult | null;
  notes: string | null;
  evidence_uri: string | null;
  origin: TestRunOrigin | null;
  evidence_sha256: string | null;
  executed_by_principal_id: string | null;
  executed_at: string | null;
}

function collectCoverageMatches(rows: readonly CoverageRow[], projectId: string): ScenarioCoverageMatch[] {
  const matches = new Map<string, {
    scenario: ScenarioCoverageMatch["scenario"];
    revision: ScenarioRevision;
    resultsByBuild: TestRun[];
  }>();
  for (const row of rows) {
    let match = matches.get(row.revision_id);
    if (match === undefined) {
      const revisionRow: ScenarioRevisionRow = {
        revision_id: row.revision_id,
        project_id: projectId,
        scenario_id: row.scenario_id,
        scenario_key: row.scenario_key,
        kind: row.kind,
        revision_number: row.revision_number,
        status: row.status,
        snapshot_json: row.snapshot_json,
        created_by_principal_id: row.created_by_principal_id,
        created_at: row.created_at,
        published_by_principal_id: row.published_by_principal_id,
        published_at: row.published_at,
      };
      match = {
        scenario: { id: row.scenario_id, key: row.scenario_key, kind: row.kind, title: row.title },
        revision: toRevision(revisionRow),
        resultsByBuild: [],
      };
      matches.set(row.revision_id, match);
    }
    if (
      row.run_id !== null &&
      row.build_id !== null &&
      row.result !== null &&
      row.executed_by_principal_id !== null &&
      row.executed_at !== null
    ) {
      match.resultsByBuild.push({
        id: row.run_id,
        projectId,
        scenarioId: row.scenario_id,
        scenarioKey: row.scenario_key,
        revisionNumber: row.revision_number,
        buildId: row.build_id,
        result: row.result,
        notes: row.notes,
        evidenceUri: row.evidence_uri,
        origin: row.origin ?? 'agent',
        evidenceSha256: row.evidence_sha256,
        executedByPrincipalId: row.executed_by_principal_id,
        executedAt: row.executed_at,
      });
    }
  }
  return [...matches.values()];
}

export function resolveCriterion(
  database: SqliteDatabase,
  projectId: string,
  criterionRef: string,
): string {
  const direct = database
    .prepare("SELECT criterion_id FROM work_item_criteria WHERE project_id = ? AND criterion_id = ?")
    .get(projectId, criterionRef) as { criterion_id: string } | undefined;
  if (direct !== undefined) {
    return direct.criterion_id;
  }
  const separator = criterionRef.lastIndexOf(":");
  if (separator > 0 && separator < criterionRef.length - 1) {
    const itemReference = criterionRef.slice(0, separator);
    const criterionKey = criterionRef.slice(separator + 1);
    const byKey = database
      .prepare(
        `SELECT c.criterion_id FROM work_item_criteria c
         INNER JOIN work_items wi ON wi.project_id = c.project_id AND wi.item_id = c.item_id
         WHERE c.project_id = ? AND (wi.item_id = ? OR wi.item_key = ? COLLATE NOCASE)
           AND c.criterion_key = ? COLLATE NOCASE`,
      )
      .get(projectId, itemReference, itemReference, criterionKey) as { criterion_id: string } | undefined;
    if (byKey !== undefined) {
      return byKey.criterion_id;
    }
  }
  throw new ApplicationError("NOT_FOUND", "Acceptance criterion was not found in this project.");
}

export function findScenario(
  database: SqliteDatabase,
  projectId: string,
  reference: string,
): ScenarioRow | undefined {
  return database
    .prepare(
      `SELECT scenario_id, project_id, scenario_key, kind, title, version,
              created_by_principal_id, created_at
       FROM scenarios WHERE project_id = ? AND (scenario_id = ? OR scenario_key = ? COLLATE NOCASE)`,
    )
    .get(projectId, reference, reference) as ScenarioRow | undefined;
}

export function toRevision(row: ScenarioRevisionRow): ScenarioRevision {
  return {
    id: row.revision_id,
    projectId: row.project_id,
    scenarioId: row.scenario_id,
    key: row.scenario_key,
    kind: row.kind,
    revisionNumber: row.revision_number,
    status: row.status,
    snapshot: JSON.parse(row.snapshot_json) as ScenarioSnapshot,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at,
    publishedByPrincipalId: row.published_by_principal_id,
    publishedAt: row.published_at,
  };
}
