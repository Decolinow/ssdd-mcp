/* global crypto */
// Planning operations (SSDD-99): teams, capacity, DoD, milestones and sprint lifecycle through
// POST /api/v1/projects/:id/planning/:operation. Each operation reuses the MCP command, so
// versions, gates and authorization are enforced by the application layer, never by this form.
// The dialog renders a guided form per operation; the raw JSON stays available under "Modo avançado".
import { elements } from "./elements.js";
import { model } from "./model.js";
import { api, toast, escapeHtml } from "./ui.js";
import { loadProjectData } from "./data.js";
import { openItem } from "./details.js";

const weekdayLabels = [[0, "Dom"], [1, "Seg"], [2, "Ter"], [3, "Qua"], [4, "Qui"], [5, "Sex"], [6, "Sáb"]];

// Field kinds: text, textarea, number, date, select, lines (one value per line -> string[]),
// weekdays (checkboxes -> number[]), criteria (one per line -> [{description}]), members ("uuid;percent" per line).
const f = (name, label, kind = "text", options = {}) => ({ name, label, kind, ...options });
const reason = (help = "Fica registrado na auditoria.") => f("reason", "Motivo", "textarea", { required: true, help, rows: 2 });
const version = (help) => f("expectedVersion", "Versão atual", "number", { required: true, min: 0, help: help ?? "Versão exibida no item; protege contra edição concorrente." });
const capacityFields = [
  f("timezone", "Fuso horário", "text", { required: true, value: "America/Sao_Paulo", help: "Nome IANA, ex.: America/Sao_Paulo." }),
  f("hoursPerDay", "Horas produtivas por dia", "number", { required: true, value: 6, min: 1, max: 24, step: "0.5" }),
  f("workingDays", "Dias úteis", "weekdays", { value: [1, 2, 3, 4, 5] }),
  f("members", "Membros", "members", { required: true, rows: 3, help: "Uma pessoa por linha: UUID do principal;percentual de dedicação (ex.: 3f2a…;100)." }),
];

export const planningOperations = {
  team_create: { label: "Criar time", hint: "Cria um time com calendário e capacidade inicial.", fields: [f("teamName", "Nome do time", "text", { required: true }), ...capacityFields, reason()] },
  team_capacity_set: { label: "Nova versão de capacidade", hint: "Publica uma nova capacidade para o time; a versão atual evita sobrescrever mudança concorrente.", fields: [f("teamId", "Time (UUID)", "text", { required: true, help: "Use team_list ou o seletor de time do cabeçalho." }), version("Versão atual da capacidade do time."), f("teamName", "Nome do time", "text", { required: true }), ...capacityFields, reason()] },
  definition_of_done_set: { label: "Definition of Done", hint: "Versão 0 cria a primeira revisão.", fields: [{ ...version("Use 0 na primeira revisão."), value: 0 }, f("criteria", "Critérios", "criteria", { required: true, rows: 5, help: "Um critério por linha." }), reason()] },
  milestone_create: { label: "Criar marco", hint: "Marco com meta, data-alvo e escopo inicial.", fields: [f("milestoneKey", "Chave", "text", { required: true, help: "Ex.: M1." }), f("title", "Título", "text", { required: true }), f("goal", "Meta", "textarea", { required: true, rows: 2 }), f("targetDate", "Data-alvo", "date", { required: true }), f("itemIdsOrKeys", "Itens do escopo", "lines", { rows: 3, help: "Uma chave ou UUID por linha." }), reason()] },
  milestone_scope_change: { label: "Alterar escopo do marco", hint: "Adiciona ou remove itens do marco.", fields: [f("milestoneIdOrKey", "Marco", "text", { required: true, help: "Chave ou UUID." }), version("Versão atual do marco."), f("addItemIdsOrKeys", "Adicionar itens", "lines", { rows: 3, help: "Uma chave por linha." }), f("removeItemIdsOrKeys", "Remover itens", "lines", { rows: 3 }), reason()] },
  sprint_draft: { label: "Planejar sprint", hint: "Apenas PBIs Ready; capacidade e DoD são fixadas no planejamento.", fields: [f("sprintKey", "Chave", "text", { required: true, help: "Ex.: SPRINT-12." }), f("title", "Título", "text", { required: true }), f("goal", "Meta da sprint", "textarea", { required: true, rows: 2 }), f("startsOn", "Início", "date", { required: true }), f("endsOn", "Fim", "date", { required: true }), f("itemIdsOrKeys", "PBIs da sprint", "lines", { rows: 4, help: "Uma chave por linha; só itens Ready." }), reason()] },
  sprint_scope_change: { label: "Alterar escopo da sprint", hint: "Adiciona ou remove PBIs de uma sprint planejada ou ativa.", fields: [f("sprintIdOrKey", "Sprint", "text", { required: true, help: "Chave ou UUID." }), version("Versão atual da sprint."), f("addItemIdsOrKeys", "Adicionar PBIs", "lines", { rows: 3 }), f("removeItemIdsOrKeys", "Remover PBIs", "lines", { rows: 3 }), reason()] },
  sprint_start: { label: "Iniciar sprint", hint: "Gate humano: confirma o escopo planejado.", fields: [f("sprintIdOrKey", "Sprint", "text", { required: true }), version("Versão atual da sprint."), reason()] },
  sprint_close: { label: "Encerrar sprint", hint: "Informe os itens aceitos na revisão; os demais voltam ao backlog como incompletos.", fields: [f("sprintIdOrKey", "Sprint", "text", { required: true }), version("Versão atual da sprint."), f("acceptedItemIds", "Itens aceitos (UUID)", "lines", { rows: 4, help: "Um UUID por linha." }), f("reviewSummary", "Resumo da revisão", "textarea", { required: true, rows: 3 }), reason()] },
  sprint_cancel: { label: "Cancelar sprint", hint: "Exige motivo; o histórico é preservado.", fields: [f("sprintIdOrKey", "Sprint", "text", { required: true }), version("Versão atual da sprint."), reason()] },
};

const itemRef = (item) => f("itemIdOrKey", "Item", "text", { required: true, value: item.key, readOnly: true });
const itemOps = {
  work_item_assign: { label: "Atribuir item", hint: "Deixe o responsável vazio para remover a atribuição.", fields: (item) => [itemRef(item), f("assigneeId", "Responsável (UUID)", "text", { nullEmpty: true, help: "UUID do principal; vazio remove." }), { ...version(), value: item.version }] },
  work_item_rank: { label: "Reordenar item", hint: "Informe exatamente um dos dois irmãos de referência.", fields: (item) => [itemRef(item), f("beforeIdOrKey", "Antes de (chave)", "text"), f("afterIdOrKey", "Depois de (chave)", "text"), { ...version(), value: item.version }] },
  comment_add: { label: "Comentar item", hint: "Comentário imutável no histórico do item.", fields: (item) => [itemRef(item), f("body", "Comentário", "textarea", { required: true, rows: 4 })] },
  work_item_estimate: { label: "Propor estimativa", hint: "Pontos para PBI, horas para tarefa; a confirmação é uma operação separada.", fields: (item) => [itemRef(item), f("unit", "Unidade", "select", { required: true, value: item.type === "task" ? "hours" : "points", options: [["points", "Pontos"], ["hours", "Horas"]] }), f("value", "Valor", "number", { required: true, value: 1, min: 0, step: "0.5" }), f("rationale", "Justificativa", "textarea", { required: true, rows: 2 }), { ...version(), value: item.version }] },
  work_item_estimate_confirm: { label: "Confirmar estimativa", hint: "O identificador da proposta vem da estimativa registrada.", fields: (item) => [itemRef(item), f("proposalId", "Proposta (UUID)", "text", { required: true }), { ...version(), value: item.version }] },
  baseline_revalidate: { label: "Revalidar baseline", hint: "PO ou Tech Lead: cria nova baseline com as revisões publicadas e resolve os impactos abertos.", fields: (item) => [itemRef(item), { ...version(), value: item.version }, reason("Obrigatório: explica por que a baseline continua válida.")] },
  baseline_fix: { label: "Fixar baseline", hint: "Só PO. Normalmente a baseline é fixada ao mover o PBI para Ready.", fields: (item) => [itemRef(item), { ...version(), value: item.version }, reason()] },
  test_run_certify: { label: "Certificar execução QA", hint: "Só QA humano, PBI em validação, execução aprovada da revisão exata da baseline; o gate do MCP explica a recusa.", fields: (item, extra) => [itemRef(item), f("runId", "Execução (UUID)", "text", { required: true, value: extra?.runId ?? "" }), { ...version(), value: item.version }, reason()] },
  trace_link_add: { label: "Criar vínculo", hint: "depends_on bloqueia o início; relates_to é informativo; implements exige o alvo publicado.", fields: (item) => [f("sourceIdOrKey", "Origem", "text", { required: true, value: item.key, readOnly: true }), f("targetIdOrKey", "Destino (chave ou UUID)", "text", { required: true }), f("type", "Tipo de vínculo", "select", { required: true, value: "relates_to", options: [["relates_to", "relates_to · relacionado"], ["depends_on", "depends_on · depende de"], ["implements", "implements · implementa"]] })] },
  trace_link_remove: { label: "Remover vínculo", hint: "Informe o vínculo ativo (consulte o rastro do item).", fields: () => [f("linkId", "Vínculo (UUID)", "text", { required: true })] },
};
let backlogItem = null;
let backlogExtra = null;

function activeOperation() {
  const key = elements.planningOperation.value;
  return backlogItem !== null && key in itemOps ? itemOps[key] : planningOperations[key];
}

function renderField(field) {
  const id = `pf-${field.name}`;
  const common = `id="${id}" name="${escapeHtml(field.name)}" data-kind="${field.kind}"${field.readOnly ? " readonly" : ""}${field.required ? ' aria-required="true"' : ""}`;
  const help = field.help ? `<small id="${id}-help">${escapeHtml(field.help)}</small>` : "";
  const describedBy = field.help ? ` aria-describedby="${id}-help"` : "";
  const value = field.value ?? "";
  let control;
  if (field.kind === "textarea" || field.kind === "lines" || field.kind === "criteria" || field.kind === "members") {
    control = `<textarea ${common}${describedBy} rows="${field.rows ?? 3}" spellcheck="false">${escapeHtml(String(value))}</textarea>`;
  } else if (field.kind === "select") {
    control = `<select ${common}${describedBy}>${field.options.map(([optionValue, text]) => `<option value="${escapeHtml(optionValue)}"${optionValue === value ? " selected" : ""}>${escapeHtml(text)}</option>`).join("")}</select>`;
  } else if (field.kind === "weekdays") {
    return `<fieldset class="form-field planning-weekdays" data-field="${field.name}" data-kind="weekdays"><legend>${escapeHtml(field.label)}</legend>${weekdayLabels.map(([day, text]) => `<label><input type="checkbox" value="${day}"${(field.value ?? []).includes(day) ? " checked" : ""}> ${text}</label>`).join("")}</fieldset>`;
  } else {
    const type = field.kind === "number" ? "number" : field.kind === "date" ? "date" : "text";
    const attributes = ["min", "max", "step"].filter((key) => field[key] !== undefined).map((key) => ` ${key}="${escapeHtml(String(field[key]))}"`).join("");
    control = `<input ${common}${describedBy} type="${type}"${attributes} value="${escapeHtml(String(value))}" autocomplete="off">`;
  }
  return `<div class="form-field"><label for="${id}">${escapeHtml(field.label)}${field.required ? ' <span class="required-mark" aria-hidden="true">*</span>' : ""}</label>${control}${help}</div>`;
}

function collectFields(fields) {
  const payload = {};
  for (const field of fields) {
    if (field.kind === "weekdays") {
      payload[field.name] = [...elements.planningFields.querySelectorAll(`[data-field="${field.name}"] input:checked`)].map((input) => Number(input.value));
      continue;
    }
    const control = elements.planningFields.querySelector(`#pf-${field.name}`);
    const raw = control.value.trim();
    const lines = () => control.value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (field.required && raw === "" && field.kind !== "lines") {
      throw Object.assign(new Error(`Preencha o campo "${field.label}"${field.name === "reason" ? " (reason)" : ""}.`), { code: "VALIDATION_FAILED" });
    }
    if (field.kind === "lines") payload[field.name] = lines();
    else if (field.kind === "criteria") payload[field.name] = lines().map((description) => ({ description }));
    else if (field.kind === "members") payload[field.name] = lines().map((line) => { const [principalId, percent = "100"] = line.split(/[;,\s]+/u); return { principalId, dedicationPercent: Number(percent) }; });
    else if (field.kind === "number") { if (raw !== "") payload[field.name] = Number(raw); }
    else if (raw !== "") payload[field.name] = raw;
    else if (field.nullEmpty) payload[field.name] = null;
  }
  return payload;
}

export function openBacklogOperations(item, operation, extra) {
  backlogItem = item;
  backlogExtra = extra ?? null;
  elements.planningOperation.innerHTML = Object.entries(itemOps).map(([key, value]) => `<option value="${key}">${value.label}</option>`).join("");
  elements.planningTitle.textContent = `Operações de ${item.key}`;
  if (operation !== undefined) elements.planningOperation.value = operation;
  applyPlanningTemplate();
  elements.planningDialog.showModal();
}

export function renderPlanningOperationOptions() {
  elements.planningOperation.innerHTML = Object.entries(planningOperations).map(([key, value]) => `<option value="${key}">${value.label}</option>`).join("");
  applyPlanningTemplate();
}

function currentFields() {
  const operation = activeOperation();
  return typeof operation.fields === "function" ? operation.fields(backlogItem, backlogExtra) : operation.fields;
}

export function applyPlanningTemplate() {
  const operation = activeOperation();
  const fields = currentFields();
  elements.planningHint.textContent = operation.hint;
  elements.planningFields.innerHTML = fields.map(renderField).join("");
  elements.planningAdvanced.open = false;
  syncAdvancedPayload();
}

/** Keeps the advanced JSON in step with the guided form (best effort: invalid or incomplete fields are skipped). */
export function syncAdvancedPayload() {
  const payload = {};
  for (const field of currentFields()) {
    try { Object.assign(payload, collectFields([{ ...field, required: false }])); } catch { /* keep going */ }
  }
  elements.planningPayload.value = JSON.stringify(payload, null, 2);
}

export function openPlanningDialog() {
  backlogItem = null;
  elements.planningTitle.textContent = "Operação de planejamento";
  renderPlanningOperationOptions();
  elements.planningDialog.showModal();
}

export async function submitPlanning(event) {
  event.preventDefault();
  elements.submitPlanning.disabled = true;
  try {
    let payload;
    if (elements.planningAdvanced.open) {
      try { payload = JSON.parse(elements.planningPayload.value); } catch { throw Object.assign(new Error("O payload precisa ser um objeto JSON válido."), { code: "VALIDATION_FAILED" }); }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw Object.assign(new Error("O payload precisa ser um objeto JSON."), { code: "VALIDATION_FAILED" });
      if ("reason" in payload && (typeof payload.reason !== "string" || payload.reason.trim() === "")) throw Object.assign(new Error("Preencha o campo \"reason\" (motivo) no JSON antes de executar."), { code: "VALIDATION_FAILED" });
    } else {
      payload = collectFields(currentFields());
    }
    for (const key of Object.keys(payload)) if (payload[key] === "" || (Array.isArray(payload[key]) && payload[key].length === 0 && key.startsWith("remove"))) delete payload[key];
    const operation = elements.planningOperation.value;
    const isBacklog = backlogItem !== null && operation in itemOps;
    const label = isBacklog ? itemOps[operation].label : planningOperations[operation].label;
    const result = await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/${isBacklog ? "backlog" : "planning"}/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SSDD-CSRF": model.session.csrfToken },
      body: JSON.stringify({ requestId: crypto.randomUUID(), ...payload }),
    });
    toast(`${label}: concluído (${result.auditEventIds?.length ?? 0} evento(s) de auditoria).`);
    elements.planningDialog.close();
    await loadProjectData();
    if (isBacklog && model.currentItem) await openItem(model.currentItem.id);
  } catch (error) {
    const details = error.details ? ` ${JSON.stringify(error.details)}` : "";
    toast(`${error.code ?? "ERRO"}: ${error.message}${details}`, true);
  } finally {
    elements.submitPlanning.disabled = false;
  }
}
