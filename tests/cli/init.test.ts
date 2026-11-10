import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { initializeProject } from "../../src/application/initialize-project.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

interface InitOutput {
  readonly created: boolean;
  readonly project: {
    readonly id: string;
    readonly key: string;
    readonly name: string;
    readonly productGoal: string;
    readonly timezone: string;
    readonly version: number;
    readonly createdAt: string;
  };
  readonly databasePath: string;
}

describe("ssdd-mcp init", () => {
  let workspace: string;

  afterEach(() => {
    if (workspace !== undefined) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("creates a project and returns the same project on repeated initialization", () => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-cli-"));
    const first = runInit(workspace);
    const second = runInit(workspace);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);

    const firstResult = JSON.parse(first.stdout) as InitOutput;
    const secondResult = JSON.parse(second.stdout) as InitOutput;
    assert.equal(firstResult.created, true);
    assert.equal(secondResult.created, false);
    assert.equal(secondResult.project.id, firstResult.project.id);
    assert.equal(firstResult.project.key, "PAY");
    assert.equal(firstResult.project.timezone, "America/Sao_Paulo");
    assert.equal(firstResult.project.version, 1);
  });

  it("rejects a conflicting initialization without overwriting the project", () => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-cli-"));
    const first = runInit(workspace);
    const conflict = spawnSync(
      process.execPath,
      [
        cliPath,
        "init",
        "--workspace",
        workspace,
        "--key",
        "PAY",
        "--name",
        "Payments",
        "--goal",
        "A changed product goal",
        "--timezone",
        "America/Sao_Paulo",
      ],
      { encoding: "utf8" },
    );

    assert.equal(first.status, 0, first.stderr);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /already exists with different configuration/);

    const afterConflict = runInit(workspace);
    const project = JSON.parse(afterConflict.stdout) as InitOutput;
    assert.equal(project.project.productGoal, "Pagamentos confiáveis");
  });

  it("rejects an invalid timezone before creating the workspace database", () => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-cli-"));
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "init",
        "--workspace",
        workspace,
        "--key",
        "PAY",
        "--name",
        "Payments",
        "--goal",
        "Pagamentos confiáveis",
        "--timezone",
        "Mars/Olympus",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a valid IANA time zone/);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(join(workspace, ".ssdd", "ssdd.sqlite")), false);
  });

  it("stops project initialization when an applied migration has changed", () => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-cli-"));
    const dataDirectory = join(workspace, ".ssdd");
    mkdirSync(dataDirectory);
    const databasePath = join(dataDirectory, "ssdd.sqlite");
    const database = openSqliteDatabase(databasePath);
    applyMigrations(database);
    database
      .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1")
      .run("0".repeat(64));
    database.close();

    assert.throws(
      () =>
        initializeProject({
          workspace,
          key: "PAY",
          name: "Payments",
          productGoal: "Pagamentos confiáveis",
          timezone: "America/Sao_Paulo",
        }),
      /differs from the version recorded in the database/,
    );

    const reopened = openSqliteDatabase(databasePath);
    const projectCount = reopened
      .prepare("SELECT COUNT(*) AS count FROM projects")
      .get() as { count: number };
    assert.equal(projectCount.count, 0);
    reopened.close();
  });
});

const cliPath = fileURLToPath(new URL("../../src/cli.js", import.meta.url));

function runInit(workspace: string) {
  return spawnSync(
    process.execPath,
    [
      cliPath,
      "init",
      "--workspace",
      workspace,
      "--key",
      "pay",
      "--name",
      "Payments",
      "--goal",
      "Pagamentos confiáveis",
      "--timezone",
      "America/Sao_Paulo",
    ],
    { encoding: "utf8" },
  );
}
