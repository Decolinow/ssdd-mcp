/* global crypto */
import { elements } from "./elements.js";
import { model } from "./model.js";
import { escapeHtml, api, toast } from "./ui.js";
import { loadParentItems, loadProjectData } from "./data.js";
import { renderScenarioManager } from "./views.js";
import { openItem } from "./details.js";

export async function openWorkItemEditor(item = null) {
  try {
    if (model.parentWorkItems.length === 0) model.parentWorkItems = await loadParentItems(model.projectId);
    model.editingItem = item;
    elements.workItemForm.reset();
    elements.workItemFormTitle.textContent = item ? `Editar ${item.key}` : "Novo PBI";
    elements.submitWorkItem.textContent = item ? "Propor revisão" : "Criar PBI";
    elements.workItemType.value = item?.type ?? "story";
    elements.workItemType.disabled = Boolean(item);
    elements.workItemTitle.value = item?.title ?? "";
    elements.workItemDescription.value = item?.description ?? "";
    elements.workItemPriority.value = String(item?.priority ?? 3);
    elements.workItemBusinessValue.value = item?.businessValueScore === null || item === null ? "" : String(item.businessValueScore);
    elements.workItemBusinessRationale.value = item?.businessValueRationale ?? "";
    elements.workItemCriteria.value = item?.criteria.map((criterion) => `${criterion.key}: ${criterion.description}`).join("\n") ?? "";
    updateWorkItemParentOptions(item?.parentId ?? "");
    updateWorkItemValueFields();
    if (elements.itemDialog.open) elements.itemDialog.close();
    elements.workItemDialog.showModal();
    elements.workItemTitle.focus();
  } catch (error) {
    toast(`${error.code ?? "ERRO"}: ${error.message}`, true);
  }
}

export function updateWorkItemParentOptions(selectedParentId = elements.workItemParent.value) {
  const type = elements.workItemType.value;
  const parentTypes = { epic: [], feature: ["epic"], story: ["feature"], bug: ["feature"], task: ["story", "bug"] };
  const labels = { epic: "Nenhum", feature: "Épico pai", story: "Feature pai", bug: "Feature pai", task: "História ou bug pai" };
  const allowed = parentTypes[type] ?? [];
  const options = model.parentWorkItems.filter((candidate) => allowed.includes(candidate.type));
  elements.workItemParentField.hidden = allowed.length === 0;
  elements.workItemParentLabel.textContent = labels[type] ?? "Item pai";
  elements.workItemParent.innerHTML = `<option value="">Selecione ${labels[type]?.toLocaleLowerCase("pt-BR") ?? "o item pai"}</option>${options.map((parent) => `<option value="${escapeHtml(parent.id)}">${escapeHtml(parent.key)} · ${escapeHtml(parent.title)}</option>`).join("")}`;
  elements.workItemParent.value = selectedParentId;
  elements.workItemParent.required = allowed.length > 0 && !model.editingItem;
  elements.workItemParent.disabled = Boolean(model.editingItem);
}

export function updateWorkItemValueFields() {
  const type = elements.workItemType.value;
  const supportsBusinessValue = ["epic", "feature", "task"].includes(type);
  const supportsCriteria = ["story", "bug"].includes(type);
  elements.workItemValueField.hidden = !supportsBusinessValue;
  elements.workItemRationaleField.hidden = !supportsBusinessValue;
  elements.workItemCriteriaField.hidden = !supportsCriteria;
}

export function parseWorkItemCriteria(value, existing = []) {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = /^([A-Z0-9._-]{1,32}):\s*(.+)$/iu.exec(line);
    const criterion = match ? existing.find((entry) => entry.key.toLocaleLowerCase() === match[1].toLocaleLowerCase()) : undefined;
    return {
      ...(criterion ? { id: criterion.id, required: criterion.required, description: match[2].trim() } : { description: match ? match[2].trim() : line, required: true }),
    };
  });
}

export async function submitWorkItemForm(event) {
  event.preventDefault();
  const item = model.editingItem;
  const button = elements.submitWorkItem;
  button.disabled = true;
  try {
    const criteria = parseWorkItemCriteria(elements.workItemCriteria.value, item?.criteria ?? []);
    const shared = {
      requestId: crypto.randomUUID(),
      title: elements.workItemTitle.value.trim(),
      description: elements.workItemDescription.value,
      priority: Number(elements.workItemPriority.value),
      businessValueScore: elements.workItemBusinessValue.value === "" ? null : Number(elements.workItemBusinessValue.value),
      businessValueRationale: elements.workItemBusinessRationale.value.trim() || null,
      criteria: ["story", "bug"].includes(elements.workItemType.value) ? criteria : [],
    };
    if (item) {
      const result = await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/work-items/${encodeURIComponent(item.key)}/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-SSDD-CSRF": model.session.csrfToken },
        body: JSON.stringify({ ...shared, expectedVersion: item.version }),
      });
      elements.workItemDialog.close();
      model.editingItem = null;
      toast(`Revisão r${result.revision.revisionNumber} proposta. Um PO humano pode publicar pelo detalhe do item.`);
      await loadProjectData();
      await openItem(item.id);
    } else {
      const type = elements.workItemType.value;
      const parentId = elements.workItemParent.value;
      const result = await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/work-items`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-SSDD-CSRF": model.session.csrfToken },
        body: JSON.stringify({ ...shared, type, ...(parentId ? { parentId } : {}) }),
      });
      elements.workItemDialog.close();
      toast(`${result.workItem.key} criado como rascunho.`);
      await loadProjectData();
      await openItem(result.workItem.id);
    }
  } catch (error) {
    const details = error.details ? ` ${JSON.stringify(error.details)}` : "";
    toast(`${error.code ?? "ERRO"}: ${error.message}${details}`, true);
    if (["VERSION_CONFLICT", "STALE_CURSOR"].includes(error.code)) await loadProjectData();
  } finally {
    button.disabled = false;
  }
}

export async function openScenarioEditor(scenarioSummary = null) {
  try {
    model.editingScenario = null;
    elements.scenarioForm.reset();
    elements.scenarioFormTitle.textContent = scenarioSummary ? `Revisar ${scenarioSummary.key}` : "Novo cenário";
    elements.submitScenario.textContent = scenarioSummary ? "Propor revisão" : "Criar rascunho";
    elements.scenarioKey.disabled = Boolean(scenarioSummary);
    elements.scenarioKind.disabled = Boolean(scenarioSummary);
    if (scenarioSummary) {
      const scenario = (await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/scenarios/${encodeURIComponent(scenarioSummary.key)}`)).scenario;
      const revision = scenario.revisions.find((entry) => entry.revisionNumber === scenario.publishedRevision);
      if (!revision) throw new Error("Publique a primeira revisão antes de propor outra.");
      const linkedTasks = await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/scenarios/${encodeURIComponent(scenario.key)}/revisions/${revision.revisionNumber}/work-items`);
      model.editingScenario = scenario;
      elements.scenarioKey.value = scenario.key;
      elements.scenarioKind.value = scenario.kind;
      elements.scenarioTitle.value = revision.snapshot.title;
      elements.scenarioPreconditions.value = revision.snapshot.preconditions.join("\n");
      elements.scenarioActions.value = revision.snapshot.steps.map((step) => step.action).join("\n");
      elements.scenarioExpectations.value = revision.snapshot.steps.map((step) => step.expected).join("\n");
      elements.scenarioCoverage.value = revision.snapshot.coverage.map((target) =>
        target.targetType === "specification" ? `specification:${target.targetId}` : target.targetId,
      ).join("\n");
      elements.scenarioTasks.value = linkedTasks.workItems.map((task) => task.key).join("\n");
    }
    elements.scenarioDialog.showModal();
    elements.scenarioTitle.focus();
  } catch (error) {
    toast(`${error.code ?? "ERRO"}: ${error.message}`, true);
  }
}

export function lines(value) {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

export async function submitScenarioForm(event) {
  event.preventDefault();
  const actions = lines(elements.scenarioActions.value);
  const expectations = lines(elements.scenarioExpectations.value);
  if (actions.length === 0 || actions.length !== expectations.length) {
    toast("Informe a mesma quantidade de ações e resultados esperados, na mesma ordem.", true);
    return;
  }
  const button = elements.submitScenario;
  button.disabled = true;
  try {
    const shared = {
      requestId: crypto.randomUUID(),
      title: elements.scenarioTitle.value.trim(),
      preconditions: lines(elements.scenarioPreconditions.value),
      steps: actions.map((action, index) => ({ action, expected: expectations[index] })),
      coverage: lines(elements.scenarioCoverage.value).map((value) => value.startsWith("specification:")
        ? { targetType: "specification", reference: value.slice("specification:".length).trim() }
        : { targetType: "criterion", reference: value }),
      workItemIdOrKeys: lines(elements.scenarioTasks.value),
    };
    if (model.editingScenario) {
      const scenario = model.editingScenario;
      const result = await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/scenarios/${encodeURIComponent(scenario.key)}/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-SSDD-CSRF": model.session.csrfToken },
        body: JSON.stringify({ ...shared, expectedVersion: scenario.version }),
      });
      toast(`Revisão r${result.revision.revisionNumber} proposta para ${scenario.key}.`);
    } else {
      const result = await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/scenarios`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-SSDD-CSRF": model.session.csrfToken },
        body: JSON.stringify({ ...shared, key: elements.scenarioKey.value.trim(), kind: elements.scenarioKind.value }),
      });
      toast(`Rascunho r${result.revision.revisionNumber} criado para ${result.revision.key}.`);
    }
    elements.scenarioDialog.close();
    model.editingScenario = null;
    await loadProjectData();
  } catch (error) {
    const details = error.details ? ` ${JSON.stringify(error.details)}` : "";
    toast(`${error.code ?? "ERRO"}: ${error.message}${details}`, true);
  } finally {
    button.disabled = false;
  }
}

export async function publishScenario(scenarioKey, revisionNumber) {
  try {
    const scenario = (await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/scenarios/${encodeURIComponent(scenarioKey)}`)).scenario;
    await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/scenarios/${encodeURIComponent(scenarioKey)}/revisions/${revisionNumber}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SSDD-CSRF": model.session.csrfToken },
      body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion: scenario.version }),
    });
    toast(`${scenarioKey} r${revisionNumber} publicada.`);
    await loadProjectData();
  } catch (error) {
    const details = error.details ? ` ${JSON.stringify(error.details)}` : "";
    toast(`${error.code ?? "ERRO"}: ${error.message}${details}`, true);
  }
}

export async function submitTestRun(event) {
  event.preventDefault();
  const [scenarioId, revisionText] = elements.testRunScenario.value.split("|");
  const scenario = model.scenarios.find((entry) => entry.id === scenarioId);
  if (!scenario || !revisionText) {
    toast("Selecione um cenário com revisão publicada.", true);
    return;
  }
  const button = elements.submitTestRun;
  button.disabled = true;
  try {
    const result = await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/scenarios/${encodeURIComponent(scenario.key)}/test-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SSDD-CSRF": model.session.csrfToken },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        revisionNumber: Number(revisionText),
        buildId: elements.testRunBuild.value.trim(),
        result: elements.testRunResult.value,
        ...(elements.testRunNotes.value.trim() ? { notes: elements.testRunNotes.value.trim() } : {}),
        ...(elements.testRunEvidence.value.trim() ? { evidenceUri: elements.testRunEvidence.value.trim() } : {}),
        workItemIdOrKeys: lines(elements.testRunTasks.value),
      }),
    });
    elements.testRunForm.reset();
    toast(`Execução ${result.run.result} registrada para ${scenario.key} r${result.run.revisionNumber} · ${result.run.buildId}.`);
    await loadProjectData();
  } catch (error) {
    const details = error.details ? ` ${JSON.stringify(error.details)}` : "";
    toast(`${error.code ?? "ERRO"}: ${error.message}${details}`, true);
  } finally {
    button.disabled = false;
    renderScenarioManager();
  }
}

export async function publishWorkItemRevision(revisionNumber) {
  const item = model.currentItem;
  if (!item) return;
  try {
    await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/work-items/${encodeURIComponent(item.key)}/revisions/${revisionNumber}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SSDD-CSRF": model.session.csrfToken },
      body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion: item.version }),
    });
    toast(`Revisão r${revisionNumber} publicada para ${item.key}.`);
    await loadProjectData();
    await openItem(item.id);
  } catch (error) {
    const details = error.details ? ` ${JSON.stringify(error.details)}` : "";
    toast(`${error.code ?? "ERRO"}: ${error.message}${details}`, true);
  }
}
