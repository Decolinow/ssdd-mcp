import { z } from "zod";
import { linkTaskToAdr } from "../../application/adr-commands.js";
import { createSpecification, proposeSpecificationRevision, publishSpecificationRevision, withdrawSpecificationRevision } from "../../application/specification-commands.js";
import { getSpecification, listSpecifications } from "../../application/specification-queries.js";
import { specificationKinds } from "../../domain/specifications.js";
import { scenarioKinds, testRunResults } from "../../domain/scenarios.js";
import { createScenario, proposeScenarioRevision, publishScenarioRevision, recordTestRun } from "../../application/scenario-commands.js";
import { getScenario, listScenarios, searchScenariosByCriterion } from "../../application/scenario-queries.js";
import { scenarioRevisionSchema, scenarioSummarySchema, scenarioSchema, testRunSchema, scenarioCoverageMatchSchema, scenarioContentInputSchema, specificationContentSchema, specificationRevisionSchema, specificationSchema, traceLinkReceiptSchema } from "../schemas.js";
import { toToolError, toolResult } from "../tool-support.js";
import type { McpToolContext } from "../tool-context.js";

export function registerSpecificationTools(context: McpToolContext): void {
  const { server, database, principalId } = context;
  server.registerTool(
    "spec_create",
    {
      title: "Criar especificação",
      description: "Cria uma regra, glossário, contrato, ADR ou requisito não funcional com revisão inicial em rascunho.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        key: z.string().trim().min(1).max(32),
        kind: z.enum(specificationKinds),
        title: z.string().trim().min(1).max(200),
        content: specificationContentSchema,
      }),
      outputSchema: z.object({
        revision: specificationRevisionSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, key, kind, title, content }) => {
      try {
        const receipt = createSpecification(database, {
          projectId,
          principalId,
          requestId,
          key,
          kind,
          title,
          content,
        });
        const result = { revision: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "spec_revision_propose",
    {
      title: "Propor revisão de especificação",
      description: "Cria um snapshot imutável em rascunho com controle de versão otimista.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        specIdOrKey: z.string().trim().min(1).max(80),
        expectedVersion: z.number().int().positive(),
        content: specificationContentSchema,
      }),
      outputSchema: z.object({
        revision: specificationRevisionSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, specIdOrKey, expectedVersion, content }) => {
      try {
        const receipt = proposeSpecificationRevision(database, {
          projectId,
          principalId,
          requestId,
          specIdOrKey,
          expectedVersion,
          content,
        });
        const result = { revision: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "spec_revision_publish",
    {
      title: "Publicar revisão de especificação",
      description: "Publica a revisão mais recente após validar versão, papel funcional e identidade humana.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        specIdOrKey: z.string().trim().min(1).max(80),
        revisionNumber: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
      }),
      outputSchema: z.object({
        revision: specificationRevisionSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, specIdOrKey, revisionNumber, expectedVersion }) => {
      try {
        const receipt = publishSpecificationRevision(database, {
          projectId,
          principalId,
          requestId,
          specIdOrKey,
          revisionNumber,
          expectedVersion,
        });
        const result = { revision: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "spec_revision_withdraw",
    {
      title: "Retirar rascunho de especificação",
      description: "Retira a última revisão Draft/In Review quando foi abandonada ou substituída; exige pessoa PO para regra/glossário e Tech Lead para decisão técnica, motivo auditado, versão esperada e revisão mais recente.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        specIdOrKey: z.string().trim().min(1).max(80),
        revisionNumber: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1000),
      }),
      outputSchema: z.object({ revision: specificationRevisionSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, specIdOrKey, revisionNumber, expectedVersion, reason }) => {
      try {
        const receipt = withdrawSpecificationRevision(database, {
          projectId, principalId, requestId, specIdOrKey, revisionNumber, expectedVersion, reason,
        });
        const result = { revision: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "spec_get",
    {
      title: "Consultar especificação",
      description: "Lê uma especificação e todas as revisões autorizadas pelo projeto.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        specIdOrKey: z.string().trim().min(1).max(80),
      }),
      outputSchema: z.object({ specification: specificationSchema }),
    },
    ({ projectId, specIdOrKey }) => {
      try {
        const result = { specification: getSpecification(database, projectId, principalId, specIdOrKey) };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "spec_list",
    {
      title: "Listar especificações",
      description: "Lista ou pesquisa especificações em páginas estáveis, com filtro por tipo e cursor vinculado a projeto, identidade, filtros e watermark.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        kind: z.enum(specificationKinds).optional(),
        search: z.string().trim().min(2).max(160).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).max(4_096).optional(),
      }),
      outputSchema: z.object({
        specifications: z.array(specificationSchema),
        nextCursor: z.string().nullable(),
        watermark: z.number().int().nonnegative(),
      }),
    },
    ({ projectId, kind, search, limit, cursor }) => {
      try {
        const result = listSpecifications(database, projectId, principalId, {
          ...(kind === undefined ? {} : { kind }),
          ...(search === undefined ? {} : { search }),
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
    "adr_link_task",
    {
      title: "Vincular ADR a tarefa",
      description: "Vincula uma tarefa a um ADR com relação implements (padrão) ou relates_to; valida os tipos e retorna as revisões disponíveis.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        taskIdOrKey: z.string().trim().min(1).max(120),
        adrIdOrKey: z.string().trim().min(1).max(80),
        relationship: z.enum(["implements", "relates_to"]).default("implements"),
      }),
      outputSchema: z.object({
        link: traceLinkReceiptSchema,
        adrRevision: z.object({ latest: z.number().int().nonnegative(), published: z.number().int().positive().nullable() }),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, taskIdOrKey, adrIdOrKey, relationship }) => {
      try {
        const receipt = linkTaskToAdr(database, { projectId, principalId, requestId, taskIdOrKey, adrIdOrKey, relationship });
        const result = { ...receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "scenario_create",
    {
      title: "Criar cenário",
      description: "Cria cenário de QA com primeira revisão em rascunho e cobertura de critérios ou especificações.",
      inputSchema: scenarioContentInputSchema.extend({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        key: z.string().trim().min(1).max(32),
        kind: z.enum(scenarioKinds),
      }),
      outputSchema: z.object({
        revision: scenarioRevisionSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, key, kind, title, preconditions, steps, coverage, workItemIdOrKeys }) => {
      try {
        const receipt = createScenario(database, {
          projectId,
          principalId,
          requestId,
          key,
          kind,
          title,
          steps,
          ...(preconditions === undefined ? {} : { preconditions }),
          ...(coverage === undefined ? {} : { coverage }),
          ...(workItemIdOrKeys === undefined ? {} : { workItemIdOrKeys }),
        });
        const result = { revision: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "scenario_revision_propose",
    {
      title: "Propor revisão de cenário",
      description: "Cria snapshot imutável candidato e valida novamente os vínculos de cobertura.",
      inputSchema: scenarioContentInputSchema.extend({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        scenarioIdOrKey: z.string().trim().min(1).max(80),
        expectedVersion: z.number().int().positive(),
      }),
      outputSchema: z.object({
        revision: scenarioRevisionSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, scenarioIdOrKey, expectedVersion, title, preconditions, steps, coverage, workItemIdOrKeys }) => {
      try {
        const receipt = proposeScenarioRevision(database, {
          projectId,
          principalId,
          requestId,
          scenarioIdOrKey,
          expectedVersion,
          title,
          steps,
          ...(preconditions === undefined ? {} : { preconditions }),
          ...(coverage === undefined ? {} : { coverage }),
          ...(workItemIdOrKeys === undefined ? {} : { workItemIdOrKeys }),
        });
        const result = { revision: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "scenario_revision_publish",
    {
      title: "Publicar revisão de cenário",
      description: "Publica o rascunho mais recente com confirmação humana QA.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        scenarioIdOrKey: z.string().trim().min(1).max(80),
        revisionNumber: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
      }),
      outputSchema: z.object({
        revision: scenarioRevisionSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, scenarioIdOrKey, revisionNumber, expectedVersion }) => {
      try {
        const receipt = publishScenarioRevision(database, {
          projectId,
          principalId,
          requestId,
          scenarioIdOrKey,
          revisionNumber,
          expectedVersion,
        });
        const result = { revision: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "scenario_get",
    {
      title: "Consultar cenário",
      description: "Consulta cenário pelo UUID ou chave e devolve todas as revisões.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        scenarioIdOrKey: z.string().trim().min(1).max(80),
      }),
      outputSchema: z.object({ scenario: scenarioSchema }),
    },
    ({ projectId, scenarioIdOrKey }) => {
      try {
        const result = { scenario: getScenario(database, projectId, principalId, scenarioIdOrKey) };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "scenario_list",
    {
      title: "Listar cenários",
      description: "Lista cenários em páginas estáveis, com filtro por tipo e cursor vinculado a projeto, identidade, filtros e watermark.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        kind: z.enum(scenarioKinds).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).max(4_096).optional(),
      }),
      outputSchema: z.object({
        scenarios: z.array(scenarioSummarySchema),
        nextCursor: z.string().nullable(),
        watermark: z.number().int().nonnegative(),
      }),
    },
    ({ projectId, kind, limit, cursor }) => {
      try {
        const result = listScenarios(database, projectId, principalId, {
          ...(kind === undefined ? {} : { kind }),
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
    "scenario_criterion_search",
    {
      title: "Buscar cenários por critério",
      description: "Retorna revisões publicadas que cobrem o critério e o resultado mais recente por build.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        criterionRef: z.string().trim().min(1).max(120),
      }),
      outputSchema: z.object({ matches: z.array(scenarioCoverageMatchSchema) }),
    },
    ({ projectId, criterionRef }) => {
      try {
        const result = { matches: searchScenariosByCriterion(database, projectId, principalId, criterionRef) };
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "test_run_record",
    {
      title: "Registrar resultado de teste",
      description: "Registra resultado imutável por revisão publicada e build.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        scenarioIdOrKey: z.string().trim().min(1).max(80),
        revisionNumber: z.number().int().positive(),
        buildId: z.string().trim().min(1).max(128),
        result: z.enum(testRunResults),
        notes: z.string().max(2_000).optional(),
        evidenceUri: z.string().trim().min(1).max(2_048).optional(),
        workItemIdOrKeys: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
      }),
      outputSchema: z.object({ run: testRunSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, scenarioIdOrKey, revisionNumber, buildId, result, notes, evidenceUri, workItemIdOrKeys }) => {
      try {
        const receipt = recordTestRun(database, {
          projectId,
          principalId,
          requestId,
          scenarioIdOrKey,
          revisionNumber,
          buildId,
          result,
          ...(notes === undefined ? {} : { notes }),
          ...(evidenceUri === undefined ? {} : { evidenceUri }),
          ...(workItemIdOrKeys === undefined ? {} : { workItemIdOrKeys }),
        });
        const payload = { run: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(payload);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

}
