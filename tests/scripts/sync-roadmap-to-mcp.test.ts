import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

interface RoadmapSyncSummary {
  readonly projectId: string;
  readonly counts: Record<string, number>;
  readonly roadmapTasks: number;
  readonly dependencyLinksAdded: number;
  readonly sprints: number;
}

it("reuses imported roadmap items when the documented status changes", { timeout: 60_000 }, () => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-roadmap-sync-"));
  const repositoryRoot = resolve(process.cwd());
  const cliPath = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const syncScriptPath = join(repositoryRoot, "scripts", "sync-roadmap-to-mcp.mjs");

  try {
    mkdirSync(join(workspace, "docs"), { recursive: true });
    copyFileSync(join(repositoryRoot, "ROADMAP.md"), join(workspace, "ROADMAP.md"));
    copyFileSync(join(repositoryRoot, "docs", "status.md"), join(workspace, "docs", "status.md"));

    const initialized = spawnSync(process.execPath, [
      cliPath,
      "init",
      "--workspace",
      workspace,
      "--key",
      "TEST",
      "--name",
      "Roadmap Sync Test",
      "--goal",
      "Exercise idempotent roadmap import",
      "--timezone",
      "America/Sao_Paulo",
    ], { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 });
    assert.equal(initialized.status, 0, `${initialized.stdout}\n${initialized.stderr}`);

    const firstRun = runSync(syncScriptPath, cliPath, workspace, repositoryRoot);
    const initialSummary = readSummary(firstRun.stdout);
    assert.equal(initialSummary.roadmapTasks, 41);
    assert.equal(initialSummary.dependencyLinksAdded, 71);
    assert.deepEqual(initialSummary.counts, { epic: 4, feature: 9, story: 9, task: 41 });

    const statusPath = join(workspace, "docs", "status.md");
    const originalStatus = readFileSync(statusPath, "utf8");
    const revisedStatus = originalStatus.replace(
      /^\| SSDD-901 \|[^\r\n]*/m,
      "| SSDD-901 | Revalidação do importador sem recriar o item |",
    );
    assert.notEqual(revisedStatus, originalStatus, "The test status row must exist");
    writeFileSync(statusPath, revisedStatus, "utf8");

    const secondRun = runSync(syncScriptPath, cliPath, workspace, repositoryRoot);
    const repeatedSummary = readSummary(secondRun.stdout);
    assert.deepEqual(repeatedSummary, initialSummary);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function runSync(syncScriptPath: string, cliPath: string, workspace: string, cwd: string) {
  const result = spawnSync(process.execPath, [syncScriptPath], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      SSDD_CLI_PATH: cliPath,
      SSDD_PROJECT_KEY: "TEST",
      SSDD_WORKSPACE: workspace,
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

function readSummary(stdout: string): RoadmapSyncSummary {
  const summaryStart = stdout.lastIndexOf("\n{");
  assert.notEqual(summaryStart, -1, "Roadmap sync output must include its summary JSON");
  return JSON.parse(stdout.slice(summaryStart + 1)) as RoadmapSyncSummary;
}
