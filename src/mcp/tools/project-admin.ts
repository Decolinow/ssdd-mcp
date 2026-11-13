import { z } from "zod";
import { createManagedUser, listManagedUsers, revokeManagedUserAuthKeys, rotateManagedUserAuthKey } from "../../application/user-management.js";
import { approvableMcpToolNames, issueToolApproval, revokeToolApproval, type ApprovableMcpToolName } from "../../application/command-approvals.js";
import type { JsonValue } from "../../application/idempotent-command.js";
import { getProject, listProjects } from "../../application/project-queries.js";
import { bindRoadmapItemId, listRoadmapItemIds, resolveRoadmapItemId } from "../../application/roadmap-identifiers.js";
import { getTaskBriefing } from "../../application/task-briefing.js";
import { fixWorkItemBaseline, getWorkBaseline, listImpactFlags, revalidateWorkItemBaseline } from "../../application/baseline-commands.js";
import { getTaskContext, taskContextProfiles, taskContextSections } from "../../application/task-context.js";
import { projectListItemSchema, projectDetailsSchema, userProjectAccessSchema, managedUserReceiptSchema, managedUsersSchema, roadmapItemReferenceSchema, baselineSchema, impactFlagSchema, taskContextSchema } from "../schemas.js";
import { toToolError, toolResult } from "../tool-support.js";
import type { McpToolContext } from "../tool-context.js";

export function registerProjectAdminTools(context: McpToolContext): void {
  const { server, database, principalId } = context;
  server.registerTool(
    "approval_issue",
    {
      title: "Autorizar uma execução de agente",
      description: "Admin humano aprova uma única chamada, vinculada ao projeto, ferramenta, argumentos, versão esperada e executor, por até dez minutos.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        toolName: z.enum(approvableMcpToolNames),
        arguments: z.record(z.string(), z.json()),
        expectedVersion: z.number().int().min(0).nullable(),
        executorPrincipalId: z.string().uuid(),
        expiresInSeconds: z.number().int().min(30).max(600),
        reason: z.string().trim().min(1).max(500),
      }),
      outputSchema: z.object({
        approval: z.object({
          approvalId: z.string().uuid(),
          projectId: z.string().uuid(),
          toolName: z.enum(approvableMcpToolNames),
          argumentsHash: z.string().length(64),
          expectedVersion: z.number().int().min(0).nullable(),
          executorPrincipalId: z.string().uuid(),
          approvedByPrincipalId: z.string().uuid(),
          issuedAt: z.string().datetime(),
          expiresAt: z.string().datetime(),
          status: z.literal("pending"),
        }),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, toolName, arguments: toolArguments, expectedVersion, executorPrincipalId, expiresInSeconds, reason }) => {
      try {
        const receipt = issueToolApproval(database, {
          projectId,
          principalId,
          requestId,
          toolName: toolName as ApprovableMcpToolName,
          arguments: toolArguments as JsonValue,
          expectedVersion,
          executorPrincipalId,
          expiresInSeconds,
          reason,
        });
        const result = { approval: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "approval_revoke",
    {
      title: "Revogar aprovação de execução",
      description: "Revoga uma aprovação ainda pendente. Apenas um admin humano do projeto pode revogar; aprovações consumidas são imutáveis.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        approvalId: z.string().uuid(),
        reason: z.string().trim().min(1).max(500),
      }),
      outputSchema: z.object({
        approval: z.object({
          approvalId: z.string().uuid(),
          status: z.literal("revoked"),
          revokedAt: z.string().datetime(),
        }),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, approvalId, reason }) => {
      try {
        const receipt = revokeToolApproval(database, { projectId, principalId, requestId, approvalId, reason });
        const result = { approval: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "task_context_get",
    {
      title: "Consultar contexto de tarefa",
      description: "Retorna contexto de PBI, regras, decisões, cenários e execuções selecionado para Dev, QA ou PO, com proveniência e paginação.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        taskIdOrKey: z.string().trim().min(1).max(80),
        profile: z.enum(taskContextProfiles).optional(),
        include: z.array(z.enum(taskContextSections)).max(taskContextSections.length).optional(),
        maxChars: z.number().int().min(2_000).max(30_000).optional(),
        cursor: z.string().max(4_096).optional(),
      }),
      outputSchema: taskContextSchema,
    },
    ({ projectId, taskIdOrKey, profile, include, maxChars, cursor }) => {
      try {
        const result = getTaskContext(database, {
          projectId,
          principalId,
          taskIdOrKey,
          ...(profile === undefined ? {} : { profile }),
          ...(include === undefined ? {} : { include }),
          ...(maxChars === undefined ? {} : { maxChars }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "task_briefing_get",
    {
      title: "Briefing da tarefa em uma chamada",
      description: "Primeiro passo de uma tarefa: contexto (mesmo orçamento/cursor de task_context_get), gates de início, progresso do workflow, perguntas abertas, termos de glossário citados, DoD e a próxima ação recomendada.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        taskIdOrKey: z.string().trim().min(1).max(80),
        profile: z.enum(taskContextProfiles).optional(),
        include: z.array(z.enum(taskContextSections)).max(taskContextSections.length).optional(),
        maxChars: z.number().int().min(2_000).max(30_000).optional(),
        cursor: z.string().max(4_096).optional(),
      }),
      outputSchema: z.object({
        context: taskContextSchema,
        startReadiness: z.object({
          canStart: z.boolean(),
          blockers: z.array(z.object({ code: z.string(), message: z.string() })),
          warnings: z.array(z.object({ code: z.string(), message: z.string() })),
        }),
        workflow: z.object({
          published: z.boolean(), unpublishedDraft: z.boolean(), progressPercent: z.number().nullable(),
          completedSteps: z.number().int().nonnegative(), totalSteps: z.number().int().nonnegative(),
        }),
        openQuestions: z.array(z.object({ key: z.string(), itemKey: z.string(), text: z.string(), blocking: z.boolean() })),
        glossaryTerms: z.array(z.object({ key: z.string(), title: z.string() })),
        nextAction: z.string(),
      }),
    },
    ({ projectId, taskIdOrKey, profile, include, maxChars, cursor }) => {
      try {
        const result = getTaskBriefing(database, {
          projectId, principalId, taskIdOrKey,
          ...(profile === undefined ? {} : { profile }), ...(include === undefined ? {} : { include }),
          ...(maxChars === undefined ? {} : { maxChars }), ...(cursor === undefined ? {} : { cursor }),
        });
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "project_list",
    {
      title: "Listar projetos",
      description: "Lista os projetos aos quais a identidade local autenticada tem acesso.",
      inputSchema: z.object({}),
      outputSchema: z.object({ projects: z.array(projectListItemSchema) }),
    },
    async () => {
      try {
        const result = { projects: listProjects(database, principalId) };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "user_create",
    {
      title: "Criar usuário MCP",
      description: "Cria um principal, concede papéis por projeto e emite uma authKey aleatória de uso único. O segredo não é gravado em auditoria nem em registros de idempotência.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(128),
        displayName: z.string().trim().min(1).max(128),
        principalType: z.enum(["human", "agent", "service"]),
        projects: z.array(userProjectAccessSchema).min(1).max(100),
        reason: z.string().trim().min(1).max(500),
      }),
      outputSchema: managedUserReceiptSchema,
    },
    ({ requestId, displayName, principalType, projects, reason }) => {
      try {
        const receipt = createManagedUser(database, {
          actorPrincipalId: principalId, requestId, displayName, principalType, projects, reason,
        });
        return toolResult(receipt);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "user_list",
    {
      title: "Listar usuários MCP",
      description: "Lista identidades, acessos de projeto e metadados de chaves sem revelar segredos.",
      inputSchema: z.object({}),
      outputSchema: managedUsersSchema,
    },
    () => {
      try {
        const result = { users: listManagedUsers(database, principalId) };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "user_auth_key_rotate",
    {
      title: "Rotacionar authKey de usuário",
      description: "Revoga a chave ativa e emite uma substituta uma única vez. Uma repetição idempotente nunca devolve novamente o segredo.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(128),
        principalId: z.string().uuid(),
        reason: z.string().trim().min(1).max(500),
      }),
      outputSchema: managedUserReceiptSchema,
    },
    ({ requestId, principalId: targetPrincipalId, reason }) => {
      try {
        const receipt = rotateManagedUserAuthKey(database, {
          actorPrincipalId: principalId, targetPrincipalId, requestId, reason,
        });
        return toolResult(receipt);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "user_auth_key_revoke",
    {
      title: "Revogar authKey de usuário",
      description: "Revoga a chave ativa específica ou todas as chaves de um usuário para bloquear novas conexões.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(128),
        principalId: z.string().uuid(),
        keyId: z.string().uuid().optional(),
        reason: z.string().trim().min(1).max(500),
      }),
      outputSchema: z.object({ principalId: z.string().uuid(), revokedCount: z.number().int().nonnegative(), replayed: z.boolean() }),
    },
    ({ requestId, principalId: targetPrincipalId, keyId, reason }) => {
      try {
        const result = revokeManagedUserAuthKeys(database, {
          actorPrincipalId: principalId, targetPrincipalId, requestId,
          ...(keyId === undefined ? {} : { keyId }), reason,
        });
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "roadmap_id_bind",
    {
      title: "Vincular ID estável do roadmap",
      description: "Registra uma associação imutável por projeto entre SSDD-### e a tarefa real do MCP, sem confundir o ID estável com a chave gerada do work item.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128),
        roadmapId: z.string().trim().regex(/^SSDD-\d{3}$/u), itemIdOrKey: z.string().trim().min(1).max(120),
      }),
      outputSchema: z.object({ roadmapItem: roadmapItemReferenceSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, roadmapId, itemIdOrKey }) => {
      try {
        const receipt = bindRoadmapItemId(database, { projectId, principalId, requestId, roadmapId, itemIdOrKey });
        const result = { roadmapItem: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "roadmap_id_resolve",
    {
      title: "Resolver ID estável do roadmap",
      description: "Resolve SSDD-### para a identidade real da tarefa no projeto; use quando um plano ou dependência cita o ID estável do roadmap.",
      inputSchema: z.object({ projectId: z.string().uuid(), roadmapId: z.string().trim().regex(/^SSDD-\d{3}$/u) }),
      outputSchema: z.object({ roadmapItem: roadmapItemReferenceSchema }),
    },
    ({ projectId, roadmapId }) => {
      try {
        const result = { roadmapItem: resolveRoadmapItemId(database, { projectId, principalId, roadmapId }) };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "roadmap_id_list",
    {
      title: "Listar IDs estáveis do roadmap",
      description: "Lista o mapa de IDs documentados para UUIDs e chaves geradas no projeto.",
      inputSchema: z.object({ projectId: z.string().uuid() }),
      outputSchema: z.object({ roadmapItems: z.array(roadmapItemReferenceSchema) }),
    },
    ({ projectId }) => {
      try {
        const result = { roadmapItems: listRoadmapItemIds(database, { projectId, principalId }) };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "project_get",
    {
      title: "Consultar projeto",
      description: "Retorna a configuração do projeto pelo projectId retornado por project_list.",
      inputSchema: z.object({ projectId: z.string().uuid() }),
      outputSchema: z.object({ project: projectDetailsSchema }),
    },
    ({ projectId }) => {
      try {
        const result = { project: getProject(database, principalId, projectId) };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "baseline_fix",
    {
      title: "Fixar baseline",
      description: "Congela as revisões publicadas do item, especificações ligadas e cenários de cobertura quando o item está Ready.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ baseline: baselineSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, itemIdOrKey, expectedVersion, reason }) => {
      try {
        const receipt = fixWorkItemBaseline(database, {
          projectId, principalId, requestId, itemIdOrKey, expectedVersion, reason,
        });
        const result = { baseline: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "baseline_get",
    {
      title: "Consultar baseline",
      description: "Resolve o snapshot histórico por item e sequência; omitindo a sequência retorna a mais recente.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
        sequence: z.number().int().positive().optional(),
      }),
      outputSchema: z.object({ baseline: baselineSchema }),
    },
    ({ projectId, itemIdOrKey, sequence }) => {
      try {
        const result = { baseline: getWorkBaseline(database, projectId, principalId, itemIdOrKey, sequence) };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "impact_list",
    {
      title: "Listar impactos",
      description: "Lista impactos abertos e revalidados causados por publicação de especificações após Ready.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
        status: z.enum(["open", "revalidated"]).optional(),
      }),
      outputSchema: z.object({ impacts: z.array(impactFlagSchema) }),
    },
    ({ projectId, itemIdOrKey, status }) => {
      try {
        const result = { impacts: listImpactFlags(database, projectId, principalId, itemIdOrKey, status) };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "baseline_revalidate",
    {
      title: "Revalidar baseline",
      description: "Cria nova baseline com revisões vigentes e resolve os impactos cobertos por ela.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({
        baseline: baselineSchema,
        resolvedImpactIds: z.array(z.string().uuid()),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, expectedVersion, reason }) => {
      try {
        const receipt = revalidateWorkItemBaseline(database, {
          projectId, principalId, requestId, itemIdOrKey, expectedVersion, reason,
        });
        const result = { ...receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

}
