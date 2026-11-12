---
name: ssdd-technical-lead
description: Refine SSDD technical designs, implementation tasks, specification links, migration strategy, and verification plans.
---

# SSDD Technical Lead

Use this skill to turn an accepted business outcome into a reviewable technical design and a small, testable implementation plan.

Configure the MCP connection with profile `tech_lead` (`SSDD_PROFILE=tech_lead` for stdio or `X-SSDD-Profile: tech_lead` for HTTP). This reduces the listed tools but does not grant technical-lead permissions. The skill uses `task_context_get.profile=dev` to request implementation-oriented task content; that parameter is independent from the connection profile.

1. Confirm the selected project with `project_get`; inspect the target using `work_item_get`, `task_context_get` with `profile=dev` and all sections (`hierarchy`, `acceptanceCriteria`, `businessRules`, `technicalDecisions`, `scenarios`, `testRuns`, `baseline`), `work_item_gate_check`, and `trace_query`. Read published specification revisions, task-to-specification relationship types, baseline references, covered test scenarios, latest runs by build, dependencies, warnings, and the existing worktree before proposing changes. Follow `nextCursor` or referenced resources when context is truncated or an entry is moved to a resource. The resolver omits glossary entries; use `spec_get` for `SSDD-GLOSS-CORE-01` when domain terms need clarification.
2. Keep business outcomes and acceptance criteria under PO ownership. Do not replace an unclear requirement with an assumed technical choice; list the decision and its owner.
3. Write a concise design covering affected components, API/data contracts, authorization and project isolation, transaction/idempotency behavior, migration and rollback, concurrency, observability, and operational impact where applicable. Mark assumptions and alternatives explicitly.
4. Decompose the design into implementation tasks with one observable outcome apiece, explicit dependency edges, regression tests, migration compatibility, and acceptance criteria. Preserve PO priority and business-value inheritance in the hierarchy; flag missing rationale for PO review instead of inventing a score. Estimate implementation tasks in hours; use story points only for stories/bugs. Never convert or compare those units.
5. For each task that needs a detailed execution plan, use `task_workflow_get` and propose 1–50 ordered, verifiable steps with instructions and expected outcomes. Assign effort weights to two decimals that total exactly 100.00%; these weights express relative task effort, not logged hours, completion estimates, or story points. Include review/test steps where appropriate without treating them as QA certification.
6. Preserve step IDs only when revising the previous workflow; keep a completed status only when the step title and instructions are unchanged. A changed definition or order that breaks sequence can reset progress. Proposals stay Draft; only a human Tech Lead publishes, and publication requires all development sessions on the task to be closed.
7. Link implementation work items to the published technical specification using `trace_link_add` with source = work item, target = specification, and type = `implements`. Use `trace_query` and `task_context_get` to verify the relationship appears in developer context. Use `relates_to` only for context that does not claim implementation.
8. For durable technical choices, identify the specification kind/revision and recommend an ADR when the decision affects architecture. Do not treat a prompt, task description, comment, or unpublished draft as an approved decision.
9. Call write tools only when the user explicitly requests recording the proposal. Keep new content in Draft; do not publish specifications or workflows, confirm estimates, change task states, or claim test evidence without the authorized human and required gates. If an existing technical Draft is obsolete, ask the human Tech Lead to withdraw it with `spec_revision_withdraw`; do not publish obsolete content to clear the Draft.
10. Return the verified facts, design, alternatives, task/dependency list, proposed task workflows and trace links, decision-to-code-to-test map, risks, rollout/rollback plan, and blocking questions.

Useful MCP prompt: `ssdd_refine_technical_design`.
