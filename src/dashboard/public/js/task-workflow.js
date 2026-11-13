/* global crypto, document, window */
import { elements } from "./elements.js";
import { model } from "./model.js";
import { escapeHtml, api, toast } from "./ui.js";
import { loadProjectData } from "./data.js";
import { formatDate } from "./views.js";
import { openItem } from "./details.js";

export function renderTaskWorkflow(item, workflowView) {
  const current = workflowView.workflow;
  const draft = workflowView.draft;
  const selected = workflowView.selectedRevision;
  const revisionOptions = workflowView.revisionHistory.map((revision) =>
    `<option value="${revision.revisionNumber}" ${revision.revisionNumber === workflowView.selectedRevisionNumber ? "selected" : ""}>r${revision.revisionNumber} · ${escapeHtml(revision.status)}</option>`).join("");
  const history = workflowView.revisionHistory.length
    ? `<label class="workflow-history-label" for="task-workflow-history">Histórico de revisões<select id="task-workflow-history">${revisionOptions}</select></label>${workflowView.revisionHistoryTruncated ? "<small>Mostrando as 50 revisões mais recentes.</small>" : ""}`
    : "";
  const draftBanner = draft
    ? `<div class="workflow-draft-banner"><strong>Proposta r${draft.revisionNumber} aguardando publicação humana.</strong><span>${escapeHtml(draft.steps.length)} etapas · esforço total de 100,00%</span></div>`
    : "";
  const canUpdate = current !== null && item.state === "in_progress"
    && item.assigneeId === model.session?.principal.id
    && model.currentTaskSessions.some((session) => session.status === "active"
      && session.developerPrincipalId === model.session?.principal.id
      && session.taskWorkflowRevisionNumber === current.revisionNumber);
  const isCurrentPublished = selected !== null && current !== null && selected.revisionNumber === current.revisionNumber;
  const progress = selected?.progressPercent;
  const steps = selected?.steps ?? [];
  const stepRows = steps.map((step) => {
    const controls = isCurrentPublished && canUpdate
      ? step.status === "pending"
        ? `<div class="workflow-step-actions"><button class="button button-secondary" type="button" data-workflow-status="in_progress" data-workflow-step="${escapeHtml(step.id)}">Iniciar etapa</button><button class="button button-secondary" type="button" data-workflow-status="done" data-workflow-step="${escapeHtml(step.id)}">Concluir</button></div>`
        : step.status === "in_progress"
          ? `<div class="workflow-step-actions"><button class="button button-secondary" type="button" data-workflow-status="pending" data-workflow-step="${escapeHtml(step.id)}">Voltar para pendente</button><button class="button button-secondary" type="button" data-workflow-status="done" data-workflow-step="${escapeHtml(step.id)}">Concluir etapa</button></div>`
          : `<small class="workflow-step-complete">Etapa concluída</small>`
      : `<small class="workflow-step-state">${escapeHtml(step.status === "in_progress" ? "Em andamento" : step.status === "done" ? "Concluída" : "Pendente")}</small>`;
    const auditNote = step.statusChangedAt ? `<small>Atualizada em ${escapeHtml(formatDate(step.statusChangedAt))}${step.statusReason ? ` · ${escapeHtml(step.statusReason)}` : ""}</small>` : "";
    return `<li class="workflow-step"><div class="workflow-step-main"><div class="workflow-step-title"><strong>${escapeHtml(step.position)}. ${escapeHtml(step.title)}</strong><span>${escapeHtml(Number(step.effortPercent).toFixed(2))}% do esforço</span></div><p>${escapeHtml(step.description)}</p>${auditNote}</div><div class="workflow-step-status">${controls}</div></li>`;
  }).join("");
  const empty = selected === null
    ? "<p>Nenhum workflow foi definido. O andamento fica sem percentual até publicar uma decomposição.</p>"
    : selected.status === "draft" || selected.status === "withdrawn"
      ? `<p>r${selected.revisionNumber} · ${escapeHtml(selected.status)} · ${escapeHtml(selected.reason)}</p>`
      : "";
  const meter = progress === null || progress === undefined ? "" : `<div class="workflow-progress"><div><strong>${escapeHtml(Number(progress).toFixed(2))}%</strong><span>${selected.steps.filter((step) => step.status === "done").length}/${selected.steps.length} etapas concluídas · revisão r${selected.revisionNumber}</span></div><progress max="100" value="${escapeHtml(progress)}" aria-label="${escapeHtml(item.key)}: ${escapeHtml(Number(progress).toFixed(2))}% do esforço concluído"></progress></div>`;
  const editorLabel = draft ? "Editar proposta" : current ? "Propor revisão" : "Definir etapas";
  return `<section id="task-workflow-section" class="detail-section task-workflow-section"><div class="detail-section-heading"><div><h3>Workflow da tarefa</h3><p>Progresso ponderado pelo esforço das etapas concluídas. Não substitui QA nem aceite.</p></div><button class="button button-secondary" type="button" data-edit-task-workflow>${editorLabel}</button></div>${draftBanner}${history}${empty}${meter}${stepRows ? `<ol class="workflow-step-list">${stepRows}</ol>` : ""}${selected?.status === "superseded" ? "<small>Revisão histórica somente para consulta.</small>" : ""}</section>`;
}

export function workflowEditorRow(step = {}, position = 1) {
  const effort = step.effortPercent === undefined ? "" : Number(step.effortPercent).toFixed(2);
  return `<fieldset class="workflow-step-editor"><legend>Etapa ${position}</legend><input type="hidden" data-workflow-step-id value="${escapeHtml(step.id ?? "")}"><div class="workflow-editor-order"><button class="button button-secondary" type="button" data-workflow-up aria-label="Mover etapa ${position} para cima" ${position === 1 ? "disabled" : ""}>↑</button><button class="button button-secondary" type="button" data-workflow-down aria-label="Mover etapa ${position} para baixo">↓</button><button class="button button-secondary" type="button" data-workflow-remove>Remover</button></div><label>Título<input data-workflow-title maxlength="160" required value="${escapeHtml(step.title ?? "")}"></label><label>Instruções e resultado esperado<textarea data-workflow-description rows="3" maxlength="4000" required>${escapeHtml(step.description ?? "")}</textarea></label><label>Esforço (%)<input data-workflow-effort type="number" min="0.01" max="100" step="0.01" required value="${escapeHtml(effort)}"></label></fieldset>`;
}

export function updateWorkflowEditorOrder() {
  const rows = [...elements.taskWorkflowStepList.querySelectorAll(".workflow-step-editor")];
  rows.forEach((row, index) => {
    row.querySelector("legend").textContent = `Etapa ${index + 1}`;
    row.querySelector("[data-workflow-up]").disabled = index === 0;
    row.querySelector("[data-workflow-down]").disabled = index === rows.length - 1;
    row.querySelector("[data-workflow-up]").setAttribute("aria-label", `Mover etapa ${index + 1} para cima`);
    row.querySelector("[data-workflow-down]").setAttribute("aria-label", `Mover etapa ${index + 1} para baixo`);
  });
}

export function updateWorkflowEditorState() {
  const rows = [...elements.taskWorkflowStepList.querySelectorAll(".workflow-step-editor")];
  const basisPoints = rows.map((row) => {
    const value = Number(row.querySelector("[data-workflow-effort]").value);
    return Number.isFinite(value) ? Math.round(value * 100) : 0;
  });
  const totalBasisPoints = basisPoints.reduce((sum, value) => sum + value, 0);
  const total = totalBasisPoints / 100;
  const valuesValid = rows.length >= 1 && rows.length <= 50 && rows.every((row, index) => {
    const effortInput = row.querySelector("[data-workflow-effort]");
    const effort = Number(effortInput.value);
    return row.querySelector("[data-workflow-title]").value.trim().length > 0
      && row.querySelector("[data-workflow-description]").value.trim().length > 0
      && Number.isFinite(effort) && effort > 0 && effort <= 100
      && Math.abs(effort * 100 - basisPoints[index]) <= 1e-7;
  });
  elements.taskWorkflowTotal.textContent = `${total.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  const valid = valuesValid && totalBasisPoints === 10_000;
  elements.taskWorkflowValidation.textContent = rows.length > 50 ? "O limite é 50 etapas." : valid ? "Soma válida. O percentual será calculado pelas etapas concluídas." : "Preencha as etapas e ajuste os pesos até 100,00%.";
  elements.taskWorkflowValidation.classList.toggle("is-valid", valid);
  elements.submitTaskWorkflow.disabled = !valid;
  elements.publishTaskWorkflow.disabled = !model.currentTaskWorkflow?.draft || model.workflowEditorDirty || !elements.taskWorkflowReason.value.trim();
  return valid;
}

export function openTaskWorkflowEditor() {
  if (!model.currentItem || model.currentItem.type !== "task" || !model.currentTaskWorkflow) return;
  const view = model.currentTaskWorkflow;
  const source = view.draft ?? view.workflow;
  const steps = source?.steps ?? [{ title: "", description: "", effortPercent: 100 }];
  model.workflowEditorDirty = false;
  elements.taskWorkflowForm.reset();
  elements.taskWorkflowFormTitle.textContent = view.draft ? `Revisar Draft r${view.draft.revisionNumber}` : view.workflow ? `Workflow r${view.workflow.revisionNumber}` : "Definir etapas da tarefa";
  elements.taskWorkflowFormHelp.textContent = view.draft
    ? "Salvar cria uma nova revisão imutável e retira o Draft anterior do fluxo ativo. O histórico será preservado."
    : "Descreva cada etapa em ordem, com resultado verificável. Os pesos devem somar exatamente 100,00%.";
  elements.submitTaskWorkflow.textContent = view.draft ? "Criar nova proposta" : view.workflow ? "Propor revisão" : "Salvar como Draft";
  elements.publishTaskWorkflow.hidden = !view.draft;
  elements.publishTaskWorkflow.textContent = view.draft ? `Publicar revisão r${view.draft.revisionNumber}` : "Publicar revisão";
  elements.taskWorkflowReason.value = "";
  elements.taskWorkflowStepList.innerHTML = steps.map((step, index) => workflowEditorRow(step, index + 1)).join("");
  updateWorkflowEditorOrder();
  updateWorkflowEditorState();
  elements.taskWorkflowDialog.showModal();
}

export async function submitTaskWorkflowForm(event) {
  event.preventDefault();
  if (!model.currentItem || !model.currentTaskWorkflow || !updateWorkflowEditorState()) return;
  const item = model.currentItem;
  const steps = [...elements.taskWorkflowStepList.querySelectorAll(".workflow-step-editor")].map((row) => ({
    ...(row.querySelector("[data-workflow-step-id]").value ? { id: row.querySelector("[data-workflow-step-id]").value } : {}),
    title: row.querySelector("[data-workflow-title]").value.trim(),
    description: row.querySelector("[data-workflow-description]").value.trim(),
    effortPercent: Number(row.querySelector("[data-workflow-effort]").value),
  }));
  elements.submitTaskWorkflow.disabled = true;
  try {
    const result = await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/work-items/${encodeURIComponent(item.id)}/task-workflow/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SSDD-CSRF": model.session.csrfToken },
      body: JSON.stringify({
        requestId: crypto.randomUUID(), expectedTaskVersion: item.version,
        expectedWorkflowVersion: model.currentTaskWorkflow.latestRevisionNumber,
        steps, reason: elements.taskWorkflowReason.value.trim(),
      }),
    });
    elements.taskWorkflowDialog.close();
    toast(`Workflow Draft r${result.workflow.revisionNumber} criado. Solicite publicação por um Tech Lead humano.`);
    await loadProjectData();
    await openItem(item.id);
  } catch (error) {
    const details = error.details ? ` ${JSON.stringify(error.details)}` : "";
    toast(`${error.code ?? "ERRO"}: ${error.message}${details}`, true);
    if (["VERSION_CONFLICT", "STALE_CURSOR"].includes(error.code)) await loadProjectData();
  } finally {
    updateWorkflowEditorState();
  }
}

export async function publishTaskWorkflowDraft() {
  const item = model.currentItem;
  const draft = model.currentTaskWorkflow?.draft;
  const reason = elements.taskWorkflowReason.value.trim();
  if (!item || !draft) return;
  if (!reason) {
    elements.taskWorkflowValidation.textContent = "Informe o motivo antes de publicar.";
    elements.taskWorkflowReason.focus();
    return;
  }
  if (model.workflowEditorDirty) {
    elements.taskWorkflowValidation.textContent = "Salve a nova proposta antes de publicar; a revisão mostrada ainda é o Draft atual.";
    return;
  }
  if (!window.confirm(`Publicar a revisão r${draft.revisionNumber} do workflow? Tech Lead humano e ausência de sessões abertas são obrigatórios.`)) return;
  elements.publishTaskWorkflow.disabled = true;
  try {
    await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/work-items/${encodeURIComponent(item.id)}/task-workflow/revisions/${draft.revisionNumber}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SSDD-CSRF": model.session.csrfToken },
      body: JSON.stringify({ requestId: crypto.randomUUID(), expectedTaskVersion: item.version, reason }),
    });
    elements.taskWorkflowDialog.close();
    toast(`Workflow r${draft.revisionNumber} publicado com sucesso.`);
    await loadProjectData();
    await openItem(item.id);
  } catch (error) {
    const details = error.details ? ` ${JSON.stringify(error.details)}` : "";
    toast(`${error.code ?? "ERRO"}: ${error.message}${details}`, true);
    if (["VERSION_CONFLICT", "STALE_CURSOR"].includes(error.code)) await loadProjectData();
  } finally {
    updateWorkflowEditorState();
  }
}

export async function changeTaskWorkflowStep(button) {
  const item = model.currentItem;
  const workflow = model.currentTaskWorkflow;
  if (!item || !workflow?.workflow) return;
  const targetStatus = button.getAttribute("data-workflow-status");
  const stepId = button.getAttribute("data-workflow-step");
  const reason = targetStatus === "done" ? "Etapa concluída pelo Developer no dashboard."
    : targetStatus === "pending" ? "Etapa reaberta para correção pelo Tech Lead no dashboard."
      : "Etapa iniciada pelo Developer no dashboard.";
  button.disabled = true;
  try {
    const result = await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/work-items/${encodeURIComponent(item.id)}/task-workflow/steps/${encodeURIComponent(stepId)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SSDD-CSRF": model.session.csrfToken },
      body: JSON.stringify({ requestId: crypto.randomUUID(), revisionNumber: workflow.workflow.revisionNumber, expectedTaskVersion: item.version, targetStatus, reason }),
    });
    toast(`Etapa atualizada. Progresso concluído: ${Number(result.transition.progressPercent).toFixed(2)}%.`);
    await loadProjectData();
    await openItem(item.id);
  } catch (error) {
    const details = error.details ? ` ${JSON.stringify(error.details)}` : "";
    toast(`${error.code ?? "ERRO"}: ${error.message}${details}`, true);
    if (["VERSION_CONFLICT", "STALE_CURSOR"].includes(error.code)) await loadProjectData();
  }
}

export async function loadTaskWorkflowRevision(revisionNumber) {
  if (!model.currentItem) return;
  try {
    const base = `/api/v1/projects/${encodeURIComponent(model.projectId)}/work-items/${encodeURIComponent(model.currentItem.id)}/task-workflow`;
    const result = await api(`${base}?revisionNumber=${encodeURIComponent(revisionNumber)}`);
    model.currentTaskWorkflow = result.workflow;
    const section = document.querySelector("#task-workflow-section");
    if (section) section.outerHTML = renderTaskWorkflow(model.currentItem, result.workflow);
  } catch (error) {
    toast(`${error.code ?? "ERRO"}: ${error.message}`, true);
  }
}
