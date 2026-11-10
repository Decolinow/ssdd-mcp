import { createHash, randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { assertProjectAuthorization, type ProjectRole } from "./local-identity.js";
import { ApplicationError } from "./errors.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface AuditEventDraft {
  readonly projectId: string;
  readonly principalId: string;
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly correlationId?: string;
  readonly reason?: string;
  readonly payload: JsonValue;
}

export interface IdempotentCommand<T> {
  readonly projectId: string;
  readonly principalId: string;
  readonly action: string;
  readonly requestId: string;
  readonly payload: JsonValue;
  readonly requiredRoles: readonly ProjectRole[];
  readonly auditEvent: AuditEventDraft | ((result: T) => AuditEventDraft);
  readonly execute: () => T;
}

export interface CommandReceipt<T> {
  readonly value: T;
  readonly auditEventIds: readonly string[];
}

interface IdempotencyRow {
  readonly payload_hash: string | null;
  readonly response_json: string | null;
  readonly expires_at: string;
}

const idempotencyWindowMs = 30 * 24 * 60 * 60 * 1_000;

export function executeIdempotentCommand<T>(
  database: SqliteDatabase,
  command: IdempotentCommand<T>,
): CommandReceipt<T> {
  validateCommand(command);
  const payloadHash = hash(canonicalJson(command.payload));

  const execute = database.transaction(() => {
    assertProjectAuthorization(
      database,
      command.projectId,
      command.principalId,
      command.requiredRoles,
    );

    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + idempotencyWindowMs).toISOString();

    database
      .prepare(
        `UPDATE idempotency_records SET payload_hash = NULL, response_json = NULL
         WHERE expires_at <= ? AND response_json IS NOT NULL`,
      )
      .run(createdAt);

    const previous = database
      .prepare(
        `SELECT payload_hash, response_json, expires_at FROM idempotency_records
         WHERE project_id = ? AND principal_id = ? AND action = ? AND request_id = ?`,
      )
      .get(
        command.projectId,
        command.principalId,
        command.action,
        command.requestId,
      ) as IdempotencyRow | undefined;

    if (previous !== undefined) {
      if (previous.payload_hash === null || previous.response_json === null) {
        return { status: "expired" as const };
      }
      if (previous.payload_hash !== payloadHash) {
        throw new ApplicationError(
          "IDEMPOTENCY_CONFLICT",
          "This request ID was already used with a different payload.",
        );
      }
      if (Date.parse(previous.expires_at) <= now.getTime()) {
        return { status: "expired" as const };
      }
      return {
        status: "receipt" as const,
        receipt: JSON.parse(previous.response_json) as CommandReceipt<T>,
      };
    }

    const value = command.execute();
    canonicalJson(value as JsonValue);
    const auditEventId = randomUUID();
    const audit =
      typeof command.auditEvent === "function"
        ? command.auditEvent(value)
        : command.auditEvent;
    validateAuditEvent(command, audit);
    database
      .prepare(
        `INSERT INTO audit_events
          (event_id, project_id, principal_id, event_type, entity_type, entity_id,
           correlation_id, reason, occurred_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        auditEventId,
        audit.projectId,
        audit.principalId,
        audit.eventType,
        audit.entityType,
        audit.entityId,
        audit.correlationId ?? randomUUID(),
        audit.reason?.trim() || null,
        createdAt,
        canonicalJson(audit.payload),
      );

    const responseJson = canonicalJson({
      value: value as JsonValue,
      auditEventIds: [auditEventId],
    });
    const receipt = JSON.parse(responseJson) as CommandReceipt<T>;
    database
      .prepare(
        `INSERT INTO idempotency_records
          (project_id, principal_id, action, request_id, payload_hash, response_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        command.projectId,
        command.principalId,
        command.action,
        command.requestId,
        payloadHash,
        responseJson,
        createdAt,
        expiresAt,
      );

    return { status: "receipt" as const, receipt };
  });

  const outcome = execute.immediate();
  if (outcome.status === "expired") {
    throw new ApplicationError(
      "IDEMPOTENCY_EXPIRED",
      "This request ID is outside the idempotency window. Check the project state before retrying with a new request ID.",
    );
  }
  return outcome.receipt;
}

function validateCommand<T>(command: IdempotentCommand<T>): void {
  if (command.projectId.trim().length === 0 || command.principalId.trim().length === 0) {
    throw new ApplicationError("VALIDATION_FAILED", "Project and principal IDs are required.");
  }
  if (
    command.action.trim().length === 0 ||
    command.action.length > 120 ||
    command.requestId.trim().length === 0 ||
    command.requestId.length > 128
  ) {
    throw new ApplicationError("VALIDATION_FAILED", "Action and request ID are invalid.");
  }
  if (typeof command.auditEvent !== "function") {
    validateAuditEvent(command, command.auditEvent);
  }
}

function validateAuditEvent<T>(
  command: IdempotentCommand<T>,
  auditEvent: AuditEventDraft,
): void {
  if (
    auditEvent.projectId !== command.projectId ||
    auditEvent.principalId !== command.principalId
  ) {
    throw new ApplicationError(
      "VALIDATION_FAILED",
      "The audit event must use the command project and principal.",
    );
  }
}

export function canonicalJson(value: JsonValue): string {
  const serialized = JSON.stringify(canonicalize(value, new WeakSet<object>()));
  if (serialized === undefined) {
    throw new ApplicationError("VALIDATION_FAILED", "Command values must be JSON serializable.");
  }
  return serialized;
}

function canonicalize(value: unknown, seen: WeakSet<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ApplicationError("VALIDATION_FAILED", "Command payload numbers must be finite.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    assertNotCircular(value, seen);
    const canonicalArray = Array.from(value, (entry) => canonicalize(entry, seen));
    seen.delete(value);
    return canonicalArray;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ApplicationError(
        "VALIDATION_FAILED",
        "Command payloads must contain only plain JSON objects.",
      );
    }
    assertNotCircular(value, seen);
    const entries = Object.entries(value);
    const canonicalObject = Object.fromEntries(
      entries
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry, seen)]),
    );
    seen.delete(value);
    return canonicalObject;
  }
  throw new ApplicationError(
    "VALIDATION_FAILED",
    "Command payloads must be JSON serializable.",
  );
}

function assertNotCircular(value: object, seen: WeakSet<object>): void {
  if (seen.has(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "Command payloads cannot contain cycles.");
  }
  seen.add(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
