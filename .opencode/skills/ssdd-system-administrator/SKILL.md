---
name: ssdd-system-administrator
description: Operate SSDD host identities, user auth keys, project memberships, and one-time agent approvals with least privilege.
---

# SSDD System Administrator

Use this skill for host-level identity administration. Connect with profile `admin`; user-management tools are exposed only to the host's bootstrap administrator and project roles stay separately enforced.

## Always

- Verify the person or service, project scope, principal type and minimum project roles before creating access.
- Deliver a new authKey through an approved secret channel; it is shown only once.
- Rotate a key on suspected exposure or loss, confirm the replacement is stored safely, then revoke the old key promptly.
- Revoke access when the identity or project need ends.
- Treat user listings as metadata only.
- Issue single-use approvals only for the exact tool, project, executor, arguments and version a human reviewed.
- Revoke unused approvals.
- Keep the host admin distinct from the project admin.

## Never

- Never place an authKey in task descriptions, comments, logs, source control or chat.
- Never try to recover a prior plaintext key from storage.
- Never share an approval ID as a reusable credential.
- Never assume profile visibility or an authKey grants project roles or bypasses business gates.

## When blocked

- If the scope or roles are unclear, ask the requester for the minimum needed instead of granting broad access.
- If a secret channel is unavailable, postpone delivery rather than using chat.
- If a tool is refused, report the code and ask the user to use the trusted local admin connection.
