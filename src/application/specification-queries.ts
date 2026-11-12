import type {
  Specification,
  SpecificationKind,
  SpecificationRevision,
  SpecificationRevisionStatus,
  SpecificationContent,
} from "../domain/specifications.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { decodeStableListCursor, encodeStableListCursor, hashListFilters } from "./stable-list-cursor.js";

export interface SpecificationPage {
  readonly specifications: readonly Specification[];
  readonly nextCursor: string | null;
  readonly watermark: number;
}

interface SpecificationRow {
  readonly spec_id: string;
  readonly project_id: string;
  readonly spec_key: string;
  readonly kind: SpecificationKind;
  readonly title: string;
  readonly version: number;
  readonly created_by_principal_id: string;
  readonly created_at: string;
}

interface RevisionRow {
  readonly revision_id: string;
  readonly project_id: string;
  readonly spec_id: string;
  readonly revision_number: number;
  readonly status: SpecificationRevisionStatus;
  readonly content_json: string;
  readonly created_by_principal_id: string;
  readonly created_at: string;
  readonly published_by_principal_id: string | null;
  readonly published_at: string | null;
}

type ListedSpecificationRow = SpecificationRow & {
  readonly latest_revision: number;
  readonly latest_status: SpecificationRevisionStatus | null;
  readonly published_revision: number | null;
  readonly latest_content_json?: string | null;
};

export function getSpecification(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  specIdOrKey: string,
): Specification {
  assertProjectAuthorization(database, projectId, principalId);
  const reference = specIdOrKey.trim();
  const row = database
    .prepare(
      `SELECT spec_id, project_id, spec_key, kind, title, version,
              created_by_principal_id, created_at
       FROM specifications
       WHERE project_id = ? AND (spec_id = ? OR spec_key = ? COLLATE NOCASE)`,
    )
    .get(projectId, reference, reference) as SpecificationRow | undefined;
  if (row === undefined) {
    throw new ApplicationError("NOT_FOUND", "Specification was not found.");
  }

  const revisions = database
    .prepare(
      `SELECT revision_id, project_id, spec_id, revision_number, status, content_json,
              created_by_principal_id, created_at, published_by_principal_id, published_at
       FROM specification_revisions
       WHERE project_id = ? AND spec_id = ?
       ORDER BY revision_number`,
    )
    .all(projectId, row.spec_id)
    .map((revisionRow) => toSpecificationRevision(revisionRow as RevisionRow, row));
  const latestRevision = revisions.at(-1)?.revisionNumber ?? 0;
  const publishedRevision =
    revisions.find((revision) => revision.status === "published")?.revisionNumber ?? null;

  return {
    id: row.spec_id,
    projectId: row.project_id,
    key: row.spec_key,
    kind: row.kind,
    title: row.title,
    version: row.version,
    latestRevision,
    latestStatus: revisions.at(-1)?.status ?? null,
    publishedRevision,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at,
    revisions,
  };
}

export function listSpecifications(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  input: { readonly kind?: SpecificationKind; readonly search?: string; readonly limit?: number; readonly cursor?: string } = {},
): SpecificationPage {
  assertProjectAuthorization(database, projectId, principalId);
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "Specification page size must be an integer between 1 and 100.");
  }
  const kind = input.kind ?? null;
  const search = input.search?.trim() || null;
  if (search !== null && (search.length < 2 || search.length > 160)) {
    throw new ApplicationError("VALIDATION_FAILED", "Specification search must contain 2-160 characters.");
  }
  const filterHash = hashListFilters({ kind, search: search === null ? null : foldSearch(search), limit });
  const watermarkRow = database.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS watermark FROM audit_events WHERE project_id = ?",
  ).get(projectId) as { watermark: number };
  const watermark = watermarkRow.watermark;
  const cursor = input.cursor === undefined ? undefined : decodeStableListCursor(input.cursor, {
    projectId, principalId, filterHash, watermark,
  });
  const afterClause = cursor === undefined ? "" : `
       AND (s.spec_key COLLATE NOCASE > ? OR (s.spec_key COLLATE NOCASE = ? AND s.spec_id > ?))`;
  const parameters: Array<string | number | null> = [projectId, kind, kind];
  if (cursor !== undefined) parameters.push(cursor.afterKey, cursor.afterKey, cursor.afterId);
  parameters.push(limit + 1);
  let rows: ListedSpecificationRow[];
  if (search === null) {
    rows = database
      .prepare(
        `SELECT s.spec_id, s.project_id, s.spec_key, s.kind, s.title, s.version,
                s.created_by_principal_id, s.created_at,
                COALESCE(MAX(r.revision_number), 0) AS latest_revision,
                (SELECT latest.status FROM specification_revisions latest
                 WHERE latest.project_id = s.project_id AND latest.spec_id = s.spec_id
                 ORDER BY latest.revision_number DESC LIMIT 1) AS latest_status,
                MAX(CASE WHEN r.status = 'published' THEN r.revision_number END) AS published_revision
         FROM specifications AS s
         LEFT JOIN specification_revisions AS r
           ON r.project_id = s.project_id AND r.spec_id = s.spec_id
         WHERE s.project_id = ? AND (? IS NULL OR s.kind = ?)
         ${afterClause}
         GROUP BY s.spec_id
         ORDER BY s.spec_key COLLATE NOCASE, s.spec_id
         LIMIT ?`,
      )
      .all(...parameters) as ListedSpecificationRow[];
  } else {
    const statement = database.prepare(
      `SELECT s.spec_id, s.project_id, s.spec_key, s.kind, s.title, s.version,
              s.created_by_principal_id, s.created_at,
              COALESCE(MAX(r.revision_number), 0) AS latest_revision,
              (SELECT latest.status FROM specification_revisions latest
               WHERE latest.project_id = s.project_id AND latest.spec_id = s.spec_id
               ORDER BY latest.revision_number DESC LIMIT 1) AS latest_status,
              MAX(CASE WHEN r.status = 'published' THEN r.revision_number END) AS published_revision,
              (SELECT latest.content_json FROM specification_revisions latest
               WHERE latest.project_id = s.project_id AND latest.spec_id = s.spec_id
               ORDER BY latest.revision_number DESC LIMIT 1) AS latest_content_json
       FROM specifications AS s
       LEFT JOIN specification_revisions AS r
         ON r.project_id = s.project_id AND r.spec_id = s.spec_id
       WHERE s.project_id = ? AND (? IS NULL OR s.kind = ?)
       ${afterClause}
       GROUP BY s.spec_id
       ORDER BY s.spec_key COLLATE NOCASE, s.spec_id`,
    );
    rows = [];
    for (const candidate of statement.iterate(...parameters.slice(0, cursor === undefined ? 3 : 6))) {
      const row = candidate as ListedSpecificationRow;
      if (!includesSearch(row.spec_key, search) && !includesSearch(row.title, search) &&
        !includesSearch(row.latest_content_json ?? "", search)) continue;
      rows.push(row);
      if (rows.length > limit) break;
    }
  }
  const matchingRows = rows;
  const hasMore = matchingRows.length > limit;
  const pageRows = matchingRows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    specifications: pageRows.map((row) => ({
    id: row.spec_id,
    projectId: row.project_id,
    key: row.spec_key,
    kind: row.kind,
    title: row.title,
    version: row.version,
    latestRevision: row.latest_revision,
    latestStatus: row.latest_status,
    publishedRevision: row.published_revision,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at,
    revisions: [],
    })),
    nextCursor: hasMore && last !== undefined ? encodeStableListCursor({
      version: 1, projectId, principalId, filterHash, watermark, afterKey: last.spec_key, afterId: last.spec_id,
    }) : null,
    watermark,
  };
}

function includesSearch(value: string, search: string): boolean {
  return foldSearch(value).includes(foldSearch(search));
}

function foldSearch(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR");
}

function toSpecificationRevision(
  row: RevisionRow,
  specification: SpecificationRow,
): SpecificationRevision {
  return {
    id: row.revision_id,
    projectId: row.project_id,
    specId: row.spec_id,
    key: specification.spec_key,
    kind: specification.kind,
    title: specification.title,
    revisionNumber: row.revision_number,
    status: row.status,
    content: JSON.parse(row.content_json) as SpecificationContent,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at,
    publishedByPrincipalId: row.published_by_principal_id,
    publishedAt: row.published_at,
  };
}
