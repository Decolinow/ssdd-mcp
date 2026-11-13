import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { assertProjectAuthorization } from "./local-identity.js";

/**
 * Human recovery of abandoned development sessions (SSDD-928). The system has no client heartbeat, so the last
 * observed activity is the latest immutable session event (start, pause, resume). Recovery never invents time:
 * active time that elapsed after the last resume is reported as `unreliableSeconds` and is NOT added to the
 * recorded duration. Authorship stays with the original developer; the recovery principal is recorded on the
 * event and in the audit trail.
 */
export const defaultStaleAfterHours = 24;
const minimumStaleAfterHours = 1;
const maximumStaleAfterHours = 24 * 90;

export interface StaleDevelopmentSession {
  readonly sessionId: string;
  readonly itemKey: string;
  readonly itemTitle: string;
  readonly developerPrincipalId: string;
  readonly developerName: string;
  readonly status: "active" | "paused";
  readonly startedAt: string;
  readonly lastEventType: string;
  readonly lastEventAt: string;
  readonly idleHours: number;
  /** Time recorded so far (accumulated before the last resume); trustworthy. */
  readonly recordedActiveSeconds: number;
  /** Time since the last resume of an active session; nobody observed it, so it is never credited. */
  readonly unreliableSeconds: number;
  readonly version: number;
}

export interface RecoverDevelopmentSessionInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly action: "cancel" | "complete";
  readonly expectedVersion: number;
  readonly staleAfterHours?: number;
  readonly reason: string;
}

export interface RecoveredDevelopmentSession {
  readonly sessionId: string;
  readonly itemKey: string;
  readonly developerPrincipalId: string;
  readonly status: "cancelled" | "completed";
  readonly endedAt: string;
  readonly recordedActiveSeconds: number;
  readonly discardedUnreliableSeconds: number;
  readonly recoveredByPrincipalId: string;
  readonly version: number;
}

interface StaleRow {
  readonly session_id: string; readonly project_id: string; readonly item_key: string; readonly item_title: string;
  readonly developer_principal_id: string; readonly developer_name: string; readonly status: "active" | "paused";
  readonly started_at: string; readonly last_resumed_at: string | null; readonly active_seconds: number; readonly version: number;
  readonly last_event_type: string; readonly last_event_at: string;
}

const selectOpenSessions = `
  SELECT ds.session_id, ds.project_id, wi.item_key, wi.title AS item_title, ds.developer_principal_id,
         p.display_name AS developer_name, ds.status, ds.started_at, ds.last_resumed_at, ds.active_seconds, ds.version,
         (SELECT e.event_type FROM development_session_events e WHERE e.project_id = ds.project_id AND e.session_id = ds.session_id
          ORDER BY e.sequence DESC LIMIT 1) AS last_event_type,
         (SELECT e.occurred_at FROM development_session_events e WHERE e.project_id = ds.project_id AND e.session_id = ds.session_id
          ORDER BY e.sequence DESC LIMIT 1) AS last_event_at
  FROM development_sessions ds
  INNER JOIN work_items wi ON wi.project_id = ds.project_id AND wi.item_id = ds.item_id
  INNER JOIN principals p ON p.principal_id = ds.developer_principal_id
  WHERE ds.project_id = ? AND ds.status IN ('active', 'paused')`;

export function listStaleDevelopmentSessions(database: SqliteDatabase, input: {
  readonly projectId: string;
  readonly principalId: string;
  readonly staleAfterHours?: number;
  readonly limit?: number;
}): { staleAfterHours: number; sessions: StaleDevelopmentSession[] } {
  assertProjectAuthorization(database, input.projectId, input.principalId, ["admin", "tech_lead"]);
  const staleAfterHours = normalizeThreshold(input.staleAfterHours);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new ApplicationError("VALIDATION_FAILED", "Stale session limit must be between 1 and 200.");
  }
  const nowMs = Date.now();
  const sessions = (database.prepare(`${selectOpenSessions} ORDER BY ds.started_at, ds.session_id`).all(input.projectId) as StaleRow[])
    .map((row) => toStale(row, nowMs))
    .filter((session) => session.idleHours >= staleAfterHours)
    .sort((left, right) => right.idleHours - left.idleHours || left.sessionId.localeCompare(right.sessionId))
    .slice(0, limit);
  return { staleAfterHours, sessions };
}

export function recoverDevelopmentSession(
  database: SqliteDatabase,
  input: RecoverDevelopmentSessionInput,
): CommandReceipt<RecoveredDevelopmentSession> {
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new ApplicationError("VALIDATION_FAILED", "A recovery reason of 10-500 characters is required.");
  }
  const staleAfterHours = normalizeThreshold(input.staleAfterHours);
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "development_session.recover",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId, sessionId: input.sessionId, action: input.action,
      expectedVersion: input.expectedVersion, staleAfterHours, reason,
    },
    requiredRoles: ["admin", "tech_lead"],
    auditEvent: (result) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "development_session.recovered",
      entityType: "development_session",
      entityId: result.sessionId,
      reason,
      payload: {
        itemKey: result.itemKey, developerPrincipalId: result.developerPrincipalId, outcome: result.status,
        recordedActiveSeconds: result.recordedActiveSeconds, discardedUnreliableSeconds: result.discardedUnreliableSeconds,
        staleAfterHours,
      },
    }),
    execute: () => {
      const row = database.prepare(`${selectOpenSessions} AND ds.session_id = ?`).get(input.projectId, input.sessionId) as StaleRow | undefined;
      if (row === undefined) {
        throw new ApplicationError("INVALID_TRANSITION", "Only an active or paused development session can be recovered.");
      }
      if (row.version !== input.expectedVersion) {
        throw new ApplicationError("VERSION_CONFLICT", `Session is at version ${row.version}, expected ${input.expectedVersion}.`);
      }
      const nowMs = Date.now();
      const stale = toStale(row, nowMs);
      if (stale.idleHours < staleAfterHours) {
        throw new ApplicationError("SESSION_NOT_STALE", `Session was active ${stale.idleHours}h ago; recovery requires at least ${staleAfterHours}h without activity.`, {
          details: { idleHours: stale.idleHours, staleAfterHours },
        });
      }
      const now = new Date(nowMs).toISOString();
      const status = input.action === "complete" ? "completed" : "cancelled";
      database.prepare(
        `UPDATE development_sessions SET status = ?, last_resumed_at = NULL, ended_at = ?, version = version + 1
         WHERE project_id = ? AND session_id = ? AND version = ?`,
      ).run(status, now, input.projectId, input.sessionId, input.expectedVersion);
      database.prepare(
        `INSERT INTO development_session_events (event_id, project_id, session_id, event_type, principal_id, occurred_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), input.projectId, input.sessionId, status, input.principalId, now, `[recovery] ${reason}`);
      return {
        sessionId: row.session_id, itemKey: row.item_key, developerPrincipalId: row.developer_principal_id, status, endedAt: now,
        recordedActiveSeconds: row.active_seconds, discardedUnreliableSeconds: stale.unreliableSeconds,
        recoveredByPrincipalId: input.principalId, version: row.version + 1,
      };
    },
  });
}

function toStale(row: StaleRow, nowMs: number): StaleDevelopmentSession {
  const lastEventAt = row.last_event_at ?? row.started_at;
  const idleHours = Math.max(0, Math.round(((nowMs - Date.parse(lastEventAt)) / 3_600_000) * 100) / 100);
  const unreliableSeconds = row.status === "active" && row.last_resumed_at !== null
    ? Math.max(0, Math.floor((nowMs - Date.parse(row.last_resumed_at)) / 1_000)) : 0;
  return {
    sessionId: row.session_id, itemKey: row.item_key, itemTitle: row.item_title, developerPrincipalId: row.developer_principal_id,
    developerName: row.developer_name, status: row.status, startedAt: row.started_at,
    lastEventType: row.last_event_type ?? "started", lastEventAt, idleHours,
    recordedActiveSeconds: row.active_seconds, unreliableSeconds, version: row.version,
  };
}

function normalizeThreshold(value: number | undefined): number {
  const hours = value ?? defaultStaleAfterHours;
  if (!Number.isSafeInteger(hours) || hours < minimumStaleAfterHours || hours > maximumStaleAfterHours) {
    throw new ApplicationError("VALIDATION_FAILED", `staleAfterHours must be an integer between ${minimumStaleAfterHours} and ${maximumStaleAfterHours}.`);
  }
  return hours;
}
