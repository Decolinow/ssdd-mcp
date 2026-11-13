import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { getTaskContext, type TaskContextInput, type TaskContextResult } from "./task-context.js";
import { getCurrentTaskWorkflowProgress, hasUnpublishedTaskWorkflow } from "./task-workflow-queries.js";
import { listQuestions } from "./work-item-questions.js";
import { getWorkItem } from "./work-item-queries.js";
import { getTaskStartReadiness } from "./work-item-workflow.js";

/**
 * One-call task briefing (SSDD-945): context + start gates + workflow progress + open questions + cited glossary terms
 * + a deterministic recommended next action. It reuses the context budget/cursor, so it never exceeds `maxChars`
 * for the context part and replaces the usual 4-5 reads an agent made before starting.
 */
export interface TaskBriefing {
  readonly context: TaskContextResult;
  readonly startReadiness: { readonly canStart: boolean; readonly blockers: ReadonlyArray<{ readonly code: string; readonly message: string }>; readonly warnings: ReadonlyArray<{ readonly code: string; readonly message: string }> };
  readonly workflow: { readonly published: boolean; readonly unpublishedDraft: boolean; readonly progressPercent: number | null; readonly completedSteps: number; readonly totalSteps: number };
  readonly openQuestions: ReadonlyArray<{ readonly key: string; readonly itemKey: string; readonly text: string; readonly blocking: boolean }>;
  readonly glossaryTerms: ReadonlyArray<{ readonly key: string; readonly title: string }>;
  readonly nextAction: string;
}

export function getTaskBriefing(database: SqliteDatabase, input: TaskContextInput): TaskBriefing {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const context = getTaskContext(database, input);
  const task = getWorkItem(database, input.projectId, input.principalId, context.task.id);
  const readiness = getTaskStartReadiness(database, { projectId: input.projectId, principalId: input.principalId, itemIdOrKey: task.id });
  const progress = getCurrentTaskWorkflowProgress(database, input.projectId, task.id);

  const itemKeys = [task.key, ...(task.parentId === null ? [] : [getWorkItem(database, input.projectId, input.principalId, task.parentId).key])];
  const openQuestions = itemKeys
    .flatMap((itemIdOrKey) => listQuestions(database, { projectId: input.projectId, principalId: input.principalId, itemIdOrKey, status: "open" }).questions)
    .map((question) => ({ key: question.key, itemKey: question.itemKey, text: question.text, blocking: question.blocking }));

  const haystack = `${task.description ?? ""}\n${JSON.stringify(context.sections.acceptanceCriteria)}`.toLowerCase();
  const glossaryTerms = (database.prepare("SELECT spec_key, title FROM specifications WHERE project_id = ? AND kind = 'glossary' ORDER BY spec_key COLLATE NOCASE")
    .all(input.projectId) as Array<{ spec_key: string; title: string }>)
    .filter((row) => haystack.includes(row.title.toLowerCase()) || haystack.includes(row.spec_key.toLowerCase()))
    .map((row) => ({ key: row.spec_key, title: row.title }));

  const blockingQuestion = openQuestions.find((question) => question.blocking);
  let nextAction: string;
  if (blockingQuestion !== undefined) {
    nextAction = `Obter resposta da pergunta bloqueante ${blockingQuestion.key} (question_answer) antes de seguir.`;
  } else if (task.state === "draft" || task.state === "ready") {
    nextAction = readiness.canStart
      ? "Chamar task_start e abrir a implementação."
      : `Resolver o bloqueio de início: ${readiness.blockers[0]?.message ?? "revise task_start_check"}`;
  } else if (task.state === "in_progress") {
    nextAction = progress !== null && !progress.allStepsDone
      ? "Continuar as etapas do workflow; ao terminar, enviar task_delivery_report_submit e mover para in_review."
      : "Enviar task_delivery_report_submit e mover para in_review.";
  } else if (task.state === "in_review") {
    nextAction = "Pedir review_record a quem não trabalhou na tarefa; depois mover para in_validation.";
  } else if (task.state === "in_validation") {
    nextAction = "Validar com a build candidata e concluir (work_item_transition → done).";
  } else {
    nextAction = "Nenhuma ação pendente.";
  }

  return {
    context,
    startReadiness: {
      canStart: readiness.canStart,
      blockers: readiness.blockers.map(({ code, message }) => ({ code, message })),
      warnings: readiness.warnings.map(({ code, message }) => ({ code, message })),
    },
    workflow: {
      published: progress !== null, unpublishedDraft: hasUnpublishedTaskWorkflow(database, input.projectId, task.id),
      progressPercent: progress?.progressPercent ?? null, completedSteps: progress?.completedSteps ?? 0, totalSteps: progress?.totalSteps ?? 0,
    },
    openQuestions, glossaryTerms, nextAction,
  };
}
