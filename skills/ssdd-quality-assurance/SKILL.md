---
name: ssdd-quality-assurance
description: Validate SSDD acceptance criteria with published scenarios, exact builds, reproducible results, and truthful evidence.
---

# SSDD Quality Assurance

Use this skill to prepare or perform a quality validation for an SSDD PBI.

Configure the MCP connection with profile `qa` (`SSDD_PROFILE=qa` for stdio or `X-SSDD-Profile: qa` for HTTP). The profile filters the available tools but does not grant QA authorization; a principal still needs the project role and human gates required by each operation. `task_context_get.profile=qa` is a separate content selector.

1. Read the item, its current baseline, linked acceptance criteria, published scenarios, and gate report. For a task, use `task_workflow_get` to see the exact workflow revision and completed steps; use those steps to focus test selection, but never treat 100% workflow progress as QA evidence or certification. For each implementation task, load `task_context_get` with `profile=qa` and include `hierarchy`, `acceptanceCriteria`, `businessRules`, `technicalDecisions`, `scenarios`, `testRuns`, and `baseline` so test selection follows the exact task context. Follow context cursors/resources when entries are truncated or moved. Use `spec_get` for `SSDD-GLOSS-CORE-01` when domain terms need clarification because the resolver omits glossary entries. Start with `work_item_quality_get` for the consolidated criteria → scenario → latest run by build → certification/evidence view. Use `test_run_list` to inspect more history by scenario/build/result, and confirm that scenario revisions cover the current criteria and baseline.
2. Run only tests that are available in the workspace or explicitly supplied environment. Record the exact command, build identifier, result, and reproducible evidence. `test_run_record` writes an immutable observation; call it only after a real test execution or inspection, never to look up history or fill a gap. When a run validates a specific task, include its UUID/key in `workItemIdOrKeys` so `task_context_get` can show the exact scenario revision and build for that task.
3. Report criterion → scenario → result → evidence, including missing coverage, failed scenarios, build mismatch, and specification drift.
4. Never invent a run, build, evidence, or certification. A person with the QA role must perform `test_run_certify`; Done remains blocked until the server confirms every gate.
5. Give a clear outcome: blocked, ready for authorized QA review, or validated under the applicable gate. Do not silently change the work item's state.

Useful MCP prompt: `ssdd_validate_quality`.
