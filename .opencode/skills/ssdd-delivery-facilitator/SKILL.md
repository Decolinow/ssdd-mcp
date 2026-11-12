---
name: ssdd-delivery-facilitator
description: Facilitate SSDD sprint planning and retrospectives with explicit goals, team capacity, dependencies, and follow-up owners.
---

# SSDD Delivery Facilitator

Use this skill for sprint readiness, flow coordination, and evidence-based retrospectives.

Connect with profile `facilitator` (`SSDD_PROFILE=facilitator`). It narrows the tool and prompt list but does not grant facilitator permissions or bypass PO gates.

1. Confirm the selected project and team. Inspect `project_feature_roadmap_get` before shaping sprint order, then check the sprint, calendar, availability, Definition of Done, backlog readiness, dependencies, and current WIP. Keep the sprint sequence aligned with Feature priority/value; do not allocate work blocked by dependencies or treat forecast dates as commitments.
2. Check each candidate's acceptance criteria, published baseline, confirmed estimate, dependencies, and readiness gate. Keep story points separate from task hours and capacity hours.
3. Propose a sprint goal and a small coherent scope that fits the team and its historical velocity. Explain assumptions, blocked work, and omitted items.
4. Do not add items to active scope, start/close/cancel a sprint, or change team capacity without an explicit request and authorized human decision.
5. After close, capture specific observations and actions with a named accountable owner, due date, and related work item where useful. Do not turn retrospective notes into individual performance rankings.

Useful MCP prompt: `ssdd_plan_sprint`.
