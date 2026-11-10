import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { initializeProject } from "../../src/application/initialize-project.js";
import { packageVersion } from "../../src/package-version.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";

test("stdio exposes project and work item tools through a real MCP client", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-stdio-"));
  initializeProject({
    workspace,
    key: "PAY",
    name: "Payments",
    productGoal: "Pagamentos confiáveis",
    timezone: "America/Sao_Paulo",
  });

  const cliPath = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const client = new Client({ name: "ssdd-mcp-tests", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "stdio", "--workspace", workspace],
  });

  context.after(async () => {
    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, packageVersion);
  const listedTools = await client.listTools();
  assert.deepEqual(
    listedTools.tools.map((tool) => tool.name).sort(),
    [
      "approval_issue",
      "approval_revoke",
      "azure_work_item_import_apply",
      "azure_work_item_import_preview",
      "baseline_fix",
      "baseline_get",
      "baseline_revalidate",
      "comment_add",
      "comment_list",
      "definition_of_done_get",
      "definition_of_done_set",
      "evidence_add",
      "evidence_list",
      "github_issue_import_apply",
      "github_issue_import_preview",
      "github_reference_list",
      "impact_list",
      "metrics_get",
      "milestone_create",
      "milestone_get",
      "milestone_list",
      "milestone_scope_change",
      "project_get",
      "project_list",
      "scenario_create",
      "scenario_criterion_search",
      "scenario_get",
      "scenario_list",
      "scenario_revision_propose",
      "scenario_revision_publish",
      "spec_create",
      "spec_get",
      "spec_list",
      "spec_revision_propose",
      "spec_revision_publish",
      "sprint_cancel",
      "sprint_close",
      "sprint_draft",
      "sprint_get",
      "sprint_list",
      "sprint_retrospective_get",
      "sprint_retrospective_set",
      "sprint_scope_change",
      "sprint_start",
      "task_context_get",
      "team_capacity_get",
      "team_capacity_set",
      "team_create",
      "team_list",
      "test_run_certify",
      "test_run_record",
      "trace_link_add",
      "trace_link_remove",
      "trace_query",
      "work_item_assign",
      "work_item_create",
      "work_item_estimate",
      "work_item_estimate_confirm",
      "work_item_gate_check",
      "work_item_get",
      "work_item_list",
      "work_item_rank",
      "work_item_revision_list",
      "work_item_revision_propose",
      "work_item_revision_publish",
      "work_item_transition",
    ],
  );
  const resourceTemplates = await client.listResourceTemplates();
  assert.ok(resourceTemplates.resourceTemplates.some((resource) => resource.name === "task-context"));
  assert.ok(resourceTemplates.resourceTemplates.some((resource) => resource.name === "work-item-revision"));
  assert.ok(resourceTemplates.resourceTemplates.some((resource) => resource.name === "specification-revision"));
  assert.ok(resourceTemplates.resourceTemplates.some((resource) => resource.name === "scenario-revision"));
  assert.ok(resourceTemplates.resourceTemplates.some((resource) => resource.name === "test-run"));

  const listResult = await client.callTool({ name: "project_list", arguments: {} });
  assert.notEqual(listResult.isError, true);
  assert.ok(listResult.structuredContent);
  const listed = listResult.structuredContent as {
    projects: Array<{ id: string; key: string; roles: string[] }>;
  };
  assert.equal(listed.projects.length, 1);
  assert.equal(listed.projects[0]?.key, "PAY");
  assert.ok(listed.projects[0]?.roles.includes("admin"));

  const projectId = listed.projects[0]?.id;
  assert.ok(projectId);
  const dodSetResult = await client.callTool({
    name: "definition_of_done_set",
    arguments: {
      projectId,
      requestId: "stdio-dod-set",
      expectedVersion: 0,
      criteria: [{ description: "Critérios aceitos e evidências preservadas." }],
      reason: "Definição inicial do projeto.",
    },
  });
  assert.notEqual(dodSetResult.isError, true);
  const dodRevision = (dodSetResult.structuredContent as { revision: { revisionNumber: number } }).revision;
  assert.equal(dodRevision.revisionNumber, 1);
  const dodGetResult = await client.callTool({ name: "definition_of_done_get", arguments: { projectId } });
  assert.notEqual(dodGetResult.isError, true);
  assert.equal((dodGetResult.structuredContent as { revisionNumber: number }).revisionNumber, 1);
  const emptySprints = await client.callTool({ name: "sprint_list", arguments: { projectId } });
  assert.notEqual(emptySprints.isError, true);
  assert.deepEqual((emptySprints.structuredContent as { sprints: unknown[] }).sprints, []);

  const localDatabase = openSqliteDatabase(join(workspace, ".ssdd", "ssdd.sqlite"));
  const principalId = (localDatabase
    .prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
    .get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
  localDatabase.close();
  const detailResult = await client.callTool({
    name: "project_get",
    arguments: { projectId },
  });
  assert.notEqual(detailResult.isError, true);
  assert.ok(detailResult.structuredContent);
  const details = detailResult.structuredContent as {
    project: { productGoal: string; timezone: string; version: number };
  };
  assert.equal(details.project.productGoal, "Pagamentos confiáveis");
  assert.equal(details.project.timezone, "America/Sao_Paulo");
  assert.equal(details.project.version, 1);

  const epicResult = await client.callTool({
    name: "work_item_create",
    arguments: {
      projectId,
      requestId: "stdio-epic-1",
      type: "epic",
      title: "Pagamentos seguros",
    },
  });
  assert.notEqual(epicResult.isError, true);
  assert.ok(epicResult.structuredContent);
  const epic = epicResult.structuredContent as {
    workItem: { id: string; key: string; type: string };
    auditEventIds: string[];
  };
  assert.equal(epic.workItem.key, "PAY-1");
  assert.equal(epic.workItem.type, "epic");
  assert.equal(epic.auditEventIds.length, 1);

  const featureResult = await client.callTool({
    name: "work_item_create",
    arguments: {
      projectId,
      requestId: "stdio-feature-1",
      type: "feature",
      parentId: epic.workItem.id,
      title: "Autenticação forte",
    },
  });
  assert.notEqual(featureResult.isError, true);
  assert.ok(featureResult.structuredContent);
  const feature = featureResult.structuredContent as { workItem: { id: string; key: string } };

  const storyResult = await client.callTool({
    name: "work_item_create",
    arguments: {
      projectId,
      requestId: "stdio-story-1",
      type: "story",
      parentId: feature.workItem.id,
      title: "Entrar com fator adicional",
      criteria: [{ description: "O segundo fator é solicitado após a senha" }],
    },
  });
  assert.notEqual(storyResult.isError, true);
  assert.ok(storyResult.structuredContent);
  const story = storyResult.structuredContent as {
    workItem: { id: string; key: string; criteria: Array<{ id: string; key: string; description: string }> };
  };
  assert.equal(story.workItem.key, "PAY-3");
  assert.equal(story.workItem.criteria[0]?.key, "AC-1");

  const readResult = await client.callTool({
    name: "work_item_get",
    arguments: { projectId, itemIdOrKey: story.workItem.key },
  });
  assert.notEqual(readResult.isError, true);
  assert.ok(readResult.structuredContent);
  const read = readResult.structuredContent as { workItem: { id: string; parentId: string } };
  assert.equal(read.workItem.id, story.workItem.id);
  assert.equal(read.workItem.parentId, feature.workItem.id);

  const backlogResult = await client.callTool({
    name: "work_item_list",
    arguments: { projectId, types: ["story"], search: "fator adicional", limit: 10 },
  });
  assert.notEqual(backlogResult.isError, true);
  assert.ok(backlogResult.structuredContent);
  const backlog = backlogResult.structuredContent as {
    items: Array<{ id: string; key: string; type: string }>;
    nextCursor: string | null;
  };
  assert.deepEqual(backlog.items, [{
    id: story.workItem.id,
    key: "PAY-3",
    type: "story",
    parentId: feature.workItem.id,
    assigneeId: null,
    title: "Entrar com fator adicional",
    state: "draft",
    priority: 2,
    rank: 1024,
    version: 1,
    revision: 1,
    updatedAt: (storyResult.structuredContent as { workItem: { updatedAt: string } }).workItem.updatedAt,
  }]);
  assert.equal(backlog.nextCursor, null);

  const secondStoryResult = await client.callTool({
    name: "work_item_create",
    arguments: {
      projectId,
      requestId: "stdio-story-2",
      type: "story",
      parentId: feature.workItem.id,
      title: "Recuperar acesso",
    },
  });
  assert.notEqual(secondStoryResult.isError, true);
  assert.ok(secondStoryResult.structuredContent);
  const secondStory = secondStoryResult.structuredContent as { workItem: { id: string; key: string } };
  const ranked = await client.callTool({
    name: "work_item_rank",
    arguments: {
      projectId,
      requestId: "stdio-rank-story-2",
      itemIdOrKey: secondStory.workItem.id,
      beforeIdOrKey: story.workItem.id,
      expectedVersion: 1,
    },
  });
  assert.notEqual(ranked.isError, true);
  assert.equal((ranked.structuredContent as { rank: { rank: number; version: number } }).rank.rank, 1024);
  const reordered = await client.callTool({
    name: "work_item_list",
    arguments: { projectId, types: ["story"], parentId: feature.workItem.id },
  });
  assert.notEqual(reordered.isError, true);
  assert.deepEqual(
    (reordered.structuredContent as { items: Array<{ id: string }> }).items.map((item) => item.id),
    [secondStory.workItem.id, story.workItem.id],
  );

  const assignment = await client.callTool({
    name: "work_item_assign",
    arguments: {
      projectId,
      requestId: "stdio-assign-story",
      itemIdOrKey: story.workItem.id,
      assigneeId: principalId,
      expectedVersion: 2,
    },
  });
  assert.notEqual(assignment.isError, true);
  assert.equal((assignment.structuredContent as { assignment: { assigneeId: string } }).assignment.assigneeId, principalId);

  for (const [requestId, body] of [["stdio-comment-1", "Início revisado"], ["stdio-comment-2", "Critério validado"]]) {
    const comment = await client.callTool({
      name: "comment_add",
      arguments: { projectId, requestId, itemIdOrKey: story.workItem.id, body },
    });
    assert.notEqual(comment.isError, true);
  }
  const firstCommentPage = await client.callTool({
    name: "comment_list",
    arguments: { projectId, itemIdOrKey: story.workItem.id, limit: 1 },
  });
  assert.notEqual(firstCommentPage.isError, true);
  const commentPage = firstCommentPage.structuredContent as { comments: Array<{ body: string }>; nextCursor: string | null };
  assert.equal(commentPage.comments[0]?.body, "Início revisado");
  assert.ok(commentPage.nextCursor);
  const nextCommentPage = await client.callTool({
    name: "comment_list",
    arguments: { projectId, itemIdOrKey: story.workItem.id, limit: 1, cursor: commentPage.nextCursor },
  });
  assert.equal((nextCommentPage.structuredContent as { comments: Array<{ body: string }> }).comments[0]?.body, "Critério validado");

  const estimate = await client.callTool({
    name: "work_item_estimate",
    arguments: {
      projectId,
      requestId: "stdio-estimate-story",
      itemIdOrKey: story.workItem.id,
      unit: "points",
      value: 5,
      rationale: "Escopo moderado",
      expectedVersion: 3,
    },
  });
  assert.notEqual(estimate.isError, true);
  const proposalId = (estimate.structuredContent as { proposal: { id: string } }).proposal.id;
  const estimateConfirmation = await client.callTool({
    name: "work_item_estimate_confirm",
    arguments: {
      projectId,
      requestId: "stdio-estimate-confirm",
      itemIdOrKey: story.workItem.id,
      proposalId,
      expectedVersion: 4,
    },
  });
  assert.notEqual(estimateConfirmation.isError, true);
  const updatedStory = await client.callTool({
    name: "work_item_get",
    arguments: { projectId, itemIdOrKey: story.workItem.id },
  });
  assert.notEqual(updatedStory.isError, true);
  const updated = updatedStory.structuredContent as { workItem: { version: number; estimates: Array<{ unit: string; value: number }> } };
  assert.equal(updated.workItem.version, 5);
  assert.deepEqual(updated.workItem.estimates.map(({ unit, value }) => ({ unit, value })), [{ unit: "points", value: 5 }]);

  const revisionProposal = await client.callTool({
    name: "work_item_revision_propose",
    arguments: {
      projectId,
      requestId: "stdio-work-item-revision-propose",
      itemIdOrKey: story.workItem.id,
      expectedVersion: 5,
      title: "Entrar com fator adicional e acompanhar sessão",
      criteria: [
        { id: story.workItem.criteria[0]!.id, description: "O segundo fator é validado após a senha" },
        { description: "A sessão mostra o horário da última autenticação" },
      ],
    },
  });
  assert.notEqual(revisionProposal.isError, true);
  const proposedRevision = (revisionProposal.structuredContent as {
    revision: { revisionNumber: number; status: string; snapshot: { criteria: Array<{ id: string }> } };
  }).revision;
  assert.equal(proposedRevision.revisionNumber, 2);
  assert.equal(proposedRevision.status, "draft");
  assert.equal(proposedRevision.snapshot.criteria[0]?.id, story.workItem.criteria[0]?.id);
  const revisionHistory = await client.callTool({
    name: "work_item_revision_list",
    arguments: { projectId, itemIdOrKey: story.workItem.id },
  });
  assert.notEqual(revisionHistory.isError, true);
  assert.equal(
    (revisionHistory.structuredContent as { revisions: Array<{ status: string }> }).revisions[1]?.status,
    "draft",
  );
  const publishedRevision = await client.callTool({
    name: "work_item_revision_publish",
    arguments: {
      projectId,
      requestId: "stdio-work-item-revision-publish",
      itemIdOrKey: story.workItem.id,
      revisionNumber: 2,
      expectedVersion: 6,
    },
  });
  assert.notEqual(publishedRevision.isError, true);
  const publishedItem = await client.callTool({
    name: "work_item_get",
    arguments: { projectId, itemIdOrKey: story.workItem.id },
  });
  const published = (publishedItem.structuredContent as {
    workItem: { title: string; version: number; revision: number; criteria: Array<{ id: string }> };
  }).workItem;
  assert.equal(published.title, "Entrar com fator adicional e acompanhar sessão");
  assert.equal(published.version, 7);
  assert.equal(published.revision, 2);
  assert.equal(published.criteria[0]?.id, story.workItem.criteria[0]?.id);
  const workItemRevisionResource = await client.readResource({
    uri: `ssdd://projects/${projectId}/work-items/${story.workItem.key}/revisions/2`,
  });
  const workItemRevisionText = workItemRevisionResource.contents[0];
  assert.ok(workItemRevisionText && "text" in workItemRevisionText);
  assert.equal(JSON.parse(workItemRevisionText.text).revisionNumber, 2);

  const scenarioCreated = await client.callTool({
    name: "scenario_create",
    arguments: {
      projectId,
      requestId: "stdio-scenario-create",
      key: "PAY-TC-01",
      kind: "acceptance",
      title: "Autenticar com fator adicional",
      preconditions: ["Usuário tem conta ativa"],
      steps: [{ action: "Informar senha e código", expected: "A sessão é autenticada" }],
      coverage: [{ targetType: "criterion", reference: "PAY-3:AC-1" }],
    },
  });
  assert.notEqual(scenarioCreated.isError, true);
  const createdScenario = (scenarioCreated.structuredContent as {
    revision: { scenarioId: string; revisionNumber: number };
  }).revision;
  const scenarioPublished = await client.callTool({
    name: "scenario_revision_publish",
    arguments: {
      projectId,
      requestId: "stdio-scenario-publish",
      scenarioIdOrKey: "PAY-TC-01",
      revisionNumber: 1,
      expectedVersion: 1,
    },
  });
  assert.notEqual(scenarioPublished.isError, true);
  const scenarioRevisionResource = await client.readResource({
    uri: `ssdd://projects/${projectId}/scenarios/PAY-TC-01/revisions/1`,
  });
  const scenarioRevisionText = scenarioRevisionResource.contents[0];
  assert.ok(scenarioRevisionText && "text" in scenarioRevisionText);
  assert.equal(JSON.parse(scenarioRevisionText.text).revisionNumber, 1);
  const recordedPassed = await client.callTool({
    name: "test_run_record",
    arguments: {
      projectId,
      requestId: "stdio-test-run-passed",
      scenarioIdOrKey: createdScenario.scenarioId,
      revisionNumber: 1,
      buildId: "ci-build-42",
      result: "passed",
    },
  });
  assert.notEqual(recordedPassed.isError, true);
  const passedRunId = (recordedPassed.structuredContent as { run: { id: string } }).run.id;
  const testRunResource = await client.readResource({ uri: `ssdd://projects/${projectId}/test-runs/${passedRunId}` });
  const testRunText = testRunResource.contents[0];
  assert.ok(testRunText && "text" in testRunText);
  assert.equal(JSON.parse(testRunText.text).result, "passed");
  const recordedFailed = await client.callTool({
    name: "test_run_record",
    arguments: {
      projectId,
      requestId: "stdio-test-run-failed",
      scenarioIdOrKey: "PAY-TC-01",
      revisionNumber: 1,
      buildId: "ci-build-42",
      result: "failed",
    },
  });
  assert.notEqual(recordedFailed.isError, true);
  const scenarioSearch = await client.callTool({
    name: "scenario_criterion_search",
    arguments: { projectId, criterionRef: "PAY-3:AC-1" },
  });
  assert.notEqual(scenarioSearch.isError, true);
  const scenarioMatch = (scenarioSearch.structuredContent as {
    matches: Array<{ revision: { revisionNumber: number }; resultsByBuild: Array<{ buildId: string; result: string }> }>;
  }).matches[0];
  assert.equal(scenarioMatch?.revision.revisionNumber, 1);
  assert.deepEqual(scenarioMatch?.resultsByBuild.map(({ buildId, result }) => ({ buildId, result })), [
    { buildId: "ci-build-42", result: "failed" },
  ]);

  const taskCreated = await client.callTool({
    name: "work_item_create",
    arguments: {
      projectId,
      requestId: "stdio-task-create",
      type: "task",
      parentId: story.workItem.id,
      title: "Implementar validação do fator adicional",
    },
  });
  assert.notEqual(taskCreated.isError, true);
  const task = (taskCreated.structuredContent as { workItem: { id: string; key: string } }).workItem;
  const qaContext = await client.callTool({
    name: "task_context_get",
    arguments: { projectId, taskIdOrKey: task.key, profile: "qa" },
  });
  assert.notEqual(qaContext.isError, true);
  const qaContextValue = qaContext.structuredContent as {
    mode: string;
    sections: { scenarios: Array<{ key: string }>; testRuns: Array<{ content: { result: string } }> };
  };
  assert.equal(qaContextValue.mode, "preview");
  assert.ok(qaContextValue.sections.scenarios.some((entry) => entry.key === "PAY-TC-01"));
  assert.equal(qaContextValue.sections.testRuns[0]?.content.result, "failed");
  const taskContextResource = await client.readResource({
    uri: `ssdd://projects/${projectId}/tasks/${task.key}/context?profile=qa`,
  });
  const taskContextText = taskContextResource.contents[0];
  assert.ok(taskContextText && "text" in taskContextText);
  assert.equal(JSON.parse(taskContextText.text).profile, "qa");

  const specCreated = await client.callTool({
    name: "spec_create",
    arguments: {
      projectId,
      requestId: "stdio-spec-create",
      key: "BR-04",
      kind: "business_rule",
      title: "Instante de corte",
      content: { text: "O cancelamento ocorre antes do horário de corte." },
    },
  });
  assert.notEqual(specCreated.isError, true);
  assert.ok(specCreated.structuredContent);

  const specPublishFirst = await client.callTool({
    name: "spec_revision_publish",
    arguments: {
      projectId,
      requestId: "stdio-spec-publish-1",
      specIdOrKey: "BR-04",
      revisionNumber: 1,
      expectedVersion: 1,
    },
  });
  assert.notEqual(specPublishFirst.isError, true);

  const specProposal = await client.callTool({
    name: "spec_revision_propose",
    arguments: {
      projectId,
      requestId: "stdio-spec-propose-2",
      specIdOrKey: "BR-04",
      expectedVersion: 2,
      content: { text: "O corte usa o instante da autorização do pagamento." },
    },
  });
  assert.notEqual(specProposal.isError, true);

  const specPublishSecond = await client.callTool({
    name: "spec_revision_publish",
    arguments: {
      projectId,
      requestId: "stdio-spec-publish-2",
      specIdOrKey: "BR-04",
      revisionNumber: 2,
      expectedVersion: 3,
    },
  });
  assert.notEqual(specPublishSecond.isError, true);

  const specRead = await client.callTool({
    name: "spec_get",
    arguments: { projectId, specIdOrKey: "br-04" },
  });
  assert.notEqual(specRead.isError, true);
  assert.ok(specRead.structuredContent);
  const spec = specRead.structuredContent as {
    specification: {
      publishedRevision: number;
      revisions: Array<{ revisionNumber: number; status: string }>;
    };
  };
  assert.equal(spec.specification.publishedRevision, 2);
  assert.deepEqual(spec.specification.revisions.map(({ revisionNumber, status }) => ({ revisionNumber, status })), [
    { revisionNumber: 1, status: "superseded" },
    { revisionNumber: 2, status: "published" },
  ]);
  const specificationRevisionResource = await client.readResource({
    uri: `ssdd://projects/${projectId}/specs/BR-04/revisions/2`,
  });
  const specificationRevisionText = specificationRevisionResource.contents[0];
  assert.ok(specificationRevisionText && "text" in specificationRevisionText);
  assert.equal(JSON.parse(specificationRevisionText.text).revisionNumber, 2);

  const specList = await client.callTool({
    name: "spec_list",
    arguments: { projectId, kind: "business_rule" },
  });
  assert.notEqual(specList.isError, true);
  assert.ok(specList.structuredContent);
  assert.equal(
    (specList.structuredContent as { specifications: Array<{ key: string }> }).specifications[0]?.key,
    "BR-04",
  );

  const traceLinkResult = await client.callTool({
    name: "trace_link_add",
    arguments: {
      projectId,
      requestId: "stdio-implements-rule",
      sourceIdOrKey: story.workItem.id,
      targetIdOrKey: "BR-04",
      type: "implements",
    },
  });
  assert.notEqual(traceLinkResult.isError, true);
  assert.ok(traceLinkResult.structuredContent);
  const traceLink = traceLinkResult.structuredContent as { link: { id: string } };

  const traceResult = await client.callTool({
    name: "trace_query",
    arguments: {
      projectId,
      nodeIdOrKey: "BR-04",
      direction: "inbound",
      linkTypes: ["implements"],
      depth: 2,
    },
  });
  assert.notEqual(traceResult.isError, true);
  assert.ok(traceResult.structuredContent);
  const graph = traceResult.structuredContent as {
    nodes: Array<{ id: string; key: string }>;
    links: Array<{ type: string }>;
  };
  assert.ok(graph.nodes.some((node) => node.id === story.workItem.id));
  assert.equal(graph.links[0]?.type, "implements");

  const readyDatabase = openSqliteDatabase(join(workspace, ".ssdd", "ssdd.sqlite"));
  readyDatabase.prepare("UPDATE work_items SET state = 'ready' WHERE project_id = ? AND item_id = ?")
    .run(projectId, story.workItem.id);
  readyDatabase.close();
  const fixedBaseline = await client.callTool({
    name: "baseline_fix",
    arguments: {
      projectId,
      requestId: "stdio-baseline-fix",
      itemIdOrKey: story.workItem.id,
      expectedVersion: 7,
      reason: "PO aceitou critérios e regra para implementação",
    },
  });
  assert.notEqual(fixedBaseline.isError, true);
  const baselineOne = (fixedBaseline.structuredContent as {
    baseline: { sequence: number; references: Array<{ entityType: string; key: string; revisionNumber: number }> };
  }).baseline;
  assert.equal(baselineOne.sequence, 1);
  assert.ok(baselineOne.references.some((reference) =>
    reference.entityType === "specification_revision" && reference.key === "BR-04" && reference.revisionNumber === 2,
  ));

  const specProposalThird = await client.callTool({
    name: "spec_revision_propose",
    arguments: {
      projectId,
      requestId: "stdio-spec-propose-3",
      specIdOrKey: "BR-04",
      expectedVersion: 4,
      content: { text: "O corte usa o instante registrado na confirmação do pagamento." },
    },
  });
  assert.notEqual(specProposalThird.isError, true);
  const specPublishThird = await client.callTool({
    name: "spec_revision_publish",
    arguments: {
      projectId,
      requestId: "stdio-spec-publish-3",
      specIdOrKey: "BR-04",
      revisionNumber: 3,
      expectedVersion: 5,
    },
  });
  assert.notEqual(specPublishThird.isError, true);
  const impacts = await client.callTool({
    name: "impact_list",
    arguments: { projectId, itemIdOrKey: story.workItem.id, status: "open" },
  });
  assert.notEqual(impacts.isError, true);
  const openImpacts = (impacts.structuredContent as { impacts: Array<{ baselineRevision: number; publishedRevision: number }> }).impacts;
  assert.deepEqual(openImpacts.map(({ baselineRevision, publishedRevision }) => ({ baselineRevision, publishedRevision })), [
    { baselineRevision: 2, publishedRevision: 3 },
  ]);
  const revalidated = await client.callTool({
    name: "baseline_revalidate",
    arguments: {
      projectId,
      requestId: "stdio-baseline-revalidate",
      itemIdOrKey: story.workItem.id,
      expectedVersion: 9,
      reason: "PO revisou a mudança de regra e aprovou o impacto",
    },
  });
  assert.notEqual(revalidated.isError, true);
  const baselineTwo = (revalidated.structuredContent as { baseline: { id: string; sequence: number } }).baseline;
  assert.equal(baselineTwo.sequence, 2);
  const resolvedImpacts = await client.callTool({
    name: "impact_list",
    arguments: { projectId, itemIdOrKey: story.workItem.id, status: "revalidated" },
  });
  assert.equal((resolvedImpacts.structuredContent as { impacts: unknown[] }).impacts.length, 1);
  const historicalBaseline = await client.callTool({
    name: "baseline_get",
    arguments: { projectId, itemIdOrKey: story.workItem.id, sequence: 1 },
  });
  assert.notEqual(historicalBaseline.isError, true);
  assert.ok((historicalBaseline.structuredContent as {
    baseline: { references: Array<{ entityType: string; key: string; revisionNumber: number }> };
  }).baseline.references.some((reference) =>
    reference.entityType === "specification_revision" && reference.key === "BR-04" && reference.revisionNumber === 2,
  ));

  const milestoneCreated = await client.callTool({
    name: "milestone_create",
    arguments: {
      projectId,
      requestId: "stdio-milestone-create",
      milestoneKey: "PAY-M1",
      title: "Primeiro lançamento",
      goal: "Entregar o fluxo mínimo de pagamentos.",
      targetDate: "2026-12-15",
      itemIdsOrKeys: [story.workItem.id],
      reason: "PO aprova o escopo inicial do lançamento.",
    },
  });
  assert.notEqual(milestoneCreated.isError, true);
  const createdMilestone = (milestoneCreated.structuredContent as {
    milestone: { id: string; key: string; version: number; scope: Array<{ itemId: string; baselineId: string }> };
    auditEventIds: string[];
  }).milestone;
  assert.equal(createdMilestone.version, 1);
  assert.equal(createdMilestone.scope[0]?.itemId, story.workItem.id);
  assert.equal(createdMilestone.scope[0]?.baselineId, baselineTwo.id);
  const milestonesListed = await client.callTool({ name: "milestone_list", arguments: { projectId } });
  assert.notEqual(milestonesListed.isError, true);
  assert.equal((milestonesListed.structuredContent as { milestones: Array<{ key: string; scopeItemCount: number }> })
    .milestones[0]?.scopeItemCount, 1);
  const milestoneRead = await client.callTool({
    name: "milestone_get", arguments: { projectId, milestoneIdOrKey: createdMilestone.key },
  });
  assert.notEqual(milestoneRead.isError, true);
  assert.equal((milestoneRead.structuredContent as { milestone: { id: string } }).milestone.id, createdMilestone.id);
  const milestoneRemoved = await client.callTool({
    name: "milestone_scope_change",
    arguments: {
      projectId,
      requestId: "stdio-milestone-remove",
      milestoneIdOrKey: createdMilestone.id,
      expectedVersion: 1,
      removeItemIdsOrKeys: [story.workItem.key],
      reason: "PO remove o PBI após revisar a prioridade.",
    },
  });
  assert.notEqual(milestoneRemoved.isError, true);
  const removedMilestone = (milestoneRemoved.structuredContent as {
    milestone: { version: number; scope: unknown[]; scopeHistory: Array<{ action: string }> };
  }).milestone;
  assert.equal(removedMilestone.version, 2);
  assert.equal(removedMilestone.scope.length, 0);
  assert.deepEqual(removedMilestone.scopeHistory.map((event) => event.action), ["add", "remove"]);
  const milestoneAdded = await client.callTool({
    name: "milestone_scope_change",
    arguments: {
      projectId,
      requestId: "stdio-milestone-add",
      milestoneIdOrKey: createdMilestone.key,
      expectedVersion: 2,
      addItemIdsOrKeys: [story.workItem.id],
      reason: "PO reavalia e aprova o PBI novamente.",
    },
  });
  assert.notEqual(milestoneAdded.isError, true);
  const restoredMilestone = (milestoneAdded.structuredContent as {
    milestone: { version: number; scope: Array<{ itemId: string }>; scopeHistory: Array<{ action: string }> };
    auditEventIds: string[];
  }).milestone;
  assert.equal(restoredMilestone.version, 3);
  assert.deepEqual(restoredMilestone.scope.map((item) => item.itemId), [story.workItem.id]);
  assert.deepEqual(restoredMilestone.scopeHistory.map((event) => event.action), ["add", "remove", "add"]);

  const traceRemoved = await client.callTool({
    name: "trace_link_remove",
    arguments: { projectId, requestId: "stdio-remove-link", linkId: traceLink.link.id },
  });
  assert.notEqual(traceRemoved.isError, true);
  assert.ok(traceRemoved.structuredContent);
  const afterRemoval = await client.callTool({
    name: "trace_query",
    arguments: {
      projectId,
      nodeIdOrKey: "BR-04",
      direction: "inbound",
      linkTypes: ["implements"],
      depth: 2,
    },
  });
  assert.notEqual(afterRemoval.isError, true);
  assert.ok(afterRemoval.structuredContent);
  assert.equal((afterRemoval.structuredContent as { links: unknown[] }).links.length, 0);

  const capacityConfigured = await client.callTool({
    name: "team_capacity_set",
    arguments: {
      projectId,
      requestId: "stdio-sprint-capacity",
      expectedVersion: 0,
      teamName: "Payments delivery",
      timezone: "America/Sao_Paulo",
      hoursPerDay: 6,
      workingDays: [1, 2, 3, 4, 5],
      members: [{ principalId, dedicationPercent: 100 }],
      reason: "Capacidade para a sprint de integração.",
    },
  });
  assert.notEqual(capacityConfigured.isError, true);
  const sprintDraft = await client.callTool({
    name: "sprint_draft",
    arguments: {
      projectId,
      requestId: "stdio-sprint-draft",
      sprintKey: "PAY-S1",
      title: "Sprint de integração",
      goal: "Fechar o primeiro incremento de pagamentos.",
      startsOn: "2026-11-09",
      endsOn: "2026-11-13",
      itemIdsOrKeys: [story.workItem.id],
      reason: "Selecionar o PBI Ready com baseline.",
    },
  });
  assert.notEqual(sprintDraft.isError, true);
  assert.ok(sprintDraft.structuredContent);
  const drafted = (sprintDraft.structuredContent as { sprint: { id: string; version: number; scope: Array<{ itemId: string }> } }).sprint;
  assert.equal(drafted.version, 1);
  assert.deepEqual(drafted.scope.map((item) => item.itemId), [story.workItem.id]);
  const sprintStarted = await client.callTool({
    name: "sprint_start",
    arguments: {
      projectId,
      requestId: "stdio-sprint-start",
      sprintIdOrKey: drafted.id,
      expectedVersion: 1,
      reason: "PO inicia a sprint planejada.",
    },
  });
  assert.notEqual(sprintStarted.isError, true);
  assert.ok(sprintStarted.structuredContent);
  const started = (sprintStarted.structuredContent as {
    sprint: { status: string; startedSnapshot: { capacity: { totalHours: number }; commitments: unknown[] } };
  }).sprint;
  assert.equal(started.status, "active");
  assert.equal(started.startedSnapshot.capacity.totalHours, 30);
  assert.equal(started.startedSnapshot.commitments.length, 1);
  const sprintRead = await client.callTool({
    name: "sprint_get",
    arguments: { projectId, sprintIdOrKey: "PAY-S1" },
  });
  assert.notEqual(sprintRead.isError, true);
  assert.equal((sprintRead.structuredContent as { status: string }).status, "active");

  const sprintClosed = await client.callTool({
    name: "sprint_close",
    arguments: {
      projectId,
      requestId: "stdio-sprint-close-retrospective",
      sprintIdOrKey: drafted.id,
      expectedVersion: 2,
      acceptedItemIds: [],
      reviewSummary: "O item continuará disponível no backlog para outro ciclo.",
      reason: "Fechar a sprint após a review.",
    },
  });
  assert.notEqual(sprintClosed.isError, true);
  assert.equal((sprintClosed.structuredContent as { sprint: { status: string } }).sprint.status, "closed");
  const retrospectiveSet = await client.callTool({
    name: "sprint_retrospective_set",
    arguments: {
      projectId,
      requestId: "stdio-retrospective-set",
      sprintIdOrKey: drafted.id,
      expectedVersion: 0,
      summary: "A equipe identificou melhorias para o próximo ciclo.",
      keepDoing: ["Revisar riscos diariamente."],
      stopDoing: [],
      tryNext: ["Separar histórias maiores antes do planejamento."],
      actions: [{ title: "Revisar tamanho das histórias", ownerPrincipalId: principalId, linkedWorkItemIdOrKey: story.workItem.id }],
      reason: "Registrar acordos da equipe.",
    },
  });
  assert.notEqual(retrospectiveSet.isError, true);
  assert.equal((retrospectiveSet.structuredContent as { retrospective: { version: number } }).retrospective.version, 1);
  const retrospectiveGet = await client.callTool({
    name: "sprint_retrospective_get",
    arguments: { projectId, sprintIdOrKey: "PAY-S1" },
  });
  assert.notEqual(retrospectiveGet.isError, true);
  assert.equal((retrospectiveGet.structuredContent as {
    version: number;
    retrospective: { actions: Array<{ linkedWorkItemKey: string | null }> };
  }).version, 1);
  assert.equal((retrospectiveGet.structuredContent as {
    retrospective: { actions: Array<{ linkedWorkItemKey: string | null }> };
  }).retrospective.actions[0]?.linkedWorkItemKey, story.workItem.key);
});
