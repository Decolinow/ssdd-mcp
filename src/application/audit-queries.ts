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
  const events = pageRows.map((row): AuditEventView => ({
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
    payload: JSON.parse(row.payload_json) as unknown,
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
