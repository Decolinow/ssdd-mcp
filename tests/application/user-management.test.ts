import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { initializeProject } from "../../src/application/initialize-project.js";
import {
  createManagedUser,
  ensureBootstrapAdministrator,
  listManagedUsers,
  resolvePrincipalFromAuthKey,
  revokeManagedUserAuthKeys,
  rotateManagedUserAuthKey,
} from "../../src/application/user-management.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";

describe("host user management and auth keys", () => {
  const workspaces: string[] = [];
  afterEach(() => {
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  it("creates one bootstrap administrator, stores only key hashes and returns generated keys once", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-user-management-"));
    workspaces.push(workspace);
    const initialized = initializeProject({
      workspace, key: "PAY", name: "Payments", productGoal: "Pagamentos", timezone: "UTC",
    });
    const database = openSqliteDatabase(initialized.databasePath);
    try {
      const adminId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
        .get(initialized.project.id) as { created_by_principal_id: string }).created_by_principal_id;
      const bootstrap = ensureBootstrapAdministrator(database, adminId);
      assert.equal(bootstrap.principalId, adminId);
      assert.match(bootstrap.authKey ?? "", /^ssdd_[A-Za-z0-9_-]{43}$/u);
      assert.equal(ensureBootstrapAdministrator(database, adminId).authKey, null);
      assert.equal(resolvePrincipalFromAuthKey(database, bootstrap.authKey!), adminId);

      const created = createManagedUser(database, {
        actorPrincipalId: adminId,
        requestId: "create-dev-user",
        displayName: "Developer One",
        principalType: "human",
        projects: [{ projectId: initialized.project.id, roles: ["developer"] }],
        reason: "Acesso ao time de pagamentos",
      });
      assert.equal(created.authKeyIssued, true);
      assert.equal(created.replayed, false);
      assert.match(created.authKey ?? "", /^ssdd_[A-Za-z0-9_-]{43}$/u);
      assert.equal(resolvePrincipalFromAuthKey(database, created.authKey!), created.principalId);

      const replayedCreate = createManagedUser(database, {
        actorPrincipalId: adminId,
        requestId: "create-dev-user",
        displayName: "Developer One",
        principalType: "human",
        projects: [{ projectId: initialized.project.id, roles: ["developer"] }],
        reason: "Acesso ao time de pagamentos",
      });
      assert.equal(replayedCreate.replayed, true);
      assert.equal(replayedCreate.authKey, null);
      assert.equal(replayedCreate.principalId, created.principalId);

      const eventJson = database.prepare("SELECT group_concat(response_json || payload_hash) AS data FROM principal_admin_events")
        .get() as { data: string };
      const storedKeyHash = database.prepare("SELECT key_hash FROM principal_api_keys WHERE principal_id = ?")
        .get(created.principalId) as { key_hash: string };
      assert.equal(eventJson.data.includes(created.authKey!), false);
      assert.notEqual(storedKeyHash.key_hash, created.authKey);
      assert.deepEqual(listManagedUsers(database, adminId).find((user) => user.principalId === created.principalId)?.projects,
        [{ projectId: initialized.project.id, roles: ["developer"] }]);

      const rotated = rotateManagedUserAuthKey(database, {
        actorPrincipalId: adminId,
        targetPrincipalId: created.principalId,
        requestId: "rotate-dev-user",
        reason: "Rotação trimestral",
      });
      assert.equal(resolvePrincipalFromAuthKey(database, created.authKey!), undefined);
      assert.equal(resolvePrincipalFromAuthKey(database, rotated.authKey!), created.principalId);
      assert.equal(rotateManagedUserAuthKey(database, {
        actorPrincipalId: adminId,
        targetPrincipalId: created.principalId,
        requestId: "rotate-dev-user",
        reason: "Rotação trimestral",
      }).authKey, null);

      const revoked = revokeManagedUserAuthKeys(database, {
        actorPrincipalId: adminId,
        targetPrincipalId: created.principalId,
        requestId: "revoke-dev-user",
        reason: "Encerramento de acesso",
      });
      assert.equal(revoked.revokedCount, 1);
      assert.equal(resolvePrincipalFromAuthKey(database, rotated.authKey!), undefined);
      assert.equal(revokeManagedUserAuthKeys(database, {
        actorPrincipalId: adminId,
        targetPrincipalId: created.principalId,
        requestId: "revoke-dev-user",
        reason: "Encerramento de acesso",
      }).replayed, true);
    } finally {
      database.close();
    }
  });
});
