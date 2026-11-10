import assert from "node:assert/strict";
import { log } from "node:console";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const workspace = resolve(process.env.SSDD_WORKSPACE ?? process.cwd());
const projectKey = process.env.SSDD_PROJECT_KEY ?? "SSDD";
const roadmap = readFileSync(resolve(workspace, "ROADMAP.md"), "utf8");
const statusDocument = readFileSync(resolve(workspace, "docs/status.md"), "utf8");
const cliPath = resolve(process.env.SSDD_CLI_PATH ?? resolve(workspace, "dist/src/cli.js"));

function parseRoadmap(markdown) {
  const epics = [...markdown.matchAll(/^\|\s*(E\d+)\s*·\s*([^|]+?)\s*\|/gm)]
    .map((match) => ({ id: match[1], title: `${match[1]} · ${match[2].trim()}` }));
  assert.equal(epics.length, 4, "Expected four roadmap epics");

  const lines = markdown.split(/\r?\n/);
  const sprints = [];
  const backlogTasks = [];
  let sprint;
  let backlogActive = false;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      sprint = undefined;
      backlogActive = line.trim() === "## Backlog de habilitação de agentes";
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
  for (const entry of sprints) {
    if (!entry.goal) {
      entry.goal = `Executar as tarefas refinadas para ${entry.name}: ${entry.tasks.map((task) => task.title).join("; ")}.`;
    }
  }
  return { epics, sprints, backlogTasks };
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

function managedItemKey(item) {
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
  if (item.type === "task") return item.title.match(/^(SSDD-\d{3}) · /)?.[1];
  return undefined;
}

async function listAllWorkItems(client, projectId) {
  const items = [];
  let cursor;
  do {
    const page = requireSuccess(await client.callTool({
      name: "work_item_list",
      arguments: { projectId, limit: 100, ...(cursor ? { cursor } : {}) },
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

const { epics, sprints, backlogTasks } = parseRoadmap(roadmap);
const statuses = parseStatuses(statusDocument);
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
  const projectDetails = requireSuccess(
    await client.callTool({ name: "project_get", arguments: { projectId } }),
    "project_get",
  );
  log(`Connected over MCP stdio: ${projectDetails.project.name} (${project.key}, ${projectId})`);

  const managedItems = new Map();
  for (const item of await listAllWorkItems(client, projectId)) {
    const key = managedItemKey(item);
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
        `Registro factual em docs/status.md (2026-11-10): ${statusText}`,
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
        `Registro factual em docs/status.md (2026-11-10): ${statusText}`,
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
      importedTasks.push(task);
      log(`${task.id} → ${result.workItem.key}`);
    }
  }

  let dependencyCount = 0;
  for (const task of importedTasks) {
    for (const dependency of task.dependencies) {
      const dependencyId = itemIds.get(dependency);
      assert.ok(dependencyId, `Missing imported dependency ${dependency} for ${task.id}`);
      requireSuccess(await client.callTool({
        name: "trace_link_add",
        arguments: {
          projectId,
          requestId: `roadmap-dependency-${dependency}-${task.id}`,
          sourceIdOrKey: itemIds.get(task.id),
          targetIdOrKey: dependencyId,
          type: "depends_on",
        },
      }), `link ${task.id} depends_on ${dependency}`);
      dependencyCount += 1;
    }
  }

  const allItems = await listAllWorkItems(client, projectId);
  const counts = Object.fromEntries(["epic", "feature", "story", "task"].map((type) => [
    type,
    allItems.filter((item) => item.type === type).length,
  ]));
  assert.ok(counts.epic >= 4 && counts.feature >= 8 && counts.story >= 8 && counts.task >= 40,
    `Imported counts are incomplete: ${JSON.stringify(counts)}`);
  assert.equal(allItems.filter((item) => item.type === "task" && /^SSDD-\d{3} · /.test(item.title)).length, importedTasks.length,
    "Imported SSDD task titles do not reconcile with the roadmap");
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
  log(JSON.stringify({ projectId, counts, roadmapTasks: importedTasks.length, dependencyLinksAdded: dependencyCount, sprints: sprints.length }, null, 2));
} finally {
  await client.close();
}
