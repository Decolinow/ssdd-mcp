import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setDefinitionOfDone } from "../../src/application/definition-of-done.js";
import { ApplicationError } from "../../src/application/errors.js";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { proposeWorkItemEstimate, confirmWorkItemEstimate } from "../../src/application/work-item-commands.js";
import { getWorkItem } from "../../src/application/work-item-queries.js";
import { createScenario, publishScenarioRevision, recordTestRun } from "../../src/application/scenario-commands.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createMilestone } from "../../src/application/milestones.js";
import { createTeamCapacityConfiguration, getTeamCapacityConfiguration, setTeamCapacityConfiguration } from "../../src/application/team-capacity.js";
import { cancelSprint, changeSprintScope, closeSprint, createSprintDraft, startSprint } from "../../src/application/sprint-commands.js";
import { getSprint, listSprints } from "../../src/application/sprint-queries.js";
import { getSprintRetrospective, setSprintRetrospective } from "../../src/application/sprint-retrospectives.js";
import { getProjectDashboardMetrics } from "../../src/application/dashboard-metrics.js";
import { addWorkItemEvidence, certifyTestRun, transitionWorkItem } from "../../src/application/work-item-workflow.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import type { WorkItemState } from "../../src/domain/work-items.js";

describe("sprint planning and Definition of Done", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;
  let featureId: string;
  let pbis: Array<{ id: string; key: string; scenarioId: string }>;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-sprint-"));
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
    featureId = createWorkItem(database, {
      projectId, principalId, requestId: requestId("feature"), type: "feature", parentId: epic.id, title: "Checkout",
    }).value.id;
    pbis = [
      createReadyPbi("Confirmar pedido", 3, 1),
      createReadyPbi("Consultar pedido", 5, 2),
      createReadyPbi("Reemitir acesso", 2, 3),
    ];

    setTeamCapacityConfiguration(database, {
      projectId,
      principalId,
      requestId: requestId("capacity"),
      expectedVersion: 0,
      teamName: "Payments team",
      timezone: "America/Sao_Paulo",
      hoursPerDay: 6,
      workingDays: [1, 2, 3, 4, 5],
      members: [{ principalId, dedicationPercent: 100 }],
      reason: "Configuração inicial do time.",
    });
    setDefinitionOfDone(database, {
      projectId,
      principalId,
      requestId: requestId("dod"),
      expectedVersion: 0,
      criteria: [{ description: "Critérios aceitos e evidências registradas." }],
      reason: "Definição inicial para as entregas do projeto.",
    });
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("pins capacity and DoD snapshots, audits scope, and closes accepted and incomplete PBIs", () => {
    const [first, second, third] = pbis;
    assert.ok(first && second && third);
    const draft = draftSprint("PAY-S1", [first.key]);
    assert.equal(draft.value.status, "draft");
    assert.equal(draft.value.capacityConfigVersion, 1);
    assert.equal(draft.value.definitionOfDoneRevision, 1);
    assert.deepEqual(draft.value.scope.map((item) => item.itemId), [first.id]);

    const planned = changeSprintScope(database, {
      projectId, principalId, requestId: requestId("scope-add"), sprintIdOrKey: "PAY-S1",
      expectedVersion: 1, addItemIdsOrKeys: [second.key], reason: "Incluir o segundo item planejado.",
    }).value;
    assert.equal(planned.version, 2);
    assert.deepEqual(planned.scope.map((item) => item.itemId), [first.id, second.id]);
    assert.deepEqual(planned.scopeHistory.map((event) => event.action), ["add", "add"]);

    setTeamCapacityConfiguration(database, {
      projectId, principalId, requestId: requestId("capacity-revision"), expectedVersion: 1,
      teamName: "Payments team", timezone: "America/Sao_Paulo", hoursPerDay: 6,
      workingDays: [1, 2, 3, 4, 5], members: [{ principalId, dedicationPercent: 100 }],
      holidays: [{ date: "2026-11-09", label: "Feriado posterior ao planejamento" }],
      reason: "Calendário revisado após o rascunho.",
    });
    setDefinitionOfDone(database, {
      projectId, principalId, requestId: requestId("dod-revision"), expectedVersion: 1,
      criteria: [
        { id: getDefinitionCriterionId(), description: "Critérios aceitos, QA certificado e evidências preservadas." },
      ],
      reason: "Critérios revisados após o planejamento.",
    });

    const fourth = createReadyPbi("Atualizar conciliação", 3, 4);
    const secondDraft = draftSprint("PAY-S2", [fourth.key]);
    assert.equal(secondDraft.value.capacityConfigVersion, 2);
    assert.equal(secondDraft.value.definitionOfDoneRevision, 2);

    const active = startSprint(database, {
      projectId, principalId, requestId: requestId("start"), sprintIdOrKey: "PAY-S1",
      expectedVersion: 2, reason: "PO confirma o início da sprint.",
    }).value;
    assert.equal(active.status, "active");
    assert.equal(active.version, 3);
    assert.equal(active.startedSnapshot?.capacity.version, 1);
    assert.equal(active.startedSnapshot?.capacity.totalHours, 30);
    assert.equal(active.startedSnapshot?.definitionOfDone.revisionNumber, 1);
    assert.equal(active.startedSnapshot?.commitments.length, 2);

    assert.throws(
      () => startSprint(database, {
        projectId, principalId, requestId: requestId("second-start"), sprintIdOrKey: "PAY-S2",
        expectedVersion: 1, reason: "Tentativa de iniciar outra sprint ativa.",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "GATE_BLOCKED",
    );
    const cancelledSecondDraft = cancelSprint(database, {
      projectId, principalId, requestId: requestId("cancel-second-before-replan"), sprintIdOrKey: "PAY-S2",
      expectedVersion: 1, reason: "Liberar o PBI para replanejamento.",
    }).value;
    assert.equal(cancelledSecondDraft.status, "cancelled");

    const developerId = addProjectMember("developer");
    assert.throws(
      () => changeSprintScope(database, {
        projectId, principalId: developerId, requestId: requestId("developer-scope"), sprintIdOrKey: "PAY-S1",
        expectedVersion: 3, removeItemIdsOrKeys: [second.key], reason: "Tentativa sem autorização de PO.",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN",
    );
    const activelyPlanned = changeSprintScope(database, {
      projectId, principalId, requestId: requestId("po-scope"), sprintIdOrKey: "PAY-S1",
      expectedVersion: 3, addItemIdsOrKeys: [third.key], reason: "PO inclui um item após revisar a capacidade.",
    }).value;
    assert.equal(activelyPlanned.version, 4);
    assert.deepEqual(activelyPlanned.scopeHistory.map((event) => event.action), ["add", "add", "add"]);

    markDone(second);
    const closed = closeSprint(database, {
      projectId, principalId, requestId: requestId("close"), sprintIdOrKey: "PAY-S1",
      expectedVersion: 4, acceptedItemIds: [second.id], reviewSummary: "Um PBI aceito; dois seguem no backlog.",
      reason: "PO encerrou a sprint após a review.",
    }).value;
    assert.equal(closed.status, "closed");
    assert.deepEqual(closed.closedSnapshot?.acceptedItemIds, [second.id]);
    assert.deepEqual(closed.closedSnapshot?.incompleteItems.map((item) => item.itemId), [first.id, third.id]);
    assert.equal(closed.closedSnapshot?.definitionOfDone.revisionNumber, 1);
    assert.deepEqual(closed.transitions.map((transition) => [transition.fromState, transition.toState]), [
      ["draft", "active"], ["active", "closed"],
    ]);
    assert.deepEqual(listSprints(database, projectId, principalId, { statuses: ["closed"] }).map((sprint) => sprint.key), ["PAY-S1"]);

  });

  it("pins every sprint to an explicit team and permits one active sprint per team", () => {
    const [first, second] = pbis;
    assert.ok(first && second);
    const primaryTeam = getTeamCapacityConfiguration(database, projectId, principalId).teamId;
    const secondaryTeam = createTeamCapacityConfiguration(database, {
      projectId,
      principalId,
      requestId: requestId("create-secondary-team"),
      teamName: "Reconciliation team",
      timezone: "America/Sao_Paulo",
      hoursPerDay: 4,
      workingDays: [1, 2, 3, 4, 5],
      members: [{ principalId, dedicationPercent: 100 }],
      reason: "Capacity for a second independent team.",
    }).value;

    const primaryDraft = draftSprint("PAY-TEAM-A", [first.key], primaryTeam);
    const secondaryDraft = draftSprint("PAY-TEAM-B", [second.key], secondaryTeam.teamId);
    assert.equal(primaryDraft.value.teamId, primaryTeam);
    assert.equal(secondaryDraft.value.teamId, secondaryTeam.teamId);
    assert.throws(
      () => draftSprint("PAY-OVERLAP", [first.key], secondaryTeam.teamId),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );

    const primaryActive = startSprint(database, {
      projectId, principalId, requestId: requestId("start-team-a"), sprintIdOrKey: primaryDraft.value.id,
      expectedVersion: 1, reason: "Start the primary team sprint.",
    }).value;
    const secondaryActive = startSprint(database, {
      projectId, principalId, requestId: requestId("start-team-b"), sprintIdOrKey: secondaryDraft.value.id,
      expectedVersion: 1, reason: "Start the secondary team sprint.",
    }).value;
    assert.equal(primaryActive.status, "active");
    assert.equal(secondaryActive.status, "active");
    assert.deepEqual(listSprints(database, projectId, principalId, { teamId: primaryTeam }).map((sprint) => sprint.key), ["PAY-TEAM-A"]);
    assert.deepEqual(listSprints(database, projectId, principalId, { teamId: secondaryTeam.teamId }).map((sprint) => sprint.key), ["PAY-TEAM-B"]);
    const milestone = createMilestone(database, {
      projectId, principalId, requestId: requestId("team-forecast-milestone"), milestoneKey: "PAY-MC-TEAM",
      title: "Entrega por time", goal: "Manter forecast isolado por time.",
      targetDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      itemIdsOrKeys: [first.id], reason: "Criar fixture para forecast por time.",
    }).value;
    const primaryMetrics = getProjectDashboardMetrics(database, {
      projectId, principalId, teamId: primaryTeam, milestoneId: milestone.id,
    });
    assert.equal(primaryMetrics.selectedTeamId, primaryTeam);
    assert.deepEqual(primaryMetrics.sprints.map((sprint) => sprint.key), ["PAY-TEAM-A"]);
    assert.equal(primaryMetrics.forecast?.teamId, primaryTeam);
    const secondaryMetrics = getProjectDashboardMetrics(database, {
      projectId, principalId, teamId: secondaryTeam.teamId, milestoneId: milestone.id,
    });
    assert.equal(secondaryMetrics.forecast?.teamId, secondaryTeam.teamId);
    assert.throws(
      () => listSprints(database, projectId, principalId),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
    assert.throws(
      () => getProjectDashboardMetrics(database, { projectId, principalId }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
  });

  it("rejects stale scope edits and keeps cancelled sprint history immutable", () => {
    const [first] = pbis;
    assert.ok(first);
    const draft = draftSprint("PAY-S1", [first!.key]).value;
    assert.throws(
      () => changeSprintScope(database, {
        projectId, principalId, requestId: requestId("stale-scope"), sprintIdOrKey: draft.id,
        expectedVersion: 2, removeItemIdsOrKeys: [first!.id], reason: "Versão desatualizada.",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VERSION_CONFLICT",
    );
    const estimate = getWorkItem(database, projectId, principalId, first.id);
    const proposal = proposeWorkItemEstimate(database, {
      projectId, principalId, requestId: requestId("reestimate"), itemIdOrKey: first.id,
      unit: "points", value: 8, rationale: "Revisão após decomposição.", expectedVersion: estimate.version,
    }).value;
    const proposed = getWorkItem(database, projectId, principalId, first.id);
    confirmWorkItemEstimate(database, {
      projectId, principalId, requestId: requestId("reestimate-confirm"), itemIdOrKey: first.id,
      proposalId: proposal.id, expectedVersion: proposed.version,
    });
    assert.throws(
      () => startSprint(database, {
        projectId, principalId, requestId: requestId("start-with-drift"), sprintIdOrKey: draft.id,
        expectedVersion: 1, reason: "Escopo planejado precisa ser revisado.",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VERSION_CONFLICT",
    );
    const cancelled = cancelSprint(database, {
      projectId, principalId, requestId: requestId("cancel-only"), sprintIdOrKey: draft.id,
      expectedVersion: 1, reason: "Rascunho cancelado.",
    }).value;
    assert.deepEqual(cancelled.scope.map((item) => item.itemId), [first.id]);
    assert.deepEqual(cancelled.scopeHistory.map((event) => event.action), ["add"]);
    assert.equal(getSprint(database, projectId, principalId, "PAY-S1").status, "cancelled");
    assert.throws(
      () => startSprint(database, {
        projectId, principalId, requestId: requestId("start-cancelled"), sprintIdOrKey: "PAY-S1",
        expectedVersion: 2, reason: "Não deve iniciar.",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_TRANSITION",
    );
    assert.throws(
      () => database.prepare("UPDATE sprint_scope_events SET reason = 'mutada' WHERE sprint_id = ?").run(draft.id),
      /immutable/,
    );
  });

  it("replays generated DoD IDs and default sprint versions without changing the result", () => {
    const [first] = pbis;
    assert.ok(first);
    const dodInput = {
      projectId,
      principalId,
      requestId: "dod-generated-idempotency",
      expectedVersion: 1,
      criteria: [{ description: "Revisão com ID gerado pelo servidor." }],
      reason: "Atualizar DoD para o próximo ciclo.",
    };
    const firstDod = setDefinitionOfDone(database, dodInput);
    const replayedDod = setDefinitionOfDone(database, dodInput);
    assert.equal(firstDod.value.criteria[0]?.id, replayedDod.value.criteria[0]?.id);
    assert.deepEqual(firstDod.auditEventIds, replayedDod.auditEventIds);

    const draftInput = {
      projectId,
      principalId,
      requestId: "sprint-default-version-idempotency",
      sprintKey: "PAY-REPLAY",
      title: "Sprint de replay",
      goal: "Preservar o plano original no retry.",
      startsOn: "2026-11-09",
      endsOn: "2026-11-13",
      itemIdsOrKeys: [first.key],
      reason: "Criar plano com versões correntes.",
    };
    const firstDraft = createSprintDraft(database, draftInput);
    assert.equal(firstDraft.value.capacityConfigVersion, 1);
    assert.equal(firstDraft.value.definitionOfDoneRevision, 2);

    setTeamCapacityConfiguration(database, {
      projectId, principalId, requestId: requestId("capacity-next"), expectedVersion: 1,
      teamName: "Payments team", timezone: "America/Sao_Paulo", hoursPerDay: 6,
      workingDays: [1, 2, 3, 4, 5], members: [{ principalId, dedicationPercent: 100 }],
      reason: "Atualizar calendário após o rascunho.",
    });
    setDefinitionOfDone(database, {
      projectId, principalId, requestId: requestId("dod-next"), expectedVersion: 2,
      criteria: [{ description: "Critério de revisão posterior." }],
      reason: "Revisar critérios após o rascunho.",
    });

    const replayedDraft = createSprintDraft(database, draftInput);
    assert.equal(replayedDraft.value.id, firstDraft.value.id);
    assert.equal(replayedDraft.value.capacityConfigVersion, 1);
    assert.equal(replayedDraft.value.definitionOfDoneRevision, 2);
    assert.deepEqual(replayedDraft.auditEventIds, firstDraft.auditEventIds);
  });

  it("records immutable retrospective revisions with human owners and linked PBIs", () => {
    const [first] = pbis;
    assert.ok(first);
    const drafted = draftSprint("PAY-RETRO", [first.key]).value;
    const started = startSprint(database, {
      projectId, principalId, requestId: requestId("retro-start"), sprintIdOrKey: drafted.id,
      expectedVersion: drafted.version, reason: "Iniciar ciclo para validar retrospectiva.",
    }).value;
    const closed = closeSprint(database, {
      projectId, principalId, requestId: requestId("retro-close"), sprintIdOrKey: started.id,
      expectedVersion: started.version, acceptedItemIds: [], reviewSummary: "O PBI segue incompleto.",
      reason: "Encerrar para registrar os aprendizados.",
    }).value;
    const ownerPrincipalId = addProjectMember("developer");
    const input = {
      projectId,
      principalId,
      requestId: "retro-record-idempotency",
      sprintIdOrKey: closed.key,
      expectedVersion: 0,
      summary: "A equipe manteve boa colaboração durante o ciclo.",
      keepDoing: ["Fazer revisão diária de bloqueios."],
      stopDoing: ["Iniciar trabalho sem capacidade confirmada."],
      tryNext: ["Revisar dependências no planejamento."],
      actions: [{ title: "Adicionar revisão de dependências", ownerPrincipalId, linkedWorkItemIdOrKey: first.key }],
      reason: "A equipe revisou os resultados e acordou uma ação.",
    } as const;

    const recorded = setSprintRetrospective(database, input);
    const replayed = setSprintRetrospective(database, input);
    assert.deepEqual(replayed.auditEventIds, recorded.auditEventIds);
    assert.equal(replayed.value.actions[0]?.id, recorded.value.actions[0]?.id);
    assert.equal(recorded.value.version, 1);
    assert.equal(recorded.value.actions[0]?.ownerPrincipalId, ownerPrincipalId);
    assert.equal(recorded.value.actions[0]?.linkedWorkItemKey, first.key);

    const revised = setSprintRetrospective(database, {
      ...input,
      requestId: "retro-revise",
      expectedVersion: 1,
      summary: "A equipe manteve colaboração e ajustou o planejamento.",
      actions: [{
        id: recorded.value.actions[0]!.id,
        title: "Revisar dependências antes do planejamento",
        ownerPrincipalId,
        linkedWorkItemIdOrKey: first.id,
      }],
    });
    assert.equal(revised.value.version, 2);
    assert.equal(revised.value.actions[0]?.id, recorded.value.actions[0]?.id);

    const latest = getSprintRetrospective(database, { projectId, principalId, sprintIdOrKey: closed.id });
    assert.equal(latest.version, 2);
    assert.equal(latest.retrospective?.summary, "A equipe manteve colaboração e ajustou o planejamento.");
    assert.deepEqual(latest.history.map((entry) => entry.revisionNumber), [2, 1]);
    const original = getSprintRetrospective(database, {
      projectId, principalId, sprintIdOrKey: closed.id, revisionNumber: 1,
    });
    assert.equal(original.retrospective?.summary, input.summary);
    assert.equal(original.retrospective?.version, 1);
    assert.equal(original.retrospective?.actions[0]?.title, "Adicionar revisão de dependências");

    assert.throws(
      () => database.prepare(
        "UPDATE sprint_retrospective_actions SET title = 'alterado' WHERE sprint_id = ? AND revision_number = 1",
      ).run(closed.id),
      /immutable/,
    );
    assert.throws(
      () => database.prepare(
        "UPDATE sprint_retrospective_revisions SET summary = 'alterado' WHERE sprint_id = ? AND revision_number = 1",
      ).run(closed.id),
      /immutable/,
    );
    assert.throws(
      () => setSprintRetrospective(database, {
        ...input, requestId: "retro-stale", expectedVersion: 1, actions: [],
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VERSION_CONFLICT",
    );
    assert.throws(
      () => setSprintRetrospective(database, {
        ...input,
        requestId: "retro-invalid-link",
        expectedVersion: 2,
        actions: [{ title: "Link inválido", ownerPrincipalId, linkedWorkItemIdOrKey: featureId }],
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
    assert.throws(
      () => setSprintRetrospective(database, {
        ...input,
        requestId: "retro-invalid-owner",
        expectedVersion: 2,
        actions: [{ title: "Ação sem responsável do projeto", ownerPrincipalId: randomUUID() }],
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
    assert.equal(getSprintRetrospective(database, { projectId, principalId, sprintIdOrKey: closed.id }).version, 2);
  });

  it("requires a closed sprint and a human facilitator to record a retrospective", () => {
    const [first] = pbis;
    assert.ok(first);
    const draft = draftSprint("PAY-RETRO-GATE", [first.key]).value;
    const input = {
      projectId,
      principalId,
      requestId: "retro-before-close",
      sprintIdOrKey: draft.id,
      expectedVersion: 0,
      summary: "Resumo da retrospectiva.",
      keepDoing: [],
      stopDoing: [],
      tryNext: [],
      actions: [],
      reason: "Registrar aprendizados.",
    } as const;
    assert.throws(
      () => setSprintRetrospective(database, input),
      (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_TRANSITION",
    );

    const agentId = randomUUID();
    const createdAt = new Date().toISOString();
    database.prepare(
      `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
       VALUES (?, 'agent', ?, 'Retro agent', ?)`,
    ).run(agentId, `retro-agent:${agentId}`, createdAt);
    database.prepare(
      "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, 'facilitator', ?)",
    ).run(projectId, agentId, createdAt);
    assert.throws(
      () => setSprintRetrospective(database, { ...input, requestId: "retro-agent", principalId: agentId }),
      (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN",
    );
  });

  function createReadyPbi(title: string, points: number, sequence: number): { id: string; key: string; scenarioId: string } {
    const pbi = createWorkItem(database, {
      projectId, principalId, requestId: requestId("story"), type: "story", parentId: featureId,
      title, description: `${title} para o cliente.`, criteria: [{ description: `${title} funciona conforme esperado.` }],
    }).value;
    const criterionId = pbi.criteria[0]!.id;
    const scenario = createScenario(database, {
      projectId, principalId, requestId: requestId("scenario"), key: `PAY-TC-${sequence}`,
      kind: "acceptance", title: `Validar ${title}`,
      steps: [{ action: title, expected: "A operação conclui com sucesso." }],
      coverage: [{ targetType: "criterion", reference: criterionId }],
    }).value;
    publishScenarioRevision(database, {
      projectId, principalId, requestId: requestId("scenario-publish"),
      scenarioIdOrKey: scenario.scenarioId, revisionNumber: 1, expectedVersion: 1,
    });
    const proposal = proposeWorkItemEstimate(database, {
      projectId, principalId, requestId: requestId("estimate"), itemIdOrKey: pbi.id,
      unit: "points", value: points, rationale: "Estimativa da equipe.", expectedVersion: pbi.version,
    }).value;
    const proposed = getWorkItem(database, projectId, principalId, pbi.id);
    confirmWorkItemEstimate(database, {
      projectId, principalId, requestId: requestId("estimate-confirm"), itemIdOrKey: pbi.id,
      proposalId: proposal.id, expectedVersion: proposed.version,
    });
    const current = getWorkItem(database, projectId, principalId, pbi.id);
    transitionWorkItem(database, {
      projectId, principalId, requestId: requestId("ready"), itemIdOrKey: pbi.id, targetState: "ready",
      expectedVersion: current.version, reason: "Critérios e cobertura aprovados.",
    });
    return { id: pbi.id, key: pbi.key, scenarioId: scenario.scenarioId };
  }

  function draftSprint(key: string, itemIdsOrKeys: readonly string[], teamId?: string) {
    return createSprintDraft(database, {
      projectId, principalId, requestId: requestId("draft"), sprintKey: key,
      title: `Sprint ${key}`, goal: "Concluir os itens priorizados.",
      startsOn: "2026-11-09", endsOn: "2026-11-13", itemIdsOrKeys,
      reason: "Rascunho criado a partir do backlog Ready.",
      ...(teamId === undefined ? {} : { teamId }),
    });
  }

  function markDone(pbi: { id: string; scenarioId: string }): void {
    transition(pbi.id, "in_progress");
    transition(pbi.id, "in_review");
    transition(pbi.id, "in_validation");
    const buildId = "candidate-sprint-42";
    addWorkItemEvidence(database, {
      projectId, principalId, requestId: requestId("build-evidence"), itemIdOrKey: pbi.id,
      kind: "build", uri: "https://ci.example/builds/candidate-sprint-42", buildId,
      description: "Build candidato validado.",
    });
    const run = recordTestRun(database, {
      projectId, principalId, requestId: requestId("test-run"), scenarioIdOrKey: pbi.scenarioId,
      revisionNumber: 1, buildId, result: "passed",
    }).value;
    const beforeCertification = getWorkItem(database, projectId, principalId, pbi.id);
    certifyTestRun(database, {
      projectId, principalId, requestId: requestId("qa-certification"), itemIdOrKey: pbi.id,
      runId: run.id, expectedVersion: beforeCertification.version, reason: "QA certificou a execução.",
    });
    transition(pbi.id, "done", buildId);
  }

  function transition(itemIdOrKey: string, targetState: WorkItemState, buildId?: string) {
    const current = getWorkItem(database, projectId, principalId, itemIdOrKey);
    return transitionWorkItem(database, {
      projectId, principalId, requestId: requestId(`transition-${targetState}`), itemIdOrKey,
      targetState, expectedVersion: current.version, reason: `Avançar para ${targetState}.`,
      ...(buildId === undefined ? {} : { buildId }),
    }).value;
  }

  function addProjectMember(role: "developer"): string {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    database.prepare(
      `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
       VALUES (?, 'human', ?, 'Sprint developer', ?)`,
    ).run(id, `sprint-test:${id}`, createdAt);
    database.prepare(
      "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)",
    ).run(projectId, id, role, createdAt);
    return id;
  }

  function getDefinitionCriterionId(): string {
    const revision = database.prepare("SELECT criteria_json FROM dod_revisions WHERE project_id = ? AND revision_number = 1")
      .get(projectId) as { criteria_json: string };
    return (JSON.parse(revision.criteria_json) as Array<{ id: string }>)[0]!.id;
  }
});

function requestId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
