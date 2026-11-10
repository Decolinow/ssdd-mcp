import { randomUUID } from "node:crypto";
import * as console from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL } from "node:url";
import { createScenario, publishScenarioRevision } from "../dist/src/application/scenario-commands.js";
import { setDefinitionOfDone } from "../dist/src/application/definition-of-done.js";
import { getProjectDashboardMetrics } from "../dist/src/application/dashboard-metrics.js";
import { initializeProject } from "../dist/src/application/initialize-project.js";
import { createWorkItem } from "../dist/src/application/create-work-item.js";
import { createMilestone } from "../dist/src/application/milestones.js";
import { createSprintDraft } from "../dist/src/application/sprint-commands.js";
import { setTeamCapacityConfiguration } from "../dist/src/application/team-capacity.js";
import { confirmWorkItemEstimate, proposeWorkItemEstimate } from "../dist/src/application/work-item-commands.js";
import { getWorkItem } from "../dist/src/application/work-item-queries.js";
import { transitionWorkItem } from "../dist/src/application/work-item-workflow.js";
import { createMcpHttpServer, listenMcpHttpServer } from "../dist/src/mcp/http-server.js";
import { openSqliteDatabase } from "../dist/src/storage-sqlite/database.js";

const workItemCount = 10_000;
const auditEventCount = 50_000;
const syntheticStoryCount = workItemCount - 1;
const sampleCount = 12;
const concurrentClientCount = 5;
const concurrentRoundCount = 20;
const workspace = mkdtempSync(join(tmpdir(), "ssdd-metrics-scale-"));
const resources = { database: undefined, httpHandle: undefined };
const clients = [];

try {
  const initialized = initializeProject({
    workspace,
    key: "SCALE",
    name: "Metrics scale fixture",
    productGoal: "Measure dashboard metrics reconstruction",
    timezone: "America/Sao_Paulo",
  });
  const database = openSqliteDatabase(initialized.databasePath);
  resources.database = database;
  const principalId = database.prepare(
    "SELECT created_by_principal_id FROM projects WHERE project_id = ?",
  ).get(initialized.project.id).created_by_principal_id;
  const epic = createWorkItem(database, {
    projectId: initialized.project.id,
    principalId,
    requestId: "scale-epic",
    type: "epic",
    title: "Scale fixture",
  }).value;
  const feature = createWorkItem(database, {
    projectId: initialized.project.id,
    principalId,
    requestId: "scale-feature",
    type: "feature",
    parentId: epic.id,
    title: "Metric reconstruction workload",
  }).value;
  const capacity = setTeamCapacityConfiguration(database, {
    projectId: initialized.project.id,
    principalId,
    requestId: "scale-capacity",
    expectedVersion: 0,
    teamName: "Scale fixture team",
    timezone: "America/Sao_Paulo",
    hoursPerDay: 6,
    workingDays: [1, 2, 3, 4, 5],
    members: [{ principalId, dedicationPercent: 100 }],
    reason: "Enable sprint and forecast metric reconstruction.",
  }).value;
  const definition = setDefinitionOfDone(database, {
    projectId: initialized.project.id,
    principalId,
    requestId: "scale-dod",
    expectedVersion: 0,
    criteria: [{ description: "Scale fixture work is validated." }],
    reason: "Create an initial Definition of Done for the scale fixture.",
  }).value;
  const targetPbi = createWorkItem(database, {
    projectId: initialized.project.id,
    principalId,
    requestId: "scale-target-pbi",
    type: "story",
    parentId: feature.id,
    title: "PBI included in metric scope",
    criteria: [{ description: "Metrics include a real approved PBI." }],
  }).value;
  const scenario = createScenario(database, {
    projectId: initialized.project.id,
    principalId,
    requestId: "scale-scenario",
    key: "SCALE-TC-1",
    kind: "acceptance",
    title: "Validate scoped PBI",
    steps: [{ action: "Read project metrics", expected: "The approved PBI appears in burnup." }],
    coverage: [{ targetType: "criterion", reference: targetPbi.criteria[0].id }],
  }).value;
  publishScenarioRevision(database, {
    projectId: initialized.project.id,
    principalId,
    requestId: "scale-scenario-publish",
    scenarioIdOrKey: scenario.scenarioId,
    revisionNumber: 1,
    expectedVersion: 1,
  });
  const estimate = proposeWorkItemEstimate(database, {
    projectId: initialized.project.id,
    principalId,
    requestId: "scale-estimate",
    itemIdOrKey: targetPbi.id,
    unit: "points",
    value: 100,
    rationale: "Estimate the PBI used by the scope fixture.",
    expectedVersion: targetPbi.version,
  }).value;
  const targetAfterProposal = getWorkItem(database, initialized.project.id, principalId, targetPbi.id);
  confirmWorkItemEstimate(database, {
    projectId: initialized.project.id,
    principalId,
    requestId: "scale-estimate-confirm",
    itemIdOrKey: targetPbi.id,
    proposalId: estimate.id,
    expectedVersion: targetAfterProposal.version,
  });
  const targetAfterEstimate = getWorkItem(database, initialized.project.id, principalId, targetPbi.id);
  transitionWorkItem(database, {
    projectId: initialized.project.id,
    principalId,
    requestId: "scale-ready",
    itemIdOrKey: targetPbi.id,
    targetState: "ready",
    expectedVersion: targetAfterEstimate.version,
    reason: "Approve the PBI for the scale fixture.",
  });
  const today = projectToday();
  const milestone = createMilestone(database, {
    projectId: initialized.project.id,
    principalId,
    requestId: "scale-milestone",
    milestoneKey: "SCALE-M1",
    title: "Metric scale milestone",
    goal: "Exercise burnup and forecast during reconstruction.",
    targetDate: addDays(today, 90),
    itemIdsOrKeys: [targetPbi.id],
    reason: "Approve one real item for the scale fixture.",
  }).value;
  const sprint = createSprintDraft(database, {
    projectId: initialized.project.id,
    principalId,
    requestId: "scale-sprint",
    sprintKey: "SCALE-S1",
    title: "Metrics scale sprint",
    goal: "Exercise sprint burndown reconstruction.",
    startsOn: today,
    endsOn: addDays(today, 9),
    itemIdsOrKeys: [targetPbi.id],
    capacityConfigVersion: capacity.version,
    definitionOfDoneRevision: definition.revisionNumber,
    reason: "Add the approved PBI to the scale fixture.",
  }).value;

  const createdAt = new Date().toISOString();
  const insertClosedSprint = database.prepare(
    `INSERT INTO sprints
      (sprint_id, project_id, sprint_key, title, goal, starts_on, ends_on, status, team_id,
       capacity_config_version, dod_revision_number, version, created_by_principal_id,
       created_at, started_at, closed_at, reason, review_summary, started_snapshot_json, closed_snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, 3, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let index = 1; index <= 3; index += 1) {
    const closedAt = new Date(Date.now() - (4 - index) * 60_000).toISOString();
    insertClosedSprint.run(
      randomUUID(), initialized.project.id, `SCALE-H${index}`, `Historical SCALE-H${index}`,
      "Closed sprint sample for Monte Carlo performance measurement",
      addDays(today, -20 - index * 10), addDays(today, -15 - index * 10), capacity.teamId,
      capacity.version, definition.revisionNumber, principalId, closedAt, closedAt, closedAt,
      "Benchmark seed", "Synthetic accepted point total",
      JSON.stringify({ capacity: { totalHours: 48 }, commitments: [] }),
      JSON.stringify({ acceptedItems: [{ itemId: randomUUID(), points: index * 5 + 5 }] }),
    );
  }
  const insertWorkItem = database.prepare(
    `INSERT INTO work_items
      (item_id, project_id, item_key, type, parent_id, title, state, priority, version,
       created_by_principal_id, created_at, updated_at)
     VALUES (?, ?, ?, 'story', ?, ?, ?, 2, 1, ?, ?, ?)`,
  );
  const insertAuditEvent = database.prepare(
    `INSERT INTO audit_events
      (event_id, project_id, principal_id, event_type, entity_type, entity_id,
       correlation_id, occurred_at, payload_json)
     VALUES (?, ?, ?, 'benchmark.noise', 'benchmark', ?, ?, ?, '{}')`,
  );
  const buildFixture = database.transaction(() => {
    for (let index = 1; index <= syntheticStoryCount; index += 1) {
      const key = `SCALE-${String(index).padStart(5, "0")}`;
      insertWorkItem.run(randomUUID(), initialized.project.id, key, feature.id, `Scale item ${index}`,
        index === 1 ? "ready" : "in_progress", principalId, createdAt, createdAt);
    }
    for (let index = 1; index <= auditEventCount; index += 1) {
      insertAuditEvent.run(`benchmark-event-${index}`, initialized.project.id, principalId,
        initialized.project.id, initialized.project.id, createdAt);
    }
  });
  buildFixture();

  const readMetrics = () => getProjectDashboardMetrics(database, {
    projectId: initialized.project.id,
    principalId,
    milestoneId: milestone.id,
    sprintId: sprint.id,
  });
  const addMetricInvalidationEvent = (index) => database.prepare(
    `INSERT INTO audit_events (
       event_id, project_id, principal_id, event_type, entity_type, entity_id,
       correlation_id, reason, event_schema_version, occurred_at, payload_json
     ) VALUES (?, ?, ?, 'benchmark.metrics_cache_invalidation', 'benchmark', ?, ?, NULL, 1, ?, '{}')`,
  ).run(randomUUID(), initialized.project.id, principalId, randomUUID(), `benchmark-${index}`, new Date().toISOString());
  readMetrics();
  const durationsMs = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    addMetricInvalidationEvent(sample);
    const start = performance.now();
    const result = readMetrics();
    durationsMs.push(performance.now() - start);
    if (result.coverage.itemsTotal !== workItemCount || result.coverage.items.length !== 20 ||
        result.coverage.itemsTruncated !== true || result.wip.totalWipCount !== workItemCount ||
        result.milestoneMetrics?.items.length !== 1 || result.sprintMetrics?.items.length !== 1 ||
        result.forecast?.status !== "forecast_ready" || result.forecast.sample.length !== 3 ||
        result.forecast.simulationCount !== 10_000) {
      throw new Error(`Scale fixture did not exercise the expected projection: ${JSON.stringify({
        coverageItemsTotal: result.coverage.itemsTotal,
        wipTotal: result.wip.totalWipCount,
        milestoneItems: result.milestoneMetrics?.items.length,
        sprintItems: result.sprintMetrics?.items.length,
        forecastStatus: result.forecast?.status,
        forecastSampleCount: result.forecast?.sample.length,
      })}`);
    }
  }
  durationsMs.sort((left, right) => left - right);
  const p95Index = Math.min(durationsMs.length - 1, Math.ceil(durationsMs.length * 0.95) - 1);

  const httpHandle = createMcpHttpServer(workspace);
  resources.httpHandle = httpHandle;
  await httpHandle.ready;
  const httpAddress = await listenMcpHttpServer(httpHandle, 0);
  for (let index = 0; index < concurrentClientCount; index += 1) {
    const client = new Client({ name: `ssdd-metrics-load-${index + 1}`, version: "0.1.0" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${httpAddress.origin}/mcp`)));
  }

  const metricsArguments = {
    projectId: initialized.project.id,
    milestoneId: milestone.id,
    sprintId: sprint.id,
  };
  addMetricInvalidationEvent("concurrent-cold");
  const coldConcurrentReadLatenciesMs = await Promise.all(clients.map(async (client) => {
    const startedAt = performance.now();
    const result = await client.callTool({ name: "metrics_get", arguments: metricsArguments });
    if (result.isError === true) throw new Error("A cold concurrent metrics request failed.");
    return performance.now() - startedAt;
  }));
  const concurrentReadLatenciesMs = [];
  for (let round = 0; round < concurrentRoundCount; round += 1) {
    const latencies = await Promise.all(clients.map(async (client) => {
      const startedAt = performance.now();
      const result = await client.callTool({ name: "metrics_get", arguments: metricsArguments });
      if (result.isError === true) throw new Error("A concurrent metrics request failed.");
      return performance.now() - startedAt;
    }));
    concurrentReadLatenciesMs.push(...latencies);
  }

  const concurrentWriteLatenciesMs = [];
  for (let round = 0; round < concurrentRoundCount; round += 1) {
    const latencies = await Promise.all(clients.map(async (client, clientIndex) => {
      const startedAt = performance.now();
      const result = await client.callTool({
        name: "work_item_create",
        arguments: {
          projectId: initialized.project.id,
          requestId: `concurrent-write-${round}-${clientIndex}`,
          type: "epic",
          title: `Concurrent write ${round + 1}-${clientIndex + 1}`,
        },
      });
      if (result.isError === true) throw new Error("A concurrent work item creation failed.");
      return performance.now() - startedAt;
    }));
    concurrentWriteLatenciesMs.push(...latencies);
  }

  const concurrentReadSummary = summarize(concurrentReadLatenciesMs);
  const coldConcurrentReadSummary = summarize(coldConcurrentReadLatenciesMs);
  const concurrentWriteSummary = summarize(concurrentWriteLatenciesMs);
  const withinTarget = coldConcurrentReadSummary.p95 <= 300 && concurrentReadSummary.p95 <= 300 &&
    concurrentWriteSummary.p95 <= 500;
  console.log(JSON.stringify({
    host: {
      node: process.version,
      platform: platform(),
      release: release(),
      architecture: arch(),
      cpuModel: cpus()[0]?.model ?? "unknown",
      logicalCores: cpus().length,
    },
    fixture: {
      workItems: workItemCount,
      syntheticAuditEvents: auditEventCount,
      totalAuditEvents: database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE project_id = ?")
        .get(initialized.project.id).count,
    },
    samples: sampleCount,
    reconstructionMs: {
      min: round(durationsMs[0]),
      median: round(durationsMs[Math.floor(durationsMs.length / 2)]),
      p95: round(durationsMs[p95Index]),
      max: round(durationsMs.at(-1)),
    },
    concurrentMcp: {
      clients: concurrentClientCount,
      roundsPerOperation: concurrentRoundCount,
      coldReadWave: {
        measuredReads: coldConcurrentReadLatenciesMs.length,
        metricsReadMs: coldConcurrentReadSummary,
      },
      measuredReads: concurrentReadLatenciesMs.length,
      metricsReadMs: concurrentReadSummary,
      measuredWrites: concurrentWriteLatenciesMs.length,
      workItemWriteMs: concurrentWriteSummary,
      targetMs: { readP95: 300, writeP95: 500 },
      withinTarget,
    },
    responseShape: {
      coverageItemsTotal: workItemCount,
      coverageItemsReturned: 20,
      coverageItemsTruncated: true,
      milestoneItems: 1,
      sprintItems: 1,
      forecastStatus: "forecast_ready",
      forecastSampleCount: 3,
      forecastSimulationCount: 10_000,
      wipItems: 200,
      wipTruncated: true,
    },
  }, null, 2));
  if (!withinTarget) {
    throw new Error("Metrics p95 exceeded the 300 ms read or 500 ms write target.");
  }
} finally {
  await Promise.all(clients.map(async (client) => client.close().catch(() => undefined)));
  await resources.httpHandle?.close();
  resources.database?.close();
  rmSync(workspace, { recursive: true, force: true });
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function summarize(durations) {
  const sorted = [...durations].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    min: round(sorted[0]),
    median: round(percentile(0.5)),
    p95: round(percentile(0.95)),
    max: round(sorted.at(-1)),
  };
}

function projectToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}-${parts.find((part) => part.type === "day").value}`;
}

function addDays(date, amount) {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + amount);
  return result.toISOString().slice(0, 10);
}
