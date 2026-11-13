import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt, type JsonValue } from "./idempotent-command.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { getWorkItem } from "./work-item-queries.js";

/**
 * Advisory path claims for parallel agents (SSDD-929). A claim reserves a repository-relative file or directory
 * for one principal under a lease. The server only coordinates intent: it is NOT Git enforcement, so agents must
 * still check branch/worktree/diff and never overwrite another person's edits. Expired or released claims never
 * block anyone; overlapping claims by another principal are rejected with an explicit, arbitrable conflict.
 */
export type FileClaimKind = "file" | "directory";
export const minimumLeaseSeconds = 60;
export const maximumLeaseSeconds = 4 * 3_600;
export const defaultLeaseSeconds = 1_800;
const maximumPathsPerCall = 50;

export interface FileClaim {
  readonly claimId: string;
  readonly path: string;
  readonly kind: FileClaimKind;
  readonly principalId: string;
  readonly principalName: string;
  readonly itemKey: string | null;
  readonly branch: string | null;
  readonly worktree: string | null;
  readonly createdAt: string;
  readonly lastHeartbeatAt: string;
  readonly leaseExpiresAt: string;
  readonly status: "active" | "expired" | "released";
  readonly version: number;
}

interface ClaimRow {
  readonly claim_id: string; readonly path: string; readonly kind: FileClaimKind; readonly principal_id: string;
  readonly principal_name: string; readonly item_key: string | null; readonly branch: string | null; readonly worktree: string | null;
  readonly created_at: string; readonly last_heartbeat_at: string; readonly lease_expires_at: string;
  readonly released_at: string | null; readonly version: number;
}

const selectClaims = `
  SELECT fc.claim_id, fc.path, fc.kind, fc.principal_id, p.display_name AS principal_name, wi.item_key, fc.branch, fc.worktree,
         fc.created_at, fc.last_heartbeat_at, fc.lease_expires_at, fc.released_at, fc.version
  FROM file_claims fc
  INNER JOIN principals p ON p.principal_id = fc.principal_id
  LEFT JOIN work_items wi ON wi.project_id = fc.project_id AND wi.item_id = fc.item_id
  WHERE fc.project_id = ?`;

export function normalizeClaimPath(raw: string): string {
  const value = raw.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (value.length === 0 || value.length > 500 || /\p{Cc}/u.test(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "Claim paths must contain 1-500 printable characters.");
  }
  if (value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
    throw new ApplicationError("VALIDATION_FAILED", "Claim paths must be relative to the repository root and must not contain '..'.", { details: { path: raw } });
  }
  return value;
}

export function pathsOverlap(left: { path: string; kind: FileClaimKind }, right: { path: string; kind: FileClaimKind }): boolean {
  if (left.path === right.path) return true;
  if (left.kind === "directory" && right.path.startsWith(`${left.path}/`)) return true;
  if (right.kind === "directory" && left.path.startsWith(`${right.path}/`)) return true;
  return false;
}

export interface AcquireFileClaimsInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly paths: readonly { readonly path: string; readonly kind: FileClaimKind }[];
  readonly itemIdOrKey?: string;
  readonly branch?: string;
  readonly worktree?: string;
  readonly leaseSeconds?: number;
}

export function acquireFileClaims(database: SqliteDatabase, input: AcquireFileClaimsInput): CommandReceipt<{ claims: FileClaim[] }> {
  if (input.paths.length < 1 || input.paths.length > maximumPathsPerCall) {
    throw new ApplicationError("VALIDATION_FAILED", `Provide 1-${maximumPathsPerCall} paths per call.`);
  }
  const paths = input.paths.map((entry) => ({ path: normalizeClaimPath(entry.path), kind: entry.kind }));
  const leaseSeconds = normalizeLease(input.leaseSeconds);
  const branch = optionalText(input.branch, 200, "branch");
  const worktree = optionalText(input.worktree, 500, "worktree");
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "file_claim.acquire",
    requestId: input.requestId,
    payload: { projectId: input.projectId, paths, itemIdOrKey: input.itemIdOrKey ?? null, branch, worktree, leaseSeconds } as unknown as JsonValue,
    requiredRoles: ["developer", "tech_lead"],
    auditEvent: (result) => ({
      projectId: input.projectId, principalId: input.principalId, eventType: "file_claim.acquired", entityType: "file_claim",
      entityId: result.claims[0]!.claimId,
      payload: { claimIds: result.claims.map((claim) => claim.claimId), paths: result.claims.map((claim) => claim.path), leaseSeconds, branch, worktree },
    }),
    execute: () => {
      const itemId = input.itemIdOrKey === undefined ? null : getWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey).id;
      const nowMs = Date.now();
      const active = activeClaims(database, input.projectId, nowMs);
      const conflicts = paths.flatMap((wanted) => active
        .filter((claim) => claim.principal_id !== input.principalId && pathsOverlap(wanted, claim))
        .map((claim) => ({ requestedPath: wanted.path, claimId: claim.claim_id, path: claim.path, kind: claim.kind, ownerPrincipalId: claim.principal_id, ownerName: claim.principal_name, leaseExpiresAt: claim.lease_expires_at, branch: claim.branch, worktree: claim.worktree })));
      if (conflicts.length > 0) {
        throw new ApplicationError("CLAIM_CONFLICT", "Another principal holds an overlapping claim; coordinate or ask a Tech Lead to arbitrate.", { details: { conflicts } });
      }
      const nowIso = new Date(nowMs).toISOString();
      const expires = new Date(nowMs + leaseSeconds * 1_000).toISOString();
      const claimIds: string[] = [];
      for (const wanted of paths) {
        const own = active.find((claim) => claim.principal_id === input.principalId && claim.path === wanted.path && claim.kind === wanted.kind);
        if (own !== undefined) {
          database.prepare("UPDATE file_claims SET last_heartbeat_at = ?, lease_expires_at = ?, version = version + 1 WHERE claim_id = ?").run(nowIso, expires, own.claim_id);
          claimIds.push(own.claim_id);
          continue;
        }
        const claimId = randomUUID();
        database.prepare(
          `INSERT INTO file_claims (claim_id, project_id, item_id, principal_id, path, kind, branch, worktree, created_at, last_heartbeat_at, lease_expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(claimId, input.projectId, itemId, input.principalId, wanted.path, wanted.kind, branch, worktree, nowIso, nowIso, expires);
        claimIds.push(claimId);
      }
      return { claims: claimIds.map((id) => readClaim(database, input.projectId, id, nowMs)) };
    },
  });
}

export function renewFileClaims(database: SqliteDatabase, input: {
  readonly projectId: string; readonly principalId: string; readonly requestId: string;
  readonly claimIds: readonly string[]; readonly leaseSeconds?: number;
}): CommandReceipt<{ claims: FileClaim[] }> {
  const claimIds = uniqueIds(input.claimIds);
  const leaseSeconds = normalizeLease(input.leaseSeconds);
  return executeIdempotentCommand(database, {
    projectId: input.projectId, principalId: input.principalId, action: "file_claim.renew", requestId: input.requestId,
    payload: { projectId: input.projectId, claimIds, leaseSeconds }, requiredRoles: ["developer", "tech_lead"],
    auditEvent: (result) => ({
      projectId: input.projectId, principalId: input.principalId, eventType: "file_claim.renewed", entityType: "file_claim",
      entityId: result.claims[0]!.claimId, payload: { claimIds, leaseSeconds },
    }),
    execute: () => {
      const nowMs = Date.now();
      const active = activeClaims(database, input.projectId, nowMs);
      for (const claimId of claimIds) {
        const row = findClaim(database, input.projectId, claimId);
        if (row.principal_id !== input.principalId) throw new ApplicationError("FORBIDDEN", "Only the claim owner can renew it.");
        if (row.released_at !== null) throw new ApplicationError("INVALID_TRANSITION", "A released claim cannot be renewed; acquire it again.");
        const clash = active.find((other) => other.claim_id !== row.claim_id && other.principal_id !== input.principalId && pathsOverlap(row, other));
        if (clash !== undefined) {
          throw new ApplicationError("CLAIM_CONFLICT", "The lease expired and another principal now holds an overlapping claim.", { details: { claimId, conflictingClaimId: clash.claim_id } });
        }
        const nowIso = new Date(nowMs).toISOString();
        database.prepare("UPDATE file_claims SET last_heartbeat_at = ?, lease_expires_at = ?, version = version + 1 WHERE claim_id = ?")
          .run(nowIso, new Date(nowMs + leaseSeconds * 1_000).toISOString(), claimId);
      }
      return { claims: claimIds.map((id) => readClaim(database, input.projectId, id, nowMs)) };
    },
  });
}

export function releaseFileClaims(database: SqliteDatabase, input: {
  readonly projectId: string; readonly principalId: string; readonly requestId: string;
  readonly claimIds: readonly string[]; readonly reason?: string;
}): CommandReceipt<{ claims: FileClaim[] }> {
  const claimIds = uniqueIds(input.claimIds);
  const reason = optionalText(input.reason, 500, "reason");
  return executeIdempotentCommand(database, {
    projectId: input.projectId, principalId: input.principalId, action: "file_claim.release", requestId: input.requestId,
    payload: { projectId: input.projectId, claimIds, reason }, requiredRoles: ["developer", "tech_lead"],
    auditEvent: (result) => ({
      projectId: input.projectId, principalId: input.principalId, eventType: "file_claim.released", entityType: "file_claim",
      entityId: result.claims[0]!.claimId, ...(reason === null ? {} : { reason }), payload: { claimIds },
    }),
    execute: () => {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const arbiter = isArbiter(database, input.projectId, input.principalId);
      for (const claimId of claimIds) {
        const row = findClaim(database, input.projectId, claimId);
        if (row.principal_id !== input.principalId && !arbiter) {
          throw new ApplicationError("FORBIDDEN", "Only the owner or a Tech Lead/Admin can release this claim.");
        }
        if (row.principal_id !== input.principalId && (reason === null || reason.length < 10)) {
          throw new ApplicationError("VALIDATION_FAILED", "Arbitrated release of another principal's claim requires a reason of at least 10 characters.");
        }
        if (row.released_at === null) {
          database.prepare(
            `UPDATE file_claims SET released_at = ?, release_reason = ?, released_by_principal_id = ?, version = version + 1 WHERE claim_id = ?`,
          ).run(nowIso, reason, input.principalId, claimId);
        }
      }
      return { claims: claimIds.map((id) => readClaim(database, input.projectId, id, nowMs)) };
    },
  });
}

export function listFileClaims(database: SqliteDatabase, input: {
  readonly projectId: string; readonly principalId: string; readonly includeInactive?: boolean;
  readonly pathPrefix?: string; readonly mine?: boolean; readonly limit?: number;
}): { claims: FileClaim[] } {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ApplicationError("VALIDATION_FAILED", "Claim limit must be between 1 and 200.");
  const prefix = input.pathPrefix === undefined ? undefined : normalizeClaimPath(input.pathPrefix);
  const nowMs = Date.now();
  const claims = (database.prepare(`${selectClaims} ORDER BY fc.created_at DESC, fc.claim_id`).all(input.projectId) as ClaimRow[])
    .map((row) => toClaim(row, nowMs))
    .filter((claim) => (input.includeInactive === true || claim.status === "active")
      && (input.mine !== true || claim.principalId === input.principalId)
      && (prefix === undefined || pathsOverlap({ path: prefix, kind: "directory" }, claim)))
    .slice(0, limit);
  return { claims };
}

function activeClaims(database: SqliteDatabase, projectId: string, nowMs: number): ClaimRow[] {
  return (database.prepare(`${selectClaims} AND fc.released_at IS NULL AND fc.lease_expires_at > ?`).all(projectId, new Date(nowMs).toISOString()) as ClaimRow[]);
}

function findClaim(database: SqliteDatabase, projectId: string, claimId: string): ClaimRow {
  const row = database.prepare(`${selectClaims} AND fc.claim_id = ?`).get(projectId, claimId) as ClaimRow | undefined;
  if (row === undefined) throw new ApplicationError("NOT_FOUND", "File claim was not found.");
  return row;
}

function readClaim(database: SqliteDatabase, projectId: string, claimId: string, nowMs: number): FileClaim {
  return toClaim(findClaim(database, projectId, claimId), nowMs);
}

function toClaim(row: ClaimRow, nowMs: number): FileClaim {
  return {
    claimId: row.claim_id, path: row.path, kind: row.kind, principalId: row.principal_id, principalName: row.principal_name,
    itemKey: row.item_key, branch: row.branch, worktree: row.worktree, createdAt: row.created_at,
    lastHeartbeatAt: row.last_heartbeat_at, leaseExpiresAt: row.lease_expires_at,
    status: row.released_at !== null ? "released" : Date.parse(row.lease_expires_at) > nowMs ? "active" : "expired",
    version: row.version,
  };
}

function isArbiter(database: SqliteDatabase, projectId: string, principalId: string): boolean {
  try {
    assertProjectAuthorization(database, projectId, principalId, ["admin", "tech_lead"]);
    return true;
  } catch {
    return false;
  }
}

function normalizeLease(value: number | undefined): number {
  const seconds = value ?? defaultLeaseSeconds;
  if (!Number.isSafeInteger(seconds) || seconds < minimumLeaseSeconds || seconds > maximumLeaseSeconds) {
    throw new ApplicationError("VALIDATION_FAILED", `leaseSeconds must be between ${minimumLeaseSeconds} and ${maximumLeaseSeconds}.`);
  }
  return seconds;
}

function uniqueIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length < 1 || unique.length > maximumPathsPerCall) {
    throw new ApplicationError("VALIDATION_FAILED", `Provide 1-${maximumPathsPerCall} claim IDs.`);
  }
  return unique;
}

function optionalText(value: string | undefined, max: number, name: string): string | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (text.length === 0) return null;
  if (text.length > max || /\p{Cc}/u.test(text)) throw new ApplicationError("VALIDATION_FAILED", `${name} must have at most ${max} printable characters.`);
  return text;
}
