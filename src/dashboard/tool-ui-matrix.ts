/**
 * Maps every MCP tool to the dashboard operation that covers it, or to an explicit future gap (SSDD-97 AC-4).
 * `docs/dashboard-parity-matrix.md` is generated from this table; `tests/dashboard/tool-ui-matrix.test.ts` fails when a
 * tool is missing, a mapped tool no longer exists or the document is stale (regenerate with UPDATE_UI_MATRIX=1).
 */
export type ToolUiCoverage = "ui" | "partial" | "gap";

export interface ToolUiEntry {
  readonly coverage: ToolUiCoverage;
  /** Dashboard surface (tab/dialog) and API route, or the reason the gap exists. */
  readonly note: string;
}

const ui = (note: string): ToolUiEntry => ({ coverage: "ui", note });
const partial = (note: string): ToolUiEntry => ({ coverage: "partial", note });
const gap = (note: string): ToolUiEntry => ({ coverage: "gap", note });
const spec = "aba Especificações";
const planning = "diálogo Planejamento (`POST …/planning/:operation`)";
const qa = "aba Qualidade";
const adminGap = "Operação administrativa de host: fica no CLI/MCP humano; sem rota no dashboard.";
const agentGap = "Fluxo de agente de desenvolvimento; o dashboard só exibe o resultado (detalhe da tarefa).";

export const toolUiMatrix: Readonly<Record<string, ToolUiEntry>> = {
  adr_link_task: ui(`${spec} → vincular ADR a tarefa; \`POST …/work-items/:key/adr-links\``),
  approval_issue: gap(adminGap),
  approval_revoke: gap(adminGap),
  audit_event_list: ui("aba Atividade; `GET …/audit` e timeline do item"),
  azure_work_item_import_apply: gap("Importação de provedor externo: fluxo de PO via MCP; sem UI planejada."),
  azure_work_item_import_preview: gap("Importação de provedor externo: fluxo de PO via MCP; sem UI planejada."),
  baseline_fix: gap("A baseline é fixada pela transição para Ready (aba Backlog → mover); não há ação isolada."),
  baseline_get: partial("Detalhe do PBI mostra a baseline fixada via `GET …/work-items/:key/quality`; sem consulta de baselines históricas."),
  baseline_revalidate: gap("Revalidação de baseline sem UI; lacuna do AC-1 do SSDD-97."),
  comment_add: ui(`diálogo Operações do item (\`POST …/backlog/:operation\`): comment_add`),
  comment_list: ui("detalhe do item; `GET …/work-items/:key/comments`"),
  definition_of_done_get: partial("Capacidade/DoD exibidas nos resumos de sprint; sem tela dedicada da DoD."),
  definition_of_done_set: ui(`${planning}: definition_of_done_set`),
  delivery_quality_metrics_get: gap("Métrica nova (SSDD-951) ainda sem aba."),
  deployment_event_list: ui("aba Métricas; `GET …/deployment-events`"),
  deployment_event_record: gap("Registro de deploy vem de pipeline/DevOps via MCP."),
  developer_execution_metrics_get: ui("aba Métricas; `GET …/developer-execution-metrics`"),
  development_session_list: ui("detalhe da tarefa e aba Métricas; `GET …/development-sessions`"),
  development_session_recover: gap(agentGap),
  development_session_stale_list: gap(agentGap),
  development_session_start: ui("Início seguro de tarefa; `POST …/work-items/:key/start`"),
  development_session_transition: gap(agentGap),
  evidence_add: gap("Evidências são anexadas por agente/QA; o dashboard apenas lista (detalhe da tarefa)."),
  evidence_list: ui("detalhe da tarefa, seção de evidências com paginação (`…/context`)"),
  file_claim_acquire: gap(agentGap),
  file_claim_list: gap(agentGap),
  file_claim_release: gap(agentGap),
  file_claim_renew: gap(agentGap),
  flow_metrics_get: partial("Métricas de fluxo aparecem na aba Métricas via `dashboard-metrics`; sem filtros próprios da tool."),
  gate_policy_get: gap("Política de gates sem UI."),
  gate_policy_set: gap("Política de gates sem UI."),
  github_issue_import_apply: gap("Importação de provedor externo: fluxo de PO via MCP; sem UI planejada."),
  github_issue_import_preview: gap("Importação de provedor externo: fluxo de PO via MCP; sem UI planejada."),
  github_reference_list: gap("Referências GitHub sem UI."),
  impact_list: gap("Impactos sem UI; lacuna do AC-1 do SSDD-97."),
  metrics_get: ui("aba Métricas; `GET …/dashboard-metrics`"),
  milestone_create: ui(`${planning}: milestone_create`),
  milestone_forecast_history: partial("Histórico de previsão exibido na aba Métricas (projeção de entrega)."),
  milestone_forecast_recalculate: gap("Recalculo de previsão só via MCP."),
  milestone_get: partial("Marco aparece como filtro/resumo em Métricas; sem detalhe dedicado."),
  milestone_list: partial("Marcos listados como filtro em Métricas; sem tela dedicada."),
  milestone_scope_change: ui(`${planning}: milestone_scope_change`),
  project_feature_roadmap_get: ui("aba Roadmap; `GET …/feature-roadmap`"),
  project_get: ui("cabeçalho do projeto; `GET …/projects/:id`"),
  project_guidance_get: gap("Orientações do projeto sem UI."),
  project_guidance_set: gap("Orientações do projeto sem UI."),
  project_list: ui("seletor de projeto; `GET /api/v1/projects`"),
  question_answer: gap("Perguntas abertas sem UI."),
  question_list: gap("Perguntas abertas sem UI."),
  question_open: gap("Perguntas abertas sem UI."),
  review_list: gap("Revisões de código sem UI."),
  review_record: gap("Revisões de código sem UI."),
  roadmap_id_bind: gap("Mapa de IDs de roadmap é ferramenta de manutenção via MCP/script."),
  roadmap_id_list: gap("Mapa de IDs de roadmap é ferramenta de manutenção via MCP/script."),
  roadmap_id_resolve: gap("Mapa de IDs de roadmap é ferramenta de manutenção via MCP/script."),
  scenario_create: ui(`${qa} → Novo cenário; \`POST …/scenarios\``),
  scenario_criterion_search: gap("Busca de critério para cobertura sem UI; o vínculo é digitado."),
  scenario_get: ui(`${qa}; \`GET …/scenarios/:key\``),
  scenario_list: ui(`${qa}; \`GET …/scenarios\``),
  scenario_revision_propose: ui(`${qa} → Propor revisão; \`POST …/scenarios/:key/revisions\``),
  scenario_revision_publish: ui(`${qa} → Publicar; \`POST …/scenarios/:key/revisions/:n/publish\``),
  spec_create: ui(`${spec} → Nova especificação; \`POST …/specifications\``),
  spec_get: ui(`${spec}; \`GET …/specifications/:key\``),
  spec_list: ui(`${spec}; \`GET …/specifications\``),
  spec_revision_propose: ui(`${spec} → Propor revisão; \`POST …/specifications/:key/revisions\``),
  spec_revision_publish: ui(`${spec} → Publicar; \`POST …/specifications/:key/revisions/:n/publish\``),
  spec_revision_withdraw: ui(`${spec} → Retirar rascunho; \`POST …/specifications/:key/revisions/:n/withdraw\``),
  sprint_cancel: ui(`${planning}: sprint_cancel`),
  sprint_close: ui(`${planning}: sprint_close`),
  sprint_draft: ui(`${planning}: sprint_draft`),
  sprint_get: ui("resumo da sprint; `GET …/sprints/:key`"),
  sprint_list: ui("resumo e seletor de sprint; `GET …/sprints`"),
  sprint_retrospective_get: ui("aba Retrospectiva; `GET …/sprints/:key/retrospective`"),
  sprint_retrospective_set: ui("aba Retrospectiva; `POST …/sprints/:key/retrospective`"),
  sprint_scope_change: ui(`${planning}: sprint_scope_change`),
  sprint_start: ui(`${planning}: sprint_start`),
  task_accept: gap("Composite de agente; o dashboard executa os passos separadamente (mover, iniciar)."),
  task_briefing_get: gap(agentGap),
  task_context_get: ui("detalhe da tarefa; `GET …/work-items/:key/context`"),
  task_delivery_report_get: gap(agentGap),
  task_delivery_report_submit: gap(agentGap),
  task_execution_queue_get: partial("Fila de entrega aparece em Início/Roadmap; sem a ordenação completa da tool."),
  task_scope_set: gap(agentGap),
  task_start: ui("Início seguro de tarefa; `POST …/work-items/:key/start`"),
  task_start_check: ui("Início seguro de tarefa; `GET …/work-items/:key/start-readiness`"),
  task_workflow_get: ui("detalhe da tarefa; `GET …/work-items/:key/task-workflow`"),
  task_workflow_propose: ui("editor de workflow; `POST …/task-workflow/revisions`"),
  task_workflow_publish: ui("editor de workflow; `POST …/task-workflow/revisions/:n/publish`"),
  task_workflow_step_transition: ui("detalhe da tarefa; `POST …/task-workflow/steps/:id/status`"),
  team_capacity_get: partial("Capacidade exibida em Métricas/Capacidade; sem histórico de versões."),
  team_capacity_set: ui(`${planning}: team_capacity_set`),
  team_create: ui(`${planning}: team_create`),
  team_list: ui("seletor de time; `GET …/teams`"),
  template_apply: gap("Templates de item (SSDD-949) sem UI."),
  template_list: gap("Templates de item (SSDD-949) sem UI."),
  template_set: gap("Templates de item (SSDD-949) sem UI."),
  test_run_certify: gap("Certificação QA pela UI planejada em SSDD-96."),
  test_run_list: ui(`${qa}; \`GET …/test-runs\``),
  test_run_record: ui(`${qa} → Registrar execução; \`POST …/scenarios/:key/test-runs\``),
  trace_link_add: ui(`diálogo Operações do item (\`POST …/backlog/:operation\`): trace_link_add`),
  trace_link_remove: ui(`diálogo Operações do item (\`POST …/backlog/:operation\`): trace_link_remove`),
  trace_query: ui("rastro do item; `GET …/work-items/:key/trace`"),
  user_auth_key_revoke: gap(adminGap),
  user_auth_key_rotate: gap(adminGap),
  user_create: gap(adminGap),
  user_list: gap(adminGap),
  work_item_assign: ui(`diálogo Operações do item (\`POST …/backlog/:operation\`): work_item_assign`),
  work_item_create: ui("Novo PBI; `POST …/work-items`"),
  work_item_estimate: ui(`diálogo Operações do item (\`POST …/backlog/:operation\`): work_item_estimate`),
  work_item_estimate_confirm: ui(`diálogo Operações do item (\`POST …/backlog/:operation\`): work_item_estimate_confirm`),
  work_item_gate_check: ui("transição e Início seguro exibem os gates; `…/start-readiness` e erros de `…/transition`"),
  work_item_get: ui("detalhe do item; `GET …/work-items/:key`"),
  work_item_list: ui("Backlog e Board; `GET …/work-items`"),
  work_item_quality_get: ui(`${qa} e detalhe do PBI; \`GET …/work-items/:key/quality\``),
  work_item_rank: ui(`diálogo Operações do item (\`POST …/backlog/:operation\`): work_item_rank`),
  work_item_readiness_review: gap("Revisão de prontidão sem UI."),
  work_item_revision_list: ui("detalhe do item; `GET …/work-items/:key/revisions`"),
  work_item_revision_propose: ui("editor do PBI; `POST …/work-items/:key/revisions`"),
  work_item_revision_publish: ui("editor do PBI; `POST …/work-items/:key/revisions/:n/publish`"),
  work_item_semantic_index: gap("Índice semântico é manutenção via MCP."),
  work_item_semantic_search: gap("Busca semântica sem UI; a busca do Backlog é textual."),
  work_item_transition: ui("Backlog/Board → mover; `POST …/work-items/:key/transition`"),
};

export function renderToolUiMatrix(): string {
  const labels: Record<ToolUiCoverage, string> = { ui: "UI", partial: "Parcial", gap: "Lacuna futura" };
  const entries = Object.entries(toolUiMatrix).sort(([a], [b]) => a.localeCompare(b));
  const count = (kind: ToolUiCoverage) => entries.filter(([, entry]) => entry.coverage === kind).length;
  return [
    "# Matriz de paridade ferramenta MCP → operação do dashboard",
    "",
    "Gerado de `src/dashboard/tool-ui-matrix.ts` (`UPDATE_UI_MATRIX=1 npm test` regenera). Cada ferramenta do MCP tem uma operação de UI, cobertura parcial ou uma lacuna futura explícita; `tests/dashboard/tool-ui-matrix.test.ts` falha se uma ferramenta nova ficar sem classificação.",
    "",
    `Resumo: ${count("ui")} com UI, ${count("partial")} parciais, ${count("gap")} lacunas futuras (${entries.length} ferramentas).`,
    "",
    "| Tool | Cobertura | Operação da UI ou motivo da lacuna |",
    "| --- | --- | --- |",
    ...entries.map(([tool, entry]) => `| \`${tool}\` | ${labels[entry.coverage]} | ${entry.note} |`),
    "",
  ].join("\n");
}
