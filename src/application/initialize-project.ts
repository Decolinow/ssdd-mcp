import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, openSync, closeSync } from "node:fs";
import { resolve, join } from "node:path";
import { openSqliteDatabase } from "../storage-sqlite/database.js";
import { applyMigrations } from "../storage-sqlite/migrations.js";
import { ApplicationError } from "./errors.js";
import {
  assertProjectAuthorization,
  getOrCreateLocalPrincipal,
  grantBootstrapProjectRoles,
} from "./local-identity.js";

export interface InitializeProjectInput {
  readonly workspace: string;
  readonly key: string;
  readonly name: string;
  readonly productGoal: string;
  readonly timezone: string;
}

export interface ProjectConfiguration {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly productGoal: string;
  readonly timezone: string;
  readonly version: number;
  readonly createdAt: string;
}

export interface InitializeProjectResult {
  readonly created: boolean;
  readonly project: ProjectConfiguration;
  readonly databasePath: string;
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

export class ProjectConfigurationConflictError extends ApplicationError {
  constructor(key: string) {
    super(
      "PROJECT_CONFIGURATION_CONFLICT",
      `Project '${key}' already exists with different configuration. Initialization never overwrites project data.`,
    );
    this.name = "ProjectConfigurationConflictError";
  }
}

export function initializeProject(
  input: InitializeProjectInput,
): InitializeProjectResult {
  const configuration = normalizeProjectInput(input);
  const workspacePath = resolve(input.workspace);
  const dataDirectory = join(workspacePath, ".ssdd");
  const databasePath = join(dataDirectory, "ssdd.sqlite");

  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  secureWorkspaceStorage(dataDirectory, databasePath);

  const database = openSqliteDatabase(databasePath);
  try {
    applyMigrations(database);

    const createOrReadProject = database.transaction(() => {
      const principal = getOrCreateLocalPrincipal(database);
      const existing = findProject(database, configuration.key);
      if (existing !== undefined) {
        if (!sameConfiguration(existing, configuration)) {
          throw new ProjectConfigurationConflictError(configuration.key);
        }
        assertProjectAuthorization(database, existing.project_id, principal.id);
        return { created: false, project: toProjectConfiguration(existing) };
      }

      const createdAt = new Date().toISOString();
      const projectId = randomUUID();
      database
        .prepare(
          `INSERT INTO projects
            (project_id, project_key, name, product_goal, timezone, created_at, created_by_principal_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectId,
          configuration.key,
          configuration.name,
          configuration.productGoal,
          configuration.timezone,
          createdAt,
          principal.id,
        );
      grantBootstrapProjectRoles(database, projectId, principal.id, createdAt);
      database
        .prepare(
          `INSERT INTO audit_events
            (event_id, project_id, principal_id, event_type, entity_type, entity_id,
             correlation_id, occurred_at, payload_json)
           VALUES (?, ?, ?, 'project.initialized', 'project', ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          projectId,
          principal.id,
          projectId,
          randomUUID(),
          createdAt,
          JSON.stringify({
            key: configuration.key,
            name: configuration.name,
            productGoal: configuration.productGoal,
            timezone: configuration.timezone,
          }),
        );

      const created = findProject(database, configuration.key);
      if (created === undefined) {
        throw new Error("Project was inserted but could not be read back.");
      }
      return { created: true, project: toProjectConfiguration(created) };
    });

    const result = createOrReadProject.immediate();
    secureWorkspaceStorage(dataDirectory, databasePath);
    return { ...result, databasePath };
  } finally {
    database.close();
  }
}

function normalizeProjectInput(
  input: InitializeProjectInput,
): Omit<ProjectConfiguration, "id" | "version" | "createdAt"> {
  const key = input.key.trim().toUpperCase();
  const name = input.name.trim();
  const productGoal = input.productGoal.trim();
  const requestedTimezone = input.timezone.trim();

  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(key)) {
    throw new Error("Project key must start with a letter and contain up to 10 letters or digits.");
  }
  if (name.length === 0 || name.length > 120) {
    throw new Error("Project name must contain between 1 and 120 characters.");
  }
  if (productGoal.length === 0 || productGoal.length > 1_000) {
    throw new Error("Product goal must contain between 1 and 1000 characters.");
  }

  let timezone: string;
  try {
    timezone = new Intl.DateTimeFormat("en-US", {
      timeZone: requestedTimezone,
    }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`'${requestedTimezone}' is not a valid IANA time zone.`);
  }

  return { key, name, productGoal, timezone };
}

function findProject(
  database: ReturnType<typeof openSqliteDatabase>,
  key: string,
): ProjectRow | undefined {
  return database
    .prepare(
      `SELECT project_id, project_key, name, product_goal, timezone, version, created_at
       FROM projects WHERE project_key = ?`,
    )
    .get(key) as ProjectRow | undefined;
}

function toProjectConfiguration(row: ProjectRow): ProjectConfiguration {
  return {
    id: row.project_id,
    key: row.project_key,
    name: row.name,
    productGoal: row.product_goal,
    timezone: row.timezone,
    version: row.version,
    createdAt: row.created_at,
  };
}

function sameConfiguration(
  row: ProjectRow,
  configuration: Omit<ProjectConfiguration, "id" | "version" | "createdAt">,
): boolean {
  return (
    row.project_key.toUpperCase() === configuration.key &&
    row.name === configuration.name &&
    row.product_goal === configuration.productGoal &&
    row.timezone === configuration.timezone
  );
}

function secureWorkspaceStorage(dataDirectory: string, databasePath: string): void {
  if (process.platform === "win32") {
    return;
  }

  chmodSync(dataDirectory, 0o700);
  const fileDescriptor = openSync(databasePath, "a", 0o600);
  closeSync(fileDescriptor);
  chmodSync(databasePath, 0o600);
}
