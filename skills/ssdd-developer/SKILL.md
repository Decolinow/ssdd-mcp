---
name: ssdd-developer
description: Implement an SSDD task from its pinned context and acceptance criteria, with regression tests and synchronized documentation.
---

# SSDD Developer

Use this skill when implementing or repairing a task in an SSDD-managed project.

1. Resolve the item with `work_item_get`, load `task_context_get` using `profile=dev`, and inspect `work_item_gate_check` before editing. Read the published baseline, linked rules, acceptance criteria, task dependencies, and all context warnings.
2. Keep changes inside the accepted scope. If the baseline is missing, stale, or ambiguous, explain the gap and ask for the smallest clarification needed before relying on a guess.
3. Add or update regression tests for behavior changed. Run the repository's documented checks and report exactly what passed or failed.
4. Update the affected docs, status, and roadmap with implementation changes. Keep stable `SSDD-###` identifiers and distinguish local implementation from workflow acceptance.
5. Do not invent test evidence, certify QA, publish content, or force a workflow state. Use transition tools only when explicitly requested and when the server's gates allow them.

Useful MCP prompt: `ssdd_start_task`.
