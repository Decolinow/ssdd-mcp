import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { reviewWorkItemReadiness } from "../../src/application/readiness-review.js";
import { answerQuestion, listQuestions, openQuestion } from "../../src/application/work-item-questions.js";
import { getWorkItemGateReport } from "../../src/application/work-item-workflow.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("readiness review and open questions (SSDD-939)", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let storyId: string;
  let taskId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-questions-"));
    const initialized = initializeProject({ workspace, key: "QS", name: "Questions", productGoal: "Perguntar", timezone: "UTC" });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?").get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    const make = (type: "epic" | "feature" | "story" | "task", title: string, extra: Record<string, unknown> = {}) =>
      createWorkItem(database, { projectId, principalId, requestId: `create-${title}`, type, title, ...extra } as Parameters<typeof createWorkItem>[1]).value;
    const epic = make("epic", "Epic");
    const feature = make("feature", "Feature", { parentId: epic.id });
    const story = make("story", "Story", {
      parentId: feature.id,
      criteria: [
        { description: "O sistema deve ser rápido" },
        { description: "O \"carrinho fantasma\" retorna o pedido confirmado" },
        { description: "Interface bonita" },
      ],
    });
    storyId = story.id;
    taskId = make("task", "Tarefa", { parentId: story.id, description: "Saída esperada" }).id;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("returns deterministic findings for vague, unobservable and unscoped criteria", () => {
    const review = reviewWorkItemReadiness(database, { projectId, principalId, itemIdOrKey: storyId });
    const codes = review.findings.map((finding) => `${finding.criterionKey ?? "-"}:${finding.code}`);
    assert.ok(codes.includes("AC-1:vague_term"));
    assert.ok(codes.includes("AC-2:term_not_in_glossary"));
    assert.ok(codes.includes("AC-3:no_observable_outcome"));
    assert.ok(codes.includes("AC-1:criterion_without_scenario"));
    assert.deepEqual(reviewWorkItemReadiness(database, { projectId, principalId, itemIdOrKey: storyId }), review);
    const task = reviewWorkItemReadiness(database, { projectId, principalId, itemIdOrKey: taskId });
    assert.deepEqual(task.findings.map(({ code }) => code), ["task_without_checklist"]);
  });

  it("blocks Ready while a blocking question is open and lets answers release it", () => {
    const opened = openQuestion(database, { projectId, principalId, requestId: "q1", itemIdOrKey: taskId, text: "Qual o formato do CSV?", blocking: true });
    assert.equal(opened.value.question.key, "Q-1");
    const replay = openQuestion(database, { projectId, principalId, requestId: "q1", itemIdOrKey: taskId, text: "Qual o formato do CSV?", blocking: true });
    assert.equal(replay.value.question.id, opened.value.question.id);

    const blocked = getWorkItemGateReport(database, { projectId, principalId, itemIdOrKey: taskId, targetState: "ready" });
    assert.equal(blocked.gates.find((gate) => gate.id === "no-blocking-questions")?.passed, false);
    assert.ok(reviewWorkItemReadiness(database, { projectId, principalId, itemIdOrKey: taskId }).findings.some((finding) => finding.code === "blocking_question_open"));
    assert.equal(listQuestions(database, { projectId, principalId, itemIdOrKey: taskId, status: "open" }).questions.length, 1);

    const answered = answerQuestion(database, { projectId, principalId, requestId: "a1", questionIdOrKey: "q-1", answer: "RFC 4180, UTF-8", expectedVersion: 1 });
    assert.equal(answered.value.question.status, "answered");
    assert.equal(getWorkItemGateReport(database, { projectId, principalId, itemIdOrKey: taskId, targetState: "ready" }).gates.find((gate) => gate.id === "no-blocking-questions")?.passed, true);
    assert.throws(
      () => answerQuestion(database, { projectId, principalId, requestId: "a2", questionIdOrKey: "Q-1", answer: "de novo" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_TRANSITION",
    );
    assert.equal(listQuestions(database, { projectId, principalId, status: "open" }).questions.length, 0);
  });
});
