import { parentPort, workerData } from "node:worker_threads";
import { addTraceLink } from "../../src/application/trace-commands.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

interface TraceWorkerData {
  readonly databasePath: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly sourceId: string;
  readonly targetId: string;
}

const port = parentPort;
if (port === null) {
  throw new Error("Trace concurrency worker requires a parent port.");
}

const data = workerData as TraceWorkerData;
port.postMessage({ type: "ready" });
await new Promise<void>((resolve) => port.once("message", () => resolve()));

const database = openSqliteDatabase(data.databasePath);
try {
  applyMigrations(database);
  addTraceLink(database, {
    projectId: data.projectId,
    principalId: data.principalId,
    requestId: data.requestId,
    sourceIdOrKey: data.sourceId,
    targetIdOrKey: data.targetId,
    type: "depends_on",
  });
  port.postMessage({ type: "result", ok: true });
} catch (error) {
  const applicationError = error as { readonly code?: string };
  port.postMessage({ type: "result", ok: false, code: applicationError.code ?? "UNKNOWN" });
} finally {
  database.close();
}
