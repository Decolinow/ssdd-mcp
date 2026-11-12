import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import type { CommandReceipt } from "./idempotent-command.js";
import { addTraceLink } from "./trace-commands.js";
import { getSpecification } from "./specification-queries.js";
import { getWorkItem } from "./work-item-queries.js";

export interface LinkTaskToAdrInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly taskIdOrKey: string;
  readonly adrIdOrKey: string;
  readonly relationship: "implements" | "relates_to";
}

export function linkTaskToAdr(
  database: SqliteDatabase,
  input: LinkTaskToAdrInput,
): CommandReceipt<{
  readonly link: {
    readonly id: string;
    readonly projectId: string;
    readonly source: { readonly id: string; readonly type: "work_item"; readonly key: string; readonly title: string };
    readonly target: { readonly id: string; readonly type: "specification"; readonly key: string; readonly title: string };
    readonly type: "implements" | "relates_to";
    readonly removedAt: null;
  };
  readonly adrRevision: { readonly latest: number; readonly published: number | null };
}> {
  const task = getWorkItem(database, input.projectId, input.principalId, input.taskIdOrKey.trim());
  if (task.type !== "task") throw new ApplicationError("VALIDATION_FAILED", "An ADR can only be linked to a task by this operation.");
  const adr = getSpecification(database, input.projectId, input.principalId, input.adrIdOrKey.trim());
  if (adr.kind !== "adr") throw new ApplicationError("VALIDATION_FAILED", "The selected specification is not an ADR.");

  const receipt = addTraceLink(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    requestId: input.requestId,
    sourceIdOrKey: task.id,
    targetIdOrKey: adr.id,
    type: input.relationship,
  });
  return {
    value: {
      link: {
        ...receipt.value,
        type: input.relationship,
        source: { ...receipt.value.source, type: "work_item" },
        target: { ...receipt.value.target, type: "specification" },
        removedAt: null,
      },
      adrRevision: { latest: adr.latestRevision, published: adr.publishedRevision },
    },
    auditEventIds: receipt.auditEventIds,
  };
}
