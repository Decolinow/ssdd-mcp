import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { openBlockingQuestions } from "./work-item-questions.js";
import { getWorkItem } from "./work-item-queries.js";
import { hasPublishedCriterionScenario } from "./work-item-workflow.js";

/**
 * Deterministic readiness review (SSDD-939): rule-based findings, no model involved, so the same input always
 * yields the same list. It reports; it never blocks a transition by itself (only blocking open questions do).
 */
export type ReadinessFindingCode =
  | "no_observable_outcome"
  | "vague_term"
  | "term_not_in_glossary"
  | "criterion_without_scenario"
  | "task_without_checklist"
  | "blocking_question_open";

export interface ReadinessFinding {
  readonly code: ReadinessFindingCode;
  readonly severity: "blocking" | "warning";
  readonly criterionKey?: string;
  readonly message: string;
}

const vagueTerms = [
  "rápido", "rapido", "rapidamente", "adequado", "adequada", "adequadamente", "amigável", "amigavel", "fácil", "facil",
  "simples", "intuitivo", "robusto", "eficiente", "melhor", "bom", "boa", "etc", "e assim por diante", "conforme necessário",
  "quickly", "fast", "easy", "user-friendly", "appropriate", "appropriately", "efficient", "robust", "as needed", "and so on",
] as const;

const outcomePattern = /\b(deve|devem|retorna|retornam|exibe|exibem|mostra|mostram|bloqueia|bloqueiam|permite|permitem|gera|geram|cria|criam|registra|registram|envia|enviam|recusa|rejeita|notifica|is|are|should|must|returns|shows|blocks|allows|creates|records|sends|rejects)\b|é |são /iu;

export function reviewWorkItemReadiness(database: SqliteDatabase, input: {
  readonly projectId: string; readonly principalId: string; readonly itemIdOrKey: string;
}): { itemKey: string; type: string; findings: ReadinessFinding[]; counts: { blocking: number; warning: number } } {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const item = getWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey.trim());
  const findings: ReadinessFinding[] = [];

  const glossary = (database.prepare(
    "SELECT spec_key, title FROM specifications WHERE project_id = ? AND kind = 'glossary'",
  ).all(input.projectId) as Array<{ spec_key: string; title: string }>)
    .flatMap((row) => [row.spec_key.toLowerCase(), row.title.toLowerCase()]);

  for (const criterion of item.criteria) {
    const text = criterion.description;
    const lowered = text.toLowerCase();
    if (criterion.then === undefined && !outcomePattern.test(text)) {
      findings.push({ code: "no_observable_outcome", severity: "warning", criterionKey: criterion.key, message: "O critério não declara um resultado observável; preencha `then` ou reescreva com o comportamento esperado." });
    }
    for (const term of vagueTerms) {
      const pattern = new RegExp(`(^|[^\\p{L}])${term.replaceAll(" ", "\\s+")}([^\\p{L}]|$)`, "iu");
      if (pattern.test(lowered)) {
        findings.push({ code: "vague_term", severity: "warning", criterionKey: criterion.key, message: `Termo vago "${term}": troque por um limite ou resultado mensurável.` });
      }
    }
    for (const match of text.matchAll(/"([^"]{2,60})"|`([^`]{2,60})`/gu)) {
      const term = (match[1] ?? match[2] ?? "").trim().toLowerCase();
      if (term.length > 0 && !glossary.some((entry) => entry === term || entry.includes(term))) {
        findings.push({ code: "term_not_in_glossary", severity: "warning", criterionKey: criterion.key, message: `O termo "${term}" não consta no glossário do projeto.` });
      }
    }
    if ((item.type === "story" || item.type === "bug") && criterion.required && !hasPublishedCriterionScenario(database, input.projectId, criterion.id)) {
      findings.push({ code: "criterion_without_scenario", severity: "warning", criterionKey: criterion.key, message: "Critério obrigatório sem cenário publicado." });
    }
  }
  if (item.type === "task" && item.criteria.length === 0) {
    findings.push({ code: "task_without_checklist", severity: "warning", message: "A tarefa não tem checklist de saída (critérios próprios)." });
  }
  for (const question of openBlockingQuestions(database, input.projectId, item.id)) {
    findings.push({ code: "blocking_question_open", severity: "blocking", message: `Pergunta bloqueante ${question.key} sem resposta: ${question.text}` });
  }
  const blocking = findings.filter((finding) => finding.severity === "blocking").length;
  return { itemKey: item.key, type: item.type, findings, counts: { blocking, warning: findings.length - blocking } };
}
