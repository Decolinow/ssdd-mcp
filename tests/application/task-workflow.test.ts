import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { startDevelopmentSession, transitionDevelopmentSession } from "../../src/application/development-lifecycle.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { getTaskWorkflow } from "../../src/application/task-workflow-queries.js";
import { proposeTaskWorkflow, publishTaskWorkflow, transitionTaskWorkflowStep } from "../../src/application/task-workflow-commands.js";
import { startTaskDevelopment } from "../../src/application/task-development-start.js";
import { assignWorkItem } from "../../src/application/work-item-commands.js";
import { getWorkItem } from "../../src/application/work-item-queries.js";
import { getTaskStartReadiness, getWorkItemGateReport } from "../../src/application/work-item-workflow.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";

describe("versioned weighted task workflows", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let storyId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-task-workflow-"));
    const initialized = initializeProject({ workspace, key: "PAY", name: "Payments", productGoal: "Pagamentos confiáveis", timezone: "UTC" });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
      .get(projectId) as { created_by_principal_id: string }).created_by_principal_id;

    const epic = create("epic", "Pagamentos");
    const feature = create("feature", "Checkout", epic.id);
    const story = create("story", "Confirmar pedido", feature.id);
    storyId = story.id;
    const now = new Date().toISOString();
    database.prepare("UPDATE work_items SET state = 'ready' WHERE project_id = ? AND item_id = ?").run(projectId, storyId);
    database.prepare(
      `INSERT INTO work_baselines (baseline_id, project_id, item_id, sequence, kind, reason, created_by_principal_id, created_at)
       VALUES (?, ?, ?, 1, 'ready', 'Baseline da fixture', ?, ?)`,
    ).run(randomUUID(), projectId, storyId, principalId, now);
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("validates effort totals and withdraws a replaced Draft without losing its history", () => {
    const task = createReadyTask("Validar callback de pagamento");
    assert.throws(() => propose({
      task, requestId: "workflow-bad-total", expectedWorkflowVersion: 0,
      steps: [{ title: "Implementar", description: "Criar implementação e testes.", effortPercent: 99.99 }],
    }), (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED");

    const first = propose({
      task, requestId: "workflow-draft-first", expectedWorkflowVersion: 0,
      steps: [{ title: "Implementar", description: "Criar implementação e testes.", effortPercent: 100 }],
    }).value;
    const currentTask = getWorkItem(database, projectId, principalId, task.id);
    const second = propose({
      task: currentTask, requestId: "workflow-draft-second", expectedWorkflowVersion: first.revisionNumber,
      steps: [
        { title: "Implementar", description: "Criar implementação e testes.", effortPercent: 70 },
        { title: "Revisar", description: "Executar revisão funcional e técnica.", effortPercent: 30 },
      ],
    }).value;
    const history = database.prepare(
      "SELECT revision_number, status FROM task_workflow_revisions WHERE project_id = ? AND item_id = ? ORDER BY revision_number",
    ).all(projectId, task.id) as Array<{ revision_number: number; status: string }>;
    assert.deepEqual(history, [{ revision_number: 1, status: "withdrawn" }, { revision_number: 2, status: "draft" }]);
    assert.equal(second.status, "draft");
    assert.equal(getTaskWorkflow(database, { projectId, principalId, taskIdOrKey: task.id }).draft?.revisionNumber, 2);
    assert.equal(getWorkItemGateReport(database, {
      projectId, principalId, itemIdOrKey: task.id, targetState: "ready",
    }).gates.find((gate) => gate.id === "task-workflow-publication")?.passed, false);
    assert.ok(getTaskStartReadiness(database, { projectId, principalId, itemIdOrKey: task.id }).blockers.some((blocker) => blocker.code === "task_workflow_unpublished"));
  });

  it("derives progress only from completed effort, pins sessions, and carries unchanged steps across revisions", () => {
    const task = createReadyTask("Implementar autorização de captura");
    const proposed = propose({
      task, requestId: "workflow-propose-main", expectedWorkflowVersion: 0,
      steps: [
        { title: "Implementar regra", description: "Adicionar validação de autorização e seus testes.", effortPercent: 60 },
        { title: "Revisar comportamento", description: "Validar os cenários de sucesso e recusa.", effortPercent: 40 },
      ],
    }).value;
    const published = publishTaskWorkflow(database, {
      projectId, principalId, requestId: "workflow-publish-main", taskIdOrKey: task.id,
      revisionNumber: proposed.revisionNumber, expectedTaskVersion: getWorkItem(database, projectId, principalId, task.id).version,
      reason: "Revisão humana da decomposição de esforço.",
    }).value.workflow;
    const readyGate = getWorkItemGateReport(database, { projectId, principalId, itemIdOrKey: task.id, targetState: "ready" });
    assert.equal(readyGate.gates.find((gate) => gate.id === "task-workflow-publication")?.passed, true);

    const started = startTaskDevelopment(database, {
      projectId, principalId, requestId: "workflow-start-task", itemIdOrKey: task.id,
      expectedVersion: getWorkItem(database, projectId, principalId, task.id).version,
      reason: "Iniciar a implementação pelas etapas planejadas.",
    }).value;
    assert.equal(started.session.taskWorkflowRevisionNumber, published.revisionNumber);
    assert.equal((database.prepare("SELECT revision_number FROM development_session_workflow_refs WHERE session_id = ?")
      .get(started.session.id) as { revision_number: number }).revision_number, published.revisionNumber);

    let taskVersion = started.task.version;
    assert.throws(() => transitionTaskWorkflowStep(database, {
      projectId, principalId, requestId: "workflow-step-out-of-order", taskIdOrKey: task.id,
      revisionNumber: published.revisionNumber, stepId: published.steps[1]!.id, expectedTaskVersion: taskVersion,
      targetStatus: "in_progress", reason: "A segunda etapa não pode começar antes da primeira.",
    }), (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_TRANSITION");
    assert.throws(() => transitionTaskWorkflowStep(database, {
      projectId, principalId, requestId: "workflow-step-skip-start", taskIdOrKey: task.id,
      revisionNumber: published.revisionNumber, stepId: published.steps[0]!.id, expectedTaskVersion: taskVersion,
      targetStatus: "done", reason: "A etapa não pode ignorar o início.",
    }), (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_TRANSITION");
    const inProgress = transitionTaskWorkflowStep(database, {
      projectId, principalId, requestId: "workflow-step-progress", taskIdOrKey: task.id,
      revisionNumber: published.revisionNumber, stepId: published.steps[0]!.id, expectedTaskVersion: taskVersion,
      targetStatus: "in_progress", reason: "Implementação iniciada.",
    }).value;
    taskVersion = inProgress.taskVersion;
    assert.equal(inProgress.progressPercent, 0, "an in-progress step does not count as completed effort");

    const completed = transitionTaskWorkflowStep(database, {
      projectId, principalId, requestId: "workflow-step-done", taskIdOrKey: task.id,
      revisionNumber: published.revisionNumber, stepId: published.steps[0]!.id, expectedTaskVersion: taskVersion,
      targetStatus: "done", reason: "A implementação e os testes passaram.",
    }).value;
    taskVersion = completed.taskVersion;
    assert.equal(completed.progressPercent, 60);
    const gateBeforeAllSteps = getWorkItemGateReport(database, { projectId, principalId, itemIdOrKey: task.id, targetState: "done" });
    assert.equal(gateBeforeAllSteps.gates.find((gate) => gate.id === "task-workflow-complete")?.passed, false);
    assert.equal((gateBeforeAllSteps.gates.find((gate) => gate.id === "task-workflow-complete")?.details as { progressPercent: number }).progressPercent, 60);

    transitionDevelopmentSession(database, {
      projectId, principalId, requestId: "workflow-close-first-session", sessionId: started.session.id,
      action: "complete", expectedVersion: started.session.version, reason: "Etapas executadas conforme o plano.",
    });
    const draft = proposeTaskWorkflow(database, {
      projectId, principalId, requestId: "workflow-revise", taskIdOrKey: task.id,
      expectedTaskVersion: taskVersion, expectedWorkflowVersion: published.revisionNumber,
      reason: "Ajustar estimativa e detalhar a revisão.",
      steps: [
        { id: published.steps[0]!.id, title: published.steps[0]!.title, description: published.steps[0]!.description, effortPercent: 50 },
        { id: published.steps[1]!.id, title: "Revisão reforçada", description: published.steps[1]!.description, effortPercent: 50 },
      ],
    }).value;
    const publication = publishTaskWorkflow(database, {
      projectId, principalId, requestId: "workflow-publish-revision", taskIdOrKey: task.id,
      revisionNumber: draft.revisionNumber, expectedTaskVersion: getWorkItem(database, projectId, principalId, task.id).version,
      reason: "Publicar esforço revisado após handoff da sessão.",
    }).value;
    assert.deepEqual(publication.migration.preservedStepIds, [published.steps[0]!.id]);
    assert.deepEqual(publication.migration.resetStepIds, [published.steps[1]!.id]);
    assert.equal(publication.migration.previousProgressPercent, 60);
    assert.equal(publication.workflow.progressPercent, 50, "the published estimate revision reweights completed effort");
    assert.equal(publication.workflow.steps[1]?.status, "pending", "a changed step definition restarts that step");

    const nextSession = startDevelopmentSession(database, {
      projectId, principalId, requestId: "workflow-new-revision-session", itemIdOrKey: task.id,
      expectedVersion: getWorkItem(database, projectId, principalId, task.id).version,
    }).value;
    assert.equal(nextSession.taskWorkflowRevisionNumber, draft.revisionNumber);
    let currentTaskVersion = getWorkItem(database, projectId, principalId, task.id).version;
    const secondStarted = transitionTaskWorkflowStep(database, {
      projectId, principalId, requestId: "workflow-second-step-start", taskIdOrKey: task.id,
      revisionNumber: draft.revisionNumber, stepId: published.steps[1]!.id, expectedTaskVersion: currentTaskVersion,
      targetStatus: "in_progress", reason: "A etapa de revisão foi iniciada após a implementação.",
    }).value;
    currentTaskVersion = secondStarted.taskVersion;
    const secondDone = transitionTaskWorkflowStep(database, {
      projectId, principalId, requestId: "workflow-second-step-done", taskIdOrKey: task.id,
      revisionNumber: draft.revisionNumber, stepId: published.steps[1]!.id, expectedTaskVersion: currentTaskVersion,
      targetStatus: "done", reason: "A revisão foi executada depois da implementação.",
    }).value;
    currentTaskVersion = secondDone.taskVersion;
    assert.equal(secondDone.progressPercent, 100);
    assert.throws(() => transitionTaskWorkflowStep(database, {
      projectId, principalId, requestId: "workflow-stale-session-revision", taskIdOrKey: task.id,
      revisionNumber: published.revisionNumber, stepId: published.steps[0]!.id,
      expectedTaskVersion: currentTaskVersion,
      targetStatus: "in_progress", reason: "Tentativa com workflow antigo.",
    }), (error: unknown) => error instanceof ApplicationError && error.code === "VERSION_CONFLICT");
    assert.throws(() => transitionTaskWorkflowStep(database, {
      projectId, principalId, requestId: "workflow-invalid-status", taskIdOrKey: task.id,
      revisionNumber: draft.revisionNumber, stepId: published.steps[1]!.id,
      expectedTaskVersion: currentTaskVersion,
      targetStatus: "finished" as never, reason: "Status deve ser validado pelo domínio.",
    }), (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED");
    transitionDevelopmentSession(database, {
      projectId, principalId, requestId: "workflow-close-second-session", sessionId: nextSession.id,
      action: "complete", expectedVersion: nextSession.version, reason: "Etapas da revisão atual concluídas.",
    });
    assert.throws(() => transitionTaskWorkflowStep(database, {
      projectId, principalId, requestId: "workflow-reset-before-downstream", taskIdOrKey: task.id,
      revisionNumber: draft.revisionNumber, stepId: published.steps[0]!.id,
      expectedTaskVersion: currentTaskVersion, targetStatus: "pending", reason: "Reset fora de ordem.",
    }), (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_TRANSITION");
    const secondReset = transitionTaskWorkflowStep(database, {
      projectId, principalId, requestId: "workflow-reset-second", taskIdOrKey: task.id,
      revisionNumber: draft.revisionNumber, stepId: published.steps[1]!.id,
      expectedTaskVersion: currentTaskVersion, targetStatus: "pending", reason: "Revisão reaberta primeiro.",
    }).value;
    const firstReset = transitionTaskWorkflowStep(database, {
      projectId, principalId, requestId: "workflow-reset-first", taskIdOrKey: task.id,
      revisionNumber: draft.revisionNumber, stepId: published.steps[0]!.id,
      expectedTaskVersion: secondReset.taskVersion, targetStatus: "pending", reason: "Implementação reaberta depois da revisão.",
    }).value;
    assert.equal(firstReset.progressPercent, 0);
  });

  it("requires a human Tech Lead to publish even when an agent has the role", () => {
    const task = createReadyTask("Documentar verificação de assinatura");
    const draft = propose({
      task, requestId: "workflow-agent-propose", expectedWorkflowVersion: 0,
      steps: [{ title: "Documentar", description: "Descrever validação da assinatura e exemplos.", effortPercent: 100 }],
    }).value;
    const agentId = randomUUID();
    const now = new Date().toISOString();
    database.prepare("INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at) VALUES (?, 'agent', ?, 'Tech Lead agent', ?)")
      .run(agentId, `task-workflow-agent:${agentId}`, now);
    database.prepare("INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, 'tech_lead', ?)")
      .run(projectId, agentId, now);
    assert.throws(() => publishTaskWorkflow(database, {
      projectId, principalId: agentId, requestId: "workflow-agent-publish", taskIdOrKey: task.id,
      revisionNumber: draft.revisionNumber, expectedTaskVersion: getWorkItem(database, projectId, principalId, task.id).version,
      reason: "Tentativa de publicação autônoma.",
    }), (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN");
  });

  function createReadyTask(title: string) {
    const task = create("task", title, storyId, `Entregar: ${title}.`);
    assignWorkItem(database, {
      projectId, principalId, requestId: `workflow-assign-${task.id}`, itemIdOrKey: task.id,
      assigneeId: principalId, expectedVersion: task.version,
    });
    database.prepare("UPDATE work_items SET state = 'ready' WHERE project_id = ? AND item_id = ?").run(projectId, task.id);
    return getWorkItem(database, projectId, principalId, task.id);
  }

  function propose(input: {
    readonly task: ReturnType<typeof createReadyTask>;
    readonly requestId: string;
    readonly expectedWorkflowVersion: number;
    readonly steps: Parameters<typeof proposeTaskWorkflow>[1]["steps"];
  }) {
    return proposeTaskWorkflow(database, {
      projectId, principalId, taskIdOrKey: input.task.id, requestId: input.requestId,
      expectedTaskVersion: input.task.version, expectedWorkflowVersion: input.expectedWorkflowVersion,
      steps: input.steps, reason: "Decomposição verificável do trabalho.",
    });
  }

  function create(type: "epic" | "feature" | "story" | "task", title: string, parentId?: string, description?: string) {
    return createWorkItem(database, {
      projectId, principalId, requestId: `workflow-create-${randomUUID()}`, type, title,
      ...(parentId === undefined ? {} : { parentId }),
      ...(description === undefined ? {} : { description }),
    }).value;
  }
});
