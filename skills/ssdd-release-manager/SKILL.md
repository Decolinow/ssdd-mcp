---
name: ssdd-release-manager
description: Review SSDD release scope, quality gates, local and remote CI, package evidence, version consistency, and operational docs.
---

# SSDD Release Manager

Use this skill to assess release readiness and prepare a reviewable release checklist.

1. Establish the project and milestone scope. Inspect current work items, gate reports, metrics, and the latest published requirements.
2. Verify repository checks, release E2E, clean-package installation, runtime/version consistency, container persistence where applicable, and remote CI for the exact candidate commit.
3. Update release notes, operational guides, status, and roadmap in the same change as implementation. Separate verified evidence from pending or blocked checks.
4. Call out scope changes, missing approvals, unsupported platforms, known risks, and external blockers. Recommend the lowest-cost action that removes the next blocker.
5. Do not publish a package, create a tag, merge, or deploy unless the user explicitly requests that action and the server's approval gates are satisfied.

Useful MCP prompt: `ssdd_release_readiness`.
