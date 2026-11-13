import { z } from "zod";
import { getProjectDashboardMetrics } from "../../application/dashboard-metrics.js";
import { getProjectFeatureRoadmap } from "../../application/prioritized-roadmap.js";
import { getDeveloperExecutionMetrics, listDeploymentEvents, listDevelopmentSessions, recordDeployment } from "../../application/development-lifecycle.js";
import { listMilestoneForecastHistory, recalculateMilestoneForecast } from "../../application/forecast-queries.js";
import { testRunResults } from "../../domain/scenarios.js";
import { listAuditEvents } from "../../application/audit-queries.js";
import { listTestRunPage } from "../../application/scenario-queries.js";
import { changeMilestoneScope, createMilestone, getMilestone, listMilestones } from "../../application/milestones.js";
import { getFlowMetrics } from "../../application/flow-metrics.js";
import { getDeliveryQualityMetrics } from "../../application/delivery-quality-metrics.js";
import { listStaleDevelopmentSessions, recoverDevelopmentSession } from "../../application/session-recovery.js";
import { testRunPageSchema, milestoneSchema, milestoneSummarySchema, forecastRecalculationSchema, developmentSessionSchema, deploymentEventSchema, metricsObjectSchema, dashboardMetricsSchema } from "../schemas.js";
import { toToolError, toolResult } from "../tool-support.js";
import type { McpToolContext } from "../tool-context.js";

export function registerReportingTools(context: McpToolContext): void {
  const { server, database, principalId } = context;
  server.registerTool(
    "development_session_stale_list",
    {
      title: "Listar sessões abandonadas",
      description: "Admin/Tech Lead: lista sessões ativas ou pausadas sem evento há pelo menos staleAfterHours (padrão 24), com último evento, tempo registrado e tempo não confiável (nunca creditado).",
      inputSchema: z.object({
        projectId: z.string().uuid(), staleAfterHours: z.number().int().min(1).max(2_160).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      outputSchema: z.object({
        staleAfterHours: z.number().int(),
        sessions: z.array(z.object({
          sessionId: z.string().uuid(), itemKey: z.string(), itemTitle: z.string(), developerPrincipalId: z.string().uuid(),
          developerName: z.string(), status: z.enum(["active", "paused"]), startedAt: z.string(), lastEventType: z.string(),
          lastEventAt: z.string(), idleHours: z.number(), recordedActiveSeconds: z.number().int(),
          unreliableSeconds: z.number().int(), version: z.number().int().positive(),
        })),
      }),
    },
    ({ projectId, staleAfterHours, limit }) => {
      try {
        const result = listStaleDevelopmentSessions(database, {
          projectId, principalId,
          ...(staleAfterHours === undefined ? {} : { staleAfterHours }), ...(limit === undefined ? {} : { limit }),
        });
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "development_session_recover",
    {
      title: "Recuperar sessão abandonada",
      description: "Admin/Tech Lead: encerra (cancel ou complete) uma sessão sem atividade há staleAfterHours, com motivo obrigatório e auditoria. Preserva a autoria do desenvolvedor e o tempo registrado; o tempo desde a última retomada não é creditado.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128), sessionId: z.string().uuid(),
        action: z.enum(["cancel", "complete"]), expectedVersion: z.number().int().positive(),
        staleAfterHours: z.number().int().min(1).max(2_160).optional(), reason: z.string().trim().min(10).max(500),
      }),
      outputSchema: z.object({
        recovery: z.object({
          sessionId: z.string().uuid(), itemKey: z.string(), developerPrincipalId: z.string().uuid(),
          status: z.enum(["cancelled", "completed"]), endedAt: z.string(), recordedActiveSeconds: z.number().int(),
          discardedUnreliableSeconds: z.number().int(), recoveredByPrincipalId: z.string().uuid(), version: z.number().int().positive(),
        }),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, sessionId, action, expectedVersion, staleAfterHours, reason }) => {
      try {
        const receipt = recoverDevelopmentSession(database, {
          projectId, principalId, requestId, sessionId, action, expectedVersion, reason,
          ...(staleAfterHours === undefined ? {} : { staleAfterHours }),
        });
        const result = { recovery: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "development_session_list",
    {
      title: "Consultar sessões de desenvolvimento",
      description: "Lista sessões por tarefa, desenvolvedor ou status; sessões ativas incluem a duração acumulada até agora.",
      inputSchema: z.object({
        projectId: z.string().uuid(), itemIdOrKey: z.string().trim().min(1).max(120).optional(),
        developerPrincipalId: z.string().uuid().optional(), status: z.enum(["active", "paused", "completed", "cancelled"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      outputSchema: z.object({ sessions: z.array(developmentSessionSchema) }),
    },
    ({ projectId, itemIdOrKey, developerPrincipalId, status, limit }) => {
      try {
        const result = { sessions: listDevelopmentSessions(database, {
          projectId, principalId,
          ...(itemIdOrKey === undefined ? {} : { itemIdOrKey }),
          ...(developerPrincipalId === undefined ? {} : { developerPrincipalId }),
          ...(status === undefined ? {} : { status }), ...(limit === undefined ? {} : { limit }),
        }) };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "developer_execution_metrics_get",
    {
      title: "Consultar esforço e calibração por desenvolvedor",
      description: "Resume horas ativas no período, tarefas com última conclusão no período e calibração apenas sobre tarefas com estimativa confirmada. As datas usam o fuso do projeto; a amostra mínima é de cinco tarefas estimadas. Não calcula velocidade em pontos por pessoa nem produz ranking.",
      inputSchema: z.object({
        projectId: z.string().uuid(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(), developerPrincipalId: z.string().uuid().optional(),
      }),
      outputSchema: z.object({
        projectId: z.string().uuid(), period: z.object({ from: z.string(), to: z.string() }), minimumSampleTasks: z.number().int(),
        developers: z.array(z.object({
          principalId: z.string().uuid(), name: z.string(), completedSessions: z.number().int(), completedTasks: z.number().int(),
          estimatedCompletedTasks: z.number().int(), activeHours: z.number(), activeHoursOnCompletedTasks: z.number(),
          activeHoursOnEstimatedCompletedTasks: z.number(), estimatedHoursOnCompletedTasks: z.number(),
          estimateVariancePercent: z.number().nullable(), effortCalibrationFactor: z.number().nullable(),
          cycleTimeHours: z.object({ sampleTasks: z.number().int(), medianHours: z.number(), p85Hours: z.number() }).nullable(),
          effortRatioRange: z.object({ sampleTasks: z.number().int(), lowFactor: z.number(), highFactor: z.number() }).nullable(),
          sampleSufficient: z.boolean(),
        })),
      }),
    },
    ({ projectId, from, to, developerPrincipalId }) => {
      try {
        const result = getDeveloperExecutionMetrics(database, {
          projectId, principalId, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }),
          ...(developerPrincipalId === undefined ? {} : { developerPrincipalId }),
        });
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "delivery_quality_metrics_get",
    {
      title: "Consultar qualidade de entrega",
      description: "Aceite na primeira passagem, devoluções por etapa e motivo, critérios partial/not_met do último relatório de entrega e bugs ligados a histórias Done no período (padrão 30 dias), segmentados por tipo de principal. Agregado; sem ranking individual; taxas null abaixo de 5 amostras.",
      inputSchema: z.object({ projectId: z.string().uuid(), from: z.string().datetime().optional(), to: z.string().datetime().optional() }),
      outputSchema: z.object({
        projectId: z.string().uuid(), period: z.object({ from: z.string(), to: z.string() }), minimumSample: z.number().int(),
        acceptance: z.object({
          doneTasks: z.number().int(), firstPassTasks: z.number().int(), firstPassRate: z.number().nullable(),
          bySegment: z.array(z.object({ principalType: z.string(), doneTasks: z.number().int(), firstPassTasks: z.number().int(), firstPassRate: z.number().nullable() })),
        }),
        returns: z.object({
          total: z.number().int(), byStage: z.array(z.object({ fromState: z.string(), count: z.number().int() })),
          topReasons: z.array(z.object({ reason: z.string(), count: z.number().int() })),
          bySegment: z.array(z.object({ principalType: z.string(), count: z.number().int() })),
        }),
        criteria: z.object({
          reportedTasks: z.number().int(),
          byStatus: z.object({ met: z.number().int(), partial: z.number().int(), not_met: z.number().int(), not_applicable: z.number().int() }),
          unresolvedShare: z.number().nullable(),
        }),
        bugs: z.object({ doneStories: z.number().int(), bugsOnDoneStories: z.number().int(), bugsPerDoneStory: z.number().nullable() }),
        limitations: z.array(z.string()),
      }),
    },
    ({ projectId, from, to }) => {
      try {
        const result = getDeliveryQualityMetrics(database, { projectId, principalId, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) });
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "flow_metrics_get",
    {
      title: "Analisar fluxo de entrega",
      description: "Tempo de ciclo, de lead, de espera e de trabalho das tarefas concluídas no período (mediana/P85 com amostra mínima), idade do WIP aberto como amostra censurada, espera por dependência e caminho crítico (só em DAG com horas estimadas). Agregado; sem ranking individual.",
      inputSchema: z.object({ projectId: z.string().uuid(), from: z.string().datetime().optional(), to: z.string().datetime().optional() }),
      outputSchema: z.object({
        projectId: z.string().uuid(), asOf: z.string(), period: z.object({ from: z.string(), to: z.string() }), minimumSample: z.number().int(),
        completed: z.object({ tasks: z.number().int(), leadTime: z.object({ sample: z.number().int(), medianHours: z.number(), p85Hours: z.number() }).nullable(), cycleTime: z.object({ sample: z.number().int(), medianHours: z.number(), p85Hours: z.number() }).nullable(), waitTime: z.object({ sample: z.number().int(), medianHours: z.number(), p85Hours: z.number() }).nullable(), workTime: z.object({ sample: z.number().int(), medianHours: z.number(), p85Hours: z.number() }).nullable(), dependencyWait: z.object({ sample: z.number().int(), medianHours: z.number(), p85Hours: z.number() }).nullable() }),
        openWork: z.object({
          byState: z.array(z.object({ state: z.string(), count: z.number().int(), medianAgeHours: z.number().nullable(), oldestAgeHours: z.number().nullable() })),
          censored: z.literal(true),
          oldest: z.array(z.object({ key: z.string(), state: z.string(), ageHours: z.number() })),
        }),
        criticalPath: z.object({
          status: z.enum(["computed", "not_a_dag", "missing_estimates", "no_open_dependencies"]), totalHours: z.number().nullable(),
          path: z.array(z.object({ key: z.string(), estimateHours: z.number() })), detail: z.string().nullable(),
        }),
        limitations: z.array(z.string()),
      }),
    },
    ({ projectId, from, to }) => {
      try {
        const result = getFlowMetrics(database, { projectId, principalId, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) });
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "deployment_event_record",
    {
      title: "Registrar evento de implantação",
      description: "Registra sucesso, falha ou rollback em homologação/produção e liga o evento a tarefas, PBIs ou marcos; produção exige Done e homologação bem-sucedida do mesmo build.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128),
        environment: z.enum(["homologation", "production"]), buildId: z.string().trim().min(1).max(128),
        releaseVersion: z.string().trim().min(1).max(128).optional(), pipelineRunId: z.string().trim().min(1).max(160).optional(),
        outcome: z.enum(["succeeded", "failed", "rolled_back"]), occurredAt: z.string().datetime().optional(),
        itemIdOrKeys: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
        milestoneIdOrKeys: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
        rollbackOfEventId: z.string().uuid().optional(), notes: z.string().max(2_000).optional(),
      }),
      outputSchema: z.object({ event: deploymentEventSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, environment, buildId, releaseVersion, pipelineRunId, outcome, occurredAt, itemIdOrKeys, milestoneIdOrKeys, rollbackOfEventId, notes }) => {
      try {
        const receipt = recordDeployment(database, {
          projectId, principalId, requestId, environment, buildId, outcome, itemIdOrKeys,
          ...(releaseVersion === undefined ? {} : { releaseVersion }), ...(pipelineRunId === undefined ? {} : { pipelineRunId }),
          ...(occurredAt === undefined ? {} : { occurredAt }), ...(milestoneIdOrKeys === undefined ? {} : { milestoneIdOrKeys }),
          ...(rollbackOfEventId === undefined ? {} : { rollbackOfEventId }), ...(notes === undefined ? {} : { notes }),
        });
        const result = { event: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "audit_event_list",
    {
      title: "Consultar timeline de auditoria",
      description: "Lê, sem alterar nada, a timeline de auditoria do projeto, do evento mais recente ao mais antigo, com filtros por entidade e por principal executor, limite e cursor estável. Aprovações de ferramenta e identidades externas só mostram payload a administradores (payloadRedacted).",
      inputSchema: z.object({
        projectId: z.string().uuid().describe("UUID do projeto retornado por project_list."),
        entityType: z.string().trim().min(1).max(80).optional()
          .describe("Filtra pelo tipo da entidade auditada, por exemplo work_item, scenario ou test_run."),
        entityId: z.string().trim().min(1).max(200).optional()
          .describe("Filtra pelo ID exato da entidade; combine com entityType."),
        actorPrincipalId: z.string().uuid().optional()
          .describe("Filtra pelos eventos executados por este principal (UUID de user_list)."),
        limit: z.number().int().min(1).max(100).optional()
          .describe("Quantidade máxima de eventos na página; padrão 50 e máximo 100."),
        cursor: z.string().max(4_096).optional()
          .describe("Cursor opaco nextCursor da página anterior; reinicie sem cursor após STALE_CURSOR."),
      }),
      outputSchema: z.object({
        events: z.array(z.object({
          id: z.string(), sequence: z.number().int(), projectId: z.string(), principalId: z.string(),
          principalName: z.string(), eventType: z.string(), entityType: z.string(), entityId: z.string(),
          correlationId: z.string(), reason: z.string().nullable(), occurredAt: z.string(),
          payload: z.unknown(), payloadRedacted: z.boolean(),
          entityReference: z.object({ entityType: z.string(), id: z.string(), key: z.string().nullable(), title: z.string().nullable(), label: z.string() }),
          relatedEntities: z.array(z.object({ entityType: z.string(), id: z.string(), key: z.string().nullable(), title: z.string().nullable(), label: z.string() })),
        })),
        nextCursor: z.string().nullable(),
        watermark: z.number().int(),
      }),
    },
    ({ projectId, entityType, entityId, actorPrincipalId, limit, cursor }) => {
      try {
        const result = listAuditEvents(database, {
          projectId, principalId,
          ...(entityType === undefined ? {} : { entityType }), ...(entityId === undefined ? {} : { entityId }),
          ...(actorPrincipalId === undefined ? {} : { actorPrincipalId }),
          ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }),
        });
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "deployment_event_list",
    {
      title: "Consultar histórico de implantações",
      description: "Lista eventos de release por projeto, ambiente e work item, mantendo falhas e rollbacks no histórico.",
      inputSchema: z.object({
        projectId: z.string().uuid(), itemIdOrKey: z.string().trim().min(1).max(120).optional(),
        environment: z.enum(["homologation", "production"]).optional(), limit: z.number().int().min(1).max(200).optional(),
      }),
      outputSchema: z.object({ events: z.array(deploymentEventSchema) }),
    },
    ({ projectId, itemIdOrKey, environment, limit }) => {
      try {
        const result = { events: listDeploymentEvents(database, {
          projectId, principalId, ...(itemIdOrKey === undefined ? {} : { itemIdOrKey }),
          ...(environment === undefined ? {} : { environment }), ...(limit === undefined ? {} : { limit }),
        }) };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "test_run_list",
    {
      title: "Consultar histórico de execuções de teste",
      description: "Lista observações QA recentes do projeto, com filtros por cenário, build e resultado e cursor estável para continuar o histórico.",
      inputSchema: z.object({
        projectId: z.string().uuid().describe("UUID do projeto retornado por project_list."),
        scenarioIdOrKey: z.string().trim().min(1).max(80).optional()
          .describe("Filtra por ID ou chave do cenário; omita para consultar o projeto inteiro."),
        buildId: z.string().trim().min(1).max(128).optional()
          .describe("Filtra pela identificação exata da build registrada."),
        result: z.enum(testRunResults).optional()
          .describe("Filtra por passed, failed, blocked ou skipped."),
        limit: z.number().int().min(1).max(100).optional()
          .describe("Quantidade máxima de execuções na página; padrão 25 e máximo 100."),
        cursor: z.string().max(4_096).optional()
          .describe("Cursor opaco nextCursor retornado na página anterior; reinicie sem cursor após STALE_CURSOR."),
      }),
      outputSchema: testRunPageSchema,
    },
    ({ projectId, scenarioIdOrKey, buildId, result, limit, cursor }) => {
      try {
        const page = listTestRunPage(database, projectId, principalId, {
          ...(scenarioIdOrKey === undefined ? {} : { scenarioIdOrKey }),
          ...(buildId === undefined ? {} : { buildId }),
          ...(result === undefined ? {} : { result }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        return toolResult(page);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "milestone_create",
    {
      title: "Criar marco com escopo aprovado",
      description: "Cria um marco e fixa os snapshots dos PBIs Ready aprovados pelo PO, incluindo baseline, revisão e pontos.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        milestoneKey: z.string().trim().min(1).max(32),
        title: z.string().trim().min(1).max(120),
        goal: z.string().trim().min(1).max(1_000),
        targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        itemIdsOrKeys: z.array(z.string().trim().min(1).max(80)).min(1).max(100),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ milestone: milestoneSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, milestoneKey, title, goal, targetDate, itemIdsOrKeys, reason }) => {
      try {
        const receipt = createMilestone(database, {
          projectId, principalId, requestId, milestoneKey, title, goal, targetDate, itemIdsOrKeys, reason,
        });
        const result = { milestone: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "milestone_scope_change",
    {
      title: "Alterar escopo aprovado do marco",
      description: "Registra inclusão e remoção de PBIs com snapshot imutável, motivo e controle otimista de versão.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        milestoneIdOrKey: z.string().trim().min(1).max(80),
        expectedVersion: z.number().int().positive(),
        addItemIdsOrKeys: z.array(z.string().trim().min(1).max(80)).min(1).max(100).optional(),
        removeItemIdsOrKeys: z.array(z.string().trim().min(1).max(80)).min(1).max(100).optional(),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ milestone: milestoneSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, milestoneIdOrKey, expectedVersion, addItemIdsOrKeys, removeItemIdsOrKeys, reason }) => {
      try {
        const receipt = changeMilestoneScope(database, {
          projectId, principalId, requestId, milestoneIdOrKey, expectedVersion, reason,
          ...(addItemIdsOrKeys === undefined ? {} : { addItemIdsOrKeys }),
          ...(removeItemIdsOrKeys === undefined ? {} : { removeItemIdsOrKeys }),
        });
        const result = { milestone: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "milestone_get",
    {
      title: "Consultar marco",
      description: "Retorna o marco, o escopo corrente e todo o histórico de aprovações e remoções.",
      inputSchema: z.object({ projectId: z.string().uuid(), milestoneIdOrKey: z.string().trim().min(1).max(80) }),
      outputSchema: z.object({ milestone: milestoneSchema }),
    },
    ({ projectId, milestoneIdOrKey }) => {
      try {
        const milestone = getMilestone(database, projectId, principalId, milestoneIdOrKey);
        return { content: [{ type: "text", text: JSON.stringify({ milestone }) }], structuredContent: { milestone } };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "milestone_list",
    {
      title: "Listar marcos",
      description: "Lista marcos do projeto com data alvo, pontos e quantidade de PBIs no escopo aprovado corrente.",
      inputSchema: z.object({ projectId: z.string().uuid(), limit: z.number().int().min(1).max(100).optional() }),
      outputSchema: z.object({ milestones: z.array(milestoneSummarySchema) }),
    },
    ({ projectId, limit }) => {
      try {
        const milestones = listMilestones(database, projectId, principalId, limit);
        return { content: [{ type: "text", text: JSON.stringify({ milestones }) }], structuredContent: { milestones } };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "milestone_forecast_history",
    {
      title: "Consultar histórico de previsões",
      description: "Lista snapshots imutáveis recentes de um marco/time; retorna os resultados, sem insumos completos da simulação.",
      inputSchema: z.object({
        projectId: z.string().uuid().describe("UUID do projeto retornado por project_list."),
        milestoneIdOrKey: z.string().trim().min(1).max(80).describe("UUID ou chave do marco."),
        teamId: z.string().uuid().optional().describe("Time da previsão; obrigatório quando o projeto tem vários times."),
        limit: z.number().int().min(1).max(20).optional().describe("Máximo de snapshots recentes; padrão 10, máximo 20."),
      }),
      outputSchema: z.object({ forecasts: z.array(metricsObjectSchema) }),
    },
    ({ projectId, milestoneIdOrKey, teamId, limit }) => {
      try {
        const entries = listMilestoneForecastHistory(database, {
          projectId, principalId, milestoneIdOrKey,
          ...(teamId === undefined ? {} : { teamId }),
          limit: limit ?? 10,
        });
        const result = { forecasts: entries.map(({ forecast }) => forecast) };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "milestone_forecast_recalculate",
    {
      title: "Recalcular snapshot de previsão",
      description: "Reexecuta o algoritmo e insumos imutáveis do snapshot indicado para verificar reprodutibilidade; não grava dados.",
      inputSchema: z.object({
        projectId: z.string().uuid().describe("UUID do projeto retornado por project_list."),
        forecastId: z.string().uuid().describe("ID do snapshot retornado por metrics_get ou milestone_forecast_history."),
      }),
      outputSchema: forecastRecalculationSchema,
    },
    ({ projectId, forecastId }) => {
      try {
        const recalculation = recalculateMilestoneForecast(database, { projectId, principalId, forecastId });
        return toolResult(recalculation);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "metrics_get",
    {
      title: "Consultar métricas do projeto",
      description: "Retorna a mesma projeção auditável do dashboard: burnup, previsão, sprint, velocidade, WIP e cobertura, em um único snapshot SQLite.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        teamId: z.string().uuid().optional(),
        milestoneId: z.string().trim().min(1).max(80).optional(),
        sprintId: z.string().trim().min(1).max(80).optional(),
        asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
      }),
      outputSchema: dashboardMetricsSchema,
    },
    ({ projectId, teamId, milestoneId, sprintId, asOfDate }) => {
      try {
        const metrics = getProjectDashboardMetrics(database, {
          projectId,
          principalId,
          ...(teamId === undefined ? {} : { teamId }),
          ...(milestoneId === undefined ? {} : { milestoneId }),
          ...(sprintId === undefined ? {} : { sprintId }),
          ...(asOfDate === undefined ? {} : { asOfDate }),
        });
        return toolResult(metrics);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "project_feature_roadmap_get",
    {
      title: "Consultar roadmap priorizado por feature",
      description: "Retorna Features ordenadas por prioridade efetiva e valor de negócio, progresso por story points confirmados, bloqueios externos, sprints planejadas e previsão P25/P50/P75. Exige três sprints fechadas comparáveis para datas; escopo sem estimativa, dependências abertas ou ausência de capacidade mantém datas indisponíveis.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        teamId: z.string().uuid().optional(),
        asOfDate: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/u).optional(),
      }),
      outputSchema: z.object({
        projectId: z.string().uuid(), teamId: z.string().uuid().nullable(), teamName: z.string().nullable(),
        teamGenerationNumber: z.number().int().nonnegative().nullable(), asOfDate: z.string(), timezone: z.string(),
        watermarkSequence: z.number().int().nonnegative(), velocitySampleSize: z.number().int().nonnegative(),
        minimumVelocitySamples: z.number().int().positive(),
        forecastBasis: z.enum(["historical_sprint_velocity_sequential_priority", "unavailable"]),
        forecastAssumption: z.string(),
        forecastUnavailableReason: z.enum(["team_required", "insufficient_velocity_samples", "unknown_feature_scope", "external_dependency", "zero_velocity"]).nullable(),
        featuresTruncated: z.boolean(),
        epics: z.array(z.object({ key: z.string(), featureCount: z.number().int().nonnegative(), taskTotal: z.number().int().nonnegative(), taskDone: z.number().int().nonnegative(), progressPercent: z.number().min(0).max(100).nullable() })),
        sprintTimeline: z.array(z.object({ index: z.number().int().positive(), startsOn: z.string(), endsOn: z.string(), source: z.enum(["planned_sprint", "historical_median"]) })),
        features: z.array(z.object({
          id: z.string().uuid(), key: z.string(), title: z.string(), state: z.string(), priority: z.number().int().min(1).max(4),
          effectivePriority: z.number().int().min(1).max(4), businessValueScore: z.number().int().min(0).max(100).nullable(),
          businessValueRationale: z.string().nullable(), businessValueSource: z.string().nullable(), rank: z.number().int().positive(),
          completedPoints: z.number().nonnegative(), remainingPoints: z.number().nonnegative(), cancelledPoints: z.number().nonnegative(),
          unestimatedItemCount: z.number().int().nonnegative(), totalItems: z.number().int().nonnegative(), completedItems: z.number().int().nonnegative(),
          cancelledItems: z.number().int().nonnegative(),
          progressPercent: z.number().min(0).max(100).nullable(),
          deliveredPercent: z.number().min(0).max(100).nullable(),
          taskTotal: z.number().int().nonnegative(), taskDone: z.number().int().nonnegative(),
          externalBlockers: z.array(z.object({ key: z.string(), state: z.string() })),
          forecast: z.object({ status: z.enum(["completed", "forecast_ready", "insufficient_data", "incomplete_scope", "blocked", "zero_velocity"]),
            favorableDate: z.string().nullable(), baseDate: z.string().nullable(), cautiousDate: z.string().nullable(),
            favorableSprint: z.number().int().positive().nullable(), baseSprint: z.number().int().positive().nullable(), cautiousSprint: z.number().int().positive().nullable() }),
        })),
      }),
    },
    ({ projectId, teamId, asOfDate }) => {
      try {
        const result = getProjectFeatureRoadmap(database, {
          projectId,
          principalId,
          ...(teamId === undefined ? {} : { teamId }),
          ...(asOfDate === undefined ? {} : { asOfDate }),
        });
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

}
