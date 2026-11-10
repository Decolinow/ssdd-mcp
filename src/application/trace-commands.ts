import { randomUUID } from "node:crypto";
import type { TraceLinkType, TraceNode, TraceNodeType } from "../domain/trace.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { assertProjectAuthorization, type ProjectRole } from "./local-identity.js";

export interface AddTraceLinkInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly sourceIdOrKey: string;
  readonly targetIdOrKey: string;
  readonly type: TraceLinkType;
}

export interface RemoveTraceLinkInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly linkId: string;
}

interface TraceLinkReceipt {
  readonly id: string;
  readonly projectId: string;
  readonly source: TraceNode;
  readonly target: TraceNode;
  readonly type: TraceLinkType;
  readonly removedAt: string | null;
}

const rolesByLinkType: Readonly<Record<TraceLinkType, readonly ProjectRole[]>> = {
  depends_on: ["po", "developer"],
  relates_to: ["po", "developer", "qa", "tech_lead"],
  implements: ["po", "developer", "tech_lead"],
};

export function addTraceLink(
  database: SqliteDatabase,
  input: AddTraceLinkInput,
): CommandReceipt<TraceLinkReceipt> {
  const sourceReference = input.sourceIdOrKey.trim();
  const targetReference = input.targetIdOrKey.trim();
  if (sourceReference.length === 0 || targetReference.length === 0) {
    throw new ApplicationError("VALIDATION_FAILED", "Both trace link endpoints are required.");
  }

  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "trace_link.add",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      sourceIdOrKey: sourceReference,
      targetIdOrKey: targetReference,
      type: input.type,
    },
    requiredRoles: rolesByLinkType[input.type],
    auditEvent: (link) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "trace_link.added",
      entityType: "trace_link",
      entityId: link.id,
      payload: {
        type: link.type,
        sourceId: link.source.id,
        targetId: link.target.id,
        sourceKey: link.source.key,
        targetKey: link.target.key,
      },
    }),
    execute: () => {
      let source = resolveTraceNode(database, input.projectId, sourceReference);
      let target = resolveTraceNode(database, input.projectId, targetReference);
      validateEndpoints(input.type, source, target);
      if (input.type === "relates_to" && source.id > target.id) {
        [source, target] = [target, source];
      }

      if (input.type === "depends_on" && hasDependencyCycle(database, input.projectId, source.id, target.id)) {
        throw new ApplicationError(
          "DEPENDENCY_CYCLE",
          "This dependency would create a cycle in the project graph.",
          { details: { sourceId: source.id, targetId: target.id } },
        );
      }

      const existing = database
        .prepare(
          `SELECT link_id FROM trace_links
           WHERE project_id = ? AND source_id = ? AND target_id = ? AND link_type = ?
             AND removed_at IS NULL`,
        )
        .get(input.projectId, source.id, target.id, input.type);
      if (existing !== undefined) {
        throw new ApplicationError("TRACE_LINK_EXISTS", "This active trace link already exists.");
      }

      const linkId = randomUUID();
      database
        .prepare(
          `INSERT INTO trace_links
            (link_id, project_id, source_id, target_id, link_type, created_by_principal_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(linkId, input.projectId, source.id, target.id, input.type, input.principalId, new Date().toISOString());
      return {
        id: linkId,
        projectId: input.projectId,
        source,
        target,
        type: input.type,
        removedAt: null,
      };
    },
  });
}

export function removeTraceLink(
  database: SqliteDatabase,
  input: RemoveTraceLinkInput,
): CommandReceipt<{ id: string; removedAt: string }> {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const link = database
    .prepare("SELECT link_id, link_type FROM trace_links WHERE project_id = ? AND link_id = ?")
    .get(input.projectId, input.linkId) as { link_id: string; link_type: TraceLinkType } | undefined;
  if (link === undefined) {
    throw new ApplicationError("NOT_FOUND", "Trace link was not found.");
  }

  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "trace_link.remove",
    requestId: input.requestId,
    payload: { projectId: input.projectId, linkId: link.link_id },
    requiredRoles: rolesByLinkType[link.link_type],
    auditEvent: (result) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "trace_link.removed",
      entityType: "trace_link",
      entityId: result.id,
      payload: { removedAt: result.removedAt },
    }),
    execute: () => {
      const current = database
        .prepare("SELECT removed_at FROM trace_links WHERE project_id = ? AND link_id = ?")
        .get(input.projectId, link.link_id) as { removed_at: string | null } | undefined;
      if (current === undefined) {
        throw new ApplicationError("NOT_FOUND", "Trace link was not found.");
      }
      if (current.removed_at !== null) {
        throw new ApplicationError("VALIDATION_FAILED", "Trace link has already been removed.");
      }
      const removedAt = new Date().toISOString();
      database
        .prepare(
          `UPDATE trace_links SET removed_by_principal_id = ?, removed_at = ?
           WHERE project_id = ? AND link_id = ? AND removed_at IS NULL`,
        )
        .run(input.principalId, removedAt, input.projectId, link.link_id);
      return { id: link.link_id, removedAt };
    },
  });
}

interface TraceNodeRow {
  readonly node_id: string;
  readonly node_type: TraceNodeType;
  readonly node_key: string;
  readonly title: string;
}

function resolveTraceNode(
  database: SqliteDatabase,
  projectId: string,
  reference: string,
): TraceNode {
  const rows = database
    .prepare(
      `SELECT n.node_id, n.node_type, n.node_key,
              CASE n.node_type
                WHEN 'work_item' THEN (SELECT title FROM work_items WHERE item_id = n.node_id AND project_id = n.project_id)
                ELSE (SELECT title FROM specifications WHERE spec_id = n.node_id AND project_id = n.project_id)
              END AS title
       FROM trace_nodes AS n
       WHERE n.project_id = ? AND (n.node_id = ? OR n.node_key = ? COLLATE NOCASE)`,
    )
    .all(projectId, reference, reference) as TraceNodeRow[];
  if (rows.length === 0) {
    throw new ApplicationError("NOT_FOUND", "Trace endpoint was not found in this project.");
  }
  if (rows.length > 1) {
    throw new ApplicationError("VALIDATION_FAILED", "Trace endpoint key is ambiguous; use its UUID.");
  }
  const row = rows[0]!;
  return { id: row.node_id, type: row.node_type, key: row.node_key, title: row.title };
}

function validateEndpoints(type: TraceLinkType, source: TraceNode, target: TraceNode): void {
  if (source.id === target.id) {
    throw new ApplicationError("VALIDATION_FAILED", "A trace link cannot point to the same node.");
  }
  if (type === "depends_on" && (source.type !== "work_item" || target.type !== "work_item")) {
    throw new ApplicationError("VALIDATION_FAILED", "Dependencies must connect two work items.");
  }
  if (type === "implements" && (source.type !== "work_item" || target.type !== "specification")) {
    throw new ApplicationError("VALIDATION_FAILED", "An implements link must go from a work item to a specification.");
  }
}

function hasDependencyCycle(
  database: SqliteDatabase,
  projectId: string,
  sourceId: string,
  targetId: string,
): boolean {
  const cycle = database
    .prepare(
      `WITH RECURSIVE reachable(node_id) AS (
         SELECT target_id FROM trace_links
         WHERE project_id = ? AND source_id = ? AND link_type = 'depends_on' AND removed_at IS NULL
         UNION
         SELECT link.target_id FROM trace_links AS link
         INNER JOIN reachable ON link.source_id = reachable.node_id
         WHERE link.project_id = ? AND link.link_type = 'depends_on' AND link.removed_at IS NULL
       )
       SELECT 1 AS creates_cycle FROM reachable WHERE node_id = ? LIMIT 1`,
    )
    .get(projectId, targetId, projectId, sourceId) as { creates_cycle: number } | undefined;
  return cycle !== undefined;
}
