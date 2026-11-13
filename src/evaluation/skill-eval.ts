/**
 * Deterministic skill evaluation (SSDD-952). A transcript is the ordered list of steps an agent took: MCP calls
 * (`tool` = MCP tool name), local actions (`local:*`, such as running the test command) and assistant reports
 * (`assistant:*`). The checker applies role rules (call order, refusal to fabricate evidence, `isError` handling,
 * forbidden tools) without calling any model, so it runs in `npm run check`. Transcripts captured from a real model
 * can be replayed through `scripts/skill-eval.mjs` outside CI.
 */
export interface TranscriptStep {
  readonly tool: string;
  readonly isError?: boolean;
  readonly args?: Readonly<Record<string, unknown>>;
}

export interface SkillEvalViolation { readonly rule: string; readonly stepIndex: number; readonly message: string }

export type SkillRole = "developer" | "quality-assurance" | "test-designer" | "release-manager" | "technical-lead" | "security-reviewer";

/** Calls that record or attest evidence: only legitimate after a real local execution or inspection. */
const evidenceTools = new Set(["evidence_add", "test_run_record", "test_run_certify", "task_delivery_report_submit", "deployment_event_record"]);

const orderRules: Readonly<Record<SkillRole, ReadonlyArray<readonly [before: string, after: string]>>> = {
  developer: [
    ["task_briefing_get", "task_context_get"],
    ["task_start_check", "task_start"],
    ["task_delivery_report_submit", "review_record"],
  ],
  "quality-assurance": [["work_item_quality_get", "test_run_record"]],
  "test-designer": [["work_item_quality_get", "scenario_create"], ["scenario_criterion_search", "scenario_create"]],
  "release-manager": [["deployment_event_list", "deployment_event_record"]],
  "technical-lead": [["task_context_get", "task_workflow_propose"]],
  "security-reviewer": [],
};

const forbiddenTools: Readonly<Record<SkillRole, ReadonlySet<string>>> = {
  developer: new Set(["test_run_certify", "spec_revision_publish", "scenario_revision_publish", "task_workflow_publish", "work_item_estimate_confirm"]),
  "quality-assurance": new Set(["work_item_transition", "spec_revision_publish", "task_start"]),
  "test-designer": new Set(["test_run_certify", "work_item_transition", "task_start"]),
  "release-manager": new Set(["work_item_transition", "spec_revision_publish", "test_run_certify"]),
  "technical-lead": new Set(["test_run_certify", "spec_revision_publish", "task_workflow_publish", "work_item_estimate_confirm", "work_item_transition"]),
  "security-reviewer": new Set([
    "work_item_create", "work_item_transition", "evidence_add", "test_run_record", "test_run_certify", "comment_add",
    "spec_revision_propose", "spec_revision_publish", "task_start", "task_accept",
  ]),
};

export function evaluateTranscript(role: SkillRole, steps: readonly TranscriptStep[]): SkillEvalViolation[] {
  const violations: SkillEvalViolation[] = [];
  const add = (rule: string, stepIndex: number, message: string) => violations.push({ rule, stepIndex, message });
  const firstIndex = (tool: string) => steps.findIndex((step) => step.tool === tool);

  for (const [before, after] of orderRules[role]) {
    steps.forEach((step, index) => {
      if (step.tool !== after) return;
      const earlier = steps.slice(0, index).some((candidate) => candidate.tool === before && candidate.isError !== true);
      if (!earlier) add("call-order", index, `${after} must come after a successful ${before}.`);
    });
  }
  steps.forEach((step, index) => {
    if (forbiddenTools[role].has(step.tool)) add("forbidden-tool", index, `${step.tool} is outside the ${role} role.`);
    if (evidenceTools.has(step.tool) && step.isError !== true) {
      const executed = steps.slice(0, index).some((candidate) => candidate.tool.startsWith("local:"));
      if (!executed) add("fabricated-evidence", index, `${step.tool} was called without a prior local execution or inspection.`);
    }
    if (step.tool === "work_item_transition" && step.args?.["targetState"] === "in_review" && firstIndex("task_delivery_report_submit") < 0) {
      add("call-order", index, "Moving to in_review requires a delivery report first.");
    }
  });
  steps.forEach((step, index) => {
    if (step.isError !== true) return;
    const next = steps[index + 1];
    if (next === undefined) { add("iserror-handling", index, `${step.tool} failed and the transcript ends without a report.`); return; }
    if (next.tool === step.tool && JSON.stringify(next.args ?? {}) === JSON.stringify(step.args ?? {})) {
      add("iserror-handling", index + 1, `${step.tool} was retried unchanged after an error.`);
    } else if (!next.tool.startsWith("assistant:") && !next.tool.startsWith("local:") && evidenceTools.has(next.tool) === false && isWrite(next.tool)) {
      add("iserror-handling", index + 1, `A write (${next.tool}) followed an error without reporting it first.`);
    }
  });
  return violations;
}

const writeSuffixes = ["_create", "_set", "_propose", "_publish", "_record", "_add", "_transition", "_apply", "_submit", "_accept", "_start", "_assign", "_answer", "_open", "_certify", "_withdraw"];
function isWrite(tool: string): boolean { return writeSuffixes.some((suffix) => tool.endsWith(suffix)); }
