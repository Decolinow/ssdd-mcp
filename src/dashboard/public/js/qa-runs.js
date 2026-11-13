// Pure helpers for the QA results chart (SSDD-95): no DOM access, so they are unit-testable in Node.
export const qaResultOrder = ["passed", "failed", "blocked", "skipped"];
export const qaResultLabels = { passed: "Aprovado", failed: "Reprovado", blocked: "Bloqueado", skipped: "Ignorado" };

/** Filters runs by build, scenario, item key, period (inclusive ISO dates yyyy-mm-dd) and optionally one result. */
export function filterRuns(runs, filters = {}) {
  const build = (filters.build ?? "").trim().toLowerCase();
  const scenario = filters.scenario ?? "";
  const item = (filters.item ?? "").trim().toLowerCase();
  const from = filters.from ? Date.parse(`${filters.from}T00:00:00.000Z`) : null;
  const to = filters.to ? Date.parse(`${filters.to}T23:59:59.999Z`) : null;
  return runs.filter((run) => {
    if (build && !String(run.buildId).toLowerCase().includes(build)) return false;
    if (scenario && run.scenarioKey !== scenario) return false;
    if (item && !(run.workItemKeys ?? []).some((key) => key.toLowerCase().includes(item))) return false;
    const executed = Date.parse(run.executedAt);
    if (from !== null && executed < from) return false;
    if (to !== null && executed > to) return false;
    if (filters.result && run.result !== filters.result) return false;
    return true;
  });
}

/** Counts per result; the sum always equals runs.length (unknown results are folded into skipped-free `other`). */
export function aggregateRuns(runs) {
  const counts = Object.fromEntries(qaResultOrder.map((result) => [result, 0]));
  let other = 0;
  for (const run of runs) {
    if (run.result in counts) counts[run.result] += 1;
    else other += 1;
  }
  return { counts, other, total: runs.length };
}

/** Coverage counts from quality summaries: covered, uncovered, no required criteria, and preview-only (no baseline). */
export function aggregateCoverage(summaries) {
  const result = { covered: 0, uncovered: 0, noCriteria: 0, withoutBaseline: 0, total: summaries.length };
  for (const item of summaries) {
    if (item.coveragePercent === null) result.noCriteria += 1;
    else if (item.coveragePercent === 100) result.covered += 1;
    else result.uncovered += 1;
    if (item.baselineSequence === null) result.withoutBaseline += 1;
  }
  return result;
}

export const coverageBuckets = {
  covered: "Cobertos (100% dos critérios obrigatórios)",
  uncovered: "Com critérios descobertos",
  noCriteria: "Sem critério obrigatório",
  withoutBaseline: "Sem baseline (apenas preview)",
};

/** True when the quality summary belongs to the coverage bucket (withoutBaseline overlaps the other three). */
export function inCoverageBucket(item, bucket) {
  if (!bucket) return true;
  if (bucket === "withoutBaseline") return item.baselineSequence === null;
  if (bucket === "noCriteria") return item.coveragePercent === null;
  if (bucket === "covered") return item.coveragePercent === 100;
  if (bucket === "uncovered") return item.coveragePercent !== null && item.coveragePercent < 100;
  return false;
}
