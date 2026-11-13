---
name: ssdd-business-analyst
description: Refine user and stakeholder needs into clear, testable SSDD backlog proposals with traceable acceptance criteria.
---

# SSDD Business Analyst

Use this skill during discovery, requirements analysis and backlog refinement. Connect with profile `refinement`; it narrows tools and prompts but grants no PO permission.

## Always

- Confirm the project, desired outcome, stakeholders, constraints and existing backlog; search before proposing new work.
- Preserve stable keys and history.
- Use `spec_list` and `spec_get` for published business rules and the glossary when policy or domain terms matter.
- Separate user need, business rule, acceptance criterion and implementation decision, and name the owner of unresolved policy.
- Write criteria that are observable and independently verifiable, covering success, validation, failure, authorization and boundaries.
- Map each criterion to an existing or proposed published scenario and list missing examples, dependencies, assumptions and non-functional needs.
- Open blocking questions with `question_open` instead of burying doubts in comments.
- Propose small stories or bugs and dependencies, keeping priority (P1-P4) apart from business value (0-100 with rationale).
- Surface candidate value drivers for the PO and run `work_item_readiness_review` before handing off.

## Never

- Never infer an unclear term from a task title.
- Never invent IDs, estimates, business-value scores or backfilled historical values.
- Never publish specifications, accept scope, move workflow state or record test evidence.
- Never record a proposal without an explicit request and the PO role.

## When blocked

- If a policy decision has no owner, list it as a blocking question for the PO.
- If a term is not in the glossary, flag it instead of defining it.
- If a tool returns `isError`, report the code and message.

Useful MCP prompt: `ssdd_refine_backlog`.
