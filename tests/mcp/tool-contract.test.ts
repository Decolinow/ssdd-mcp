import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { initializeProject } from "../../src/application/initialize-project.js";
import { mcpToolHints } from "../../src/mcp/tool-hints.js";

// SSDD-946: every tool is annotated, and every writing tool cites a precondition and its most common error.
test("every tool has annotations and every write tool documents precondition and common error", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-tool-contract-"));
  initializeProject({ workspace, key: "TC", name: "Contract", productGoal: "Contrato", timezone: "UTC" });
  const client = new Client({ name: "contract", version: "0.1.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../src/cli.js", import.meta.url)), "stdio", "--workspace", workspace],
    stderr: "ignore",
  }));
  context.after(async () => {
    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  const tools = (await client.listTools()).tools;
  for (const tool of tools) {
    const annotations = tool.annotations;
    assert.ok(annotations && typeof annotations.readOnlyHint === "boolean" && typeof annotations.destructiveHint === "boolean"
      && typeof annotations.idempotentHint === "boolean", `${tool.name}: annotations incompletas`);
    if (annotations.readOnlyHint === true) continue;
    assert.ok(mcpToolHints[tool.name], `${tool.name}: escrita sem pré-condição/erro comum em tool-hints.ts`);
    assert.match(tool.description ?? "", /Pré-condição: .+ Erro comum: /u, `${tool.name}: descrição sem pré-condição e erro comum`);
  }
  for (const name of Object.keys(mcpToolHints)) assert.ok(tools.some((tool) => tool.name === name), `dica órfã: ${name}`);
});
