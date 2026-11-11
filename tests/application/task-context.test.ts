import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { addWorkItemComment } from "../../src/application/work-item-commands.js";
import { fixWorkItemBaseline } from "../../src/application/baseline-commands.js";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { publishScenarioRevision, recordTestRun, createScenario } from "../../src/application/scenario-commands.js";
import { createSpecification, proposeSpecificationRevision, publishSpecificationRevision } from "../../src/application/specification-commands.js";
import { addTraceLink } from "../../src/application/trace-commands.js";
import { getTaskContext } from "../../src/application/task-context.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("task context profiles, baselines and pagination", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let pbiId: string;
  let taskId: string;
  let criterionId: string;
  let businessRuleId: string;
  let scenarioId: string;
  let taskKey: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-task-context-"));
    const initialized = initializeProject({
      workspace,
      key: "PAY",
      name: "Payments",
      productGoal: "Pagamentos confiáveis",
      timezone: "America/Sao_Paulo",
    });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
      .get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    const epic = createWorkItem(database, {
      projectId, principalId, requestId: `epic-${randomUUID()}`, type: "epic", title: "Pagamentos",
    }).value;
    const feature = createWorkItem(database, {
      projectId, principalId, requestId: `feature-${randomUUID()}`, type: "feature", parentId: epic.id, title: "Checkout",
    }).value;
    const pbi = createWorkItem(database, {
      projectId,
      principalId,
      requestId: `story-${randomUUID()}`,
      type: "story",
      parentId: feature.id,
      title: "Confirmar pagamento",
      criteria: [{ description: "A confirmação respeita o instante de corte." }],
    }).value;
    pbiId = pbi.id;
    criterionId = pbi.criteria[0]!.id;
    taskId = createWorkItem(database, {
      projectId,
      principalId,
      requestId: `task-${randomUUID()}`,
      type: "task",
      parentId: pbi.id,
      title: "Implementar a confirmação",
      description: "Aplicar a regra no serviço de pagamento.",
    }).value.id;
    taskKey = (database.prepare("SELECT item_key FROM work_items WHERE project_id = ? AND item_id = ?")
      .get(projectId, taskId) as { item_key: string }).item_key;

    businessRuleId = createSpecification(database, {
      projectId,
      principalId,
      requestId: `rule-${randomUUID()}`,
      key: "BR-01",
      kind: "business_rule",
      title: "Instante de corte",
      content: { text: "A confirmação é válida antes do instante de corte." },
    }).value.specId;
    publishSpecificationRevision(database, {
      projectId, principalId, requestId: `rule-publish-${randomUUID()}`,
      specIdOrKey: businessRuleId, revisionNumber: 1, expectedVersion: 1,
    });
    const adrId = createSpecification(database, {
      projectId,
      principalId,
      requestId: `adr-${randomUUID()}`,
      key: "ADR-01",
      kind: "adr",
      title: "Transição atômica",
      content: { decision: "Persistir a confirmação e o evento na mesma transação." },
    }).value.specId;
    publishSpecificationRevision(database, {
      projectId, principalId, requestId: `adr-publish-${randomUUID()}`,
      specIdOrKey: adrId, revisionNumber: 1, expectedVersion: 1,
    });
    for (const specId of [businessRuleId, adrId]) {
      addTraceLink(database, {
        projectId, principalId, requestId: `link-${randomUUID()}`,
        sourceIdOrKey: pbi.id, targetIdOrKey: specId, type: "implements",
      });
    }
    addTraceLink(database, {
      projectId, principalId, requestId: `task-related-${randomUUID()}`,
      sourceIdOrKey: taskId, targetIdOrKey: adrId, type: "relates_to",
    });

    scenarioId = createScenario(database, {
      projectId,
      principalId,
      requestId: `scenario-${randomUUID()}`,
      key: "PAY-TC-01",
      kind: "acceptance",
      title: "Confirmar antes do corte",
      steps: [{ action: "Confirmar o pagamento", expected: "A confirmação é aceita" }],
      coverage: [
        { targetType: "criterion", reference: `${pbi.key}:AC-1` },
        { targetType: "specification", reference: "BR-01" },
      ],
    }).value.scenarioId;
    publishScenarioRevision(database, {
      projectId, principalId, requestId: `scenario-publish-${randomUUID()}`,
      scenarioIdOrKey: scenarioId, revisionNumber: 1, expectedVersion: 1,
    });
    recordTestRun(database, {
      projectId, principalId, requestId: `run-${randomUUID()}`, scenarioIdOrKey: scenarioId,
      revisionNumber: 1, buildId: "build-42", result: "passed", notes: "Execução aprovada.",
    });
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("returns distinct Dev and QA profiles with hierarchy, requirements, scenarios and runs", () => {
    const dev = getTaskContext(database, { projectId, principalId, taskIdOrKey: taskKey, profile: "dev" });
    const qa = getTaskContext(database, { projectId, principalId, taskIdOrKey: taskKey, profile: "qa" });

    assert.equal(dev.mode, "preview");
    assert.ok(dev.warnings.some((warning) => warning.code === "NO_BASELINE_PREVIEW"));
    assert.deepEqual(dev.sections.hierarchy.map((entry) => entry.content && (entry.content as { type: string }).type), [
      "epic", "feature", "story", "task",
    ]);
    assert.equal(dev.sections.acceptanceCriteria[0]?.content && (dev.sections.acceptanceCriteria[0].content as { id: string }).id, criterionId);
    assert.ok(dev.sections.businessRules.some((entry) => entry.key === "BR-01"));
    assert.ok(dev.sections.technicalDecisions.some((entry) => entry.key === "ADR-01"));
    const relatedDecision = dev.sections.technicalDecisions.find((entry) => entry.key === "ADR-01");
    assert.equal(relatedDecision?.source.relationship, "task_direct_link");
    assert.equal(relatedDecision?.source.traceLinkType, "relates_to");
    assert.equal(dev.sections.testRuns.length, 0);
    assert.equal(qa.sections.technicalDecisions.length, 0);
    assert.equal(qa.sections.testRuns.length, 1);
    assert.equal(qa.sections.testRuns[0]?.content && (qa.sections.testRuns[0].content as { result: string }).result, "passed");
    assert.ok(qa.sections.scenarios.some((entry) => entry.key === "PAY-TC-01"));
  });

  it("uses the baseline snapshot and warns when a linked rule changes afterward", () => {
    database.prepare("UPDATE work_items SET state = 'ready' WHERE project_id = ? AND item_id = ?").run(projectId, pbiId);
    const baseline = fixWorkItemBaseline(database, {
      projectId, principalId, requestId: `baseline-${randomUUID()}`, itemIdOrKey: pbiId,
      expectedVersion: 1, reason: "PO aprovou o escopo para implementação.",
    }).value;
    assert.equal(baseline.sequence, 1);

    proposeSpecificationRevision(database, {
      projectId, principalId, requestId: `rule-propose-${randomUUID()}`,
      specIdOrKey: businessRuleId, expectedVersion: 2,
      content: { text: "A confirmação ocorre antes do corte e na transação de pagamento." },
    });
    publishSpecificationRevision(database, {
      projectId, principalId, requestId: `rule-publish-2-${randomUUID()}`,
      specIdOrKey: businessRuleId, revisionNumber: 2, expectedVersion: 3,
    });

    const context = getTaskContext(database, { projectId, principalId, taskIdOrKey: taskId, profile: "po" });
    assert.equal(context.mode, "pinned");
    assert.equal(context.baseline?.id, baseline.id);
    const rule = context.sections.businessRules.find((entry) => entry.key === "BR-01");
    assert.equal(rule?.source.revisionNumber, 1);
    assert.equal((rule?.content as { text: string }).text, "A confirmação é válida antes do instante de corte.");
    assert.ok(context.warnings.some((warning) => warning.code === "BASELINE_DRIFT" && warning.key === "BR-01"));
    assert.equal(context.sections.baseline[0]?.content && (context.sections.baseline[0].content as { sequence: number }).sequence, 1);
    assert.ok(context.sections.scenarios.some((entry) => entry.key === "PAY-TC-01"));
  });

  it("paginates complete context entries and rejects a stale continuation cursor", () => {
    const first = getTaskContext(database, { projectId, principalId, taskIdOrKey: taskKey, profile: "po", maxChars: 2_000 });
    assert.ok(JSON.stringify(first).length <= 2_000);
    assert.equal(first.truncated, true);
    assert.ok(first.nextCursor);
    const seen = new Set<string>();
    for (const entries of Object.values(first.sections)) for (const entry of entries) seen.add(`${entry.section}:${entry.key}`);

    let cursor: string | null = first.nextCursor;
    let pages = 1;
    while (cursor !== null) {
      const page = getTaskContext(database, {
        projectId, principalId, taskIdOrKey: taskKey, profile: "po", maxChars: 2_000, cursor,
      });
      assert.ok(JSON.stringify(page).length <= 2_000);
      for (const entries of Object.values(page.sections)) {
        for (const entry of entries) {
          const identity = `${entry.section}:${entry.key}`;
          assert.ok(!seen.has(identity), `duplicate context entry ${identity}`);
          seen.add(identity);
        }
      }
      cursor = page.nextCursor;
      pages += 1;
      assert.ok(pages < 10, "pagination should make progress");
    }
    assert.ok(pages > 1);
    assert.ok(seen.has("acceptanceCriteria:AC-1"));

    const stalePage = getTaskContext(database, { projectId, principalId, taskIdOrKey: taskKey, profile: "po", maxChars: 2_000 });
    assert.ok(stalePage.nextCursor);
    addWorkItemComment(database, {
      projectId, principalId, requestId: `comment-${randomUUID()}`, itemIdOrKey: pbiId,
      body: "Atualização posterior à primeira página.",
    });
    assert.throws(
      () => getTaskContext(database, {
        projectId, principalId, taskIdOrKey: taskKey, profile: "po", maxChars: 2_000, cursor: stalePage.nextCursor!,
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "STALE_CURSOR",
    );
  });
});
