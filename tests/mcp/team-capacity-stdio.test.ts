import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { test } from "node:test";
import { initializeProject } from "../../src/application/initialize-project.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";

test("stdio configures a team and returns its calculated capacity", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-team-capacity-"));
  const initialized = initializeProject({
    workspace,
    key: "PAY",
    name: "Payments",
    productGoal: "Pagamentos confiáveis",
    timezone: "America/Sao_Paulo",
  });
  const database = openSqliteDatabase(initialized.databasePath);
  const principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
    .get(initialized.project.id) as { created_by_principal_id: string }).created_by_principal_id;
  const developerId = randomUUID();
  const createdAt = new Date().toISOString();
  database.prepare(
    `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
     VALUES (?, 'human', ?, 'Capacity developer', ?)`,
  ).run(developerId, `capacity:${developerId}`, createdAt);
  database.prepare(
    "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, 'developer', ?)",
  ).run(initialized.project.id, developerId, createdAt);
  database.close();

  const cliPath = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const client = new Client({ name: "ssdd-mcp-capacity-tests", version: "0.1.0" });
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
  const configured = await client.callTool({
    name: "team_capacity_set",
    arguments: {
      projectId: initialized.project.id,
      requestId: "capacity-configure-v1",
      expectedVersion: 0,
      teamName: "Payments team",
      timezone: "America/Sao_Paulo",
      hoursPerDay: 6,
      workingDays: [1, 2, 3, 4, 5],
      members: [
        { principalId, dedicationPercent: 100 },
        { principalId: developerId, dedicationPercent: 50 },
      ],
      absences: [{ principalId, date: "2026-11-10", hours: 6, reason: "Ausência" }],
      reason: "Configurar capacidade inicial para a sprint.",
    },
  });
  assert.notEqual(configured.isError, true);
  const configuration = configured.structuredContent as {
    configuration: { version: number; generationNumber: number; members: unknown[] };
  };
  assert.equal(configuration.configuration.version, 1);
  assert.equal(configuration.configuration.generationNumber, 1);
  assert.equal(configuration.configuration.members.length, 2);

  const capacity = await client.callTool({
    name: "team_capacity_get",
    arguments: {
      projectId: initialized.project.id,
      startDate: "2026-11-09",
      endDate: "2026-11-20",
    },
  });
  assert.notEqual(capacity.isError, true);
  const report = capacity.structuredContent as {
    totalHours: number; workdays: number; version: number; generationNumber: number;
  };
  assert.equal(report.version, 1);
  assert.equal(report.generationNumber, 1);
  assert.equal(report.workdays, 10);
  assert.equal(report.totalHours, 84);

  const secondTeam = await client.callTool({
    name: "team_create",
    arguments: {
      projectId: initialized.project.id,
      requestId: "capacity-create-second-team",
      teamName: "Reconciliation team",
      timezone: "America/Sao_Paulo",
      hoursPerDay: 4,
      workingDays: [1, 2, 3, 4, 5],
      members: [{ principalId, dedicationPercent: 100 }],
      reason: "Criar capacidade isolada para conciliação.",
    },
  });
  assert.notEqual(secondTeam.isError, true);
  const createdTeam = secondTeam.structuredContent as { configuration: { teamId: string } };
  const listedTeams = await client.callTool({ name: "team_list", arguments: { projectId: initialized.project.id } });
  assert.notEqual(listedTeams.isError, true);
  assert.equal((listedTeams.structuredContent as { teams: unknown[] }).teams.length, 2);
  const isolatedCapacity = await client.callTool({
    name: "team_capacity_get",
    arguments: {
      projectId: initialized.project.id,
      teamId: createdTeam.configuration.teamId,
      startDate: "2026-11-09",
      endDate: "2026-11-09",
    },
  });
  assert.notEqual(isolatedCapacity.isError, true);
  assert.equal((isolatedCapacity.structuredContent as { totalHours: number }).totalHours, 4);
  const ambiguousCapacity = await client.callTool({
    name: "team_capacity_get",
    arguments: { projectId: initialized.project.id, startDate: "2026-11-09", endDate: "2026-11-09" },
  });
  assert.equal(ambiguousCapacity.isError, true);
  const ambiguousText = ambiguousCapacity.content.find((content) => content.type === "text");
  assert.ok(ambiguousText && ambiguousText.type === "text");
  assert.equal((JSON.parse(ambiguousText.text) as { code: string }).code, "VALIDATION_FAILED");
});
