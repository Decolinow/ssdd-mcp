/* global crypto */
// Planning operations (SSDD-99): teams, capacity, DoD, milestones and sprint lifecycle through
// POST /api/v1/projects/:id/planning/:operation. Each operation reuses the MCP command, so
// versions, gates and authorization are enforced by the application layer, never by this form.
import { elements } from "./elements.js";
import { model } from "./model.js";
import { api, toast } from "./ui.js";
import { loadProjectData } from "./data.js";
import { openItem } from "./details.js";

const capacityTemplate = {
  teamName: "", timezone: "America/Sao_Paulo", hoursPerDay: 6, workingDays: [1, 2, 3, 4, 5],
  members: [{ principalId: "", dedicationPercent: 100 }], reason: "",
};

export const planningOperations = {
  team_create: { label: "Criar time", hint: "Cria um time com capacidade inicial.", template: capacityTemplate },
  team_capacity_set: { label: "Nova versão de capacidade", hint: "expectedVersion deve ser a versão atual da capacidade do time.", template: { ...capacityTemplate, expectedVersion: 1, teamId: "" } },
  definition_of_done_set: { label: "Definition of Done", hint: "expectedVersion 0 cria a primeira revisão.", template: { expectedVersion: 0, criteria: [{ description: "" }], reason: "" } },
  milestone_create: { label: "Criar marco", hint: "Itens por chave ou UUID.", template: { milestoneKey: "", title: "", goal: "", targetDate: "", itemIdsOrKeys: [], reason: "" } },
  milestone_scope_change: { label: "Alterar escopo do marco", hint: "Informe a versão atual do marco.", template: { milestoneIdOrKey: "", expectedVersion: 1, addItemIdsOrKeys: [], removeItemIdsOrKeys: [], reason: "" } },
  sprint_draft: { label: "Planejar sprint", hint: "Apenas PBIs Ready; capacidade e DoD são fixadas.", template: { sprintKey: "", title: "", goal: "", startsOn: "", endsOn: "", itemIdsOrKeys: [], reason: "" } },
  sprint_scope_change: { label: "Alterar escopo da sprint", hint: "Informe a versão atual da sprint.", template: { sprintIdOrKey: "", expectedVersion: 1, addItemIdsOrKeys: [], removeItemIdsOrKeys: [], reason: "" } },
  sprint_start: { label: "Iniciar sprint", hint: "Gate humano: confirma o escopo planejado.", template: { sprintIdOrKey: "", expectedVersion: 1, reason: "" } },
  sprint_close: { label: "Encerrar sprint", hint: "acceptedItemIds são UUIDs dos itens aceitos na revisão.", template: { sprintIdOrKey: "", expectedVersion: 1, acceptedItemIds: [], reviewSummary: "", reason: "" } },
  sprint_cancel: { label: "Cancelar sprint", hint: "Exige motivo; o histórico é preservado.", template: { sprintIdOrKey: "", expectedVersion: 1, reason: "" } },
};

const itemOps = {
  work_item_assign: { label: "Atribuir item", hint: "assigneeId é o UUID do responsável (null remove).", template: (item) => ({ itemIdOrKey: item.key, assigneeId: null, expectedVersion: item.version }) },
  work_item_rank: { label: "Reordenar item", hint: "Informe exatamente um de beforeIdOrKey/afterIdOrKey (irmão).", template: (item) => ({ itemIdOrKey: item.key, afterIdOrKey: "", expectedVersion: item.version }) },
  comment_add: { label: "Comentar item", hint: "Comentário imutável no histórico do item.", template: (item) => ({ itemIdOrKey: item.key, body: "" }) },
  work_item_estimate: { label: "Propor estimativa", hint: "points para PBI, hours para tarefa; a confirmação é uma operação separada.", template: (item) => ({ itemIdOrKey: item.key, unit: item.type === "task" ? "hours" : "points", value: 1, rationale: "", expectedVersion: item.version }) },
  work_item_estimate_confirm: { label: "Confirmar estimativa", hint: "proposalId vem da proposta registrada.", template: (item) => ({ itemIdOrKey: item.key, proposalId: "", expectedVersion: item.version }) },
  baseline_revalidate: { label: "Revalidar baseline", hint: "PO ou Tech Lead: cria nova baseline com as revisões publicadas e resolve os impactos abertos; o motivo é obrigatório.", template: (item) => ({ itemIdOrKey: item.key, expectedVersion: item.version, reason: "" }) },
  baseline_fix: { label: "Fixar baseline", hint: "Só PO. Normalmente a baseline é fixada ao mover o PBI para Ready.", template: (item) => ({ itemIdOrKey: item.key, expectedVersion: item.version, reason: "" }) },
  test_run_certify: { label: "Certificar execução QA", hint: "Só QA humano, PBI em validação, execução aprovada da revisão exata da baseline; o gate do MCP explica a recusa.", template: (item, extra) => ({ itemIdOrKey: item.key, runId: extra?.runId ?? "", expectedVersion: item.version, reason: "" }) },
  trace_link_add: { label: "Criar vínculo", hint: "type: depends_on, relates_to ou implements.", template: (item) => ({ sourceIdOrKey: item.key, targetIdOrKey: "", type: "relates_to" }) },
  trace_link_remove: { label: "Remover vínculo", hint: "linkId do vínculo ativo (consulte o rastro do item).", template: () => ({ linkId: "" }) },
};
let backlogItem = null;
let backlogExtra = null;

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

export function applyPlanningTemplate() {
  const key = elements.planningOperation.value;
  const operation = backlogItem !== null && key in itemOps ? itemOps[key] : planningOperations[key];
  elements.planningHint.textContent = operation.hint;
  elements.planningPayload.value = JSON.stringify(typeof operation.template === "function" ? operation.template(backlogItem, backlogExtra) : operation.template, null, 2);
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
    try { payload = JSON.parse(elements.planningPayload.value); } catch { throw Object.assign(new Error("O payload precisa ser um objeto JSON válido."), { code: "VALIDATION_FAILED" }); }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw Object.assign(new Error("O payload precisa ser um objeto JSON."), { code: "VALIDATION_FAILED" });
    if ("reason" in payload && (typeof payload.reason !== "string" || payload.reason.trim() === "")) throw Object.assign(new Error("Preencha o campo \"reason\" (motivo) no JSON antes de executar."), { code: "VALIDATION_FAILED" });
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
