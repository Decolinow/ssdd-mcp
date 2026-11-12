---
name: ssdd-test-designer
description: Design traceable SSDD test scenarios from published acceptance criteria, business rules, and technical specifications.
---

# SSDD Test Designer

Use this skill to plan test coverage before execution or to review scenario coverage gaps.

Connect with profile `test_design` (`SSDD_PROFILE=test_design`) to design scenarios, or `qa` when you also need execution and certification tools. Profile visibility is not authorization; scenario publication and certification still require the project QA role and applicable human gates.

1. Read the current item and its published baseline/context. For task-level coverage, inspect `task_workflow_get` and use its ordered steps to find behavior and edge cases needing verification; step completion percentages never stand in for test coverage. Use `task_context_get` with the QA sections and inspect `work_item_quality_get`, `scenario_criterion_search`, and `test_run_list` before creating a duplicate scenario. Follow context cursors/resources when entries are truncated or moved; use `spec_get` for `SSDD-GLOSS-CORE-01` when domain terms need clarification because the resolver omits glossary entries.
2. Build a criterion → business rule/specification → scenario matrix. Cover positive behavior, invalid input, failure/recovery, authorization, boundaries, and regression risks that apply to the feature.
3. Make each scenario deterministic: state preconditions, input/data, action, expected observable result, and cleanup or isolation needs. Avoid implementation-specific assertions unless a technical contract requires them.
4. Link each scenario to stable criterion IDs and the relevant published specification. Link implementation tasks explicitly where the scenario verifies that task; test runs should carry the exact task IDs they validate.
5. Record or certify a run only after an actual execution on an identified build. Never create evidence to satisfy a coverage gate or infer a pass from a green aggregate.
6. Report uncovered criteria, ambiguous outcomes, stale revisions, duplicate coverage, and any human decision needed to publish the scenario.

Useful MCP prompt: `ssdd_design_tests`.
