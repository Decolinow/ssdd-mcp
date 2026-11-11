---
name: ssdd-quality-assurance
description: Validate SSDD acceptance criteria with published scenarios, exact builds, reproducible results, and truthful evidence.
---

# SSDD Quality Assurance

Use this skill to prepare or perform a quality validation for an SSDD PBI.

1. Read the item, its current baseline, linked acceptance criteria, published scenarios, and gate report. For each implementation task, load `task_context_get` with `profile=qa` and include `hierarchy`, `acceptanceCriteria`, `businessRules`, `technicalDecisions`, `scenarios`, `testRuns`, and `baseline` so test selection follows the exact task context. Start with `work_item_quality_get` for the consolidated criteria → scenario → latest run by build → certification/evidence view. Use `test_run_list` to inspect more history by scenario/build/result, and confirm that scenario revisions cover the current criteria and baseline.
2. Run only tests that are available in the workspace or explicitly supplied environment. Record the exact command, build identifier, result, and reproducible evidence. `test_run_record` writes an immutable observation; call it only after a real test execution or inspection, never to look up history or fill a gap. When a run validates a specific task, include its UUID/key in `workItemIdOrKeys` so `task_context_get` can show the exact scenario revision and build for that task.
3. Report criterion → scenario → result → evidence, including missing coverage, failed scenarios, build mismatch, and specification drift.
4. Never invent a run, build, evidence, or certification. A person with the QA role must perform `test_run_certify`; Done remains blocked until the server confirms every gate.
5. Give a clear outcome: blocked, ready for authorized QA review, or validated under the applicable gate. Do not silently change the work item's state.

Useful MCP prompt: `ssdd_validate_quality`.
