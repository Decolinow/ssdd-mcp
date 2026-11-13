# Matriz de paridade do catálogo MCP

Gerada por `tests/mcp/catalog-parity.test.ts` (SSDD-906). Não edite à mão: rode `UPDATE_PARITY_MATRIX=1 npm test` depois de mudar o catálogo.
stdio e Streamable HTTP expõem o mesmo catálogo (nome, descrição, schemas e anotações idênticos), verificado no mesmo teste.
A autorização por papel de cada operação está em `docs/mcp.md`; a coluna de perfis mostra onde a tool é visível além de `full`.

| Tool | Mutabilidade | Paginação | Perfis | Skills consumidoras |
|---|---|---|---|---|
| `adr_create` | escrita (aprovável) | — | specification, tech_lead | chamada direta (sem skill dedicada) |
| `adr_link_task` | escrita (aprovável) | — | specification, tech_lead | chamada direta (sem skill dedicada) |
| `adr_search` | leitura | cursor | refinement, specification, dev, test_design, qa, tech_lead, security_review, po, devops | chamada direta (sem skill dedicada) |
| `approval_issue` | escrita | — | admin | chamada direta (sem skill dedicada) |
| `approval_revoke` | escrita | — | admin | chamada direta (sem skill dedicada) |
| `audit_event_list` | leitura | cursor | tech_lead, security_review, admin | chamada direta (sem skill dedicada) |
| `azure_work_item_import_apply` | escrita | — | po | chamada direta (sem skill dedicada) |
| `azure_work_item_import_preview` | leitura | — | po | chamada direta (sem skill dedicada) |
| `baseline_fix` | escrita (aprovável) | — | tech_lead | chamada direta (sem skill dedicada) |
| `baseline_get` | leitura | — | specification, dev, test_design, qa, tech_lead, security_review, po, release, devops, admin | chamada direta (sem skill dedicada) |
| `baseline_revalidate` | escrita (aprovável) | — | tech_lead | chamada direta (sem skill dedicada) |
| `comment_add` | escrita (aprovável) | — | refinement, specification, dev, test_design, qa, tech_lead | chamada direta (sem skill dedicada) |
| `comment_list` | leitura | cursor | refinement, specification, dev, test_design, qa, tech_lead, security_review, po | chamada direta (sem skill dedicada) |
| `definition_of_done_get` | leitura | — | po, facilitator | chamada direta (sem skill dedicada) |
| `definition_of_done_set` | escrita (aprovável) | — | facilitator | chamada direta (sem skill dedicada) |
| `delivery_quality_metrics_get` | leitura | — | tech_lead, facilitator | chamada direta (sem skill dedicada) |
| `deployment_event_list` | leitura | — | dev, tech_lead, security_review, release, devops | ssdd-release-manager |
| `deployment_event_record` | escrita (aprovável) | — | release, devops | ssdd-release-manager |
| `developer_execution_metrics_get` | leitura | — | tech_lead | chamada direta (sem skill dedicada) |
| `development_session_list` | leitura | — | dev, tech_lead, security_review | chamada direta (sem skill dedicada) |
| `development_session_recover` | escrita (aprovável) | — | tech_lead, admin | chamada direta (sem skill dedicada) |
| `development_session_stale_list` | leitura | — | tech_lead, admin | chamada direta (sem skill dedicada) |
| `development_session_start` | escrita (aprovável) | — | dev, tech_lead | chamada direta (sem skill dedicada) |
| `development_session_transition` | escrita (aprovável) | — | dev, tech_lead | ssdd-developer |
| `evidence_add` | escrita (aprovável) | — | dev, qa, tech_lead | chamada direta (sem skill dedicada) |
| `evidence_list` | leitura | cursor | specification, dev, test_design, qa, tech_lead, security_review, po, release, admin | chamada direta (sem skill dedicada) |
| `file_claim_acquire` | escrita | — | dev, tech_lead | chamada direta (sem skill dedicada) |
| `file_claim_list` | leitura | — | dev, tech_lead | chamada direta (sem skill dedicada) |
| `file_claim_release` | escrita | — | dev, tech_lead | chamada direta (sem skill dedicada) |
| `file_claim_renew` | escrita | — | dev, tech_lead | chamada direta (sem skill dedicada) |
| `flow_metrics_get` | leitura | — | tech_lead | chamada direta (sem skill dedicada) |
| `gate_policy_get` | leitura | — | dev, tech_lead, po | chamada direta (sem skill dedicada) |
| `gate_policy_set` | escrita (aprovável) | — | tech_lead, po | chamada direta (sem skill dedicada) |
| `github_issue_import_apply` | escrita | — | po | chamada direta (sem skill dedicada) |
| `github_issue_import_preview` | leitura | — | po | chamada direta (sem skill dedicada) |
| `github_reference_list` | leitura | — | dev, qa, tech_lead, release, devops | ssdd-release-manager |
| `impact_list` | leitura | — | specification, dev, test_design, qa, tech_lead, security_review, po, release, devops | chamada direta (sem skill dedicada) |
| `metrics_get` | escrita | — | po, facilitator, release, devops | chamada direta (sem skill dedicada) |
| `milestone_create` | escrita (aprovável) | — | po | chamada direta (sem skill dedicada) |
| `milestone_forecast_history` | leitura | — | po, facilitator, release, devops | chamada direta (sem skill dedicada) |
| `milestone_forecast_recalculate` | leitura | — | po, release, devops | chamada direta (sem skill dedicada) |
| `milestone_get` | leitura | — | po, facilitator, release, devops | chamada direta (sem skill dedicada) |
| `milestone_list` | leitura | — | po, facilitator, release, devops | chamada direta (sem skill dedicada) |
| `milestone_scope_change` | escrita (aprovável) | — | po | chamada direta (sem skill dedicada) |
| `project_feature_roadmap_get` | leitura | — | tech_lead, po, facilitator, devops | ssdd-delivery-facilitator, ssdd-product-owner |
| `project_get` | leitura | — | refinement, specification, dev, test_design, qa, tech_lead, security_review, po, facilitator, release, devops, admin | ssdd-product-owner, ssdd-technical-lead |
| `project_guidance_get` | leitura | — | dev, tech_lead, po | chamada direta (sem skill dedicada) |
| `project_guidance_set` | escrita (aprovável) | — | tech_lead, po | chamada direta (sem skill dedicada) |
| `project_list` | leitura | — | refinement, specification, dev, test_design, qa, tech_lead, security_review, po, facilitator, release, devops, admin | chamada direta (sem skill dedicada) |
| `question_answer` | escrita (aprovável) | — | tech_lead, po | chamada direta (sem skill dedicada) |
| `question_list` | leitura | — | refinement, specification, dev, test_design, tech_lead, security_review, po | chamada direta (sem skill dedicada) |
| `question_open` | escrita (aprovável) | — | refinement, dev, tech_lead, po | ssdd-business-analyst |
| `review_list` | leitura | — | dev, qa, tech_lead | chamada direta (sem skill dedicada) |
| `review_record` | escrita (aprovável) | — | dev, qa, tech_lead | ssdd-quality-assurance |
| `roadmap_id_bind` | escrita (aprovável) | — | po | chamada direta (sem skill dedicada) |
| `roadmap_id_list` | leitura | — | refinement, specification, test_design, tech_lead, security_review, po | chamada direta (sem skill dedicada) |
| `roadmap_id_resolve` | leitura | — | refinement, specification, test_design, tech_lead, security_review, po | ssdd-developer |
| `scenario_create` | escrita (aprovável) | — | test_design, qa | chamada direta (sem skill dedicada) |
| `scenario_criterion_search` | leitura | — | refinement, specification, dev, test_design, qa, tech_lead, security_review, po, release | ssdd-test-designer |
| `scenario_get` | leitura | — | refinement, specification, dev, test_design, qa, tech_lead, security_review, po, release, devops | chamada direta (sem skill dedicada) |
| `scenario_list` | leitura | cursor | refinement, specification, dev, test_design, qa, tech_lead, security_review, po, release, devops | chamada direta (sem skill dedicada) |
| `scenario_revision_propose` | escrita (aprovável) | — | test_design, qa | chamada direta (sem skill dedicada) |
| `scenario_revision_publish` | escrita (aprovável) | — | test_design, qa | chamada direta (sem skill dedicada) |
| `spec_create` | escrita (aprovável) | — | refinement, specification, tech_lead, po | chamada direta (sem skill dedicada) |
| `spec_get` | leitura | — | refinement, specification, dev, test_design, qa, tech_lead, security_review, po, release, devops | ssdd-business-analyst, ssdd-developer, ssdd-product-owner, ssdd-quality-assurance, ssdd-technical-lead, ssdd-test-designer |
| `spec_list` | leitura | cursor | refinement, specification, dev, test_design, qa, tech_lead, security_review, po, release, devops | ssdd-business-analyst, ssdd-product-owner |
| `spec_revision_propose` | escrita (aprovável) | — | refinement, specification, tech_lead, po | chamada direta (sem skill dedicada) |
| `spec_revision_publish` | escrita (aprovável) | — | tech_lead, po | chamada direta (sem skill dedicada) |
| `spec_revision_withdraw` | escrita | — | tech_lead, po | ssdd-product-owner, ssdd-technical-lead |
| `sprint_cancel` | escrita (aprovável) | — | facilitator | chamada direta (sem skill dedicada) |
| `sprint_close` | escrita (aprovável) | — | facilitator | chamada direta (sem skill dedicada) |
| `sprint_draft` | escrita (aprovável) | — | po, facilitator | chamada direta (sem skill dedicada) |
| `sprint_get` | leitura | — | po, facilitator | chamada direta (sem skill dedicada) |
| `sprint_list` | leitura | — | po, facilitator | chamada direta (sem skill dedicada) |
| `sprint_retrospective_get` | leitura | — | po, facilitator | chamada direta (sem skill dedicada) |
| `sprint_retrospective_set` | escrita (aprovável) | — | facilitator | chamada direta (sem skill dedicada) |
| `sprint_scope_change` | escrita (aprovável) | — | po, facilitator | chamada direta (sem skill dedicada) |
| `sprint_start` | escrita (aprovável) | — | po, facilitator | chamada direta (sem skill dedicada) |
| `task_accept` | escrita (aprovável) | — | dev, tech_lead | chamada direta (sem skill dedicada) |
| `task_briefing_get` | leitura | cursor | dev, tech_lead | ssdd-developer |
| `task_context_get` | leitura | cursor | refinement, specification, dev, test_design, qa, tech_lead, security_review, po, facilitator, admin | ssdd-developer, ssdd-quality-assurance, ssdd-technical-lead, ssdd-test-designer |
| `task_delivery_report_get` | leitura | — | dev, tech_lead | chamada direta (sem skill dedicada) |
| `task_delivery_report_submit` | escrita (aprovável) | — | dev, tech_lead | ssdd-developer |
| `task_execution_queue_get` | leitura | — | dev, tech_lead, po | ssdd-developer, ssdd-product-owner |
| `task_scope_set` | escrita (aprovável) | — | dev, tech_lead | ssdd-developer |
| `task_start` | escrita (aprovável) | — | dev, tech_lead | ssdd-developer |
| `task_start_check` | leitura | — | dev, tech_lead | ssdd-developer |
| `task_workflow_get` | leitura | — | refinement, specification, dev, test_design, qa, tech_lead, security_review, po, release | ssdd-developer, ssdd-quality-assurance, ssdd-test-designer |
| `task_workflow_propose` | escrita (aprovável) | — | dev, tech_lead | chamada direta (sem skill dedicada) |
| `task_workflow_publish` | escrita (aprovável) | — | tech_lead | chamada direta (sem skill dedicada) |
| `task_workflow_step_transition` | escrita (aprovável) | — | dev, tech_lead | ssdd-developer |
| `team_capacity_get` | leitura | — | security_review, po, facilitator, devops | chamada direta (sem skill dedicada) |
| `team_capacity_set` | escrita (aprovável) | — | facilitator | chamada direta (sem skill dedicada) |
| `team_create` | escrita (aprovável) | — | facilitator | chamada direta (sem skill dedicada) |
| `team_list` | leitura | — | security_review, po, facilitator, devops | chamada direta (sem skill dedicada) |
| `template_apply` | escrita (aprovável) | — | dev, tech_lead, po | ssdd-product-owner, ssdd-technical-lead |
| `template_list` | leitura | — | dev, tech_lead, po | chamada direta (sem skill dedicada) |
| `template_set` | escrita (aprovável) | — | tech_lead, po | ssdd-technical-lead |
| `test_run_certify` | escrita (aprovável) | — | qa | chamada direta (sem skill dedicada) |
| `test_run_list` | leitura | cursor | specification, dev, test_design, qa, tech_lead, security_review, po, release, devops, admin | ssdd-quality-assurance, ssdd-test-designer |
| `test_run_record` | escrita (aprovável) | — | qa | ssdd-quality-assurance |
| `trace_link_add` | escrita (aprovável) | — | specification, tech_lead | ssdd-technical-lead |
| `trace_link_remove` | escrita (aprovável) | — | specification, tech_lead | chamada direta (sem skill dedicada) |
| `trace_query` | leitura | — | refinement, specification, dev, test_design, qa, tech_lead, security_review, po, release | ssdd-product-owner, ssdd-technical-lead |
| `user_auth_key_revoke` | escrita | — | admin | chamada direta (sem skill dedicada) |
| `user_auth_key_rotate` | escrita | — | admin | chamada direta (sem skill dedicada) |
| `user_create` | escrita | — | admin | chamada direta (sem skill dedicada) |
| `user_list` | leitura | — | admin | chamada direta (sem skill dedicada) |
| `work_item_assign` | escrita (aprovável) | — | refinement, dev, tech_lead, po | chamada direta (sem skill dedicada) |
| `work_item_create` | escrita (aprovável) | — | refinement, specification, dev, tech_lead, po | chamada direta (sem skill dedicada) |
| `work_item_estimate` | escrita (aprovável) | — | dev, tech_lead | chamada direta (sem skill dedicada) |
| `work_item_estimate_confirm` | escrita (aprovável) | — | dev, tech_lead | chamada direta (sem skill dedicada) |
| `work_item_gate_check` | leitura | — | refinement, specification, dev, test_design, qa, tech_lead, security_review, po, facilitator, release, devops, admin | ssdd-developer, ssdd-technical-lead |
| `work_item_get` | leitura | — | refinement, specification, dev, test_design, qa, tech_lead, security_review, po, facilitator, release, devops, admin | ssdd-developer, ssdd-technical-lead |
| `work_item_list` | leitura | cursor | refinement, specification, dev, test_design, qa, tech_lead, security_review, po, facilitator, release, devops, admin | ssdd-product-owner |
| `work_item_quality_get` | leitura | cursor | refinement, specification, dev, test_design, qa, tech_lead, security_review, po, facilitator, release, devops, admin | ssdd-quality-assurance, ssdd-test-designer |
| `work_item_rank` | escrita (aprovável) | — | tech_lead, po | chamada direta (sem skill dedicada) |
| `work_item_readiness_review` | leitura | — | refinement, specification, dev, test_design, tech_lead, security_review, po | ssdd-business-analyst |
| `work_item_revision_list` | leitura | — | refinement, specification, dev, test_design, qa, tech_lead, security_review, po, release, devops, admin | chamada direta (sem skill dedicada) |
| `work_item_revision_propose` | escrita (aprovável) | — | refinement, specification, tech_lead, po | chamada direta (sem skill dedicada) |
| `work_item_revision_publish` | escrita (aprovável) | — | tech_lead, po | chamada direta (sem skill dedicada) |
| `work_item_semantic_index` | escrita | cursor | refinement, specification, tech_lead, po | chamada direta (sem skill dedicada) |
| `work_item_semantic_search` | escrita | — | refinement, specification, dev, test_design, tech_lead, po | chamada direta (sem skill dedicada) |
| `work_item_transition` | escrita (aprovável) | — | dev, tech_lead, po | chamada direta (sem skill dedicada) |
