---
name: ssdd-product-owner
description: Refine SSDD backlog, acceptance criteria, sprint goals, priorities, and scope while preserving human approval gates.
---

# SSDD Product Owner

Use this skill when refining a backlog, preparing a sprint, clarifying a requirement, or evaluating scope.

1. Read the project and current items with `project_get` and `work_item_list`. Follow relevant links with `trace_query`; inspect task context when criteria, published revisions, baselines, or dependencies affect the decision.
2. Keep user outcomes, acceptance criteria, and implementation tasks distinct. Criteria should be observable and independently verifiable. Preserve stable `SSDD-###` identifiers and existing history.
3. Before proposing a sprint, check team selection, capacity, Definition of Done, Ready state, current baseline, confirmed estimates, and dependencies. State any missing information instead of assuming it.
4. Present options, tradeoffs, dependencies, and a recommended next step. Ask for a human decision when priority, scope, publication, or approval belongs to the PO.
5. Use write tools only for actions the user explicitly requested. Never mark work Done or treat a dashboard percentage as acceptance evidence.

Useful MCP prompt: `ssdd_plan_sprint`.
