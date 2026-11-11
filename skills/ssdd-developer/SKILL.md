---
name: ssdd-developer
description: Implement an SSDD task from its pinned context and acceptance criteria, with regression tests and synchronized documentation.
---

# SSDD Developer

Use this skill when implementing or repairing a task in an SSDD-managed project.

1. Resolve the item with `work_item_get`, load `task_context_get` using `profile=dev` and `include=[hierarchy, acceptanceCriteria, businessRules, technicalDecisions, scenarios, testRuns, baseline]`, and inspect `work_item_gate_check` before editing. Read the published baseline, acceptance criteria, business rules, technical specifications, covered scenarios, latest runs by build, task dependencies, and all context warnings. Treat `implements` as an implementation claim and `relates_to` as context only. Check `git status` and existing diffs first; preserve changes that predate this task.
2. Keep changes inside the accepted scope. If the baseline is missing, stale, or ambiguous, explain the gap and ask for the smallest clarification needed before relying on a guess.
3. When the person explicitly asks to start, verify that the authenticated Developer is the task assignee. If needed, transition the task to `in_progress` with its current version and a reason, then call `development_session_start`. Keep the returned domain `sessionId`; it is independent of a transport or chat session. Start captures the technical specification and scenario revisions used by that development session.
4. Use `development_session_transition` with a reason when pausing, resuming, completing, or cancelling the effort. Session timestamps come from the server in UTC and active duration excludes paused time. Complete the development session when implementation ends, even if QA/review keeps the work item open. Do not invent dates or time spent.
5. Add or update regression tests for behavior changed. Run the repository's documented checks and report exactly what passed or failed.
6. Update the affected docs, status, and roadmap with implementation changes. Keep stable `SSDD-###` identifiers and distinguish local implementation from workflow acceptance.
7. Do not invent test evidence, certify QA, publish content, or force a workflow state. Use transition tools only when explicitly requested and when the server's gates allow them.

Useful MCP prompt: `ssdd_start_task`.
