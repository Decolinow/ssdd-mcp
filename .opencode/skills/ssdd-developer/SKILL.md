---
name: ssdd-developer
description: Implement an SSDD task from its pinned context and acceptance criteria, with regression tests and synchronized documentation.
---

# SSDD Developer

Use this skill when implementing or repairing a task in an SSDD-managed project. Connect with `SSDD_PROFILE=dev` (stdio) or `X-SSDD-Profile: dev` (HTTP); the profile only filters tools, and `task_context_get.profile=dev` separately selects context sections.

## Always

- Pick work with `task_execution_queue_get` (assigned to you by default) and take the first startable task; it is a recommendation, so re-check with `task_start_check`.
- Resolve the item with `work_item_get`, then call `task_briefing_get` (`profile=dev`) first: context, start gates, workflow, open questions and next action in one response.
- Use `task_context_get` only to page a truncated context or to request other sections; follow `nextCursor` or the referenced resource before concluding context is missing.
- Call `task_workflow_get` for tasks and read the published revision and the Draft.
- Read `spec_get` for `SSDD-GLOSS-CORE-01` when a domain term is unclear; the resolver omits glossary entries.
- Treat `implements` links as implementation claims and `relates_to` as context only; use the UUID from `roadmap_id_resolve` when an `SSDD-###` alias collides.
- Check `git status` and existing diffs first and preserve changes that predate the task.
- Keep changes inside the accepted scope and declare expected paths with `task_scope_set` when known.
- Start only on explicit request: `task_start_check`, then `task_start` with current version, reason, new request ID and session reference; keep the returned version and session ID.
- Follow the published workflow in order and update steps with `task_workflow_step_transition` while your session is active and pinned to that revision.
- Pause, resume, complete or cancel with `development_session_transition` and a reason; complete the session when implementation ends.
- Check `work_item_gate_check` and keep evidence, scenario execution, baseline and human certification as separate gates.
- Add regression tests for changed behavior, run the documented checks and report exactly what passed or failed.
- Update docs, status and roadmap in the same change, keeping `SSDD-###` stable and local implementation distinct from workflow acceptance.
- Submit the delivery report (`task_delivery_report_submit`) with real evidence before asking for review.

## Never

- Never move Draft directly to `in_progress` or bypass a start gate; `task_start` is the only path from Ready.
- Never invent dates, time spent, workflow steps, percentages, test evidence or certification.
- Never treat a 100% workflow as QA acceptance.
- Never assign business-value scores yourself; ask the PO.
- Never publish content or force a workflow state; use transition tools only when asked and when the gates allow.

## When blocked

- If `canStart` is false, list the blockers from `task_start_check` and stop.
- If the baseline is missing, stale or ambiguous, state the gap and ask for the smallest clarification.
- If the session pins an older workflow revision or a new one is proposed, stop updating steps and ask the Tech Lead.
- If a paused session belongs to a prior Developer, ask that person to complete or cancel it.
- If a tool returns `isError`, report the code and message and do not retry with changed intent.

Useful MCP prompt: `ssdd_start_task`.
