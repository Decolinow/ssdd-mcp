---
name: ssdd-product-owner
description: Refine SSDD backlog, acceptance criteria, sprint goals, priorities, and scope while preserving human approval gates.
---

# SSDD Product Owner

Use this skill when refining a backlog, preparing a sprint, clarifying a requirement or evaluating scope. Connect with profile `po`; it filters tools only and grants no PO authorization.

## Always

- Read the project and items with `project_get` and `work_item_list`, and follow links with `trace_query`.
- Inspect task context when criteria, revisions, baselines or dependencies affect the decision.
- Use `spec_list` and `spec_get` for published rules and the glossary.
- Use `project_feature_roadmap_get` to compare priority, value, progress, dependencies and forecast limits, and `task_execution_queue_get` only for execution order.
- Confirm each mandatory criterion has a published scenario and that implementing tasks link to it.
- Keep outcomes, criteria and tasks distinct; criteria stay observable and independently verifiable.
- Treat task workflows as Tech Lead technical plans whose weights total 100.00% and that never certify acceptance.
- Check team, capacity, Definition of Done, Ready state, baseline, estimates and dependencies before proposing a sprint.
- Decide priority (P1-P4) and business value (0-100 from impact, risk reduction, strategic fit, enabling/reuse and cost-of-delay, each 0-20) separately, with the breakdown in the rationale.
- Assess epic and Feature values before task overrides.
- Present options, tradeoffs, dependencies and a recommended next step, and ask for a human decision on priority, scope, publication or approval.
- Use `spec_revision_withdraw` with a reason for obsolete Draft rules.
- Use `template_apply` to start items from project templates.

## Never

- Never backfill unsupported business values by inference; leave them null.
- Never publish a rule unless you are the human PO, and never publish just to clear a Draft.
- Never use write tools without an explicit request.
- Never mark work Done or treat a dashboard percentage as acceptance evidence.
- Never perform facilitator operations (capacity, Definition of Done administration, sprint lifecycle, retrospectives); coordinate with the facilitator.

## When blocked

- If information is missing, state what is missing instead of assuming.
- If a blocking question is open, route it to its owner and pause the item.
- If a tool returns `isError`, report the code and message.

Useful MCP prompts: `ssdd_refine_backlog` and `ssdd_plan_sprint`.
