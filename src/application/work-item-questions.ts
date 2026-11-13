import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { getWorkItem } from "./work-item-queries.js";

/**
 * Open questions on a work item (SSDD-939). A question marked `blocking` keeps the item out of Ready until it is
 * answered, and the open ones are surfaced in the task context, so doubts stop being lost in comments.
 */
export interface WorkItemQuestion {
  readonly id: string;
  readonly key: string;
  readonly itemKey: string;
  readonly text: string;
  readonly blocking: boolean;
  readonly status: "open" | "answered";
  readonly answer: string | null;
  readonly askedByPrincipalId: string;
  readonly askedAt: string;
  readonly answeredByPrincipalId: string | null;
  readonly answeredAt: string | null;
  readonly version: number;
}

interface QuestionRow {
  readonly question_id: string; readonly question_key: string; readonly item_key: string; readonly text: string;
  readonly blocking: number; readonly status: "open" | "answered"; readonly answer: string | null;
  readonly asked_by_principal_id: string; readonly asked_at: string; readonly answered_by_principal_id: string | null;
  readonly answered_at: string | null; readonly version: number;
}

const selectQuestions = `
  SELECT q.question_id, q.question_key, wi.item_key, q.text, q.blocking, q.status, q.answer, q.asked_by_principal_id,
         q.asked_at, q.answered_by_principal_id, q.answered_at, q.version
  FROM work_item_questions q
  INNER JOIN work_items wi ON wi.project_id = q.project_id AND wi.item_id = q.item_id
  WHERE q.project_id = ?`;

function toQuestion(row: QuestionRow): WorkItemQuestion {
  return {
    id: row.question_id, key: row.question_key, itemKey: row.item_key, text: row.text, blocking: row.blocking === 1,
    status: row.status, answer: row.answer, askedByPrincipalId: row.asked_by_principal_id, askedAt: row.asked_at,
    answeredByPrincipalId: row.answered_by_principal_id, answeredAt: row.answered_at, version: row.version,
  };
}

export function openQuestion(database: SqliteDatabase, input: {
  readonly projectId: string; readonly principalId: string; readonly requestId: string;
  readonly itemIdOrKey: string; readonly text: string; readonly blocking?: boolean;
}): CommandReceipt<{ question: WorkItemQuestion }> {
  const text = input.text.trim();
  if (text.length === 0 || text.length > 2_000) {
    throw new ApplicationError("VALIDATION_FAILED", "A question must contain 1-2000 characters.");
  }
  const blocking = input.blocking === true;
  return executeIdempotentCommand(database, {
    projectId: input.projectId, principalId: input.principalId, action: "question.open", requestId: input.requestId,
    payload: { projectId: input.projectId, itemIdOrKey: input.itemIdOrKey, text, blocking },
    requiredRoles: ["developer", "po", "qa", "tech_lead", "facilitator"],
    auditEvent: (result) => ({
      projectId: input.projectId, principalId: input.principalId, eventType: "question.opened", entityType: "work_item_question",
      entityId: result.question.id, payload: { key: result.question.key, itemKey: result.question.itemKey, blocking },
    }),
    execute: () => {
      const item = getWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey.trim());
      if (item.state === "done" || item.state === "cancelled") {
        throw new ApplicationError("INVALID_TRANSITION", "Questions cannot be opened on a done or cancelled item.");
      }
      const maximum = (database.prepare(
        "SELECT COALESCE(MAX(CAST(SUBSTR(question_key, 3) AS INTEGER)), 0) AS maximum FROM work_item_questions WHERE project_id = ?",
      ).get(input.projectId) as { maximum: number }).maximum;
      const id = randomUUID();
      database.prepare(
        `INSERT INTO work_item_questions (question_id, project_id, item_id, question_key, text, blocking, asked_by_principal_id, asked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.projectId, item.id, `Q-${maximum + 1}`, text, blocking ? 1 : 0, input.principalId, new Date().toISOString());
      return { question: readQuestion(database, input.projectId, id) };
    },
  });
}

export function answerQuestion(database: SqliteDatabase, input: {
  readonly projectId: string; readonly principalId: string; readonly requestId: string;
  readonly questionIdOrKey: string; readonly answer: string; readonly expectedVersion?: number;
}): CommandReceipt<{ question: WorkItemQuestion }> {
  const answer = input.answer.trim();
  if (answer.length === 0 || answer.length > 4_000) {
    throw new ApplicationError("VALIDATION_FAILED", "An answer must contain 1-4000 characters.");
  }
  return executeIdempotentCommand(database, {
    projectId: input.projectId, principalId: input.principalId, action: "question.answer", requestId: input.requestId,
    payload: { projectId: input.projectId, questionIdOrKey: input.questionIdOrKey, answer, expectedVersion: input.expectedVersion ?? null },
    requiredRoles: ["po", "tech_lead", "stakeholder"],
    auditEvent: (result) => ({
      projectId: input.projectId, principalId: input.principalId, eventType: "question.answered", entityType: "work_item_question",
      entityId: result.question.id, payload: { key: result.question.key, itemKey: result.question.itemKey },
    }),
    execute: () => {
      const row = findQuestion(database, input.projectId, input.questionIdOrKey.trim());
      if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
        throw new ApplicationError("VERSION_CONFLICT", `Question is at version ${row.version}, expected ${input.expectedVersion}.`);
      }
      if (row.status === "answered") {
        throw new ApplicationError("INVALID_TRANSITION", "The question is already answered.");
      }
      database.prepare(
        `UPDATE work_item_questions SET status = 'answered', answer = ?, answered_by_principal_id = ?, answered_at = ?, version = version + 1
         WHERE project_id = ? AND question_id = ?`,
      ).run(answer, input.principalId, new Date().toISOString(), input.projectId, row.question_id);
      return { question: readQuestion(database, input.projectId, row.question_id) };
    },
  });
}

export function listQuestions(database: SqliteDatabase, input: {
  readonly projectId: string; readonly principalId: string; readonly itemIdOrKey?: string;
  readonly status?: "open" | "answered"; readonly limit?: number;
}): { questions: WorkItemQuestion[] } {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new ApplicationError("VALIDATION_FAILED", "Question limit must be between 1 and 200.");
  }
  const itemId = input.itemIdOrKey === undefined ? undefined : getWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey.trim()).id;
  const rows = database.prepare(`${selectQuestions} ORDER BY q.asked_at, q.question_key`).all(input.projectId) as unknown as QuestionRow[];
  const questions = rows
    .filter((row) => input.status === undefined || row.status === input.status)
    .filter((row) => itemId === undefined || (database.prepare("SELECT 1 FROM work_item_questions WHERE question_id = ? AND item_id = ?").get(row.question_id, itemId) !== undefined))
    .slice(0, limit)
    .map(toQuestion);
  return { questions };
}

/** Open blocking questions on an item, used by the Ready gate and the task context. */
export function openBlockingQuestions(database: SqliteDatabase, projectId: string, itemId: string): Array<{ key: string; text: string }> {
  return database.prepare(
    `SELECT question_key AS key, text FROM work_item_questions
     WHERE project_id = ? AND item_id = ? AND status = 'open' AND blocking = 1 ORDER BY question_key`,
  ).all(projectId, itemId) as Array<{ key: string; text: string }>;
}

function findQuestion(database: SqliteDatabase, projectId: string, reference: string): QuestionRow {
  const row = database.prepare(`${selectQuestions} AND (q.question_id = ? OR q.question_key = ? COLLATE NOCASE)`)
    .get(projectId, reference, reference) as QuestionRow | undefined;
  if (row === undefined) throw new ApplicationError("NOT_FOUND", "Question was not found.");
  return row;
}

function readQuestion(database: SqliteDatabase, projectId: string, questionId: string): WorkItemQuestion {
  return toQuestion(findQuestion(database, projectId, questionId));
}
