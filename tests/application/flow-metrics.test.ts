import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { getFlowMetrics } from "../../src/application/flow-metrics.js";
import { confirmWorkItemEstimate, proposeWorkItemEstimate } from "../../src/application/work-item-commands.js";
import { addTraceLink } from "../../src/application/trace-commands.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

const hour = 3_600_000;
const base = Date.parse("2026-11-01T00:00:00.000Z");
const at = (hours: number): string => new Date(base + hours * hour).toISOString();

describe("flow metrics (SSDD-930)", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let storyId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-flow-"));
    const initialized = initializeProject({ workspace, key: "FL", name: "Flow", productGoal: "Fluxo", timezone: "UTC" });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?").get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    const epic = item("epic", "Épico");
    const feature = item("feature", "Feature", epic.id);
    storyId = item("story", "História", feature.id).id;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  function item(type: "epic" | "feature" | "story" | "task", title: string, parentId?: string) {
    return createWorkItem(database, { projectId, principalId, requestId: randomUUID(), type, title, ...(parentId === undefined ? {} : { parentId }) }).value;
  }

  function history(id: string, steps: Array<[string, number]>, createdAtHours = 0): void {
    database.prepare("UPDATE work_items SET created_at = ? WHERE project_id = ? AND item_id = ?").run(at(createdAtHours), projectId, id);
    let version = 1;
    let previous = "draft";
    for (const [state, hours] of steps) {
      version += 1;
      database.prepare(
        `INSERT INTO work_item_state_transitions (transition_id, project_id, item_id, from_state, to_state, item_version, reason, transitioned_by_principal_id, transitioned_at)
         VALUES (?, ?, ?, ?, ?, ?, 'teste', ?, ?)`,
      ).run(randomUUID(), projectId, id, previous, state, version, principalId, at(hours));
      previous = state;
    }
    database.prepare("UPDATE work_items SET state = ? WHERE project_id = ? AND item_id = ?").run(previous, projectId, id);
  }

  it("derives lead/cycle/wait/work distributions from transitions and hides samples below the minimum", () => {
    for (let index = 0; index < 5; index += 1) {
      const task = item("task", `Concluída ${index}`, storyId);
      // draft→ready at 1h, in_progress at 3h, review at 7h, validation at 8h, done at 10h (+ index hours offset on done only).
      history(task.id, [["ready", 1], ["in_progress", 3], ["in_review", 7], ["in_validation", 8], ["done", 10 + index]]);
    }
    const metrics = getFlowMetrics(database, { projectId, principalId, from: at(0), to: at(100), now: new Date(base + 200 * hour) });
    assert.equal(metrics.completed.tasks, 5);
    assert.equal(metrics.completed.leadTime?.sample, 5);
    assert.equal(metrics.completed.leadTime?.medianHours, 12);
    assert.equal(metrics.completed.cycleTime?.medianHours, 9);
    assert.equal(metrics.completed.workTime?.medianHours, 4);
    assert.equal(metrics.completed.waitTime?.medianHours, 2 + 1 + 4, "ready (2h) + review (1h) + validation (done-8h at median index 2 → 4h)");
    const sparse = getFlowMetrics(database, { projectId, principalId, from: at(0), to: at(100), now: new Date(base + 200 * hour) });
    assert.equal(sparse.criticalPath.status, "no_open_dependencies");
    const narrow = getFlowMetrics(database, { projectId, principalId, from: at(0), to: at(11), now: new Date(base + 200 * hour) });
    assert.equal(narrow.completed.tasks, 1);
    assert.equal(narrow.completed.leadTime, null, "below the minimum sample");
    assert.ok(metrics.limitations.length > 0);
  });

  it("reports open work as a censored sample and computes the critical path only for a DAG with hour estimates", () => {
    const a = item("task", "A", storyId);
    const b = item("task", "B", storyId);
    const c = item("task", "C", storyId);
    history(a.id, [["ready", 1], ["in_progress", 2]]);
    history(b.id, [["ready", 1]]);
    addTraceLink(database, { projectId, principalId, requestId: randomUUID(), sourceIdOrKey: a.key, targetIdOrKey: b.key, type: "depends_on" });
    addTraceLink(database, { projectId, principalId, requestId: randomUUID(), sourceIdOrKey: b.key, targetIdOrKey: c.key, type: "depends_on" });
    const now = new Date(base + 50 * hour);
    const missing = getFlowMetrics(database, { projectId, principalId, from: at(0), to: at(100), now });
    assert.equal(missing.criticalPath.status, "missing_estimates");
    assert.equal(missing.openWork.censored, true);
    assert.equal(missing.openWork.byState.find((entry) => entry.state === "in_progress")?.oldestAgeHours, 48);
    for (const [task, value] of [[a, 3], [b, 5], [c, 2]] as const) {
      const proposal = proposeWorkItemEstimate(database, {
        projectId, principalId, requestId: randomUUID(), itemIdOrKey: task.id, unit: "hours", value, rationale: "teste", expectedVersion: 1,
      }).value;
      confirmWorkItemEstimate(database, { projectId, principalId, requestId: randomUUID(), itemIdOrKey: task.id, proposalId: proposal.id, expectedVersion: 2 });
    }
    const computed = getFlowMetrics(database, { projectId, principalId, from: at(0), to: at(100), now });
    assert.equal(computed.criticalPath.status, "computed");
    assert.equal(computed.criticalPath.totalHours, 10);
    assert.deepEqual(computed.criticalPath.path.map((step) => step.key), [a.key, b.key, c.key]);
  });
});
