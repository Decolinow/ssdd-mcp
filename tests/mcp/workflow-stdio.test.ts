import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { initializeProject } from "../../src/application/initialize-project.js";

test("stdio completes a baseline-to-QA workflow through MCP tools", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-workflow-stdio-"));
  initializeProject({
    workspace,
    key: "PAY",
    name: "Payments",
    productGoal: "Pagamentos confiáveis",
    timezone: "America/Sao_Paulo",
  });

  const cliPath = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const client = new Client({ name: "ssdd-mcp-workflow-tests", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "stdio", "--workspace", workspace],
  });
  context.after(async () => {
    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  await client.connect(transport);
  const projectList = await client.callTool({ name: "project_list", arguments: {} });
  assert.notEqual(projectList.isError, true);
  const projectId = (projectList.structuredContent as { projects: Array<{ id: string }> }).projects[0]?.id;
  assert.ok(projectId);

  const epicResult = await client.callTool({
    name: "work_item_create",
    arguments: { projectId, requestId: "workflow-epic", type: "epic", title: "Pagamentos" },
  });
  assert.notEqual(epicResult.isError, true);
  const epicId = (epicResult.structuredContent as { workItem: { id: string } }).workItem.id;
  const featureResult = await client.callTool({
    name: "work_item_create",
    arguments: { projectId, requestId: "workflow-feature", type: "feature", parentId: epicId, title: "Checkout" },
  });
  assert.notEqual(featureResult.isError, true);
  const featureId = (featureResult.structuredContent as { workItem: { id: string } }).workItem.id;
  const storyResult = await client.callTool({
    name: "work_item_create",
    arguments: {
      projectId,
      requestId: "workflow-story",
      type: "story",
      parentId: featureId,
      title: "Confirmar pedido",
      description: "Confirmar pedido válido e devolver identificador.",
      criteria: [{ description: "Pedido válido recebe identificador" }],
    },
  });
  assert.notEqual(storyResult.isError, true);
  const story = (storyResult.structuredContent as {
    workItem: { id: string; key: string; criteria: Array<{ id: string }>; version: number };
  }).workItem;
  const blockedReady = await client.callTool({
    name: "work_item_gate_check",
    arguments: { projectId, itemIdOrKey: story.key, targetState: "ready" },
  });
  assert.notEqual(blockedReady.isError, true);
  assert.equal((blockedReady.structuredContent as { canProceed: boolean }).canProceed, false);

  const scenarioResult = await client.callTool({
    name: "scenario_create",
    arguments: {
      projectId,
      requestId: "workflow-scenario-create",
      key: "PAY-TC-01",
      kind: "acceptance",
      title: "Pedido confirmado",
      steps: [{ action: "Confirmar pedido válido", expected: "O identificador é retornado" }],
      coverage: [{ targetType: "criterion", reference: `${story.key}:AC-1` }],
    },
  });
  assert.notEqual(scenarioResult.isError, true);
  const scenarioId = (scenarioResult.structuredContent as { revision: { scenarioId: string } }).revision.scenarioId;
  const scenarioPublish = await client.callTool({
    name: "scenario_revision_publish",
    arguments: {
      projectId, requestId: "workflow-scenario-publish", scenarioIdOrKey: scenarioId,
      revisionNumber: 1, expectedVersion: 1,
    },
  });
  assert.notEqual(scenarioPublish.isError, true);

  const estimateProposal = await client.callTool({
    name: "work_item_estimate",
    arguments: {
      projectId,
      requestId: "workflow-estimate-propose",
      itemIdOrKey: story.id,
      unit: "points",
      value: 5,
      rationale: "Escopo de confirmação moderado.",
      expectedVersion: 1,
    },
  });
  assert.notEqual(estimateProposal.isError, true);
  const proposalId = (estimateProposal.structuredContent as { proposal: { id: string } }).proposal.id;
  const estimateConfirmation = await client.callTool({
    name: "work_item_estimate_confirm",
    arguments: {
      projectId, requestId: "workflow-estimate-confirm", itemIdOrKey: story.id,
      proposalId, expectedVersion: 2,
    },
  });
  assert.notEqual(estimateConfirmation.isError, true);
  const ready = await client.callTool({
    name: "work_item_transition",
    arguments: {
      projectId, requestId: "workflow-ready", itemIdOrKey: story.id,
      targetState: "ready", expectedVersion: 3, reason: "Critérios revisados pelo PO.",
    },
  });
  assert.notEqual(ready.isError, true);
  const readyValue = ready.structuredContent as {
    transition: { baselineId: string; itemVersion: number };
    baseline: { id: string; sequence: number };
    auditEventIds: string[];
  };
  assert.equal(readyValue.baseline.sequence, 1);
  assert.equal(readyValue.transition.baselineId, readyValue.baseline.id);
  assert.equal(readyValue.auditEventIds.length, 1);

  const milestoneResult = await client.callTool({
    name: "milestone_create",
    arguments: {
      projectId,
      requestId: "workflow-milestone",
      milestoneKey: "PAY-RELEASE-01",
      title: "Primeira entrega",
      goal: "Entregar confirmação confiável de pedidos.",
      targetDate: "2099-01-01",
      itemIdsOrKeys: [story.id],
      reason: "Escopo de teste da trilha MCP.",
    },
  });
  assert.notEqual(milestoneResult.isError, true);
  const milestoneId = (milestoneResult.structuredContent as { milestone: { id: string } }).milestone.id;
  const metricsResult = await client.callTool({
    name: "metrics_get",
    arguments: { projectId, milestoneId },
  });
  assert.notEqual(metricsResult.isError, true);
  const metrics = metricsResult.structuredContent as {
    selectedTeamId: string | null;
    forecast: { forecastId: string; status: string } | null;
  };
  assert.ok(metrics.forecast);
  const forecastHistoryResult = await client.callTool({
    name: "milestone_forecast_history",
    arguments: {
      projectId,
      milestoneIdOrKey: milestoneId,
      ...(metrics.selectedTeamId === null ? {} : { teamId: metrics.selectedTeamId }),
      limit: 5,
    },
  });
  assert.notEqual(forecastHistoryResult.isError, true);
  const forecasts = (forecastHistoryResult.structuredContent as { forecasts: Array<{ forecastId: string }> }).forecasts;
  assert.ok(forecasts.some(({ forecastId }) => forecastId === metrics.forecast?.forecastId));
  const recalculationResult = await client.callTool({
    name: "milestone_forecast_recalculate",
    arguments: { projectId, forecastId: metrics.forecast.forecastId },
  });
  assert.notEqual(recalculationResult.isError, true);
  assert.equal((recalculationResult.structuredContent as { status: string }).status, metrics.forecast.status);
  const forecastHistoryAfterRecalculation = await client.callTool({
    name: "milestone_forecast_history",
    arguments: {
      projectId,
      milestoneIdOrKey: milestoneId,
      ...(metrics.selectedTeamId === null ? {} : { teamId: metrics.selectedTeamId }),
      limit: 5,
    },
  });
  assert.notEqual(forecastHistoryAfterRecalculation.isError, true);
  assert.deepEqual(
    (forecastHistoryAfterRecalculation.structuredContent as { forecasts: Array<{ forecastId: string }> }).forecasts
      .map(({ forecastId }) => forecastId),
    forecasts.map(({ forecastId }) => forecastId),
    "recalculating an immutable forecast must not persist a new snapshot",
  );

  const evidence = await client.callTool({
    name: "evidence_add",
    arguments: {
      projectId,
      requestId: "workflow-evidence",
      itemIdOrKey: story.id,
      kind: "build",
      uri: "https://ci.example/builds/candidate-42",
      buildId: "candidate-42",
      description: "Build que será validado por QA.",
    },
  });
  assert.notEqual(evidence.isError, true);
  assert.equal((evidence.structuredContent as { evidence: { baselineId: string } }).evidence.baselineId, readyValue.baseline.id);

  for (const [targetState, expectedVersion] of [["in_progress", 4], ["in_review", 5], ["in_validation", 6]] as const) {
    const transition = await client.callTool({
      name: "work_item_transition",
      arguments: {
        projectId, requestId: `workflow-${targetState}`, itemIdOrKey: story.id,
        targetState, expectedVersion, reason: `Avançar para ${targetState}.`,
      },
    });
    assert.notEqual(transition.isError, true);
  }

  const runResult = await client.callTool({
    name: "test_run_record",
    arguments: {
      projectId,
      requestId: "workflow-run",
      scenarioIdOrKey: scenarioId,
      revisionNumber: 1,
      buildId: "candidate-42",
      result: "passed",
    },
  });
  assert.notEqual(runResult.isError, true);
  const runId = (runResult.structuredContent as { run: { id: string } }).run.id;
  const runHistoryResult = await client.callTool({
    name: "test_run_list",
    arguments: {
      projectId,
      scenarioIdOrKey: scenarioId,
      buildId: "candidate-42",
      result: "passed",
      limit: 10,
    },
  });
  assert.notEqual(runHistoryResult.isError, true);
  const runHistory = runHistoryResult.structuredContent as {
    runs: Array<{ id: string; scenarioId: string; revisionNumber: number; buildId: string; result: string }>;
    nextCursor: string | null;
    watermark: number;
  };
  assert.deepEqual(runHistory.runs.map(({ id, scenarioId: listedScenarioId, revisionNumber, buildId, result }) => ({
    id, scenarioId: listedScenarioId, revisionNumber, buildId, result,
  })), [{
    id: runId,
    scenarioId,
    revisionNumber: 1,
    buildId: "candidate-42",
    result: "passed",
  }]);
  assert.equal(runHistory.nextCursor, null);
  assert.ok(runHistory.watermark > 0);
  const qualityResult = await client.callTool({
    name: "work_item_quality_get",
    arguments: { projectId, itemIdOrKey: story.id },
  });
  assert.notEqual(qualityResult.isError, true);
  const quality = qualityResult.structuredContent as {
    mode: string;
    baseline: { sequence: number } | null;
    requiredCriteria: number;
    coveredRequiredCriteria: number;
    criteria: Array<{ covered: boolean; scenarios: Array<{ latestRuns: Array<{ run: { id: string } }> }> }>;
  };
  assert.equal(quality.mode, "pinned");
  assert.equal(quality.baseline?.sequence, 1);
  assert.deepEqual([quality.requiredCriteria, quality.coveredRequiredCriteria], [1, 1]);
  assert.ok(quality.criteria[0]?.covered);
  assert.ok(quality.criteria[0]?.scenarios[0]?.latestRuns.some(({ run }) => run.id === runId));
  const certificationResult = await client.callTool({
    name: "test_run_certify",
    arguments: {
      projectId,
      requestId: "workflow-certify",
      itemIdOrKey: story.id,
      runId,
      expectedVersion: 7,
      reason: "QA conferiu o cenário no build candidato.",
    },
  });
  assert.notEqual(certificationResult.isError, true);
  assert.equal((certificationResult.structuredContent as { certification: { runId: string } }).certification.runId, runId);

  const doneGate = await client.callTool({
    name: "work_item_gate_check",
    arguments: { projectId, itemIdOrKey: story.id, targetState: "done", buildId: "candidate-42" },
  });
  assert.notEqual(doneGate.isError, true);
  assert.equal((doneGate.structuredContent as { canProceed: boolean }).canProceed, true);
  const done = await client.callTool({
    name: "work_item_transition",
    arguments: {
      projectId, requestId: "workflow-done", itemIdOrKey: story.id,
      targetState: "done", expectedVersion: 8, reason: "QA aprovado para o build candidato.", buildId: "candidate-42",
    },
  });
  assert.notEqual(done.isError, true);
  assert.equal((done.structuredContent as { transition: { toState: string } }).transition.toState, "done");

  const evidenceList = await client.callTool({
    name: "evidence_list",
    arguments: { projectId, itemIdOrKey: story.id, limit: 10 },
  });
  assert.notEqual(evidenceList.isError, true);
  assert.equal((evidenceList.structuredContent as { evidence: Array<{ buildId: string | null }> }).evidence[0]?.buildId, "candidate-42");
});
