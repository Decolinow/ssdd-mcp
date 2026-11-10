import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { chmod, copyFile, link, mkdir, readFile, readdir, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, basename, join, resolve } from "node:path";
import Sqlite from "better-sqlite3";
import { applyMigrations, inspectMigrationHistory, type MigrationInspection } from "../storage-sqlite/migrations.js";
import { openSqliteDatabase } from "../storage-sqlite/database.js";

const backupManifestVersion = 1;
const exportVersion = 1;
const backupFileNamePrefix = "ssdd-backup-";
const excludedExportTables = new Set([
  "command_approvals",
  "idempotency_records",
  "schema_migrations",
  "project_sequences",
]);

export interface BackupManifest {
  readonly manifestVersion: 1;
  readonly databaseFile: string;
  readonly createdAt: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly schemaVersion: number;
  readonly projectKeys: readonly string[];
}

export interface BackupResult {
  readonly backupPath: string;
  readonly manifestPath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly schemaVersion: number;
  readonly projectKeys: readonly string[];
}

export interface RestoreResult {
  readonly workspace: string;
  readonly databasePath: string;
  readonly sourceSha256: string;
  readonly sourceSchemaVersion: number;
  readonly restoredSchemaVersion: number;
  readonly projectKeys: readonly string[];
}

export interface DoctorReport {
  readonly status: "ok" | "warning" | "error";
  readonly appVersion: string;
  readonly databasePresent: boolean;
  readonly sqliteVersion: string | null;
  readonly journalMode: string | null;
  readonly integrity: "ok" | "failed" | "not_checked";
  readonly foreignKeyViolations: number | null;
  readonly migrations: MigrationInspection | null;
  readonly projectCount: number | null;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

export interface ExportResult {
  readonly outputPath: string | null;
  readonly format: "json" | "markdown" | "gherkin";
  readonly bytes: number;
  readonly projectKeys: readonly string[];
}

interface DatabaseOverview {
  readonly schemaVersion: number;
  readonly projectKeys: readonly string[];
  readonly integrityCheck: string;
}

export async function backupWorkspace(workspace: string, outputPath?: string): Promise<BackupResult> {
  const databasePath = workspaceDatabasePath(workspace);
  if (!await pathExists(databasePath)) throw new Error(`No SSDD workspace database found at '${databasePath}'.`);

  const resolvedOutput = resolve(outputPath ?? join(
    dirname(databasePath),
    `${backupFileNamePrefix}${new Date().toISOString().replace(/[:.]/gu, "-")}.sqlite`,
  ));
  if (resolvedOutput === databasePath) throw new Error("Backup output cannot overwrite the active workspace database.");
  const manifestPath = `${resolvedOutput}.manifest.json`;
  await mkdir(dirname(resolvedOutput), { recursive: true, mode: 0o700 });
  if (await pathExists(resolvedOutput) || await pathExists(manifestPath)) {
    throw new Error("Backup output or its manifest already exists; choose a new output path.");
  }

  const temporaryPath = `${resolvedOutput}.${randomUUID()}.tmp`;
  try {
    const database = openSqliteDatabase(databasePath);
    try {
      const integrity = String(database.pragma("integrity_check", { simple: true }));
      if (integrity !== "ok") throw new Error("Workspace database failed SQLite integrity_check; backup was not created.");
      const foreignKeyViolations = (database.pragma("foreign_key_check") as unknown[]).length;
      if (foreignKeyViolations > 0) throw new Error("Workspace database has foreign key violations; backup was not created.");
      await database.backup(temporaryPath);
    } finally {
      database.close();
    }
    const overview = inspectDatabaseFile(temporaryPath);
    if (overview.integrityCheck !== "ok") throw new Error("SQLite backup failed integrity_check.");
    const fileStat = await stat(temporaryPath);
    const sha256 = await sha256File(temporaryPath);
    const manifest: BackupManifest = {
      manifestVersion: backupManifestVersion,
      databaseFile: basename(resolvedOutput),
      createdAt: new Date().toISOString(),
      sizeBytes: fileStat.size,
      sha256,
      schemaVersion: overview.schemaVersion,
      projectKeys: overview.projectKeys,
    };
    await copyFile(temporaryPath, resolvedOutput, constants.COPYFILE_EXCL);
    try {
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      await unlink(resolvedOutput).catch(() => undefined);
      throw error;
    }
    await chmod(resolvedOutput, 0o600).catch(() => undefined);
    return {
      backupPath: resolvedOutput,
      manifestPath,
      sizeBytes: manifest.sizeBytes,
      sha256,
      schemaVersion: manifest.schemaVersion,
      projectKeys: manifest.projectKeys,
    };
  } finally {
    await rm(temporaryPath, { force: true });
    await rm(`${temporaryPath}-wal`, { force: true });
    await rm(`${temporaryPath}-shm`, { force: true });
  }
}

export async function restoreWorkspace(workspace: string, backupPath: string): Promise<RestoreResult> {
  const resolvedWorkspace = resolve(workspace);
  const resolvedBackup = resolve(backupPath);
  const manifestPath = `${resolvedBackup}.manifest.json`;
  const manifest = parseBackupManifest(await readFile(manifestPath, "utf8"));
  if (manifest.databaseFile !== basename(resolvedBackup)) {
    throw new Error("Backup manifest names a different database file.");
  }
  const backupStat = await stat(resolvedBackup);
  if (backupStat.size !== manifest.sizeBytes || await sha256File(resolvedBackup) !== manifest.sha256) {
    throw new Error("Backup file does not match its manifest hash or size.");
  }
  const backupOverview = inspectDatabaseFile(resolvedBackup);
  if (
    backupOverview.integrityCheck !== "ok" ||
    backupOverview.schemaVersion !== manifest.schemaVersion ||
    JSON.stringify(backupOverview.projectKeys) !== JSON.stringify(manifest.projectKeys)
  ) {
    throw new Error("Backup database contents do not match the verified manifest.");
  }

  const databasePath = workspaceDatabasePath(resolvedWorkspace);
  const databaseDirectory = dirname(databasePath);
  await mkdir(resolvedWorkspace, { recursive: true, mode: 0o700 });
  let createdDatabaseDirectory = false;
  if (await pathExists(databaseDirectory)) {
    const entries = await readdir(databaseDirectory);
    if (entries.length > 0) throw new Error("Restore requires a clean workspace with an empty .ssdd directory.");
  } else {
    await mkdir(databaseDirectory, { recursive: true, mode: 0o700 });
    createdDatabaseDirectory = true;
  }
  await chmod(databaseDirectory, 0o700).catch(() => undefined);

  const stagingPath = join(databaseDirectory, `.restore-${randomUUID()}.sqlite`);
  try {
    await copyFile(resolvedBackup, stagingPath, constants.COPYFILE_EXCL);
    const restored = openSqliteDatabase(stagingPath);
    let overview: DatabaseOverview;
    try {
      applyMigrations(restored);
      const integrity = String(restored.pragma("integrity_check", { simple: true }));
      const foreignKeyViolations = (restored.pragma("foreign_key_check") as unknown[]).length;
      if (integrity !== "ok" || foreignKeyViolations !== 0) {
        throw new Error("Restored database failed integrity or foreign key checks.");
      }
      overview = readDatabaseOverview(restored);
    } finally {
      restored.close();
    }
    await chmod(stagingPath, 0o600).catch(() => undefined);
    await link(stagingPath, databasePath);
    await unlink(stagingPath).catch(() => undefined);
    return {
      workspace: resolvedWorkspace,
      databasePath,
      sourceSha256: manifest.sha256,
      sourceSchemaVersion: manifest.schemaVersion,
      restoredSchemaVersion: overview.schemaVersion,
      projectKeys: overview.projectKeys,
    };
  } catch (error) {
    await rm(stagingPath, { force: true });
    await rm(`${stagingPath}-wal`, { force: true });
    await rm(`${stagingPath}-shm`, { force: true });
    if (createdDatabaseDirectory) await rmdir(databaseDirectory).catch(() => undefined);
    throw error;
  }
}

export function diagnoseWorkspace(workspace: string): DoctorReport {
  const databasePath = workspaceDatabasePath(workspace);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!sqliteDatabaseExists(databasePath)) {
    return {
      status: "error",
      appVersion: "0.1.0",
      databasePresent: false,
      sqliteVersion: null,
      journalMode: null,
      integrity: "not_checked",
      foreignKeyViolations: null,
      migrations: null,
      projectCount: null,
      warnings,
      errors: ["Workspace database is missing. Run `ssdd-mcp init` first."],
    };
  }

  let database: Sqlite.Database | undefined;
  try {
    database = new Sqlite(databasePath, { readonly: true, fileMustExist: true });
    const sqliteVersion = (database.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
    const journalMode = String(database.pragma("journal_mode", { simple: true })).toLowerCase();
    const integrityCheck = String(database.pragma("integrity_check", { simple: true }));
    const foreignKeyViolations = (database.pragma("foreign_key_check") as unknown[]).length;
    const migrations = inspectMigrationHistory(database);
    const projectCount = (database.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }).count;
    const ftsAvailable = database.prepare(
      "SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'work_items_fts'",
    ).get() !== undefined;
    const jsonAvailable = database.prepare("SELECT json_valid('{}') AS valid").get() as { valid: number };

    if (integrityCheck !== "ok") errors.push("SQLite integrity_check failed.");
    if (foreignKeyViolations > 0) errors.push("Database contains foreign key violations.");
    if (migrations.status === "drift" || migrations.status === "ahead" || migrations.status === "missing") {
      errors.push(`Migration history is ${migrations.status}; do not start the server until it is repaired or upgraded.`);
    } else if (migrations.status === "behind") {
      warnings.push("Database has migrations pending; the next application start will apply them.");
    }
    if (journalMode !== "wal") warnings.push(`Database journal mode is '${journalMode}', expected 'wal'.`);
    if (!ftsAvailable) warnings.push("The work item full-text index is unavailable.");
    if (jsonAvailable.valid !== 1) warnings.push("SQLite JSON functions are unavailable.");

    const status = errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "ok";
    return {
      status,
      appVersion: "0.1.0",
      databasePresent: true,
      sqliteVersion,
      journalMode,
      integrity: integrityCheck === "ok" ? "ok" : "failed",
      foreignKeyViolations,
      migrations,
      projectCount,
      warnings,
      errors,
    };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Database diagnostic failed.");
    return {
      status: "error",
      appVersion: "0.1.0",
      databasePresent: true,
      sqliteVersion: null,
      journalMode: null,
      integrity: "failed",
      foreignKeyViolations: null,
      migrations: null,
      projectCount: null,
      warnings,
      errors,
    };
  } finally {
    database?.close();
  }
}

export function exportWorkspace(
  workspace: string,
  format: "json" | "markdown" | "gherkin",
): { readonly content: string; readonly projectKeys: readonly string[] } {
  const databasePath = workspaceDatabasePath(workspace);
  const database = openSqliteDatabase(databasePath);
  try {
    const overview = readDatabaseOverview(database);
    const projects = database.prepare(
      `SELECT project_id AS id, project_key AS key, name, product_goal AS productGoal,
              timezone, created_at AS createdAt, version
       FROM projects ORDER BY project_key COLLATE NOCASE`,
    ).all() as Array<Record<string, unknown> & { id: string; key: string; name: string; productGoal: string; timezone: string }>;
    if (format === "gherkin") {
      return { content: renderGherkinExport(database), projectKeys: overview.projectKeys };
    }
    const principals = database.prepare(
      `SELECT DISTINCT p.principal_id AS id, p.principal_type AS type,
              p.display_name AS displayName, p.created_at AS createdAt
       FROM principals p
       LEFT JOIN project_memberships pm ON pm.principal_id = p.principal_id
       LEFT JOIN projects pr ON pr.created_by_principal_id = p.principal_id
       WHERE pm.project_id IN (SELECT project_id FROM projects)
          OR pr.project_id IN (SELECT project_id FROM projects)
       ORDER BY p.display_name COLLATE NOCASE`,
    ).all() as Array<Record<string, unknown>>;

    const exportedTables: Record<string, readonly Record<string, unknown>[]> = {};
    const tableRows = database.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    ).all() as Array<{ name: string }>;
    const projectIds = projects.map((project) => project.id as string);
    for (const { name } of tableRows) {
      if (excludedExportTables.has(name) || name === "principals" || projectIds.length === 0) continue;
      const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "project_id")) continue;
      const placeholders = projectIds.map(() => "?").join(", ");
      const rows = database.prepare(
        `SELECT * FROM ${quoteIdentifier(name)} WHERE project_id IN (${placeholders})`,
      ).all(...projectIds) as Array<Record<string, unknown>>;
      exportedTables[name] = rows.map(redactSensitiveColumns);
    }

    const exportDocument = {
      format: "ssdd-mcp-export",
      exportVersion,
      exportedAt: new Date().toISOString(),
      schemaVersion: overview.schemaVersion,
      projects: projects.map(redactSensitiveColumns),
      principals: principals.map(redactSensitiveColumns),
      tables: exportedTables,
    };
    if (format === "json") {
      return { content: `${JSON.stringify(exportDocument, null, 2)}\n`, projectKeys: overview.projectKeys };
    }
    return { content: renderMarkdownExport(exportDocument), projectKeys: overview.projectKeys };
  } finally {
    database.close();
  }
}

export async function writeExport(
  workspace: string,
  format: "json" | "markdown" | "gherkin",
  outputPath: string,
): Promise<ExportResult> {
  const resolvedOutput = resolve(outputPath);
  const exported = exportWorkspace(workspace, format);
  await mkdir(dirname(resolvedOutput), { recursive: true, mode: 0o700 });
  await writeFile(resolvedOutput, exported.content, { flag: "wx", mode: 0o600 });
  return {
    outputPath: resolvedOutput,
    format,
    bytes: Buffer.byteLength(exported.content, "utf8"),
    projectKeys: exported.projectKeys,
  };
}

export function workspaceDatabasePath(workspace: string): string {
  return join(resolve(workspace), ".ssdd", "ssdd.sqlite");
}

function readDatabaseOverview(database: Sqlite.Database): DatabaseOverview {
  const migration = inspectMigrationHistory(database);
  if (migration.status === "missing" || migration.status === "drift" || migration.status === "ahead") {
    throw new Error(`Database migration history is ${migration.status}.`);
  }
  const integrityCheck = String(database.pragma("integrity_check", { simple: true }));
  const projectKeys = (database.prepare("SELECT project_key FROM projects ORDER BY project_key COLLATE NOCASE").all() as Array<{ project_key: string }>).map((row) => row.project_key);
  return { schemaVersion: migration.appliedVersion, projectKeys, integrityCheck };
}

function inspectDatabaseFile(path: string): DatabaseOverview {
  const database = new Sqlite(path, { readonly: true, fileMustExist: true });
  try {
    return readDatabaseOverview(database);
  } finally {
    database.close();
  }
}

function parseBackupManifest(text: string): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Backup manifest is not valid JSON.");
  }
  if (value === null || typeof value !== "object") {
    throw new Error("Backup manifest has an unsupported or invalid shape.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.manifestVersion !== backupManifestVersion ||
    typeof record.databaseFile !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.sizeBytes !== "number" ||
    !Number.isSafeInteger(record.sizeBytes) ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.sha256) ||
    typeof record.schemaVersion !== "number" ||
    !Number.isSafeInteger(record.schemaVersion) ||
    !Array.isArray(record.projectKeys) ||
    !record.projectKeys.every((key: unknown) => typeof key === "string")
  ) {
    throw new Error("Backup manifest has an unsupported or invalid shape.");
  }
  return record as unknown as BackupManifest;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function sqliteDatabaseExists(path: string): boolean {
  try {
    const database = new Sqlite(path, { readonly: true, fileMustExist: true });
    database.close();
    return true;
  } catch {
    return false;
  }
}

function quoteIdentifier(value: string): string {
  const escaped = value.split(String.fromCharCode(34)).join(String.fromCharCode(34).repeat(2));
  return `${String.fromCharCode(34)}${escaped}${String.fromCharCode(34)}`;
}

function redactSensitiveColumns(row: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (isSensitiveKey(key)) continue;
    sanitized[key] = typeof value === "string" && looksLikeJson(value) ? redactJsonString(value) : value;
  }
  return sanitized;
}

function redactNestedSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactNestedSecrets);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !isSensitiveKey(key)).map(([key, entry]) => [key, redactNestedSecrets(entry)]));
  }
  return value;
}

function redactJsonString(value: string): string {
  try {
    return JSON.stringify(redactNestedSecrets(JSON.parse(value) as unknown));
  } catch {
    return value;
  }
}

function isSensitiveKey(key: string): boolean {
  return /(?:identity[_-]?key|token|secret|password|authorization)/iu.test(key);
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function renderMarkdownExport(document: {
  readonly exportedAt: string;
  readonly schemaVersion: number;
  readonly projects: readonly Record<string, unknown>[];
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}): string {
  const lines = [
    "# SSDD MCP project export",
    "",
    `Exported at: ${document.exportedAt}`,
    `Database schema version: ${document.schemaVersion}`,
    "",
    "## Projects",
    "",
  ];
  for (const project of document.projects) {
    lines.push(`### ${String(project.key)} · ${String(project.name)}`, "", String(project.productGoal), "", `Timezone: ${String(project.timezone)}`, "");
  }
  const workItems = document.tables.work_items ?? [];
  if (workItems.length > 0) {
    lines.push("## Work items", "", "| Key | Type | State | Title |", "|---|---|---|---|");
    for (const item of workItems) {
      lines.push(`| ${markdownCell(item.item_key ?? item.key)} | ${markdownCell(item.type)} | ${markdownCell(item.state)} | ${markdownCell(item.title)} |`);
    }
    lines.push("");
  }
  lines.push("## Included records", "");
  for (const [table, rows] of Object.entries(document.tables).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`- ${table}: ${rows.length}`);
  }
  lines.push("", "This export omits credentials, identity keys, tool approvals, idempotency records and migration checksums.", "");
  return lines.join("\n");
}

function renderGherkinExport(database: Sqlite.Database): string {
  const rows = database.prepare(
    `SELECT p.project_key, p.name AS project_name, s.scenario_key, s.kind,
            r.revision_number, r.snapshot_json
     FROM scenarios s
     INNER JOIN projects p ON p.project_id = s.project_id
     INNER JOIN scenario_revisions r ON r.project_id = s.project_id AND r.scenario_id = s.scenario_id
     WHERE r.status = 'published'
     ORDER BY p.project_key COLLATE NOCASE, s.scenario_key COLLATE NOCASE`,
  ).all() as Array<{
    project_key: string;
    project_name: string;
    scenario_key: string;
    kind: string;
    revision_number: number;
    snapshot_json: string;
  }>;
  if (rows.length === 0) return "# No published scenarios found.\n";

  return `${rows.map((row) => {
    const snapshot = JSON.parse(row.snapshot_json) as {
      readonly title: string;
      readonly preconditions: readonly string[];
      readonly steps: readonly { readonly action: string; readonly expected: string }[];
    };
    const lines = [
      `@project_${row.project_key} @scenario_${row.scenario_key} @kind_${row.kind} @revision_${row.revision_number}`,
      `Feature: ${singleGherkinLine(row.project_name)}`,
      "",
      `  # SSDD source: ${row.project_key}/${row.scenario_key}@${row.revision_number}`,
      `  Scenario: ${singleGherkinLine(snapshot.title)}`,
      ...snapshot.preconditions.map((condition) => `    Given ${singleGherkinLine(condition)}`),
      ...snapshot.steps.flatMap((step) => [
        `    When ${singleGherkinLine(step.action)}`,
        `    Then ${singleGherkinLine(step.expected)}`,
      ]),
    ];
    return lines.join("\n");
  }).join("\n\n")}\n`;
}

function singleGherkinLine(value: string): string {
  return value
    .replace(/[\r\n\t\v\f]+/gu, " ")
    .replace(/\p{Cc}/gu, (character) => {
      return `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
    })
    .replace(/\s+/gu, " ")
    .trim();
}

function markdownCell(value: unknown): string {
  return String(value ?? "").replace(/[|\r\n]/gu, " ");
}
