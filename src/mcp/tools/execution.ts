import { z } from "zod";
import { startDevelopmentSession, transitionDevelopmentSession } from "../../application/development-lifecycle.js";
import { startTaskDevelopment } from "../../application/task-development-start.js";
import { getTaskWorkflow } from "../../application/task-workflow-queries.js";
import { proposeTaskWorkflow, publishTaskWorkflow, transitionTaskWorkflowStep } from "../../application/task-workflow-commands.js";
import { taskWorkflowStepStatuses } from "../../domain/task-workflow.js";
import { getTaskStartReadiness } from "../../application/work-item-workflow.js";
import { evidenceKinds } from "../../domain/workflow.js";
import { acceptTask } from "../../application/task-accept.js";
import { applyItemTemplate, listItemTemplates, setItemTemplate } from "../../application/item-templates.js";
import { readProjectGuidance, setProjectGuidance } from "../../application/project-guidance.js";
import { readGatePolicy, setGatePolicy } from "../../application/gate-policy.js";
import { listReviews, recordReview } from "../../application/task-reviews.js";
import { listDeliveryReports, setTaskPathScope, submitDeliveryReport } from "../../application/task-delivery-reports.js";
import { answerQuestion, listQuestions, openQuestion } from "../../application/work-item-questions.js";
import { reviewWorkItemReadiness } from "../../application/readiness-review.js";
import { acquireFileClaims, listFileClaims, releaseFileClaims, renewFileClaims } from "../../application/file-claims.js";
import { workItemTransitionSchema, developmentSessionSchema, taskWorkflowRevisionSchema, taskWorkflowViewSchema } from "../schemas.js";
import { toToolError, toolResult } from "../tool-support.js";
import type { McpToolContext } from "../tool-context.js";

export function registerExecutionTools(context: McpToolContext): void {
  const { server, database, principalId } = context;
  server.registerTool(
    "task_workflow_get",
    {
      title: "Consultar workflow ponderado da tarefa",
      description: "Retorna o plano publicado, Draft atual, estados auditados das etapas e percentual calculado apenas pelas etapas concluídas.",
      inputSchema: z.object({
        projectId: z.string().uuid(), taskIdOrKey: z.string().trim().min(1).max(120),
        revisionNumber: z.number().int().positive().optional(),
      }),
      outputSchema: taskWorkflowViewSchema,
    },
    ({ projectId, taskIdOrKey, revisionNumber }) => {
      try {
        const view = getTaskWorkflow(database, { projectId, principalId, taskIdOrKey, ...(revisionNumber === undefined ? {} : { revisionNumber }) });
        return toolResult(view);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "task_workflow_propose",
    {
      title: "Propor workflow técnico ponderado",
      description: "Cria revisão Draft imutável com 1-50 etapas cuja soma de esforço é exatamente 100.00%; novo Draft substitui o Draft anterior sem apagar histórico.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128), taskIdOrKey: z.string().trim().min(1).max(120),
        expectedTaskVersion: z.number().int().positive(), expectedWorkflowVersion: z.number().int().nonnegative(),
        steps: z.array(z.object({ id: z.string().uuid().optional(), title: z.string().trim().min(1).max(160),
          description: z.string().trim().min(1).max(4_000), effortPercent: z.number().positive().max(100) })).min(1).max(50),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ workflow: taskWorkflowRevisionSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, taskIdOrKey, expectedTaskVersion, expectedWorkflowVersion, steps, reason }) => {
      try {
        const receipt = proposeTaskWorkflow(database, {
          projectId, principalId, requestId, taskIdOrKey, expectedTaskVersion, expectedWorkflowVersion,
          steps: steps.map((step) => ({ title: step.title, description: step.description, effortPercent: step.effortPercent,
            ...(step.id === undefined ? {} : { id: step.id }) })), reason,
        });
        const result = { workflow: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "task_workflow_publish",
    {
      title: "Publicar workflow da tarefa",
      description: "Publica uma revisão Draft por Tech Lead humano sem sessões abertas; preserva etapa não alterada e volta etapas com definição alterada para Pendente.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128), taskIdOrKey: z.string().trim().min(1).max(120),
        revisionNumber: z.number().int().positive(), expectedTaskVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({
        workflow: taskWorkflowRevisionSchema,
        migration: z.object({ preservedStepIds: z.array(z.string().uuid()), resetStepIds: z.array(z.string().uuid()), previousProgressPercent: z.number().min(0).max(100).nullable() }),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, taskIdOrKey, revisionNumber, expectedTaskVersion, reason }) => {
      try {
        const receipt = publishTaskWorkflow(database, { projectId, principalId, requestId, taskIdOrKey, revisionNumber, expectedTaskVersion, reason });
        const result = { ...receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "task_workflow_step_transition",
    {
      title: "Atualizar etapa do workflow",
      description: "Atualiza status da etapa na revisão publicada; apenas etapa Done compõe o percentual e o Developer precisa de sessão ativa pinned à revisão.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128), taskIdOrKey: z.string().trim().min(1).max(120),
        revisionNumber: z.number().int().positive(), stepId: z.string().uuid(), expectedTaskVersion: z.number().int().positive(),
        targetStatus: z.enum(taskWorkflowStepStatuses), reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({
        transition: z.object({ projectId: z.string().uuid(), taskId: z.string().uuid(), taskKey: z.string(), taskVersion: z.number().int().positive(),
          revisionNumber: z.number().int().positive(), stepId: z.string().uuid(), fromStatus: z.enum(taskWorkflowStepStatuses),
          toStatus: z.enum(taskWorkflowStepStatuses), changedAt: z.string().datetime(), progressPercent: z.number().min(0).max(100) }),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, taskIdOrKey, revisionNumber, stepId, expectedTaskVersion, targetStatus, reason }) => {
      try {
        const receipt = transitionTaskWorkflowStep(database, {
          projectId, principalId, requestId, taskIdOrKey, revisionNumber, stepId, expectedTaskVersion, targetStatus, reason,
        });
        const result = { transition: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "development_session_start",
    {
      title: "Iniciar sessão de desenvolvimento",
      description: "Inicia uma sessão rastreável para a tarefa atribuída ao principal autenticado e fixa as revisões técnicas e cenários ligados à tarefa.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(120), expectedVersion: z.number().int().positive(),
        sessionReference: z.string().trim().min(1).max(160).optional(),
      }),
      outputSchema: z.object({ session: developmentSessionSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, itemIdOrKey, expectedVersion, sessionReference }) => {
      try {
        const receipt = startDevelopmentSession(database, {
          projectId, principalId, requestId, itemIdOrKey, expectedVersion,
          ...(sessionReference === undefined ? {} : { sessionReference }),
        });
        const result = { session: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "task_start_check",
    {
      title: "Verificar se a tarefa pode iniciar",
      description: "Diagnostica estado, atribuição, papel Developer, PBI pai e baseline, dependências e sessão aberta antes de iniciar uma tarefa.",
      inputSchema: z.object({ projectId: z.string().uuid(), taskIdOrKey: z.string().trim().min(1).max(120) }),
      outputSchema: z.object({
        itemId: z.string().uuid(), itemKey: z.string(), title: z.string(), state: z.string(), version: z.number().int().positive(),
        assigneeId: z.string().uuid().nullable(),
        parent: z.object({ id: z.string().uuid(), key: z.string(), state: z.string(), baselineId: z.string().uuid().nullable() }).nullable(),
        dependencies: z.array(z.object({ id: z.string().uuid(), key: z.string(), title: z.string(), state: z.string(), complete: z.boolean() })),
        openSession: z.object({ id: z.string().uuid(), status: z.enum(["active", "paused"]), developerPrincipalId: z.string().uuid() }).nullable(),
        blockers: z.array(z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() })),
        warnings: z.array(z.object({ code: z.string(), message: z.string(), keys: z.array(z.string()) })),
        canStart: z.boolean(),
      }),
    },
    ({ projectId, taskIdOrKey }) => {
      try {
        const report = getTaskStartReadiness(database, { projectId, principalId, itemIdOrKey: taskIdOrKey });
        return toolResult(report);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "task_start",
    {
      title: "Iniciar tarefa atomicamente",
      description: "Valida todos os gates e, se a tarefa estiver Ready, transiciona para in_progress e abre a sessão numa única transação; uma falha reverte ambas as operações.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(100),
        taskIdOrKey: z.string().trim().min(1).max(120),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1_000),
        sessionReference: z.string().trim().min(1).max(160).optional(),
      }),
      outputSchema: z.object({ task: z.object({ id: z.string().uuid(), key: z.string(), state: z.literal("in_progress"), version: z.number().int().positive() }),
        transition: workItemTransitionSchema.nullable(), session: developmentSessionSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, taskIdOrKey, expectedVersion, reason, sessionReference }) => {
      try {
        const receipt = startTaskDevelopment(database, {
          projectId, principalId, requestId, itemIdOrKey: taskIdOrKey, expectedVersion, reason,
          ...(sessionReference === undefined ? {} : { sessionReference }),
        });
        const { operationAuditEventIds, ...started } = receipt.value;
        const result = { ...started, auditEventIds: [...operationAuditEventIds, ...receipt.auditEventIds] };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "task_accept",
    {
      title: "Aceitar tarefa em uma chamada",
      description: "Fecha uma tarefa Draft/Ready pelos mesmos gates (atribuir, estimar, Ready, task_start, evidência, sessão, in_review, in_validation, done) numa única transação idempotente e devolve só o resumo. Falha em qualquer gate reverte tudo; repetir com o mesmo requestId reexecuta sem duplicar.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(90),
        taskIdOrKey: z.string().trim().min(1).max(120),
        expectedVersion: z.number().int().positive().optional(),
        reason: z.string().trim().min(1).max(500),
        estimateHours: z.number().int().min(1).max(10_000).optional(),
        evidence: z.object({
          kind: z.enum(evidenceKinds), uri: z.string().trim().min(1).max(2_048),
          description: z.string().trim().min(1).max(2_000), buildId: z.string().trim().min(1).max(128).optional(),
        }),
      }),
      outputSchema: z.object({
        key: z.string(), state: z.literal("done"), version: z.number().int().positive(), steps: z.array(z.string()),
        evidenceId: z.string().uuid().nullable(), sessionId: z.string().uuid().nullable(), alreadyDone: z.boolean(),
        auditEventCount: z.number().int().nonnegative(),
      }),
    },
    ({ projectId, requestId, taskIdOrKey, expectedVersion, reason, estimateHours, evidence }) => {
      try {
        const receipt = acceptTask(database, {
          projectId, principalId, requestId, itemIdOrKey: taskIdOrKey, reason,
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
          ...(estimateHours === undefined ? {} : { estimateHours }),
          evidence: { kind: evidence.kind, uri: evidence.uri, description: evidence.description, ...(evidence.buildId === undefined ? {} : { buildId: evidence.buildId }) },
        });
        return toolResult(receipt.value);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "development_session_transition",
    {
      title: "Atualizar sessão de desenvolvimento",
      description: "Pausa, retoma, conclui ou cancela a sessão do próprio desenvolvedor com duração ativa acumulada e histórico imutável.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128), sessionId: z.string().uuid(),
        action: z.enum(["pause", "resume", "complete", "cancel"]), expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(500),
      }),
      outputSchema: z.object({ session: developmentSessionSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, sessionId, action, expectedVersion, reason }) => {
      try {
        const receipt = transitionDevelopmentSession(database, { projectId, principalId, requestId, sessionId, action, expectedVersion, reason });
        const result = { session: receipt.value, auditEventIds: receipt.auditEventIds };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  const fileClaimSchema = z.object({
    claimId: z.string().uuid(), path: z.string(), kind: z.enum(["file", "directory"]), principalId: z.string().uuid(),
    principalName: z.string(), itemKey: z.string().nullable(), branch: z.string().nullable(), worktree: z.string().nullable(),
    createdAt: z.string(), lastHeartbeatAt: z.string(), leaseExpiresAt: z.string(), status: z.enum(["active", "expired", "released"]),
    version: z.number().int().positive(),
  });
  const fileClaimsOutput = z.object({ claims: z.array(fileClaimSchema), auditEventIds: z.array(z.string().uuid()) });
  const claimResult = (receipt: { value: { claims: unknown[] }; auditEventIds: readonly string[] }) => {
    const result = { claims: receipt.value.claims, auditEventIds: receipt.auditEventIds };
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  };

  server.registerTool(
    "file_claim_acquire",
    {
      title: "Reservar caminhos do repositório",
      description: "Reserva arquivos ou diretórios (caminhos relativos ao repositório) por lease. Sobreposição com reserva ativa de outra pessoa falha com CLAIM_CONFLICT e lista os donos; é coordenação, não enforcement do Git: confira branch/worktree/diff antes de editar.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128),
        paths: z.array(z.object({ path: z.string().trim().min(1).max(500), kind: z.enum(["file", "directory"]) })).min(1).max(50),
        itemIdOrKey: z.string().trim().min(1).max(120).optional(), branch: z.string().trim().min(1).max(200).optional(),
        worktree: z.string().trim().min(1).max(500).optional(), leaseSeconds: z.number().int().min(60).max(14_400).optional(),
      }),
      outputSchema: fileClaimsOutput,
    },
    ({ projectId, requestId, paths, itemIdOrKey, branch, worktree, leaseSeconds }) => {
      try {
        return claimResult(acquireFileClaims(database, {
          projectId, principalId, requestId, paths,
          ...(itemIdOrKey === undefined ? {} : { itemIdOrKey }), ...(branch === undefined ? {} : { branch }),
          ...(worktree === undefined ? {} : { worktree }), ...(leaseSeconds === undefined ? {} : { leaseSeconds }),
        }));
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "file_claim_renew",
    {
      title: "Renovar reservas",
      description: "Renova o lease (heartbeat) das reservas do próprio chamador; falha se outra pessoa assumiu caminho sobreposto depois da expiração.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128),
        claimIds: z.array(z.string().uuid()).min(1).max(50), leaseSeconds: z.number().int().min(60).max(14_400).optional(),
      }),
      outputSchema: fileClaimsOutput,
    },
    ({ projectId, requestId, claimIds, leaseSeconds }) => {
      try {
        return claimResult(renewFileClaims(database, { projectId, principalId, requestId, claimIds, ...(leaseSeconds === undefined ? {} : { leaseSeconds }) }));
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "file_claim_release",
    {
      title: "Liberar reservas",
      description: "Libera reservas (idempotente). O dono libera as suas; Tech Lead/Admin arbitra a liberação de reserva alheia com motivo de pelo menos 10 caracteres.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128),
        claimIds: z.array(z.string().uuid()).min(1).max(50), reason: z.string().trim().min(1).max(500).optional(),
      }),
      outputSchema: fileClaimsOutput,
    },
    ({ projectId, requestId, claimIds, reason }) => {
      try {
        return claimResult(releaseFileClaims(database, { projectId, principalId, requestId, claimIds, ...(reason === undefined ? {} : { reason }) }));
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "file_claim_list",
    {
      title: "Consultar reservas",
      description: "Lista reservas ativas do projeto (ou também expiradas/liberadas com includeInactive), filtrando por prefixo de caminho ou só as minhas.",
      inputSchema: z.object({
        projectId: z.string().uuid(), pathPrefix: z.string().trim().min(1).max(500).optional(),
        mine: z.boolean().optional(), includeInactive: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional(),
      }),
      outputSchema: z.object({ claims: z.array(fileClaimSchema) }),
    },
    ({ projectId, pathPrefix, mine, includeInactive, limit }) => {
      try {
        const result = listFileClaims(database, {
          projectId, principalId, ...(pathPrefix === undefined ? {} : { pathPrefix }), ...(mine === undefined ? {} : { mine }),
          ...(includeInactive === undefined ? {} : { includeInactive }), ...(limit === undefined ? {} : { limit }),
        });
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  const questionSchema = z.object({
    id: z.string().uuid(), key: z.string(), itemKey: z.string(), text: z.string(), blocking: z.boolean(),
    status: z.enum(["open", "answered"]), answer: z.string().nullable(), askedByPrincipalId: z.string().uuid(), askedAt: z.string(),
    answeredByPrincipalId: z.string().uuid().nullable(), answeredAt: z.string().nullable(), version: z.number().int().positive(),
  });
  const questionOutput = z.object({ question: questionSchema, auditEventCount: z.number().int().nonnegative() });
  const questionResult = (receipt: { value: { question: unknown }; auditEventIds: readonly string[] }) => {
    const result = { question: receipt.value.question, auditEventCount: receipt.auditEventIds.length };
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  };

  const deliveryEntrySchema = z.object({
    criterionKey: z.string().trim().min(1).max(40), scope: z.enum(["pbi", "task", "dod"]),
    status: z.enum(["met", "partial", "not_met", "not_applicable"]),
    evidence: z.string().trim().min(1).max(2_000).optional(), assumptions: z.string().trim().min(1).max(2_000).optional(),
    deviations: z.string().trim().min(1).max(2_000).optional(),
  });
  const deliveryReportSchema = z.object({
    id: z.string().uuid(), itemKey: z.string(), reportNumber: z.number().int().positive(), entries: z.array(deliveryEntrySchema),
    changeSet: z.object({ branch: z.string().optional(), commits: z.array(z.string()), paths: z.array(z.string()) }).nullable(),
    outOfScopePaths: z.array(z.string()),
    summary: z.string().nullable(), submittedByPrincipalId: z.string().uuid(), submittedAt: z.string(),
  });

  server.registerTool(
    "task_delivery_report_submit",
    {
      title: "Enviar relatório de entrega",
      description: "Declara, por critério do PBI e por item do checklist da tarefa, status (met, partial, not_met, not_applicable), evidência, suposições e desvios. Imutável e numerado; reenviar cria o próximo número. Com not_met, in_progress → in_review é bloqueado.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128), taskIdOrKey: z.string().trim().min(1).max(120),
        entries: z.array(deliveryEntrySchema).min(1).max(100), summary: z.string().trim().min(1).max(2_000).optional(),
        changeSet: z.object({
          branch: z.string().trim().min(1).max(200).optional(),
          commits: z.array(z.string().trim().min(7).max(64)).max(200),
          paths: z.array(z.string().trim().min(1).max(500)).max(500),
        }).optional(),
      }),
      outputSchema: z.object({ report: deliveryReportSchema, auditEventCount: z.number().int().nonnegative() }),
    },
    ({ projectId, requestId, taskIdOrKey, entries, summary, changeSet }) => {
      try {
        const receipt = submitDeliveryReport(database, {
          projectId, principalId, requestId, itemIdOrKey: taskIdOrKey,
          entries: entries.map((entry) => ({
            criterionKey: entry.criterionKey, scope: entry.scope, status: entry.status,
            ...(entry.evidence === undefined ? {} : { evidence: entry.evidence }),
            ...(entry.assumptions === undefined ? {} : { assumptions: entry.assumptions }),
            ...(entry.deviations === undefined ? {} : { deviations: entry.deviations }),
          })),
          ...(summary === undefined ? {} : { summary }),
          ...(changeSet === undefined ? {} : { changeSet: { ...(changeSet.branch === undefined ? {} : { branch: changeSet.branch }), commits: changeSet.commits, paths: changeSet.paths } }),
        });
        const result = { report: receipt.value.report, auditEventCount: receipt.auditEventIds.length };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  const reviewSchema = z.object({
    id: z.string().uuid(), itemKey: z.string(), reportNumber: z.number().int().positive().nullable(), decision: z.enum(["approved", "changes_requested"]),
    advisory: z.boolean(), findings: z.array(z.object({ criterionKey: z.string().optional(), message: z.string() })),
    summary: z.string().nullable(), reviewerPrincipalId: z.string().uuid(), reviewedAt: z.string(),
  });

  server.registerTool(
    "review_record",
    {
      title: "Registrar revisão independente",
      description: "Registra a decisão (approved, changes_requested) e achados ligados a critérios sobre uma tarefa em in_review. O revisor não pode ter sessão de desenvolvimento nela; revisão por principal não humano é consultiva. Imutável; a última vale.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128), taskIdOrKey: z.string().trim().min(1).max(120),
        decision: z.enum(["approved", "changes_requested"]),
        findings: z.array(z.object({ criterionKey: z.string().trim().min(1).max(40).optional(), message: z.string().trim().min(1).max(1_000) })).max(50).optional(),
        summary: z.string().trim().min(1).max(2_000).optional(),
      }),
      outputSchema: z.object({ review: reviewSchema, auditEventCount: z.number().int().nonnegative() }),
    },
    ({ projectId, requestId, taskIdOrKey, decision, findings, summary }) => {
      try {
        const receipt = recordReview(database, {
          projectId, principalId, requestId, itemIdOrKey: taskIdOrKey, decision,
          ...(findings === undefined ? {} : { findings: findings.map((finding) => ({ ...(finding.criterionKey === undefined ? {} : { criterionKey: finding.criterionKey }), message: finding.message })) }),
          ...(summary === undefined ? {} : { summary }),
        });
        const result = { review: receipt.value.review, auditEventCount: receipt.auditEventIds.length };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "review_list",
    {
      title: "Listar revisões da tarefa",
      description: "Lista as revisões independentes da tarefa, da mais recente à mais antiga, com decisão, achados e se foram consultivas.",
      inputSchema: z.object({ projectId: z.string().uuid(), taskIdOrKey: z.string().trim().min(1).max(120) }),
      outputSchema: z.object({ reviews: z.array(reviewSchema) }),
    },
    ({ projectId, taskIdOrKey }) => {
      try {
        const result = listReviews(database, { projectId, principalId, itemIdOrKey: taskIdOrKey });
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  const gatePolicySchema = z.object({
    level: z.enum(["lite", "standard", "strict"]), revisionNumber: z.number().int().positive().nullable(), reason: z.string().nullable(),
    setByPrincipalId: z.string().uuid().nullable(), setAt: z.string().nullable(),
  });

  const guidanceSchema = z.object({
    revisionNumber: z.number().int().positive().nullable(),
    content: z.object({ conventions: z.array(z.object({ title: z.string(), text: z.string() })), verificationCommands: z.array(z.string()) }),
    reason: z.string().nullable(), setByPrincipalId: z.string().uuid().nullable(), setAt: z.string().nullable(),
  });

  const templateSchema = z.object({
    key: z.string(), revisionNumber: z.number().int().positive(), name: z.string(), checklist: z.array(z.string()),
    steps: z.array(z.object({ title: z.string(), description: z.string(), effortPercent: z.number() })),
    reason: z.string(), createdByPrincipalId: z.string().uuid(), createdAt: z.string(),
  });

  server.registerTool(
    "template_set",
    {
      title: "Definir modelo de trabalho",
      description: "PO ou Tech Lead humano grava nova revisão imutável de um modelo (chave como endpoint, migracao, correcao) com checklist de saída e etapas ponderadas que somam 100%; expectedRevision 0 cria o modelo.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128), key: z.string().trim().min(2).max(60),
        name: z.string().trim().min(1).max(160), checklist: z.array(z.string().trim().min(1).max(2_000)).max(30),
        steps: z.array(z.object({ title: z.string().trim().min(1).max(160), description: z.string().trim().min(1).max(4_000), effortPercent: z.number().gt(0).max(100) })).max(50),
        expectedRevision: z.number().int().min(0), reason: z.string().trim().min(10).max(1_000),
      }),
      outputSchema: z.object({ template: templateSchema, auditEventCount: z.number().int().nonnegative() }),
    },
    ({ projectId, requestId, key, name, checklist, steps, expectedRevision, reason }) => {
      try {
        const receipt = setItemTemplate(database, { projectId, principalId, requestId, key, name, checklist, steps, expectedRevision, reason });
        const result = { template: receipt.value.template, auditEventCount: receipt.auditEventIds.length };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "template_list",
    {
      title: "Listar modelos de trabalho",
      description: "Lista a revisão mais recente de cada modelo do projeto, ou o histórico de um modelo quando key é informada.",
      inputSchema: z.object({ projectId: z.string().uuid(), key: z.string().trim().min(2).max(60).optional() }),
      outputSchema: z.object({ templates: z.array(templateSchema) }),
    },
    ({ projectId, key }) => {
      try {
        const result = listItemTemplates(database, { projectId, principalId, ...(key === undefined ? {} : { key }) });
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "template_apply",
    {
      title: "Aplicar modelo a uma tarefa",
      description: "Opcional e auditado: cria Draft de revisão com o checklist do modelo e Draft de workflow ponderado na tarefa; a publicação continua com o papel humano de sempre.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(100), taskIdOrKey: z.string().trim().min(1).max(120), templateKey: z.string().trim().min(2).max(60),
      }),
      outputSchema: z.object({
        taskKey: z.string(), templateKey: z.string(), templateRevision: z.number().int().positive(),
        checklistDraftRevision: z.number().int().positive().nullable(), workflowDraftRevision: z.number().int().positive().nullable(),
        auditEventCount: z.number().int().nonnegative(),
      }),
    },
    ({ projectId, requestId, taskIdOrKey, templateKey }) => {
      try {
        const receipt = applyItemTemplate(database, { projectId, principalId, requestId, taskIdOrKey, templateKey });
        const result = { ...receipt.value, auditEventCount: receipt.auditEventIds.length };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "project_guidance_get",
    {
      title: "Consultar orientações do projeto",
      description: "Devolve a revisão vigente das orientações do projeto (convenções do repositório e comandos de verificação) com autoria e motivo; vazio quando nunca configuradas.",
      inputSchema: z.object({ projectId: z.string().uuid() }),
      outputSchema: guidanceSchema,
    },
    ({ projectId }) => {
      try {
        const result = readProjectGuidance(database, projectId, principalId);
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "project_guidance_set",
    {
      title: "Definir orientações do projeto",
      description: "PO ou Tech Lead humano grava nova revisão imutável das orientações (até 30 convenções e 20 comandos de verificação) com motivo de 10+ caracteres; expectedRevision 0 cria a primeira. Entram na seção guidance do contexto da tarefa.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128), expectedRevision: z.number().int().min(0),
        conventions: z.array(z.object({ title: z.string().trim().min(1).max(120), text: z.string().trim().min(1).max(1_000) })).max(30),
        verificationCommands: z.array(z.string().trim().min(1).max(300)).max(20),
        reason: z.string().trim().min(10).max(1_000),
      }),
      outputSchema: z.object({ guidance: guidanceSchema, auditEventCount: z.number().int().nonnegative() }),
    },
    ({ projectId, requestId, expectedRevision, conventions, verificationCommands, reason }) => {
      try {
        const receipt = setProjectGuidance(database, { projectId, principalId, requestId, expectedRevision, content: { conventions, verificationCommands }, reason });
        const result = { guidance: receipt.value, auditEventCount: receipt.auditEventIds.length };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "gate_policy_get",
    {
      title: "Consultar política de gates",
      description: "Devolve o nível vigente (lite, standard ou strict; standard quando nunca configurado) e o histórico de revisões da política do projeto.",
      inputSchema: z.object({ projectId: z.string().uuid() }),
      outputSchema: z.object({ policy: gatePolicySchema, history: z.array(gatePolicySchema) }),
    },
    ({ projectId }) => {
      try {
        const result = readGatePolicy(database, projectId, principalId);
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "gate_policy_set",
    {
      title: "Definir política de gates",
      description: "PO ou Tech Lead humano grava nova revisão da política (lite, standard, strict) com motivo de 10+ caracteres; expectedRevision 0 cria a primeira. lite dispensa cenário publicado no Ready; strict exige relatório de entrega e revisão independente humana.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128), level: z.enum(["lite", "standard", "strict"]),
        reason: z.string().trim().min(10).max(1_000), expectedRevision: z.number().int().min(0),
      }),
      outputSchema: z.object({ policy: gatePolicySchema, auditEventCount: z.number().int().nonnegative() }),
    },
    ({ projectId, requestId, level, reason, expectedRevision }) => {
      try {
        const receipt = setGatePolicy(database, { projectId, principalId, requestId, level, reason, expectedRevision });
        const result = { policy: receipt.value, auditEventCount: receipt.auditEventIds.length };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "task_scope_set",
    {
      title: "Declarar escopo de caminhos da tarefa",
      description: "Declara (substitui) os caminhos do repositório que a tarefa deve tocar. Alteração fora do escopo vira achado na revisão e em task_delivery_report_get, nunca bloqueio automático.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128), taskIdOrKey: z.string().trim().min(1).max(120),
        paths: z.array(z.string().trim().min(1).max(500)).max(200),
      }),
      outputSchema: z.object({ itemKey: z.string(), paths: z.array(z.string()), version: z.number().int().positive(), auditEventCount: z.number().int().nonnegative() }),
    },
    ({ projectId, requestId, taskIdOrKey, paths }) => {
      try {
        const receipt = setTaskPathScope(database, { projectId, principalId, requestId, itemIdOrKey: taskIdOrKey, paths });
        const result = { ...receipt.value, auditEventCount: receipt.auditEventIds.length };
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "task_delivery_report_get",
    {
      title: "Consultar relatório de entrega",
      description: "Devolve o esperado (critérios do PBI e checklist da tarefa) e os relatórios de entrega enviados, do mais recente ao mais antigo, para comparar esperado × entregue.",
      inputSchema: z.object({ projectId: z.string().uuid(), taskIdOrKey: z.string().trim().min(1).max(120), latestOnly: z.boolean().optional() }),
      outputSchema: z.object({
        expected: z.array(z.object({ key: z.string(), scope: z.enum(["pbi", "task", "dod"]), required: z.boolean() })),
        reports: z.array(deliveryReportSchema),
        pathScope: z.array(z.string()).nullable(),
      }),
    },
    ({ projectId, taskIdOrKey, latestOnly }) => {
      try {
        const result = listDeliveryReports(database, { projectId, principalId, itemIdOrKey: taskIdOrKey, ...(latestOnly === undefined ? {} : { latestOnly }) });
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "question_open",
    {
      title: "Abrir pergunta",
      description: "Registra uma pergunta em aberto num item; se bloqueante, impede o Ready até ser respondida e aparece como aviso no contexto da tarefa.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128), itemIdOrKey: z.string().trim().min(1).max(120),
        text: z.string().trim().min(1).max(2_000), blocking: z.boolean().optional(),
      }),
      outputSchema: questionOutput,
    },
    ({ projectId, requestId, itemIdOrKey, text, blocking }) => {
      try {
        return questionResult(openQuestion(database, { projectId, principalId, requestId, itemIdOrKey, text, ...(blocking === undefined ? {} : { blocking }) }));
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "question_answer",
    {
      title: "Responder pergunta",
      description: "Responde uma pergunta aberta (UUID ou chave Q-N); PO, Tech Lead ou Stakeholder. Libera o gate de Ready quando era a última bloqueante.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128), questionIdOrKey: z.string().trim().min(1).max(60),
        answer: z.string().trim().min(1).max(4_000), expectedVersion: z.number().int().positive().optional(),
      }),
      outputSchema: questionOutput,
    },
    ({ projectId, requestId, questionIdOrKey, answer, expectedVersion }) => {
      try {
        return questionResult(answerQuestion(database, { projectId, principalId, requestId, questionIdOrKey, answer, ...(expectedVersion === undefined ? {} : { expectedVersion }) }));
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "question_list",
    {
      title: "Listar perguntas",
      description: "Lista perguntas do projeto, filtrando por item e por status (open/answered).",
      inputSchema: z.object({
        projectId: z.string().uuid(), itemIdOrKey: z.string().trim().min(1).max(120).optional(),
        status: z.enum(["open", "answered"]).optional(), limit: z.number().int().min(1).max(200).optional(),
      }),
      outputSchema: z.object({ questions: z.array(questionSchema) }),
    },
    ({ projectId, itemIdOrKey, status, limit }) => {
      try {
        const result = listQuestions(database, {
          projectId, principalId, ...(itemIdOrKey === undefined ? {} : { itemIdOrKey }),
          ...(status === undefined ? {} : { status }), ...(limit === undefined ? {} : { limit }),
        });
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "work_item_readiness_review",
    {
      title: "Revisar prontidão do item",
      description: "Revisão determinística (sem modelo): critério sem resultado observável, termo vago, termo fora do glossário, critério obrigatório sem cenário, tarefa sem checklist e perguntas bloqueantes abertas.",
      inputSchema: z.object({ projectId: z.string().uuid(), itemIdOrKey: z.string().trim().min(1).max(120) }),
      outputSchema: z.object({
        itemKey: z.string(), type: z.string(),
        findings: z.array(z.object({
          code: z.enum(["no_observable_outcome", "vague_term", "term_not_in_glossary", "criterion_without_scenario", "task_without_checklist", "blocking_question_open", "out_of_scope_change"]),
          severity: z.enum(["blocking", "warning"]), criterionKey: z.string().optional(), message: z.string(),
        })),
        counts: z.object({ blocking: z.number().int().nonnegative(), warning: z.number().int().nonnegative() }),
      }),
    },
    ({ projectId, itemIdOrKey }) => {
      try {
        const result = reviewWorkItemReadiness(database, { projectId, principalId, itemIdOrKey });
        return toolResult(result);
      } catch (error) { return toToolError(error); }
    },
  );

}
