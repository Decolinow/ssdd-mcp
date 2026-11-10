import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { initializeProject } from "../../src/application/initialize-project.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";

describe("ssdd-mcp access", () => {
  let workspace: string;

  afterEach(() => {
    if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
  });

  it("grants and revokes project roles for a provisioned OIDC identity", () => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-cli-access-"));
    const initialized = initializeProject({
      workspace,
      key: "PAY",
      name: "Payments",
      productGoal: "Pagamentos confiáveis",
      timezone: "America/Sao_Paulo",
    });

    const grant = runAccess(workspace, "grant", [
      "--issuer", "https://identity.example",
      "--subject", "alice-123",
      "--display-name", "Alice",
      "--type", "human",
      "--roles", "developer,qa",
      "--reason", "Entrada no time de pagamentos.",
      "--request-id", "access-grant-alice",
    ]);
    assert.equal(grant.status, 0, grant.stderr);
    const granted = JSON.parse(grant.stdout) as { value: { principalId: string; projectRoles: string[] } };
    assert.deepEqual(granted.value.projectRoles, ["developer", "qa"]);

    const revoke = runAccess(workspace, "revoke", [
      "--issuer", "https://identity.example",
      "--subject", "alice-123",
      "--roles", "qa",
      "--reason", "Acesso QA encerrado.",
      "--request-id", "access-revoke-alice",
    ]);
    assert.equal(revoke.status, 0, revoke.stderr);
    const revoked = JSON.parse(revoke.stdout) as { value: { principalId: string; projectRoles: string[] } };
    assert.equal(revoked.value.principalId, granted.value.principalId);
    assert.deepEqual(revoked.value.projectRoles, ["developer"]);

    const database = openSqliteDatabase(initialized.databasePath);
    const events = database.prepare(
      "SELECT event_type FROM audit_events WHERE event_type LIKE 'external_identity.%' ORDER BY occurred_at, event_type",
    ).all() as Array<{ event_type: string }>;
    database.close();
    assert.deepEqual(events.map((event) => event.event_type), [
      "external_identity.roles_granted",
      "external_identity.roles_revoked",
    ]);
  });

  it("requires issuer and resource URL together before starting remote access", () => {
    const result = spawnSync(process.execPath, [cliPath, "serve", "--oidc-issuer", "https://identity.example"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be provided together/u);

    const originOnly = spawnSync(process.execPath, [cliPath, "serve", "--allowed-origin", "client.example.com"], { encoding: "utf8" });
    assert.equal(originOnly.status, 1);
    assert.match(originOnly.stderr, /Additional allowed origins require OIDC mode/u);
  });

  it("exits unsuccessfully when OIDC discovery cannot be reached", async () => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-cli-oidc-startup-"));
    initializeProject({
      workspace,
      key: "PAY",
      name: "Payments",
      productGoal: "Pagamentos confiáveis",
      timezone: "America/Sao_Paulo",
    });
    const unavailablePort = await reserveUnusedPort();
    const result = spawnSync(process.execPath, [
      cliPath,
      "serve",
      "--workspace", workspace,
      "--oidc-issuer", `http://127.0.0.1:${unavailablePort}`,
      "--resource-url", "https://mcp.example.com/mcp",
    ], { encoding: "utf8", timeout: 5_000 });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Could not reach the configured OIDC discovery endpoint/u);
  });
});

const cliPath = fileURLToPath(new URL("../../src/cli.js", import.meta.url));

function runAccess(workspace: string, action: "grant" | "revoke", args: readonly string[]) {
  return spawnSync(process.execPath, [cliPath, "access", action, "--workspace", workspace, "--project", "PAY", ...args], { encoding: "utf8" });
}

function reserveUnusedPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectPort(new Error("Could not reserve an unused port for the CLI startup test."));
        return;
      }
      server.close((error) => {
        if (error !== undefined) rejectPort(error);
        else resolvePort(address.port);
      });
    });
  });
}
