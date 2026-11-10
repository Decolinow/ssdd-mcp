import { createHash, randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";

export const projectRoles = [
  "admin",
  "po",
  "developer",
  "qa",
  "tech_lead",
  "facilitator",
  "stakeholder",
] as const;

export type ProjectRole = (typeof projectRoles)[number];

export interface LocalPrincipal {
  readonly id: string;
  readonly identityKey: string;
  readonly displayName: string;
}

const bootstrapRoles: readonly ProjectRole[] = projectRoles;

export function getOrCreateLocalPrincipal(
  database: SqliteDatabase,
): LocalPrincipal {
  const displayName = userInfo().username.trim() || "local-user";
  const identityMaterial = `${process.platform}\u0000${hostname()}\u0000${displayName.toLowerCase()}`;
  const identityDigest = createHash("sha256").update(identityMaterial).digest("hex");
  const identityKey = `local:${identityDigest}`;

  const existing = database
    .prepare(
      "SELECT principal_id, identity_key, display_name FROM principals WHERE identity_key = ?",
    )
    .get(identityKey) as
    | { principal_id: string; identity_key: string; display_name: string }
    | undefined;

  if (existing !== undefined) {
    return {
      id: existing.principal_id,
      identityKey: existing.identity_key,
      displayName: existing.display_name,
    };
  }

  const principal: LocalPrincipal = {
    id: randomUUID(),
    identityKey,
    displayName,
  };
  database
    .prepare(
      `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
       VALUES (?, 'human', ?, ?, ?)`,
    )
    .run(principal.id, principal.identityKey, principal.displayName, new Date().toISOString());

  return principal;
}

export function grantBootstrapProjectRoles(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  createdAt: string,
): void {
  const insertMembership = database.prepare(
    "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)",
  );

  for (const role of bootstrapRoles) {
    insertMembership.run(projectId, principalId, role, createdAt);
  }
}

export function getProjectRoles(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
): ProjectRole[] {
  const rows = database
    .prepare(
      "SELECT role FROM project_memberships WHERE project_id = ? AND principal_id = ? ORDER BY role",
    )
    .all(projectId, principalId) as Array<{ role: ProjectRole }>;
  return rows.map((row) => row.role);
}

export function assertProjectAuthorization(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  requiredRoles: readonly ProjectRole[] = [],
): void {
  const assignedRoles = getProjectRoles(database, projectId, principalId);
  if (assignedRoles.length === 0) {
    throw new ApplicationError("FORBIDDEN", "The principal is not a member of this project.");
  }

  if (
    requiredRoles.length > 0 &&
    !requiredRoles.some((role) => assignedRoles.includes(role))
  ) {
    throw new ApplicationError(
      "FORBIDDEN",
      "The principal does not have a role authorized for this operation.",
      { details: { requiredRoles } },
    );
  }
}
