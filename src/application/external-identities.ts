import { createHash, randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { projectRoles, type ProjectRole } from "./local-identity.js";

export type ExternalPrincipalType = "human" | "agent" | "service";

export interface GrantExternalIdentityInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly displayName: string;
  readonly principalType: ExternalPrincipalType;
  readonly roles: readonly ProjectRole[];
  readonly reason: string;
}

export interface RevokeExternalIdentityRolesInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly roles: readonly ProjectRole[];
  readonly reason: string;
}

export interface ExternalIdentityReceipt {
  readonly principalId: string;
  readonly identityKey: string;
  readonly principalType: ExternalPrincipalType;
  readonly displayName: string;
  readonly projectRoles: readonly ProjectRole[];
}

export function externalIdentityKey(issuer: string, subject: string): string {
  const normalizedIssuer = normalizeIssuer(issuer);
  const normalizedSubject = normalizeSubject(subject);
  const digest = createHash("sha256")
    .update(`${normalizedIssuer}\u0000${normalizedSubject}`)
    .digest("hex");
  return `oidc:${digest}`;
}

export function grantExternalIdentity(
  database: SqliteDatabase,
  input: GrantExternalIdentityInput,
): CommandReceipt<ExternalIdentityReceipt> {
  const issuer = normalizeIssuer(input.issuer);
  const subject = normalizeSubject(input.subject);
  const identityKey = externalIdentityKey(issuer, subject);
  const displayName = normalizeText(input.displayName, 128, "Display name must contain 1-128 characters.");
  const reason = normalizeText(input.reason, 500, "Reason must contain 1-500 characters.");
  const roles = normalizeRoles(input.roles);
  if (!["human", "agent", "service"].includes(input.principalType)) {
    throw new ApplicationError("VALIDATION_FAILED", "Principal type must be human, agent, or service.");
  }

  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "external_identity.grant",
    requestId: input.requestId,
    payload: {
      issuer,
      subject,
      displayName,
      principalType: input.principalType,
      roles,
      reason,
    },
    requiredRoles: ["admin"],
    auditEvent: (result) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "external_identity.roles_granted",
      entityType: "principal",
      entityId: result.principalId,
      reason,
      payload: {
        identityKey,
        principalType: input.principalType,
        roles,
      },
    }),
    execute: () => {
      const existing = database
        .prepare("SELECT principal_id, principal_type, display_name FROM principals WHERE identity_key = ?")
        .get(identityKey) as {
          principal_id: string;
          principal_type: ExternalPrincipalType;
          display_name: string;
        } | undefined;

      const principalId = existing?.principal_id ?? randomUUID();
      if (existing === undefined) {
        database.prepare(
          `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(principalId, input.principalType, identityKey, displayName, new Date().toISOString());
      } else if (existing.principal_type !== input.principalType || existing.display_name !== displayName) {
        throw new ApplicationError(
          "EXTERNAL_IDENTITY_CONFLICT",
          "The external identity is already linked to a different principal profile.",
        );
      }

      const insertMembership = database.prepare(
        "INSERT OR IGNORE INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)",
      );
      const createdAt = new Date().toISOString();
      for (const role of roles) insertMembership.run(input.projectId, principalId, role, createdAt);

      const assignedRoles = database.prepare(
        "SELECT role FROM project_memberships WHERE project_id = ? AND principal_id = ? ORDER BY role",
      ).all(input.projectId, principalId) as Array<{ role: ProjectRole }>;

      return {
        principalId,
        identityKey,
        principalType: input.principalType,
        displayName,
        projectRoles: assignedRoles.map((row) => row.role),
      };
    },
  });
}

export function revokeExternalIdentityRoles(
  database: SqliteDatabase,
  input: RevokeExternalIdentityRolesInput,
): CommandReceipt<ExternalIdentityReceipt> {
  const identityKey = externalIdentityKey(input.issuer, input.subject);
  const reason = normalizeText(input.reason, 500, "Reason must contain 1-500 characters.");
  const roles = normalizeRoles(input.roles);

  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "external_identity.revoke_roles",
    requestId: input.requestId,
    payload: { identityKey, roles, reason },
    requiredRoles: ["admin"],
    auditEvent: (result) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "external_identity.roles_revoked",
      entityType: "principal",
      entityId: result.principalId,
      reason,
      payload: { identityKey, roles },
    }),
    execute: () => {
      const principal = database
        .prepare("SELECT principal_id, principal_type, display_name FROM principals WHERE identity_key = ?")
        .get(identityKey) as {
          principal_id: string;
          principal_type: ExternalPrincipalType;
          display_name: string;
        } | undefined;
      if (principal === undefined) throw new ApplicationError("NOT_FOUND", "External identity was not found.");

      const revoke = database.prepare(
        "DELETE FROM project_memberships WHERE project_id = ? AND principal_id = ? AND role = ?",
      );
      let removedCount = 0;
      for (const role of roles) removedCount += revoke.run(input.projectId, principal.principal_id, role).changes;
      if (removedCount === 0) {
        throw new ApplicationError("NOT_FOUND", "External identity has none of the requested project roles.");
      }

      const assignedRoles = database.prepare(
        "SELECT role FROM project_memberships WHERE project_id = ? AND principal_id = ? ORDER BY role",
      ).all(input.projectId, principal.principal_id) as Array<{ role: ProjectRole }>;
      return {
        principalId: principal.principal_id,
        identityKey,
        principalType: principal.principal_type,
        displayName: principal.display_name,
        projectRoles: assignedRoles.map((row) => row.role),
      };
    },
  });
}

export function findExternalPrincipalId(
  database: SqliteDatabase,
  issuer: string,
  subject: string,
): string | undefined {
  const identityKey = externalIdentityKey(issuer, subject);
  const row = database
    .prepare(
      `SELECT p.principal_id FROM principals p
       WHERE p.identity_key = ?
         AND EXISTS (
           SELECT 1 FROM project_memberships pm WHERE pm.principal_id = p.principal_id
         )`,
    )
    .get(identityKey) as { principal_id: string } | undefined;
  return row?.principal_id;
}

function normalizeIssuer(value: string): string {
  const issuer = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new ApplicationError("VALIDATION_FAILED", "OIDC issuer must be an absolute URL.");
  }
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new ApplicationError("VALIDATION_FAILED", "OIDC issuer URL is not valid.");
  }
  return issuer;
}

function normalizeSubject(value: string): string {
  const subject = value.trim();
  if (subject.length < 1 || subject.length > 512 || /\p{Cc}/u.test(subject)) {
    throw new ApplicationError("VALIDATION_FAILED", "OIDC subject must contain 1-512 printable characters.");
  }
  return subject;
}

function normalizeRoles(values: readonly ProjectRole[]): ProjectRole[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > projectRoles.length) {
    throw new ApplicationError("VALIDATION_FAILED", "Grant or revoke at least one valid project role.");
  }
  const seen = new Set<ProjectRole>();
  for (const value of values) {
    if (!projectRoles.includes(value) || seen.has(value)) {
      throw new ApplicationError("VALIDATION_FAILED", "Project roles must be valid and unique.");
    }
    seen.add(value);
  }
  return [...seen].sort((left, right) => left.localeCompare(right));
}

function normalizeText(value: string, maxLength: number, message: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxLength) {
    throw new ApplicationError("VALIDATION_FAILED", message);
  }
  return normalized;
}

