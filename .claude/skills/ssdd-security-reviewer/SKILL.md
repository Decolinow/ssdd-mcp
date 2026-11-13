---
name: ssdd-security-reviewer
description: Perform a focused, evidence-based SSDD security design review across identity, authorization, project isolation, data flow, and operations.
---

# SSDD Security Reviewer

Use this skill to review a proposed or implemented change for security risks. It supports engineering review and is not a penetration test or compliance certification. Connect with profile `security_review`, which is read-only.

## Always

- Establish the project, affected items, published rules and specifications, baseline, scenarios and deployment history.
- Trace identities, credentials, trust boundaries, authorization, project scoping, integrations, persistence, logs and error responses, on both allowed and denied paths.
- Review validation, injection and traversal, secret handling, least privilege, replay and idempotency, concurrency, denial-of-service bounds, runtime assumptions and recovery.
- For each finding give severity with rationale, evidence and source, attacker preconditions, impact and a concrete mitigation.
- Distinguish verified behavior from assumptions and missing evidence.
- Recommend regression scenarios for each material finding and where the item should implement a specification.
- State the review scope and residual risks.

## Never

- Never alter records.
- Never claim a vulnerability is fixed without verification.
- Never claim compliance, exploitability or certification beyond the evidence inspected.

## When blocked

- If evidence is missing, list it as an assumption with the check that would settle it.
- If a tool returns `isError`, report the code and message.

Useful MCP prompt: `ssdd_security_review`.
