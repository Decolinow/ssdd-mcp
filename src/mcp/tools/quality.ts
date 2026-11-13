import { z } from "zod";
import { getWorkItemQualityReport } from "../../application/quality-queries.js";
import { traceLinkTypes } from "../../domain/trace.js";
import { workItemStates } from "../../domain/work-items.js";
import { addTraceLink, removeTraceLink } from "../../application/trace-commands.js";
import { queryTraceGraph } from "../../application/trace-queries.js";
import { addWorkItemEvidence, certifyTestRun, getWorkItemGateReport, listWorkItemEvidence, transitionWorkItem } from "../../application/work-item-workflow.js";
import { evidenceKinds } from "../../domain/workflow.js";
import { workItemGateReportSchema, workItemEvidenceSchema, workItemTransitionSchema, testRunCertificationSchema, workItemQualityReportSchema, traceLinkReceiptSchema, traceGraphSchema } from "../schemas.js";
import { toToolError, toolResult } from "../tool-support.js";
import type { McpToolContext } from "../tool-context.js";

export function registerQualityTools(context: McpToolContext): void {
  const { server, database, principalId } = context;
  server.registerTool(
    "work_item_gate_check",
    {
      title: "Verificar gates do item",
      description: "Mostra os critérios pendentes para Ready ou Done, incluindo baseline, evidência, cenários e build candidato. transitionPath lista os estados a percorrer (ex.: in_review, in_validation, done) a partir do estado atual.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
        targetState: z.enum(["ready", "done"]),
        buildId: z.string().trim().min(1).max(128).optional(),
      }),
      outputSchema: workItemGateReportSchema,
    },
    ({ projectId, itemIdOrKey, targetState, buildId }) => {
      try {
        const report = getWorkItemGateReport(database, {
          projectId, principalId, itemIdOrKey, targetState,
          ...(buildId === undefined ? {} : { buildId }),
        });
        return toolResult(report);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_quality_get",
    {
      title: "Consultar qualidade do item",
      description: "Consolida critérios, cenários, últimas execuções por build, certificações e evidências na baseline ou em modo preview.",
      inputSchema: z.object({
        projectId: z.string().uuid().describe("UUID do projeto retornado por project_list."),
        itemIdOrKey: z.string().trim().min(1).max(80).describe("UUID ou chave de uma história ou bug."),
        evidenceCursor: z.string().max(4_096).optional()
          .describe("Cursor nextEvidenceCursor da resposta anterior para continuar a página de evidências."),
      }),
      outputSchema: workItemQualityReportSchema,
    },
    ({ projectId, itemIdOrKey, evidenceCursor }) => {
      try {
        const report = getWorkItemQualityReport(database, {
          projectId, principalId, itemIdOrKey,
          ...(evidenceCursor === undefined ? {} : { evidenceCursor }),
        });
        return toolResult(report);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_transition",
    {
      title: "Alterar estado do item",
      description: "Executa uma transição autorizada, registra histórico auditado e cria a baseline ao entrar em Ready.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        targetState: z.enum(workItemStates),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1_000),
        buildId: z.string().trim().min(1).max(128).optional(),
      }),
      outputSchema: z.object({
        transition: workItemTransitionSchema,
        baseline: z.object({ id: z.string().uuid(), sequence: z.number().int().positive() }).nullable(),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, targetState, expectedVersion, reason, buildId }) => {
      try {
        const receipt = transitionWorkItem(database, {
          projectId, principalId, requestId, itemIdOrKey, targetState, expectedVersion, reason,
          ...(buildId === undefined ? {} : { buildId }),
        });
        const result = { ...receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "evidence_add",
    {
      title: "Adicionar evidência",
      description: "Anexa uma referência imutável a PR, commit, build, artefato ou relatório ao item e à baseline atual.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        kind: z.enum(evidenceKinds),
        uri: z.string().trim().min(1).max(2_048),
        buildId: z.string().trim().min(1).max(128).optional(),
        description: z.string().trim().min(1).max(2_000),
      }),
      outputSchema: z.object({ evidence: workItemEvidenceSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, itemIdOrKey, kind, uri, buildId, description }) => {
      try {
        const receipt = addWorkItemEvidence(database, {
          projectId, principalId, requestId, itemIdOrKey, kind, uri, description,
          ...(buildId === undefined ? {} : { buildId }),
        });
        const result = { evidence: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "evidence_list",
    {
      title: "Listar evidências",
      description: "Lista evidências em páginas estáveis; cursor fica obsoleto após alteração do projeto.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().max(2_048).optional(),
      }),
      outputSchema: z.object({ evidence: z.array(workItemEvidenceSchema), nextCursor: z.string().nullable() }),
    },
    ({ projectId, itemIdOrKey, limit, cursor }) => {
      try {
        const result = listWorkItemEvidence(database, {
          projectId, principalId, itemIdOrKey,
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "test_run_certify",
    {
      title: "Certificar execução de QA",
      description: "Permite a uma pessoa QA certificar a última execução aprovada de cenário da baseline enquanto o PBI está em validação.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        runId: z.string().uuid(),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ certification: testRunCertificationSchema.extend({ version: z.number().int().positive() }), auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, itemIdOrKey, runId, expectedVersion, reason }) => {
      try {
        const receipt = certifyTestRun(database, {
          projectId, principalId, requestId, itemIdOrKey, runId, expectedVersion, reason,
        });
        const result = { certification: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "trace_link_add",
    {
      title: "Adicionar ligação de rastreabilidade",
      description: "Adiciona depends_on, relates_to ou implements, validando tipos de endpoint e ciclos de dependência.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        sourceIdOrKey: z.string().trim().min(1).max(80),
        targetIdOrKey: z.string().trim().min(1).max(80),
        type: z.enum(traceLinkTypes),
      }),
      outputSchema: z.object({
        link: traceLinkReceiptSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, sourceIdOrKey, targetIdOrKey, type }) => {
      try {
        const receipt = addTraceLink(database, {
          projectId,
          principalId,
          requestId,
          sourceIdOrKey,
          targetIdOrKey,
          type,
        });
        const result = { link: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "trace_link_remove",
    {
      title: "Remover ligação de rastreabilidade",
      description: "Retira uma ligação da visão corrente sem apagar o histórico.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        linkId: z.string().uuid(),
      }),
      outputSchema: z.object({
        link: z.object({ id: z.string().uuid(), removedAt: z.string().datetime() }),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, linkId }) => {
      try {
        const receipt = removeTraceLink(database, { projectId, principalId, requestId, linkId });
        const result = { link: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "trace_query",
    {
      title: "Consultar rastreabilidade",
      description: "Expande ligações ativas até três níveis e sinaliza cortes por orçamento.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        nodeIdOrKey: z.string().trim().min(1).max(80),
        direction: z.enum(["inbound", "outbound", "both"]).optional(),
        linkTypes: z.array(z.enum(traceLinkTypes)).min(1).max(3).optional(),
        depth: z.number().int().min(1).max(3).optional(),
        maxNodes: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: traceGraphSchema,
    },
    ({ projectId, nodeIdOrKey, direction, linkTypes, depth, maxNodes }) => {
      try {
        const graph = queryTraceGraph(database, {
          projectId,
          principalId,
          nodeIdOrKey,
          ...(direction === undefined ? {} : { direction }),
          ...(linkTypes === undefined ? {} : { linkTypes }),
          ...(depth === undefined ? {} : { depth }),
          ...(maxNodes === undefined ? {} : { maxNodes }),
        });
        return toolResult(graph);
      } catch (error) {
        return toToolError(error);
      }
    },
  );
}
