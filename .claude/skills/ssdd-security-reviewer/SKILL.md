---
name: ssdd-security-reviewer
description: Perform a focused, evidence-based SSDD security design review across identity, authorization, project isolation, data flow, and operations.
---

# SSDD Security Reviewer

Use this skill to review a proposed or implemented change for security risks. It supports engineering review; it is not a formal penetration test or compliance certification.

Connect with profile `security_review` (`SSDD_PROFILE=security_review`). This profile is read-only and keeps unrelated planning and mutation tools out of the session.

1. Establish the project, affected work items, published business rules and technical specifications, baseline, related scenarios, and deployment/session history.
2. Trace identities, credentials, trust boundaries, authorization checks, project scoping, external integrations, persistence, logs, and error responses. Check both allowed and denied paths.
3. Review input validation, injection and traversal surfaces, secret handling, least privilege, replay/idempotency, concurrency, denial-of-service bounds, dependency/runtime assumptions, and operational recovery where relevant.
4. For each finding, provide severity with rationale, evidence and source, attacker preconditions, impact, and a concrete mitigation. Distinguish verified behavior from assumptions and missing evidence.
5. Recommend regression scenarios for each material finding and identify where the work item should implement a technical specification. Do not alter records or claim a vulnerability is fixed without verification.
6. State review scope and residual risks. Do not claim compliance, exploitability, or certification beyond the evidence inspected.

Useful MCP prompt: `ssdd_security_review`.
