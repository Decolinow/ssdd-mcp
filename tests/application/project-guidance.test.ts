import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { readProjectGuidance, recentReturnReasons, setProjectGuidance } from "../../src/application/project-guidance.js";
import { getTaskContext } from "../../src/application/task-context.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("project guidance in the task context (SSDD-948)", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let storyId: string;
  let taskId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-guidance-"));
    const initialized = initializeProject({ workspace, key: "GD", name: "Guidance", productGoal: "Orientar", timezone: "UTC" });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?").get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    const make = (type: "epic" | "feature" | "story" | "task", title: string, extra: Record<string, unknown> = {}) =>
      createWorkItem(database, { projectId, principalId, requestId: `create-${title}`, type, title, ...extra } as Parameters<typeof createWorkItem>[1]).value;
    const epic = make("epic", "Epic");
    const feature = make("feature", "Feature", { parentId: epic.id });
    storyId = make("story", "Story", { parentId: feature.id, criteria: [{ description: "Pedido confirmado" }] }).id;
    taskId = make("task", "Tarefa", { parentId: storyId, description: "Entrega" }).id;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("versions guidance with provenance and rejects stale revisions and empty content", () => {
    assert.equal(readProjectGuidance(database, projectId, principalId).revisionNumber, null);
    assert.throws(() => setProjectGuidance(database, { projectId, principalId, requestId: "empty", expectedRevision: 0, content: { conventions: [], verificationCommands: [] }, reason: "Orientações iniciais do time" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED");
    const first = setProjectGuidance(database, {
      projectId, principalId, requestId: "g1", expectedRevision: 0, reason: "Orientações iniciais do time",
      content: { conventions: [{ title: "Commits", text: "Commits pequenos com mensagem no imperativo." }], verificationCommands: ["npm run check"] },
    });
    assert.equal(first.value.revisionNumber, 1);
    assert.throws(() => setProjectGuidance(database, { projectId, principalId, requestId: "stale", expectedRevision: 0, reason: "Reenvio com revisão velha", content: { conventions: [], verificationCommands: ["npm test"] } }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VERSION_CONFLICT");
    assert.throws(() => database.prepare("UPDATE project_guidance_revisions SET reason = 'x'").run(), /immutable/);
  });

  it("adds a guidance section with conventions, retrospective actions and return reasons", () => {
    setProjectGuidance(database, {
      projectId, principalId, requestId: "g1", expectedRevision: 0, reason: "Orientações iniciais do time",
      content: { conventions: [{ title: "Commits", text: "Commits pequenos." }], verificationCommands: ["npm run check"] },
    });
    database.prepare(
      `INSERT INTO work_item_state_transitions (transition_id, project_id, item_id, from_state, to_state, item_version, baseline_id, build_id, reason, transitioned_by_principal_id, transitioned_at)
       VALUES ('t1', ?, ?, 'in_review', 'in_progress', 2, NULL, NULL, 'faltou tratar estoque insuficiente', ?, '2026-01-01T00:00:00.000Z')`,
    ).run(projectId, taskId, principalId);
    const context = getTaskContext(database, { projectId, principalId, taskIdOrKey: taskId, include: ["guidance"] });
    const keys = context.sections.guidance.map((entry) => entry.key);
    assert.ok(keys.includes("guidance:conventions:r1"));
    assert.ok(keys.some((key) => key.startsWith("guidance:returns:")));
    const returns = recentReturnReasons(database, projectId, storyId);
    assert.equal(returns[0]?.reason, "faltou tratar estoque insuficiente");
    const conventions = context.sections.guidance.find((entry) => entry.key === "guidance:conventions:r1")?.content as { provenance: { revision: number } };
    assert.equal(conventions.provenance.revision, 1);
  });
});
