export const mcpProfiles = [
  "full",
  "refinement",
  "specification",
  "dev",
  "test_design",
  "qa",
  "tech_lead",
  "security_review",
  "po",
  "facilitator",
  "release",
  "devops",
  "admin",
] as const;
export type McpProfile = (typeof mcpProfiles)[number];

const projectReadTools = ["project_list", "project_get"] as const;

const refinementReadTools = [
  ...projectReadTools, "roadmap_id_resolve", "roadmap_id_list",
  "work_item_get", "work_item_revision_list", "work_item_list", "work_item_semantic_search", "task_workflow_get", "comment_list",
  "spec_get", "spec_list", "scenario_get", "scenario_list", "scenario_criterion_search", "trace_query",
  "adr_search", "work_item_gate_check", "work_item_quality_get", "task_context_get",
  "question_list", "work_item_readiness_review",
] as const;

const specificationReadTools = [
  ...refinementReadTools,
  "baseline_get", "impact_list", "test_run_list", "evidence_list",
] as const;

const testDesignReadTools = [
  ...refinementReadTools,
  "baseline_get", "impact_list", "test_run_list", "work_item_quality_get", "evidence_list",
] as const;

const developerReadTools = [
  ...projectReadTools,
  "task_context_get", "work_item_get", "work_item_revision_list", "work_item_list", "work_item_semantic_search", "task_workflow_get",
  "task_execution_queue_get",
  "comment_list", "baseline_get", "impact_list", "spec_get", "spec_list", "adr_search", "task_start_check",
  "scenario_get", "scenario_list", "scenario_criterion_search", "test_run_list",
  "development_session_list", "deployment_event_list", "github_reference_list",
  "work_item_gate_check", "work_item_quality_get", "evidence_list", "trace_query",
  "question_list", "work_item_readiness_review", "task_delivery_report_get", "review_list", "task_briefing_get", "gate_policy_get", "project_guidance_get",
] as const;

const qaReadTools = [
  ...projectReadTools,
  "task_context_get", "work_item_get", "work_item_revision_list", "work_item_list", "task_workflow_get", "comment_list",
  "baseline_get", "impact_list", "spec_get", "spec_list", "scenario_get", "scenario_list",
  "scenario_criterion_search", "test_run_list", "github_reference_list", "adr_search",
  "work_item_gate_check", "work_item_quality_get", "evidence_list", "trace_query",
] as const;

const technicalLeadReadTools = [
  ...new Set([
    ...refinementReadTools, ...specificationReadTools, ...testDesignReadTools, ...developerReadTools,
    "developer_execution_metrics_get", "flow_metrics_get",
    "project_feature_roadmap_get", "audit_event_list",
  ]),
] as const;

const productOwnerReadTools = [
  ...new Set([
    ...refinementReadTools, ...specificationReadTools, ...testDesignReadTools,
    "milestone_get", "milestone_list", "milestone_forecast_history", "metrics_get",
    "project_feature_roadmap_get", "task_execution_queue_get",
    "team_list", "team_capacity_get", "definition_of_done_get", "sprint_get", "sprint_list",
    "sprint_retrospective_get",
  ]),
] as const;

const facilitatorReadTools = [
  ...projectReadTools,
  "task_context_get", "work_item_get", "work_item_list", "work_item_gate_check", "work_item_quality_get",
  "milestone_get", "milestone_list", "milestone_forecast_history", "metrics_get",
  "project_feature_roadmap_get",
  "team_list", "team_capacity_get", "definition_of_done_get", "sprint_get", "sprint_list",
  "sprint_retrospective_get",
] as const;

const releaseReadTools = [
  ...projectReadTools,
  "work_item_get", "work_item_revision_list", "work_item_list", "task_workflow_get", "baseline_get", "impact_list",
  "spec_get", "spec_list", "scenario_get", "scenario_list", "scenario_criterion_search", "test_run_list",
  "milestone_get", "milestone_list", "milestone_forecast_history", "metrics_get",
  "deployment_event_list", "github_reference_list", "work_item_gate_check", "work_item_quality_get",
  "evidence_list", "trace_query",
] as const;

const adminReadTools = [
  ...projectReadTools,
  "task_context_get", "work_item_get", "work_item_revision_list", "work_item_list",
  "baseline_get", "test_run_list", "work_item_gate_check", "work_item_quality_get", "evidence_list", "audit_event_list", "development_session_stale_list",
] as const;

const securityReviewReadTools = [
  ...specificationReadTools,
  "development_session_list", "deployment_event_list", "team_list", "team_capacity_get", "audit_event_list",
] as const;

const developerTools = [
  "work_item_create", "work_item_assign", "comment_add", "work_item_estimate", "work_item_estimate_confirm",
  "development_session_start", "development_session_transition", "task_start_check", "task_start", "task_accept", "file_claim_acquire", "file_claim_renew", "file_claim_release", "file_claim_list", "task_workflow_propose",
  "task_workflow_step_transition", "work_item_transition", "evidence_add", "question_open", "task_delivery_report_submit", "review_record", "task_scope_set",
] as const;

const qaTools = [
  "scenario_create", "scenario_revision_propose", "scenario_revision_publish",
  "test_run_record", "test_run_certify", "evidence_add", "comment_add", "review_record", "review_list",
] as const;

const testDesignTools = [
  "scenario_create", "scenario_revision_propose", "scenario_revision_publish", "comment_add",
] as const;

const technicalLeadTools = [
  "baseline_fix", "baseline_revalidate", "work_item_create", "work_item_revision_propose",
  "work_item_revision_publish", "work_item_estimate_confirm", "spec_create", "adr_create", "adr_link_task",
  "spec_revision_propose", "spec_revision_publish", "spec_revision_withdraw", "trace_link_add", "trace_link_remove", "work_item_semantic_index",
  "task_workflow_propose", "task_workflow_publish", "task_workflow_step_transition",
  "development_session_stale_list", "development_session_recover", "question_answer", "gate_policy_set", "project_guidance_set",
  "file_claim_acquire", "file_claim_renew", "file_claim_release", "file_claim_list",
] as const;

const productOwnerTools = [
  "work_item_create", "work_item_revision_propose", "work_item_revision_publish",
  "work_item_assign", "work_item_rank", "work_item_transition", "question_open", "question_answer", "gate_policy_set", "gate_policy_get", "project_guidance_set", "project_guidance_get", "spec_create", "spec_revision_propose", "spec_revision_publish", "spec_revision_withdraw",
  "adr_search",
  "milestone_create", "milestone_scope_change", "milestone_forecast_recalculate",
  "roadmap_id_bind",
  "work_item_semantic_index",
  "github_issue_import_preview", "github_issue_import_apply", "azure_work_item_import_preview", "azure_work_item_import_apply",
  "sprint_draft", "sprint_scope_change", "sprint_start",
] as const;

const refinementWriteTools = [
  "work_item_create", "work_item_revision_propose", "work_item_assign", "spec_create", "spec_revision_propose",
  "comment_add", "work_item_semantic_index", "question_open",
] as const;

const specificationWriteTools = [
  "work_item_create", "work_item_revision_propose", "spec_create", "spec_revision_propose",
  "adr_search", "adr_create", "adr_link_task", "trace_link_add", "trace_link_remove", "comment_add", "work_item_semantic_index",
] as const;

const facilitatorTools = [
  "team_create", "team_capacity_set", "definition_of_done_set", "sprint_draft", "sprint_scope_change",
  "sprint_start", "sprint_close", "sprint_cancel", "sprint_retrospective_set",
] as const;

const releaseTools = [
  "milestone_forecast_recalculate", "deployment_event_record", "github_reference_list",
] as const;

const administrationTools = [
  "user_create", "user_list", "user_auth_key_rotate", "user_auth_key_revoke",
  "approval_issue", "approval_revoke", "development_session_recover",
] as const;

const refinementTools = new Set([...refinementReadTools, ...refinementWriteTools]);
const specificationTools = new Set([...specificationReadTools, ...specificationWriteTools]);
const testDesignToolNames = new Set([...testDesignReadTools, ...testDesignTools]);
const securityReviewTools = new Set(securityReviewReadTools.filter((name) => name !== "work_item_semantic_search"));

const profileToolNames: Readonly<Record<Exclude<McpProfile, "full">, ReadonlySet<string>>> = {
  refinement: refinementTools,
  specification: specificationTools,
  dev: new Set([...developerReadTools, ...developerTools]),
  test_design: testDesignToolNames,
  qa: new Set([...qaReadTools, ...qaTools]),
  tech_lead: new Set([
    ...technicalLeadReadTools, ...developerTools, ...technicalLeadTools,
    ...productOwnerTools.filter((name) => name === "work_item_assign" || name === "work_item_rank"),
  ]),
  security_review: securityReviewTools,
  po: new Set([...productOwnerReadTools, ...productOwnerTools]),
  facilitator: new Set([...facilitatorReadTools, ...facilitatorTools]),
  release: new Set([...releaseReadTools, ...releaseTools]),
  devops: new Set([
    "project_list", "project_get", "work_item_get", "work_item_list", "work_item_revision_list",
    "work_item_gate_check", "work_item_quality_get", "test_run_list", "baseline_get", "impact_list",
    "milestone_get", "milestone_list", "milestone_forecast_history", "milestone_forecast_recalculate",
    "metrics_get", "deployment_event_list", "deployment_event_record", "github_reference_list",
    "project_feature_roadmap_get",
    "team_list", "team_capacity_get", "spec_get", "spec_list", "adr_search", "scenario_get", "scenario_list",
  ]),
  admin: new Set([...adminReadTools, ...administrationTools]),
};

const profilePromptNames: Readonly<Record<McpProfile, ReadonlySet<string>>> = {
  full: new Set([
    "ssdd_refine_backlog", "ssdd_refine_technical_design", "ssdd_plan_sprint", "ssdd_start_task",
    "ssdd_validate_quality", "ssdd_release_readiness", "ssdd_design_tests", "ssdd_security_review",
  ]),
  refinement: new Set(["ssdd_refine_backlog"]),
  specification: new Set(["ssdd_refine_technical_design"]),
  dev: new Set(["ssdd_start_task"]),
  test_design: new Set(["ssdd_design_tests"]),
  qa: new Set(["ssdd_design_tests", "ssdd_validate_quality"]),
  tech_lead: new Set(["ssdd_refine_technical_design", "ssdd_start_task", "ssdd_design_tests"]),
  security_review: new Set(["ssdd_security_review"]),
  po: new Set(["ssdd_refine_backlog", "ssdd_plan_sprint"]),
  facilitator: new Set(["ssdd_plan_sprint"]),
  release: new Set(["ssdd_release_readiness"]),
  devops: new Set(["ssdd_release_readiness"]),
  admin: new Set(),
};

const profileSkillNames: Readonly<Record<McpProfile, ReadonlySet<string>>> = {
  full: new Set([
    "ssdd-product-owner", "ssdd-technical-lead", "ssdd-developer", "ssdd-quality-assurance",
    "ssdd-release-manager", "ssdd-business-analyst", "ssdd-test-designer", "ssdd-security-reviewer",
    "ssdd-delivery-facilitator", "ssdd-system-administrator",
  ]),
  refinement: new Set(["ssdd-business-analyst", "ssdd-product-owner"]),
  specification: new Set(["ssdd-technical-lead"]),
  dev: new Set(["ssdd-developer"]),
  test_design: new Set(["ssdd-test-designer"]),
  qa: new Set(["ssdd-test-designer", "ssdd-quality-assurance"]),
  tech_lead: new Set(["ssdd-technical-lead", "ssdd-developer"]),
  security_review: new Set(["ssdd-security-reviewer"]),
  po: new Set(["ssdd-business-analyst", "ssdd-product-owner"]),
  facilitator: new Set(["ssdd-delivery-facilitator"]),
  release: new Set(["ssdd-release-manager"]),
  devops: new Set(["ssdd-release-manager"]),
  admin: new Set(["ssdd-system-administrator"]),
};

export function parseMcpProfile(value: string | undefined): McpProfile {
  const profile = value?.trim() || "full";
  if ((mcpProfiles as readonly string[]).includes(profile)) return profile as McpProfile;
  throw new Error(`Unsupported MCP profile '${profile}'. Use one of: ${mcpProfiles.join(", ")}.`);
}

export function mcpProfileAllowsTool(profile: McpProfile, toolName: string, isInstanceAdmin: boolean): boolean {
  if (toolName.startsWith("user_") && !isInstanceAdmin) return false;
  if (profile === "full") return true;
  return profileToolNames[profile].has(toolName);
}

export function mcpProfileAllowsPrompt(profile: McpProfile, promptName: string): boolean {
  return profilePromptNames[profile].has(promptName);
}

export function mcpProfileSkillNames(profile: McpProfile, isInstanceAdmin: boolean): ReadonlySet<string> {
  if (profile === "admin" && !isInstanceAdmin) return new Set();
  if (profile === "full" && !isInstanceAdmin) {
    return new Set([...profileSkillNames.full].filter((name) => name !== "ssdd-system-administrator"));
  }
  return profileSkillNames[profile];
}
