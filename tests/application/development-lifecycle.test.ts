import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { getDeveloperExecutionMetrics, listDeploymentEvents, listDevelopmentSessions, recordDeployment, startDevelopmentSession, transitionDevelopmentSession } from "../../src/application/development-lifecycle.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createScenario, publishScenarioRevision, recordTestRun } from "../../src/application/scenario-commands.js";
import { createSpecification, publishSpecificationRevision } from "../../src/application/specification-commands.js";
import { addTraceLink } from "../../src/application/trace-commands.js";
import { getTaskContext } from "../../src/application/task-context.js";
import { assignWorkItem } from "../../src/application/work-item-commands.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("development sessions, task QA links, release events and developer metrics", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let featureId: string;
  let storyId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-dev-lifecycle-"));
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
    const epic = createWorkItem(database, itemInput("epic", "Payments")).value;
    featureId = createWorkItem(database, itemInput("feature", "Checkout", epic.id)).value.id;
    storyId = createWorkItem(database, itemInput("story", "Confirmar pedido", featureId)).value.id;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("pins technical and scenario revisions to the started task session and links exact QA runs", () => {
    const task = createTask("Integrar confirmação");
    const specification = createSpecification(database, {
      projectId, principalId, requestId: "spec-create", key: "ADR-PAY-1", kind: "adr", title: "Idempotência de pagamento",
      content: { decision: "Usar chave por pedido." },
    }).value;
    publishSpecificationRevision(database, {
      projectId, principalId, requestId: "spec-publish", specIdOrKey: specification.specId, revisionNumber: 1, expectedVersion: 1,
    });
    addTraceLink(database, {
      projectId, principalId, requestId: "task-implements-spec", sourceIdOrKey: task.id, targetIdOrKey: specification.specId, type: "implements",
    });
    const scenario = createScenario(database, {
      projectId, principalId, requestId: "task-scenario-create", key: "PAY-TC-01", kind: "integration",
      title: "Pagamento idempotente", steps: [{ action: "Repetir a requisição", expected: "Um pedido é criado" }], workItemIdOrKeys: [task.id],
    }).value;
    publishScenarioRevision(database, {
      projectId, principalId, requestId: "task-scenario-publish", scenarioIdOrKey: scenario.key, revisionNumber: 1, expectedVersion: 1,
    });

    const started = startDevelopmentSession(database, {
      projectId, principalId, requestId: "session-start", itemIdOrKey: task.id, expectedVersion: task.version, sessionReference: "codex-thread:dev-42",
    });
    const retry = startDevelopmentSession(database, {
      projectId, principalId, requestId: "session-start", itemIdOrKey: task.id, expectedVersion: task.version, sessionReference: "codex-thread:dev-42",
    });
    assert.equal(retry.value.id, started.value.id);
    assert.equal(started.value.technicalSpecifications[0]?.revisionNumber, 1);
    assert.equal(started.value.scenarios[0]?.revisionNumber, 1);
    assert.equal(listDevelopmentSessions(database, { projectId, principalId, itemIdOrKey: task.key })[0]?.sessionReference, "codex-thread:dev-42");

    const run = recordTestRun(database, {
      projectId, principalId, requestId: "task-run", scenarioIdOrKey: scenario.key, revisionNumber: 1,
      buildId: "build-50", result: "passed", workItemIdOrKeys: [task.id],
    }).value;
    const context = getTaskContext(database, {
      projectId, principalId, taskIdOrKey: task.id,
      include: ["technicalDecisions", "scenarios", "testRuns"],
    });
    assert.equal(context.sections.technicalDecisions[0]?.source.revisionNumber, 1);
    assert.equal(context.sections.technicalDecisions[0]?.source.mode, "pinned");
    assert.equal(context.sections.technicalDecisions[0]?.source.relationship, "task_direct_link");
    assert.equal(context.sections.technicalDecisions[0]?.source.pinSource, "development_session");
    assert.equal(context.sections.scenarios[0]?.source.revisionNumber, 1);
    assert.equal(context.sections.scenarios[0]?.source.pinSource, "development_session");
    assert.ok(context.sections.testRuns.some((entry) => entry.source.entityId === run.id && (entry.content as { readonly buildId?: unknown }).buildId === "build-50"));
    assert.equal(context.sections.testRuns[0]?.source.relationship, "task_run_link");

    const sourceEventCount = database.prepare("SELECT COUNT(*) AS count FROM development_session_events WHERE session_id = ?")
      .get(started.value.id) as { count: number };
    assert.equal(sourceEventCount.count, 1, "the idempotent retry does not append a second start event");
  });

  it("keeps the original developer's session through reassignment and accumulates active time across pauses", () => {
    const task = createTask("Implementar autorização");
    const secondDeveloperId = createDeveloper("dev-two", "Developer Two");
    const original = startDevelopmentSession(database, {
      projectId, principalId, requestId: "session-original-start", itemIdOrKey: task.id, expectedVersion: task.version,
    }).value;
    database.prepare("UPDATE development_sessions SET last_resumed_at = ? WHERE session_id = ?")
      .run(new Date(Date.now() - 10_000).toISOString(), original.id);
    const paused = transitionDevelopmentSession(database, {
      projectId, principalId, requestId: "session-original-pause", sessionId: original.id, action: "pause", expectedVersion: 1, reason: "Aguardando revisão de API.",
    }).value;
    assert.equal(paused.status, "paused");
    assert.ok(paused.activeSeconds >= 8);

    assignWorkItem(database, {
      projectId, principalId, requestId: "reassign-task", itemIdOrKey: task.id, assigneeId: secondDeveloperId, expectedVersion: task.version,
    });
    const reassigned = getItemVersion(task.id);
    const second = startDevelopmentSession(database, {
      projectId, principalId: secondDeveloperId, requestId: "session-second-start", itemIdOrKey: task.id, expectedVersion: reassigned.version,
    }).value;
    assert.equal(second.developerPrincipalId, secondDeveloperId);
    const originalCompleted = transitionDevelopmentSession(database, {
      projectId, principalId, requestId: "session-original-complete", sessionId: original.id, action: "complete", expectedVersion: paused.version, reason: "Entrega transferida.",
    }).value;
    assert.equal(originalCompleted.status, "completed");
    assert.equal(originalCompleted.developerPrincipalId, principalId);
    assert.throws(() => transitionDevelopmentSession(database, {
      projectId, principalId, requestId: "session-second-owned-by-other", sessionId: second.id, action: "complete", expectedVersion: second.version, reason: "Não sou responsável por esta sessão.",
    }), (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN");
    const secondCompleted = transitionDevelopmentSession(database, {
      projectId, principalId: secondDeveloperId, requestId: "session-second-complete", sessionId: second.id, action: "complete", expectedVersion: second.version, reason: "Implementação concluída.",
    }).value;
    assert.equal(secondCompleted.status, "completed");
  });

  it("requires homologation of the same successful build before production and preserves rollback history", () => {
    const task = createTask("Validar produção");
    database.prepare("UPDATE work_items SET state = 'done' WHERE project_id = ? AND item_id = ?").run(projectId, task.id);
    const failed = recordDeployment(database, {
      projectId, principalId, requestId: "homol-failed", environment: "homologation", buildId: "build-80", outcome: "failed", itemIdOrKeys: [task.id],
    }).value;
    assert.equal(failed.outcome, "failed");
    assert.throws(() => recordDeployment(database, {
      projectId, principalId, requestId: "prod-blocked", environment: "production", buildId: "build-80", outcome: "succeeded", itemIdOrKeys: [task.id],
    }), (error: unknown) => error instanceof ApplicationError && error.code === "GATE_BLOCKED");

    const homologation = recordDeployment(database, {
      projectId, principalId, requestId: "homol-pass", environment: "homologation", buildId: "build-81", outcome: "succeeded", itemIdOrKeys: [task.id],
    }).value;
    assert.throws(() => recordDeployment(database, {
      projectId, principalId, requestId: "prod-mismatch", environment: "production", buildId: "build-82", outcome: "succeeded", itemIdOrKeys: [task.id],
    }), (error: unknown) => error instanceof ApplicationError && error.code === "GATE_BLOCKED");
    const production = recordDeployment(database, {
      projectId, principalId, requestId: "prod-pass", environment: "production", buildId: "build-81", outcome: "succeeded", itemIdOrKeys: [task.id],
    }).value;
    const rollback = recordDeployment(database, {
      projectId, principalId, requestId: "prod-rollback", environment: "production", buildId: "build-81-rb", outcome: "rolled_back",
      rollbackOfEventId: production.id, itemIdOrKeys: [task.id],
    }).value;
    assert.equal(rollback.rollbackOfEventId, production.id);
    const eventIds = listDeploymentEvents(database, { projectId, principalId, itemIdOrKey: task.key }).map((event) => event.id);
    assert.deepEqual(new Set(eventIds), new Set([rollback.id, production.id, homologation.id, failed.id]));
  });

  it("calculates descriptive per-developer effort and hides confidence below five completed tasks", () => {
    const completedTasks = Array.from({ length: 5 }, (_, index) => createTask(`Task ${index + 1}`));
    const now = new Date().toISOString();
    for (const [index, task] of completedTasks.entries()) {
      const proposalId = randomUUID();
      database.prepare(
        `INSERT INTO work_item_estimate_proposals
          (proposal_id, project_id, item_id, unit, value, rationale, status, proposed_by_principal_id, proposed_at, resolved_by_principal_id, resolved_at)
         VALUES (?, ?, ?, 'hours', 1, 'estimativa de fixture', 'confirmed', ?, ?, ?, ?)`,
      ).run(proposalId, projectId, task.id, principalId, now, principalId, now);
      database.prepare(
        `INSERT INTO work_item_estimates (project_id, item_id, unit, value, proposal_id, confirmed_by_principal_id, confirmed_at)
         VALUES (?, ?, 'hours', 1, ?, ?, ?)`,
      ).run(projectId, task.id, proposalId, principalId, now);
      const session = startDevelopmentSession(database, {
        projectId, principalId, requestId: `metric-start-${index}`, itemIdOrKey: task.id, expectedVersion: task.version,
      }).value;
      database.prepare("UPDATE development_sessions SET last_resumed_at = ? WHERE session_id = ?")
        .run(new Date(Date.now() - 3_600_000).toISOString(), session.id);
      transitionDevelopmentSession(database, {
        projectId, principalId, requestId: `metric-complete-session-${index}`, sessionId: session.id, action: "complete", expectedVersion: 1, reason: "Task concluída.",
      });
      const completedAt = new Date().toISOString();
      database.prepare("UPDATE work_items SET state = 'done', version = version + 1 WHERE project_id = ? AND item_id = ?")
        .run(projectId, task.id);
      database.prepare(
        `INSERT INTO work_item_state_transitions
          (transition_id, project_id, item_id, from_state, to_state, item_version, reason, transitioned_by_principal_id, transitioned_at)
         VALUES (?, ?, ?, 'in_progress', 'done', ?, 'QA concluída', ?, ?)`,
      ).run(randomUUID(), projectId, task.id, task.version + 1, principalId, completedAt);
    }
    const date = new Date().toISOString().slice(0, 10);
    const metrics = getDeveloperExecutionMetrics(database, { projectId, principalId, from: date, to: date });
    assert.equal(metrics.minimumSampleTasks, 5);
    assert.equal(metrics.developers[0]?.completedTasks, 5);
    assert.equal(metrics.developers[0]?.sampleSufficient, true);
    assert.equal(metrics.developers[0]?.activeHours, 5);
    assert.equal(metrics.developers[0]?.estimateVariancePercent, 0);
    assert.equal(metrics.developers[0]?.effortCalibrationFactor, 1);

    const lowSample = getDeveloperExecutionMetrics(database, { projectId, principalId, from: date, to: date, developerPrincipalId: principalId });
    assert.equal(lowSample.developers[0]?.sampleSufficient, true);

    const newDeveloperId = createDeveloper("dev-low-sample", "Developer Low Sample");
    const oneTask = createTask("Uma tarefa isolada");
    assignWorkItem(database, {
      projectId, principalId, requestId: "low-sample-reassign", itemIdOrKey: oneTask.id,
      assigneeId: newDeveloperId, expectedVersion: oneTask.version,
    });
    const session = startDevelopmentSession(database, {
      projectId, principalId: newDeveloperId, requestId: "low-sample-start", itemIdOrKey: oneTask.id, expectedVersion: oneTask.version + 1,
    }).value;
    transitionDevelopmentSession(database, {
      projectId, principalId: newDeveloperId, requestId: "low-sample-stop", sessionId: session.id,
      action: "complete", expectedVersion: 1, reason: "Concluída sem estimativa confirmada.",
    });
    const completedAt = new Date().toISOString();
    database.prepare("UPDATE work_items SET state = 'done', version = version + 1 WHERE project_id = ? AND item_id = ?")
      .run(projectId, oneTask.id);
    database.prepare(
      `INSERT INTO work_item_state_transitions
        (transition_id, project_id, item_id, from_state, to_state, item_version, reason, transitioned_by_principal_id, transitioned_at)
       VALUES (?, ?, ?, 'in_progress', 'done', ?, 'QA concluída', ?, ?)`,
    ).run(randomUUID(), projectId, oneTask.id, oneTask.version + 2, newDeveloperId, completedAt);
    const oneTaskSample = getDeveloperExecutionMetrics(database, {
      projectId, principalId, from: date, to: date, developerPrincipalId: newDeveloperId,
    }).developers[0];
    assert.equal(oneTaskSample?.completedTasks, 1);
    assert.equal(oneTaskSample?.sampleSufficient, false);
    assert.equal(oneTaskSample?.estimateVariancePercent, null);
    assert.equal(oneTaskSample?.effortCalibrationFactor, null);
  });

  function createTask(title: string) {
    const task = createWorkItem(database, {
      projectId, principalId, requestId: `task-${randomUUID()}`, type: "task", parentId: storyId, title, description: `Resultado de ${title}`,
    }).value;
    database.prepare("UPDATE work_items SET state = 'in_progress', assignee_principal_id = ? WHERE project_id = ? AND item_id = ?")
      .run(principalId, projectId, task.id);
    return task;
  }

  function createDeveloper(identitySuffix: string, displayName: string): string {
    const developerId = randomUUID();
    database.prepare("INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at) VALUES (?, 'human', ?, ?, ?)")
      .run(developerId, `test:${identitySuffix}`, displayName, new Date().toISOString());
    database.prepare("INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, 'developer', ?)")
      .run(projectId, developerId, new Date().toISOString());
    return developerId;
  }

  function getItemVersion(itemId: string): { version: number } {
    return database.prepare("SELECT version FROM work_items WHERE project_id = ? AND item_id = ?").get(projectId, itemId) as { version: number };
  }

  function itemInput(type: "epic" | "feature" | "story", title: string, parentId?: string) {
    return { projectId, principalId, requestId: `${type}-${randomUUID()}`, type, title, ...(parentId === undefined ? {} : { parentId }) } as const;
  }
});
