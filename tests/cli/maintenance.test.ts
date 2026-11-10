import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { initializeProject } from "../../src/application/initialize-project.js";
import { runCli } from "../../src/cli.js";

describe("ssdd-mcp maintenance CLI", () => {
  const workspaces: string[] = [];
  afterEach(() => {
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  it("runs doctor, backup, restore, and all export formats", async () => {
    const root = mkdtempSync(join(tmpdir(), "ssdd-mcp-maintenance-cli-"));
    workspaces.push(root);
    const workspace = join(root, "source");
    initializeProject({
      workspace,
      key: "PAY",
      name: "Payments",
      productGoal: "Pagamentos confiáveis",
      timezone: "America/Sao_Paulo",
    });

    const doctor = createOutput();
    assert.equal(await runCli(["doctor", "--workspace", workspace], doctor.stdout, doctor.stderr), 0);
    assert.equal((JSON.parse(doctor.value()) as { status: string }).status, "ok");

    const backupPath = join(root, "project.sqlite");
    const backup = createOutput();
    assert.equal(await runCli(["backup", "--workspace", workspace, "--output", backupPath], backup.stdout, backup.stderr), 0);
    assert.equal(existsSync(backupPath), true);
    assert.equal(existsSync(`${backupPath}.manifest.json`), true);

    const restoredWorkspace = join(root, "restored");
    const restore = createOutput();
    assert.equal(await runCli(["restore", "--workspace", restoredWorkspace, "--backup", backupPath], restore.stdout, restore.stderr), 0);
    assert.match(restore.value(), /restoredSchemaVersion/u);
    assert.equal(existsSync(join(restoredWorkspace, ".ssdd", "ssdd.sqlite")), true);

    const json = createOutput();
    assert.equal(await runCli(["export", "--workspace", restoredWorkspace, "--format", "json"], json.stdout, json.stderr), 0);
    assert.equal((JSON.parse(json.value()) as { format: string }).format, "ssdd-mcp-export");

    const markdownPath = join(root, "project.md");
    const markdown = createOutput();
    assert.equal(await runCli(["export", "--workspace", restoredWorkspace, "--format", "markdown", "--output", markdownPath], markdown.stdout, markdown.stderr), 0);
    assert.equal(existsSync(markdownPath), true);
    assert.match(markdown.value(), /project.md/u);

    const gherkin = createOutput();
    assert.equal(await runCli(["export", "--workspace", restoredWorkspace, "--format", "gherkin"], gherkin.stdout, gherkin.stderr), 0);
    assert.equal(gherkin.value(), "# No published scenarios found.\n");
    const featurePath = join(root, "scenarios.feature");
    const gherkinFile = createOutput();
    assert.equal(await runCli(["export", "--workspace", restoredWorkspace, "--format", "gherkin", "--output", featurePath], gherkinFile.stdout, gherkinFile.stderr), 0);
    assert.equal(existsSync(featurePath), true);
    assert.match(gherkinFile.value(), /"format": "gherkin"/u);
    assert.equal(readFileSync(featurePath, "utf8"), "# No published scenarios found.\n");

    const invalidFormat = createOutput();
    assert.equal(await runCli(["export", "--workspace", workspace, "--format", "yaml"], invalidFormat.stdout, invalidFormat.stderr), 1);
    assert.match(invalidFormat.error(), /json.*markdown.*gherkin/u);
  });
});

function createOutput(): {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  value(): string;
  error(): string;
} {
  let output = "";
  let errors = "";
  return {
    stdout: { write: (chunk: string | Uint8Array) => { output += String(chunk); return true; } },
    stderr: { write: (chunk: string | Uint8Array) => { errors += String(chunk); return true; } },
    value: () => output,
    error: () => errors,
  };
}
