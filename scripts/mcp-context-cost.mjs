#!/usr/bin/env node
// Reports the context cost (serialized tools/list bytes, ~3.6 bytes per token) of every MCP profile and the heaviest tools.
// Usage: npm run build && node scripts/mcp-context-cost.mjs [--json]
import * as console from "node:console";
import process from "node:process";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const { initializeProject } = await import(pathToFileURL(join(root, "dist/src/application/initialize-project.js")).href);
const { mcpProfileAllowsTool, mcpProfiles } = await import(pathToFileURL(join(root, "dist/src/mcp/profiles.js")).href);
const workspace = mkdtempSync(join(tmpdir(), "ssdd-context-cost-"));
initializeProject({ workspace, key: "CTX", name: "Context", productGoal: "Medir custo de contexto", timezone: "UTC" });
const client = new Client({ name: "ssdd-context-cost", version: "0.1.0" });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "dist/src/cli.js"), "stdio", "--workspace", workspace], stderr: "ignore" }));
  const { tools } = await client.listTools();
  const size = Object.fromEntries(tools.map((tool) => [tool.name, JSON.stringify(tool).length]));
  const profiles = Object.fromEntries(mcpProfiles.map((profile) => {
    const names = tools.map((tool) => tool.name).filter((name) => mcpProfileAllowsTool(profile, name, true));
    const bytes = names.reduce((sum, name) => sum + size[name], 0);
    return [profile, { tools: names.length, bytes, approxTokens: Math.round(bytes / 3.6) }];
  }));
  const heaviest = Object.entries(size).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, bytes]) => ({ name, bytes }));
  if (process.argv.includes("--json")) console.log(JSON.stringify({ tools: tools.length, profiles, heaviest }, null, 2));
  else {
    console.log(`${tools.length} tools`);
    for (const [profile, value] of Object.entries(profiles)) console.log(`${profile.padEnd(16)} ${String(value.tools).padStart(3)} tools ${String(value.bytes).padStart(7)} B ~${value.approxTokens} tokens`);
    console.log("\nHeaviest tools:");
    for (const { name, bytes } of heaviest) console.log(`${name.padEnd(36)} ${bytes} B`);
  }
} finally {
  await client.close();
  rmSync(workspace, { recursive: true, force: true });
}
