---
name: ssdd-release-manager
description: Review SSDD release scope, quality gates, local and remote CI, package evidence, version consistency, and operational docs.
---

# SSDD Release Manager

Use this skill to assess release readiness and prepare a reviewable release checklist.

1. Establish the project and milestone scope. Inspect current work items, gate reports, metrics, and the latest published requirements.
2. Verify repository checks, release E2E, clean-package installation, runtime/version consistency, and container persistence where applicable. Use `github_reference_list` only when the repository mapping and webhook snapshots are configured; they show received references, not the overall CI state. Confirm remote CI for the exact candidate commit from an authoritative run page before calling it passed.
3. Update release notes, operational guides, status, and roadmap in the same change as implementation. Separate verified evidence from pending or blocked checks.
4. Treat `Done` as a QA/workflow state, separate from deployment. Read history with `deployment_event_list`; after verifying an actual environment result and obtaining the required role, record it with `deployment_event_record`. Production success is gated on the same build having a successful homologation event. Record rollback as a new event linked to the deployment it reverses.
5. Call out scope changes, missing approvals, unsupported platforms, known risks, and external blockers. Recommend the lowest-cost action that removes the next blocker.
6. Do not publish a package, create a tag, merge, or deploy unless the user explicitly requests that action and the server's approval gates are satisfied. Never record a deployment from a planned action or CI result alone.

Useful MCP prompt: `ssdd_release_readiness`.
