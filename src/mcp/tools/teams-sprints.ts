import { z } from "zod";
import { createTeamCapacityConfiguration, getTeamCapacity, setTeamCapacityConfiguration } from "../../application/team-capacity.js";
import { listProjectTeams } from "../../application/team-directory.js";
import { getDefinitionOfDone, setDefinitionOfDone } from "../../application/definition-of-done.js";
import { cancelSprint, changeSprintScope, closeSprint, createSprintDraft, startSprint } from "../../application/sprint-commands.js";
import { getSprint, listSprints } from "../../application/sprint-queries.js";
import { getSprintRetrospective, setSprintRetrospective } from "../../application/sprint-retrospectives.js";
import { sprintStates } from "../../domain/sprints.js";
import { teamCapacityConfigurationSchema, teamCapacityReportSchema, teamSummarySchema, teamCapacityInputFieldsSchema, definitionOfDoneRevisionSchema, sprintRetrospectiveRevisionSchema, sprintRetrospectiveReadSchema, sprintSchema } from "../schemas.js";
import { toToolError, toolResult } from "../tool-support.js";
import type { McpToolContext } from "../tool-context.js";

export function registerTeamSprintTools(context: McpToolContext): void {
  const { server, database, principalId } = context;
  server.registerTool(
    "team_list",
    {
      title: "Listar times",
      description: "Lista os times do projeto, incluindo configuração corrente, membros e versões.",
      inputSchema: z.object({ projectId: z.string().uuid() }),
      outputSchema: z.object({ teams: z.array(teamSummarySchema) }),
    },
    ({ projectId }) => {
      try {
        const teams = listProjectTeams(database, projectId, principalId);
        return { content: [{ type: "text", text: JSON.stringify({ teams }) }], structuredContent: { teams } };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "team_create",
    {
      title: "Criar time",
      description: "Cria um novo time com configuração inicial, calendário e composição próprios.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
      }).extend(teamCapacityInputFieldsSchema.shape),
      outputSchema: z.object({ configuration: teamCapacityConfigurationSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, teamName, timezone, hoursPerDay, workingDays, members, holidays, absences, reason }) => {
      try {
        const receipt = createTeamCapacityConfiguration(database, {
          projectId, principalId, requestId, teamName, timezone, hoursPerDay, workingDays, members, reason,
          ...(holidays === undefined ? {} : { holidays }),
          ...(absences === undefined ? {} : { absences }),
        });
        const result = { configuration: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "team_capacity_set",
    {
      title: "Configurar capacidade do time",
      description: "Cria uma versão imutável da capacidade do time selecionado; em projetos com vários times, informe teamId.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        expectedVersion: z.number().int().min(0),
        teamId: z.string().uuid().optional(),
      }).extend(teamCapacityInputFieldsSchema.shape),
      outputSchema: z.object({
        configuration: teamCapacityConfigurationSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, expectedVersion, teamId, teamName, timezone, hoursPerDay, workingDays, members, holidays, absences, reason }) => {
      try {
        const receipt = setTeamCapacityConfiguration(database, {
          projectId, principalId, requestId, expectedVersion, teamName, timezone, hoursPerDay, workingDays, members, reason,
          ...(teamId === undefined ? {} : { teamId }),
          ...(holidays === undefined ? {} : { holidays }),
          ...(absences === undefined ? {} : { absences }),
        });
        const result = { configuration: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "team_capacity_get",
    {
      title: "Consultar capacidade do time",
      description: "Calcula horas disponíveis por pessoa e por dia útil, considerando dedicação, calendário, período ativo e ausências.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        configVersion: z.number().int().positive().optional(),
        teamId: z.string().uuid().optional(),
      }),
      outputSchema: teamCapacityReportSchema,
    },
    ({ projectId, startDate, endDate, configVersion, teamId }) => {
      try {
        const report = getTeamCapacity(database, {
          projectId, principalId, startDate, endDate,
          ...(configVersion === undefined ? {} : { configVersion }),
          ...(teamId === undefined ? {} : { teamId }),
        });
        return toolResult(report);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "definition_of_done_set",
    {
      title: "Definir Definition of Done",
      description: "Cria uma revisão imutável dos critérios compartilhados de conclusão do projeto.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        expectedVersion: z.number().int().min(0),
        criteria: z.array(z.object({ id: z.string().uuid().optional(), description: z.string().trim().min(1).max(500) })).min(1).max(50),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ revision: definitionOfDoneRevisionSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, expectedVersion, criteria, reason }) => {
      try {
        const receipt = setDefinitionOfDone(database, { projectId, principalId, requestId, expectedVersion, criteria, reason });
        const result = { revision: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "definition_of_done_get",
    {
      title: "Consultar Definition of Done",
      description: "Retorna a revisão atual ou uma revisão histórica da Definition of Done do projeto.",
      inputSchema: z.object({ projectId: z.string().uuid(), revisionNumber: z.number().int().positive().optional() }),
      outputSchema: definitionOfDoneRevisionSchema,
    },
    ({ projectId, revisionNumber }) => {
      try {
        const revision = getDefinitionOfDone(database, projectId, principalId, revisionNumber);
        return toolResult(revision);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_draft",
    {
      title: "Planejar sprint",
      description: "Cria um rascunho de sprint com versão de capacidade e Definition of Done fixadas e PBIs Ready comprometidos.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        teamId: z.string().uuid().optional(),
        sprintKey: z.string().trim().min(1).max(32),
        title: z.string().trim().min(1).max(120),
        goal: z.string().trim().min(1).max(1_000),
        startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        itemIdsOrKeys: z.array(z.string().trim().min(1).max(80)).min(1).max(100),
        capacityConfigVersion: z.number().int().positive().optional(),
        definitionOfDoneRevision: z.number().int().positive().optional(),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ sprint: sprintSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, teamId, sprintKey, title, goal, startsOn, endsOn, itemIdsOrKeys, capacityConfigVersion, definitionOfDoneRevision, reason }) => {
      try {
        const receipt = createSprintDraft(database, {
          projectId, principalId, requestId, sprintKey, title, goal, startsOn, endsOn, itemIdsOrKeys, reason,
          ...(teamId === undefined ? {} : { teamId }),
          ...(capacityConfigVersion === undefined ? {} : { capacityConfigVersion }),
          ...(definitionOfDoneRevision === undefined ? {} : { definitionOfDoneRevision }),
        });
        const result = { sprint: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_scope_change",
    {
      title: "Alterar escopo da sprint",
      description: "Inclui ou remove PBIs do escopo, preservando cada alteração no histórico imutável.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        sprintIdOrKey: z.string().trim().min(1).max(80),
        expectedVersion: z.number().int().positive(),
        addItemIdsOrKeys: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
        removeItemIdsOrKeys: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ sprint: sprintSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, sprintIdOrKey, expectedVersion, addItemIdsOrKeys, removeItemIdsOrKeys, reason }) => {
      try {
        const receipt = changeSprintScope(database, {
          projectId, principalId, requestId, sprintIdOrKey, expectedVersion, reason,
          ...(addItemIdsOrKeys === undefined ? {} : { addItemIdsOrKeys }),
          ...(removeItemIdsOrKeys === undefined ? {} : { removeItemIdsOrKeys }),
        });
        const result = { sprint: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_start",
    {
      title: "Iniciar sprint",
      description: "Valida escopo, baseline e capacidade; inicia a sprint com snapshots de capacidade e Definition of Done.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128),
        sprintIdOrKey: z.string().trim().min(1).max(80), expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ sprint: sprintSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, sprintIdOrKey, expectedVersion, reason }) => {
      try {
        const receipt = startSprint(database, { projectId, principalId, requestId, sprintIdOrKey, expectedVersion, reason });
        const result = { sprint: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_close",
    {
      title: "Encerrar sprint",
      description: "Registra a revisão, PBIs aceitos e itens incompletos em um snapshot auditável.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128),
        sprintIdOrKey: z.string().trim().min(1).max(80), expectedVersion: z.number().int().positive(),
        acceptedItemIds: z.array(z.string().trim().min(1).max(80)).max(100),
        reviewSummary: z.string().trim().min(1).max(2_000), reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ sprint: sprintSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, sprintIdOrKey, expectedVersion, acceptedItemIds, reviewSummary, reason }) => {
      try {
        const receipt = closeSprint(database, {
          projectId, principalId, requestId, sprintIdOrKey, expectedVersion, acceptedItemIds, reviewSummary, reason,
        });
        const result = { sprint: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_cancel",
    {
      title: "Cancelar sprint",
      description: "Cancela uma sprint draft ou ativa, preservando escopo e transição no histórico.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128),
        sprintIdOrKey: z.string().trim().min(1).max(80), expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ sprint: sprintSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, sprintIdOrKey, expectedVersion, reason }) => {
      try {
        const receipt = cancelSprint(database, { projectId, principalId, requestId, sprintIdOrKey, expectedVersion, reason });
        const result = { sprint: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_retrospective_set",
    {
      title: "Registrar retrospectiva da sprint",
      description: "Cria uma revisão imutável da retrospectiva de uma sprint fechada. Exige facilitador humano e responsáveis humanos do projeto.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        sprintIdOrKey: z.string().trim().min(1).max(80),
        expectedVersion: z.number().int().nonnegative(),
        summary: z.string().trim().min(1).max(2_000),
        keepDoing: z.array(z.string().trim().min(1).max(500)).max(20),
        stopDoing: z.array(z.string().trim().min(1).max(500)).max(20),
        tryNext: z.array(z.string().trim().min(1).max(500)).max(20),
        actions: z.array(z.object({
          id: z.string().uuid().optional(),
          title: z.string().trim().min(1).max(300),
          ownerPrincipalId: z.string().uuid(),
          linkedWorkItemIdOrKey: z.string().trim().min(1).max(80).optional(),
        })).max(50),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({
        retrospective: sprintRetrospectiveRevisionSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    async (input) => {
      try {
        const receipt = setSprintRetrospective(database, { ...input, principalId });
        const result = { retrospective: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_retrospective_get",
    {
      title: "Consultar retrospectiva da sprint",
      description: "Retorna retrospectiva atual ou revisão histórica e a lista de revisões da sprint.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        sprintIdOrKey: z.string().trim().min(1).max(80),
        revisionNumber: z.number().int().positive().optional(),
      }),
      outputSchema: sprintRetrospectiveReadSchema,
    },
    ({ projectId, sprintIdOrKey, revisionNumber }) => {
      try {
        const result = getSprintRetrospective(database, {
          projectId,
          principalId,
          sprintIdOrKey,
          ...(revisionNumber === undefined ? {} : { revisionNumber }),
        });
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_get",
    {
      title: "Consultar sprint",
      description: "Retorna sprint, escopo vigente, histórico de alterações e snapshots de início e encerramento.",
      inputSchema: z.object({ projectId: z.string().uuid(), sprintIdOrKey: z.string().trim().min(1).max(80) }),
      outputSchema: sprintSchema,
    },
    ({ projectId, sprintIdOrKey }) => {
      try {
        const sprint = getSprint(database, projectId, principalId, sprintIdOrKey);
        return toolResult(sprint);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_list",
    {
      title: "Listar sprints",
      description: "Lista sprints do projeto, com filtros opcionais por estado.",
      inputSchema: z.object({
        projectId: z.string().uuid(), teamId: z.string().uuid().optional(),
        statuses: z.array(z.enum(sprintStates)).max(4).optional(), limit: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: z.object({ sprints: z.array(sprintSchema) }),
    },
    ({ projectId, teamId, statuses, limit }) => {
      try {
        const sprints = listSprints(database, projectId, principalId, {
          ...(statuses === undefined ? {} : { statuses }),
          ...(limit === undefined ? {} : { limit }),
          ...(teamId === undefined ? {} : { teamId }),
        });
        const result = { sprints };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

}
