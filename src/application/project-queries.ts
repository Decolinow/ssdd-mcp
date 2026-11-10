import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import {
  assertProjectAuthorization,
  getProjectRoles,
  type ProjectRole,
} from "./local-identity.js";

export interface ProjectListItem {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly timezone: string;
  readonly version: number;
  readonly roles: readonly ProjectRole[];
}

export interface ProjectDetails extends ProjectListItem {
  readonly productGoal: string;
  readonly createdAt: string;
}

interface ProjectRow {
  readonly project_id: string;
  readonly project_key: string;
  readonly name: string;
  readonly product_goal: string;
  readonly timezone: string;
  readonly version: number;
  readonly created_at: string;
}

export function listProjects(
  database: SqliteDatabase,
  principalId: string,
): ProjectListItem[] {
  const rows = database
    .prepare(
      `SELECT p.project_id, p.project_key, p.name, p.timezone, p.version, m.role
       FROM projects AS p
       INNER JOIN project_memberships AS m ON m.project_id = p.project_id
       WHERE m.principal_id = ?
       ORDER BY p.project_key, m.role`,
    )
    .all(principalId) as Array<{
    project_id: string;
    project_key: string;
    name: string;
    timezone: string;
    version: number;
    role: ProjectRole;
  }>;

  const projects = new Map<string, ProjectListItem>();
  for (const row of rows) {
    const existing = projects.get(row.project_id);
    if (existing !== undefined) {
      projects.set(row.project_id, {
        ...existing,
        roles: [...existing.roles, row.role],
      });
      continue;
    }

    projects.set(row.project_id, {
      id: row.project_id,
      key: row.project_key,
      name: row.name,
      timezone: row.timezone,
      version: row.version,
      roles: [row.role],
    });
  }

  return [...projects.values()];
}

export function getProject(
  database: SqliteDatabase,
  principalId: string,
  projectId: string,
): ProjectDetails {
  const row = database
    .prepare(
      `SELECT project_id, project_key, name, product_goal, timezone, version, created_at
       FROM projects WHERE project_id = ?`,
    )
    .get(projectId) as ProjectRow | undefined;

  if (row === undefined) {
    throw new ApplicationError("NOT_FOUND", "Project was not found.");
  }

  assertProjectAuthorization(database, projectId, principalId);
  const roles = getProjectRoles(database, projectId, principalId);

  return {
    id: row.project_id,
    key: row.project_key,
    name: row.name,
    productGoal: row.product_goal,
    timezone: row.timezone,
    version: row.version,
    createdAt: row.created_at,
    roles,
  };
}
