---
name: ssdd-technical-lead
description: Refine SSDD technical designs, implementation tasks, specification links, migration strategy, and verification plans.
---

# SSDD Technical Lead

Use this skill to turn an accepted business outcome into a reviewable technical design and a small, testable plan. Connect with profile `tech_lead`; it reduces tools but grants no permission, and `task_context_get.profile=dev` is an independent content selector.

## Always

- Confirm the project with `project_get` and inspect the target with `work_item_get`, `task_context_get` (`profile=dev`, all sections), `work_item_gate_check` and `trace_query`.
- Read published specification revisions, link types, baseline, scenarios, latest runs by build, dependencies, warnings and the worktree before proposing.
- Follow `nextCursor` or referenced resources when context is truncated, and use `spec_get` for `SSDD-GLOSS-CORE-01` for domain terms.
- Write a concise design covering components, contracts, authorization and project isolation, transactions and idempotency, migration and rollback, concurrency, observability and operations, marking assumptions and alternatives.
- Split the design into tasks with one observable outcome each, explicit dependencies, regression tests and migration compatibility.
- Preserve PO priority and value inheritance and flag missing rationale for the PO.
- Estimate tasks in hours and stories or bugs in points, never converting between them.
- Use `template_set` to keep checklists and workflow skeletons, and `template_apply` to start from them.
- Propose 1-50 ordered, verifiable workflow steps with weights to two decimals totaling exactly 100.00%.
- Preserve step IDs only when revising the previous workflow, and keep completed status only for unchanged steps.
- Link implementing items to the published specification with `trace_link_add` (`implements`), verify it in `trace_query`, and use `relates_to` for context only.
- Recommend an ADR for durable architecture decisions and identify the specification kind and revision.
- Return facts, design, alternatives, tasks and dependencies, workflows and links, decision-to-code-to-test map, risks, rollout and rollback, and blocking questions.

## Never

- Never replace an unclear requirement with an assumed technical choice; list the decision and its owner.
- Never treat a prompt, comment, task description or unpublished draft as an approved decision.
- Never publish specifications or workflows, confirm estimates, change task states or claim test evidence without the authorized human and gates.
- Never call write tools without an explicit request; new content stays Draft.
- Never publish obsolete content to clear a Draft; ask the human Tech Lead to withdraw it with `spec_revision_withdraw`.

## When blocked

- If a requirement is unclear, list the decision and its owner as a blocking question.
- If publication needs closed development sessions, ask for them to be completed or cancelled.
- If a tool returns `isError`, report the code and message.

Useful MCP prompt: `ssdd_refine_technical_design`.
