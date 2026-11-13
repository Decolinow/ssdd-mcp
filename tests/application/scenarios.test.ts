import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ApplicationError } from "../../src/application/errors.js";
import { createSpecification } from "../../src/application/specification-commands.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import {
  createScenario,
  proposeScenarioRevision,
  publishScenarioRevision,
  recordTestRun,
} from "../../src/application/scenario-commands.js";
import { importJunitReport } from "../../src/application/junit-import.js";
import { getScenario, listScenarios, listTestRunPage, searchScenariosByCriterion } from "../../src/application/scenario-queries.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("versioned scenarios, coverage and test runs", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let criterionId: string;
  let criterionRef: string;
  let specificationId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-scenarios-"));
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
    principalId = (database
      .prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
      .get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    const epic = createWorkItem(database, {
      projectId, principalId, requestId: `epic-${randomUUID()}`, type: "epic", title: "Payments",
    }).value;
    const feature = createWorkItem(database, {
      projectId, principalId, requestId: `feature-${randomUUID()}`, type: "feature", parentId: epic.id, title: "Checkout",
    }).value;
    const story = createWorkItem(database, {
      projectId,
      principalId,
      requestId: `story-${randomUUID()}`,
      type: "story",
      parentId: feature.id,
      title: "Confirmar pedido",
      criteria: [{ description: "Pedido válido recebe identificador" }],
    }).value;
    criterionId = story.criteria[0]!.id;
    criterionRef = `${story.key}:${story.criteria[0]!.key}`;
    specificationId = createSpecification(database, {
      projectId,
      principalId,
      requestId: `spec-${randomUUID()}`,
      key: "BR-01",
      kind: "business_rule",
      title: "Identificador do pedido",
      content: { text: "O pedido confirmado tem identificador único." },
    }).value.specId;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("publishes coverage, records immutable runs and returns the latest result by build", () => {
    const draft = createScenario(database, scenarioInput("PAY-TC-01", "Pedido confirmado")).value;
    assert.equal(draft.status, "draft");
    assert.throws(
      () => recordTestRun(database, {
        projectId,
        principalId,
        requestId: "run-draft-forbidden",
        scenarioIdOrKey: "PAY-TC-01",
        revisionNumber: 1,
        buildId: "build-100",
        result: "passed",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );

    const published = publishScenarioRevision(database, {
      projectId,
      principalId,
      requestId: "scenario-publish-1",
      scenarioIdOrKey: "PAY-TC-01",
      revisionNumber: 1,
      expectedVersion: 1,
    });
    assert.equal(published.value.status, "published");
    assert.equal(published.value.publishedByPrincipalId, principalId);
    assert.throws(
      () => database.prepare(
        `INSERT INTO scenario_revision_coverage
          (project_id, scenario_id, revision_number, target_type, target_id)
         VALUES (?, ?, 1, 'criterion', ?)`,
      ).run(projectId, draft.scenarioId, criterionId),
      /draft revision/,
    );

    recordTestRun(database, runInput("run-100-fail", "build-100", "failed", 1));
    recordTestRun(database, runInput("run-100-pass", "build-100", "passed", 1));
    recordTestRun(database, runInput("run-101-blocked", "build-101", "blocked", 1));

    const byId = searchScenariosByCriterion(database, projectId, principalId, criterionId);
    const byKey = searchScenariosByCriterion(database, projectId, principalId, criterionRef);
    assert.equal(byId.length, 1);
    assert.deepEqual(byId, byKey);
    assert.equal(byId[0]?.revision.revisionNumber, 1);
    assert.deepEqual(byId[0]?.resultsByBuild.map(({ buildId, result }) => ({ buildId, result })), [
      { buildId: "build-100", result: "passed" },
      { buildId: "build-101", result: "blocked" },
    ]);
    assert.equal(listScenarios(database, projectId, principalId, { kind: "acceptance" }).scenarios[0]?.key, "PAY-TC-01");
    assert.equal(getScenario(database, projectId, principalId, "pay-tc-01").publishedRevision, 1);
    assert.throws(
      () => database.prepare("UPDATE test_runs SET result = 'failed' WHERE build_id = 'build-100'").run(),
      /immutable/,
    );
  });

  it("keeps coverage per immutable revision and rejects stale scenario versions", () => {
    createScenario(database, scenarioInput("PAY-TC-02", "Pedido confirmado"));
    publishScenarioRevision(database, {
      projectId, principalId, requestId: "scenario-publish-initial", scenarioIdOrKey: "PAY-TC-02",
      revisionNumber: 1, expectedVersion: 1,
    });
    const revised = proposeScenarioRevision(database, {
      projectId,
      principalId,
      requestId: "scenario-revision-propose",
      scenarioIdOrKey: "PAY-TC-02",
      expectedVersion: 2,
      title: "Pedido confirmado e rastreável",
      preconditions: ["Cliente possui forma de pagamento válida"],
      steps: [
        { action: "Enviar pedido com pagamento válido", expected: "O pedido é confirmado" },
        { action: "Consultar o pedido", expected: "O identificador é retornado" },
      ],
      coverage: [
        { targetType: "criterion", reference: criterionRef },
        { targetType: "specification", reference: "BR-01" },
      ],
    }).value;
    assert.equal(revised.revisionNumber, 2);
    assert.equal(revised.snapshot.coverage[1]?.targetId, specificationId);
    assert.throws(
      () => proposeScenarioRevision(database, {
        projectId, principalId, requestId: "scenario-stale", scenarioIdOrKey: "PAY-TC-02",
        expectedVersion: 2, title: "Stale", steps: [{ action: "A", expected: "B" }],
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VERSION_CONFLICT",
    );
    publishScenarioRevision(database, {
      projectId, principalId, requestId: "scenario-publish-revision-2", scenarioIdOrKey: "PAY-TC-02",
      revisionNumber: 2, expectedVersion: 3,
    });
    const history = getScenario(database, projectId, principalId, "PAY-TC-02");
    assert.equal(history.title, "Pedido confirmado e rastreável");
    assert.deepEqual(history.revisions.map(({ revisionNumber, status }) => ({ revisionNumber, status })), [
      { revisionNumber: 1, status: "superseded" },
      { revisionNumber: 2, status: "published" },
    ]);
    assert.equal(searchScenariosByCriterion(database, projectId, principalId, criterionId).length, 2);
  });

  it("paginates filtered test-run history and rejects mismatched or stale cursors", () => {
    createScenario(database, scenarioInput("PAY-TC-PAGE", "Histórico paginado"));
    publishScenarioRevision(database, {
      projectId,
      principalId,
      requestId: "scenario-publish-page",
      scenarioIdOrKey: "PAY-TC-PAGE",
      revisionNumber: 1,
      expectedVersion: 1,
    });
    recordTestRun(database, {
      ...runInput("run-page-failed", "build-page-1", "failed", 1),
      scenarioIdOrKey: "PAY-TC-PAGE",
    });
    recordTestRun(database, {
      ...runInput("run-page-passed-1", "build-page-1", "passed", 1),
      scenarioIdOrKey: "PAY-TC-PAGE",
    });
    recordTestRun(database, {
      ...runInput("run-page-passed-2", "build-page-2", "passed", 1),
      scenarioIdOrKey: "PAY-TC-PAGE",
    });

    const firstPage = listTestRunPage(database, projectId, principalId, {
      scenarioIdOrKey: "pay-tc-page",
      limit: 2,
    });
    assert.deepEqual(firstPage.runs.map(({ result }) => result), ["passed", "passed"]);
    assert.ok(firstPage.watermark > 0);
    assert.ok(firstPage.nextCursor);
    assert.throws(
      () => listTestRunPage(database, projectId, principalId, {
        scenarioIdOrKey: "PAY-TC-PAGE",
        result: "failed",
        limit: 2,
        cursor: firstPage.nextCursor!,
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );

    const secondPage = listTestRunPage(database, projectId, principalId, {
      scenarioIdOrKey: "PAY-TC-PAGE",
      limit: 2,
      cursor: firstPage.nextCursor!,
    });
    assert.deepEqual(secondPage.runs.map(({ result }) => result), ["failed"]);
    assert.equal(secondPage.nextCursor, null);

    recordTestRun(database, {
      ...runInput("run-page-new", "build-page-3", "passed", 1),
      scenarioIdOrKey: "PAY-TC-PAGE",
    });
    assert.throws(
      () => listTestRunPage(database, projectId, principalId, {
        scenarioIdOrKey: "PAY-TC-PAGE",
        limit: 2,
        cursor: firstPage.nextCursor!,
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "STALE_CURSOR",
    );

    const filtered = listTestRunPage(database, projectId, principalId, {
      scenarioIdOrKey: "PAY-TC-PAGE",
      buildId: "build-page-1",
      result: "passed",
    });
    assert.deepEqual(filtered.runs.map(({ buildId, result }) => ({ buildId, result })), [
      { buildId: "build-page-1", result: "passed" },
    ]);
  });

  it("paginates scenario summaries and rejects cursors from another filter or project state", () => {
    for (let index = 1; index <= 101; index += 1) {
      const key = `PAY-TC-PAGE-${String(index).padStart(3, "0")}`;
      createScenario(database, scenarioInput(key, key));
    }
    const empty = listScenarios(database, projectId, principalId, { kind: "regression" });
    assert.deepEqual(empty.scenarios, []);
    assert.equal(empty.nextCursor, null);
    const one = listScenarios(database, projectId, principalId, { kind: "acceptance", limit: 1 });
    assert.deepEqual(one.scenarios.map(({ key }) => key), ["PAY-TC-PAGE-001"]);
    assert.ok(one.nextCursor);

    const first = listScenarios(database, projectId, principalId, { kind: "acceptance", limit: 100 });
    assert.equal(first.scenarios.length, 100);
    assert.equal(first.scenarios[0]?.key, "PAY-TC-PAGE-001");
    assert.equal(first.scenarios.at(-1)?.key, "PAY-TC-PAGE-100");
    assert.ok(first.watermark > 0);
    assert.ok(first.nextCursor);
    const second = listScenarios(database, projectId, principalId, {
      kind: "acceptance", limit: 100, cursor: first.nextCursor!,
    });
    assert.deepEqual(second.scenarios.map(({ key }) => key), ["PAY-TC-PAGE-101"]);
    assert.equal(second.nextCursor, null);
    assert.throws(
      () => listScenarios(database, projectId, principalId, { kind: "regression", limit: 100, cursor: first.nextCursor! }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );

    createScenario(database, scenarioInput("PAY-TC-PAGE-102", "Nova revisão de catálogo"));
    assert.throws(
      () => listScenarios(database, projectId, principalId, { kind: "acceptance", limit: 100, cursor: first.nextCursor! }),
      (error: unknown) => error instanceof ApplicationError && error.code === "STALE_CURSOR",
    );
  });

  it("requires a human QA publisher and prevents cross-project coverage references", () => {
    assert.throws(
      () => createScenario(database, {
        ...scenarioInput("PAY-TC-BAD", "Pedido inválido"),
        coverage: [{ targetType: "criterion", reference: randomUUID() }],
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "NOT_FOUND",
    );
    const draft = createScenario(database, scenarioInput("PAY-TC-03", "Pedido inválido")).value;
    const serviceId = createPrincipal("service", "qa");
    assert.throws(
      () => publishScenarioRevision(database, {
        projectId, principalId: serviceId, requestId: "scenario-publish-service", scenarioIdOrKey: "PAY-TC-03",
        revisionNumber: draft.revisionNumber, expectedVersion: 1,
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN",
    );
  });

  it("records run origin and evidence hash, and trusts ci only with a matching successful workflow run", () => {
    createScenario(database, scenarioInput("PAY-TC-01", "Pedido confirmado"));
    publishScenarioRevision(database, {
      projectId, principalId, requestId: "origin-publish", scenarioIdOrKey: "PAY-TC-01", revisionNumber: 1, expectedVersion: 1,
    });
    const sha = "ab12cd34ef567890ab12cd34ef567890ab12cd34";
    const digest = "a".repeat(64);

    const observed = recordTestRun(database, { ...runInput("origin-default", "git-ab12cd3", "passed", 1), evidenceSha256: digest.toUpperCase() }).value;
    assert.equal(observed.origin, "agent");
    assert.equal(observed.evidenceSha256, digest);
    const human = recordTestRun(database, { ...runInput("origin-human", "git-ab12cd3", "passed", 1), origin: "human" }).value;
    assert.equal(human.origin, "human");
    assert.equal(human.evidenceSha256, null);

    assert.throws(
      () => recordTestRun(database, { ...runInput("origin-bad-hash", "build-1", "passed", 1), evidenceSha256: "xyz" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
    for (const buildId of ["build-1", "git-ab12cd3"]) {
      assert.throws(
        () => recordTestRun(database, { ...runInput(`origin-ci-${buildId}`, buildId, "passed", 1), origin: "ci" }),
        (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED" &&
          /build id|workflow run/u.test(error.message),
      );
    }

    const insertWorkflowRun = (workflowRunId: string, status: string, conclusion: string | null, headSha: string): void => {
      const receiptId = randomUUID();
      database.prepare(
        `INSERT INTO webhook_receipts (receipt_id, provider, delivery_id, project_id, principal_id, event_type, payload_sha256, receipt_json, received_at)
         VALUES (?, 'github', ?, ?, ?, 'workflow_run', ?, '{}', ?)`,
      ).run(receiptId, `delivery-${receiptId}`, projectId, principalId, "b".repeat(64), new Date().toISOString());
      database.prepare(
        `INSERT INTO github_workflow_run_events
          (event_id, receipt_id, project_id, repository_id, repository_full_name, workflow_run_id, run_number, name, status,
           conclusion, html_url, head_branch, head_sha, pull_request_numbers_json, work_item_id, work_item_key, received_at)
         VALUES (?, ?, ?, '1', 'org/repo', ?, 1, 'ci', ?, ?, 'https://github.com/org/repo/actions/runs/1', 'main', ?, '[]', NULL, NULL, ?)`,
      ).run(randomUUID(), receiptId, projectId, workflowRunId, status, conclusion, headSha, new Date().toISOString());
    };
    insertWorkflowRun("900", "completed", "failure", sha);
    assert.throws(
      () => recordTestRun(database, { ...runInput("origin-ci-failed", "git-ab12cd3", "passed", 1), origin: "ci" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
    insertWorkflowRun("901", "completed", "success", sha);
    const verified = recordTestRun(database, { ...runInput("origin-ci-ok", "git-ab12cd3", "passed", 1), origin: "ci" }).value;
    assert.equal(verified.origin, "ci");
    assert.throws(
      () => recordTestRun(database, { ...runInput("origin-ci-other", "git-ffffff0", "passed", 1), origin: "ci" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );

    const page = listTestRunPage(database, projectId, principalId, {});
    assert.deepEqual(
      page.runs.map((run) => run.origin).sort(),
      ["agent", "ci", "human"],
    );
  });

  it("imports a JUnit report by scenario tag, folds cases, hashes the report and stays idempotent", () => {
    createScenario(database, scenarioInput("PAY-TC-01", "Pedido confirmado"));
    createScenario(database, scenarioInput("PAY-TC-02", "Pedido recusado"));
    createScenario(database, scenarioInput("PAY-TC-03", "Rascunho nunca publicado"));
    for (const [index, key] of ["PAY-TC-01", "PAY-TC-02"].entries()) {
      publishScenarioRevision(database, {
        projectId, principalId, requestId: `junit-pub-${index}`, scenarioIdOrKey: key, revisionNumber: 1, expectedVersion: 1,
      });
    }
    const xml = `<?xml version="1.0"?>
<testsuites><testsuite name="s">
  <testcase classname="checkout" name="PAY-TC-01 confirma pedido"/>
  <testcase classname="checkout" name="PAY-TC-01 gera identificador"><failure message="boom &amp; co"/></testcase>
  <testcase classname="checkout" name="outro caso"><properties><property name="scenario" value="PAY-TC-02"/></properties><skipped/></testcase>
  <testcase classname="checkout" name="PAY-TC-03 ainda rascunho"/>
  <testcase classname="checkout" name="PAY-TC-011 nao e o 01"/>
</testsuite></testsuites>`;
    const input = { projectId, principalId, requestId: "junit-1", buildId: "git-abc1234", xml };
    const report = importJunitReport(database, input);
    assert.equal(report.testCases, 5);
    assert.equal(report.evidenceSha256.length, 64);
    const byKey = Object.fromEntries(report.imported.map((item) => [item.scenarioKey, item]));
    assert.equal(byKey["PAY-TC-01"]?.result, "failed");
    assert.equal(byKey["PAY-TC-01"]?.cases, 2);
    assert.equal(byKey["PAY-TC-02"]?.result, "skipped");
    assert.equal(byKey["PAY-TC-02"]?.run.evidenceSha256, report.evidenceSha256);
    assert.equal(byKey["PAY-TC-02"]?.run.origin, "agent");
    assert.equal(report.imported.length, 2);
    assert.equal(report.unmatched.length, 2);

    const replay = importJunitReport(database, input);
    assert.deepEqual(replay.imported.map((item) => item.run.id), report.imported.map((item) => item.run.id));
    assert.equal(listTestRunPage(database, projectId, principalId, {}).runs.length, 2);

    assert.throws(
      () => importJunitReport(database, { ...input, requestId: "junit-ci", origin: "ci" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
    assert.throws(
      () => importJunitReport(database, { ...input, requestId: "junit-none", xml: "<testsuite><testcase name=\"nada\"/></testsuite>" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED" && /nothing to import/u.test(error.message),
    );
    assert.throws(
      () => importJunitReport(database, { ...input, requestId: "junit-dtd", xml: "<!DOCTYPE x [<!ENTITY a 'b'>]><testsuite><testcase name=\"PAY-TC-01\"/></testsuite>" }),
      /DOCTYPE/u,
    );
    assert.throws(
      () => importJunitReport(database, { ...input, requestId: "junit-empty", xml: "<testsuite/>" }),
      /no testcase/u,
    );
  });

  function scenarioInput(key: string, title: string) {
    return {
      projectId,
      principalId,
      requestId: `scenario-${randomUUID()}`,
      key,
      kind: "acceptance" as const,
      title,
      preconditions: ["Cliente possui conta ativa"],
      steps: [{ action: "Confirmar o pedido", expected: "Pedido recebe identificador" }],
      coverage: [
        { targetType: "criterion" as const, reference: criterionRef },
        { targetType: "specification" as const, reference: specificationId },
      ],
    };
  }

  function runInput(requestId: string, buildId: string, result: "passed" | "failed" | "blocked", revisionNumber: number) {
    return {
      projectId,
      principalId,
      requestId,
      scenarioIdOrKey: "PAY-TC-01",
      revisionNumber,
      buildId,
      result,
    };
  }

  function createPrincipal(type: "service", role: "qa"): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    database.prepare(
      "INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, type, `test:${id}`, type, now);
    database.prepare(
      "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)",
    ).run(projectId, id, role, now);
    return id;
  }
});
