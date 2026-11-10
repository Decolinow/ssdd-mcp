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
import { getScenario, listScenarios, searchScenariosByCriterion } from "../../src/application/scenario-queries.js";
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
    assert.equal(listScenarios(database, projectId, principalId, "acceptance")[0]?.key, "PAY-TC-01");
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
