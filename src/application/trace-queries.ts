import type {
  TraceDirection,
  TraceEdge,
  TraceGraph,
  TraceLinkType,
  TraceNode,
  TraceNodeType,
} from "../domain/trace.js";
import { traceLinkTypes } from "../domain/trace.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { assertProjectAuthorization } from "./local-identity.js";

export interface TraceQueryInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly nodeIdOrKey: string;
  readonly direction?: TraceDirection;
  readonly linkTypes?: readonly TraceLinkType[];
  readonly depth?: number;
  readonly maxNodes?: number;
}

interface TraceLinkRow {
  readonly link_id: string;
  readonly source_id: string;
  readonly source_type: TraceNodeType;
  readonly source_key: string;
  readonly source_title: string;
  readonly target_id: string;
  readonly target_type: TraceNodeType;
  readonly target_key: string;
  readonly target_title: string;
  readonly link_type: TraceLinkType;
}

export function queryTraceGraph(database: SqliteDatabase, input: TraceQueryInput): TraceGraph {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const direction = input.direction ?? "both";
  const depth = input.depth ?? 1;
  const maxNodes = input.maxNodes ?? 100;
  const linkTypes = [...new Set(input.linkTypes ?? traceLinkTypes)];
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 3) {
    throw new ApplicationError("VALIDATION_FAILED", "Trace depth must be an integer between 1 and 3.");
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "Trace node limit must be an integer between 1 and 100.");
  }
  if (linkTypes.length === 0 || linkTypes.some((type) => !traceLinkTypes.includes(type))) {
    throw new ApplicationError("VALIDATION_FAILED", "At least one supported trace link type is required.");
  }

  const root = resolveNode(database, input.projectId, input.nodeIdOrKey);
  const nodes = new Map<string, TraceNode>([[root.id, root]]);
  const links = new Map<string, TraceEdge>();
  let frontier = [root.id];
  let truncated = false;

  for (let currentDepth = 1; currentDepth <= depth && frontier.length > 0; currentDepth += 1) {
    const frontierSet = new Set(frontier);
    const edges = loadIncidentLinks(database, input.projectId, frontier, direction, linkTypes);
    const nextFrontier: string[] = [];

    for (const edge of edges) {
      const source = toNode(edge, "source");
      const target = toNode(edge, "target");
      const neighbor = neighborFor(edge.link_type, source, target, frontierSet, direction);
      if (neighbor === undefined) {
        continue;
      }
      if (!nodes.has(neighbor.id)) {
        if (nodes.size >= maxNodes) {
          truncated = true;
          continue;
        }
        nodes.set(neighbor.id, neighbor);
        nextFrontier.push(neighbor.id);
      }
      if (!links.has(edge.link_id)) {
        links.set(edge.link_id, {
          id: edge.link_id,
          type: edge.link_type,
          source,
          target,
          depth: currentDepth,
        });
      }
    }

    frontier = nextFrontier;
    if (truncated) {
      break;
    }
  }

  if (!truncated && frontier.length > 0) {
    const moreEdges = loadIncidentLinks(database, input.projectId, frontier, direction, linkTypes);
    truncated = moreEdges.some((edge) => {
      const source = toNode(edge, "source");
      const target = toNode(edge, "target");
      const neighbor = neighborFor(edge.link_type, source, target, new Set(frontier), direction);
      return neighbor !== undefined && !nodes.has(neighbor.id);
    });
  }

  return {
    root,
    nodes: [...nodes.values()],
    links: [...links.values()],
    truncated,
  };
}

function resolveNode(database: SqliteDatabase, projectId: string, reference: string): TraceNode {
  const value = reference.trim();
  if (value.length === 0) {
    throw new ApplicationError("VALIDATION_FAILED", "A trace root node is required.");
  }
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
    .all(projectId, value, value) as Array<{
    node_id: string;
    node_type: TraceNodeType;
    node_key: string;
    title: string;
  }>;
  if (rows.length === 0) {
    throw new ApplicationError("NOT_FOUND", "Trace node was not found in this project.");
  }
  if (rows.length > 1) {
    throw new ApplicationError("VALIDATION_FAILED", "Trace node key is ambiguous; use its UUID.");
  }
  const row = rows[0]!;
  return { id: row.node_id, type: row.node_type, key: row.node_key, title: row.title };
}

function loadIncidentLinks(
  database: SqliteDatabase,
  projectId: string,
  frontier: readonly string[],
  direction: TraceDirection,
  linkTypes: readonly TraceLinkType[],
): TraceLinkRow[] {
  const frontierPlaceholders = frontier.map(() => "?").join(", ");
  const typePlaceholders = linkTypes.map(() => "?").join(", ");
  const directionClause =
    direction === "outbound"
      ? `(l.source_id IN (${frontierPlaceholders}) OR (l.link_type = 'relates_to' AND l.target_id IN (${frontierPlaceholders})))`
      : direction === "inbound"
        ? `(l.target_id IN (${frontierPlaceholders}) OR (l.link_type = 'relates_to' AND l.source_id IN (${frontierPlaceholders})))`
        : `(l.source_id IN (${frontierPlaceholders}) OR l.target_id IN (${frontierPlaceholders}))`;
  const parameters: string[] = [projectId, ...linkTypes, ...frontier, ...frontier];

  return database
    .prepare(
      `SELECT l.link_id, l.source_id, s.node_type AS source_type, s.node_key AS source_key,
              CASE s.node_type
                WHEN 'work_item' THEN (SELECT title FROM work_items WHERE item_id = s.node_id AND project_id = s.project_id)
                ELSE (SELECT title FROM specifications WHERE spec_id = s.node_id AND project_id = s.project_id)
              END AS source_title,
              l.target_id, t.node_type AS target_type, t.node_key AS target_key,
              CASE t.node_type
                WHEN 'work_item' THEN (SELECT title FROM work_items WHERE item_id = t.node_id AND project_id = t.project_id)
                ELSE (SELECT title FROM specifications WHERE spec_id = t.node_id AND project_id = t.project_id)
              END AS target_title,
              l.link_type
       FROM trace_links AS l
       INNER JOIN trace_nodes AS s ON s.project_id = l.project_id AND s.node_id = l.source_id
       INNER JOIN trace_nodes AS t ON t.project_id = l.project_id AND t.node_id = l.target_id
       WHERE l.project_id = ? AND l.link_type IN (${typePlaceholders})
         AND l.removed_at IS NULL AND ${directionClause}
       ORDER BY l.created_at, l.link_id`,
    )
    .all(...parameters) as TraceLinkRow[];
}

function toNode(edge: TraceLinkRow, side: "source" | "target"): TraceNode {
  return side === "source"
    ? { id: edge.source_id, type: edge.source_type, key: edge.source_key, title: edge.source_title }
    : { id: edge.target_id, type: edge.target_type, key: edge.target_key, title: edge.target_title };
}

function neighborFor(
  type: TraceLinkType,
  source: TraceNode,
  target: TraceNode,
  frontier: ReadonlySet<string>,
  direction: TraceDirection,
): TraceNode | undefined {
  const sourceIsCurrent = frontier.has(source.id);
  const targetIsCurrent = frontier.has(target.id);
  if (type === "relates_to") {
    if (sourceIsCurrent) {
      return target;
    }
    return targetIsCurrent ? source : undefined;
  }
  if (direction === "outbound") {
    return sourceIsCurrent ? target : undefined;
  }
  if (direction === "inbound") {
    return targetIsCurrent ? source : undefined;
  }
  if (sourceIsCurrent) {
    return target;
  }
  return targetIsCurrent ? source : undefined;
}
