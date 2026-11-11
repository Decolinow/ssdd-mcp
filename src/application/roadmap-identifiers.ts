import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { getWorkItem } from "./work-item-queries.js";

export interface RoadmapItemReference {
  readonly roadmapId: string;
  readonly projectId: string;
  readonly itemId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly boundByPrincipalId: string;
  readonly boundAt: string;
}

export function bindRoadmapItemId(database: SqliteDatabase, input: {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly roadmapId: string;
  readonly itemIdOrKey: string;
}): CommandReceipt<RoadmapItemReference> {
  const roadmapId = normalizeRoadmapId(input.roadmapId);
  const item = getWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey.trim());
  if (item.type !== "task") throw new ApplicationError("VALIDATION_FAILED", "Stable roadmap IDs can only be bound to task work items.");
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "roadmap_id.bind",
    requestId: input.requestId,
    payload: { projectId: input.projectId, roadmapId, itemId: item.id },
    requiredRoles: ["admin", "po"],
    auditEvent: (reference) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "roadmap_id.bound",
      entityType: "roadmap_item_id",
      entityId: reference.itemId,
      payload: { roadmapId, itemId: reference.itemId, itemKey: reference.itemKey },
    }),
    execute: () => {
      const existingId = database.prepare(
        "SELECT project_id, roadmap_id, item_id, bound_by_principal_id, bound_at FROM roadmap_item_ids WHERE project_id = ? AND roadmap_id = ?",
      ).get(input.projectId, roadmapId) as RoadmapIdRow | undefined;
      if (existingId !== undefined && existingId.item_id !== item.id) {
        throw new ApplicationError("CONFLICT", `${roadmapId} is already bound to a different task.`);
      }
      const existingItem = database.prepare(
        "SELECT roadmap_id FROM roadmap_item_ids WHERE project_id = ? AND item_id = ?",
      ).get(input.projectId, item.id) as { roadmap_id: string } | undefined;
      if (existingItem !== undefined && existingItem.roadmap_id !== roadmapId) {
        throw new ApplicationError("CONFLICT", `Task ${item.key} is already bound to ${existingItem.roadmap_id}.`);
      }
      const now = new Date().toISOString();
      if (existingId === undefined) {
        database.prepare(
          `INSERT INTO roadmap_item_ids (project_id, roadmap_id, item_id, bound_by_principal_id, bound_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(input.projectId, roadmapId, item.id, input.principalId, now);
      }
      return {
        roadmapId,
        projectId: input.projectId,
        itemId: item.id,
        itemKey: item.key,
        title: item.title,
        boundByPrincipalId: existingId?.bound_by_principal_id ?? input.principalId,
        boundAt: existingId?.bound_at ?? now,
      };
    },
  });
}

export function resolveRoadmapItemId(database: SqliteDatabase, input: {
  readonly projectId: string;
  readonly principalId: string;
  readonly roadmapId: string;
}): RoadmapItemReference {
  const roadmapId = normalizeRoadmapId(input.roadmapId);
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const row = database.prepare(
    `SELECT map.roadmap_id, map.project_id, map.item_id, wi.item_key, wi.title,
            map.bound_by_principal_id, map.bound_at
     FROM roadmap_item_ids map
     INNER JOIN work_items wi ON wi.project_id = map.project_id AND wi.item_id = map.item_id
     WHERE map.project_id = ? AND map.roadmap_id = ?`,
  ).get(input.projectId, roadmapId) as RoadmapIdRow | undefined;
  if (row === undefined) throw new ApplicationError("NOT_FOUND", `Stable roadmap ID ${roadmapId} is not mapped in this project.`);
  return toReference(row);
}

export function listRoadmapItemIds(database: SqliteDatabase, input: {
  readonly projectId: string;
  readonly principalId: string;
}): RoadmapItemReference[] {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  return (database.prepare(
    `SELECT map.roadmap_id, map.project_id, map.item_id, wi.item_key, wi.title,
            map.bound_by_principal_id, map.bound_at
     FROM roadmap_item_ids map
     INNER JOIN work_items wi ON wi.project_id = map.project_id AND wi.item_id = map.item_id
     WHERE map.project_id = ? ORDER BY map.roadmap_id`,
  ).all(input.projectId) as RoadmapIdRow[]).map(toReference);
}

interface RoadmapIdRow {
  readonly roadmap_id: string;
  readonly project_id: string;
  readonly item_id: string;
  readonly item_key: string;
  readonly title: string;
  readonly bound_by_principal_id: string;
  readonly bound_at: string;
}

function toReference(row: RoadmapIdRow): RoadmapItemReference {
  return {
    roadmapId: row.roadmap_id, projectId: row.project_id, itemId: row.item_id,
    itemKey: row.item_key, title: row.title, boundByPrincipalId: row.bound_by_principal_id, boundAt: row.bound_at,
  };
}

function normalizeRoadmapId(value: string): string {
  const roadmapId = value.trim().toUpperCase();
  if (!/^SSDD-\d{3}$/u.test(roadmapId)) throw new ApplicationError("VALIDATION_FAILED", "Stable roadmap IDs must use the SSDD-### format.");
  return roadmapId;
}
