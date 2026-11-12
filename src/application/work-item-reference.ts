import type { SqliteDatabase } from "../storage-sqlite/database.js";

/** Resolve a mapped stable roadmap alias before looking up a generated item key. */
export function resolveWorkItemIdentifier(database: SqliteDatabase, projectId: string, itemIdOrKey: string): string {
  const reference = itemIdOrKey.trim();
  if (!/^SSDD-\d{3}$/iu.test(reference)) return reference;
  const mapping = database.prepare(
    "SELECT item_id FROM roadmap_item_ids WHERE project_id = ? AND roadmap_id = ?",
  ).get(projectId, reference.toUpperCase()) as { item_id: string } | undefined;
  return mapping?.item_id ?? reference;
}
