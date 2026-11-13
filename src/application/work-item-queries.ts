import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { createHash } from "node:crypto";
import type {
  AcceptanceCriterion,
  CriterionStructure,
  WorkItem,
  WorkItemContentRevision,
  WorkItemEstimate,
  WorkItemListItem,
  WorkItemState,
  WorkItemType,
} from "../domain/work-items.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { ApplicationError } from "./errors.js";
import { resolveWorkItemIdentifier } from "./work-item-reference.js";

interface WorkItemRow {
  readonly item_id: string;
  readonly project_id: string;
  readonly item_key: string;
  readonly type: WorkItemType;
  readonly parent_id: string | null;
  readonly related_story_id: string | null;
  readonly assignee_principal_id: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly state: string;
  readonly priority: number;
  readonly business_value_score: number | null;
  readonly business_value_rationale: string | null;
  readonly rank: number;
  readonly version: number;
  readonly revision: number;
  readonly created_by_principal_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export function getWorkItem(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  itemIdOrKey: string,
): WorkItem {
  assertProjectAuthorization(database, projectId, principalId);

  const lookupReference = resolveWorkItemIdentifier(database, projectId, itemIdOrKey);

  const row = database
    .prepare(
      `SELECT item_id, project_id, item_key, type, parent_id, related_story_id,
              assignee_principal_id, title, description, state, priority,
              business_value_score, business_value_rationale, rank, version, created_by_principal_id,
              created_at, updated_at,
              (SELECT MAX(r.revision_number) FROM work_item_revisions r
               WHERE r.project_id = work_items.project_id AND r.item_id = work_items.item_id
                 AND r.status = 'published') AS revision
       FROM work_items
       WHERE project_id = ? AND (item_id = ? OR item_key = ? COLLATE NOCASE)`,
    )
    .get(projectId, lookupReference, lookupReference) as WorkItemRow | undefined;

  if (row === undefined) {
    throw new ApplicationError("NOT_FOUND", "Work item was not found.");
  }

  const criteria = database
    .prepare(
      `SELECT criterion_id, criterion_key, description, is_required, position, structure_json
       FROM work_item_criteria WHERE project_id = ? AND item_id = ? AND is_active = 1 ORDER BY position`,
    )
    .all(projectId, row.item_id)
    .map((entry) => {
      const criterion = entry as {
        criterion_id: string;
        criterion_key: string;
        description: string;
        is_required: number;
        position: number;
        structure_json: string | null;
      };
      const result: AcceptanceCriterion = {
        id: criterion.criterion_id,
        key: criterion.criterion_key,
        description: criterion.description,
        required: criterion.is_required === 1,
        position: criterion.position,
        ...(criterion.structure_json === null ? {} : (JSON.parse(criterion.structure_json) as CriterionStructure)),
      };
      return result;
    });
  const estimates = database
    .prepare(
      `SELECT unit, value, proposal_id, confirmed_by_principal_id, confirmed_at
       FROM work_item_estimates WHERE project_id = ? AND item_id = ? ORDER BY unit`,
    )
    .all(projectId, row.item_id)
    .map((entry) => {
      const estimate = entry as {
        unit: WorkItemEstimate["unit"];
        value: number;
        proposal_id: string;
        confirmed_by_principal_id: string;
        confirmed_at: string;
      };
      return {
        unit: estimate.unit,
        value: estimate.value,
        proposalId: estimate.proposal_id,
        confirmedByPrincipalId: estimate.confirmed_by_principal_id,
        confirmedAt: estimate.confirmed_at,
      } satisfies WorkItemEstimate;
    });

  return {
    id: row.item_id,
    projectId: row.project_id,
    key: row.item_key,
    type: row.type,
    parentId: row.parent_id,
    relatedStoryId: row.related_story_id,
    assigneeId: row.assignee_principal_id,
    title: row.title,
    description: row.description,
    state: row.state,
    priority: row.priority,
    businessValueScore: row.business_value_score,
    businessValueRationale: row.business_value_rationale,
    rank: row.rank,
    version: row.version,
    revision: row.revision,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    criteria,
    estimates,
  };
}

export function listWorkItemRevisions(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  itemIdOrKey: string,
): readonly WorkItemContentRevision[] {
  assertProjectAuthorization(database, projectId, principalId);
  const lookupReference = resolveWorkItemIdentifier(database, projectId, itemIdOrKey);
  const item = database
    .prepare(
      `SELECT item_id FROM work_items
       WHERE project_id = ? AND (item_id = ? OR item_key = ? COLLATE NOCASE)`,
    )
    .get(projectId, lookupReference, lookupReference) as { item_id: string } | undefined;
  if (item === undefined) {
    throw new ApplicationError("NOT_FOUND", "Work item was not found.");
  }
  const rows = database
    .prepare(
      `SELECT revision_id, project_id, item_id, revision_number, status, snapshot_json,
              created_by_principal_id, created_at, published_by_principal_id, published_at
       FROM work_item_revisions WHERE project_id = ? AND item_id = ? ORDER BY revision_number`,
    )
    .all(projectId, item.item_id) as Array<{
    revision_id: string;
    project_id: string;
    item_id: string;
    revision_number: number;
    status: WorkItemContentRevision["status"];
    snapshot_json: string;
    created_by_principal_id: string;
    created_at: string;
    published_by_principal_id: string | null;
    published_at: string | null;
  }>;
  return rows.map((row) => ({
    id: row.revision_id,
    projectId: row.project_id,
    itemId: row.item_id,
    revisionNumber: row.revision_number,
    status: row.status,
    snapshot: normalizeWorkItemSnapshot(JSON.parse(row.snapshot_json) as Record<string, unknown>),
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at,
    publishedByPrincipalId: row.published_by_principal_id,
    publishedAt: row.published_at,
  }));
}

export interface ListWorkItemsInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly types?: readonly WorkItemType[];
  readonly states?: readonly WorkItemState[];
  readonly parentId?: string;
  readonly search?: string;
  readonly assignedToMe?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface WorkItemPage {
  readonly items: readonly WorkItemListItem[];
  readonly nextCursor: string | null;
}

interface WorkItemListRow {
  readonly item_id: string;
  readonly item_key: string;
  readonly type: WorkItemType;
  readonly parent_id: string | null;
  readonly assignee_principal_id: string | null;
  readonly title: string;
  readonly state: WorkItemState;
  readonly priority: number;
  readonly business_value_score: number | null;
  readonly business_value_rationale: string | null;
  readonly rank: number;
  readonly version: number;
  readonly revision: number;
  readonly updated_at: string;
}

interface WorkItemCursor {
  readonly version: 1;
  readonly projectId: string;
  readonly principalId: string;
  readonly filterHash: string;
  readonly watermark: number;
  readonly afterKey: string;
  readonly afterId: string;
  readonly afterRank: number;
}

export function listWorkItems(database: SqliteDatabase, input: ListWorkItemsInput): WorkItemPage {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const filters = normalizeListFilters(input);
  const parent =
    filters.parentId === null
      ? undefined
      : (database
          .prepare(
            `SELECT item_id FROM work_items
             WHERE project_id = ? AND (item_id = ? OR item_key = ? COLLATE NOCASE)`,
          )
          .get(input.projectId, filters.parentId, filters.parentId) as
          | { item_id: string }
          | undefined);
  const resolvedParentId = parent?.item_id ?? null;
  const filterHash = hash(
    JSON.stringify({
      types: filters.types,
      states: filters.states,
      parentId: resolvedParentId,
      parentWasRequested: filters.parentWasRequested,
      searchExpression: filters.searchExpression,
      assignedToMe: filters.assignedToMe,
      limit: filters.limit,
    }),
  );
  const watermarkRow = database
    .prepare("SELECT COALESCE(MAX(sequence), 0) AS watermark FROM audit_events WHERE project_id = ?")
    .get(input.projectId) as { watermark: number };
  const watermark = watermarkRow.watermark;
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);

  if (cursor !== undefined) {
    if (
      cursor.projectId !== input.projectId ||
      cursor.principalId !== input.principalId ||
      cursor.filterHash !== filterHash
    ) {
      throw new ApplicationError(
        "VALIDATION_FAILED",
        "The cursor belongs to another project, principal or filter set.",
      );
    }
    if (cursor.watermark !== watermark) {
      throw new ApplicationError(
        "STALE_CURSOR",
        "The project changed after this page was read. Restart the list without a cursor.",
      );
    }
  }

  const where = ["wi.project_id = ?"];
  const parameters: Array<string | number> = [input.projectId];
  if (filters.types.length > 0) {
    where.push(`wi.type IN (${filters.types.map(() => "?").join(", ")})`);
    parameters.push(...filters.types);
  }
  if (filters.states.length > 0) {
    where.push(`wi.state IN (${filters.states.map(() => "?").join(", ")})`);
    parameters.push(...filters.states);
  }
  if (resolvedParentId !== null) {
    where.push("wi.parent_id = ?");
    parameters.push(resolvedParentId);
  } else if (filters.parentWasRequested) {
    where.push("0 = 1");
  }
  if (filters.assignedToMe) {
    where.push("wi.assignee_principal_id = ?");
    parameters.push(input.principalId);
  }
  if (filters.searchExpression !== null) {
    where.push("work_items_fts MATCH ?");
    parameters.push(filters.searchExpression);
  }
  if (cursor !== undefined) {
    where.push(
      `(
        wi.rank > ? OR
        (wi.rank = ? AND (
          wi.item_key COLLATE NOCASE > ? OR
          (wi.item_key COLLATE NOCASE = ? AND wi.item_id > ?)
        ))
      )`,
    );
    parameters.push(
      cursor.afterRank,
      cursor.afterRank,
      cursor.afterKey,
      cursor.afterKey,
      cursor.afterId,
    );
  }

  const rows = database
    .prepare(
      `SELECT wi.item_id, wi.item_key, wi.type, wi.parent_id, wi.assignee_principal_id,
              wi.title, wi.state, wi.priority, wi.business_value_score, wi.business_value_rationale,
              wi.rank, wi.version, wi.updated_at,
              (SELECT MAX(r.revision_number) FROM work_item_revisions r
               WHERE r.project_id = wi.project_id AND r.item_id = wi.item_id
                 AND r.status = 'published') AS revision
       FROM work_items AS wi
       ${filters.searchExpression === null ? "" : "INNER JOIN work_items_fts ON work_items_fts.rowid = wi.rowid"}
       WHERE ${where.join(" AND ")}
       ORDER BY wi.rank, wi.item_key COLLATE NOCASE, wi.item_id
       LIMIT ?`,
    )
    .all(...parameters, filters.limit + 1) as WorkItemListRow[];

  const hasMore = rows.length > filters.limit;
  const pageRows = rows.slice(0, filters.limit);
  const baseItems = pageRows.map((row) => ({
    id: row.item_id,
    key: row.item_key,
    type: row.type,
    parentId: row.parent_id,
    assigneeId: row.assignee_principal_id,
    title: row.title,
    state: row.state,
    priority: row.priority,
    businessValueScore: row.business_value_score,
    businessValueRationale: row.business_value_rationale,
    rank: row.rank,
    version: row.version,
    revision: row.revision,
    updatedAt: row.updated_at,
  }));
  const progressByTaskId = taskWorkflowProgressForItems(database, input.projectId,
    baseItems.filter((item) => item.type === "task").map((item) => item.id));
  const items: WorkItemListItem[] = baseItems.map((item) => {
    const progress = progressByTaskId.get(item.id);
    return {
      ...item,
      taskWorkflowRevisionNumber: progress?.revisionNumber ?? null,
      taskWorkflowProgressPercent: progress?.progressPercent ?? null,
      taskWorkflowCompletedSteps: progress?.completedSteps ?? null,
      taskWorkflowTotalSteps: progress?.totalSteps ?? null,
    };
  });
  const last = pageRows.at(-1);

  return {
    items,
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor({
            version: 1,
            projectId: input.projectId,
            principalId: input.principalId,
            filterHash,
            watermark,
            afterKey: last.item_key,
            afterId: last.item_id,
            afterRank: last.rank,
          })
        : null,
  };
}

function normalizeWorkItemSnapshot(value: Record<string, unknown>): WorkItemContentRevision["snapshot"] {
  return {
    type: value.type as WorkItemType,
    parentId: value.parentId as string | null,
    relatedStoryId: value.relatedStoryId as string | null,
    title: value.title as string,
    description: value.description as string | null,
    priority: value.priority as number,
    businessValueScore: typeof value.businessValueScore === "number" ? value.businessValueScore : null,
    businessValueRationale: typeof value.businessValueRationale === "string" ? value.businessValueRationale : null,
    criteria: value.criteria as readonly AcceptanceCriterion[],
  };
}

function taskWorkflowProgressForItems(
  database: SqliteDatabase,
  projectId: string,
  itemIds: readonly string[],
): Map<string, { readonly revisionNumber: number; readonly progressPercent: number; readonly completedSteps: number; readonly totalSteps: number }> {
  const result = new Map<string, { revisionNumber: number; progressPercent: number; completedSteps: number; totalSteps: number }>();
  if (itemIds.length === 0) return result;
  const rows = database.prepare(
    `SELECT revision.item_id, revision.revision_number, COUNT(step.step_id) AS total_steps,
            SUM(CASE WHEN event.to_status = 'done' THEN 1 ELSE 0 END) AS completed_steps,
            SUM(CASE WHEN event.to_status = 'done' THEN step.effort_basis_points ELSE 0 END) AS completed_effort_basis_points
     FROM task_workflow_revisions revision
     INNER JOIN task_workflow_steps step ON step.project_id = revision.project_id AND step.item_id = revision.item_id
       AND step.revision_number = revision.revision_number
     LEFT JOIN task_workflow_step_events event ON event.sequence = (
       SELECT MAX(latest.sequence) FROM task_workflow_step_events latest
       WHERE latest.project_id = step.project_id AND latest.item_id = step.item_id
         AND latest.revision_number = step.revision_number AND latest.step_id = step.step_id
     )
     WHERE revision.project_id = ? AND revision.status = 'published'
       AND revision.item_id IN (${itemIds.map(() => "?").join(", ")})
     GROUP BY revision.item_id, revision.revision_number`,
  ).all(projectId, ...itemIds) as Array<{
    item_id: string; revision_number: number; total_steps: number; completed_steps: number; completed_effort_basis_points: number;
  }>;
  for (const row of rows) result.set(row.item_id, {
    revisionNumber: row.revision_number,
    progressPercent: Math.round(row.completed_effort_basis_points) / 100,
    completedSteps: row.completed_steps,
    totalSteps: row.total_steps,
  });
  return result;
}

interface NormalizedListFilters {
  readonly types: WorkItemType[];
  readonly states: WorkItemState[];
  readonly parentId: string | null;
  readonly parentWasRequested: boolean;
  readonly searchExpression: string | null;
  readonly assignedToMe: boolean;
  readonly limit: number;
}

function normalizeListFilters(input: ListWorkItemsInput): NormalizedListFilters {
  const types = [...new Set(input.types ?? [])].sort();
  const states = [...new Set(input.states ?? [])].sort();
  const parentReference = input.parentId?.trim() || null;
  const search = input.search?.trim() ?? "";
  const searchTokens = [...new Set(search.match(/[\p{L}\p{N}_]+/gu)?.map((token) => token.toLowerCase()) ?? [])];
  const limit = input.limit ?? 25;

  if (types.length > 5 || states.length > 7) {
    throw new ApplicationError("VALIDATION_FAILED", "List filters contain too many values.");
  }
  if (search.length > 200 || searchTokens.length > 10) {
    throw new ApplicationError("VALIDATION_FAILED", "Search accepts at most 200 characters and 10 terms.");
  }
  if (search.length > 0 && searchTokens.length === 0) {
    throw new ApplicationError("VALIDATION_FAILED", "Search must contain at least one searchable term.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "Page size must be an integer between 1 and 100.");
  }

  return {
    types,
    states,
    parentId: parentReference,
    parentWasRequested: parentReference !== null,
    searchExpression: searchTokens.length === 0 ? null : searchTokens.map((token) => `"${token}"`).join(" AND "),
    assignedToMe: input.assignedToMe ?? false,
    limit,
  };
}

function encodeCursor(cursor: WorkItemCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): WorkItemCursor {
  if (value.length > 4_096 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "The list cursor is invalid.");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isWorkItemCursor(parsed)) {
      throw new Error("Invalid cursor shape");
    }
    return parsed;
  } catch {
    throw new ApplicationError("VALIDATION_FAILED", "The list cursor is invalid.");
  }
}

function isWorkItemCursor(value: unknown): value is WorkItemCursor {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const cursor = value as Record<string, unknown>;
  return (
    cursor.version === 1 &&
    typeof cursor.projectId === "string" &&
    typeof cursor.principalId === "string" &&
    typeof cursor.filterHash === "string" &&
    typeof cursor.watermark === "number" &&
    Number.isSafeInteger(cursor.watermark) &&
    typeof cursor.afterKey === "string" &&
    typeof cursor.afterId === "string" &&
    typeof cursor.afterRank === "number" &&
    Number.isSafeInteger(cursor.afterRank)
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
