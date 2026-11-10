import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ApplicationError } from "../../src/application/errors.js";
import {
  findExternalPrincipalId,
  grantExternalIdentity,
  revokeExternalIdentityRoles,
} from "../../src/application/external-identities.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { getProjectRoles } from "../../src/application/local-identity.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";

describe("provisioned external identities", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let adminPrincipalId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-external-identity-"));
    const initialized = initializeProject({
      workspace,
      key: "PAY",
      name: "Payments",
      productGoal: "Pagamentos confiáveis",
      timezone: "America/Sao_Paulo",
    });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    const project = database.prepare(
      "SELECT created_by_principal_id FROM projects WHERE project_id = ?",
    ).get(projectId) as { created_by_principal_id: string };
    adminPrincipalId = project.created_by_principal_id;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("grants roles to an issuer-subject identity and audits/replays the command", () => {
    const input = {
      projectId,
      principalId: adminPrincipalId,
      requestId: "grant-alice-1",
      issuer: "https://identity.example/tenant",
      subject: "user-123",
      displayName: "Alice",
      principalType: "human" as const,
      roles: ["developer", "qa"] as const,
      reason: "Equipe de entrega do produto.",
    };
    const first = grantExternalIdentity(database, input);
    const replay = grantExternalIdentity(database, input);

    assert.deepEqual(replay, first);
    assert.equal(findExternalPrincipalId(database, input.issuer, input.subject), first.value.principalId);
    assert.deepEqual(getProjectRoles(database, projectId, first.value.principalId), ["developer", "qa"]);
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'external_identity.roles_granted'").get() as { count: number }).count,
      1,
    );
  });

  it("revokes only selected project roles and requires the local administrator role", () => {
    const grant = grantExternalIdentity(database, {
      projectId,
      principalId: adminPrincipalId,
      requestId: "grant-bob-1",
      issuer: "https://identity.example",
      subject: "user-456",
      displayName: "Bob",
      principalType: "human",
      roles: ["developer", "stakeholder"],
      reason: "Acesso inicial.",
    });
    const revoke = revokeExternalIdentityRoles(database, {
      projectId,
      principalId: adminPrincipalId,
      requestId: "revoke-bob-1",
      issuer: "https://identity.example",
      subject: "user-456",
      roles: ["developer"],
      reason: "Responsabilidade de desenvolvimento encerrada.",
    });

    assert.equal(revoke.value.principalId, grant.value.principalId);
    assert.deepEqual(revoke.value.projectRoles, ["stakeholder"]);
    const revokeFinalRole = revokeExternalIdentityRoles(database, {
      projectId,
      principalId: adminPrincipalId,
      requestId: "revoke-bob-final-role",
      issuer: "https://identity.example",
      subject: "user-456",
      roles: ["stakeholder"],
      reason: "Acesso do projeto encerrado.",
    });
    assert.deepEqual(revokeFinalRole.value.projectRoles, []);
    assert.equal(findExternalPrincipalId(database, "https://identity.example", "user-456"), undefined);
    assert.throws(
      () => grantExternalIdentity(database, {
        projectId,
        principalId: "not-a-project-admin",
        requestId: "grant-outside-1",
        issuer: "https://identity.example",
        subject: "user-789",
        displayName: "Mallory",
        principalType: "human",
        roles: ["stakeholder"],
        reason: "Tentativa sem autorização.",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN",
    );
  });

  it("rejects insecure non-loopback issuers and invalid roles", () => {
    assert.throws(
      () => grantExternalIdentity(database, {
        projectId,
        principalId: adminPrincipalId,
        requestId: "grant-http-issuer",
        issuer: "http://identity.example",
        subject: "user-123",
        displayName: "Alice",
        principalType: "human",
        roles: ["developer"],
        reason: "Teste de política.",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
  });
});
