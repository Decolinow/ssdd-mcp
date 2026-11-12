import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { getProjectFeatureRoadmap, getTaskExecutionQueue } from "../../src/application/prioritized-roadmap.js";
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
