import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { initializeProject } from "../dist/src/application/initialize-project.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-demo-"));
const client = new Client({ name: "ssdd-mcp-demo", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repositoryRoot, "dist", "src", "cli.js"), "stdio", "--workspace", workspace],
});

async function callTool(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) {
    const text = result.content.find((block) => block.type === "text")?.text ?? "Unknown MCP error";
    throw new Error(`${name} failed: ${text}`);
  }
  assert.ok(result.structuredContent, `${name} did not return structured content`);
  return result.structuredContent;
}

try {
  const initialized = initializeProject({
    workspace,
    key: "PAY",
    name: "Payments demo",
    productGoal: "Demonstrate a traceable local delivery",
    timezone: "America/Sao_Paulo",
  });
  await client.connect(transport);

  const projectId = initialized.project.id;
  const epic = await callTool("work_item_create", {
    projectId, requestId: "demo-epic", type: "epic", title: "Reliable checkout",
  });
  const feature = await callTool("work_item_create", {
    projectId, requestId: "demo-feature", type: "feature", parentId: epic.workItem.id, title: "Order confirmation",
  });
  const story = await callTool("work_item_create", {
    projectId,
    requestId: "demo-story",
    type: "story",
    parentId: feature.workItem.id,
    title: "Confirm a valid order",
    description: "Persist the order and return its identifier.",
    criteria: [{ description: "A valid order returns a unique identifier" }],
  });

  const scenario = await callTool("scenario_create", {
    projectId,
    requestId: "demo-scenario-create",
    key: "PAY-TC-01",
    kind: "acceptance",
    title: "Order confirmation returns its identifier",
    steps: [{ action: "Confirm a valid order", expected: "A unique order identifier is returned" }],
    coverage: [{ targetType: "criterion", reference: `${story.workItem.key}:AC-1` }],
  });
  await callTool("scenario_revision_publish", {
    projectId,
    requestId: "demo-scenario-publish",
    scenarioIdOrKey: scenario.revision.scenarioId,
    revisionNumber: 1,
    expectedVersion: 1,
  });

  const proposal = await callTool("work_item_estimate", {
    projectId,
    requestId: "demo-estimate-propose",
    itemIdOrKey: story.workItem.id,
    unit: "points",
    value: 3,
    rationale: "Small, bounded delivery slice.",
    expectedVersion: 1,
  });
  await callTool("work_item_estimate_confirm", {
    projectId,
    requestId: "demo-estimate-confirm",
    itemIdOrKey: story.workItem.id,
    proposalId: proposal.proposal.id,
    expectedVersion: 2,
  });

  const readyGates = await callTool("work_item_gate_check", {
    projectId, itemIdOrKey: story.workItem.key, targetState: "ready",
  });
  assert.equal(readyGates.canProceed, true, "PBI must meet Ready gates before the PO transition");
  const ready = await callTool("work_item_transition", {
    projectId,
    requestId: "demo-ready",
    itemIdOrKey: story.workItem.id,
    targetState: "ready",
    expectedVersion: 3,
    reason: "PO approved the published criteria and estimate.",
  });

  const candidateBuild = "demo-build-1";
  await callTool("evidence_add", {
    projectId,
    requestId: "demo-evidence",
    itemIdOrKey: story.workItem.id,
    kind: "build",
    uri: "https://ci.example/builds/demo-build-1",
    buildId: candidateBuild,
    description: "Candidate build for QA validation.",
  });
  for (const [targetState, expectedVersion] of [["in_progress", 4], ["in_review", 5], ["in_validation", 6]]) {
    await callTool("work_item_transition", {
      projectId,
      requestId: `demo-${targetState}`,
      itemIdOrKey: story.workItem.id,
      targetState,
      expectedVersion,
      reason: `Move delivery to ${targetState}.`,
    });
  }

  const run = await callTool("test_run_record", {
    projectId,
    requestId: "demo-test-run",
    scenarioIdOrKey: scenario.revision.scenarioId,
    revisionNumber: 1,
    buildId: candidateBuild,
    result: "passed",
    notes: "QA replayed the published acceptance scenario.",
  });
  const certification = await callTool("test_run_certify", {
    projectId,
    requestId: "demo-qa-certification",
    itemIdOrKey: story.workItem.id,
    runId: run.run.id,
    expectedVersion: 7,
    reason: "QA approved the latest passing run for the candidate build.",
  });
  const doneGates = await callTool("work_item_gate_check", {
    projectId, itemIdOrKey: story.workItem.id, targetState: "done", buildId: candidateBuild,
  });
  assert.equal(doneGates.canProceed, true, "PBI must meet Done gates after QA certification");
  await callTool("work_item_transition", {
    projectId,
    requestId: "demo-done",
    itemIdOrKey: story.workItem.id,
    targetState: "done",
    expectedVersion: 8,
    reason: "QA passed and the candidate build has traceable evidence.",
    buildId: candidateBuild,
  });

  process.stdout.write(`${JSON.stringify({
    status: "completed",
    project: initialized.project.key,
    workItem: story.workItem.key,
    baselineSequence: ready.baseline.sequence,
    candidateBuild,
    certifiedRunId: certification.certification.runId,
    finalState: "done",
  }, null, 2)}\n`);
} finally {
  await client.close();
  rmSync(workspace, { recursive: true, force: true });
}
