import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

interface Run { result: string; scenarioKey: string; buildId: string; executedAt: string; workItemKeys: string[] }
interface QaRuns {
  filterRuns(runs: Run[], filters?: Record<string, string>): Run[];
  aggregateRuns(runs: Run[]): { counts: Record<string, number>; other: number; total: number };
  aggregateCoverage(items: { coveragePercent: number | null; baselineSequence: number | null }[]): Record<string, number>;
}

test("QA chart aggregation reconciles with filtered runs and coverage buckets (SSDD-95)", async () => {
  const qa = await import(pathToFileURL(resolve(process.cwd(), "src/dashboard/public/js/qa-runs.js")).href) as QaRuns;
  const run = (result: string, scenarioKey: string, buildId: string, executedAt: string, workItemKeys: string[] = []): Run => ({ result, scenarioKey, buildId, executedAt, workItemKeys });
  const runs = [
    run("passed", "SCN-1", "build-1", "2026-11-10T10:00:00.000Z", ["SSDD-95"]),
    run("failed", "SCN-1", "build-2", "2026-11-11T23:59:00.000Z"),
    run("blocked", "SCN-2", "build-2", "2026-11-12T08:00:00.000Z", ["SSDD-99"]),
    run("skipped", "SCN-2", "build-3", "2026-11-13T08:00:00.000Z"),
  ];
  const all = qa.aggregateRuns(runs);
  assert.deepEqual(all.counts, { passed: 1, failed: 1, blocked: 1, skipped: 1 });
  assert.equal(Object.values(all.counts).reduce((a, b) => a + b, 0) + all.other, all.total);
  for (const filters of [{ build: "BUILD-2" }, { scenario: "SCN-2" }, { item: "ssdd-95" }, { from: "2026-11-11", to: "2026-11-12" }, { result: "passed" }, {}]) {
    const filtered = qa.filterRuns(runs, filters);
    const aggregated = qa.aggregateRuns(filtered);
    assert.equal(aggregated.total, filtered.length);
    assert.equal(Object.values(aggregated.counts).reduce((a, b) => a + b, 0) + aggregated.other, filtered.length);
  }
  assert.equal(qa.filterRuns(runs, { build: "build-2" }).length, 2);
  assert.equal(qa.filterRuns(runs, { from: "2026-11-11", to: "2026-11-11" }).length, 1, "period end is inclusive of the whole day");
  assert.equal(qa.filterRuns(runs, { build: "nenhum" }).length, 0);
  assert.deepEqual(qa.aggregateCoverage([
    { coveragePercent: 100, baselineSequence: 1 }, { coveragePercent: 50, baselineSequence: null }, { coveragePercent: null, baselineSequence: null },
  ]), { covered: 1, uncovered: 1, noCriteria: 1, withoutBaseline: 2, total: 3 });
});
