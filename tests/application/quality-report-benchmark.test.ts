import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { getWorkItemQualityReport } from "../../src/application/quality-queries.js";
import {
  createScenario, proposeScenarioRevision, publishScenarioRevision, recordTestRun,
} from "../../src/application/scenario-commands.js";
import { searchScenariosByCriteria, searchScenariosByCriterion } from "../../src/application/scenario-queries.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

const criterionCount = 50;
const scenarioCount = 20;
const builds = ["build-a", "build-b", "build-c"] as const;

describe("quality report fixture and query batching (SSDD-905)", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let storyId: string;
  let criterionIds: string[];

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-quality-bench-"));
    const initialized = initializeProject({
      workspace, key: "QB", name: "Quality bench", productGoal: "Medir relatório", timezone: "America/Sao_Paulo",
    });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
      .get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    const epic = createWorkItem(database, {
      projectId, principalId, requestId: "qb-epic", type: "epic", title: "Épico",
    }).value;
    const feature = createWorkItem(database, {
      projectId, principalId, requestId: "qb-feature", type: "feature", parentId: epic.id, title: "Feature",
    }).value;
    const story = createWorkItem(database, {
      projectId, principalId, requestId: "qb-story", type: "story", parentId: feature.id, title: "História grande",
      criteria: Array.from({ length: criterionCount }, (_, index) => ({ description: `Critério ${index + 1}` })),
    }).value;
    storyId = story.id;
    criterionIds = story.criteria.map((criterion) => criterion.id);
    for (let index = 0; index < scenarioCount; index += 1) {
      const key = `QB-TC-${index + 1}`;
      // Each scenario covers 5 criteria; criteria 45-49 stay uncovered by scenarios 0-8 only partially.
      const covered = Array.from({ length: 5 }, (_, offset) => criterionIds[(index * 2 + offset) % (criterionCount - 5)]!);
      const created = createScenario(database, {
        projectId, principalId, requestId: `qb-sc-${index}`, key, kind: "acceptance", title: `Cenário ${index + 1}`,
        steps: [{ action: "Executar", expected: "Resultado esperado" }],
        coverage: covered.map((reference) => ({ targetType: "criterion" as const, reference })),
      }).value;
      publishScenarioRevision(database, {
        projectId, principalId, requestId: `qb-pub-${index}`, scenarioIdOrKey: created.scenarioId,
        revisionNumber: 1, expectedVersion: 1,
      });
      if (index % 4 === 0) {
        const version = (database.prepare("SELECT version FROM scenarios WHERE scenario_id = ?")
          .get(created.scenarioId) as { version: number }).version;
        const revised = proposeScenarioRevision(database, {
          projectId, principalId, requestId: `qb-rev-${index}`, scenarioIdOrKey: created.scenarioId,
          expectedVersion: version, title: `Cenário ${index + 1} v2`,
          steps: [{ action: "Executar v2", expected: "Resultado esperado v2" }],
          coverage: covered.slice(0, 3).map((reference) => ({ targetType: "criterion" as const, reference })),
        }).value;
        const next = (database.prepare("SELECT version FROM scenarios WHERE scenario_id = ?")
          .get(created.scenarioId) as { version: number }).version;
        publishScenarioRevision(database, {
          projectId, principalId, requestId: `qb-pub2-${index}`, scenarioIdOrKey: created.scenarioId,
          revisionNumber: revised.revisionNumber, expectedVersion: next,
        });
      }
      for (const [buildIndex, buildId] of builds.entries()) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          recordTestRun(database, {
            projectId, principalId, requestId: `qb-run-${index}-${buildIndex}-${attempt}`,
            scenarioIdOrKey: created.scenarioId, revisionNumber: 1, buildId,
            result: attempt === 0 ? "failed" : "passed",
          });
        }
      }
    }
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("batch search returns exactly what the per-criterion search returns", () => {
    const batch = searchScenariosByCriteria(database, projectId, principalId, criterionIds);
    assert.equal(batch.size, criterionCount);
    let withMatches = 0;
    for (const criterionId of criterionIds) {
      const single = searchScenariosByCriterion(database, projectId, principalId, criterionId);
      assert.deepEqual(batch.get(criterionId), single, `criterion ${criterionId}`);
      if (single.length > 0) withMatches += 1;
    }
    assert.ok(withMatches >= 40, "fixture must cover most criteria");
    assert.ok(withMatches < criterionCount, "fixture must keep uncovered criteria");
    const superseded = [...batch.values()].flat().filter((match) => match.revision.status === "superseded");
    assert.ok(superseded.length > 0, "fixture must include superseded revisions");
    const withRuns = [...batch.values()].flat().filter((match) => match.resultsByBuild.length === builds.length);
    assert.ok(withRuns.length > 0);
    assert.ok(withRuns.every((match) => match.resultsByBuild.every((run) => run.result === "passed")));
    assert.deepEqual(searchScenariosByCriteria(database, projectId, principalId, []), new Map());
  });

  it("measures the quality report: fewer queries and p50/p95 latency for the batched path", () => {
    const report = getWorkItemQualityReport(database, { projectId, principalId, itemIdOrKey: storyId });
    assert.equal(report.criteria.length, criterionCount);
    assert.equal(report.mode, "preview");

    const sequentialQueries = countQueries(database, () => {
      for (const criterionId of criterionIds) searchScenariosByCriterion(database, projectId, principalId, criterionId);
    });
    const batchedQueries = countQueries(database, () => {
      searchScenariosByCriteria(database, projectId, principalId, criterionIds);
    });
    const reportQueries = countQueries(database, () => {
      getWorkItemQualityReport(database, { projectId, principalId, itemIdOrKey: storyId });
    });
    assert.ok(batchedQueries <= 3, `batched search used ${batchedQueries} queries`);
    assert.ok(sequentialQueries >= criterionCount * 2, `sequential search used ${sequentialQueries} queries`);
    assert.ok(reportQueries < sequentialQueries / 2, `report used ${reportQueries} vs ${sequentialQueries}`);

    const sequential = sample(() => {
      for (const criterionId of criterionIds) searchScenariosByCriterion(database, projectId, principalId, criterionId);
    });
    const batched = sample(() => {
      searchScenariosByCriteria(database, projectId, principalId, criterionIds);
    });
    console.log(JSON.stringify({
      benchmark: "quality-report-criteria-search",
      criteria: criterionCount, scenarios: scenarioCount, builds: builds.length,
      queries: { sequential: sequentialQueries, batched: batchedQueries, report: reportQueries },
      sequentialMs: sequential, batchedMs: batched,
    }));
  });
});

function countQueries(database: SqliteDatabase, action: () => void): number {
  const holder = database as unknown as { prepare: (sql: string) => unknown };
  const original = holder.prepare.bind(database);
  let count = 0;
  holder.prepare = (sql: string) => {
    count += 1;
    return original(sql);
  };
  try {
    action();
  } finally {
    holder.prepare = original;
  }
  return count;
}

function sample(action: () => void): { p50: number; p95: number } {
  const durations: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const start = performance.now();
    action();
    durations.push(performance.now() - start);
  }
  durations.sort((left, right) => left - right);
  const at = (fraction: number) => durations[Math.min(durations.length - 1, Math.ceil(durations.length * fraction) - 1)]!;
  return { p50: Math.round(at(0.5) * 100) / 100, p95: Math.round(at(0.95) * 100) / 100 };
}
