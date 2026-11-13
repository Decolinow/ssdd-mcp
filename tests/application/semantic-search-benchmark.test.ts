import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { indexWorkItemSemantics, searchWorkItemsSemantically } from "../../src/application/semantic-work-item-search.js";
import type { TextEmbeddingProvider } from "../../src/integrations/embeddings.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";

// SSDD-923: reproducible cost/latency baseline for exact semantic search. Uses a deterministic offline provider
// (no network or credential) and temporary workspaces. Scales can be narrowed with SSDD_BENCH_SCALES=1000,5000.
// Hard limits below are the published SLOs (docs/semantic-search-benchmark.md): generous on purpose, so the
// test catches regressions of order of magnitude rather than machine noise.

const dimensions = 384;
const scales = (process.env["SSDD_BENCH_SCALES"] ?? "1000,5000,10000").split(",").map((value) => Number(value.trim()));
const sloMs = { indexPerItem: 5, warmP95: { 1000: 400, 5000: 1_500, 10000: 3_000 } as Record<number, number> };
const sloHeapMegabytes = 512;

test("semantic search benchmark: index time, cold/warm p50/p95, vector size, queries and database size by scale", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-semantic-bench-"));
  const initialized = initializeProject({ workspace, key: "SB", name: "Semantic bench", productGoal: "Medir busca", timezone: "UTC" });
  let database = openSqliteDatabase(initialized.databasePath);
  context.after(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  const projectId = initialized.project.id;
  const principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
    .get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
  const epic = createWorkItem(database, { projectId, principalId, requestId: randomUUID(), type: "epic", title: "Plataforma" }).value;
  const feature = createWorkItem(database, { projectId, principalId, requestId: randomUUID(), type: "feature", parentId: epic.id, title: "Busca" }).value;

  let providerCalls = 0;
  const provider: TextEmbeddingProvider = {
    modelKey: createHash("sha256").update("deterministic-bench").digest("hex"),
    modelName: "deterministic-hash-embedding",
    embed: async (inputs) => {
      providerCalls += 1;
      return inputs.map(hashedVector);
    },
  };
  const topics = ["pagamento", "fatura", "estorno", "relatório", "autenticação", "fila", "sprint", "baseline", "evidência", "cenário"];
  let created = 2;
  const results: unknown[] = [];

  for (const scale of scales) {
    assert.ok(scale <= 10_000 - 2 || scale === 10_000, "scale must fit the exact-search bound");
    while (created < scale) {
      const topic = topics[created % topics.length]!;
      createWorkItem(database, {
        projectId, principalId, requestId: randomUUID(), type: "story", parentId: feature.id,
        title: `Item ${created} sobre ${topic}`, description: `Descrição ${created}: tratar ${topic} com o fluxo número ${created % 97}.`,
      });
      created += 1;
    }

    const callsBeforeIndex = providerCalls;
    const indexStart = performance.now();
    let cursor: string | undefined;
    let indexed = 0;
    do {
      const page = await indexWorkItemSemantics(database, provider, { projectId, principalId, limit: 200, ...(cursor === undefined ? {} : { cursor }) });
      indexed += page.indexedCount;
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    const indexMs = performance.now() - indexStart;
    assert.ok(indexed > 0);
    assert.ok(indexMs / created <= sloMs.indexPerItem, `index took ${(indexMs / created).toFixed(2)} ms/item at ${scale}`);

    const search = (query: string) => searchWorkItemsSemantically(database, provider, { projectId, principalId, query, limit: 10 });
    // Cold: first search on a freshly opened connection (empty page cache and prepared statements).
    const cold: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      database.close();
      database = openSqliteDatabase(initialized.databasePath);
      const start = performance.now();
      const result = await search(`consulta fria ${attempt} sobre ${topics[attempt]!}`);
      cold.push(performance.now() - start);
      assert.equal(result.indexComplete, true);
    }
    const heapBefore = process.memoryUsage().heapUsed;
    let peakHeap = heapBefore;
    const warm: number[] = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const start = performance.now();
      const result = await search(`consulta aquecida ${attempt} sobre ${topics[attempt % topics.length]!}`);
      warm.push(performance.now() - start);
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      assert.equal(result.results.length, 10);
    }
    const queries = countQueries(database, async () => { await search("contagem de consultas sobre pagamento"); });
    const queryCount = await queries;
    const heapGrowthMb = Math.max(0, peakHeap - heapBefore) / 1_048_576;
    const warmStats = percentiles(warm);
    assert.ok(heapGrowthMb <= sloHeapMegabytes, `search heap grew ${heapGrowthMb.toFixed(1)} MB at ${scale}`);
    const limit = sloMs.warmP95[scale];
    if (limit !== undefined) assert.ok(warmStats.p95 <= limit, `warm p95 ${warmStats.p95} ms exceeds ${limit} ms at ${scale}`);
    results.push({
      items: created, vectorDimensions: dimensions, providerCallsForIndex: providerCalls - callsBeforeIndex, indexMs: round(indexMs),
      indexMsPerItem: round(indexMs / created), coldMs: percentiles(cold), warmMs: warmStats,
      sqlStatementsPerSearch: queryCount, databaseMegabytes: round(statSync(initialized.databasePath).size / 1_048_576),
      warmHeapGrowthMegabytes: round(heapGrowthMb),
    });
  }
  console.log(JSON.stringify({ benchmark: "semantic-search", node: process.version, results }));
});

test("semantic search rejects an oversized project before any provider call", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-semantic-limit-"));
  const initialized = initializeProject({ workspace, key: "SL", name: "Semantic limit", productGoal: "Limite", timezone: "UTC" });
  const database = openSqliteDatabase(initialized.databasePath);
  context.after(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  const projectId = initialized.project.id;
  const principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
    .get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
  const epic = createWorkItem(database, { projectId, principalId, requestId: randomUUID(), type: "epic", title: "Épico" }).value;
  // Bulk-insert directly: this test targets the guard, not item creation.
  const insert = database.prepare(
    `INSERT INTO work_items (item_id, project_id, item_key, type, parent_id, title, description, state, priority, rank, version, created_by_principal_id, created_at, updated_at)
     SELECT ?, project_id, ?, 'feature', ?, ?, NULL, state, priority, ?, 1, created_by_principal_id, created_at, updated_at FROM work_items WHERE item_id = ?`,
  );
  database.transaction(() => {
    for (let index = 0; index < 10_001; index += 1) insert.run(randomUUID(), `SL-BULK-${index}`, epic.id, `Item ${index}`, 100_000 + index, epic.id);
  })();
  let providerCalls = 0;
  const provider: TextEmbeddingProvider = {
    modelKey: createHash("sha256").update("never-called").digest("hex"),
    modelName: "never-called",
    embed: async () => { providerCalls += 1; return []; },
  };
  await assert.rejects(
    () => searchWorkItemsSemantically(database, provider, { projectId, principalId, query: "qualquer consulta" }),
    (error: unknown) => error instanceof ApplicationError && error.code === "SEMANTIC_SEARCH_PROJECT_TOO_LARGE",
  );
  assert.equal(providerCalls, 0, "the bound must be enforced before spending a network call");
});

function hashedVector(text: string): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length === 0) continue;
    const digest = createHash("sha256").update(token).digest();
    for (let index = 0; index < 8; index += 1) {
      const slot = digest.readUInt16BE(index * 2) % dimensions;
      vector[slot] = vector[slot]! + (digest[16 + index]! % 2 === 0 ? 1 : -1);
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

async function countQueries(database: SqliteDatabase, action: () => Promise<void>): Promise<number> {
  const holder = database as unknown as { prepare: (sql: string) => unknown };
  const original = holder.prepare.bind(database);
  let count = 0;
  holder.prepare = (sql: string) => { count += 1; return original(sql); };
  try { await action(); } finally { holder.prepare = original; }
  return count;
}

function percentiles(values: readonly number[]): { p50: number; p95: number } {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
  return { p50: round(at(0.5)), p95: round(at(0.95)) };
}

function round(value: number): number { return Math.round(value * 100) / 100; }
