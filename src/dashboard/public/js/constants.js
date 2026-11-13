
export const states = ["ready", "in_progress", "in_review", "in_validation", "done"];

export const stateLabels = {
  draft: "Rascunho",
  ready: "Ready",
  in_progress: "Em progresso",
  in_review: "Em revisão",
  in_validation: "Em validação",
  done: "Done",
  cancelled: "Cancelado",
  active: "Ativa",
  paused: "Pausada",
  completed: "Concluída",
  closed: "Fechada",
};

export const typeLabels = { epic: "Épico", feature: "Feature", story: "História", bug: "Bug", task: "Tarefa" };

export const typeMarks = { epic: "E", feature: "F", story: "H", bug: "B", task: "T" };

export const metricNumberFormatter = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });

export const metricDateFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeZone: "UTC" });

export const localDateFormatters = new Map();

export const workProfileLabels = {
  admin: "Administração", po: "Product Owner", developer: "Developer", qa: "QA",
  tech_lead: "Tech Lead", facilitator: "Facilitador", stakeholder: "Stakeholder",
};

export const workProfileOrder = ["developer", "qa", "po", "tech_lead", "facilitator", "stakeholder", "admin"];

export const scenarioKindLabels = {
  acceptance: "Aceitação", regression: "Regressão", integration: "Integração",
  performance: "Performance", security: "Segurança", manual: "Manual",
};

export const specificationKindLabels = {
  business_rule: "Regra de negócio", glossary: "Glossário", api_contract: "Contrato de API",
  adr: "Decisão de arquitetura", non_functional: "Requisito não funcional",
};

export const transitions = {
  draft: ["ready", "cancelled"],
  ready: ["in_progress", "cancelled"],
  in_progress: ["in_review", "cancelled"],
  in_review: ["in_validation", "in_progress", "cancelled"],
  in_validation: ["done", "in_progress", "cancelled"],
  done: ["in_progress"],
  cancelled: [],
};
