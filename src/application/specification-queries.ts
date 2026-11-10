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
  kind?: SpecificationKind,
): Specification[] {
  assertProjectAuthorization(database, projectId, principalId);
  const rows = database
    .prepare(
      `SELECT s.spec_id, s.project_id, s.spec_key, s.kind, s.title, s.version,
              s.created_by_principal_id, s.created_at,
              COALESCE(MAX(r.revision_number), 0) AS latest_revision,
              MAX(CASE WHEN r.status = 'published' THEN r.revision_number END) AS published_revision
       FROM specifications AS s
       LEFT JOIN specification_revisions AS r
         ON r.project_id = s.project_id AND r.spec_id = s.spec_id
       WHERE s.project_id = ? AND (? IS NULL OR s.kind = ?)
       GROUP BY s.spec_id
       ORDER BY s.spec_key COLLATE NOCASE
       LIMIT 100`,
    )
    .all(projectId, kind ?? null, kind ?? null) as Array<
    SpecificationRow & { latest_revision: number; published_revision: number | null }
  >;

  return rows.map((row) => ({
    id: row.spec_id,
    projectId: row.project_id,
    key: row.spec_key,
    kind: row.kind,
    title: row.title,
    version: row.version,
    latestRevision: row.latest_revision,
    publishedRevision: row.published_revision,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at,
    revisions: [],
  }));
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
