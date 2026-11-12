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
import { linkTaskToAdr } from "../../src/application/adr-commands.js";
import { createSpecification, publishSpecificationRevision } from "../../src/application/specification-commands.js";
import { getTaskContext } from "../../src/application/task-context.js";
import { startTaskDevelopment } from "../../src/application/task-development-start.js";
import { assignWorkItem } from "../../src/application/work-item-commands.js";
import { getWorkItem } from "../../src/application/work-item-queries.js";
import { getTaskStartReadiness, transitionWorkItem } from "../../src/application/work-item-workflow.js";
import { addTraceLink } from "../../src/application/trace-commands.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";

describe("task development start gates", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let storyId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-task-start-"));
    const initialized = initializeProject({ workspace, key: "PAY", name: "Payments", productGoal: "Pagamentos confiáveis", timezone: "UTC" });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
      .get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    const epic = createItem("epic", "Pagamentos");
    const feature = createItem("feature", "Checkout", epic.id);
    storyId = createItem("story", "Confirmar pedido", feature.id).id;
    const now = new Date().toISOString();
    database.prepare("UPDATE work_items SET state = 'ready' WHERE project_id = ? AND item_id = ?").run(projectId, storyId);
    database.prepare(
      `INSERT INTO work_baselines (baseline_id, project_id, item_id, sequence, kind, reason, created_by_principal_id, created_at)
       VALUES (?, ?, ?, 1, 'ready', 'Baseline de fixture', ?, ?)`,
    ).run(randomUUID(), projectId, storyId, principalId, now);
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("checks gates, moves Ready to in_progress, pins ADRs, and opens a session atomically", () => {
    const task = createTask("Aplicar chave de idempotência");
    const adr = createSpecification(database, {
      projectId, principalId, requestId: "task-start-adr-create", key: "ADR-PAY-10", kind: "adr",
      title: "Chaves de idempotência por pedido", content: { decision: "Usar uma chave estável por pedido." },
    }).value;
    publishSpecificationRevision(database, {
      projectId, principalId, requestId: "task-start-adr-publish", specIdOrKey: adr.key, revisionNumber: 1, expectedVersion: 1,
    });
    linkTaskToAdr(database, {
      projectId, principalId, requestId: "task-start-adr-link", taskIdOrKey: task.key, adrIdOrKey: adr.key, relationship: "implements",
    });

    const readiness = getTaskStartReadiness(database, { projectId, principalId, itemIdOrKey: task.key });
    assert.equal(readiness.canStart, true);
    assert.deepEqual(readiness.blockers, []);

    const started = startTaskDevelopment(database, {
      projectId, principalId, requestId: "task-start-success", itemIdOrKey: task.key, expectedVersion: task.version,
      reason: "Iniciar implementação revisada.", sessionReference: "codex-chat:task-start-test",
    });
    assert.equal(started.value.task.state, "in_progress");
    assert.equal(started.value.task.version, task.version + 1);
    assert.equal(started.value.transition?.toState, "in_progress");
    assert.equal(started.value.session.status, "active");
    assert.deepEqual(started.value.session.technicalSpecifications.map((spec) => [spec.key, spec.revisionNumber]), [[adr.key, 1]]);
    assert.equal(started.value.operationAuditEventIds.length, 2);
    assert.equal(started.auditEventIds.length, 1);
    assert.equal(getWorkItem(database, projectId, principalId, task.id).state, "in_progress");
    const context = getTaskContext(database, {
      projectId, principalId, taskIdOrKey: task.key, include: ["technicalDecisions"],
    });
    assert.equal(context.sections.technicalDecisions[0]?.source.pinSource, "development_session");
    assert.equal(context.sections.technicalDecisions[0]?.source.key, adr.key);

    const replay = startTaskDevelopment(database, {
      projectId, principalId, requestId: "task-start-success", itemIdOrKey: task.key, expectedVersion: task.version,
      reason: "Iniciar implementação revisada.", sessionReference: "codex-chat:task-start-test",
    });
    assert.deepEqual(replay, started);
  });

  it("blocks a task while prerequisites are incomplete and does not change its state", () => {
    const task = createTask("Consumir serviço de autorização");
    const prerequisite = createTask("Preparar serviço de autorização");
    addTraceLink(database, {
      projectId, principalId, requestId: "task-start-dependency", sourceIdOrKey: task.key, targetIdOrKey: prerequisite.key, type: "depends_on",
    });

    const readiness = getTaskStartReadiness(database, { projectId, principalId, itemIdOrKey: task.key });
    assert.equal(readiness.canStart, false);
    assert.equal(readiness.dependencies[0]?.complete, false);
    assert.ok(readiness.blockers.some((blocker) => blocker.code === "dependencies_incomplete"));
    assert.throws(() => startTaskDevelopment(database, {
      projectId, principalId, requestId: "task-start-blocked", itemIdOrKey: task.key, expectedVersion: task.version,
      reason: "Tentar iniciar antes do pré-requisito.",
    }), (error: unknown) => error instanceof ApplicationError && error.code === "START_BLOCKED");
    assert.equal(getWorkItem(database, projectId, principalId, task.id).state, "ready");
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM development_sessions WHERE project_id = ? AND item_id = ?")
      .get(projectId, task.id) as { count: number }).count, 0);
  });

  it("does not allow a direct Ready-to-in-progress transition to bypass the atomic start command", () => {
    const task = createTask("Registrar início de forma atômica");
    assert.throws(() => transitionWorkItem(database, {
      projectId, principalId, requestId: "task-start-direct-transition", itemIdOrKey: task.key,
      targetState: "in_progress", expectedVersion: task.version, reason: "Tentativa de usar somente a transição.",
    }), (error: unknown) => error instanceof ApplicationError && error.code === "USE_TASK_START");
    assert.equal(getWorkItem(database, projectId, principalId, task.key).state, "ready");
  });

  it("requires a published implementing ADR before starting development", () => {
    const task = createTask("Aplicar política de idempotência");
    const adr = createSpecification(database, {
      projectId, principalId, requestId: "task-start-draft-adr-create", key: "ADR-PAY-11", kind: "adr",
      title: "Política de idempotência", content: { decision: "Usar uma chave por pedido." },
    }).value;
    linkTaskToAdr(database, {
      projectId, principalId, requestId: "task-start-draft-adr-link", taskIdOrKey: task.key, adrIdOrKey: adr.key, relationship: "implements",
    });

    const readiness = getTaskStartReadiness(database, { projectId, principalId, itemIdOrKey: task.key });
    assert.equal(readiness.canStart, false);
    assert.ok(readiness.blockers.some((blocker) => blocker.code === "implementing_adr_unpublished"));
    assert.throws(() => startTaskDevelopment(database, {
      projectId, principalId, requestId: "task-start-draft-adr-blocked", itemIdOrKey: task.key,
      expectedVersion: task.version, reason: "A decisão ainda não foi publicada.",
    }), (error: unknown) => error instanceof ApplicationError && error.code === "START_BLOCKED");
    assert.equal(getWorkItem(database, projectId, principalId, task.key).state, "ready");
  });

  it("rolls back the state transition if opening the session fails", () => {
    const task = createTask("Atualizar credenciais de pagamento");
    database.exec(`CREATE TRIGGER fail_task_start_session BEFORE INSERT ON development_sessions
      BEGIN SELECT RAISE(ABORT, 'simulated session failure'); END;`);
    try {
      assert.throws(() => startTaskDevelopment(database, {
        projectId, principalId, requestId: "task-start-rollback", itemIdOrKey: task.key, expectedVersion: task.version,
        reason: "Validar atomicidade do início.",
      }));
    } finally {
      database.exec("DROP TRIGGER fail_task_start_session");
    }
    const unchanged = getWorkItem(database, projectId, principalId, task.id);
    assert.equal(unchanged.state, "ready");
    assert.equal(unchanged.version, task.version);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM work_item_state_transitions WHERE project_id = ? AND item_id = ? AND to_state = 'in_progress'")
      .get(projectId, task.id) as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM development_sessions WHERE project_id = ? AND item_id = ?")
      .get(projectId, task.id) as { count: number }).count, 0);
  });

  it("reports a paused session instead of attempting a duplicate session", () => {
    const task = createTask("Reprocessar evento de cobrança");
    database.prepare("UPDATE work_items SET state = 'in_progress' WHERE project_id = ? AND item_id = ?").run(projectId, task.id);
    const session = startDevelopmentSession(database, {
      projectId, principalId, requestId: "task-start-paused-session", itemIdOrKey: task.id, expectedVersion: task.version,
    }).value;
    transitionDevelopmentSession(database, {
      projectId, principalId, requestId: "task-start-pause-session", sessionId: session.id,
      action: "pause", expectedVersion: session.version, reason: "Aguardando dependência externa.",
    });
    const readiness = getTaskStartReadiness(database, { projectId, principalId, itemIdOrKey: task.key });
    assert.equal(readiness.canStart, false);
    assert.equal(readiness.openSession?.status, "paused");
    assert.ok(readiness.blockers.some((blocker) => blocker.code === "task_session_paused"));
  });

  it("blocks a second developer from taking over a task while its previous session is paused", () => {
    const task = createTask("Rotacionar segredo de integração");
    database.prepare("UPDATE work_items SET state = 'in_progress' WHERE project_id = ? AND item_id = ?").run(projectId, task.id);
    const priorSession = startDevelopmentSession(database, {
      projectId, principalId, requestId: "task-start-prior-dev-session", itemIdOrKey: task.id, expectedVersion: task.version,
    }).value;
    transitionDevelopmentSession(database, {
      projectId, principalId, requestId: "task-start-prior-dev-pause", sessionId: priorSession.id,
      action: "pause", expectedVersion: priorSession.version, reason: "Transferência pendente.",
    });

    const nextDeveloperId = randomUUID();
    const now = new Date().toISOString();
    database.prepare("INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at) VALUES (?, 'human', ?, 'Next Developer', ?)")
      .run(nextDeveloperId, `task-start-next-dev:${nextDeveloperId}`, now);
    database.prepare("INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, 'developer', ?)")
      .run(projectId, nextDeveloperId, now);
    assignWorkItem(database, {
      projectId, principalId, requestId: "task-start-handoff-reassign", itemIdOrKey: task.id,
      assigneeId: nextDeveloperId, expectedVersion: getWorkItem(database, projectId, principalId, task.id).version,
    });

    const readiness = getTaskStartReadiness(database, { projectId, principalId: nextDeveloperId, itemIdOrKey: task.key });
    assert.equal(readiness.canStart, false);
    assert.ok(readiness.blockers.some((blocker) => blocker.code === "task_session_handoff_required"));
    assert.throws(() => startTaskDevelopment(database, {
      projectId, principalId: nextDeveloperId, requestId: "task-start-handoff-blocked", itemIdOrKey: task.key,
      expectedVersion: getWorkItem(database, projectId, nextDeveloperId, task.key).version,
      reason: "Não iniciar com sessão anterior aberta.",
    }), (error: unknown) => error instanceof ApplicationError && error.code === "START_BLOCKED");
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM development_sessions WHERE project_id = ? AND item_id = ? AND status = 'active'")
      .get(projectId, task.id) as { count: number }).count, 0);
  });

  it("derives short stable child request IDs from long start request IDs", () => {
    const task = createTask("Confirmar operação com identificador longo");
    const requestId = `start-${"x".repeat(94)}`;
    const started = startTaskDevelopment(database, {
      projectId, principalId, requestId, itemIdOrKey: task.key, expectedVersion: task.version,
      reason: "Validar request IDs compostos longos.",
    });
    assert.equal(started.value.session.status, "active");
  });

  function createTask(title: string) {
    const task = createItem("task", title, storyId, `Implementar ${title}.`);
    assignWorkItem(database, {
      projectId, principalId, requestId: `task-start-assignment-${task.key}`, itemIdOrKey: task.id,
      assigneeId: principalId, expectedVersion: task.version,
    });
    database.prepare("UPDATE work_items SET state = 'ready' WHERE project_id = ? AND item_id = ?").run(projectId, task.id);
    return getWorkItem(database, projectId, principalId, task.id);
  }

  function createItem(type: "epic" | "feature" | "story" | "task", title: string, parentId?: string, description?: string) {
    return createWorkItem(database, {
      projectId, principalId, requestId: `task-start-create-${randomUUID()}`, type, title,
      ...(parentId === undefined ? {} : { parentId }),
      ...(description === undefined ? {} : { description }),
    }).value;
  }
});
