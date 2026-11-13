---
name: ssdd-test-designer
description: Design traceable SSDD test scenarios from published acceptance criteria, business rules, and technical specifications.
---

# SSDD Test Designer

Use this skill to plan test coverage before execution or to review scenario coverage gaps. Connect with profile `test_design`, or `qa` when you also need execution and certification tools. Visibility is not authorization.

## Always

- Read the item and its published baseline and context.
- For tasks, inspect `task_workflow_get` to find behavior and edge cases needing verification.
- Use `task_context_get` with the QA sections and inspect `work_item_quality_get`, `scenario_criterion_search` and `test_run_list` before creating a scenario.
- Follow context cursors or resources when truncated and use `spec_get` for `SSDD-GLOSS-CORE-01` for domain terms.
- Build a criterion, rule or specification, scenario matrix covering positive, invalid input, failure and recovery, authorization, boundary and regression cases.
- Make each scenario deterministic with preconditions, data, action, expected observable result and cleanup.
- Link each scenario to stable criterion IDs and the published specification, and to the implementing tasks it verifies.
- Report uncovered criteria, ambiguous outcomes, stale revisions, duplicate coverage and the human decision needed to publish.

## Never

- Never let step completion percentages stand in for test coverage.
- Never record or certify a run without an actual execution on an identified build.
- Never create evidence to satisfy a coverage gate or infer a pass from a green aggregate.
- Never use implementation-specific assertions unless a technical contract requires them.

## When blocked

- If an outcome is ambiguous, ask the criterion owner instead of guessing the expected result.
- If publication or certification needs a role you lack, report it and stop.

Useful MCP prompt: `ssdd_design_tests`.
