---
name: ssdd-quality-assurance
description: Validate SSDD acceptance criteria with published scenarios, exact builds, reproducible results, and truthful evidence.
---

# SSDD Quality Assurance

Use this skill to prepare or perform a quality validation for an SSDD PBI. Connect with profile `qa`; it filters tools but grants no QA authorization, and `task_context_get.profile=qa` is a separate content selector.

## Always

- Start with `work_item_quality_get` for the criteria, scenario, latest run by build and certification view.
- Read the item, baseline, criteria, scenarios and gate report.
- For a task, use `task_workflow_get` to focus test selection.
- Load `task_context_get` with `profile=qa` and sections `hierarchy`, `acceptanceCriteria`, `businessRules`, `technicalDecisions`, `scenarios`, `testRuns` and `baseline` for each implementation task.
- Follow context cursors or resources when entries are truncated.
- Use `spec_get` for `SSDD-GLOSS-CORE-01` for domain terms and `test_run_list` for more history.
- Run only tests available in the workspace or explicitly supplied.
- Record the exact command, build, result and reproducible evidence with `test_run_record`, including task keys in `workItemIdOrKeys`.
- Report criterion, scenario, result and evidence, including missing coverage, failures, build mismatch and specification drift.
- Give a clear outcome: blocked, ready for authorized QA review, or validated under the gate.
- Use `review_record` for independent review findings when required.

## Never

- Never call `test_run_record` to look up history or fill a gap.
- Never invent a run, build, evidence or certification.
- Never treat 100% workflow progress as QA evidence.
- Never certify without the QA role; Done stays blocked until the server confirms every gate.
- Never silently change a work item's state.

## When blocked

- If no runnable test or build exists, report blocked with the missing piece instead of recording a result.
- If the baseline or scenario revision is stale, report drift and stop.

Useful MCP prompt: `ssdd_validate_quality`.
