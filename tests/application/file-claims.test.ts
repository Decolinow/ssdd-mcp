import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ApplicationError } from "../../src/application/errors.js";
import { acquireFileClaims, listFileClaims, normalizeClaimPath, pathsOverlap, releaseFileClaims, renewFileClaims } from "../../src/application/file-claims.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createManagedUser, ensureBootstrapAdministrator } from "../../src/application/user-management.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("file claims for parallel agents (SSDD-929)", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let adminId: string;
  let alice: string;
  let bob: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-file-claims-"));
    const initialized = initializeProject({ workspace, key: "FC", name: "Claims", productGoal: "Coordenar", timezone: "UTC" });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    adminId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?").get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
    ensureBootstrapAdministrator(database, adminId);
    const user = (name: string, roles: ("developer" | "tech_lead")[]) => createManagedUser(database, {
      actorPrincipalId: adminId, requestId: `fc-${name}`, displayName: name, principalType: "human",
      projects: [{ projectId, roles }], reason: "Acesso de teste",
    }).principalId;
    alice = user("alice", ["developer"]);
    bob = user("bob", ["developer"]);
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("normalizes paths and detects file/directory overlap", () => {
    const backslash = String.fromCharCode(92);
    assert.equal(normalizeClaimPath(`.${backslash}src${backslash}mcp${backslash}`), "src/mcp");
    for (const bad of ["../x", "/abs", "C:/x", "a/../b", "", "a//b"]) assert.throws(() => normalizeClaimPath(bad), ApplicationError, bad);
    assert.ok(pathsOverlap({ path: "src", kind: "directory" }, { path: "src/a.ts", kind: "file" }));
    assert.ok(pathsOverlap({ path: "src/a.ts", kind: "file" }, { path: "src", kind: "directory" }));
    assert.ok(!pathsOverlap({ path: "src", kind: "file" }, { path: "src/a.ts", kind: "file" }));
    assert.ok(!pathsOverlap({ path: "src", kind: "directory" }, { path: "srcs/a.ts", kind: "file" }));
  });

  it("blocks overlap from another principal with an explicit conflict, atomically, and is idempotent", () => {
    const first = acquireFileClaims(database, { projectId, principalId: alice, requestId: "a1", paths: [{ path: "src/mcp", kind: "directory" }], branch: "feat/a", worktree: "../wt-a" });
    assert.equal(first.value.claims[0]?.status, "active");
    assert.deepEqual(acquireFileClaims(database, { projectId, principalId: alice, requestId: "a1", paths: [{ path: "src/mcp", kind: "directory" }], branch: "feat/a", worktree: "../wt-a" }).value, first.value);
    try {
      acquireFileClaims(database, { projectId, principalId: bob, requestId: "b1", paths: [{ path: "docs/x.md", kind: "file" }, { path: "src/mcp/server.ts", kind: "file" }] });
      assert.fail("expected conflict");
    } catch (error) {
      assert.ok(error instanceof ApplicationError && error.code === "CLAIM_CONFLICT");
      const conflicts = (error.details as { conflicts: { ownerName: string; branch: string }[] }).conflicts;
      assert.equal(conflicts[0]?.ownerName, "alice");
      assert.equal(conflicts[0]?.branch, "feat/a");
    }
    assert.equal(listFileClaims(database, { projectId, principalId: bob }).claims.length, 1, "the non-conflicting path of the failed call was not claimed");
    const own = acquireFileClaims(database, { projectId, principalId: alice, requestId: "a2", paths: [{ path: "src/mcp", kind: "directory" }] });
    assert.equal(own.value.claims[0]?.claimId, first.value.claims[0]?.claimId, "re-acquiring the same path renews instead of duplicating");
  });

  it("expired and released claims stop blocking, renewal is owner-only, and arbitration needs a reason", () => {
    const claim = acquireFileClaims(database, { projectId, principalId: alice, requestId: "a1", paths: [{ path: "src/a.ts", kind: "file" }], leaseSeconds: 60 }).value.claims[0]!;
    database.prepare("UPDATE file_claims SET lease_expires_at = ? WHERE claim_id = ?").run(new Date(Date.now() - 1_000).toISOString(), claim.claimId);
    assert.equal(listFileClaims(database, { projectId, principalId: bob }).claims.length, 0);
    assert.equal(listFileClaims(database, { projectId, principalId: bob, includeInactive: true }).claims[0]?.status, "expired");
    const taken = acquireFileClaims(database, { projectId, principalId: bob, requestId: "b1", paths: [{ path: "src/a.ts", kind: "file" }] }).value.claims[0]!;
    assert.throws(() => renewFileClaims(database, { projectId, principalId: alice, requestId: "a-renew", claimIds: [claim.claimId] }), (e: unknown) => e instanceof ApplicationError && e.code === "CLAIM_CONFLICT");
    assert.throws(() => renewFileClaims(database, { projectId, principalId: alice, requestId: "a-renew2", claimIds: [taken.claimId] }), (e: unknown) => e instanceof ApplicationError && e.code === "FORBIDDEN");
    const renewed = renewFileClaims(database, { projectId, principalId: bob, requestId: "b-renew", claimIds: [taken.claimId], leaseSeconds: 3_600 });
    assert.ok(renewed.value.claims[0]!.leaseExpiresAt > taken.leaseExpiresAt);
    assert.throws(() => releaseFileClaims(database, { projectId, principalId: alice, requestId: "a-rel", claimIds: [taken.claimId] }), (e: unknown) => e instanceof ApplicationError && e.code === "FORBIDDEN");
    assert.throws(() => releaseFileClaims(database, { projectId, principalId: adminId, requestId: "adm-rel", claimIds: [taken.claimId], reason: "curto" }), (e: unknown) => e instanceof ApplicationError && e.code === "VALIDATION_FAILED");
    const released = releaseFileClaims(database, { projectId, principalId: adminId, requestId: "adm-rel2", claimIds: [taken.claimId], reason: "Agente travado; arbitragem do tech lead." });
    assert.equal(released.value.claims[0]?.status, "released");
    assert.ok(released.auditEventIds.length > 0);
    assert.throws(() => renewFileClaims(database, { projectId, principalId: bob, requestId: "b-renew2", claimIds: [taken.claimId] }), (e: unknown) => e instanceof ApplicationError && e.code === "INVALID_TRANSITION");
    assert.equal(listFileClaims(database, { projectId, principalId: bob, pathPrefix: "src" }).claims.length, 0);
  });
});
