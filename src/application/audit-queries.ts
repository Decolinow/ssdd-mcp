import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { assertProjectAuthorization } from "./local-identity.js";

export interface AuditEventView {
  readonly id: string;
  readonly sequence: number;
  readonly projectId: string;
  readonly principalId: string;
  readonly principalName: string;
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly correlationId: string;
  readonly reason: string | null;
  readonly occurredAt: string;
  readonly payload: unknown;
  readonly entityReference: AuditEntityReference;
  readonly relatedEntities: readonly AuditEntityReference[];
}

export interface AuditEntityReference {
  readonly entityType: string;
  readonly id: string;
  readonly key: string | null;
  readonly title: string | null;
  readonly label: string;
}

interface AuditCursor {
  readonly version: 1;
  readonly projectId: string;
  readonly principalId: string;
  readonly filterHash: string;
  readonly watermark: number;
  readonly beforeSequence: number;
}

export interface ListAuditEventsResult {
  readonly events: readonly AuditEventView[];
  readonly nextCursor: string | null;
  readonly watermark: number;
}

export function listAuditEvents(
  database: SqliteDatabase,
  input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly entityType?: string;
    readonly entityId?: string;
    readonly limit?: number;
    readonly cursor?: string;
  },
): ListAuditEventsResult {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const entityType = input.entityType?.trim() || null;
  const entityId = input.entityId?.trim() || null;
  const limit = input.limit ?? 50;
  if (entityType !== null && entityType.length > 80) {
    throw new ApplicationError("VALIDATION_FAILED", "Audit entity type exceeds 80 characters.");
  }
  if (entityId !== null && entityId.length > 200) {
    throw new ApplicationError("VALIDATION_FAILED", "Audit entity ID exceeds 200 characters.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "Audit page size must be an integer between 1 and 100.");
  }

  const filterHash = hash(JSON.stringify({ entityType, entityId, limit }));
  const watermarkRow = database.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS watermark FROM audit_events WHERE project_id = ?",
  ).get(input.projectId) as { watermark: number };
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  if (cursor !== undefined) {
    if (
      cursor.projectId !== input.projectId || cursor.principalId !== input.principalId ||
      cursor.filterHash !== filterHash
    ) {
      throw new ApplicationError("VALIDATION_FAILED", "The audit cursor belongs to another project, principal or filter set.");
    }
    if (cursor.watermark !== watermarkRow.watermark) {
      throw new ApplicationError("STALE_CURSOR", "The project changed after this audit page was read. Restart without a cursor.");
    }
  }

  const watermark = cursor?.watermark ?? watermarkRow.watermark;
  const rows = database.prepare(
    `SELECT event.sequence, event.event_id, event.project_id, event.principal_id, principal.display_name,
            event.event_type, event.entity_type, event.entity_id, event.correlation_id, event.reason,
            event.occurred_at, event.payload_json
     FROM audit_events event INNER JOIN principals principal ON principal.principal_id = event.principal_id
     WHERE event.project_id = ? AND event.sequence <= ?
       AND (? IS NULL OR event.entity_type = ?)
       AND (? IS NULL OR event.entity_id = ?)
       AND (? IS NULL OR event.sequence < ?)
     ORDER BY event.sequence DESC LIMIT ?`,
  ).all(
    input.projectId,
    watermark,
    entityType,
    entityType,
    entityId,
    entityId,
    cursor?.beforeSequence ?? null,
    cursor?.beforeSequence ?? null,
    limit + 1,
  ) as Array<{
    sequence: number;
    event_id: string;
    project_id: string;
    principal_id: string;
    display_name: string;
    event_type: string;
    entity_type: string;
    entity_id: string;
    correlation_id: string;
    reason: string | null;
    occurred_at: string;
    payload_json: string;
  }>;
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const payloads = pageRows.map((row) => JSON.parse(row.payload_json) as unknown);
  const resolved = resolveAuditReferences(database, input.projectId, pageRows, payloads);
  const events = pageRows.map((row, index): AuditEventView => ({
    id: row.event_id,
    sequence: row.sequence,
    projectId: row.project_id,
    principalId: row.principal_id,
    principalName: row.display_name,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    correlationId: row.correlation_id,
    reason: row.reason,
    occurredAt: row.occurred_at,
    payload: payloads[index],
    entityReference: resolved.entities.get(referenceMapKey(row.entity_type, row.entity_id)) ??
      createAuditReference(row.entity_type, row.entity_id, null, null),
    relatedEntities: resolved.related.get(row.event_id) ?? [],
  }));
  const last = pageRows.at(-1);
  return {
    events,
    nextCursor: hasMore && last !== undefined ? encodeCursor({
      version: 1,
      projectId: input.projectId,
      principalId: input.principalId,
      filterHash,
      watermark,
      beforeSequence: last.sequence,
    }) : null,
    watermark,
  };
}

interface AuditReferenceRow {
  readonly id: string;
  readonly key: string;
  readonly title: string | null;
}

interface TraceNodeReferenceRow extends AuditReferenceRow {
  readonly entityType: string;
}

function resolveAuditReferences(
  database: SqliteDatabase,
  projectId: string,
  rows: readonly { readonly event_id: string; readonly entity_type: string; readonly entity_id: string }[],
  payloads: readonly unknown[],
): { entities: Map<string, AuditEntityReference>; related: Map<string, readonly AuditEntityReference[]> } {
  const idsByType = new Map<string, Set<string>>();
  const traceIds = new Set<string>();
  const traceLinkIds = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (["work_item", "specification", "scenario", "sprint", "milestone", "test_run"].includes(row.entity_type)) {
      addId(idsByType, row.entity_type, row.entity_id);
    }
    if (row.entity_type === "trace_link") {
      traceLinkIds.add(row.entity_id);
      const payload = asRecord(payloads[index]);
      for (const field of ["sourceId", "targetId"]) {
        if (typeof payload[field] === "string") traceIds.add(payload[field] as string);
      }
    }
  }

  const entities = new Map<string, AuditEntityReference>();
  const nodesById = new Map<string, AuditEntityReference>();
  const related = new Map<string, readonly AuditEntityReference[]>();
  const traceLinksById = new Map<string, { sourceId: string; targetId: string; type: string }>();
  const sources = [
    { type: "work_item", table: "work_items", idColumn: "item_id", keyColumn: "item_key" },
    { type: "specification", table: "specifications", idColumn: "spec_id", keyColumn: "spec_key" },
    { type: "scenario", table: "scenarios", idColumn: "scenario_id", keyColumn: "scenario_key" },
    { type: "sprint", table: "sprints", idColumn: "sprint_id", keyColumn: "sprint_key" },
    { type: "milestone", table: "milestones", idColumn: "milestone_id", keyColumn: "milestone_key" },
  ] as const;
  for (const source of sources) {
    const ids = [...(idsByType.get(source.type) ?? [])];
    if (ids.length === 0) continue;
    const placeholders = ids.map(() => "?").join(", ");
    const matches = database.prepare(
      "SELECT " + source.idColumn + " AS id, " + source.keyColumn + " AS key, title " +
      "FROM " + source.table + " WHERE project_id = ? AND " + source.idColumn + " IN (" + placeholders + ")",
    ).all(projectId, ...ids) as AuditReferenceRow[];
    for (const match of matches) {
      entities.set(referenceMapKey(source.type, match.id), createAuditReference(source.type, match.id, match.key, match.title));
    }
  }

  const testRunIds = [...(idsByType.get("test_run") ?? [])];
  if (testRunIds.length > 0) {
    const placeholders = testRunIds.map(() => "?").join(", ");
    const matches = database.prepare(
      "SELECT run.run_id AS id, run.build_id AS key, " +
      "scenario.scenario_key || ' · ' || scenario.title || ' · r' || run.revision_number || ' · ' || run.result AS title " +
      "FROM test_runs run INNER JOIN scenarios scenario " +
      "ON scenario.project_id = run.project_id AND scenario.scenario_id = run.scenario_id " +
      "WHERE run.project_id = ? AND run.run_id IN (" + placeholders + ")",
    ).all(projectId, ...testRunIds) as AuditReferenceRow[];
    for (const match of matches) {
      entities.set(referenceMapKey("test_run", match.id), createAuditReference("test_run", match.id, match.key, match.title));
    }
  }

  if (traceLinkIds.size > 0) {
    const ids = [...traceLinkIds];
    const placeholders = ids.map(() => "?").join(", ");
    const links = database.prepare(
      "SELECT link_id, source_id, target_id, link_type FROM trace_links " +
      "WHERE project_id = ? AND link_id IN (" + placeholders + ")",
    ).all(projectId, ...ids) as Array<{ link_id: string; source_id: string; target_id: string; link_type: string }>;
    for (const link of links) {
      traceLinksById.set(link.link_id, { sourceId: link.source_id, targetId: link.target_id, type: link.link_type });
      traceIds.add(link.source_id);
      traceIds.add(link.target_id);
    }
  }

  if (traceIds.size > 0) {
    const ids = [...traceIds];
    const placeholders = ids.map(() => "?").join(", ");
    const matches = database.prepare(
      "SELECT node.node_id AS id, node.node_type AS entityType, node.node_key AS key, " +
      "CASE node.node_type " +
      "WHEN 'work_item' THEN (SELECT item.title FROM work_items item WHERE item.project_id = node.project_id AND item.item_id = node.node_id) " +
      "WHEN 'specification' THEN (SELECT specification.title FROM specifications specification WHERE specification.project_id = node.project_id AND specification.spec_id = node.node_id) " +
      "END AS title FROM trace_nodes node WHERE node.project_id = ? AND node.node_id IN (" + placeholders + ")",
    ).all(projectId, ...ids) as TraceNodeReferenceRow[];
    for (const match of matches) {
      const reference = createAuditReference(match.entityType, match.id, match.key, match.title);
      nodesById.set(match.id, reference);
      entities.set(referenceMapKey(match.entityType, match.id), reference);
    }
  }

  for (const [index, row] of rows.entries()) {
    if (row.entity_type === "trace_link") {
      const payload = asRecord(payloads[index]);
      const link = traceLinksById.get(row.entity_id);
      const endpointPayload = {
        ...payload,
        sourceId: typeof payload.sourceId === "string" ? payload.sourceId : link?.sourceId,
        targetId: typeof payload.targetId === "string" ? payload.targetId : link?.targetId,
      };
      related.set(row.event_id, [
        traceEndpointReference(nodesById, endpointPayload, "source"),
        traceEndpointReference(nodesById, endpointPayload, "target"),
      ].filter((reference): reference is AuditEntityReference => reference !== null));
      const linkType = typeof payload.type === "string" ? payload.type : link?.type ?? null;
      entities.set(referenceMapKey(row.entity_type, row.entity_id), createAuditReference(
        row.entity_type, row.entity_id, null, traceLinkLabel(linkType),
      ));
    } else if (!entities.has(referenceMapKey(row.entity_type, row.entity_id))) {
      entities.set(referenceMapKey(row.entity_type, row.entity_id), createAuditReference(row.entity_type, row.entity_id, null, null));
    }
  }
  return { entities, related };
}

function traceEndpointReference(
  nodesById: ReadonlyMap<string, AuditEntityReference>,
  payload: Record<string, unknown>,
  endpoint: "source" | "target",
): AuditEntityReference | null {
  const id = payload[endpoint + "Id"];
  if (typeof id !== "string") return null;
  const reference = nodesById.get(id);
  if (reference !== undefined) return reference;
  const key = payload[endpoint + "Key"];
  return createAuditReference("trace_node", id, typeof key === "string" ? key : null, null);
}

function addId(map: Map<string, Set<string>>, type: string, id: string): void {
  const ids = map.get(type) ?? new Set<string>();
  ids.add(id);
  map.set(type, ids);
}

function createAuditReference(type: string, id: string, key: string | null, title: string | null): AuditEntityReference {
  const label = key === null ? (title ?? type) : title === null ? key : key + " · " + title;
  return { entityType: type, id, key, title, label };
}

function traceLinkLabel(type: string | null): string {
  switch (type) {
    case "depends_on": return "Vínculo de dependência";
    case "relates_to": return "Vínculo de contexto";
    case "implements": return "Vínculo de implementação";
    default: return "Vínculo de rastreabilidade";
  }
}

function referenceMapKey(type: string, id: string): string {
  return type + "\u0000" + id;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function encodeCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): AuditCursor {
  if (value.length > 4_096 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "The audit cursor is invalid.");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isAuditCursor(parsed)) throw new Error("Invalid cursor shape");
    return parsed;
  } catch {
    throw new ApplicationError("VALIDATION_FAILED", "The audit cursor is invalid.");
  }
}

function isAuditCursor(value: unknown): value is AuditCursor {
  if (value === null || typeof value !== "object") return false;
  const cursor = value as Record<string, unknown>;
  return cursor.version === 1 && typeof cursor.projectId === "string" &&
    typeof cursor.principalId === "string" && typeof cursor.filterHash === "string" &&
    typeof cursor.watermark === "number" && Number.isSafeInteger(cursor.watermark) &&
    typeof cursor.beforeSequence === "number" && Number.isSafeInteger(cursor.beforeSequence);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
