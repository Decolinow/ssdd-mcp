import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";

describe("SQLite foundation", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ssdd-mcp-test-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("enables foreign keys, WAL and FTS5 on a file-backed database", () => {
    const database = openSqliteDatabase(join(directory, "project.sqlite"));

    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
    const version = database
      .prepare("SELECT sqlite_version() AS version")
      .get() as { version: string };
    assert.match(version.version, /^\d+\.\d+\.\d+$/);

    database.exec(
      "CREATE VIRTUAL TABLE search_probe USING fts5(content); INSERT INTO search_probe VALUES ('specification search');",
    );
    assert.equal(
      database.prepare("SELECT content FROM search_probe WHERE search_probe MATCH 'specification'").pluck().get(),
      "specification search",
    );

    database.close();
  });

  it("persists committed data after closing and reopening", () => {
    const filename = join(directory, "persistent.sqlite");
    const firstConnection = openSqliteDatabase(filename);
    firstConnection.exec("CREATE TABLE projects (project_key TEXT PRIMARY KEY)");
    firstConnection.prepare("INSERT INTO projects (project_key) VALUES (?)").run("PAY");
    firstConnection.close();

    const secondConnection = openSqliteDatabase(filename);
    const project = secondConnection
      .prepare("SELECT project_key FROM projects")
      .get() as { project_key: string };

    assert.equal(project.project_key, "PAY");
    secondConnection.close();
  });

  it("enforces foreign key constraints", () => {
    const database = openSqliteDatabase(join(directory, "constraints.sqlite"));
    database.exec(
      "CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE work_items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id));",
    );

    assert.throws(() => {
      database.prepare("INSERT INTO work_items (id, project_id) VALUES (?, ?)").run("PAY-1", "missing");
    }, /FOREIGN KEY constraint failed/);

    database.close();
  });
});
