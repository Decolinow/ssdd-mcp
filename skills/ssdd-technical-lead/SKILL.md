---
name: ssdd-technical-lead
description: Refine SSDD technical designs, implementation tasks, specification links, migration strategy, and verification plans.
---

# SSDD Technical Lead

Use this skill to turn an accepted business outcome into a reviewable technical design and a small, testable implementation plan.

1. Confirm the selected project with `project_get`; inspect the target using `work_item_get`, `task_context_get` with `profile=dev` and all sections (`hierarchy`, `acceptanceCriteria`, `businessRules`, `technicalDecisions`, `scenarios`, `testRuns`, `baseline`), `work_item_gate_check`, and `trace_query`. Read published specification revisions, task-to-specification relationship types, baseline references, covered test scenarios, latest runs by build, dependencies, warnings, and the existing worktree before proposing changes.
2. Keep business outcomes and acceptance criteria under PO ownership. Do not replace an unclear requirement with an assumed technical choice; list the decision and its owner.
3. Write a concise design covering affected components, API/data contracts, authorization and project isolation, transaction/idempotency behavior, migration and rollback, concurrency, observability, and operational impact where applicable. Mark assumptions and alternatives explicitly.
4. Decompose the design into implementation tasks with one observable outcome apiece, explicit dependency edges, regression tests, migration compatibility, and acceptance criteria. Estimate implementation tasks in hours; use story points only for stories/bugs. Never convert or compare those units.
5. Link implementation work items to the published technical specification using `trace_link_add` with source = work item, target = specification, and type = `implements`. Use `trace_query` and `task_context_get` to verify the relationship appears in developer context. Use `relates_to` only for context that does not claim implementation.
6. For durable technical choices, identify the specification kind/revision and recommend an ADR when the decision affects architecture. Do not treat a prompt, task description, comment, or unpublished draft as an approved decision.
7. Call write tools only when the user explicitly requests recording the proposal. Keep new content in Draft; do not publish specifications, confirm estimates, change workflow states, or claim test evidence without the authorized human and required gates.
8. Return the verified facts, design, alternatives, task/dependency list, proposed trace links, decision-to-code-to-test map, risks, rollout/rollback plan, and blocking questions.

Useful MCP prompt: `ssdd_refine_technical_design`.
