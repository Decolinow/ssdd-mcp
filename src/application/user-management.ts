import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { projectRoles, type ProjectRole } from "./local-identity.js";
import { ApplicationError } from "./errors.js";

export type ManagedPrincipalType = "human" | "agent" | "service";

export interface BootstrapAdministrator {
  readonly principalId: string;
  readonly displayName: string;
  readonly authKey: string | null;
}

export interface UserProjectAccess {
  readonly projectId: string;
  readonly roles: readonly ProjectRole[];
}

export interface CreateManagedUserInput {
  readonly actorPrincipalId: string;
  readonly requestId: string;
  readonly displayName: string;
  readonly principalType: ManagedPrincipalType;
  readonly projects: readonly UserProjectAccess[];
  readonly reason: string;
}

export interface ManagedUserReceipt {
  readonly principalId: string;
  readonly displayName: string;
  readonly principalType: ManagedPrincipalType;
  readonly projects: readonly UserProjectAccess[];
  readonly authKeyId: string | null;
  readonly authKey: string | null;
  readonly authKeyIssued: boolean;
  readonly replayed: boolean;
}

export interface RotateUserAuthKeyInput {
  readonly actorPrincipalId: string;
  readonly targetPrincipalId: string;
  readonly requestId: string;
  readonly reason: string;
}

export interface RevokeUserAuthKeysInput extends RotateUserAuthKeyInput {
  readonly keyId?: string;
}

export interface ManagedUserSummary {
  readonly principalId: string;
  readonly displayName: string;
  readonly principalType: ManagedPrincipalType;
  readonly createdAt: string;
  readonly isInstanceAdministrator: boolean;
  readonly projects: readonly UserProjectAccess[];
  readonly authKeys: readonly {
    readonly keyId: string;
    readonly prefix: string;
    readonly createdAt: string;
    readonly lastUsedAt: string | null;
    readonly revokedAt: string | null;
  }[];
}

export interface AuthKeySessionIdentity {
  readonly principalId: string;
  readonly keyId: string;
}

interface PrincipalRow {
  readonly principal_id: string;
  readonly principal_type: ManagedPrincipalType;
  readonly display_name: string;
  readonly created_at: string;
}

interface AdminEventRow {
  readonly actor_principal_id: string;
  readonly action: string;
  readonly payload_hash: string;
  readonly response_json: string;
}

const authKeyPrefix = "ssdd_";

export function ensureBootstrapAdministrator(
  database: SqliteDatabase,
  localPrincipalId: string,
): BootstrapAdministrator {
  const result = database.transaction(() => {
    const existing = database.prepare(
      `SELECT p.principal_id, p.display_name
       FROM instance_administrators admin
       INNER JOIN principals p ON p.principal_id = admin.principal_id
       WHERE admin.singleton_id = 1`,
    ).get() as { principal_id: string; display_name: string } | undefined;
    if (existing !== undefined) {
      return { principalId: existing.principal_id, displayName: existing.display_name, authKey: null };
    }

    const principal = database.prepare(
      "SELECT principal_id, principal_type, display_name FROM principals WHERE principal_id = ?",
    ).get(localPrincipalId) as { principal_id: string; principal_type: string; display_name: string } | undefined;
    if (principal === undefined || principal.principal_type !== "human") {
      throw new ApplicationError("VALIDATION_FAILED", "The bootstrap administrator must be an existing human principal.");
    }

    const authKey = generateAuthKey();
    const now = new Date().toISOString();
    database.prepare(
      "INSERT INTO instance_administrators (singleton_id, principal_id, created_at) VALUES (1, ?, ?)",
    ).run(principal.principal_id, now);
    insertApiKey(database, principal.principal_id, authKey, now);
    writeAdminEvent(database, {
      requestId: `bootstrap:${principal.principal_id}`,
      actorPrincipalId: principal.principal_id,
      targetPrincipalId: principal.principal_id,
      action: "bootstrap",
      payload: { principalId: principal.principal_id },
      reason: "Initial MCP host administrator",
      occurredAt: now,
      response: { principalId: principal.principal_id, displayName: principal.display_name },
    });
    return { principalId: principal.principal_id, displayName: principal.display_name, authKey };
  });

  return result.immediate();
}

export function createManagedUser(
  database: SqliteDatabase,
  input: CreateManagedUserInput,
): ManagedUserReceipt {
  const normalized = normalizeCreateUserInput(input);
  assertInstanceAdministrator(database, input.actorPrincipalId);
  const payloadHash = hash(JSON.stringify(normalized));

  return database.transaction(() => {
    const previous = findAdminEvent(database, input.requestId);
    if (previous !== undefined) {
      assertSameRequest(previous, input.actorPrincipalId, "user.create", payloadHash);
      const receipt = JSON.parse(previous.response_json) as Omit<ManagedUserReceipt, "authKey" | "authKeyIssued" | "replayed">;
      return { ...receipt, authKey: null, authKeyIssued: false, replayed: true };
    }

    const now = new Date().toISOString();
    const principalId = randomUUID();
    const authKey = generateAuthKey();
    const authKeyId = randomUUID();
    database.prepare(
      `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(principalId, normalized.principalType, `api-user:${principalId}`, normalized.displayName, now);

    const projectExists = database.prepare("SELECT 1 AS found FROM projects WHERE project_id = ?");
    const membership = database.prepare(
      "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)",
    );
    for (const project of normalized.projects) {
      if (projectExists.get(project.projectId) === undefined) {
        throw new ApplicationError("NOT_FOUND", `Project '${project.projectId}' was not found.`);
      }
      for (const role of project.roles) membership.run(project.projectId, principalId, role, now);
    }
    insertApiKey(database, principalId, authKey, now, authKeyId);

    const response: Omit<ManagedUserReceipt, "authKey" | "authKeyIssued" | "replayed"> = {
      principalId,
      displayName: normalized.displayName,
      principalType: normalized.principalType,
      projects: normalized.projects,
      authKeyId,
    };
    writeAdminEvent(database, {
      requestId: input.requestId,
      actorPrincipalId: input.actorPrincipalId,
      targetPrincipalId: principalId,
      action: "user.create",
      payload: normalized,
      reason: normalized.reason,
      occurredAt: now,
      response,
    });
    return { ...response, authKey, authKeyIssued: true, replayed: false };
  }).immediate();
}

export function rotateManagedUserAuthKey(
  database: SqliteDatabase,
  input: RotateUserAuthKeyInput,
): ManagedUserReceipt {
  const reason = normalizeText(input.reason, 500, "Reason must contain 1-500 characters.");
  validateRequestId(input.requestId);
  assertInstanceAdministrator(database, input.actorPrincipalId);
  const payload = { targetPrincipalId: input.targetPrincipalId, reason };
  const payloadHash = hash(JSON.stringify(payload));

  return database.transaction(() => {
    const previous = findAdminEvent(database, input.requestId);
    if (previous !== undefined) {
      assertSameRequest(previous, input.actorPrincipalId, "user.auth_key.rotate", payloadHash);
      const receipt = JSON.parse(previous.response_json) as Omit<ManagedUserReceipt, "authKey" | "authKeyIssued" | "replayed">;
      return { ...receipt, authKey: null, authKeyIssued: false, replayed: true };
    }

    const principal = getPrincipal(database, input.targetPrincipalId);
    const now = new Date().toISOString();
    database.prepare(
      "UPDATE principal_api_keys SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL",
    ).run(now, principal.principal_id);
    const authKey = generateAuthKey();
    const authKeyId = randomUUID();
    insertApiKey(database, principal.principal_id, authKey, now, authKeyId);
    const response: Omit<ManagedUserReceipt, "authKey" | "authKeyIssued" | "replayed"> = {
      principalId: principal.principal_id,
      displayName: principal.display_name,
      principalType: principal.principal_type,
      projects: listUserProjectAccess(database, principal.principal_id),
      authKeyId,
    };
    writeAdminEvent(database, {
      requestId: input.requestId,
      actorPrincipalId: input.actorPrincipalId,
      targetPrincipalId: principal.principal_id,
      action: "user.auth_key.rotate",
      payload,
      reason,
      occurredAt: now,
      response,
    });
    return { ...response, authKey, authKeyIssued: true, replayed: false };
  }).immediate();
}

export function revokeManagedUserAuthKeys(
  database: SqliteDatabase,
  input: RevokeUserAuthKeysInput,
): { readonly principalId: string; readonly revokedCount: number; readonly replayed: boolean } {
  const reason = normalizeText(input.reason, 500, "Reason must contain 1-500 characters.");
  validateRequestId(input.requestId);
  assertInstanceAdministrator(database, input.actorPrincipalId);
  const target = getPrincipal(database, input.targetPrincipalId);
  const payload = { targetPrincipalId: target.principal_id, keyId: input.keyId ?? null, reason };
  const payloadHash = hash(JSON.stringify(payload));

  return database.transaction(() => {
    const previous = findAdminEvent(database, input.requestId);
    if (previous !== undefined) {
      assertSameRequest(previous, input.actorPrincipalId, "user.auth_key.revoke", payloadHash);
      const response = JSON.parse(previous.response_json) as { principalId: string; revokedCount: number };
      return { ...response, replayed: true };
    }
    const now = new Date().toISOString();
    const update = input.keyId === undefined
      ? database.prepare("UPDATE principal_api_keys SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL")
        .run(now, target.principal_id)
      : database.prepare("UPDATE principal_api_keys SET revoked_at = ? WHERE principal_id = ? AND key_id = ? AND revoked_at IS NULL")
        .run(now, target.principal_id, input.keyId);
    if (update.changes === 0) throw new ApplicationError("NOT_FOUND", "No active auth key matched this user and key ID.");
    const response = { principalId: target.principal_id, revokedCount: update.changes };
    writeAdminEvent(database, {
      requestId: input.requestId,
      actorPrincipalId: input.actorPrincipalId,
      targetPrincipalId: target.principal_id,
      action: "user.auth_key.revoke",
      payload,
      reason,
      occurredAt: now,
      response,
    });
    return { ...response, replayed: false };
  }).immediate();
}

export function listManagedUsers(database: SqliteDatabase, actorPrincipalId: string): readonly ManagedUserSummary[] {
  assertInstanceAdministrator(database, actorPrincipalId);
  const principals = database.prepare(
    `SELECT p.principal_id, p.principal_type, p.display_name, p.created_at,
            CASE WHEN admin.principal_id IS NULL THEN 0 ELSE 1 END AS is_instance_administrator
     FROM principals p LEFT JOIN instance_administrators admin ON admin.principal_id = p.principal_id
     ORDER BY p.display_name COLLATE NOCASE, p.principal_id`,
  ).all() as Array<PrincipalRow & { is_instance_administrator: number }>;
  const users = principals.map((principal): ManagedUserSummary => ({
    principalId: principal.principal_id,
    displayName: principal.display_name,
    principalType: principal.principal_type,
    createdAt: principal.created_at,
    isInstanceAdministrator: principal.is_instance_administrator === 1,
    projects: listUserProjectAccess(database, principal.principal_id),
    authKeys: (database.prepare(
      `SELECT key_id, key_prefix, created_at, last_used_at, revoked_at
       FROM principal_api_keys WHERE principal_id = ? ORDER BY created_at DESC`,
    ).all(principal.principal_id) as Array<{
      key_id: string; key_prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null;
    }>).map((key) => ({
      keyId: key.key_id,
      prefix: key.key_prefix,
      createdAt: key.created_at,
      lastUsedAt: key.last_used_at,
      revokedAt: key.revoked_at,
    })),
  }));
  return users;
}

export function isInstanceAdministrator(database: SqliteDatabase, principalId: string): boolean {
  return database.prepare(
    "SELECT 1 AS found FROM instance_administrators WHERE singleton_id = 1 AND principal_id = ?",
  ).get(principalId) !== undefined;
}

export function resolvePrincipalFromAuthKey(database: SqliteDatabase, authKey: string): string | undefined {
  return resolveAuthKeySessionIdentity(database, authKey)?.principalId;
}

export function resolveAuthKeySessionIdentity(database: SqliteDatabase, authKey: string): AuthKeySessionIdentity | undefined {
  if (!isAuthKeyFormat(authKey)) return undefined;
  const keyHash = hash(authKey);
  const row = database.prepare(
    `SELECT key_id, principal_id, last_used_at FROM principal_api_keys
     WHERE key_hash = ? AND revoked_at IS NULL`,
  ).get(keyHash) as { key_id: string; principal_id: string; last_used_at: string | null } | undefined;
  if (row === undefined) return undefined;
  const now = new Date();
  if (row.last_used_at === null || now.getTime() - Date.parse(row.last_used_at) >= 15 * 60 * 1_000) {
    database.prepare(
      `UPDATE principal_api_keys SET last_used_at = ?
       WHERE key_id = ? AND revoked_at IS NULL`,
    ).run(now.toISOString(), row.key_id);
  }
  return { principalId: row.principal_id, keyId: row.key_id };
}

export function isAuthKeySessionActive(database: SqliteDatabase, principalId: string, keyId: string): boolean {
  return database.prepare(
    "SELECT 1 AS found FROM principal_api_keys WHERE key_id = ? AND principal_id = ? AND revoked_at IS NULL",
  ).get(keyId, principalId) !== undefined;
}

export function assertInstanceAdministrator(database: SqliteDatabase, principalId: string): void {
  if (!isInstanceAdministrator(database, principalId)) {
    throw new ApplicationError("FORBIDDEN", "This operation requires the MCP host administrator.");
  }
}

function normalizeCreateUserInput(input: CreateManagedUserInput): {
  readonly displayName: string;
  readonly principalType: ManagedPrincipalType;
  readonly projects: readonly UserProjectAccess[];
  readonly reason: string;
} {
  validateRequestId(input.requestId);
  const displayName = normalizeText(input.displayName, 128, "Display name must contain 1-128 characters.");
  const reason = normalizeText(input.reason, 500, "Reason must contain 1-500 characters.");
  if (!["human", "agent", "service"].includes(input.principalType)) {
    throw new ApplicationError("VALIDATION_FAILED", "Principal type must be human, agent or service.");
  }
  if (!Array.isArray(input.projects) || input.projects.length < 1 || input.projects.length > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "Assign the user to between 1 and 100 projects.");
  }
  const projectIds = new Set<string>();
  const projects = input.projects.map((project) => {
    if (!/^[0-9a-f-]{36}$/iu.test(project.projectId) || projectIds.has(project.projectId)) {
      throw new ApplicationError("VALIDATION_FAILED", "Project IDs must be valid and unique.");
    }
    projectIds.add(project.projectId);
    if (!Array.isArray(project.roles) || project.roles.length < 1 || project.roles.length > projectRoles.length) {
      throw new ApplicationError("VALIDATION_FAILED", "Each project assignment requires at least one valid role.");
    }
    const roles = [...new Set<ProjectRole>(project.roles)];
    if (roles.length !== project.roles.length || roles.some((role) => !projectRoles.includes(role))) {
      throw new ApplicationError("VALIDATION_FAILED", "Project roles must be valid and unique.");
    }
    return { projectId: project.projectId, roles: roles.sort() };
  }).sort((left, right) => left.projectId.localeCompare(right.projectId));
  return { displayName, principalType: input.principalType, projects, reason };
}

function listUserProjectAccess(database: SqliteDatabase, principalId: string): UserProjectAccess[] {
  const rows = database.prepare(
    `SELECT project_id, role FROM project_memberships
     WHERE principal_id = ? ORDER BY project_id, role`,
  ).all(principalId) as Array<{ project_id: string; role: ProjectRole }>;
  const projects = new Map<string, ProjectRole[]>();
  for (const row of rows) {
    const roles = projects.get(row.project_id) ?? [];
    roles.push(row.role);
    projects.set(row.project_id, roles);
  }
  return [...projects].map(([projectId, roles]) => ({ projectId, roles }));
}

function getPrincipal(database: SqliteDatabase, principalId: string): PrincipalRow {
  const principal = database.prepare(
    "SELECT principal_id, principal_type, display_name, created_at FROM principals WHERE principal_id = ?",
  ).get(principalId) as PrincipalRow | undefined;
  if (principal === undefined) throw new ApplicationError("NOT_FOUND", "User was not found.");
  return principal;
}

function findAdminEvent(database: SqliteDatabase, requestId: string): AdminEventRow | undefined {
  return database.prepare(
    `SELECT actor_principal_id, action, payload_hash, response_json
     FROM principal_admin_events WHERE request_id = ?`,
  ).get(requestId) as AdminEventRow | undefined;
}

function assertSameRequest(event: AdminEventRow, actorPrincipalId: string, action: string, payloadHash: string): void {
  if (event.actor_principal_id !== actorPrincipalId || event.action !== action || event.payload_hash !== payloadHash) {
    throw new ApplicationError("IDEMPOTENCY_CONFLICT", "This request ID was already used with a different command.");
  }
}

function writeAdminEvent(database: SqliteDatabase, input: {
  readonly requestId: string;
  readonly actorPrincipalId: string;
  readonly targetPrincipalId: string | null;
  readonly action: string;
  readonly payload: unknown;
  readonly reason: string;
  readonly occurredAt: string;
  readonly response: unknown;
}): void {
  database.prepare(
    `INSERT INTO principal_admin_events
      (event_id, request_id, actor_principal_id, target_principal_id, action, payload_hash,
       reason, occurred_at, response_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(), input.requestId, input.actorPrincipalId, input.targetPrincipalId,
    input.action, hash(JSON.stringify(input.payload)), input.reason, input.occurredAt,
    JSON.stringify(input.response),
  );
}

function insertApiKey(database: SqliteDatabase, principalId: string, authKey: string, now: string, keyId = randomUUID()): string {
  database.prepare(
    `INSERT INTO principal_api_keys (key_id, principal_id, key_hash, key_prefix, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(keyId, principalId, hash(authKey), authKey.slice(0, 13), now);
  return keyId;
}

function generateAuthKey(): string {
  return `${authKeyPrefix}${randomBytes(32).toString("base64url")}`;
}

function isAuthKeyFormat(value: string): boolean {
  return /^ssdd_[A-Za-z0-9_-]{43}$/u.test(value);
}

function normalizeText(value: string, maxLength: number, message: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxLength || /\p{Cc}/u.test(normalized)) {
    throw new ApplicationError("VALIDATION_FAILED", message);
  }
  return normalized;
}

function validateRequestId(value: string): void {
  if (value.trim().length < 1 || value.length > 128 || /\p{Cc}/u.test(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "Request ID must contain 1-128 printable characters.");
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
