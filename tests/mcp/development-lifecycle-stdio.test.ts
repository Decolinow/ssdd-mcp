import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { test } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";

test("stdio exposes development and deployment lifecycle through MCP", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-lifecycle-stdio-"));
  const initialized = initializeProject({
    workspace, key: "PAY", name: "Payments", productGoal: "Rastrear execução e release", timezone: "America/Sao_Paulo",
  });
  const database = openSqliteDatabase(initialized.databasePath);
  const principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
    .get(initialized.project.id) as { created_by_principal_id: string }).created_by_principal_id;
  const epic = createWorkItem(database, {
    projectId: initialized.project.id, principalId, requestId: "mcp-life-epic", type: "epic", title: "Payments",
  }).value;
  const feature = createWorkItem(database, {
    projectId: initialized.project.id, principalId, requestId: "mcp-life-feature", type: "feature", parentId: epic.id, title: "Checkout",
  }).value;
  const story = createWorkItem(database, {
    projectId: initialized.project.id, principalId, requestId: "mcp-life-story", type: "story", parentId: feature.id, title: "Confirmar pedido",
  }).value;
  const task = createWorkItem(database, {
    projectId: initialized.project.id, principalId, requestId: "mcp-life-task", type: "task", parentId: story.id,
    title: "Registrar sessão", description: "Desenvolver e validar a integração.",
  }).value;
  const parentBaselineId = randomUUID();
  const baselineCreatedAt = new Date().toISOString();
  database.prepare("UPDATE work_items SET state = 'ready', version = version + 1 WHERE project_id = ? AND item_id = ?")
    .run(initialized.project.id, story.id);
  database.prepare(
    `INSERT INTO work_baselines
      (baseline_id, project_id, item_id, sequence, kind, reason, created_by_principal_id, created_at)
     VALUES (?, ?, ?, 1, 'ready', 'Lifecycle stdio test baseline', ?, ?)`,
  ).run(parentBaselineId, initialized.project.id, story.id, principalId, baselineCreatedAt);
  database.prepare("UPDATE work_items SET state = 'in_progress', assignee_principal_id = ? WHERE item_id = ?")
    .run(principalId, task.id);
  database.close();

  const client = new Client({ name: "ssdd-mcp-lifecycle-tests", version: "0.1.0" });
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
  const projects = await client.callTool({ name: "project_list", arguments: {} });
  const projectId = (projects.structuredContent as { projects: Array<{ id: string }> }).projects[0]!.id;
  const started = await client.callTool({
    name: "development_session_start",
    arguments: { projectId, requestId: "mcp-session-start", itemIdOrKey: task.key, expectedVersion: task.version, sessionReference: "thread:test-17" },
  });
  assert.notEqual(started.isError, true);
  const session = (started.structuredContent as { session: { id: string; status: string; developerPrincipalId: string; version: number } }).session;
  assert.equal(session.status, "active");
  assert.equal(session.developerPrincipalId, principalId);
  const paused = await client.callTool({
    name: "development_session_transition",
    arguments: { projectId, requestId: "mcp-session-pause", sessionId: session.id, action: "pause", expectedVersion: 1, reason: "Aguardando dependência." },
  });
  assert.notEqual(paused.isError, true);
  assert.equal((paused.structuredContent as { session: { status: string } }).session.status, "paused");
  const resumed = await client.callTool({
    name: "development_session_transition",
    arguments: { projectId, requestId: "mcp-session-resume", sessionId: session.id, action: "resume", expectedVersion: 2, reason: "Dependência disponível." },
  });
  assert.notEqual(resumed.isError, true);
  const completed = await client.callTool({
    name: "development_session_transition",
    arguments: { projectId, requestId: "mcp-session-complete", sessionId: session.id, action: "complete", expectedVersion: 3, reason: "Implementação finalizada." },
  });
  assert.notEqual(completed.isError, true);

  const sessionList = await client.callTool({ name: "development_session_list", arguments: { projectId, itemIdOrKey: task.key } });
  assert.notEqual(sessionList.isError, true);
  assert.equal((sessionList.structuredContent as { sessions: Array<{ id: string; status: string }> }).sessions[0]?.status, "completed");
  const developerMetrics = await client.callTool({
    name: "developer_execution_metrics_get", arguments: { projectId, from: projectToday(), to: projectToday() },
  });
  assert.notEqual(developerMetrics.isError, true);
  const developerMetricResult = developerMetrics.structuredContent as { developers: Array<{
    activeHoursOnCompletedTasks: number; activeHoursOnEstimatedCompletedTasks: number; estimatedCompletedTasks: number;
  }> };
  assert.ok(developerMetricResult.developers.length > 0);
  assert.equal(typeof developerMetricResult.developers[0]?.estimatedCompletedTasks, "number");
  assert.equal(typeof developerMetricResult.developers[0]?.activeHoursOnCompletedTasks, "number");
  assert.equal(typeof developerMetricResult.developers[0]?.activeHoursOnEstimatedCompletedTasks, "number");

  const failedProductionGate = await client.callTool({
    name: "deployment_event_record",
    arguments: { projectId, requestId: "mcp-prod-blocked", environment: "production", buildId: "mcp-build-1", outcome: "succeeded", itemIdOrKeys: [task.key] },
  });
  assert.equal(failedProductionGate.isError, true);
  const homologation = await client.callTool({
    name: "deployment_event_record",
    arguments: { projectId, requestId: "mcp-homol-failed", environment: "homologation", buildId: "mcp-build-1", outcome: "failed", itemIdOrKeys: [task.key] },
  });
  assert.notEqual(homologation.isError, true);
  const releaseHistory = await client.callTool({
    name: "deployment_event_list", arguments: { projectId, environment: "homologation", itemIdOrKey: task.key },
  });
  assert.notEqual(releaseHistory.isError, true);
  assert.equal((releaseHistory.structuredContent as { events: Array<{ outcome: string; itemIds: string[] }> }).events[0]?.outcome, "failed");
});

function projectToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
