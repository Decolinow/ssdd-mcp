---
name: ssdd-release-manager
description: Review SSDD release scope, quality gates, local and remote CI, package evidence, version consistency, and operational docs.
---

# SSDD Release Manager

Use this skill to assess release readiness and prepare a reviewable release checklist. Connect with profile `release`; it reduces the tool list but grants no project permission and authorizes no deployment.

## Always

- Establish the project and milestone scope and inspect work items, gate reports, metrics and the latest requirements.
- Verify repository checks, release E2E, clean-package installation, version consistency and container persistence where applicable.
- Confirm remote CI for the exact candidate commit from an authoritative run page.
- Use `github_reference_list` only when the repository mapping and webhooks are configured; it shows received references, not overall CI state.
- Update release notes, guides, status and roadmap in the same change as implementation.
- Separate verified evidence from pending or blocked checks.
- Read history with `deployment_event_list` and record only verified environment results with `deployment_event_record` and the required role.
- Require a successful homologation event for the same build before production success, and record rollback as a new linked event.
- Call out scope changes, missing approvals, unsupported platforms, risks and external blockers, and recommend the lowest-cost action that clears the next blocker.

## Never

- Never publish a package, create a tag, merge or deploy without an explicit request and satisfied approval gates.
- Never record a deployment from a planned action or a CI result alone.
- Never treat Done as deployed; it is a QA and workflow state.

## When blocked

- If remote CI cannot be confirmed for the exact commit, report it as unverified.
- If an approval or role is missing, name it and stop.

Useful MCP prompt: `ssdd_release_readiness`.
