# Matriz de paridade ferramenta MCP → operação do dashboard

Gerado de `src/dashboard/tool-ui-matrix.ts` (`UPDATE_UI_MATRIX=1 npm test` regenera). Cada ferramenta do MCP tem uma operação de UI, cobertura parcial ou uma lacuna futura explícita; `tests/dashboard/tool-ui-matrix.test.ts` falha se uma ferramenta nova ficar sem classificação.

Resumo: 65 com UI, 8 parciais, 49 lacunas futuras (122 ferramentas).

| Tool | Cobertura | Operação da UI ou motivo da lacuna |
| --- | --- | --- |
| `adr_link_task` | UI | aba Especificações → vincular ADR a tarefa; `POST …/work-items/:key/adr-links` |
| `approval_issue` | Lacuna futura | Operação administrativa de host: fica no CLI/MCP humano; sem rota no dashboard. |
| `approval_revoke` | Lacuna futura | Operação administrativa de host: fica no CLI/MCP humano; sem rota no dashboard. |
| `audit_event_list` | UI | aba Atividade; `GET …/audit` e timeline do item |
| `azure_work_item_import_apply` | Lacuna futura | Importação de provedor externo: fluxo de PO via MCP; sem UI planejada. |
| `azure_work_item_import_preview` | Lacuna futura | Importação de provedor externo: fluxo de PO via MCP; sem UI planejada. |
| `baseline_fix` | Lacuna futura | A baseline é fixada pela transição para Ready (aba Backlog → mover); não há ação isolada. |
| `baseline_get` | Parcial | Detalhe do PBI mostra a baseline fixada via `GET …/work-items/:key/quality`; sem consulta de baselines históricas. |
| `baseline_revalidate` | Lacuna futura | Revalidação de baseline sem UI; lacuna do AC-1 do SSDD-97. |
| `comment_add` | UI | diálogo Operações do item (`POST …/backlog/:operation`): comment_add |
| `comment_list` | UI | detalhe do item; `GET …/work-items/:key/comments` |
| `definition_of_done_get` | Parcial | Capacidade/DoD exibidas nos resumos de sprint; sem tela dedicada da DoD. |
| `definition_of_done_set` | UI | diálogo Planejamento (`POST …/planning/:operation`): definition_of_done_set |
| `delivery_quality_metrics_get` | Lacuna futura | Métrica nova (SSDD-951) ainda sem aba. |
| `deployment_event_list` | UI | aba Métricas; `GET …/deployment-events` |
| `deployment_event_record` | Lacuna futura | Registro de deploy vem de pipeline/DevOps via MCP. |
| `developer_execution_metrics_get` | UI | aba Métricas; `GET …/developer-execution-metrics` |
| `development_session_list` | UI | detalhe da tarefa e aba Métricas; `GET …/development-sessions` |
| `development_session_recover` | Lacuna futura | Fluxo de agente de desenvolvimento; o dashboard só exibe o resultado (detalhe da tarefa). |
| `development_session_stale_list` | Lacuna futura | Fluxo de agente de desenvolvimento; o dashboard só exibe o resultado (detalhe da tarefa). |
| `development_session_start` | UI | Início seguro de tarefa; `POST …/work-items/:key/start` |
| `development_session_transition` | Lacuna futura | Fluxo de agente de desenvolvimento; o dashboard só exibe o resultado (detalhe da tarefa). |
| `evidence_add` | Lacuna futura | Evidências são anexadas por agente/QA; o dashboard apenas lista (detalhe da tarefa). |
| `evidence_list` | UI | detalhe da tarefa, seção de evidências com paginação (`…/context`) |
| `file_claim_acquire` | Lacuna futura | Fluxo de agente de desenvolvimento; o dashboard só exibe o resultado (detalhe da tarefa). |
| `file_claim_list` | Lacuna futura | Fluxo de agente de desenvolvimento; o dashboard só exibe o resultado (detalhe da tarefa). |
| `file_claim_release` | Lacuna futura | Fluxo de agente de desenvolvimento; o dashboard só exibe o resultado (detalhe da tarefa). |
| `file_claim_renew` | Lacuna futura | Fluxo de agente de desenvolvimento; o dashboard só exibe o resultado (detalhe da tarefa). |
| `flow_metrics_get` | Parcial | Métricas de fluxo aparecem na aba Métricas via `dashboard-metrics`; sem filtros próprios da tool. |
| `gate_policy_get` | Lacuna futura | Política de gates sem UI. |
| `gate_policy_set` | Lacuna futura | Política de gates sem UI. |
| `github_issue_import_apply` | Lacuna futura | Importação de provedor externo: fluxo de PO via MCP; sem UI planejada. |
| `github_issue_import_preview` | Lacuna futura | Importação de provedor externo: fluxo de PO via MCP; sem UI planejada. |
| `github_reference_list` | Lacuna futura | Referências GitHub sem UI. |
| `impact_list` | Lacuna futura | Impactos sem UI; lacuna do AC-1 do SSDD-97. |
| `metrics_get` | UI | aba Métricas; `GET …/dashboard-metrics` |
| `milestone_create` | UI | diálogo Planejamento (`POST …/planning/:operation`): milestone_create |
| `milestone_forecast_history` | Parcial | Histórico de previsão exibido na aba Métricas (projeção de entrega). |
| `milestone_forecast_recalculate` | Lacuna futura | Recalculo de previsão só via MCP. |
| `milestone_get` | Parcial | Marco aparece como filtro/resumo em Métricas; sem detalhe dedicado. |
| `milestone_list` | Parcial | Marcos listados como filtro em Métricas; sem tela dedicada. |
| `milestone_scope_change` | UI | diálogo Planejamento (`POST …/planning/:operation`): milestone_scope_change |
| `project_feature_roadmap_get` | UI | aba Roadmap; `GET …/feature-roadmap` |
| `project_get` | UI | cabeçalho do projeto; `GET …/projects/:id` |
| `project_guidance_get` | Lacuna futura | Orientações do projeto sem UI. |
| `project_guidance_set` | Lacuna futura | Orientações do projeto sem UI. |
| `project_list` | UI | seletor de projeto; `GET /api/v1/projects` |
| `question_answer` | Lacuna futura | Perguntas abertas sem UI. |
| `question_list` | Lacuna futura | Perguntas abertas sem UI. |
| `question_open` | Lacuna futura | Perguntas abertas sem UI. |
| `review_list` | Lacuna futura | Revisões de código sem UI. |
| `review_record` | Lacuna futura | Revisões de código sem UI. |
| `roadmap_id_bind` | Lacuna futura | Mapa de IDs de roadmap é ferramenta de manutenção via MCP/script. |
| `roadmap_id_list` | Lacuna futura | Mapa de IDs de roadmap é ferramenta de manutenção via MCP/script. |
| `roadmap_id_resolve` | Lacuna futura | Mapa de IDs de roadmap é ferramenta de manutenção via MCP/script. |
| `scenario_create` | UI | aba Qualidade → Novo cenário; `POST …/scenarios` |
| `scenario_criterion_search` | Lacuna futura | Busca de critério para cobertura sem UI; o vínculo é digitado. |
| `scenario_get` | UI | aba Qualidade; `GET …/scenarios/:key` |
| `scenario_list` | UI | aba Qualidade; `GET …/scenarios` |
| `scenario_revision_propose` | UI | aba Qualidade → Propor revisão; `POST …/scenarios/:key/revisions` |
| `scenario_revision_publish` | UI | aba Qualidade → Publicar; `POST …/scenarios/:key/revisions/:n/publish` |
| `spec_create` | UI | aba Especificações → Nova especificação; `POST …/specifications` |
| `spec_get` | UI | aba Especificações; `GET …/specifications/:key` |
| `spec_list` | UI | aba Especificações; `GET …/specifications` |
| `spec_revision_propose` | UI | aba Especificações → Propor revisão; `POST …/specifications/:key/revisions` |
| `spec_revision_publish` | UI | aba Especificações → Publicar; `POST …/specifications/:key/revisions/:n/publish` |
| `spec_revision_withdraw` | UI | aba Especificações → Retirar rascunho; `POST …/specifications/:key/revisions/:n/withdraw` |
| `sprint_cancel` | UI | diálogo Planejamento (`POST …/planning/:operation`): sprint_cancel |
| `sprint_close` | UI | diálogo Planejamento (`POST …/planning/:operation`): sprint_close |
| `sprint_draft` | UI | diálogo Planejamento (`POST …/planning/:operation`): sprint_draft |
| `sprint_get` | UI | resumo da sprint; `GET …/sprints/:key` |
| `sprint_list` | UI | resumo e seletor de sprint; `GET …/sprints` |
| `sprint_retrospective_get` | UI | aba Retrospectiva; `GET …/sprints/:key/retrospective` |
| `sprint_retrospective_set` | UI | aba Retrospectiva; `POST …/sprints/:key/retrospective` |
| `sprint_scope_change` | UI | diálogo Planejamento (`POST …/planning/:operation`): sprint_scope_change |
| `sprint_start` | UI | diálogo Planejamento (`POST …/planning/:operation`): sprint_start |
| `task_accept` | Lacuna futura | Composite de agente; o dashboard executa os passos separadamente (mover, iniciar). |
| `task_briefing_get` | Lacuna futura | Fluxo de agente de desenvolvimento; o dashboard só exibe o resultado (detalhe da tarefa). |
| `task_context_get` | UI | detalhe da tarefa; `GET …/work-items/:key/context` |
| `task_delivery_report_get` | Lacuna futura | Fluxo de agente de desenvolvimento; o dashboard só exibe o resultado (detalhe da tarefa). |
| `task_delivery_report_submit` | Lacuna futura | Fluxo de agente de desenvolvimento; o dashboard só exibe o resultado (detalhe da tarefa). |
| `task_execution_queue_get` | Parcial | Fila de entrega aparece em Início/Roadmap; sem a ordenação completa da tool. |
| `task_scope_set` | Lacuna futura | Fluxo de agente de desenvolvimento; o dashboard só exibe o resultado (detalhe da tarefa). |
| `task_start` | UI | Início seguro de tarefa; `POST …/work-items/:key/start` |
| `task_start_check` | UI | Início seguro de tarefa; `GET …/work-items/:key/start-readiness` |
| `task_workflow_get` | UI | detalhe da tarefa; `GET …/work-items/:key/task-workflow` |
| `task_workflow_propose` | UI | editor de workflow; `POST …/task-workflow/revisions` |
| `task_workflow_publish` | UI | editor de workflow; `POST …/task-workflow/revisions/:n/publish` |
| `task_workflow_step_transition` | UI | detalhe da tarefa; `POST …/task-workflow/steps/:id/status` |
| `team_capacity_get` | Parcial | Capacidade exibida em Métricas/Capacidade; sem histórico de versões. |
| `team_capacity_set` | UI | diálogo Planejamento (`POST …/planning/:operation`): team_capacity_set |
| `team_create` | UI | diálogo Planejamento (`POST …/planning/:operation`): team_create |
| `team_list` | UI | seletor de time; `GET …/teams` |
| `template_apply` | Lacuna futura | Templates de item (SSDD-949) sem UI. |
| `template_list` | Lacuna futura | Templates de item (SSDD-949) sem UI. |
| `template_set` | Lacuna futura | Templates de item (SSDD-949) sem UI. |
| `test_run_certify` | UI | detalhe do PBI, botão Certificar em cada execução aprovada; diálogo Operações (`POST …/backlog/test_run_certify`) |
| `test_run_list` | UI | aba Qualidade; `GET …/test-runs` |
| `test_run_record` | UI | aba Qualidade → Registrar execução; `POST …/scenarios/:key/test-runs` |
| `trace_link_add` | UI | diálogo Operações do item (`POST …/backlog/:operation`): trace_link_add |
| `trace_link_remove` | UI | diálogo Operações do item (`POST …/backlog/:operation`): trace_link_remove |
| `trace_query` | UI | rastro do item; `GET …/work-items/:key/trace` |
| `user_auth_key_revoke` | Lacuna futura | Operação administrativa de host: fica no CLI/MCP humano; sem rota no dashboard. |
| `user_auth_key_rotate` | Lacuna futura | Operação administrativa de host: fica no CLI/MCP humano; sem rota no dashboard. |
| `user_create` | Lacuna futura | Operação administrativa de host: fica no CLI/MCP humano; sem rota no dashboard. |
| `user_list` | Lacuna futura | Operação administrativa de host: fica no CLI/MCP humano; sem rota no dashboard. |
| `work_item_assign` | UI | diálogo Operações do item (`POST …/backlog/:operation`): work_item_assign |
| `work_item_create` | UI | Novo PBI; `POST …/work-items` |
| `work_item_estimate` | UI | diálogo Operações do item (`POST …/backlog/:operation`): work_item_estimate |
| `work_item_estimate_confirm` | UI | diálogo Operações do item (`POST …/backlog/:operation`): work_item_estimate_confirm |
| `work_item_gate_check` | UI | transição e Início seguro exibem os gates; `…/start-readiness` e erros de `…/transition` |
| `work_item_get` | UI | detalhe do item; `GET …/work-items/:key` |
| `work_item_list` | UI | Backlog e Board; `GET …/work-items` |
| `work_item_quality_get` | UI | aba Qualidade e detalhe do PBI; `GET …/work-items/:key/quality` |
| `work_item_rank` | UI | diálogo Operações do item (`POST …/backlog/:operation`): work_item_rank |
| `work_item_readiness_review` | Lacuna futura | Revisão de prontidão sem UI. |
| `work_item_revision_list` | UI | detalhe do item; `GET …/work-items/:key/revisions` |
| `work_item_revision_propose` | UI | editor do PBI; `POST …/work-items/:key/revisions` |
| `work_item_revision_publish` | UI | editor do PBI; `POST …/work-items/:key/revisions/:n/publish` |
| `work_item_semantic_index` | Lacuna futura | Índice semântico é manutenção via MCP. |
| `work_item_semantic_search` | Lacuna futura | Busca semântica sem UI; a busca do Backlog é textual. |
| `work_item_transition` | UI | Backlog/Board → mover; `POST …/work-items/:key/transition` |
