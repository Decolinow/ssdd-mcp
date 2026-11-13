/**
 * Classificação explícita de cada tool MCP para as anotações do protocolo
 * (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
 *
 * As anotações são dicas para o cliente decidir auto-aprovação e confirmação.
 * Elas não substituem RBAC, aprovações delegadas nem gates de domínio.
 * Uma tool registrada sem classificação aqui falha no teste de contrato.
 */
export interface McpToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/** Leituras puras: não gravam estado de domínio nem cache. */
const readOnlyTools = [
  "project_list", "project_get", "roadmap_id_resolve", "roadmap_id_list",
  "work_item_get", "work_item_list", "work_item_revision_list", "work_item_gate_check",
  "work_item_quality_get", "comment_list", "evidence_list",
  "task_context_get", "task_execution_queue_get", "task_start_check", "task_workflow_get",
  "project_feature_roadmap_get", "baseline_get", "impact_list",
  "spec_get", "spec_list", "adr_search", "scenario_get", "scenario_list", "scenario_criterion_search",
  "test_run_list", "trace_query", "github_reference_list",
  "team_list", "team_capacity_get", "definition_of_done_get",
  "sprint_get", "sprint_list", "sprint_retrospective_get",
  "milestone_get", "milestone_list", "milestone_forecast_history", "milestone_forecast_recalculate",
  "development_session_list", "development_session_stale_list", "file_claim_list", "question_list", "work_item_readiness_review", "task_delivery_report_get", "developer_execution_metrics_get", "flow_metrics_get", "deployment_event_list", "audit_event_list",
  "user_list",
] as const;

/**
 * Consultas que podem gravar cache ou snapshot derivado (aditivo e idempotente).
 * `metrics_get` pode registrar snapshot imutável de previsão; as tools semânticas
 * mantêm o índice vetorial derivado.
 */
const derivedWriteTools = ["metrics_get", "work_item_semantic_index", "work_item_semantic_search"] as const;

/** Prévias de importação: leem sistema externo e não gravam no SSDD. */
const externalReadTools = ["github_issue_import_preview", "azure_work_item_import_preview"] as const;

/** Aplicação de importação: relê o sistema externo e grava itens Draft aditivos no SSDD. */
const externalImportApplyTools = ["github_issue_import_apply", "azure_work_item_import_apply"] as const;

/** Mutações que encerram, retiram, revogam ou substituem estado vigente. */
const destructiveTools = [
  "trace_link_remove", "approval_revoke", "user_auth_key_revoke", "user_auth_key_rotate",
  "spec_revision_withdraw", "file_claim_release", "sprint_cancel", "sprint_close", "work_item_transition",
] as const;

/** Mutações aditivas de domínio (histórico append-only ou nova revisão). */
const additiveMutationTools = [
  "approval_issue", "user_create", "roadmap_id_bind",
  "baseline_fix", "baseline_revalidate",
  "work_item_create", "work_item_revision_propose", "work_item_revision_publish",
  "work_item_assign", "work_item_rank", "work_item_estimate", "work_item_estimate_confirm",
  "comment_add", "evidence_add",
  "spec_create", "adr_create", "spec_revision_propose", "spec_revision_publish", "adr_link_task",
  "scenario_create", "scenario_revision_propose", "scenario_revision_publish",
  "test_run_record", "test_run_certify",
  "task_workflow_propose", "task_workflow_publish", "task_workflow_step_transition",
  "task_start", "task_accept", "development_session_start", "development_session_transition", "development_session_recover",
  "file_claim_acquire", "file_claim_renew", "question_open", "question_answer", "task_delivery_report_submit",
  "deployment_event_record",
  "milestone_create", "milestone_scope_change",
  "team_create", "team_capacity_set", "definition_of_done_set",
  "sprint_draft", "sprint_scope_change", "sprint_start", "sprint_retrospective_set",
  "trace_link_add",
] as const;

function annotation(
  readOnlyHint: boolean,
  destructiveHint: boolean,
  openWorldHint = false,
): McpToolAnnotations {
  // Leituras e mutações com requestId repetem o resultado original, então todas são idempotentes.
  return { readOnlyHint, destructiveHint, idempotentHint: true, openWorldHint };
}

const catalog = new Map<string, McpToolAnnotations>();
for (const name of readOnlyTools) catalog.set(name, annotation(true, false));
for (const name of externalReadTools) catalog.set(name, annotation(true, false, true));
for (const name of derivedWriteTools) catalog.set(name, annotation(false, false));
for (const name of destructiveTools) catalog.set(name, annotation(false, true));
for (const name of externalImportApplyTools) catalog.set(name, annotation(false, false, true));
for (const name of additiveMutationTools) catalog.set(name, annotation(false, false));

export function mcpToolAnnotations(toolName: string): McpToolAnnotations | undefined {
  return catalog.get(toolName);
}

/** Acrescenta anotações à configuração da tool sem sobrescrever as já declaradas. */
export function withToolAnnotations(toolName: string, config: unknown): unknown {
  const annotations = catalog.get(toolName);
  if (annotations === undefined || typeof config !== "object" || config === null) return config;
  const existing = (config as { annotations?: object }).annotations;
  return { ...config, annotations: { ...annotations, ...existing } };
}

export function classifiedMcpToolNames(): readonly string[] {
  return [...catalog.keys()];
}
