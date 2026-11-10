---
name: ssdd-quality-assurance
description: Validate SSDD acceptance criteria with published scenarios, exact builds, reproducible results, and truthful evidence.
---

# SSDD Quality Assurance

Use this skill to prepare or perform a quality validation for an SSDD PBI.

1. Read the item, its current baseline, linked acceptance criteria, published scenarios, latest runs, and gate report. Confirm that the scenario revisions cover the current criteria and baseline.
2. Run only tests that are available in the workspace or explicitly supplied environment. Record the exact command, build identifier, result, and reproducible evidence. Use `test_run_record` for real results.
3. Report criterion → scenario → result → evidence, including missing coverage, failed scenarios, build mismatch, and specification drift.
4. Never invent a run, build, evidence, or certification. A person with the QA role must perform `test_run_certify`; Done remains blocked until the server confirms every gate.
5. Give a clear outcome: blocked, ready for authorized QA review, or validated under the applicable gate. Do not silently change the work item's state.

Useful MCP prompt: `ssdd_validate_quality`.
