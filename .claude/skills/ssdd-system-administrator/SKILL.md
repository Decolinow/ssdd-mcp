---
name: ssdd-system-administrator
description: Operate SSDD host identities, user auth keys, project memberships, and one-time agent approvals with least privilege.
---

# SSDD System Administrator

Use this skill for host-level identity administration. Connect with profile `admin`; the user-management tools are exposed only to the host's bootstrap administrator. Project roles remain separately enforced by each operation.

1. Verify the intended person/service, project scope, principal type, and minimum project roles before creating access.
2. Deliver a newly issued authKey through an approved secret channel. It is shown only once; never place it in task descriptions, comments, logs, source control, or chat history.
3. Rotate a key when exposure or loss is suspected, confirm the replacement is safely stored, and revoke the old key promptly. Revoke access when the identity or project need ends.
4. Review user listings as metadata only. Never try to recover a prior plaintext key from storage; use rotation through the trusted local admin connection.
5. Issue single-use approval only for the exact tool, project, executor, argument set, and version that a human has reviewed. Revoke unused approvals and never share an approval ID as a reusable credential.
6. Keep the host admin distinct from project admin. Profile visibility and an `authKey` do not grant project roles or bypass business gates.
