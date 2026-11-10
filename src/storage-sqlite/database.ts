import Sqlite from "better-sqlite3";

export type SqliteDatabase = InstanceType<typeof Sqlite>;

export interface SqliteCapabilities {
  readonly sqliteVersion: string;
  readonly journalMode: string;
  readonly foreignKeys: true;
  readonly fts5: true;
  readonly jsonFunctions: true;
}

const busyTimeoutMs = 5_000;

export function openSqliteDatabase(filename: string): SqliteDatabase {
  const database = new Sqlite(filename);

  try {
    database.pragma("foreign_keys = ON");
    database.pragma(`busy_timeout = ${busyTimeoutMs}`);

    const journalMode = String(
      database.pragma("journal_mode = WAL", { simple: true }),
    ).toLowerCase();
    database.pragma("synchronous = NORMAL");

    inspectSqliteCapabilities(database, filename, journalMode);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function inspectSqliteCapabilities(
  database: SqliteDatabase,
  filename: string,
  journalMode: string,
): SqliteCapabilities {
  const versionResult = database
    .prepare("SELECT sqlite_version() AS version")
    .get() as { version: string };

  if (database.pragma("foreign_keys", { simple: true }) !== 1) {
    throw new Error("SQLite must support and enable foreign key enforcement.");
  }

  if (filename !== ":memory:" && journalMode !== "wal") {
    throw new Error(`SQLite must support WAL mode; received '${journalMode}'.`);
  }

  const validJson = database
    .prepare("SELECT json_valid(?) AS valid")
    .pluck()
    .get("{}") as number;
  if (validJson !== 1) {
    throw new Error("SQLite must include JSON validation functions.");
  }

  try {
    database.exec("CREATE VIRTUAL TABLE temp.ssdd_fts5_probe USING fts5(content)");
    database.exec("DROP TABLE temp.ssdd_fts5_probe");
  } catch (cause) {
    throw new Error("SQLite must include FTS5 support.", { cause });
  }

  return {
    sqliteVersion: versionResult.version,
    journalMode,
    foreignKeys: true,
    fts5: true,
    jsonFunctions: true,
  };
}
