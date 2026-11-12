import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { allowedParentTypes, type WorkItem, type WorkItemType } from "../domain/work-items.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt, type JsonValue } from "./idempotent-command.js";
import type { ProjectRole } from "./local-identity.js";
import { getWorkItem } from "./work-item-queries.js";

export interface CreateWorkItemInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly type: WorkItemType;
  readonly parentId?: string;
  readonly relatedStoryId?: string;
  readonly title: string;
  readonly description?: string;
  readonly priority?: number;
  readonly businessValueScore?: number | null;
  readonly businessValueRationale?: string | null;
  readonly criteria?: readonly {
    readonly description: string;
    readonly required?: boolean | undefined;
  }[];
}

interface CreateWorkItemResult {
  readonly itemId: string;
}

const allowedCreationRoles: Readonly<Record<WorkItemType, readonly ProjectRole[]>> = {
  epic: ["po"],
  feature: ["po", "developer"],
  story: ["po", "developer", "qa"],
  bug: ["qa", "developer"],
  task: ["developer", "qa"],
};

export function createWorkItem(
  database: SqliteDatabase,
  input: CreateWorkItemInput,
): CommandReceipt<WorkItem> {
  const normalized = normalizeInput(input);
  const requestPayload: JsonValue = {
    projectId: input.projectId,
    type: normalized.type,
    parentId: normalized.parentId,
    relatedStoryId: normalized.relatedStoryId,
    title: normalized.title,
    description: normalized.description,
    priority: normalized.priority,
    businessValueScore: normalized.businessValueScore,
    businessValueRationale: normalized.businessValueRationale,
    criteria: normalized.criteria.map((criterion) => ({
      description: criterion.description,
      required: criterion.required,
    })),
  };

  const receipt = executeIdempotentCommand<CreateWorkItemResult>(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "work_item.create",
    requestId: input.requestId,
    payload: requestPayload,
    requiredRoles: allowedCreationRoles[normalized.type],
    auditEvent: (result) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "work_item.created",
      entityType: "work_item",
      entityId: result.itemId,
      payload: {
        type: normalized.type,
        parentId: normalized.parentId,
        title: normalized.title,
      },
    }),
    execute: () => {
      const parent = getRelatedItem(database, input.projectId, normalized.parentId);
      const parentTypes = allowedParentTypes[normalized.type];
      if (
        parentTypes.length === 0
          ? parent !== undefined
          : parent === undefined || !parentTypes.includes(parent.type)
      ) {
        throw new ApplicationError(
          "VALIDATION_FAILED",
          parentTypes.length === 0
            ? "Epic work items cannot have a parent."
            : `A ${normalized.type} must have a parent of type ${parentTypes.join(" or ")}.`,
          { details: { type: normalized.type, allowedParentTypes: parentTypes } },
        );
      }

      if (normalized.relatedStoryId !== null) {
        if (normalized.type !== "bug") {
          throw new ApplicationError(
            "VALIDATION_FAILED",
            "Only a bug may reference a related story.",
          );
        }
        const relatedStory = getRelatedItem(
          database,
          input.projectId,
          normalized.relatedStoryId,
        );
        if (relatedStory === undefined || relatedStory.type !== "story") {
          throw new ApplicationError(
            "VALIDATION_FAILED",
            "The related work item must be a story in the same project.",
          );
        }
      }

      if (
        normalized.criteria.length > 0 &&
        normalized.type !== "story" &&
        normalized.type !== "bug"
      ) {
        throw new ApplicationError(
          "VALIDATION_FAILED",
          "Acceptance criteria can only be added to stories and bugs.",
        );
      }

      const project = database
        .prepare("SELECT project_key FROM projects WHERE project_id = ?")
        .get(input.projectId) as { project_key: string } | undefined;
      if (project === undefined) {
        throw new ApplicationError("NOT_FOUND", "Project was not found.");
      }

      const itemNumber = allocateWorkItemNumber(database, input.projectId);
      const itemId = randomUUID();
      const itemKey = `${project.project_key}-${itemNumber}`;
      const rank = nextWorkItemRank(database, input.projectId, normalized.type, normalized.parentId);
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO work_items
            (item_id, project_id, item_key, type, parent_id, related_story_id, title,
             description, priority, rank, created_by_principal_id, created_at, updated_at,
             business_value_score, business_value_rationale)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          itemId,
          input.projectId,
          itemKey,
          normalized.type,
          normalized.parentId,
          normalized.relatedStoryId,
          normalized.title,
          normalized.description,
          normalized.priority,
          rank,
          input.principalId,
          now,
          now,
          normalized.businessValueScore,
          normalized.businessValueRationale,
        );

      const revisionCriteria = normalized.criteria.map((criterion, index) => ({
        id: randomUUID(),
        key: `AC-${index + 1}`,
        description: criterion.description,
        required: criterion.required,
        position: index + 1,
      }));
      const insertCriterion = database.prepare(
        `INSERT INTO work_item_criteria
          (criterion_id, project_id, item_id, criterion_key, description, is_required, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      revisionCriteria.forEach((criterion) => {
        insertCriterion.run(
          criterion.id,
          input.projectId,
          itemId,
          criterion.key,
          criterion.description,
          criterion.required ? 1 : 0,
          criterion.position,
          now,
        );
      });

      database
        .prepare(
          `INSERT INTO work_item_revisions
            (revision_id, project_id, item_id, revision_number, snapshot_json,
             created_by_principal_id, created_at, status, published_by_principal_id, published_at)
           VALUES (?, ?, ?, 1, ?, ?, ?, 'published', ?, ?)`,
        )
        .run(
          randomUUID(),
          input.projectId,
          itemId,
          JSON.stringify({
            type: normalized.type,
            parentId: normalized.parentId,
            relatedStoryId: normalized.relatedStoryId,
            title: normalized.title,
            description: normalized.description,
            priority: normalized.priority,
            businessValueScore: normalized.businessValueScore,
            businessValueRationale: normalized.businessValueRationale,
            criteria: revisionCriteria,
          }),
          input.principalId,
          now,
          input.principalId,
          now,
        );

      return { itemId };
    },
  });

  return {
    ...receipt,
    value: getWorkItem(database, input.projectId, input.principalId, receipt.value.itemId),
  };
}

interface NormalizedInput {
  readonly type: WorkItemType;
  readonly parentId: string | null;
  readonly relatedStoryId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly priority: number;
  readonly businessValueScore: number | null;
  readonly businessValueRationale: string | null;
  readonly criteria: readonly { description: string; required: boolean }[];
}

function normalizeInput(input: CreateWorkItemInput): NormalizedInput {
  const title = input.title.trim();
  const description = input.description?.trim() || null;
  const priority = input.priority ?? 2;
  const businessValueScore = input.businessValueScore ?? null;
  const businessValueRationale = input.businessValueRationale?.trim() || null;
  const criteria = (input.criteria ?? []).map((criterion) => ({
    description: criterion.description.trim(),
    required: criterion.required ?? true,
  }));

  if (title.length === 0 || title.length > 200) {
    throw new ApplicationError("VALIDATION_FAILED", "Title must contain between 1 and 200 characters.");
  }
  if (description !== null && description.length > 10_000) {
    throw new ApplicationError("VALIDATION_FAILED", "Description cannot exceed 10000 characters.");
  }
  if (!Number.isSafeInteger(priority) || priority < 1 || priority > 4) {
    throw new ApplicationError("VALIDATION_FAILED", "Priority must be an integer between 1 and 4.");
  }
  validateBusinessValue(input.type, businessValueScore, businessValueRationale);
  if (criteria.length > 50) {
    throw new ApplicationError("VALIDATION_FAILED", "At most 50 acceptance criteria can be created at once.");
  }
  const descriptions = new Set<string>();
  for (const criterion of criteria) {
    if (criterion.description.length === 0 || criterion.description.length > 2_000) {
      throw new ApplicationError(
        "VALIDATION_FAILED",
        "Acceptance criteria must contain between 1 and 2000 characters.",
      );
    }
    const normalizedDescription = criterion.description.toLowerCase();
    if (descriptions.has(normalizedDescription)) {
      throw new ApplicationError("VALIDATION_FAILED", "Acceptance criteria must be unique.");
    }
    descriptions.add(normalizedDescription);
  }
  if (input.relatedStoryId !== undefined && input.type !== "bug") {
    throw new ApplicationError("VALIDATION_FAILED", "Only a bug may reference a related story.");
  }

  return {
    type: input.type,
    parentId: input.parentId?.trim() || null,
    relatedStoryId: input.relatedStoryId?.trim() || null,
    title,
    description,
    priority,
    businessValueScore,
    businessValueRationale,
    criteria,
  };
}

function validateBusinessValue(type: WorkItemType, score: number | null, rationale: string | null): void {
  if (score !== null && (!Number.isSafeInteger(score) || score < 0 || score > 100)) {
    throw new ApplicationError("VALIDATION_FAILED", "Business value score must be an integer between 0 and 100.");
  }
  if (type !== "epic" && type !== "feature" && type !== "task" && (score !== null || rationale !== null)) {
    throw new ApplicationError("VALIDATION_FAILED", "Business value may only be set on epics, features and tasks.");
  }
  if ((score === null) !== (rationale === null) || (rationale !== null && (rationale.length === 0 || rationale.length > 1000))) {
    throw new ApplicationError("VALIDATION_FAILED", "A business value score requires a rationale of 1-1000 characters; clearing both fields is allowed.");
  }
}

function getRelatedItem(
  database: SqliteDatabase,
  projectId: string,
  itemId: string | null,
): { id: string; type: WorkItemType } | undefined {
  if (itemId === null) {
    return undefined;
  }
  return database
    .prepare(
      `SELECT item_id AS id, type FROM work_items
       WHERE project_id = ? AND (item_id = ? OR item_key = ? COLLATE NOCASE)`,
    )
    .get(projectId, itemId, itemId) as { id: string; type: WorkItemType } | undefined;
}

function allocateWorkItemNumber(database: SqliteDatabase, projectId: string): number {
  const current = database
    .prepare("SELECT next_work_item_number FROM project_sequences WHERE project_id = ?")
    .get(projectId) as { next_work_item_number: number } | undefined;

  if (current === undefined) {
    database
      .prepare("INSERT INTO project_sequences (project_id, next_work_item_number) VALUES (?, 2)")
      .run(projectId);
    return 1;
  }

  database
    .prepare("UPDATE project_sequences SET next_work_item_number = ? WHERE project_id = ?")
    .run(current.next_work_item_number + 1, projectId);
  return current.next_work_item_number;
}

function nextWorkItemRank(
  database: SqliteDatabase,
  projectId: string,
  type: WorkItemType,
  parentId: string | null,
): number {
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(rank), 0) AS maximum
       FROM work_items WHERE project_id = ? AND type = ? AND parent_id IS ?`,
    )
    .get(projectId, type, parentId) as { maximum: number };
  return row.maximum + 1024;
}

