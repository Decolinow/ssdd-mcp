import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
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
  readonly stableRoadmapIdsMapped: number;
  readonly stableIdCollisionsVerified: number;
  readonly dependencyLinksReconciled: number;
  readonly sprints: number;
  readonly installerTasks: number;
  readonly installerStoryPoints: number;
  readonly installerTaskHours: number;
}

it("reuses imported roadmap items, preserves cancelled mapped tasks, and ignores cancelled duplicates", { timeout: 60_000 }, async () => {
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
    assert.equal(initialSummary.roadmapTasks, 66);
    assert.equal(initialSummary.stableRoadmapIdsMapped, 55);
    assert.equal(initialSummary.installerTasks, 11);
    assert.equal(initialSummary.installerStoryPoints, 26);
    assert.equal(initialSummary.installerTaskHours, 49);
    assert.equal(initialSummary.dependencyLinksReconciled, 127);
    assert.deepEqual(initialSummary.counts, { epic: 4, feature: 13, story: 14, task: 66 });
    const mappingDocument = JSON.parse(readFileSync(join(workspace, ".ssdd", "roadmap-id-map.json"), "utf8")) as {
      projectId: string;
      items: Record<string, { itemId: string; itemKey: string; title: string }>;
    };
    assert.equal(mappingDocument.projectId, initialSummary.projectId);
    assert.equal(Object.keys(mappingDocument.items).length, 55);
    assert.ok(mappingDocument.items["SSDD-902"]);

    await cancelMappedTask(workspace, cliPath, mappingDocument.projectId, mappingDocument.items["SSDD-914"]!.itemId);

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
    const repeatedMappingDocument = JSON.parse(readFileSync(join(workspace, ".ssdd", "roadmap-id-map.json"), "utf8")) as typeof mappingDocument;
    assert.deepEqual(repeatedMappingDocument, mappingDocument);

    await createCancelledDuplicate(workspace, cliPath, mappingDocument.projectId);
    const thirdRun = runSync(syncScriptPath, cliPath, workspace, repositoryRoot);
    const recoveredSummary = readSummary(thirdRun.stdout);
    assert.deepEqual(recoveredSummary, initialSummary, "Cancelled duplicate items must not block idempotent reconciliation");
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

function createCancelledDuplicate(workspace: string, cliPath: string, projectId: string) {
  const client = new Client({ name: "ssdd-roadmap-cancelled-duplicate", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "stdio", "--workspace", workspace],
  });
  return client.connect(transport).then(async () => {
    const read = async <T>(name: string, arguments_: Record<string, unknown>): Promise<T> => {
      const result = await client.callTool({ name, arguments: arguments_ });
      assert.notEqual(result.isError, true, `${name}: ${result.content.map((entry) => entry.type === "text" ? entry.text : "").join("\n")}`);
      const text = result.content.find((entry) => entry.type === "text");
      assert.ok(text && text.type === "text");
      return JSON.parse(text.text) as T;
    };
    try {
      const items = await read<{ items: Array<{ id: string; key: string; parentId: string | null; title: string }> }>(
        "work_item_list",
        { projectId, limit: 100 },
      );
      const original = items.items.find((item) => item.title === "Validar configurações com processo MCP real");
      assert.ok(original?.parentId, "The original installer task and parent must exist");
      const duplicate = await read<{ workItem: { id: string; key: string; version: number } }>("work_item_create", {
        projectId,
        requestId: "test-create-cancelled-roadmap-duplicate",
        type: "task",
        parentId: original.parentId,
        title: original.title,
        description: "Duplicate test record to confirm cancelled historical work does not block roadmap sync.",
      });
      await read("work_item_transition", {
        projectId,
        requestId: "test-cancel-roadmap-duplicate",
        itemIdOrKey: duplicate.workItem.id,
        targetState: "cancelled",
        expectedVersion: duplicate.workItem.version,
        reason: "Duplicate fixture for roadmap sync regression coverage.",
      });
    } finally {
      await client.close();
    }
  });
}

async function cancelMappedTask(workspace: string, cliPath: string, projectId: string, itemId: string): Promise<void> {
  const client = new Client({ name: "ssdd-roadmap-cancel-mapped-task", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cliPath, "stdio", "--workspace", workspace] });
  await client.connect(transport);
  try {
    const current = await client.callTool({ name: "work_item_get", arguments: { projectId, itemIdOrKey: itemId } });
    assert.notEqual(current.isError, true);
    const item = (current.structuredContent as { workItem?: { version: number } } | undefined)?.workItem;
    assert.ok(item);
    const transition = await client.callTool({
      name: "work_item_transition",
      arguments: {
        projectId,
        requestId: "test-cancel-mapped-roadmap-task",
        itemIdOrKey: itemId,
        targetState: "cancelled",
        expectedVersion: item.version,
        reason: "Regression test: mapped cancellation is historical and must not cause recreation.",
      },
    });
    assert.notEqual(transition.isError, true);
  } finally {
    await client.close();
  }
}

function readSummary(stdout: string): RoadmapSyncSummary {
  const summaryStart = stdout.lastIndexOf("\n{");
  assert.notEqual(summaryStart, -1, "Roadmap sync output must include its summary JSON");
  return JSON.parse(stdout.slice(summaryStart + 1)) as RoadmapSyncSummary;
}
