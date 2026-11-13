import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  mcpProfileAllowsPrompt,
  mcpProfileAllowsTool,
  mcpProfileSkillNames,
  mcpProfiles,
  parseMcpProfile,
  type McpProfile,
} from "../../src/mcp/profiles.js";

test("workflow profiles expose only their stage prompts and skills", () => {
  const expected: Record<string, { readonly prompts: readonly string[]; readonly skills: readonly string[] }> = {
    full: {
      prompts: [
        "ssdd_refine_backlog", "ssdd_refine_technical_design", "ssdd_plan_sprint", "ssdd_start_task",
        "ssdd_validate_quality", "ssdd_release_readiness", "ssdd_design_tests", "ssdd_security_review",
      ],
      skills: [
        "ssdd-product-owner", "ssdd-technical-lead", "ssdd-developer", "ssdd-quality-assurance",
        "ssdd-release-manager", "ssdd-business-analyst", "ssdd-test-designer", "ssdd-security-reviewer",
        "ssdd-delivery-facilitator", "ssdd-system-administrator",
      ],
    },
    refinement: { prompts: ["ssdd_refine_backlog"], skills: ["ssdd-business-analyst", "ssdd-product-owner"] },
    specification: { prompts: ["ssdd_refine_technical_design"], skills: ["ssdd-technical-lead"] },
    dev: { prompts: ["ssdd_start_task"], skills: ["ssdd-developer"] },
    test_design: { prompts: ["ssdd_design_tests"], skills: ["ssdd-test-designer"] },
    qa: { prompts: ["ssdd_design_tests", "ssdd_validate_quality"], skills: ["ssdd-test-designer", "ssdd-quality-assurance"] },
    tech_lead: {
      prompts: ["ssdd_refine_technical_design", "ssdd_start_task", "ssdd_design_tests"],
      skills: ["ssdd-technical-lead", "ssdd-developer"],
    },
    security_review: { prompts: ["ssdd_security_review"], skills: ["ssdd-security-reviewer"] },
    po: { prompts: ["ssdd_refine_backlog", "ssdd_plan_sprint"], skills: ["ssdd-business-analyst", "ssdd-product-owner"] },
    facilitator: { prompts: ["ssdd_plan_sprint"], skills: ["ssdd-delivery-facilitator"] },
    release: { prompts: ["ssdd_release_readiness"], skills: ["ssdd-release-manager"] },
    devops: { prompts: ["ssdd_release_readiness"], skills: ["ssdd-release-manager"] },
    admin: { prompts: [], skills: ["ssdd-system-administrator"] },
  };

  assert.deepEqual([...mcpProfiles].sort(), Object.keys(expected).sort());
  for (const profile of mcpProfiles) {
    const allowed = expected[profile]!;
    assert.deepEqual(
      [...new Set([...mcpProfiles.flatMap((candidate) => expected[candidate]!.prompts)])]
        .filter((name) => mcpProfileAllowsPrompt(profile, name)).sort(),
      [...allowed.prompts].sort(),
      `${profile} prompt set`,
    );
    assert.deepEqual([...mcpProfileSkillNames(profile, true)].sort(), [...allowed.skills].sort(), `${profile} admin skill set`);
  }
  assert.equal(mcpProfileSkillNames("admin", false).size, 0, "non-admins do not receive the host administrator playbook");
  assert.equal(mcpProfileSkillNames("full", false).has("ssdd-system-administrator"), false);
  assert.equal(mcpProfileSkillNames("full", true).has("ssdd-system-administrator"), true);
});

test("stage profiles keep authorization gates separate from visibility and avoid unrelated tools", () => {
  assert.equal(parseMcpProfile(" test_design "), "test_design");
  assert.throws(() => parseMcpProfile("unknown"), /Unsupported MCP profile/u);

  assert.equal(mcpProfileAllowsTool("refinement", "work_item_create", false), true);
  assert.equal(mcpProfileAllowsTool("refinement", "spec_create", false), true);
  assert.equal(mcpProfileAllowsTool("refinement", "test_run_certify", false), false);
  assert.equal(mcpProfileAllowsTool("specification", "spec_revision_propose", false), true);
  assert.equal(mcpProfileAllowsTool("specification", "deployment_event_record", false), false);
  assert.equal(mcpProfileAllowsTool("test_design", "scenario_create", false), true);
  assert.equal(mcpProfileAllowsTool("test_design", "test_run_record", false), false);
  assert.equal(mcpProfileAllowsTool("security_review", "spec_revision_propose", false), false);
  assert.equal(mcpProfileAllowsTool("security_review", "task_context_get", false), true);
  assert.equal(mcpProfileAllowsTool("security_review", "work_item_semantic_search", false), false);
  assert.equal(mcpProfileAllowsTool("devops", "deployment_event_record", false), true);
  assert.equal(mcpProfileAllowsTool("devops", "work_item_transition", false), false);

  assert.equal(mcpProfileAllowsTool("dev", "metrics_get", false), false);
  assert.equal(mcpProfileAllowsTool("dev", "work_item_create", false), true);
  assert.equal(mcpProfileAllowsTool("dev", "work_item_estimate_confirm", false), true);
  assert.equal(mcpProfileAllowsTool("dev", "task_start_check", false), true);
  assert.equal(mcpProfileAllowsTool("dev", "task_start", false), true);
  assert.equal(mcpProfileAllowsTool("dev", "development_session_start", false), true);
  assert.equal(mcpProfileAllowsTool("dev", "task_workflow_get", false), true);
  assert.equal(mcpProfileAllowsTool("dev", "task_workflow_propose", false), true);
  assert.equal(mcpProfileAllowsTool("dev", "task_workflow_step_transition", false), true);
  assert.equal(mcpProfileAllowsTool("dev", "task_workflow_publish", false), false);
  assert.equal(mcpProfileAllowsTool("dev", "spec_create", false), false);
  assert.equal(mcpProfileAllowsTool("dev", "sprint_draft", false), false);
  assert.equal(mcpProfileAllowsTool("qa", "development_session_start", false), false);
  assert.equal(mcpProfileAllowsTool("qa", "deployment_event_record", false), false);
  assert.equal(mcpProfileAllowsTool("qa", "task_workflow_get", false), true);
  assert.equal(mcpProfileAllowsTool("qa", "task_workflow_step_transition", false), false);
  assert.equal(mcpProfileAllowsTool("tech_lead", "milestone_forecast_recalculate", false), false);
  assert.equal(mcpProfileAllowsTool("tech_lead", "sprint_draft", false), false);
  assert.equal(mcpProfileAllowsTool("tech_lead", "task_workflow_publish", false), true);
  assert.equal(mcpProfileAllowsTool("po", "team_capacity_set", false), false);
  assert.equal(mcpProfileAllowsTool("po", "work_item_transition", false), true);
  assert.equal(mcpProfileAllowsTool("po", "definition_of_done_set", false), false);
  assert.equal(mcpProfileAllowsTool("facilitator", "work_item_transition", false), false);
  assert.equal(mcpProfileAllowsTool("facilitator", "test_run_record", false), false);
  assert.equal(mcpProfileAllowsTool("release", "scenario_create", false), false);
  assert.equal(mcpProfileAllowsTool("release", "sprint_draft", false), false);
  assert.equal(mcpProfileAllowsTool("admin", "task_context_get", true), true);
  assert.equal(mcpProfileAllowsTool("admin", "sprint_draft", true), false);
  assert.equal(mcpProfileAllowsTool("admin", "scenario_create", true), false);

  assert.equal(mcpProfileAllowsTool("admin", "user_create", false), false);
  assert.equal(mcpProfileAllowsTool("admin", "user_create", true), true);
  assert.equal(mcpProfileAllowsTool("full", "new_future_tool", true), true);
});

test("every registered MCP tool is assigned to at least one curated workflow profile", () => {
  const serverSource = readFileSync(resolve(process.cwd(), "src/mcp/server.ts"), "utf8");
  const registered = [...serverSource.matchAll(/server\.registerTool\(\s*["']([^"']+)["']/gu)]
    .map((match) => match[1]!);
  assert.ok(registered.length > 50, "the registry scan should find the MCP tool catalog");

  const fullOnlyTools = new Set<string>();
  const uncovered = registered.filter((toolName) =>
    !fullOnlyTools.has(toolName) &&
    !mcpProfiles.some((profile) => profile !== "full" && mcpProfileAllowsTool(profile, toolName, true)));
  assert.deepEqual(uncovered, [], "new tools need an intentional workflow profile or an explicit full-only decision");
  assert.ok([...fullOnlyTools].every((toolName) => registered.includes(toolName)), "full-only tool declarations must exist in the registry");

  const securityWrites = registered.filter((toolName) =>
    mcpProfileAllowsTool("security_review", toolName, true) &&
    /(?:_create|_propose|_publish|_add|_remove|_record|_certify|_transition|_set|_start|_close|_cancel|_assign|_rank|_estimate|_fix|_revalidate|_issue|_revoke|_apply|_scope_change|_bind)$/u.test(toolName));
  assert.deepEqual(securityWrites, [], "security_review must remain a read-only surface");
});

test("stage profiles stay within their reviewed MCP context budgets", () => {
  const serverSource = readFileSync(resolve(process.cwd(), "src/mcp/server.ts"), "utf8");
  const registered = [...serverSource.matchAll(/server\.registerTool\(\s*["']([^"']+)["']/gu)]
    .map((match) => match[1]!);
  const reviewedMaximum: Record<string, number> = {
    refinement: 30, // Inclui question_list, work_item_readiness_review e question_open (SSDD-939).
    specification: 36, // Inclui question_list e work_item_readiness_review (SSDD-939).
    dev: 51, // Includes the task execution queue, workflow progress, atomic task start, and task_accept.
    test_design: 30, // Inclui question_list e work_item_readiness_review (SSDD-939).
    qa: 31,
    tech_lead: 75, // Timeline de auditoria somente leitura, ADR authoring, draft withdrawal, task workflow, execution ordering, and feature forecasts are part of the role.
    security_review: 30, // Inclui a timeline de auditoria somente leitura.
    po: 62, // Includes backlog discovery, draft withdrawal, task queue, feature roadmap and sprint planning.
    facilitator: 27,
    release: 26,
    devops: 26,
    admin: 21, // Inclui a timeline de auditoria somente leitura.
  };
  for (const [profile, maximum] of Object.entries(reviewedMaximum)) {
    const visibleCount = registered.filter((name) => mcpProfileAllowsTool(profile as McpProfile, name, true)).length;
    assert.ok(visibleCount <= maximum, `${profile} exposes ${visibleCount} tools; review the context budget (${maximum}) before expanding it`);
  }
});
