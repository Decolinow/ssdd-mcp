import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { initializeProject } from "../../src/application/initialize-project.js";
import { approvableMcpToolNames } from "../../src/application/command-approvals.js";
import { classifiedMcpToolNames, mcpToolAnnotations, withToolAnnotations } from "../../src/mcp/tool-annotations.js";

test("every registered MCP tool carries a coherent annotation set", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-annotations-"));
  initializeProject({
    workspace,
    key: "ANN",
    name: "Annotations",
    productGoal: "Contrato de anotações das tools",
    timezone: "UTC",
  });

  const cliPath = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const client = new Client({ name: "ssdd-mcp-tests", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "stdio", "--workspace", workspace],
    stderr: "ignore",
  });
  context.after(async () => {
    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  await client.connect(transport);

  const { tools } = await client.listTools();
  assert.ok(tools.length > 0);
  const classified = new Set(classifiedMcpToolNames());

  for (const tool of tools) {
    assert.ok(classified.has(tool.name), `${tool.name} precisa de classificação em tool-annotations.ts`);
    const hints = tool.annotations;
    assert.ok(hints, `${tool.name} sem annotations`);
    for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
      assert.equal(typeof hints[key], "boolean", `${tool.name}.${key}`);
    }
    if (hints.readOnlyHint) assert.equal(hints.destructiveHint, false, `${tool.name}: leitura não pode ser destrutiva`);
  }

  // Cada tool classificada existe no catálogo, exceto as de administração de usuários, exclusivas do admin da instância.
  const listed = new Set(tools.map((tool) => tool.name));
  for (const name of classified) {
    if (name.startsWith("user_")) continue;
    assert.ok(listed.has(name), `${name} está classificada mas não é registrada`);
  }

  // Toda mutação elegível a aprovação delegada precisa ser anotada como escrita.
  for (const name of approvableMcpToolNames) {
    assert.equal(mcpToolAnnotations(name)?.readOnlyHint, false, `${name} é mutação aprovável`);
  }

  const byName = new Map(tools.map((tool) => [tool.name, tool.annotations]));
  assert.equal(byName.get("work_item_get")?.readOnlyHint, true);
  assert.equal(byName.get("task_start")?.readOnlyHint, false);
  assert.equal(byName.get("trace_link_remove")?.destructiveHint, true);
  assert.equal(byName.get("github_issue_import_preview")?.openWorldHint, true);
  assert.equal(byName.get("work_item_create")?.destructiveHint, false);
});

test("declared annotations win over the catalog defaults", () => {
  const merged = withToolAnnotations("work_item_get", { annotations: { readOnlyHint: false, title: "x" } }) as {
    annotations: Record<string, unknown>;
  };
  assert.equal(merged.annotations.readOnlyHint, false);
  assert.equal(merged.annotations.idempotentHint, true);
  assert.deepEqual(withToolAnnotations("unknown_tool", { a: 1 }), { a: 1 });
});
