import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { getDeliveryQualityMetrics } from "../../src/application/delivery-quality-metrics.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("delivery quality metrics (SSDD-951)", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let storyId: string;
  let featureId: string;
  const at = (minutes: number) => new Date(Date.parse("2026-11-10T00:00:00Z") + minutes * 60_000).toISOString();

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-quality-"));
    const initialized = initializeProject({ workspace, key: "QM", name: "Quality", productGoal: "Medir", timezone: "UTC" });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?").get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    const epic = make("epic", "Epic");
    featureId = make("feature", "Feature", epic).id;
    storyId = make("story", "Story", featureId).id;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  function make(type: "epic" | "feature" | "story" | "task" | "bug", title: string, parentOrStory?: string | { id: string }, extra: Record<string, unknown> = {}) {
    const parentId = typeof parentOrStory === "string" ? parentOrStory : parentOrStory?.id;
    return createWorkItem(database, { projectId, principalId, requestId: `create-${title}`, type, title, ...(parentId === undefined ? {} : { parentId }), ...extra } as Parameters<typeof createWorkItem>[1]).value;
  }

  function transition(itemId: string, version: number, from: string, to: string, reason: string, minute: number): void {
    database.prepare(
      `INSERT INTO work_item_state_transitions (transition_id, project_id, item_id, from_state, to_state, item_version, reason, transitioned_by_principal_id, transitioned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), projectId, itemId, from, to, version, reason, principalId, at(minute));
  }

  it("reports first-pass acceptance, returns by reason, criteria status and bugs, hiding small-sample rates", () => {
    const tasks = [1, 2, 3, 4, 5].map((n) => make("task", `T${n}`, storyId));
    tasks.forEach((task, index) => {
      let version = 2;
      transition(task.id, version++, "in_progress", "in_review", "pronto para revisão", index * 10 + 1);
      if (index === 0) {
        transition(task.id, version++, "in_review", "in_progress", "Faltou teste de erro", 100);
        transition(task.id, version++, "in_progress", "in_review", "corrigido", 101);
      }
      transition(task.id, version, "in_validation", "done", "ok", index * 10 + 5);
      database.prepare("UPDATE work_items SET state = 'done' WHERE item_id = ?").run(task.id);
    });
    const story = make("story", "Done story", featureId);
    database.prepare("UPDATE work_items SET state = 'done' WHERE item_id = ?").run(story.id);
    transition(story.id, 2, "in_validation", "done", "ok", 20);
    const bug = make("bug", "Bug na história", featureId, { relatedStoryId: story.id });
    database.prepare("UPDATE work_items SET created_at = ? WHERE item_id = ?").run(at(30), bug.id);
    database.prepare(
      `INSERT INTO task_delivery_reports (report_id, project_id, item_id, report_number, entries_json, summary, submitted_by_principal_id, submitted_at)
       VALUES (?, ?, ?, 1, ?, NULL, ?, ?)`,
    ).run(randomUUID(), projectId, tasks[0]!.id, JSON.stringify([{ status: "met" }, { status: "partial" }, { status: "not_met" }]), principalId, at(40));

    const metrics = getDeliveryQualityMetrics(database, { projectId, principalId, from: at(-10), to: at(500) });
    assert.equal(metrics.acceptance.doneTasks, 5);
    assert.equal(metrics.acceptance.firstPassTasks, 4);
    assert.equal(metrics.acceptance.firstPassRate, 80);
    assert.deepEqual(metrics.acceptance.bySegment.map((entry) => entry.principalType), ["human"]);
    assert.equal(metrics.returns.total, 1);
    assert.deepEqual(metrics.returns.topReasons, [{ reason: "faltou teste de erro", count: 1 }]);
    assert.deepEqual(metrics.criteria.byStatus, { met: 1, partial: 1, not_met: 1, not_applicable: 0 });
    assert.equal(metrics.criteria.unresolvedShare, null);
    assert.equal(metrics.bugs.bugsOnDoneStories, 1);
    assert.equal(metrics.bugs.bugsPerDoneStory, null);
    assert.ok(metrics.limitations.length >= 2);
    assert.equal(getDeliveryQualityMetrics(database, { projectId, principalId, from: at(-10), to: at(1) }).acceptance.doneTasks, 0);
    assert.throws(() => getDeliveryQualityMetrics(database, { projectId, principalId, from: at(5), to: at(1) }), /from and to/);
  });
});
