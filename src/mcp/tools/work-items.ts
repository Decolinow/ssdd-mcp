import { z } from "zod";
import { getTaskExecutionQueue } from "../../application/prioritized-roadmap.js";
import { createWorkItem } from "../../application/create-work-item.js";
import { getWorkItem, listWorkItemRevisions, listWorkItems } from "../../application/work-item-queries.js";
import { addWorkItemComment, assignWorkItem, confirmWorkItemEstimate, listWorkItemComments, proposeWorkItemEstimate, rankWorkItem } from "../../application/work-item-commands.js";
import { workItemStates, workItemTypes } from "../../domain/work-items.js";
import { proposeWorkItemRevision, publishWorkItemRevision } from "../../application/work-item-revisions.js";
import { indexWorkItemSemantics, searchWorkItemsSemantically } from "../../application/semantic-work-item-search.js";
import { criterionStructureShape, workItemEstimateProposalSchema, workItemCommentSchema, workItemSchema, workItemContentRevisionSchema, workItemListItemSchema } from "../schemas.js";
import { currentItemVersion, toToolError, leanTaskQueue, toolResult } from "../tool-support.js";
import type { McpToolContext } from "../tool-context.js";

export function registerWorkItemTools(context: McpToolContext): void {
  const { server, database, principalId, embeddingProvider } = context;
  server.registerTool(
    "work_item_create",
    {
      title: "Criar item de trabalho",
      description:
        "Cria épico, funcionalidade, história, bug ou tarefa, validando hierarquia e auditando a alteração.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        type: z.enum(workItemTypes),
        parentId: z.string().trim().min(1).optional(),
        relatedStoryId: z.string().trim().min(1).optional(),
        title: z.string().trim().min(1).max(200),
        description: z.string().max(10_000).optional(),
        priority: z.number().int().min(1).max(4).optional(),
        businessValueScore: z.number().int().min(0).max(100).nullable().optional(),
        businessValueRationale: z.string().trim().max(1000).nullable().optional(),
        criteria: z
          .array(z.object({ description: z.string().trim().min(1).max(2_000), required: z.boolean().optional() }))
          .max(50)
          .optional(),
      }),
      outputSchema: z.object({
        workItem: workItemSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, type, parentId, relatedStoryId, title, description, priority, businessValueScore, businessValueRationale, criteria }) => {
      try {
        const receipt = createWorkItem(database, {
          projectId,
          principalId,
          requestId,
          type,
          title,
          ...(parentId === undefined ? {} : { parentId }),
          ...(relatedStoryId === undefined ? {} : { relatedStoryId }),
          ...(description === undefined ? {} : { description }),
          ...(priority === undefined ? {} : { priority }),
          ...(businessValueScore === undefined ? {} : { businessValueScore }),
          ...(businessValueRationale === undefined ? {} : { businessValueRationale }),
          ...(criteria === undefined ? {} : { criteria }),
        });
        const result = { workItem: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_get",
    {
      title: "Consultar item de trabalho",
      description: "Consulta um item pelo UUID ou chave legível, como PAY-12.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
      }),
      outputSchema: z.object({ workItem: workItemSchema }),
    },
    ({ projectId, itemIdOrKey }) => {
      try {
        const result = { workItem: getWorkItem(database, projectId, principalId, itemIdOrKey) };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_revision_list",
    {
      title: "Listar revisões de item",
      description: "Lista revisões imutáveis de conteúdo e indica qual versão está em rascunho ou publicada.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
      }),
      outputSchema: z.object({ revisions: z.array(workItemContentRevisionSchema) }),
    },
    ({ projectId, itemIdOrKey }) => {
      try {
        const result = { revisions: listWorkItemRevisions(database, projectId, principalId, itemIdOrKey) };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_revision_propose",
    {
      title: "Propor revisão de item",
      description: "Cria snapshot candidato sem alterar o conteúdo publicado; critérios existentes preservam seus IDs.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        expectedVersion: z.number().int().positive(),
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(10_000).nullable().optional(),
        priority: z.number().int().min(1).max(4).optional(),
        businessValueScore: z.number().int().min(0).max(100).nullable().optional(),
        businessValueRationale: z.string().trim().max(1000).nullable().optional(),
        criteria: z.array(z.object({
          id: z.string().uuid().optional(),
          description: z.string().trim().min(1).max(2_000),
          required: z.boolean().optional(),
          ...criterionStructureShape,
        })).max(50).optional(),
      }),
      outputSchema: z.object({
        revision: workItemContentRevisionSchema,
        version: z.number().int().positive(),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, expectedVersion, title, description, priority, businessValueScore, businessValueRationale, criteria }) => {
      try {
        const receipt = proposeWorkItemRevision(database, {
          projectId,
          principalId,
          requestId,
          itemIdOrKey,
          expectedVersion,
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          ...(priority === undefined ? {} : { priority }),
          ...(businessValueScore === undefined ? {} : { businessValueScore }),
          ...(businessValueRationale === undefined ? {} : { businessValueRationale }),
          ...(criteria === undefined
            ? {}
            : {
                criteria: criteria.map((criterion) => ({
                  ...(criterion.id === undefined ? {} : { id: criterion.id }),
                  description: criterion.description,
                  ...(criterion.required === undefined ? {} : { required: criterion.required }),
                  ...(criterion.given === undefined ? {} : { given: criterion.given }),
                  ...(criterion.when === undefined ? {} : { when: criterion.when }),
                  ...(criterion.then === undefined ? {} : { then: criterion.then }),
                  ...(criterion.verification === undefined ? {} : { verification: criterion.verification }),
                  ...(criterion.example === undefined ? {} : { example: criterion.example }),
                })),
              }),
        });
        const result = { revision: receipt.value, version: currentItemVersion(database, projectId, receipt.value.itemId), auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_revision_publish",
    {
      title: "Publicar revisão de item",
      description: "Publica o rascunho mais recente com confirmação humana PO e atualiza o conteúdo corrente do item.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        revisionNumber: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
      }),
      outputSchema: z.object({
        revision: workItemContentRevisionSchema,
        version: z.number().int().positive(),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, revisionNumber, expectedVersion }) => {
      try {
        const receipt = publishWorkItemRevision(database, {
          projectId,
          principalId,
          requestId,
          itemIdOrKey,
          revisionNumber,
          expectedVersion,
        });
        const result = { revision: receipt.value, version: currentItemVersion(database, projectId, receipt.value.itemId), auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_list",
    {
      title: "Listar itens de trabalho",
      description:
        "Lista itens com filtros combináveis, busca textual e cursor estável. assignedToMe=true limita aos itens atribuídos à identidade autenticada.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        types: z.array(z.enum(workItemTypes)).max(5).optional(),
        states: z.array(z.enum(workItemStates)).max(7).optional(),
        parentId: z.string().trim().min(1).max(80).optional(),
        search: z.string().trim().min(1).max(200).optional(),
        assignedToMe: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).max(4096).optional(),
      }),
      outputSchema: z.object({
        items: z.array(workItemListItemSchema),
        nextCursor: z.string().nullable(),
      }),
    },
    ({ projectId, types, states, parentId, search, assignedToMe, limit, cursor }) => {
      try {
        const page = listWorkItems(database, {
          projectId,
          principalId,
          ...(types === undefined ? {} : { types }),
          ...(states === undefined ? {} : { states }),
          ...(parentId === undefined ? {} : { parentId }),
          ...(search === undefined ? {} : { search }),
          ...(assignedToMe === undefined ? {} : { assignedToMe }),
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
    "task_execution_queue_get",
    {
      title: "Consultar fila priorizada de execução",
      description: "Lista tarefas Ready/in_progress atribuídas ao principal (por padrão), validadas pelos bloqueios reais de início. Ordena por prioridade efetiva (P1 primeiro), valor de negócio herdado/definido (maior primeiro) e rank; valores ausentes ficam por último. Se nada puder iniciar, emptyReason explica e upNext lista as próximas tarefas ainda não Ready (sem dependência aberta primeiro), excluindo as já entregues localmente e sem aceite formal (awaitingAcceptance/awaitingAcceptanceCount) com o que falta e a próxima ação. Por padrão a resposta omite justificativa e fonte do valor de negócio e a fonte da prioridade (verbose=true as inclui; work_item_get traz a justificativa). Read-only; inicie somente com task_start após task_start_check.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        assignedToMe: z.boolean().optional().default(true),
        limit: z.number().int().min(1).max(50).optional().default(20),
        verbose: z.boolean().optional().default(false),
      }),
      outputSchema: z.object({
        projectId: z.string().uuid(),
        order: z.array(z.enum(["startable_first", "priority_ascending", "business_value_descending", "feature_rank", "task_rank", "key"])),
        assignedToMe: z.boolean(),
        scannedCount: z.number().int().nonnegative(),
        candidateLimitReached: z.boolean(),
        blockedCount: z.number().int().nonnegative(),
        businessValueMissingCount: z.number().int().nonnegative(),
        blocked: z.array(z.object({
          id: z.string().uuid(), key: z.string(), title: z.string(), state: z.string(), assigneeId: z.string().uuid().nullable(),
          priority: z.number().int().min(1).max(4), prioritySource: z.string().optional(),
          businessValueScore: z.number().int().min(0).max(100).nullable(), businessValueRationale: z.string().nullable().optional(),
          businessValueSource: z.string().nullable().optional(), featureKey: z.string().nullable(), rank: z.number().int().positive(),
          blockerCodes: z.array(z.string()),
        })),
        tasks: z.array(z.object({
          id: z.string().uuid(), key: z.string(), title: z.string(), state: z.string(), assigneeId: z.string().uuid().nullable(),
          priority: z.number().int().min(1).max(4), prioritySource: z.string().optional(),
          businessValueScore: z.number().int().min(0).max(100).nullable(), businessValueRationale: z.string().nullable().optional(),
          businessValueSource: z.string().nullable().optional(), featureKey: z.string().nullable(), rank: z.number().int().positive(),
        })),
        emptyReason: z.enum(["no_ready_tasks", "ready_tasks_blocked"]).nullable(),
        inFlight: z.array(z.object({ key: z.string(), state: z.string(), assigneeId: z.string().uuid().nullable() })),
        awaitingAcceptanceCount: z.number().int().nonnegative(),
        awaitingAcceptance: z.array(z.string()),
        upNext: z.array(z.object({
          id: z.string().uuid(), key: z.string(), title: z.string(), state: z.string(), assigneeId: z.string().uuid().nullable(),
          priority: z.number().int().min(1).max(4), prioritySource: z.string().optional(),
          businessValueScore: z.number().int().min(0).max(100).nullable(), businessValueRationale: z.string().nullable().optional(),
          businessValueSource: z.string().nullable().optional(), featureKey: z.string().nullable(), rank: z.number().int().positive(),
          unmetDependencies: z.array(z.string()),
          dependenciesAwaitingAcceptance: z.array(z.string()),
          missing: z.array(z.enum(["not_ready_state", "assignee", "estimate", "business_value", "dependencies"])),
          nextAction: z.string(),
        })),
      }),
    },
    ({ projectId, assignedToMe, limit, verbose }) => {
      try {
        const result = getTaskExecutionQueue(database, {
          projectId,
          principalId,
          assignedToMe,
          limit,
        });
        const lean = verbose ? result : leanTaskQueue(result);
        return toolResult(lean);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_semantic_index",
    {
      title: "Indexar tarefas para busca semântica",
      description: "Gera ou atualiza vetores de título, descrição e critérios para uma página de itens. Use o cursor até completar o projeto; requer provedor de embeddings configurado.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        assignedToMe: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().trim().min(1).max(4096).optional(),
      }),
      outputSchema: z.object({
        indexedCount: z.number().int().nonnegative(),
        unchangedCount: z.number().int().nonnegative(),
        skippedChangedCount: z.number().int().nonnegative(),
        model: z.string(),
        watermarkSequence: z.number().int().nonnegative(),
        nextCursor: z.string().nullable(),
      }),
    },
    async ({ projectId, assignedToMe, limit, cursor }) => {
      try {
        const result = await indexWorkItemSemantics(database, embeddingProvider, {
          projectId,
          principalId,
          ...(assignedToMe === undefined ? {} : { assignedToMe }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "work_item_semantic_search",
    {
      title: "Buscar tarefas por significado",
      description: "Busca vetorial por similaridade de embeddings, pode completar automaticamente uma página de índice e informa quando faltam itens indexados.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        query: z.string().trim().min(3).max(1_000),
        assignedToMe: z.boolean().optional(),
        types: z.array(z.enum(workItemTypes)).max(5).optional(),
        states: z.array(z.enum(workItemStates)).max(7).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      outputSchema: z.object({
        query: z.string(),
        model: z.string(),
        results: z.array(z.object({
          id: z.string().uuid(),
          key: z.string(),
          type: z.enum(workItemTypes),
          title: z.string(),
          description: z.string().nullable(),
          state: z.enum(workItemStates),
          assigneeId: z.string().uuid().nullable(),
          similarity: z.number().min(-1).max(1),
        })),
        indexedCount: z.number().int().nonnegative(),
        missingEmbeddingCount: z.number().int().nonnegative(),
        indexComplete: z.boolean(),
        nextIndexCursor: z.string().nullable(),
      }),
    },
    async ({ projectId, query, assignedToMe, types, states, limit }) => {
      try {
        const result = await searchWorkItemsSemantically(database, embeddingProvider, {
          projectId,
          principalId,
          query,
          ...(assignedToMe === undefined ? {} : { assignedToMe }),
          ...(types === undefined ? {} : { types }),
          ...(states === undefined ? {} : { states }),
          ...(limit === undefined ? {} : { limit }),
        });
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "work_item_assign",
    {
      title: "Atribuir item de trabalho",
      description: "Define ou remove o responsável após verificar papel de equipe e versão do item.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        assigneeId: z.string().uuid().nullable(),
        expectedVersion: z.number().int().positive(),
      }),
      outputSchema: z.object({
        assignment: z.object({
          itemId: z.string().uuid(),
          itemKey: z.string(),
          assigneeId: z.string().uuid().nullable(),
          version: z.number().int().positive(),
        }),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, assigneeId, expectedVersion }) => {
      try {
        const receipt = assignWorkItem(database, {
          projectId,
          principalId,
          requestId,
          itemIdOrKey,
          assigneeId,
          expectedVersion,
        });
        const result = { assignment: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_rank",
    {
      title: "Ordenar item de trabalho",
      description: "Move um item entre irmãos com controle de versão e auditoria.",
      inputSchema: z
        .object({
          projectId: z.string().uuid(),
          requestId: z.string().trim().min(1).max(128),
          itemIdOrKey: z.string().trim().min(1).max(80),
          beforeIdOrKey: z.string().trim().min(1).max(80).optional(),
          afterIdOrKey: z.string().trim().min(1).max(80).optional(),
          expectedVersion: z.number().int().positive(),
        })
        .refine((input) => (input.beforeIdOrKey === undefined) !== (input.afterIdOrKey === undefined), {
          message: "Specify exactly one beforeIdOrKey or afterIdOrKey.",
        }),
      outputSchema: z.object({
        rank: z.object({
          itemId: z.string().uuid(),
          itemKey: z.string(),
          rank: z.number().int().positive(),
          version: z.number().int().positive(),
        }),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, beforeIdOrKey, afterIdOrKey, expectedVersion }) => {
      try {
        const receipt = rankWorkItem(database, {
          projectId,
          principalId,
          requestId,
          itemIdOrKey,
          expectedVersion,
          ...(beforeIdOrKey === undefined ? {} : { beforeIdOrKey }),
          ...(afterIdOrKey === undefined ? {} : { afterIdOrKey }),
        });
        const result = { rank: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "comment_add",
    {
      title: "Comentar item de trabalho",
      description: "Adiciona comentário imutável ao histórico de um item.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        body: z.string().trim().min(1).max(5_000),
      }),
      outputSchema: z.object({
        comment: workItemCommentSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, body }) => {
      try {
        const receipt = addWorkItemComment(database, {
          projectId,
          principalId,
          requestId,
          itemIdOrKey,
          body,
        });
        const result = { comment: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "comment_list",
    {
      title: "Listar comentários",
      description: "Lista comentários do item em ordem imutável com cursor preso ao item e à identidade.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).max(2048).optional(),
      }),
      outputSchema: z.object({
        comments: z.array(workItemCommentSchema),
        nextCursor: z.string().nullable(),
      }),
    },
    ({ projectId, itemIdOrKey, limit, cursor }) => {
      try {
        const page = listWorkItemComments(database, {
          projectId,
          principalId,
          itemIdOrKey,
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
    "work_item_estimate",
    {
      title: "Propor estimativa",
      description: "Registra proposta de pontos para história/bug ou horas para tarefa.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        unit: z.enum(["points", "hours"]),
        value: z.number().int().min(1).max(10_000),
        rationale: z.string().trim().min(1).max(1_000),
        expectedVersion: z.number().int().positive(),
      }),
      outputSchema: z.object({
        proposal: workItemEstimateProposalSchema,
        version: z.number().int().positive(),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, unit, value, rationale, expectedVersion }) => {
      try {
        const receipt = proposeWorkItemEstimate(database, {
          projectId,
          principalId,
          requestId,
          itemIdOrKey,
          unit,
          value,
          rationale,
          expectedVersion,
        });
        const result = { proposal: receipt.value, version: currentItemVersion(database, projectId, receipt.value.itemId), auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_estimate_confirm",
    {
      title: "Confirmar estimativa",
      description: "Confirma uma proposta específica e atualiza a estimativa corrente do item.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        proposalId: z.string().uuid(),
        expectedVersion: z.number().int().positive(),
      }),
      outputSchema: z.object({
        proposal: workItemEstimateProposalSchema,
        version: z.number().int().positive(),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, proposalId, expectedVersion }) => {
      try {
        const receipt = confirmWorkItemEstimate(database, {
          projectId,
          principalId,
          requestId,
          itemIdOrKey,
          proposalId,
          expectedVersion,
        });
        const result = { ...receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

}
