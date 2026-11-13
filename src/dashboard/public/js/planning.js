/* global crypto */
// Planning operations (SSDD-99): teams, capacity, DoD, milestones and sprint lifecycle through
// POST /api/v1/projects/:id/planning/:operation. Each operation reuses the MCP command, so
// versions, gates and authorization are enforced by the application layer, never by this form.
import { elements } from "./elements.js";
import { model } from "./model.js";
import { api, toast } from "./ui.js";
import { loadProjectData } from "./data.js";

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

export function renderPlanningOperationOptions() {
  elements.planningOperation.innerHTML = Object.entries(planningOperations).map(([key, value]) => `<option value="${key}">${value.label}</option>`).join("");
  applyPlanningTemplate();
}

export function applyPlanningTemplate() {
  const operation = planningOperations[elements.planningOperation.value];
  elements.planningHint.textContent = operation.hint;
  elements.planningPayload.value = JSON.stringify(operation.template, null, 2);
}

export function openPlanningDialog() {
  if (elements.planningOperation.options.length === 0) renderPlanningOperationOptions();
  elements.planningDialog.showModal();
}

export async function submitPlanning(event) {
  event.preventDefault();
  elements.submitPlanning.disabled = true;
  try {
    let payload;
    try { payload = JSON.parse(elements.planningPayload.value); } catch { throw Object.assign(new Error("O payload precisa ser um objeto JSON válido."), { code: "VALIDATION_FAILED" }); }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw Object.assign(new Error("O payload precisa ser um objeto JSON."), { code: "VALIDATION_FAILED" });
    for (const key of Object.keys(payload)) if (payload[key] === "" || (Array.isArray(payload[key]) && payload[key].length === 0 && key.startsWith("remove"))) delete payload[key];
    const operation = elements.planningOperation.value;
    const result = await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/planning/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SSDD-CSRF": model.session.csrfToken },
      body: JSON.stringify({ requestId: crypto.randomUUID(), ...payload }),
    });
    toast(`${planningOperations[operation].label}: concluído (${result.auditEventIds?.length ?? 0} evento(s) de auditoria).`);
    elements.planningDialog.close();
    await loadProjectData();
  } catch (error) {
    const details = error.details ? ` ${JSON.stringify(error.details)}` : "";
    toast(`${error.code ?? "ERRO"}: ${error.message}${details}`, true);
  } finally {
    elements.submitPlanning.disabled = false;
  }
}
