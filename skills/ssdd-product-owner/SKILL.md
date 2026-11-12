---
name: ssdd-product-owner
description: Refine SSDD backlog, acceptance criteria, sprint goals, priorities, and scope while preserving human approval gates.
---

# SSDD Product Owner

Use this skill when refining a backlog, preparing a sprint, clarifying a requirement, or evaluating scope.

Configure the MCP connection with profile `po` (`SSDD_PROFILE=po` for stdio or `X-SSDD-Profile: po` for HTTP). The connection profile filters tools only; it does not grant PO authorization or approve publication and workflow gates.

1. Read the project and current items with `project_get` and `work_item_list`. Follow relevant links with `trace_query`; inspect task context when criteria, published revisions, baselines, or dependencies affect the decision. Use `spec_list`/`spec_get` for published business rules and the glossary when terms affect product policy; the task-context resolver omits glossary entries. Use `project_feature_roadmap_get` to compare Feature priority, business value, progress, dependencies, and forecast limits; use `task_execution_queue_get` only when checking the execution sequence. Confirm each mandatory acceptance criterion has a published scenario, and identify implementation tasks that should be linked to the scenario and its test runs.
2. Keep user outcomes, acceptance criteria, and implementation tasks distinct. Criteria should be observable and independently verifiable. Task workflows are technical plans owned by the Tech Lead: their step weights total 100.00% of relative task effort, remain separate from story points/hours, and do not certify acceptance or QA. Preserve stable `SSDD-###` identifiers and existing history.
3. Before proposing a sprint, check team selection, capacity, Definition of Done, Ready state, current baseline, confirmed estimates, and dependencies. State any missing information instead of assuming it.
   Coordinate with the delivery facilitator for team calendars, capacity and Definition of Done administration, sprint lifecycle operations, and retrospectives. The PO profile can shape sprint goal and scope but does not expose those operational writes.
4. Treat priority and business value as separate decisions: priority is P1–P4 (P1 highest); business value is 0–100 from five PO dimensions (impact, risk reduction, strategic fit, enabling/reuse, and cost-of-delay urgency; each 0–20). Put the dimension breakdown and evidence/assessment in the rationale. The score is ordinal, not money or a delivery forecast. Assess epic/Feature values before task overrides so tasks inherit a meaningful score. Leave unsupported values null; never backfill by inference. Publish an accepted rule only as a human PO. Use `spec_revision_withdraw` with a reason when a Draft business rule is obsolete or abandoned; do not publish it just to clear the Draft state.
5. Present options, tradeoffs, dependencies, and a recommended next step. Ask for a human decision when priority, scope, publication, or approval belongs to the PO.
6. Use write tools only for actions the user explicitly requested. Never mark work Done or treat a dashboard percentage as acceptance evidence.

Useful MCP prompts: `ssdd_refine_backlog` for backlog refinement and `ssdd_plan_sprint` for sprint selection.
