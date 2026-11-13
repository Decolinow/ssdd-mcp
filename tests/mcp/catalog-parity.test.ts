import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { approvableMcpToolNames } from "../../src/application/command-approvals.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createMcpHttpServer, listenMcpHttpServer } from "../../src/mcp/http-server.js";
import { mcpProfileAllowsTool, mcpProfiles } from "../../src/mcp/profiles.js";
import { mcpToolAnnotations } from "../../src/mcp/tool-annotations.js";

// SSDD-906: the tool catalog must be identical across stdio and Streamable HTTP, every tool must be
// documented in docs/mcp.md, and docs/mcp-parity-matrix.md (generated) must match the live catalog.
// Regenerate with: UPDATE_PARITY_MATRIX=1 npm test

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("stdio and Streamable HTTP expose the same tool contracts and the parity matrix is current", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-parity-"));
  initializeProject({ workspace, key: "PAR", name: "Parity", productGoal: "Paridade de catálogo", timezone: "UTC" });

  const stdio = new Client({ name: "ssdd-parity-stdio", version: "0.1.0" });
  await stdio.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../src/cli.js", import.meta.url)), "stdio", "--workspace", workspace],
    stderr: "ignore",
  }));
  const handle = createMcpHttpServer(workspace);
  const address = await listenMcpHttpServer(handle, 0);
  const http = new Client({ name: "ssdd-parity-http", version: "0.1.0" });
  context.after(async () => {
    await stdio.close();
    await http.close();
    await handle.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  await http.connect(new StreamableHTTPClientTransport(new URL(`${address.origin}/mcp`)));

  const stdioTools = (await stdio.listTools()).tools;
  const httpTools = (await http.listTools()).tools;
  const byName = (tools: typeof stdioTools) => new Map(tools.map((tool) => [tool.name, tool]));
  const stdioByName = byName(stdioTools);
  const httpByName = byName(httpTools);
  assert.deepEqual([...httpByName.keys()].sort(), [...stdioByName.keys()].sort(), "transports expose different tool names");
  for (const [name, tool] of stdioByName) {
    const other = httpByName.get(name)!;
    assert.deepEqual(other.inputSchema, tool.inputSchema, `${name}: inputSchema differs between transports`);
    assert.deepEqual(other.outputSchema, tool.outputSchema, `${name}: outputSchema differs between transports`);
    assert.deepEqual(other.annotations, tool.annotations, `${name}: annotations differ between transports`);
    assert.equal(other.description, tool.description, `${name}: description differs between transports`);
  }

  const mcpDoc = readFileSync(join(repositoryRoot, "docs/mcp.md"), "utf8");
  const skills = readSkills();
  const approvable = new Set<string>(approvableMcpToolNames);
  const rows = [...stdioByName.keys()].sort().map((name) => {
    assert.ok(mcpDoc.includes(`\`${name}\``), `${name} não está documentada em docs/mcp.md`);
    const annotations = mcpToolAnnotations(name);
    assert.ok(annotations, `${name} sem classificação`);
    const properties = Object.keys((stdioByName.get(name)!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    const paginated = properties.includes("cursor") || properties.includes("evidenceCursor");
    const mutability = annotations.readOnlyHint ? "leitura"
      : approvable.has(name) ? "escrita (aprovável)" : "escrita";
    const profiles = mcpProfiles.filter((profile) => mcpProfileAllowsTool(profile, name, true) && profile !== "full");
    const consumers = skills.filter((skill) => skill.text.includes(name)).map((skill) => skill.name);
    return `| \`${name}\` | ${mutability} | ${paginated ? "cursor" : "—"} | ${profiles.join(", ") || "somente full"} | ${
      consumers.length > 0 ? consumers.join(", ") : "chamada direta (sem skill dedicada)"} |`;
  });
  const matrix = [
    "# Matriz de paridade do catálogo MCP",
    "",
    "Gerada por `tests/mcp/catalog-parity.test.ts` (SSDD-906). Não edite à mão: rode `UPDATE_PARITY_MATRIX=1 npm test` depois de mudar o catálogo.",
    "stdio e Streamable HTTP expõem o mesmo catálogo (nome, descrição, schemas e anotações idênticos), verificado no mesmo teste.",
    "A autorização por papel de cada operação está em `docs/mcp.md`; a coluna de perfis mostra onde a tool é visível além de `full`.",
    "",
    "| Tool | Mutabilidade | Paginação | Perfis | Skills consumidoras |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");

  const matrixPath = join(repositoryRoot, "docs/mcp-parity-matrix.md");
  if (process.env["UPDATE_PARITY_MATRIX"] === "1") writeFileSync(matrixPath, matrix);
  assert.ok(existsSync(matrixPath), "docs/mcp-parity-matrix.md ausente; rode UPDATE_PARITY_MATRIX=1 npm test");
  assert.equal(
    readFileSync(matrixPath, "utf8").replace(/\r\n/g, "\n"),
    matrix,
    "docs/mcp-parity-matrix.md está desatualizada; rode UPDATE_PARITY_MATRIX=1 npm test",
  );
});

function readSkills(): Array<{ name: string; text: string }> {
  const root = join(repositoryRoot, "skills");
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md")))
    .map((entry) => ({ name: entry.name, text: readFileSync(join(root, entry.name, "SKILL.md"), "utf8") }));
}
