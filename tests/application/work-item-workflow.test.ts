import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { addWorkItemEvidence, certifyTestRun, getWorkItemGateReport, listWorkItemEvidence, transitionWorkItem } from "../../src/application/work-item-workflow.js";
import { listAuditEvents } from "../../src/application/audit-queries.js";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { getWorkItemQualityReport, listProjectQualitySummaries } from "../../src/application/quality-queries.js";
import { assignWorkItem, confirmWorkItemEstimate, proposeWorkItemEstimate } from "../../src/application/work-item-commands.js";
import { getWorkItem } from "../../src/application/work-item-queries.js";
import { createScenario, publishScenarioRevision, recordTestRun } from "../../src/application/scenario-commands.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import type { WorkItemState } from "../../src/domain/work-items.js";

describe("work item workflow, evidence and QA gates", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let storyId: string;
  let storyKey: string;
  let criterionId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-workflow-"));
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
      projectId, principalId, requestId: requestId("epic"), type: "epic", title: "Pagamentos",
    }).value;
    const feature = createWorkItem(database, {
      projectId, principalId, requestId: requestId("feature"), type: "feature", parentId: epic.id, title: "Checkout",
    }).value;
    const story = createWorkItem(database, {
      projectId,
      principalId,
      requestId: requestId("story"),
      type: "story",
      parentId: feature.id,
      title: "Confirmar pedido",
      description: "Confirmar um pedido válido e informar o identificador.",
      criteria: [{ description: "Pedido válido recebe identificador" }],
    }).value;
    storyId = story.id;
    storyKey = story.key;
    criterionId = story.criteria[0]!.id;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("blocks Ready until coverage and estimate are ready, then creates the PBI baseline atomically", () => {
    const initialReport = getWorkItemGateReport(database, {
      projectId, principalId, itemIdOrKey: storyKey, targetState: "ready",
    });
    assert.equal(initialReport.canProceed, false);
    assert.deepEqual(initialReport.gates.filter((gate) => !gate.passed).map((gate) => gate.id), [
      "required-criterion-coverage", "confirmed-estimate",
    ]);

    const scenario = createPublishedScenario();
    confirmStoryPoints();
    const readyReport = getWorkItemGateReport(database, {
      projectId, principalId, itemIdOrKey: storyId, targetState: "ready",
    });
    assert.equal(readyReport.canProceed, true);

    const ready = transition("ready");
    assert.equal(ready.transition.fromState, "draft");
    assert.equal(ready.transition.toState, "ready");
    assert.equal(ready.transition.itemVersion, getWorkItem(database, projectId, principalId, storyId).version);
    assert.deepEqual(ready.baseline, { id: ready.transition.baselineId, sequence: 1 });
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM work_baselines WHERE item_id = ?")
      .get(storyId) as { count: number }).count, 1);

    transition("in_progress");
    transition("in_review");
    transition("in_validation");
    addEvidence(storyId, "build", "https://ci.example/builds/candidate-42", "candidate-42", "Candidato de release");

    recordRun(scenario.scenarioId, "build-41", "passed", "old-build-pass");
    const mismatch = getWorkItemGateReport(database, {
      projectId, principalId, itemIdOrKey: storyId, targetState: "done", buildId: "candidate-42",
    });
    const buildGate = mismatch.gates.find((gate) => gate.id.endsWith(":build"));
    assert.equal(buildGate?.passed, false);
    assert.deepEqual((buildGate?.details as { availableBuilds: Array<{ buildId: string }> }).availableBuilds.map(({ buildId }) => buildId), ["build-41"]);

    recordRun(scenario.scenarioId, "candidate-42", "failed", "candidate-failed");
    const failed = getWorkItemGateReport(database, {
      projectId, principalId, itemIdOrKey: storyId, targetState: "done", buildId: "candidate-42",
    });
    assert.ok(failed.gates.some((gate) => gate.id.endsWith(":result") && !gate.passed));

    const passedRun = recordRun(scenario.scenarioId, "candidate-42", "passed", "candidate-passed");
    const itemBeforeCertification = getWorkItem(database, projectId, principalId, storyId);
    const certification = certifyTestRun(database, {
      projectId,
      principalId,
      requestId: requestId("certify"),
      itemIdOrKey: storyId,
      runId: passedRun.id,
      expectedVersion: itemBeforeCertification.version,
      reason: "QA conferiu a execução do build candidato.",
    });
    assert.equal(certification.value.certifiedByPrincipalId, principalId);
    assert.equal(certification.value.baselineId, ready.baseline?.id);

    const doneReport = getWorkItemGateReport(database, {
      projectId, principalId, itemIdOrKey: storyId, targetState: "done", buildId: "candidate-42",
    });
    assert.equal(doneReport.canProceed, true);
    const done = transition("done", "candidate-42");
    assert.equal(done.transition.toState, "done");
    assert.equal(done.transition.buildId, "candidate-42");
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM work_item_state_transitions WHERE item_id = ?")
      .get(storyId) as { count: number }).count, 5);

    const quality = getWorkItemQualityReport(database, { projectId, principalId, itemIdOrKey: storyId });
    assert.equal(quality.mode, "pinned");
    assert.equal(quality.baseline?.sequence, 1);
    assert.deepEqual([quality.requiredCriteria, quality.coveredRequiredCriteria, quality.coveragePercent], [1, 1, 100]);
    const qualityRuns = quality.criteria[0]?.scenarios[0]?.latestRuns ?? [];
    assert.ok(qualityRuns.some(({ run }) => run.buildId === "build-41" && run.result === "passed"));
    assert.ok(qualityRuns.some(({ run, certification: reportCertification }) =>
      run.buildId === "candidate-42" && run.result === "passed" && reportCertification?.id === certification.value.id));
    assert.equal(quality.evidence.length, 1);

    const summaries = listProjectQualitySummaries(database, { projectId, principalId });
    assert.deepEqual(
      summaries.find(({ itemId }) => itemId === storyId),
      {
        itemId: storyId,
        itemKey: storyKey,
        type: "story",
        title: "Confirmar pedido",
        state: "done",
        version: getWorkItem(database, projectId, principalId, storyId).version,
        baselineId: ready.baseline?.id,
        baselineSequence: 1,
        requiredCriteria: 1,
        coveredRequiredCriteria: 1,
        coveragePercent: 100,
      },
    );

    const firstAuditPage = listAuditEvents(database, {
      projectId, principalId, entityType: "work_item", entityId: storyId, limit: 2,
    });
    assert.equal(firstAuditPage.events.length, 2);
    assert.ok(firstAuditPage.nextCursor);
    assert.equal(firstAuditPage.events[0]?.eventType, "work_item.state_transitioned");
    const latestTransitionId = (database.prepare(
      "SELECT transition_id FROM work_item_state_transitions WHERE project_id = ? AND item_id = ? ORDER BY item_version DESC LIMIT 1",
    ).get(projectId, storyId) as { transition_id: string }).transition_id;
    const latestTransitionPayload = firstAuditPage.events[0]?.payload as { toState: string; transitionId: string };
    assert.equal(latestTransitionPayload.toState, "done");
    assert.equal(latestTransitionPayload.transitionId, latestTransitionId);
    assert.equal(firstAuditPage.events[0]?.reason, "Avançar para done.");
    assert.equal(listAuditEvents(database, {
      projectId, principalId, entityType: "work_item", entityId: storyId, limit: 2,
      cursor: firstAuditPage.nextCursor!,
    }).events.length, 2);
    addEvidence(storyId, "other", "https://docs.example/retro", null, "Evento posterior para invalidar o cursor");
    assert.throws(
      () => listAuditEvents(database, {
        projectId, principalId, entityType: "work_item", entityId: storyId, limit: 2,
        cursor: firstAuditPage.nextCursor!,
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "STALE_CURSOR",
    );
  });

  it("requires task preparation and task-owned evidence before Done", () => {
    createPublishedScenario();
    confirmStoryPoints();
    const baselineId = transition("ready").baseline?.id;
    assert.ok(baselineId);
    const developerId = createMember("developer");
    const task = createWorkItem(database, {
      projectId,
      principalId: developerId,
      requestId: requestId("task"),
      type: "task",
      parentId: storyId,
      title: "Implementar confirmação",
      description: "Persistir o identificador retornado pela confirmação.",
    }).value;
    const unassigned = getWorkItemGateReport(database, {
      projectId, principalId, itemIdOrKey: task.id, targetState: "ready",
    });
    assert.equal(unassigned.canProceed, false);
    assert.ok(unassigned.gates.some((gate) => gate.id === "task-assignee" && !gate.passed));

    assignWorkItem(database, {
      projectId, principalId, requestId: requestId("assign"), itemIdOrKey: task.id,
      assigneeId: developerId, expectedVersion: task.version,
    });
    assert.equal(getWorkItemGateReport(database, {
      projectId, principalId: developerId, itemIdOrKey: task.id, targetState: "ready",
    }).canProceed, true);
    transitionItem(task.id, "ready", undefined, developerId);
    transitionItem(task.id, "in_progress", undefined, developerId);
    const evidence = addEvidence(task.id, "artifact", "https://artifacts.example/tasks/1", "candidate-42", "Implementação da tarefa");
    assert.equal(evidence.baselineId, baselineId);
    transitionItem(task.id, "in_review", undefined, developerId);
    transitionItem(task.id, "in_validation", undefined, developerId);
    const taskDone = getWorkItemGateReport(database, {
      projectId, principalId: developerId, itemIdOrKey: task.id, targetState: "done", buildId: "candidate-42",
    });
    assert.equal(taskDone.canProceed, true);
    assert.equal(transitionItem(task.id, "done", "candidate-42", developerId).toState, "done");
  });

  it("rejects agent QA certification and keeps evidence pagination immutable and stable", () => {
    const scenario = createPublishedScenario();
    confirmStoryPoints();
    transition("ready");
    transition("in_progress");
    transition("in_review");
    transition("in_validation");
    const run = recordRun(scenario.scenarioId, "candidate-42", "passed", "agent-cert-run");
    const agentId = randomUUID();
    const createdAt = new Date().toISOString();
    database.prepare(
      `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
       VALUES (?, 'agent', ?, 'QA agent', ?)`,
    ).run(agentId, `agent:${agentId}`, createdAt);
    database.prepare(
      "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, 'qa', ?)",
    ).run(projectId, agentId, createdAt);
    const before = getWorkItem(database, projectId, principalId, storyId);
    assert.throws(
      () => certifyTestRun(database, {
        projectId, principalId: agentId, requestId: requestId("agent-certify"), itemIdOrKey: storyId,
        runId: run.id, expectedVersion: before.version, reason: "Agente não pode certificar QA.",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN",
    );
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM test_run_certifications WHERE item_id = ?")
      .get(storyId) as { count: number }).count, 0);

    addEvidence(storyId, "commit", "https://git.example/commit/1", null, "Primeiro commit");
    addEvidence(storyId, "pull_request", "https://git.example/pull/2", null, "Revisão de código");
    const firstPage = listWorkItemEvidence(database, { projectId, principalId, itemIdOrKey: storyId, limit: 1 });
    assert.equal(firstPage.evidence.length, 1);
    assert.ok(firstPage.nextCursor);
    assert.throws(
      () => database.prepare("UPDATE evidence SET description = 'alterada' WHERE evidence_id = ?")
        .run(firstPage.evidence[0]?.id),
      /immutable/,
    );
    addEvidence(storyId, "other", "https://docs.example/note/3", null, "Anotação posterior");
    assert.throws(
      () => listWorkItemEvidence(database, {
        projectId, principalId, itemIdOrKey: storyId, limit: 1, cursor: firstPage.nextCursor!,
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "STALE_CURSOR",
    );
    assert.equal(listWorkItemEvidence(database, { projectId, principalId, itemIdOrKey: storyId }).evidence.length, 3);
  });

  function createPublishedScenario() {
    const scenario = createScenario(database, {
      projectId,
      principalId,
      requestId: requestId("scenario-create"),
      key: "PAY-TC-01",
      kind: "acceptance",
      title: "Pedido confirmado",
      steps: [{ action: "Confirmar pedido válido", expected: "O identificador do pedido é retornado" }],
      coverage: [{ targetType: "criterion", reference: criterionId }],
    }).value;
    publishScenarioRevision(database, {
      projectId,
      principalId,
      requestId: requestId("scenario-publish"),
      scenarioIdOrKey: scenario.scenarioId,
      revisionNumber: 1,
      expectedVersion: 1,
    });
    return scenario;
  }

  function createMember(role: "developer" | "qa"): string {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    database.prepare(
      `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
       VALUES (?, 'human', ?, ?, ?)`,
    ).run(id, `test:${id}`, `Test ${role}`, createdAt);
    database.prepare(
      "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)",
    ).run(projectId, id, role, createdAt);
    return id;
  }

  function confirmStoryPoints(): void {
    const current = getWorkItem(database, projectId, principalId, storyId);
    const proposal = proposeWorkItemEstimate(database, {
      projectId, principalId, requestId: requestId("estimate-propose"), itemIdOrKey: storyId,
      unit: "points", value: 5, rationale: "Escopo de confirmação moderado.", expectedVersion: current.version,
    }).value;
    const proposed = getWorkItem(database, projectId, principalId, storyId);
    confirmWorkItemEstimate(database, {
      projectId, principalId, requestId: requestId("estimate-confirm"), itemIdOrKey: storyId,
      proposalId: proposal.id, expectedVersion: proposed.version,
    });
  }

  function recordRun(scenarioId: string, buildId: string, result: "passed" | "failed", id: string) {
    return recordTestRun(database, {
      projectId, principalId, requestId: id, scenarioIdOrKey: scenarioId,
      revisionNumber: 1, buildId, result,
    }).value;
  }

  function addEvidence(itemIdOrKey: string, kind: "pull_request" | "commit" | "build" | "artifact" | "test_report" | "other", uri: string, buildId: string | null, description: string) {
    return addWorkItemEvidence(database, {
      projectId, principalId, requestId: requestId("evidence"), itemIdOrKey, kind, uri,
      description, ...(buildId === null ? {} : { buildId }),
    }).value;
  }

  function transition(targetState: WorkItemState, buildId?: string) {
    const current = getWorkItem(database, projectId, principalId, storyId);
    return transitionWorkItem(database, {
      projectId,
      principalId,
      requestId: requestId(`transition-${targetState}`),
      itemIdOrKey: storyId,
      targetState,
      expectedVersion: current.version,
      reason: `Avançar para ${targetState}.`,
      ...(buildId === undefined ? {} : { buildId }),
    }).value;
  }

  function transitionItem(itemIdOrKey: string, targetState: WorkItemState, buildId?: string, actorId = principalId) {
    const current = getWorkItem(database, projectId, actorId, itemIdOrKey);
    return transitionWorkItem(database, {
      projectId,
      principalId: actorId,
      requestId: requestId(`transition-${targetState}`),
      itemIdOrKey,
      targetState,
      expectedVersion: current.version,
      reason: `Avançar para ${targetState}.`,
      ...(buildId === undefined ? {} : { buildId }),
    }).value.transition;
  }
});

function requestId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
