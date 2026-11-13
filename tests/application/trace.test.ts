import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { listAuditEvents } from "../../src/application/audit-queries.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createSpecification } from "../../src/application/specification-commands.js";
import { addTraceLink, removeTraceLink } from "../../src/application/trace-commands.js";
import { queryTraceGraph } from "../../src/application/trace-queries.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("typed traceability graph", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-trace-"));
    const initialized = initializeProject({
      workspace,
      key: "PAY",
      name: "Payments",
      productGoal: "Pagamentos confiáveis",
      timezone: "America/Sao_Paulo",
    });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    const project = database
      .prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
      .get(projectId) as { created_by_principal_id: string };
    principalId = project.created_by_principal_id;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("traces a work item to a specification and retains removed relationship history", () => {
    const hierarchy = createHierarchy();
    const specification = createSpecification(database, {
      projectId,
      principalId,
      requestId: "create-rule",
      key: "BR-04",
      kind: "business_rule",
      title: "Payment cut-off",
      content: { text: "Rules are versioned." },
    }).value;
    const implementsLink = addTraceLink(database, {
      projectId,
      principalId,
      requestId: "implements-rule",
      sourceIdOrKey: hierarchy.story.key,
      targetIdOrKey: specification.key,
      type: "implements",
    });
    assert.equal(implementsLink.value.source.id, hierarchy.story.id);
    assert.equal(implementsLink.value.target.id, specification.specId);
    const auditLink = listAuditEvents(database, {
      projectId,
      principalId,
      entityType: "trace_link",
      entityId: implementsLink.value.id,
    }).events[0]!;
    assert.equal(auditLink.entityReference.label, "Vínculo de implementação");
    assert.deepEqual(auditLink.relatedEntities.map(({ key, title, label }) => ({ key, title, label })), [
      { key: hierarchy.story.key, title: "Log in", label: hierarchy.story.key + " · Log in" },
      { key: specification.key, title: "Payment cut-off", label: specification.key + " · Payment cut-off" },
    ]);
    const specificationAudit = listAuditEvents(database, {
      projectId, principalId, entityType: "specification", entityId: specification.specId,
    }).events[0]!;
    assert.equal(specificationAudit.entityReference.key, specification.key);
    assert.equal(specificationAudit.entityReference.label, specification.key + " · Payment cut-off");
    const missingEntityId = "external-record-removed";
    database.prepare(
      `INSERT INTO audit_events
        (event_id, project_id, principal_id, event_type, entity_type, entity_id, correlation_id, occurred_at, payload_json)
       VALUES (?, ?, ?, 'external.changed', 'external_entity', ?, ?, ?, '{}')`,
    ).run("external-audit-event", projectId, principalId, missingEntityId, "external-correlation", new Date().toISOString());
    const fallbackEvent = listAuditEvents(database, {
      projectId, principalId, entityType: "external_entity", entityId: missingEntityId,
    }).events[0]!;
    assert.equal(fallbackEvent.entityReference.label, "external_entity");
    assert.equal(fallbackEvent.entityReference.id, missingEntityId);

    const inbound = queryTraceGraph(database, {
      projectId,
      principalId,
      nodeIdOrKey: "BR-04",
      direction: "inbound",
      linkTypes: ["implements"],
      depth: 2,
    });
    assert.deepEqual(inbound.nodes.map((node) => node.key), ["BR-04", hierarchy.story.key]);
    assert.equal(inbound.links[0]?.source.id, hierarchy.story.id);
    assert.equal(inbound.links[0]?.target.id, specification.specId);

    const related = addTraceLink(database, {
      projectId,
      principalId,
      requestId: "related-items",
      sourceIdOrKey: hierarchy.story.key,
      targetIdOrKey: hierarchy.epic.key,
      type: "relates_to",
    });
    const symmetric = queryTraceGraph(database, {
      projectId,
      principalId,
      nodeIdOrKey: hierarchy.epic.key,
      direction: "outbound",
      linkTypes: ["relates_to"],
    });
    assert.ok(symmetric.nodes.some((node) => node.id === hierarchy.story.id));

    const removed = removeTraceLink(database, {
      projectId,
      principalId,
      requestId: "remove-related-items",
      linkId: related.value.id,
    });
    assert.equal(removed.value.id, related.value.id);
    const removedLink = database
      .prepare("SELECT removed_at, removed_by_principal_id FROM trace_links WHERE link_id = ?")
      .get(related.value.id) as { removed_at: string | null; removed_by_principal_id: string | null };
    assert.ok(removedLink.removed_at);
    assert.equal(removedLink.removed_by_principal_id, principalId);
    const removedAudit = listAuditEvents(database, {
      projectId, principalId, entityType: "trace_link", entityId: related.value.id,
    }).events[0]!;
    assert.equal(removedAudit.eventType, "trace_link.removed");
    assert.equal(removedAudit.entityReference.label, "Vínculo de contexto");
    assert.deepEqual(removedAudit.relatedEntities.map(({ key, title }) => ({ key: key ?? "", title })).sort((left, right) => left.key.localeCompare(right.key)), [
      { key: hierarchy.story.key, title: "Log in" },
      { key: hierarchy.epic.key, title: "Payments" },
    ].sort((left, right) => left.key.localeCompare(right.key)));
    assert.equal(
      queryTraceGraph(database, {
        projectId,
        principalId,
        nodeIdOrKey: hierarchy.epic.key,
        direction: "both",
        linkTypes: ["relates_to"],
      }).links.length,
      0,
    );
  });

  it("rejects dependency cycles and invalid or cross-project endpoint types", () => {
    const hierarchy = createHierarchy();
    const specification = createSpecification(database, {
      projectId,
      principalId,
      requestId: "create-rule",
      key: "BR-04",
      kind: "business_rule",
      title: "Payment cut-off",
      content: { text: "Rules are versioned." },
    }).value;
    const firstTask = createWorkItem(database, {
      projectId,
      principalId,
      requestId: "task-one",
      type: "task",
      parentId: hierarchy.story.id,
      title: "Task one",
    }).value;
    const secondTask = createWorkItem(database, {
      projectId,
      principalId,
      requestId: "task-two",
      type: "task",
      parentId: hierarchy.story.id,
      title: "Task two",
    }).value;
    addTraceLink(database, {
      projectId,
      principalId,
      requestId: "task-one-depends-two",
      sourceIdOrKey: firstTask.id,
      targetIdOrKey: secondTask.id,
      type: "depends_on",
    });
    assert.throws(
      () =>
        addTraceLink(database, {
          projectId,
          principalId,
          requestId: "task-two-depends-one",
          sourceIdOrKey: secondTask.id,
          targetIdOrKey: firstTask.id,
          type: "depends_on",
        }),
      (error: unknown) => error instanceof ApplicationError && error.code === "DEPENDENCY_CYCLE",
    );
    assert.throws(
      () =>
        addTraceLink(database, {
          projectId,
          principalId,
          requestId: "invalid-implements-direction",
          sourceIdOrKey: specification.specId,
          targetIdOrKey: hierarchy.story.key,
          type: "implements",
        }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );

    const otherProject = initializeProject({
      workspace,
      key: "OPS",
      name: "Operations",
      productGoal: "Operations goal",
      timezone: "America/Sao_Paulo",
    });
    const externalEpic = createWorkItem(database, {
      projectId: otherProject.project.id,
      principalId,
      requestId: "external-epic",
      type: "epic",
      title: "Operations epic",
    }).value;
    assert.throws(
      () =>
        addTraceLink(database, {
          projectId,
          principalId,
          requestId: "cross-project-link",
          sourceIdOrKey: hierarchy.story.id,
          targetIdOrKey: externalEpic.id,
          type: "relates_to",
        }),
      (error: unknown) => error instanceof ApplicationError && error.code === "NOT_FOUND",
    );
    const activeCount = database
      .prepare("SELECT COUNT(*) AS count FROM trace_links WHERE project_id = ? AND removed_at IS NULL")
      .get(projectId) as { count: number };
    assert.equal(activeCount.count, 1);
  });

  it("limits graph expansion and marks omitted nodes", () => {
    const hierarchy = createHierarchy();
    createWorkItem(database, {
      projectId,
      principalId,
      requestId: "task-one",
      type: "task",
      parentId: hierarchy.story.id,
      title: "Task one",
    });
    createWorkItem(database, {
      projectId,
      principalId,
      requestId: "task-two",
      type: "task",
      parentId: hierarchy.story.id,
      title: "Task two",
    });
    createWorkItem(database, {
      projectId,
      principalId,
      requestId: "task-three",
      type: "task",
      parentId: hierarchy.story.id,
      title: "Task three",
    });
    const tasks = database
      .prepare("SELECT item_id FROM work_items WHERE type = 'task' ORDER BY item_key")
      .all() as Array<{ item_id: string }>;
    for (const [index, source] of tasks.entries()) {
      const target = tasks[index + 1];
      if (target !== undefined) {
        addTraceLink(database, {
          projectId,
          principalId,
          requestId: `task-chain-${index}`,
          sourceIdOrKey: source.item_id,
          targetIdOrKey: target.item_id,
          type: "depends_on",
        });
      }
    }

    const graph = queryTraceGraph(database, {
      projectId,
      principalId,
      nodeIdOrKey: tasks[0]!.item_id,
      direction: "outbound",
      depth: 3,
      maxNodes: 2,
    });
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.truncated, true);
  });

  it("serializes concurrent dependency additions so only one direction can commit", async () => {
    const hierarchy = createHierarchy();
    const firstTask = createWorkItem(database, {
      projectId,
      principalId,
      requestId: "concurrent-task-one",
      type: "task",
      parentId: hierarchy.story.id,
      title: "Concurrent task one",
    }).value;
    const secondTask = createWorkItem(database, {
      projectId,
      principalId,
      requestId: "concurrent-task-two",
      type: "task",
      parentId: hierarchy.story.id,
      title: "Concurrent task two",
    }).value;
    const databasePath = join(workspace, ".ssdd", "ssdd.sqlite");
    const workers = [
      new Worker(new URL("./trace-concurrency-worker.js", import.meta.url), {
        workerData: {
          databasePath,
          projectId,
          principalId,
          requestId: "concurrent-forward",
          sourceId: firstTask.id,
          targetId: secondTask.id,
        },
      }),
      new Worker(new URL("./trace-concurrency-worker.js", import.meta.url), {
        workerData: {
          databasePath,
          projectId,
          principalId,
          requestId: "concurrent-reverse",
          sourceId: secondTask.id,
          targetId: firstTask.id,
        },
      }),
    ];
    const readyMessages = await Promise.all(workers.map((worker) => once(worker, "message")));
    assert.ok(readyMessages.every(([message]) => (message as { type: string }).type === "ready"));
    const resultsPromise = Promise.all(workers.map((worker) => once(worker, "message")));
    const exitPromise = Promise.all(workers.map((worker) => once(worker, "exit")));
    workers.forEach((worker) => worker.postMessage("go"));
    const results = (await resultsPromise).map(([message]) => message as {
      type: string;
      ok: boolean;
      code?: string;
    });
    await exitPromise;

    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.deepEqual(results.filter((result) => !result.ok).map((result) => result.code), ["DEPENDENCY_CYCLE"]);
    const activeCount = database
      .prepare("SELECT COUNT(*) AS count FROM trace_links WHERE project_id = ? AND link_type = 'depends_on' AND removed_at IS NULL")
      .get(projectId) as { count: number };
    assert.equal(activeCount.count, 1);
  });

  function createHierarchy() {
    const epic = createWorkItem(database, {
      projectId,
      principalId,
      requestId: "epic",
      type: "epic",
      title: "Payments",
    }).value;
    const feature = createWorkItem(database, {
      projectId,
      principalId,
      requestId: "feature",
      type: "feature",
      parentId: epic.id,
      title: "Authentication",
    }).value;
    const story = createWorkItem(database, {
      projectId,
      principalId,
      requestId: "story",
      type: "story",
      parentId: feature.id,
      title: "Log in",
    }).value;
    return { epic, feature, story };
  }
});
