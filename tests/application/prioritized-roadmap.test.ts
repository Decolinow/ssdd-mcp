import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { setDefinitionOfDone } from "../../src/application/definition-of-done.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { getProjectFeatureRoadmap, getTaskExecutionQueue } from "../../src/application/prioritized-roadmap.js";
import { setTeamCapacityConfiguration } from "../../src/application/team-capacity.js";
import { confirmWorkItemEstimate, proposeWorkItemEstimate } from "../../src/application/work-item-commands.js";
import { getWorkItem } from "../../src/application/work-item-queries.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";

describe("business value, prioritized execution and project feature roadmap", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-prioritized-roadmap-"));
    const initialized = initializeProject({
      workspace,
      key: "PAY",
      name: "Payments",
      productGoal: "Pagamentos confiáveis",
      timezone: "America/Sao_Paulo",
    });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
      .get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("orders startable assigned tasks by inherited priority, then business value, then stable rank", () => {
    const lowPriority = createQueueTask("Normal value", 2, 3, 92);
    const lowerValue = createQueueTask("P1 lower value", 1, 3, 40);
    const higherValue = createQueueTask("P1 higher value", 1, 4, 81);
    const queue = getTaskExecutionQueue(database, { projectId, principalId });

    assert.deepEqual(queue.tasks.map((task) => task.key), [higherValue.task.key, lowerValue.task.key, lowPriority.task.key]);
    assert.equal(queue.tasks[0]?.priority, 1);
    assert.equal(queue.tasks[0]?.prioritySource, higherValue.epic.key);
    assert.equal(queue.tasks[0]?.businessValueScore, 81);
    assert.equal(queue.tasks[0]?.businessValueSource, higherValue.feature.key);
    assert.equal(queue.blockedCount, 0);
    assert.equal(queue.assignedToMe, true);
  });

  it("explains an empty queue and lists the next not-ready tasks with what is missing", () => {
    const epic = createWorkItem(database, { projectId, principalId, requestId: randomUUID(), type: "epic", title: "Epic", priority: 2 }).value;
    const feature = createWorkItem(database, { projectId, principalId, requestId: randomUUID(), type: "feature", title: "Feature", parentId: epic.id, priority: 2 }).value;
    const story = createWorkItem(database, { projectId, principalId, requestId: randomUUID(), type: "story", title: "Story", parentId: feature.id, priority: 2 }).value;
    const first = createWorkItem(database, { projectId, principalId, requestId: randomUUID(), type: "task", title: "First", parentId: story.id }).value;
    const second = createWorkItem(database, { projectId, principalId, requestId: randomUUID(), type: "task", title: "Second", parentId: story.id }).value;
    database.prepare(
      `INSERT INTO trace_links (link_id, project_id, source_id, target_id, link_type, created_by_principal_id, created_at)
       VALUES (?, ?, ?, ?, 'depends_on', ?, ?)`,
    ).run(randomUUID(), projectId, first.id, second.id, principalId, new Date().toISOString());

    const queue = getTaskExecutionQueue(database, { projectId, principalId });

    assert.equal(queue.tasks.length, 0);
    assert.equal(queue.emptyReason, "no_ready_tasks");
    assert.deepEqual(queue.upNext.map((task) => task.key), [second.key, first.key]);
    assert.deepEqual(queue.upNext[1]?.unmetDependencies, [second.key]);
    assert.ok(queue.upNext[0]?.missing.includes("estimate"));
    assert.ok(queue.upNext[1]?.missing.includes("dependencies"));
    assert.match(queue.upNext[1]?.nextAction ?? "", /Concluir antes/);
    assert.equal(queue.awaitingAcceptanceCount, 0);
  });

  it("keeps tasks delivered locally out of upNext and lists them as awaiting acceptance", () => {
    const epic = createWorkItem(database, { projectId, principalId, requestId: randomUUID(), type: "epic", title: "Epic" }).value;
    const feature = createWorkItem(database, { projectId, principalId, requestId: randomUUID(), type: "feature", title: "Feature", parentId: epic.id }).value;
    const story = createWorkItem(database, { projectId, principalId, requestId: randomUUID(), type: "story", title: "Story", parentId: feature.id }).value;
    const delivered = createWorkItem(database, {
      projectId, principalId, requestId: randomUUID(), type: "task", title: "Delivered", parentId: story.id,
      description: "[roadmap:X] Registro factual em docs/status.md (2026-11-12): Concluído localmente: testes passam.",
    }).value;
    const pending = createWorkItem(database, {
      projectId, principalId, requestId: randomUUID(), type: "task", title: "Pending", parentId: story.id,
      description: "Registro factual em docs/status.md (2026-11-12): Sem registro individual em docs/status.md",
    }).value;

    const queue = getTaskExecutionQueue(database, { projectId, principalId });

    assert.deepEqual(queue.upNext.map((task) => task.key), [pending.key]);
    assert.equal(queue.awaitingAcceptanceCount, 1);
    assert.deepEqual(queue.awaitingAcceptance, [delivered.key]);
  });

  it("reports the story as the priority source when it raises a task above its Feature", () => {
    const urgent = createQueueTask("P1 from story", 3, 3, 50, 1);
    const queue = getTaskExecutionQueue(database, { projectId, principalId });

    assert.equal(queue.tasks[0]?.key, urgent.task.key);
    assert.equal(queue.tasks[0]?.priority, 1);
    assert.equal(queue.tasks[0]?.prioritySource, urgent.story.key);
  });

  it("orders features by priority and value but withholds date forecasts when no team is selected", () => {
    const epic = createWorkItem(database, {
      projectId, principalId, requestId: randomUUID(), type: "epic", title: "Payments",
      priority: 2, businessValueScore: 70, businessValueRationale: "Protects core payment reliability.",
    }).value;
    const later = createWorkItem(database, {
      projectId, principalId, requestId: randomUUID(), type: "feature", title: "Later feature", parentId: epic.id,
      priority: 3, businessValueScore: 60, businessValueRationale: "Improves support efficiency.",
    }).value;
    const first = createWorkItem(database, {
      projectId, principalId, requestId: randomUUID(), type: "feature", title: "First feature", parentId: epic.id,
      priority: 1, businessValueScore: 85, businessValueRationale: "Prevents failed customer payments.",
    }).value;
    createWorkItem(database, {
      projectId, principalId, requestId: randomUUID(), type: "story", title: "Unestimated story", parentId: first.id,
    });

    const roadmap = getProjectFeatureRoadmap(database, { projectId, principalId });

    assert.deepEqual(roadmap.features.map((feature) => feature.key), [first.key, later.key]);
    assert.equal(roadmap.features[0]?.effectivePriority, 1);
    assert.equal(roadmap.features[0]?.businessValueScore, 85);
    assert.equal(roadmap.features[0]?.unestimatedItemCount, 1);
    assert.equal(roadmap.forecastUnavailableReason, "team_required");
    assert.equal(roadmap.velocitySampleSize, 0);
    assert.equal(roadmap.sprintTimeline.length, 0);
    assert.equal(roadmap.features[0]?.forecast.baseDate, null);
  });

  it("does not report a Feature without work items as completed", () => {
    const epic = createWorkItem(database, {
      projectId, principalId, requestId: randomUUID(), type: "epic", title: "Empty epic",
    }).value;
    const feature = createWorkItem(database, {
      projectId, principalId, requestId: randomUUID(), type: "feature", title: "Empty Feature", parentId: epic.id,
    }).value;

    const roadmap = getProjectFeatureRoadmap(database, { projectId, principalId });

    assert.equal(roadmap.features.find((item) => item.key === feature.key)?.forecast.status, "incomplete_scope");
    assert.equal(roadmap.features.find((item) => item.key === feature.key)?.totalItems, 0);
  });

  it("starts unplanned roadmap windows after the cutoff instead of after the last historical sprint", () => {
    const today = projectToday();
    configureTeam();
    const { feature } = createEstimatedFeature("Remaining feature", 20);
    seedClosedSprint(today, "PAY-H1", 10, 1);
    seedClosedSprint(today, "PAY-H2", 15, 2);
    seedClosedSprint(today, "PAY-H3", 20, 3);

    const roadmap = getProjectFeatureRoadmap(database, { projectId, principalId, asOfDate: today });

    assert.equal(roadmap.velocitySampleSize, 3);
    const featureForecast = roadmap.features.find((item) => item.key === feature.key)?.forecast;
    assert.equal(featureForecast?.status, "forecast_ready");
    assert.ok(roadmap.sprintTimeline.length > 0);
    assert.ok(roadmap.sprintTimeline.every((sprint) => sprint.startsOn > today));
    assert.equal(roadmap.sprintTimeline[0]?.startsOn, addDays(today, 1));
    assert.ok((featureForecast?.favorableDate ?? "") > today);
  });

  it("starts unplanned roadmap windows after the active sprint ends", () => {
    const today = projectToday();
    configureTeam();
    const activeEnd = addDays(today, 6);
    const { feature } = createEstimatedFeature("Active sprint feature", 20);
    seedClosedSprint(today, "PAY-H1", 10, 1);
    seedClosedSprint(today, "PAY-H2", 15, 2);
    seedClosedSprint(today, "PAY-H3", 20, 3);
    seedActiveSprint(today, activeEnd);

    const roadmap = getProjectFeatureRoadmap(database, { projectId, principalId, asOfDate: today });

    assert.equal(roadmap.velocitySampleSize, 3);
    assert.equal(roadmap.sprintTimeline[0]?.startsOn, addDays(activeEnd, 1));
    assert.ok(roadmap.sprintTimeline.every((sprint) => sprint.startsOn > today));
    assert.equal(roadmap.features.find((item) => item.key === feature.key)?.forecast.status, "forecast_ready");
  });

  function configureTeam(): void {
    setTeamCapacityConfiguration(database, {
      projectId, principalId, requestId: randomUUID(), expectedVersion: 0,
      teamName: "Roadmap team", timezone: "America/Sao_Paulo", hoursPerDay: 8,
      workingDays: [1, 2, 3, 4, 5], members: [{ principalId, dedicationPercent: 100 }],
      reason: "Configuração para a projeção do roadmap.",
    });
    setDefinitionOfDone(database, {
      projectId, principalId, requestId: randomUUID(), expectedVersion: 0,
      criteria: [{ description: "Critérios de entrega aceitos." }], reason: "Definition of Done do roadmap.",
    });
  }

  function createEstimatedFeature(title: string, points: number) {
    const epic = createWorkItem(database, {
      projectId, principalId, requestId: randomUUID(), type: "epic", title: `${title} epic`,
    }).value;
    const feature = createWorkItem(database, {
      projectId, principalId, requestId: randomUUID(), type: "feature", title, parentId: epic.id,
    }).value;
    const story = createWorkItem(database, {
      projectId, principalId, requestId: randomUUID(), type: "story", title: `${title} story`, parentId: feature.id,
    }).value;
    const proposal = proposeWorkItemEstimate(database, {
      projectId, principalId, requestId: randomUUID(), itemIdOrKey: story.id, unit: "points",
      value: points, rationale: "Estimativa inicial para a projeção do roadmap.", expectedVersion: story.version,
    }).value;
    const proposed = getWorkItem(database, projectId, principalId, story.id);
    confirmWorkItemEstimate(database, {
      projectId, principalId, requestId: randomUUID(), itemIdOrKey: story.id,
      proposalId: proposal.id, expectedVersion: proposed.version,
    });
    return { feature, story };
  }

  function seedClosedSprint(today: string, sprintKey: string, deliveredPoints: number, sequence: number): void {
    insertSprint(sprintKey, "closed", addDays(today, -20 - sequence * 10), addDays(today, -15 - sequence * 10), {
      acceptedItems: [{ itemId: randomUUID(), points: deliveredPoints }],
    });
  }

  function seedActiveSprint(startsOn: string, endsOn: string): void {
    insertSprint("PAY-ACTIVE", "active", startsOn, endsOn, null);
  }

  function insertSprint(
    sprintKey: string,
    status: "active" | "closed",
    startsOn: string,
    endsOn: string,
    closedSnapshot: { acceptedItems: Array<{ itemId: string; points: number }> } | null,
  ): void {
    const teamId = (database.prepare("SELECT team_id FROM teams WHERE project_id = ?")
      .get(projectId) as { team_id: string }).team_id;
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO sprints
        (sprint_id, project_id, sprint_key, title, goal, starts_on, ends_on, status, team_id,
         capacity_config_version, dod_revision_number, version, created_by_principal_id,
         created_at, started_at, closed_at, reason, review_summary, started_snapshot_json, closed_snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), projectId, sprintKey, `Sprint ${sprintKey}`, "Roadmap timeline fixture", startsOn, endsOn, status,
      teamId, principalId, now, status === "closed" ? now : null, status === "closed" ? now : null,
      "Roadmap timeline fixture", closedSnapshot === null ? null : "Synthetic sample",
      JSON.stringify({ capacity: { totalHours: 100 }, commitments: [] }),
      closedSnapshot === null ? null : JSON.stringify(closedSnapshot),
    );
  }

  function createQueueTask(title: string, epicPriority: number, featurePriority: number, featureValue: number, storyPriority = 2) {
    const epic = createWorkItem(database, {
      projectId, principalId, requestId: randomUUID(), type: "epic", title: `${title} epic`, priority: epicPriority,
    }).value;
    const feature = createWorkItem(database, {
      projectId, principalId, requestId: randomUUID(), type: "feature", title: `${title} feature`, parentId: epic.id,
      priority: featurePriority, businessValueScore: featureValue, businessValueRationale: `Value rationale for ${title}.`,
    }).value;
    const story = createWorkItem(database, {
      projectId, principalId, requestId: randomUUID(), type: "story", title: `${title} story`, parentId: feature.id,
      priority: storyPriority,
    }).value;
    const task = createWorkItem(database, {
      projectId, principalId, requestId: randomUUID(), type: "task", title, parentId: story.id,
      description: `Implement ${title}.`,
    }).value;
    const now = new Date().toISOString();
    database.prepare("UPDATE work_items SET state = 'ready' WHERE project_id = ? AND item_id = ?").run(projectId, story.id);
    database.prepare("UPDATE work_items SET state = 'ready', assignee_principal_id = ? WHERE project_id = ? AND item_id = ?")
      .run(principalId, projectId, task.id);
    database.prepare(
      `INSERT INTO work_baselines (baseline_id, project_id, item_id, sequence, kind, reason, created_by_principal_id, created_at)
       VALUES (?, ?, ?, 1, 'ready', 'queue test fixture', ?, ?)`,
    ).run(randomUUID(), projectId, story.id, principalId, now);
    return { epic, feature, story, task };
  }
});

function projectToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year")!.value}-${parts.find((part) => part.type === "month")!.value}-${parts.find((part) => part.type === "day")!.value}`;
}

function addDays(date: string, amount: number): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + amount);
  return result.toISOString().slice(0, 10);
}
