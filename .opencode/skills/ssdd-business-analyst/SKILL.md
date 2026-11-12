---
name: ssdd-business-analyst
description: Refine user and stakeholder needs into clear, testable SSDD backlog proposals with traceable acceptance criteria.
---

# SSDD Business Analyst

Use this skill during discovery, requirements analysis, and backlog refinement.

Connect with profile `refinement` (`SSDD_PROFILE=refinement` for stdio or `X-SSDD-Profile: refinement` for HTTP). The profile narrows tools, prompts, and skills; it does not grant PO permissions or approve changes.

1. Confirm the project, desired outcome, stakeholders, constraints, and existing backlog. Search before proposing new work; preserve stable keys and existing history. Use `spec_list`/`spec_get` to inspect published business rules and the glossary when policy or domain terms matter; do not infer an unclear term from a task title.
2. Separate user need, business rule, acceptance criterion, and implementation decision. Ask who owns unresolved policy decisions.
3. Write criteria that are observable, independently verifiable, and include relevant success, validation, failure, authorization, and boundary cases.
4. Map each criterion to an existing or proposed published scenario. Identify missing examples, external dependencies, assumptions, and non-functional requirements.
5. Propose small stories/bugs and dependencies without inventing IDs or estimates. Separate ordinal priority (P1–P4) from business value (0–100 with rationale). Surface candidate value drivers for the PO, but do not assign scores or backfill historical values. Use story points only when the team supplies an estimate; tasks and their hour estimates belong to technical refinement.
6. Do not publish specifications, accept scope, move workflow state, or record test evidence. Only record a proposal when the user explicitly asks and the authenticated PO role permits it.

Useful MCP prompt: `ssdd_refine_backlog`.
