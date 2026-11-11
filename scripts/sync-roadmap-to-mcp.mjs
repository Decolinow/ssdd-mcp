import assert from "node:assert/strict";
import { log } from "node:console";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const workspace = resolve(process.env.SSDD_WORKSPACE ?? process.cwd());
const projectKey = process.env.SSDD_PROJECT_KEY ?? "SSDD";
const roadmap = readFileSync(resolve(workspace, "ROADMAP.md"), "utf8");
const statusDocument = readFileSync(resolve(workspace, "docs/status.md"), "utf8");
const statusDate = statusDocument.match(/^\*\*Atualizado em:\*\*\s*(\d{4}-\d{2}-\d{2})[ \t]*\r?$/m)?.[1];
assert.ok(statusDate, "docs/status.md must declare its last update date");
const cliPath = resolve(process.env.SSDD_CLI_PATH ?? resolve(workspace, "dist/src/cli.js"));
const roadmapMappingPath = resolve(workspace, ".ssdd", "roadmap-id-map.json");

function parseRoadmap(markdown) {
  const epics = [...markdown.matchAll(/^\|\s*(E\d+)\s*·\s*([^|]+?)\s*\|/gm)]
    .map((match) => ({ id: match[1], title: `${match[1]} · ${match[2].trim()}` }));
  assert.equal(epics.length, 4, "Expected four roadmap epics");

  const lines = markdown.split(/\r?\n/);
  const sprints = [];
  const backlogTasks = [];
  const improvementTasks = [];
  const installerFeatures = [];
  let sprint;
  let backlogActive = false;
  let installerBacklogActive = false;
  let improvementBacklogActive = false;
  let installerFeature;
  let installerStory;
  let parsingStoryCriteria = false;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      sprint = undefined;
      backlogActive = line.trim() === "## Backlog de habilitação de agentes";
      installerBacklogActive = line.trim() === "## Backlog de instalação para Claude Code, Codex e OpenCode";
      improvementBacklogActive = line.trim() === "## Auditoria e próximas melhorias do MCP"
        || line.trim() === "## Implantação de equipe, execução e governança enterprise";
      installerFeature = undefined;
      installerStory = undefined;
      parsingStoryCriteria = false;
    }
    if (installerBacklogActive) {
      const featureHeading = line.match(/^### (SSDD-\d+) · (.+)$/);
      if (featureHeading) {
        installerFeature = { id: featureHeading[1], title: featureHeading[2].trim(), description: "", stories: [] };
        installerFeatures.push(installerFeature);
        installerStory = undefined;
        parsingStoryCriteria = false;
        continue;
      }
      const storyHeading = line.match(/^#### (SSDD-\d+) · (.+?) \((\d+) pontos\)$/);
      if (storyHeading && installerFeature) {
        installerStory = {
          id: storyHeading[1],
          title: storyHeading[2].trim(),
          points: Number(storyHeading[3]),
          description: "",
          criteria: [],
          tasks: [],
        };
        installerFeature.stories.push(installerStory);
        parsingStoryCriteria = false;
        continue;
      }
      if (installerStory && line.startsWith("**História:**")) {
        installerStory.description = line.replace(/^\*\*História:\*\*\s*/, "").trim();
        continue;
      }
      if (installerStory && line.startsWith("**Critérios de aceite:**")) {
        parsingStoryCriteria = true;
        continue;
      }
      if (line.startsWith("| ID | Tarefa | Horas |")) {
        parsingStoryCriteria = false;
        continue;
      }
      if (parsingStoryCriteria) {
        const criterion = line.match(/^- (.+)$/);
        if (criterion) installerStory.criteria.push(criterion[1].trim());
      }
      const installerTask = line.match(/^\|\s*(SSDD-\d+)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*([^|]*?)\s*\|\s*([^|]+?)\s*\|$/);
      if (installerTask && installerStory) {
        const dependencyCell = installerTask[4].trim();
        installerStory.tasks.push({
          id: installerTask[1],
          title: installerTask[2].trim(),
          hours: Number(installerTask[3]),
          dependencies: dependencyCell === "—"
            ? []
            : dependencyCell.split(",").map((value) => value.trim()),
          acceptance: installerTask[5].trim(),
          storyId: installerStory.id,
        });
      }
    }
    const improvementTask = line.match(/^\|\s*(SSDD-\d{3})\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]+?)\s*\|$/);
    if (improvementBacklogActive && improvementTask) {
      const dependencyCell = improvementTask[4].trim();
      improvementTasks.push({
        id: improvementTask[1],
        title: improvementTask[2].trim(),
        points: Number(improvementTask[3]),
        dependencies: dependencyCell === "—" || dependencyCell === "-"
          ? []
          : (dependencyCell.match(/\d+/g) ?? []).map((value) => `SSDD-${value.padStart(3, "0")}`),
        status: improvementTask[5].trim(),
        acceptance: improvementTask[6].trim(),
      });
    }
    const heading = line.match(/^## Sprint (\d+) · (.*?) \((?:v\d+\.\d+ · )?(\d+) pontos\)$/);
    if (heading) {
      backlogActive = false;
      sprint = {
        number: Number(heading[1]),
        name: heading[2],
        points: Number(heading[3]),
        goal: "",
        tasks: [],
      };
      sprints.push(sprint);
      continue;
    }
    if (sprint && sprint.goal === "" && line.startsWith("**Meta:**")) {
      sprint.goal = line.replace(/^\*\*Meta:\*\*\s*/, "").trim();
      continue;
    }
    const task = line.match(/^\|\s*(SSDD-\d+)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/);
    if (task) {
      const dependencyCell = task[4].trim();
      const parsedTask = {
        id: task[1],
        title: task[2].trim(),
        points: Number(task[3]),
        dependencies: dependencyCell === "—"
          ? []
          : dependencyCell.split(",").map((value) => `SSDD-${value.trim().replace(/^SSDD-/, "")}`),
        acceptance: task[5].trim(),
      };
      if (sprint) sprint.tasks.push(parsedTask);
      else if (backlogActive) backlogTasks.push(parsedTask);
    }
  }
  assert.equal(sprints.length, 8, "Expected eight roadmap sprints");
  assert.equal(sprints.reduce((count, entry) => count + entry.tasks.length, 0), 40, "Expected forty roadmap tasks");
  assert.equal(backlogTasks.length, 1, "Expected one agent enablement backlog task");
  assert.equal(installerFeatures.length, 3, "Expected three local agent installer features");
  assert.equal(installerFeatures.reduce((count, feature) => count + feature.stories.length, 0), 4, "Expected four local agent installer stories");
  assert.equal(installerFeatures.reduce((count, feature) => count + feature.stories.reduce((storyCount, story) => storyCount + story.tasks.length, 0), 0), 11,
    "Expected eleven local agent installer tasks");
  assert.equal(improvementTasks.length, 14, "Expected fourteen technical and enterprise improvement tasks (SSDD-902 through SSDD-915)");
  for (const entry of sprints) {
    if (!entry.goal) {
      entry.goal = `Executar as tarefas refinadas para ${entry.name}: ${entry.tasks.map((task) => task.title).join("; ")}.`;
    }
  }
  return { epics, sprints, backlogTasks, installerFeatures, improvementTasks };
}

function parseStatuses(markdown) {
  const statuses = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\|\s*(SSDD-\d+)\s*\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/);
    if (match) statuses.set(match[1], `${match[2].trim()}: ${match[3].trim()}`);
  }
  return statuses;
}

function requireSuccess(result, name) {
  if (result.isError || !result.structuredContent) {
    throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent ?? result.content)}`);
  }
  return result.structuredContent;
}

function isKnownDuplicateTraceLink(result) {
  if (!result.isError) return false;
  return result.content.some((entry) => {
    if (entry.type !== "text") return false;
    try {
      return JSON.parse(entry.text).code === "TRACE_LINK_EXISTS";
    } catch {
      return false;
    }
  });
}

function managedItemKey(item, titleKeys) {
  if (item.type === "epic") return item.title.match(/^(E\d+) · /)?.[1];
  if (item.type === "feature") {
    const sprintNumber = item.title.match(/^Sprint (\d+) · /)?.[1];
    if (sprintNumber) return `S${sprintNumber.padStart(2, "0")}`;
    if (item.title === "Habilitação de agentes") return "agent-enablement";
  }
  if (item.type === "story") {
    const sprintNumber = item.title.match(/^Meta da Sprint (\d+)$/)?.[1];
    if (sprintNumber) return `S${sprintNumber.padStart(2, "0")}-GOAL`;
    if (item.title === "Fluxos guiados por papel de agente") return "agent-enablement-goal";
  }
  if (item.type === "task") return item.title.match(/^(SSDD-\d{3}) · /)?.[1] ?? titleKeys.get(`task:${item.title}`);
  return titleKeys.get(`${item.type}:${item.title}`);
}

async function listAllWorkItems(client, projectId) {
  const items = [];
  let cursor;
  do {
    const page = requireSuccess(await client.callTool({
      name: "work_item_list",
      arguments: {
        projectId,
        states: ["draft", "ready", "in_progress", "in_review", "in_validation", "done", "cancelled"],
        limit: 100,
        ...(cursor ? { cursor } : {}),
      },
    }), "work_item_list");
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

async function createOrReuseWorkItem(client, arguments_, name, key, managedItems) {
  const existing = managedItems.get(key);
  if (existing) {
    assert.equal(existing.type, arguments_.type, `${key} changed work item type`);
    assert.equal(existing.parentId, arguments_.parentId ?? null, `${key} changed parent`);
    return { workItem: existing };
  }

  const result = requireSuccess(await client.callTool({
    name: "work_item_create",
    arguments: arguments_,
  }), name);
  managedItems.set(key, result.workItem);
  return result;
}

async function ensureRoadmapMapping(client, projectId, roadmapId, workItem, roadmapMappings) {
  if (!/^SSDD-\d{3}$/u.test(roadmapId)) return;
  const existing = roadmapMappings.get(roadmapId);
  if (existing) {
    assert.equal(existing.itemId, workItem.id, `${roadmapId} mapping points at a different work item`);
    assert.equal(existing.itemKey, workItem.key, `${roadmapId} generated key changed`);
    assert.equal(existing.title, workItem.title, `${roadmapId} title changed`);
    return;
  }
  const result = requireSuccess(await client.callTool({
    name: "roadmap_id_bind",
    arguments: {
      projectId,
      requestId: `roadmap-bind-${roadmapId}`,
      roadmapId,
      itemIdOrKey: workItem.id,
    },
  }), `bind ${roadmapId}`);
  roadmapMappings.set(roadmapId, result.roadmapItem);
}

function readRoadmapMappingFile(mappingPath, projectId, roadmapMappings) {
  if (!existsSync(mappingPath)) return;
  const document = JSON.parse(readFileSync(mappingPath, "utf8"));
  assert.equal(document.version, 1, "Unsupported roadmap ID map version");
  assert.equal(document.projectId, projectId, "Roadmap ID map belongs to another MCP project");
  assert.ok(document.items && typeof document.items === "object" && !Array.isArray(document.items), "Roadmap ID map items must be an object");
  for (const [roadmapId, expected] of Object.entries(document.items)) {
    const actual = roadmapMappings.get(roadmapId);
    assert.ok(actual, `${roadmapId} is present in the local map but not in the MCP project`);
    assert.equal(actual.itemId, expected.itemId, `${roadmapId} UUID differs between the local map and MCP`);
    assert.equal(actual.itemKey, expected.itemKey, `${roadmapId} generated key differs between the local map and MCP`);
    assert.equal(actual.title, expected.title, `${roadmapId} title differs between the local map and MCP`);
  }
}

function writeRoadmapMappingFile(mappingPath, projectId, roadmapMappings) {
  mkdirSync(dirname(mappingPath), { recursive: true });
  const items = Object.fromEntries([...roadmapMappings.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([roadmapId, item]) => [roadmapId, {
      itemId: item.itemId,
      itemKey: item.itemKey,
      title: item.title,
      boundAt: item.boundAt,
    }]));
  const temporaryPath = `${mappingPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, projectId, items }, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, mappingPath);
}

async function ensureConfirmedEstimate(client, projectId, itemId, unit, value, requestId, rationale) {
  let workItem = requireSuccess(await client.callTool({
    name: "work_item_get",
    arguments: { projectId, itemIdOrKey: itemId },
  }), `read ${itemId} estimate` ).workItem;
  let estimate = workItem.estimates.find((entry) => entry.unit === unit);
  if (estimate) {
    assert.equal(estimate.value, value, `${itemId} ${unit} estimate drifted from ROADMAP.md`);
    return estimate;
  }
  const proposed = requireSuccess(await client.callTool({
    name: "work_item_estimate",
    arguments: {
      projectId,
      requestId: `${requestId}-propose`,
      itemIdOrKey: workItem.id,
      unit,
      value,
      rationale,
      expectedVersion: workItem.version,
    },
  }), `propose ${itemId} ${unit} estimate`);
  requireSuccess(await client.callTool({
    name: "work_item_estimate_confirm",
    arguments: {
      projectId,
      requestId: `${requestId}-confirm`,
      itemIdOrKey: workItem.id,
      proposalId: proposed.proposal.id,
      expectedVersion: workItem.version + 1,
    },
  }), `confirm ${itemId} ${unit} estimate`);
  workItem = requireSuccess(await client.callTool({
    name: "work_item_get",
    arguments: { projectId, itemIdOrKey: itemId },
  }), `verify ${itemId} estimate`).workItem;
  estimate = workItem.estimates.find((entry) => entry.unit === unit);
  assert.equal(estimate?.value, value, `${itemId} ${unit} estimate was not confirmed`);
  return estimate;
}

const { epics, sprints, backlogTasks, installerFeatures, improvementTasks } = parseRoadmap(roadmap);
const statuses = parseStatuses(statusDocument);
const installerTitleKeys = new Map();
const installerTasks = installerFeatures.flatMap((feature) => feature.stories.flatMap((story) => story.tasks));
for (const feature of installerFeatures) {
  installerTitleKeys.set(`feature:${feature.title}`, feature.id);
  for (const story of feature.stories) {
    installerTitleKeys.set(`story:${story.title}`, story.id);
    for (const task of story.tasks) installerTitleKeys.set(`task:${task.title}`, task.id);
  }
}
const client = new Client({ name: "ssdd-roadmap-sync", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cliPath, "stdio", "--workspace", workspace],
});
const itemIds = new Map();
const sprintParentEpic = new Map([
  [1, "E1"], [2, "E2"], [3, "E2"], [4, "E3"],
  [5, "E3"], [6, "E4"], [7, "E4"], [8, "E3"],
]);

try {
  await client.connect(transport);
  const projects = requireSuccess(await client.callTool({ name: "project_list", arguments: {} }), "project_list");
  const project = projects.projects.find((entry) => entry.key === projectKey);
  assert.ok(project, `Project ${projectKey} is not registered in this workspace`);
  const projectId = project.id;
  const currentRoadmapMap = requireSuccess(await client.callTool({ name: "roadmap_id_list", arguments: { projectId } }), "roadmap_id_list");
  const roadmapMappings = new Map(currentRoadmapMap.roadmapItems.map((entry) => [entry.roadmapId, entry]));
  readRoadmapMappingFile(roadmapMappingPath, projectId, roadmapMappings);
  const projectDetails = requireSuccess(
    await client.callTool({ name: "project_get", arguments: { projectId } }),
    "project_get",
  );
  log(`Connected over MCP stdio: ${projectDetails.project.name} (${project.key}, ${projectId})`);

  const managedItems = new Map();
  const mappedRoadmapItemIds = new Set([...roadmapMappings.values()].map((entry) => entry.itemId));
  for (const item of await listAllWorkItems(client, projectId)) {
    // Preserve cancelled tasks with an explicit stable roadmap identity; ignore unrelated cancelled duplicates.
    if (item.state === "cancelled" && !mappedRoadmapItemIds.has(item.id)) continue;
    const key = managedItemKey(item, installerTitleKeys);
    if (key) {
      assert.ok(!managedItems.has(key), `Multiple roadmap items map to ${key}`);
      managedItems.set(key, item);
    }
  }

  const epicIds = new Map();
  for (const epic of epics) {
    const result = await createOrReuseWorkItem(client, {
      projectId,
      requestId: `roadmap-import-${epic.id}`,
      type: "epic",
      title: epic.title,
      description: `[roadmap:${epic.id}] Épico importado de ROADMAP.md. O estado do item segue os gates formais do workflow.`,
    }, `create ${epic.id}`, epic.id, managedItems);
    epicIds.set(epic.id, result.workItem.id);
    itemIds.set(epic.id, result.workItem.id);
  }

  const importedTasks = [];
  for (const sprint of sprints) {
    const sprintLabel = String(sprint.number).padStart(2, "0");
    const epicId = sprintParentEpic.get(sprint.number);
    assert.ok(epicId, `No epic mapping for sprint ${sprint.number}`);
    const featureKey = `S${sprintLabel}`;
    const feature = await createOrReuseWorkItem(client, {
      projectId,
      requestId: `roadmap-import-S${sprintLabel}`,
      type: "feature",
      parentId: epicIds.get(epicId),
      title: `Sprint ${sprint.number} · ${sprint.name}`,
      description: `[roadmap:S${sprintLabel}] Sprint de ${sprint.points} pontos. Origem: ROADMAP.md. Meta: ${sprint.goal}`,
    }, `create sprint ${sprint.number}`, featureKey, managedItems);
    itemIds.set(`S${sprintLabel}`, feature.workItem.id);

    const goalKey = `${featureKey}-GOAL`;
    const goal = await createOrReuseWorkItem(client, {
      projectId,
      requestId: `roadmap-import-S${sprintLabel}-GOAL`,
      type: "story",
      parentId: feature.workItem.id,
      title: `Meta da Sprint ${sprint.number}`,
      description: `[roadmap:S${sprintLabel}-GOAL] ${sprint.goal}`,
    }, `create sprint goal ${sprint.number}`, goalKey, managedItems);
    itemIds.set(`S${sprintLabel}-GOAL`, goal.workItem.id);

    for (const task of sprint.tasks) {
      const dependencyText = task.dependencies.length ? task.dependencies.join(", ") : "Nenhuma";
      const statusText = statuses.get(task.id) ?? "Sem registro individual em docs/status.md";
      const description = [
        `[roadmap:${task.id}]`,
        `Origem: ROADMAP.md, Sprint ${sprint.number}.`,
        `Pontos: ${task.points}.`,
        `Critério de aceite planejado: ${task.acceptance}`,
        `Dependências no roadmap: ${dependencyText}.`,
        `Registro factual em docs/status.md (${statusDate}): ${statusText}`,
        "Estado de workflow SSDD: Draft na importação. A descrição registra progresso histórico; aceite formal exige os gates, revisões e evidências definidos pelo projeto.",
      ].join("\n");
      const result = await createOrReuseWorkItem(client, {
        projectId,
        requestId: `roadmap-import-${task.id}`,
        type: "task",
        parentId: goal.workItem.id,
        title: `${task.id} · ${task.title}`,
        description,
      }, `create ${task.id}`, task.id, managedItems);
      itemIds.set(task.id, result.workItem.id);
      await ensureRoadmapMapping(client, projectId, task.id, result.workItem, roadmapMappings);
      importedTasks.push(task);
      log(`${task.id} → ${result.workItem.key}`);
    }
  }

  if (backlogTasks.length > 0) {
    const feature = await createOrReuseWorkItem(client, {
      projectId,
      requestId: "roadmap-import-agent-enablement",
      type: "feature",
      parentId: epicIds.get("E4"),
      title: "Habilitação de agentes",
      description: "[roadmap:agent-enablement] Backlog transversal do MCP, ainda sem compromisso de sprint.",
    }, "create agent enablement feature", "agent-enablement", managedItems);
    const story = await createOrReuseWorkItem(client, {
      projectId,
      requestId: "roadmap-import-agent-enablement-goal",
      type: "story",
      parentId: feature.workItem.id,
      title: "Fluxos guiados por papel de agente",
      description: "PO, Developer, QA e Release recebem orientação segura, contextualizada e verificável.",
    }, "create agent enablement story", "agent-enablement-goal", managedItems);
    for (const task of backlogTasks) {
      const dependencyText = task.dependencies.length ? task.dependencies.join(", ") : "Nenhuma";
      const statusText = statuses.get(task.id) ?? "Sem registro individual em docs/status.md";
      const description = [
        `[roadmap:${task.id}]`,
        "Origem: ROADMAP.md, backlog transversal sem sprint comprometida.",
        `Pontos: ${task.points}.`,
        `Critério de aceite planejado: ${task.acceptance}`,
        `Dependências no roadmap: ${dependencyText}.`,
        `Registro factual em docs/status.md (${statusDate}): ${statusText}`,
        "Estado de workflow SSDD: Draft na importação. O aceite formal exige os gates, revisões e evidências definidos pelo projeto.",
      ].join("\n");
      const result = await createOrReuseWorkItem(client, {
        projectId,
        requestId: `roadmap-import-${task.id}`,
        type: "task",
        parentId: story.workItem.id,
        title: `${task.id} · ${task.title}`,
        description,
      }, `create ${task.id}`, task.id, managedItems);
      itemIds.set(task.id, result.workItem.id);
      await ensureRoadmapMapping(client, projectId, task.id, result.workItem, roadmapMappings);
      importedTasks.push(task);
      log(`${task.id} → ${result.workItem.key}`);
    }
  }

  if (improvementTasks.length > 0) {
    const feature = await createOrReuseWorkItem(client, {
      projectId,
      requestId: "roadmap-import-improvement-backlog",
      type: "feature",
      parentId: epicIds.get("E4"),
      title: "Melhorias do MCP e governança enterprise",
      description: "[roadmap:improvement-backlog] Backlog de melhorias do MCP com IDs estáveis, execução rastreável, releases, métricas e operação de equipe.",
    }, "create improvement backlog feature", "improvement-backlog", managedItems);
    itemIds.set("improvement-backlog", feature.workItem.id);
    const story = await createOrReuseWorkItem(client, {
      projectId,
      requestId: "roadmap-import-improvement-goal",
      type: "story",
      parentId: feature.workItem.id,
      title: "Executar melhorias de engenharia e governança",
      description: "[roadmap:improvement-goal] Como equipe, quero rastrear melhorias do MCP do planejamento à operação enterprise com aceites e histórico verificáveis.",
    }, "create improvement backlog story", "improvement-goal", managedItems);
    itemIds.set("improvement-goal", story.workItem.id);
    for (const task of improvementTasks) {
      const dependencyText = task.dependencies.length ? task.dependencies.join(", ") : "Nenhuma";
      const statusText = statuses.get(task.id) ?? task.status ?? "Sem registro individual em docs/status.md";
      const description = [
        `[roadmap:${task.id}]`,
        "Origem: ROADMAP.md, backlog de auditoria e implantação enterprise.",
        `Pontos relativos: ${task.points}.`,
        `Critério de aceite planejado: ${task.acceptance}`,
        `Dependências no roadmap: ${dependencyText}.`,
        `Registro factual em docs/status.md (2026-11-11): ${statusText}`,
        "Estado de workflow SSDD: Draft na importação. Esta descrição não substitui gates, revisão de negócio/técnica ou evidência de aceite.",
      ].join("\n");
      const result = await createOrReuseWorkItem(client, {
        projectId,
        requestId: `roadmap-import-${task.id}`,
        type: "task",
        parentId: story.workItem.id,
        title: `${task.id} · ${task.title}`,
        description,
      }, `create ${task.id}`, task.id, managedItems);
      itemIds.set(task.id, result.workItem.id);
      await ensureRoadmapMapping(client, projectId, task.id, result.workItem, roadmapMappings);
      importedTasks.push(task);
      log(`${task.id} → ${result.workItem.key}`);
    }
  }

  for (const featureSpec of installerFeatures) {
    const feature = await createOrReuseWorkItem(client, {
      projectId,
      requestId: `roadmap-import-${featureSpec.id}`,
      type: "feature",
      parentId: epicIds.get("E4"),
      title: featureSpec.title,
      description: `[roadmap:${featureSpec.id}] ${featureSpec.description || "Feature de instalação local para clientes de codificação; veja o detalhamento e aceite em ROADMAP.md."}`,
    }, `create ${featureSpec.id}`, featureSpec.id, managedItems);
    itemIds.set(featureSpec.id, feature.workItem.id);

    for (const storySpec of featureSpec.stories) {
      const story = await createOrReuseWorkItem(client, {
        projectId,
        requestId: `roadmap-import-${storySpec.id}`,
        type: "story",
        parentId: feature.workItem.id,
        title: storySpec.title,
        description: `[roadmap:${storySpec.id}] ${storySpec.description}`,
        criteria: storySpec.criteria.map((description) => ({ description, required: true })),
      }, `create ${storySpec.id}`, storySpec.id, managedItems);
      itemIds.set(storySpec.id, story.workItem.id);
    await ensureConfirmedEstimate(
      client,
      projectId,
      story.workItem.id,
      "points",
      storySpec.points,
      `roadmap-import-${storySpec.id}-points`,
      "Estimativa Fibonacci da história conforme ROADMAP.md; pontos não são horas.",
    );

      for (const task of storySpec.tasks) {
        const dependencyText = task.dependencies.length ? task.dependencies.join(", ") : "Nenhuma";
        const statusText = statuses.get(task.id) ?? "Sem registro individual em docs/status.md";
        const description = [
          `[roadmap:${task.id}]`,
          `Origem: ROADMAP.md, história ${storySpec.id}.`,
          `Horas estimadas da tarefa: ${task.hours}.`,
          `Critério de aceite planejado: ${task.acceptance}`,
          `Dependências no roadmap: ${dependencyText}.`,
          `Registro factual em docs/status.md (${statusDate}): ${statusText}`,
          "Estado de workflow SSDD: Draft na importação. A descrição registra planejamento; aceite formal exige os gates, baseline e evidências do projeto.",
        ].join("\n");
        const result = await createOrReuseWorkItem(client, {
          projectId,
          requestId: `roadmap-import-${task.id}`,
          type: "task",
          parentId: story.workItem.id,
          title: task.title,
          description,
        }, `create ${task.id}`, task.id, managedItems);
        itemIds.set(task.id, result.workItem.id);
        await ensureConfirmedEstimate(
          client,
          projectId,
          result.workItem.id,
          "hours",
          task.hours,
          `roadmap-import-${task.id}-hours`,
          "Horas de foco estimadas para a tarefa conforme ROADMAP.md.",
        );
        importedTasks.push(task);
        log(`${task.id} → ${result.workItem.key}`);
      }
    }
  }

  let dependencyCount = 0;
  for (const task of importedTasks) {
    for (const dependency of task.dependencies) {
      const dependencyId = itemIds.get(dependency);
      assert.ok(dependencyId, `Missing imported dependency ${dependency} for ${task.id}`);
      const linkResult = await client.callTool({
        name: "trace_link_add",
        arguments: {
          projectId,
          requestId: `roadmap-dependency-${dependency}-${task.id}-${dependencyId}`,
          sourceIdOrKey: itemIds.get(task.id),
          targetIdOrKey: dependencyId,
          type: "depends_on",
        },
      });
      if (!isKnownDuplicateTraceLink(linkResult)) {
        requireSuccess(linkResult, `link ${task.id} depends_on ${dependency}`);
      }
      dependencyCount += 1;
    }
  }

  const allItems = await listAllWorkItems(client, projectId);
  const activeItems = allItems.filter((item) => item.state !== "cancelled");
  const importedTaskIds = new Set(importedTasks.map((task) => itemIds.get(task.id)).filter(Boolean));
  const importedTaskItems = allItems.filter((item) => importedTaskIds.has(item.id));
  const counts = Object.fromEntries(["epic", "feature", "story", "task"].map((type) => [
    type,
    type === "task" ? importedTaskItems.length : activeItems.filter((item) => item.type === type).length,
  ]));
  assert.ok(counts.epic >= 4 && counts.feature >= 13 && counts.story >= 14 && counts.task >= 66,
    `Imported counts are incomplete: ${JSON.stringify(counts)}`);
  assert.equal(importedTaskItems.length, importedTasks.length,
    "Imported SSDD task IDs do not reconcile with the roadmap, including cancelled historical tasks");
  assert.ok(importedTaskItems.every((item) => item.type === "task"), "A stable roadmap task ID resolved to a non-task item");
  const agentTask = backlogTasks.find((task) => task.id === "SSDD-901");
  assert.ok(agentTask, "Agent enablement task is missing from the roadmap");
  const graph = requireSuccess(await client.callTool({
    name: "trace_query",
    arguments: {
      projectId,
      nodeIdOrKey: itemIds.get(agentTask.id),
      direction: "outbound",
      linkTypes: ["depends_on"],
      depth: 1,
    },
  }), "verify roadmap dependencies");
  const observedDependencies = graph.links.map((link) => link.target.id).sort();
  const expectedDependencies = agentTask.dependencies.map((id) => itemIds.get(id)).sort();
  assert.deepEqual(observedDependencies, expectedDependencies, "MCP dependency graph does not match the roadmap");
  const installerDocsTask = installerTasks.find((task) => task.id === "SSDD-84");
  assert.ok(installerDocsTask, "The installer documentation task is missing from the roadmap");
  const installerGraph = requireSuccess(await client.callTool({
    name: "trace_query",
    arguments: { projectId, nodeIdOrKey: itemIds.get(installerDocsTask.id), direction: "outbound", linkTypes: ["depends_on"], depth: 1 },
  }), "verify agent installer dependencies");
  assert.deepEqual(installerGraph.links.map((link) => link.target.id).sort(), installerDocsTask.dependencies.map((id) => itemIds.get(id)).sort(),
    "Agent installer dependencies do not match the roadmap");
  const finalRoadmapMap = requireSuccess(await client.callTool({
    name: "roadmap_id_list",
    arguments: { projectId },
  }), "verify stable roadmap IDs");
  const finalMappings = new Map(finalRoadmapMap.roadmapItems.map((entry) => [entry.roadmapId, entry]));
  const stableRoadmapTasks = importedTasks.filter((task) => /^SSDD-\d{3}$/u.test(task.id));
  for (const task of stableRoadmapTasks) {
    const mapping = finalMappings.get(task.id);
    assert.ok(mapping, `Stable ID ${task.id} has no persisted MCP mapping`);
    assert.equal(mapping.itemId, itemIds.get(task.id), `${task.id} resolves to a different task`);
  }
  assert.equal(stableRoadmapTasks.length, 55, "Expected mappings for all 55 stable roadmap tasks");
  assert.equal(finalMappings.size, stableRoadmapTasks.length, "MCP project contains unexpected roadmap ID mappings");
  let stableIdCollisionsVerified = 0;
  for (const [roadmapId, stableMapping] of finalMappings) {
    const generatedKeyCollision = allItems.find((item) => item.key.toUpperCase() === roadmapId);
    if (generatedKeyCollision && stableMapping.itemId !== generatedKeyCollision.id) {
    const resolution = requireSuccess(await client.callTool({
      name: "work_item_get",
        arguments: { projectId, itemIdOrKey: roadmapId },
      }), `verify stable ID precedence for ${roadmapId}`);
      assert.equal(resolution.workItem.id, stableMapping.itemId, `Stable roadmap ID ${roadmapId} must win a generated-key collision`);
      stableIdCollisionsVerified += 1;
    }
  }
  writeRoadmapMappingFile(roadmapMappingPath, projectId, finalMappings);
  const installerStoryPoints = installerFeatures.flatMap((feature) => feature.stories).reduce((total, story) => total + story.points, 0);
  const installerTaskHours = installerTasks.reduce((total, task) => total + task.hours, 0);
  log(JSON.stringify({ projectId, counts, roadmapTasks: importedTasks.length, stableRoadmapIdsMapped: finalMappings.size, stableIdCollisionsVerified, installerTasks: installerTasks.length, installerStoryPoints, installerTaskHours, dependencyLinksReconciled: dependencyCount, sprints: sprints.length }, null, 2));
} finally {
  await client.close();
}
