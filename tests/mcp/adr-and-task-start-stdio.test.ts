import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { initializeProject } from "../../src/application/initialize-project.js";

test("MCP creates, searches and traces ADRs and reports task-start blockers", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-adr-start-stdio-"));
  initializeProject({ workspace, key: "PAY", name: "Payments", productGoal: "Pagamentos confiáveis", timezone: "UTC" });
  const client = new Client({ name: "ssdd-mcp-adr-start-tests", version: "0.2.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../src/cli.js", import.meta.url)), "stdio", "--workspace", workspace],
    stderr: "ignore",
  });
  context.after(async () => {
    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  await client.connect(transport);
  const projectList = await client.callTool({ name: "project_list", arguments: {} });
  const projectId = (projectList.structuredContent as { projects: Array<{ id: string }> }).projects[0]?.id;
  assert.ok(projectId);

  const epic = (await client.callTool({ name: "work_item_create", arguments: {
    projectId, requestId: "adr-test-epic", type: "epic", title: "Pagamentos",
  } })).structuredContent as { workItem: { id: string } };
  const feature = (await client.callTool({ name: "work_item_create", arguments: {
    projectId, requestId: "adr-test-feature", type: "feature", parentId: epic.workItem.id, title: "Checkout",
  } })).structuredContent as { workItem: { id: string } };
  const story = (await client.callTool({ name: "work_item_create", arguments: {
    projectId, requestId: "adr-test-story", type: "story", parentId: feature.workItem.id,
    title: "Confirmar pedido", description: "A pessoa confirma o pedido.",
  } })).structuredContent as { workItem: { id: string } };
  const taskResult = await client.callTool({ name: "work_item_create", arguments: {
    projectId, requestId: "adr-test-task", type: "task", parentId: story.workItem.id,
    title: "Aplicar idempotência", description: "Persistir chave estável por pedido.",
  } });
  const task = (taskResult.structuredContent as { workItem: { id: string; key: string; state: string; version: number } }).workItem;

  const adrResult = await client.callTool({ name: "adr_create", arguments: {
    projectId, requestId: "adr-test-create", key: "ADR-PAY-01", title: "Idempotência por pedido",
    content: { decision: "A decisão usa uma chave estável por pedido." },
  } });
  assert.notEqual(adrResult.isError, true);
  const adr = (adrResult.structuredContent as { revision: { key: string; status: string } }).revision;
  assert.equal(adr.status, "draft");

  const search = await client.callTool({ name: "adr_search", arguments: { projectId, query: "decisao" } });
  assert.notEqual(search.isError, true);
  assert.deepEqual((search.structuredContent as { specifications: Array<{ key: string }> }).specifications.map(({ key }) => key), [adr.key]);

  const link = await client.callTool({ name: "adr_link_task", arguments: {
    projectId, requestId: "adr-test-link", taskIdOrKey: task.key, adrIdOrKey: adr.key,
  } });
  assert.notEqual(link.isError, true);
  const linkValue = link.structuredContent as { link: { type: string; source: { key: string }; target: { key: string } }; adrRevision: { published: number | null } };
  assert.equal(linkValue.link.type, "implements");
  assert.equal(linkValue.link.source.key, task.key);
  assert.equal(linkValue.link.target.key, adr.key);
  assert.equal(linkValue.adrRevision.published, null);

  const taskContext = await client.callTool({ name: "task_context_get", arguments: {
    projectId, taskIdOrKey: task.key, include: ["technicalDecisions"],
  } });
  assert.notEqual(taskContext.isError, true);
  assert.ok((taskContext.structuredContent as { warnings: Array<{ code: string }> }).warnings.some(({ code }) => code === "SPEC_WITHOUT_PUBLICATION"));

  const readiness = await client.callTool({ name: "task_start_check", arguments: { projectId, taskIdOrKey: task.key } });
  assert.notEqual(readiness.isError, true);
  assert.equal((readiness.structuredContent as { canStart: boolean; blockers: Array<{ code: string }> }).canStart, false);
  assert.ok((readiness.structuredContent as { blockers: Array<{ code: string }> }).blockers.some(({ code }) => code === "task_not_ready_for_development"));

  const aliasReadiness = await client.callTool({ name: "task_start_check", arguments: { projectId, itemIdOrKey: task.key } });
  assert.notEqual(aliasReadiness.isError, true);
  assert.deepEqual(aliasReadiness.structuredContent, readiness.structuredContent);
  const bothNames = await client.callTool({ name: "task_start_check", arguments: { projectId, itemIdOrKey: task.key, taskIdOrKey: task.key } });
  assert.equal(bothNames.isError, true);
  const neitherName = await client.callTool({ name: "task_start_check", arguments: { projectId } });
  assert.equal(neitherName.isError, true);

  const start = await client.callTool({ name: "task_start", arguments: {
    projectId, requestId: "adr-test-start-draft", taskIdOrKey: task.key, expectedVersion: task.version, reason: "Não iniciar tarefa Draft.",
  } });
  assert.equal(start.isError, true);
  const current = await client.callTool({ name: "work_item_get", arguments: { projectId, itemIdOrKey: task.key } });
  assert.equal((current.structuredContent as { workItem: { state: string } }).workItem.state, "draft");
});
