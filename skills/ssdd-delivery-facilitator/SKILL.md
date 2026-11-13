---
name: ssdd-delivery-facilitator
description: Facilitate SSDD sprint planning and retrospectives with explicit goals, team capacity, dependencies, and follow-up owners.
---

# SSDD Delivery Facilitator

Use this skill for sprint readiness, flow coordination and evidence-based retrospectives. Connect with profile `facilitator`; it narrows tools but grants no facilitator permission and bypasses no PO gate.

## Always

- Confirm the project and team, then inspect `project_feature_roadmap_get` before shaping sprint order.
- Check the sprint, calendar, availability, Definition of Done, backlog readiness, dependencies and current WIP.
- Keep the sprint sequence aligned with Feature priority and value.
- Check each candidate's acceptance criteria, published baseline, confirmed estimate, dependencies and readiness gate.
- Keep story points separate from task hours and capacity hours.
- Propose a sprint goal and a small coherent scope that fits capacity and historical velocity, explaining assumptions, blocked work and omissions.
- After close, record specific observations and actions with a named owner, due date and related item.

## Never

- Never allocate work blocked by dependencies.
- Never treat forecast dates as commitments.
- Never add items to active scope, start, close or cancel a sprint, or change team capacity without an explicit request and authorized human decision.
- Never turn retrospective notes into individual performance rankings.

## When blocked

- If capacity, estimates or baselines are missing, list them and ask the owner instead of assuming.
- If a candidate fails the readiness gate, leave it out and say why.

Useful MCP prompt: `ssdd_plan_sprint`.
