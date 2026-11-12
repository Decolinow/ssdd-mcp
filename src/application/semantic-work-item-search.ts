import { createHash } from "node:crypto";
import type { WorkItemState, WorkItemType } from "../domain/work-items.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import type { TextEmbeddingProvider } from "../integrations/embeddings.js";
import { ApplicationError } from "./errors.js";
import { assertProjectAuthorization } from "./local-identity.js";

const maximumIndexPageSize = 200;
const embeddingBatchSize = 32;
const automaticIndexPageSize = 50;
const maximumIndexedContentLength = 12_000;
const maximumEmbeddingDimensions = 8_192;
const maximumSearchProjectItems = 10_000;

export interface WorkItemSemanticIndexInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly assignedToMe?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface WorkItemSemanticIndexResult {
  readonly indexedCount: number;
  readonly unchangedCount: number;
  readonly skippedChangedCount: number;
  readonly model: string;
  readonly watermarkSequence: number;
  readonly nextCursor: string | null;
}

export interface WorkItemSemanticSearchInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly query: string;
  readonly assignedToMe?: boolean;
  readonly types?: readonly WorkItemType[];
  readonly states?: readonly WorkItemState[];
  readonly limit?: number;
}

export interface WorkItemSemanticSearchResult {
  readonly query: string;
  readonly model: string;
  readonly results: readonly {
    readonly id: string;
    readonly key: string;
    readonly type: WorkItemType;
    readonly title: string;
    readonly description: string | null;
    readonly state: WorkItemState;
    readonly assigneeId: string | null;
    readonly similarity: number;
  }[];
  readonly indexedCount: number;
  readonly missingEmbeddingCount: number;
  readonly indexComplete: boolean;
  readonly nextIndexCursor: string | null;
}

interface WorkItemEmbeddingSource {
  readonly item_id: string;
  readonly item_key: string;
  readonly type: WorkItemType;
  readonly title: string;
  readonly description: string | null;
  readonly state: WorkItemState;
  readonly assignee_principal_id: string | null;
  readonly embedding_content: string;
  readonly cached_content_hash?: string | null;
  readonly cached_vector_json?: string | null;
  readonly cached_dimension?: number | null;
}

interface SemanticSearchCandidate {
  readonly item_id: string;
  readonly item_key: string;
  readonly type: WorkItemType;
  readonly state: WorkItemState;
  readonly assignee_principal_id: string | null;
  readonly embedding_content: string;
  readonly cached_content_hash: string | null;
  readonly cached_vector_json: string | null;
  readonly cached_dimension: number | null;
}

interface RankedSearchCandidate {
  readonly id: string;
  readonly key: string;
  readonly type: WorkItemType;
  readonly state: WorkItemState;
  readonly assigneeId: string | null;
  readonly similarity: number;
}

interface SemanticCursor {
  readonly version: 1;
  readonly projectId: string;
  readonly principalId: string;
  readonly modelKey: string;
  readonly filterHash: string;
  readonly watermark: number;
  readonly afterKey: string;
  readonly afterId: string;
}

export async function indexWorkItemSemantics(
  database: SqliteDatabase,
  provider: TextEmbeddingProvider | undefined,
  input: WorkItemSemanticIndexInput,
): Promise<WorkItemSemanticIndexResult> {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const embeddingProvider = requireProvider(provider);
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumIndexPageSize) {
    throw new ApplicationError("VALIDATION_FAILED", `Semantic index page size must be between 1 and ${maximumIndexPageSize}.`);
  }
  const assignedToMe = input.assignedToMe ?? false;
  const watermark = projectWatermark(database, input.projectId);
  const filterHash = hash(JSON.stringify({ assignedToMe }));
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  if (cursor !== undefined) {
    if (
      cursor.projectId !== input.projectId || cursor.principalId !== input.principalId ||
      cursor.modelKey !== embeddingProvider.modelKey || cursor.filterHash !== filterHash
    ) {
      throw new ApplicationError("VALIDATION_FAILED", "The semantic index cursor belongs to another project, principal, model or filter.");
    }
    if (cursor.watermark !== watermark) {
      throw new ApplicationError("STALE_CURSOR", "The project changed during semantic indexing. Restart without a cursor.");
    }
  }

  const after = cursor;
  const sources = selectWorkItemSources(database, input.projectId, input.principalId, embeddingProvider.modelKey, {
    assignedToMe,
    limit: limit + 1,
    ...(after === undefined ? {} : { afterKey: after.afterKey, afterId: after.afterId }),
  });
  const hasMore = sources.length > limit;
  const page = sources.slice(0, limit);
  const pending: Array<{ readonly source: WorkItemEmbeddingSource; readonly content: string; readonly contentHash: string }> = [];
  let unchangedCount = 0;
  for (const source of page) {
    const content = embeddingContent(source);
    const contentHash = hash(content);
    if (source.cached_content_hash === contentHash) unchangedCount += 1;
    else pending.push({ source, content, contentHash });
  }

  let indexedCount = 0;
  let skippedChangedCount = 0;
  for (let offset = 0; offset < pending.length; offset += embeddingBatchSize) {
    const batch = pending.slice(offset, offset + embeddingBatchSize);
    const vectors = await embeddingProvider.embed(batch.map((item) => item.content));
    validateVectors(vectors, batch.length);
    const persist = database.transaction(() => {
      const latestById = new Map(
        selectWorkItemSourcesByIds(database, input.projectId, batch.map((item) => item.source.item_id))
          .map((source) => [source.item_id, source] as const),
      );
      for (const [index, item] of batch.entries()) {
        const latest = latestById.get(item.source.item_id);
        if (latest === undefined || hash(embeddingContent(latest)) !== item.contentHash) {
          skippedChangedCount += 1;
          continue;
        }
        const vector = vectors[index]!;
        database.prepare(
          `INSERT INTO work_item_embeddings
            (project_id, item_id, model_key, model_name, content_hash, vector_json, dimension, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, item_id, model_key) DO UPDATE SET
             model_name = excluded.model_name,
             content_hash = excluded.content_hash,
             vector_json = excluded.vector_json,
             dimension = excluded.dimension,
             indexed_at = excluded.indexed_at`,
        ).run(
          input.projectId, item.source.item_id, embeddingProvider.modelKey, embeddingProvider.modelName,
          item.contentHash, JSON.stringify(vector), vector.length, new Date().toISOString(),
        );
        indexedCount += 1;
      }
    });
    persist.immediate();
  }

  const last = page.at(-1);
  return {
    indexedCount,
    unchangedCount,
    skippedChangedCount,
    model: embeddingProvider.modelName,
    watermarkSequence: watermark,
    nextCursor: hasMore && last !== undefined
      ? encodeCursor({
          version: 1,
          projectId: input.projectId,
          principalId: input.principalId,
          modelKey: embeddingProvider.modelKey,
          filterHash,
          watermark,
          afterKey: last.item_key,
          afterId: last.item_id,
        })
      : null,
  };
}

export async function searchWorkItemsSemantically(
  database: SqliteDatabase,
  provider: TextEmbeddingProvider | undefined,
  input: WorkItemSemanticSearchInput,
): Promise<WorkItemSemanticSearchResult> {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const embeddingProvider = requireProvider(provider);
  const query = input.query.trim();
  const limit = input.limit ?? 10;
  if (query.length < 3 || query.length > 1_000 || /\p{Cc}/u.test(query)) {
    throw new ApplicationError("VALIDATION_FAILED", "Semantic search query must contain 3-1000 printable characters.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new ApplicationError("VALIDATION_FAILED", "Semantic search result limit must be between 1 and 50.");
  }
  const types = normalizeSet(input.types, ["epic", "feature", "story", "bug", "task"] as const, "work item types");
  const states = normalizeSet(input.states, ["draft", "ready", "in_progress", "in_review", "in_validation", "done", "cancelled"] as const, "work item states");
  const assignedToMe = input.assignedToMe ?? false;
  const sourceCount = countSearchItems(database, input.projectId, input.principalId, assignedToMe);
  if (sourceCount > maximumSearchProjectItems) {
    throw new ApplicationError("SEMANTIC_SEARCH_PROJECT_TOO_LARGE", `Exact semantic search is bounded to ${maximumSearchProjectItems} work items per project.`);
  }

  const queryVectors = await embeddingProvider.embed([query]);
  validateVectors(queryVectors, 1);
  const queryVector = queryVectors[0]!;

  const indexing = await indexWorkItemSemantics(database, embeddingProvider, {
    projectId: input.projectId,
    principalId: input.principalId,
    assignedToMe,
    limit: automaticIndexPageSize,
  });
  const candidates = iterateSemanticSearchCandidates(
    database,
    input.projectId,
    input.principalId,
    embeddingProvider.modelKey,
    assignedToMe,
    types,
    states,
  );
  const ranked: RankedSearchCandidate[] = [];
  let indexedCount = 0;
  let missingEmbeddingCount = 0;
  for (const source of candidates) {
    const contentHash = hash(embeddingContent(source));
    if (
      source.cached_content_hash == null || source.cached_vector_json == null || source.cached_dimension == null ||
      source.cached_content_hash !== contentHash
    ) {
      missingEmbeddingCount += 1;
      continue;
    }
    if (source.cached_dimension !== queryVector.length) {
      throw new ApplicationError("EMBEDDING_DIMENSION_MISMATCH", "The query vector does not match the configured model index. Rebuild the semantic index.");
    }
    let vector: unknown;
    try {
      vector = JSON.parse(source.cached_vector_json) as unknown;
    } catch {
      throw new ApplicationError("SEMANTIC_INDEX_CORRUPT", "A stored semantic vector is invalid. Rebuild the semantic index.");
    }
    if (!isVector(vector, source.cached_dimension)) {
      throw new ApplicationError("SEMANTIC_INDEX_CORRUPT", "A stored semantic vector is invalid. Rebuild the semantic index.");
    }
    indexedCount += 1;
    insertRankedCandidate(ranked, {
      id: source.item_id,
      key: source.item_key,
      type: source.type,
      state: source.state,
      assigneeId: source.assignee_principal_id,
      similarity: roundSimilarity(cosineSimilarity(queryVector, vector)),
    }, limit);
  }
  const details = selectSearchItemDetails(database, input.projectId, ranked.map((item) => item.id));
  const results = ranked.flatMap((item) => {
    const detail = details.get(item.id);
    return detail === undefined ? [] : [{ ...item, title: detail.title, description: detail.description }];
  });
  return {
    query,
    model: embeddingProvider.modelName,
    results,
    indexedCount,
    missingEmbeddingCount,
    indexComplete: missingEmbeddingCount === 0,
    nextIndexCursor: indexing.nextCursor,
  };
}

function countSearchItems(database: SqliteDatabase, projectId: string, principalId: string, assignedToMe: boolean): number {
  const row = database.prepare(
    `SELECT COUNT(*) AS count FROM work_items
     WHERE project_id = ? AND (? = 0 OR assignee_principal_id = ?)`,
  ).get(projectId, assignedToMe ? 1 : 0, principalId) as { count: number };
  return row.count;
}

function* iterateSemanticSearchCandidates(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  modelKey: string,
  assignedToMe: boolean,
  types: readonly WorkItemType[],
  states: readonly WorkItemState[],
): Generator<SemanticSearchCandidate> {
  const typeFilter = types.length === 0 ? "" : `AND wi.type IN (${types.map(() => "?").join(", ")})`;
  const stateFilter = states.length === 0 ? "" : `AND wi.state IN (${states.map(() => "?").join(", ")})`;
  const statement = database.prepare(
    `SELECT wi.item_id, wi.item_key, wi.type, wi.state, wi.assignee_principal_id,
            ${embeddingContentSql("wi")} AS embedding_content,
            embedding.content_hash AS cached_content_hash,
            embedding.vector_json AS cached_vector_json,
            embedding.dimension AS cached_dimension
     FROM work_items wi
     LEFT JOIN work_item_embeddings embedding
       ON embedding.project_id = wi.project_id AND embedding.item_id = wi.item_id AND embedding.model_key = ?
     WHERE wi.project_id = ? AND (? = 0 OR wi.assignee_principal_id = ?) ${typeFilter} ${stateFilter}
     ORDER BY wi.item_key COLLATE NOCASE, wi.item_id`,
  );
  const rows = statement.iterate(
    modelKey, projectId, assignedToMe ? 1 : 0, principalId, ...types, ...states,
  ) as IterableIterator<SemanticSearchCandidate>;
  yield* rows;
}

function selectSearchItemDetails(
  database: SqliteDatabase,
  projectId: string,
  itemIds: readonly string[],
): Map<string, { readonly title: string; readonly description: string | null }> {
  if (itemIds.length === 0) return new Map();
  const placeholders = itemIds.map(() => "?").join(", ");
  const rows = database.prepare(
    `SELECT item_id, title, description FROM work_items
     WHERE project_id = ? AND item_id IN (${placeholders})`,
  ).all(projectId, ...itemIds) as Array<{ item_id: string; title: string; description: string | null }>;
  return new Map(rows.map((row) => [row.item_id, { title: row.title, description: row.description }]));
}

function compareRankedCandidates(left: RankedSearchCandidate, right: RankedSearchCandidate): number {
  return right.similarity - left.similarity || left.key.localeCompare(right.key);
}

function insertRankedCandidate(
  ranked: RankedSearchCandidate[],
  candidate: RankedSearchCandidate,
  limit: number,
): void {
  let low = 0;
  let high = Math.min(ranked.length, limit);
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareRankedCandidates(candidate, ranked[middle]!) < 0) high = middle;
    else low = middle + 1;
  }
  if (low >= limit) return;
  ranked.splice(low, 0, candidate);
  if (ranked.length > limit) ranked.pop();
}

function selectWorkItemSources(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  modelKey: string,
  options: { readonly assignedToMe: boolean; readonly limit: number; readonly afterKey?: string; readonly afterId?: string },
): WorkItemEmbeddingSource[] {
  return database.prepare(
    `SELECT wi.item_id, wi.item_key, wi.type, wi.title, wi.description, wi.state, wi.assignee_principal_id,
            ${embeddingContentSql("wi")} AS embedding_content,
            embedding.content_hash AS cached_content_hash,
            embedding.vector_json AS cached_vector_json,
            embedding.dimension AS cached_dimension
     FROM work_items wi
     LEFT JOIN work_item_embeddings embedding
       ON embedding.project_id = wi.project_id AND embedding.item_id = wi.item_id AND embedding.model_key = ?
     WHERE wi.project_id = ?
       AND (? = 0 OR wi.assignee_principal_id = ?)
       AND (? IS NULL OR wi.item_key COLLATE NOCASE > ? COLLATE NOCASE
         OR (wi.item_key COLLATE NOCASE = ? COLLATE NOCASE AND wi.item_id > ?))
     ORDER BY wi.item_key COLLATE NOCASE, wi.item_id
     LIMIT ?`,
  ).all(
    modelKey,
    projectId,
    options.assignedToMe ? 1 : 0,
    principalId,
    options.afterKey ?? null,
    options.afterKey ?? null,
    options.afterKey ?? null,
    options.afterId ?? "",
    options.limit,
  ) as WorkItemEmbeddingSource[];
}

function selectWorkItemSourcesByIds(
  database: SqliteDatabase,
  projectId: string,
  itemIds: readonly string[],
): WorkItemEmbeddingSource[] {
  if (itemIds.length === 0) return [];
  const placeholders = itemIds.map(() => "?").join(", ");
  return database.prepare(
    `SELECT wi.item_id, wi.item_key, wi.type, wi.title, wi.description, wi.state, wi.assignee_principal_id,
            ${embeddingContentSql("wi")} AS embedding_content
     FROM work_items wi WHERE wi.project_id = ? AND wi.item_id IN (${placeholders})`,
  ).all(projectId, ...itemIds) as WorkItemEmbeddingSource[];
}

function embeddingContent(source: { readonly embedding_content: string }): string {
  return source.embedding_content.slice(0, maximumIndexedContentLength);
}

function embeddingContentSql(alias: "wi"): string {
  return `substr(${alias}.item_key || ' ' || ${alias}.type || ': ' || ${alias}.title || char(10) ||
    COALESCE(${alias}.description, '') || char(10) || 'Critérios:' || char(10) || COALESCE((
      SELECT group_concat(ordered_criteria.description, char(10))
      FROM (
        SELECT criteria.description
        FROM work_item_criteria criteria
        WHERE criteria.project_id = ${alias}.project_id AND criteria.item_id = ${alias}.item_id
        ORDER BY criteria.position, criteria.criterion_id
      ) AS ordered_criteria
    ), ''), 1, ${maximumIndexedContentLength})`;
}

function projectWatermark(database: SqliteDatabase, projectId: string): number {
  const row = database.prepare("SELECT COALESCE(MAX(sequence), 0) AS watermark FROM audit_events WHERE project_id = ?")
    .get(projectId) as { watermark: number };
  return row.watermark;
}

function requireProvider(provider: TextEmbeddingProvider | undefined): TextEmbeddingProvider {
  if (provider === undefined) {
    throw new ApplicationError("EMBEDDINGS_NOT_CONFIGURED", "Configure SSDD_EMBEDDING_ENDPOINT and SSDD_EMBEDDING_MODEL to use semantic task search.");
  }
  if (!/^[a-f0-9]{64}$/u.test(provider.modelKey) || provider.modelName.trim().length === 0) {
    throw new ApplicationError("EMBEDDING_PROVIDER_INVALID", "The configured embedding provider has invalid model metadata.");
  }
  return provider;
}

function validateVectors(vectors: readonly (readonly number[])[], expectedCount: number): void {
  if (
    vectors.length !== expectedCount || vectors.length === 0 ||
    vectors.some((vector) => !isVector(vector, vectors[0]?.length ?? 0))
  ) {
    throw new ApplicationError("EMBEDDING_PROVIDER_INVALID_RESPONSE", "The embedding provider returned invalid or inconsistent vectors.");
  }
}

function isVector(value: unknown, dimension: number): value is number[] {
  return Array.isArray(value) && dimension > 0 && dimension <= maximumEmbeddingDimensions && value.length === dimension &&
    value.every((component) => typeof component === "number" && Number.isFinite(component));
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftComponent = left[index]!;
    const rightComponent = right[index]!;
    dot += leftComponent * rightComponent;
    leftMagnitude += leftComponent * leftComponent;
    rightMagnitude += rightComponent * rightComponent;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function roundSimilarity(value: number): number {
  return Math.round(Math.max(-1, Math.min(1, value)) * 10_000) / 10_000;
}

function normalizeSet<T extends string>(values: readonly T[] | undefined, allowed: readonly T[], label: string): T[] {
  const normalized = [...new Set(values ?? [])];
  if (normalized.some((value) => !allowed.includes(value))) {
    throw new ApplicationError("VALIDATION_FAILED", `Semantic search has invalid ${label}.`);
  }
  return normalized;
}

function encodeCursor(cursor: SemanticCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): SemanticCursor {
  if (value.length > 4_096 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "The semantic index cursor is invalid.");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object") throw new Error("Invalid cursor");
    const cursor = parsed as Record<string, unknown>;
    if (
      cursor.version !== 1 || typeof cursor.projectId !== "string" || typeof cursor.principalId !== "string" ||
      typeof cursor.modelKey !== "string" || typeof cursor.filterHash !== "string" ||
      !Number.isSafeInteger(cursor.watermark) || typeof cursor.afterKey !== "string" || typeof cursor.afterId !== "string"
    ) throw new Error("Invalid cursor");
    return cursor as unknown as SemanticCursor;
  } catch {
    throw new ApplicationError("VALIDATION_FAILED", "The semantic index cursor is invalid.");
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
