import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { getTaskContext } from "../../src/application/task-context.js";
import { listDeliveryReports, submitDeliveryReport, unattestedDefinitionOfDone } from "../../src/application/task-delivery-reports.js";
import { transitionWorkItem } from "../../src/application/work-item-workflow.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("delivery report per criterion (SSDD-940)", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let taskId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-delivery-"));
    const initialized = initializeProject({ workspace, key: "DR", name: "Delivery", productGoal: "Entregar", timezone: "UTC" });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?").get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    const make = (type: "epic" | "feature" | "story" | "task", title: string, extra: Record<string, unknown> = {}) =>
      createWorkItem(database, { projectId, principalId, requestId: `create-${title}`, type, title, ...extra } as Parameters<typeof createWorkItem>[1]).value;
    const epic = make("epic", "Epic");
    const feature = make("feature", "Feature", { parentId: epic.id });
    const story = make("story", "Story", { parentId: feature.id, criteria: [{ description: "Pedido confirmado" }, { description: "Estoque validado" }] });
    taskId = make("task", "Tarefa", { parentId: story.id, description: "Entrega" }).id;
    database.prepare("UPDATE work_items SET state = 'in_progress' WHERE project_id = ? AND item_id = ?").run(projectId, taskId);
  });

  afterEach(() => {
    delete process.env["SSDD_REQUIRE_DELIVERY_REPORT"];
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const submit = (requestId: string, second: "met" | "not_met" | "not_applicable", extra: Record<string, string> = {}) => submitDeliveryReport(database, {
    projectId, principalId, requestId, itemIdOrKey: taskId,
    entries: [
      { criterionKey: "AC-1", scope: "pbi", status: "met", evidence: "teste X passou" },
      { criterionKey: "AC-2", scope: "pbi", status: second, ...(second === "met" ? { evidence: "teste Y passou" } : {}), ...extra },
    ],
  });
  const toReview = (requestId: string) => transitionWorkItem(database, { projectId, principalId, requestId, itemIdOrKey: taskId, targetState: "in_review", expectedVersion: (database.prepare("SELECT version FROM work_items WHERE item_id = ?").get(taskId) as { version: number }).version, reason: "self_validation: ok" });

  it("requires full coverage and evidence, numbers reports and keeps them immutable", () => {
    assert.throws(() => submitDeliveryReport(database, { projectId, principalId, requestId: "partial", itemIdOrKey: taskId, entries: [{ criterionKey: "AC-1", scope: "pbi", status: "met", evidence: "ok" }] }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED");
    assert.throws(() => submit("no-assumption", "not_applicable"), (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED");
    const first = submit("r1", "met");
    const second = submit("r2", "not_applicable", { assumptions: "fora do escopo desta entrega", deviations: "adiado" });
    assert.equal(first.value.report.reportNumber, 1);
    assert.equal(second.value.report.reportNumber, 2);
    const listed = listDeliveryReports(database, { projectId, principalId, itemIdOrKey: taskId });
    assert.deepEqual(listed.reports.map((report) => report.reportNumber), [2, 1]);
    assert.equal(listed.expected.length, 2);
    assert.throws(() => database.prepare("UPDATE task_delivery_reports SET summary = 'x'").run(), /immutable/);
    assert.throws(() => database.prepare("DELETE FROM task_delivery_reports").run(), /immutable/);
  });

  it("blocks in_review while the latest report has not_met and releases it after a corrected report", () => {
    submit("bad", "not_met");
    assert.throws(() => toReview("review-1"), (error: unknown) => error instanceof ApplicationError && error.code === "GATE_BLOCKED");
    submit("good", "met");
    assert.equal(toReview("review-2").value.transition.toState, "in_review");
  });

  it("only demands a report without one when the host opts in", () => {
    process.env["SSDD_REQUIRE_DELIVERY_REPORT"] = "1";
    assert.throws(() => toReview("strict"), (error: unknown) => error instanceof ApplicationError && error.code === "GATE_BLOCKED");
    delete process.env["SSDD_REQUIRE_DELIVERY_REPORT"];
    assert.equal(toReview("lenient").value.transition.toState, "in_review");
  });

  it("pins the Definition of Done, requires the report to attest it and warns when it is revised later (SSDD-943)", () => {
    const insertDod = database.prepare(
      "INSERT INTO dod_revisions (project_id, revision_number, criteria_json, reason, created_by_principal_id, created_at) VALUES (?, ?, ?, 'teste', ?, '2026-01-01T00:00:00.000Z')",
    );
    insertDod.run(projectId, 1, JSON.stringify([{ id: "dod-a", description: "Testes passam" }, { id: "dod-b", description: "Docs atualizadas" }]), principalId);
    database.prepare("INSERT INTO task_dod_pins (project_id, item_id, dod_revision, pinned_at) VALUES (?, ?, 1, '2026-01-02T00:00:00.000Z')").run(projectId, taskId);

    assert.deepEqual(listDeliveryReports(database, { projectId, principalId, itemIdOrKey: taskId }).expected.filter((entry) => entry.scope === "dod").map((entry) => entry.key), ["dod-a", "dod-b"]);
    assert.throws(() => submit("without-dod", "met"), (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED");

    const entries = (second: "met" | "partial") => [
      { criterionKey: "AC-1", scope: "pbi" as const, status: "met" as const, evidence: "teste X" },
      { criterionKey: "AC-2", scope: "pbi" as const, status: "met" as const, evidence: "teste Y" },
      { criterionKey: "dod-a", scope: "dod" as const, status: "met" as const, evidence: "npm test verde" },
      { criterionKey: "dod-b", scope: "dod" as const, status: second, evidence: "docs parciais" },
    ];
    submitDeliveryReport(database, { projectId, principalId, requestId: "dod-partial", itemIdOrKey: taskId, entries: entries("partial") });
    assert.deepEqual(unattestedDefinitionOfDone(database, projectId, taskId), ["dod-b"]);
    submitDeliveryReport(database, { projectId, principalId, requestId: "dod-met", itemIdOrKey: taskId, entries: entries("met") });
    assert.deepEqual(unattestedDefinitionOfDone(database, projectId, taskId), []);

    insertDod.run(projectId, 2, JSON.stringify([{ id: "dod-c", description: "Nova regra" }]), principalId);
    const context = getTaskContext(database, { projectId, principalId, taskIdOrKey: taskId, include: ["definitionOfDone"] });
    assert.deepEqual(context.sections.definitionOfDone.map((entry) => entry.key), ["DoD-r1:1", "DoD-r1:2"]);
    assert.ok(context.warnings.some((warning) => warning.code === "DOD_REVISED_AFTER_PIN"));
  });
});
