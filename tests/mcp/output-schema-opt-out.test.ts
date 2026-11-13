import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { initializeProject } from "../../src/application/initialize-project.js";

// U18: output schemas dominate the tools/list payload. The opt-out must shrink it without losing structured results.
test("SSDD_MCP_OMIT_OUTPUT_SCHEMAS=1 shrinks tools/list and keeps structuredContent", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-schema-optout-"));
  initializeProject({ workspace, key: "OPT", name: "Opt", productGoal: "Contexto", timezone: "UTC" });
  const connect = async (omit: boolean) => {
    const client = new Client({ name: "optout", version: "0.1.0" });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../../src/cli.js", import.meta.url)), "stdio", "--workspace", workspace],
      env: { ...process.env, SSDD_PROFILE: "dev", ...(omit ? { SSDD_MCP_OMIT_OUTPUT_SCHEMAS: "1" } : {}) } as Record<string, string>,
      stderr: "ignore",
    }));
    return client;
  };
  const full = await connect(false);
  const lean = await connect(true);
  context.after(async () => {
    await full.close();
    await lean.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  const fullTools = (await full.listTools()).tools;
  const leanTools = (await lean.listTools()).tools;
  assert.deepEqual(leanTools.map((tool) => tool.name), fullTools.map((tool) => tool.name));
  assert.ok(fullTools.every((tool) => tool.outputSchema !== undefined));
  assert.ok(leanTools.every((tool) => tool.outputSchema === undefined));
  const bytes = (tools: typeof fullTools) => JSON.stringify(tools).length;
  assert.ok(bytes(leanTools) < bytes(fullTools) * 0.4, `lean ${bytes(leanTools)} vs full ${bytes(fullTools)}`);
  const result = await lean.callTool({ name: "project_list", arguments: {} });
  assert.ok((result.structuredContent as { projects: unknown[] }).projects.length === 1);
});
