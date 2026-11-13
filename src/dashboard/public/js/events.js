/* global document, window, Element */
import { transitions } from "./constants.js";
import { elements } from "./elements.js";
import { model } from "./model.js";
import { toast } from "./ui.js";
import { loadSpecifications, loadProjectData, loadDashboardMetrics, loadProjectRoadmap, applyDeveloperMetricFilters } from "./data.js";
import { claimQuickAccessTask, scheduleRefresh, submitLogin, logout } from "./session.js";
import { syncWorkProfileOptions, storeWorkProfile, renderQuickAccess, render } from "./quick-access.js";
import { projectLocalDate, isHistoryDateSelectable, historyDateBoundsMessage, loadProjectHistory } from "./history.js";
import { renderSpecifications, renderSpecificationDetail, openSpecification, runSpecificationAction, openSpecificationForm, submitSpecificationForm } from "./specifications.js";
import { renderMetrics } from "./metrics.js";
import { renderScenarioManager } from "./views.js";
import { loadSelectedRetrospective, loadMoreTaskContext, loadMoreEvidence, loadMoreActivity, applyActivityFilters, openItem } from "./details.js";
import { workflowEditorRow, updateWorkflowEditorOrder, updateWorkflowEditorState, openTaskWorkflowEditor, submitTaskWorkflowForm, publishTaskWorkflowDraft, changeTaskWorkflowStep, loadTaskWorkflowRevision } from "./task-workflow.js";
import { openWorkItemEditor, updateWorkItemParentOptions, updateWorkItemValueFields, submitWorkItemForm, openScenarioEditor, submitScenarioForm, publishScenario, submitTestRun, publishWorkItemRevision } from "./editors.js";
import { openTransition, updateTransitionStartHint, updateBuildField, submitTransition, setView } from "./transitions.js";

elements.loginForm.addEventListener("submit", (event) => { void submitLogin(event); });

const qaFilterFields = [
  [elements.qaFilterBuild, "build"], [elements.qaFilterScenario, "scenario"], [elements.qaFilterItem, "item"],
  [elements.qaFilterFrom, "from"], [elements.qaFilterTo, "to"],
];
for (const [field, name] of qaFilterFields) {
  field.addEventListener("input", () => { model.qaFilters[name] = field.value; renderScenarioManager(); });
}
document.querySelector("#qa-filter-form").addEventListener("submit", (event) => event.preventDefault());
elements.qaRunChart.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const resultButton = target?.closest("[data-qa-result]");
  if (resultButton) {
    const result = resultButton.getAttribute("data-qa-result");
    model.qaFilters.result = model.qaFilters.result === result ? "" : result;
    renderScenarioManager();
    elements.qaRunChart.querySelector(`[data-qa-result="${result}"]`)?.focus();
    return;
  }
  if (target?.closest("[data-qa-clear]")) {
    model.qaFilters = { build: "", scenario: "", item: "", from: "", to: "", result: "" };
    for (const [field] of qaFilterFields) field.value = "";
    renderScenarioManager();
  }
});
document.addEventListener("visibilitychange", () => {
  scheduleRefresh();
  if (!document.hidden && model.session !== null) void loadProjectData();
});
elements.logout.addEventListener("click", () => { void logout(); });
elements.projectSelect.addEventListener("change", () => {
  model.projectId = elements.projectSelect.value;
  model.project = null;
  model.quickAccess = null;
  model.workProfile = null;
  model.teams = [];
  model.selectedTeamId = null;
  model.items = [];
  model.sprint = null;
  model.dashboardMetrics = null;
  model.projectRoadmap = null;
  model.historySnapshot = null;
  model.historyDate = null;
  model.historyCursor = null;
  model.specifications = [];
  model.specificationKind = "";
  model.specificationSearch = "";
  model.currentSpecification = null;
  model.selectedSpecificationRevisionNumber = null;
  elements.specificationKind.value = "";
  elements.specificationSearch.value = "";
  model.selectedMetricsMilestoneId = null;
  model.selectedMetricsSprintId = null;
  model.selectedMetricsDate = null;
  model.metricsFiltersInitialized = false;
  model.developerMetricsFrom = null;
  model.developerMetricsTo = null;
  model.developerMetricsRangeCustomized = false;
  model.selectedMetricsDeveloperId = null;
  elements.loading.hidden = false;
  syncWorkProfileOptions();
  void loadProjectData();
});
elements.homeProfile.addEventListener("change", () => {
  model.workProfile = elements.homeProfile.value;
  storeWorkProfile(`ssdd-dashboard-work-profile:${model.projectId}`, model.workProfile);
  renderQuickAccess();
});
elements.teamSelect.addEventListener("change", () => {
  model.selectedTeamId = elements.teamSelect.value || null;
  model.sprint = null;
  model.closedSprints = [];
  model.selectedRetrospectiveSprintId = null;
  model.retrospective = null;
  model.dashboardMetrics = null;
  model.projectRoadmap = null;
  model.selectedMetricsSprintId = null;
  model.metricsFiltersInitialized = false;
  void loadProjectData();
});
elements.refresh.addEventListener("click", () => {
  void loadProjectData();
  if (document.querySelector('[role="tab"][aria-selected="true"]')?.id === "metrics-tab") void loadDashboardMetrics();
});
elements.retry.addEventListener("click", () => { void loadProjectData(); });
elements.search.addEventListener("input", render);
elements.typeFilter.addEventListener("change", render);
elements.homeTab.addEventListener("click", () => setView("home"));
elements.metricsTab.addEventListener("click", () => setView("metrics"));
elements.roadmapTab.addEventListener("click", () => setView("roadmap"));
elements.roadmapDate.addEventListener("change", () => { void loadProjectRoadmap(); });
elements.historyTab.addEventListener("click", () => setView("history"));
elements.specificationsTab.addEventListener("click", () => setView("specifications"));
elements.specificationKind.addEventListener("change", () => {
  model.specificationKind = elements.specificationKind.value;
  void loadSpecifications();
});
elements.specificationSearch.addEventListener("input", () => {
  model.specificationSearch = elements.specificationSearch.value;
  if (model.specificationSearchTimer !== null) window.clearTimeout(model.specificationSearchTimer);
  model.specificationSearchTimer = window.setTimeout(() => {
    model.specificationSearchTimer = null;
    void loadSpecifications();
  }, 300);
});
elements.applySpecificationFilter.addEventListener("click", () => {
  model.specificationKind = elements.specificationKind.value;
  model.specificationSearch = elements.specificationSearch.value;
  void loadSpecifications();
});
elements.backlogTab.addEventListener("click", () => setView("backlog"));
elements.boardTab.addEventListener("click", () => setView("board"));
elements.qualityTab.addEventListener("click", () => setView("quality"));
elements.activityTab.addEventListener("click", () => setView("activity"));
elements.retrospectiveTab.addEventListener("click", () => setView("retrospective"));
const tabs = [elements.homeTab, elements.metricsTab, elements.roadmapTab, elements.historyTab, elements.specificationsTab, elements.backlogTab, elements.boardTab, elements.qualityTab, elements.activityTab, elements.retrospectiveTab];
const tabViews = ["home", "metrics", "roadmap", "history", "specifications", "backlog", "board", "quality", "activity", "retrospective"];
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(index + offset + tabs.length) % tabs.length];
    next.focus();
    setView(tabViews[(index + offset + tabs.length) % tabs.length]);
  });
}
elements.metricsMilestone.addEventListener("change", () => {
  model.selectedMetricsMilestoneId = elements.metricsMilestone.value;
  void loadDashboardMetrics();
});
elements.metricsSprint.addEventListener("change", () => {
  model.selectedMetricsSprintId = elements.metricsSprint.value;
  void loadDashboardMetrics();
});
elements.metricsDate.addEventListener("change", () => {
  model.selectedMetricsDate = elements.metricsDate.value || null;
  void loadDashboardMetrics();
});
elements.metricsToday.addEventListener("click", () => {
  model.selectedMetricsDate = null;
  elements.metricsDate.value = "";
  void loadDashboardMetrics();
});
elements.metricsEffortApply.addEventListener("click", applyDeveloperMetricFilters);
elements.metricsEffortReset.addEventListener("click", () => {
  model.developerMetricsRangeCustomized = false;
  model.selectedMetricsDeveloperId = null;
  void loadDashboardMetrics();
});
elements.metricsDeveloper.addEventListener("change", () => {
  model.selectedMetricsDeveloperId = elements.metricsDeveloper.value || null;
  renderMetrics();
});
elements.historyApply.addEventListener("click", () => {
  if (!isHistoryDateSelectable()) {
    void loadProjectHistory();
    return;
  }
  model.historyCursor = null;
  void loadProjectHistory();
});
elements.historyDate.addEventListener("change", () => {
  model.historyDate = elements.historyDate.value || null;
  model.historyCursor = null;
  model.historySnapshot = null;
  elements.historyContent.innerHTML = '<div class="history-empty">Escolha “Ver retrato” para carregar a data selecionada.</div>';
  elements.historyApply.disabled = !isHistoryDateSelectable();
  if (isHistoryDateSelectable()) {
    elements.historyError.hidden = true;
    elements.historyMeta.textContent = "Aguardando a consulta da data selecionada.";
  } else {
    elements.historyError.textContent = historyDateBoundsMessage();
    elements.historyError.hidden = false;
    elements.historyMeta.textContent = "A data escolhida está fora do período disponível.";
  }
});
elements.historyToday.addEventListener("click", () => {
  if (!model.project) return;
  elements.historyDate.value = projectLocalDate(new Date(), model.project.timezone);
  model.historyDate = elements.historyDate.value;
  model.historyCursor = null;
  void loadProjectHistory();
});
elements.historyContent.addEventListener("click", (event) => {
  if (event.target.closest("#history-load-more") && model.historyCursor) {
    void loadProjectHistory(model.historyCursor);
  }
});
elements.metricsContent.addEventListener("click", (event) => {
  const point = event.target.closest("[data-metric-date]");
  if (!point) return;
  model.selectedMetricsDate = point.getAttribute("data-metric-date");
  elements.metricsDate.value = model.selectedMetricsDate;
  void loadDashboardMetrics();
});
elements.metricsContent.addEventListener("change", (event) => {
  if (!event.target.matches("#metrics-velocity-window")) return;
  model.metricsVelocityWindow = Number(event.target.value);
  renderMetrics();
});
elements.metricsContent.addEventListener("keydown", (event) => {
  if ((event.key !== "Enter" && event.key !== " ") || !event.target.matches("[data-metric-date]")) return;
  event.preventDefault();
  model.selectedMetricsDate = event.target.getAttribute("data-metric-date");
  elements.metricsDate.value = model.selectedMetricsDate;
  void loadDashboardMetrics();
});
elements.loadMoreActivity.addEventListener("click", () => { void loadMoreActivity(); });
elements.targetState.addEventListener("change", updateBuildField);
elements.targetState.addEventListener("change", () => { void updateTransitionStartHint(); });
elements.transitionForm.addEventListener("submit", (event) => { void submitTransition(event); });
elements.applyActivityFilter.addEventListener("click", () => { void applyActivityFilters(); });
elements.retrospectiveSprint.addEventListener("change", () => {
  model.selectedRetrospectiveSprintId = elements.retrospectiveSprint.value || null;
  void loadSelectedRetrospective();
});
elements.retrospectiveContent.addEventListener("change", (event) => {
  if (event.target.id === "retrospective-revision") void loadSelectedRetrospective(event.target.value);
});
elements.activityEntityId.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void applyActivityFilters();
  }
});
elements.detailMove.addEventListener("click", () => {
  if (model.currentItem) openTransition(model.currentItem);
});
elements.itemDetails.addEventListener("change", (event) => {
  if (event.target.id === "task-workflow-history") void loadTaskWorkflowRevision(Number(event.target.value));
});
elements.taskWorkflowForm.addEventListener("submit", (event) => { void submitTaskWorkflowForm(event); });
elements.publishTaskWorkflow.addEventListener("click", () => { void publishTaskWorkflowDraft(); });
elements.addTaskWorkflowStep.addEventListener("click", () => {
  const rows = elements.taskWorkflowStepList.querySelectorAll(".workflow-step-editor");
  if (rows.length >= 50) {
    toast("O workflow pode ter no máximo 50 etapas.", true);
    return;
  }
  elements.taskWorkflowStepList.insertAdjacentHTML("beforeend", workflowEditorRow({}, rows.length + 1));
  model.workflowEditorDirty = true;
  updateWorkflowEditorOrder();
  updateWorkflowEditorState();
  elements.taskWorkflowStepList.querySelector(".workflow-step-editor:last-child [data-workflow-title]").focus();
});
elements.taskWorkflowStepList.addEventListener("input", () => {
  model.workflowEditorDirty = true;
  updateWorkflowEditorState();
});
elements.taskWorkflowReason.addEventListener("input", () => { updateWorkflowEditorState(); });
elements.taskWorkflowStepList.addEventListener("click", (event) => {
  const row = event.target.closest(".workflow-step-editor");
  if (!row) return;
  if (event.target.closest("[data-workflow-remove]")) {
    if (elements.taskWorkflowStepList.querySelectorAll(".workflow-step-editor").length <= 1) {
      toast("Um workflow deve conter pelo menos uma etapa.", true);
      return;
    }
    row.remove();
  } else if (event.target.closest("[data-workflow-up]") && row.previousElementSibling) {
    row.parentElement.insertBefore(row, row.previousElementSibling);
  } else if (event.target.closest("[data-workflow-down]") && row.nextElementSibling) {
    row.parentElement.insertBefore(row.nextElementSibling, row);
  } else return;
  model.workflowEditorDirty = true;
  updateWorkflowEditorOrder();
  updateWorkflowEditorState();
});
elements.detailEdit.addEventListener("click", () => {
  if (model.currentItem) void openWorkItemEditor(model.currentItem);
});
elements.createWorkItem.addEventListener("click", () => { void openWorkItemEditor(); });
elements.workItemForm.addEventListener("submit", (event) => { void submitWorkItemForm(event); });
elements.workItemType.addEventListener("change", () => {
  updateWorkItemParentOptions("");
  updateWorkItemValueFields();
});
elements.createScenario.addEventListener("click", () => { void openScenarioEditor(); });
elements.scenarioForm.addEventListener("submit", (event) => { void submitScenarioForm(event); });
elements.testRunForm.addEventListener("submit", (event) => { void submitTestRun(event); });
document.addEventListener("click", (event) => {
  if (event.target.closest(".retro-pbi")) event.preventDefault();
  const homeViewButton = event.target.closest("[data-home-view]");
  if (homeViewButton) {
    const view = homeViewButton.getAttribute("data-home-view");
    if (view) {
      setView(view);
      document.getElementById(`${view}-tab`)?.focus();
    }
    return;
  }
  const evidenceButton = event.target.closest("[data-load-evidence]");
  if (evidenceButton) {
    void loadMoreEvidence(evidenceButton);
    return;
  }
  const taskContextButton = event.target.closest("[data-load-task-context]");
  if (taskContextButton) {
    void loadMoreTaskContext(taskContextButton);
    return;
  }
  const scenarioPublish = event.target.closest("[data-publish-scenario]");
  if (scenarioPublish) {
    void publishScenario(scenarioPublish.getAttribute("data-publish-scenario"), Number(scenarioPublish.getAttribute("data-revision")));
    return;
  }
  const claimButton = event.target.closest("[data-home-claim]");
  if (claimButton) {
    void claimQuickAccessTask(claimButton);
    return;
  }
  if (event.target.closest("[data-edit-task-workflow]")) {
    openTaskWorkflowEditor();
    return;
  }
  const workflowStatus = event.target.closest("[data-workflow-status]");
  if (workflowStatus) {
    void changeTaskWorkflowStep(workflowStatus);
    return;
  }
  const scenarioRevise = event.target.closest("[data-revise-scenario]");
  if (scenarioRevise) {
    const scenario = model.scenarios.find((entry) => entry.key === scenarioRevise.getAttribute("data-revise-scenario"));
    if (scenario) void openScenarioEditor(scenario);
    return;
  }
  const itemPublish = event.target.closest("[data-publish-item-revision]");
  if (itemPublish) {
    void publishWorkItemRevision(Number(itemPublish.getAttribute("data-publish-item-revision")));
    return;
  }
  const specificationOpen = event.target.closest("[data-open-specification]");
  if (specificationOpen) {
    const specificationKey = specificationOpen.getAttribute("data-open-specification");
    if (specificationKey) void openSpecification(specificationKey);
    return;
  }
  const specificationRevision = event.target.closest("[data-spec-revision]");
  if (specificationRevision) {
    model.selectedSpecificationRevisionNumber = Number(specificationRevision.getAttribute("data-spec-revision"));
    renderSpecificationDetail();
    return;
  }
  const specificationAction = event.target.closest("[data-spec-action]");
  if (specificationAction) {
    void runSpecificationAction(specificationAction);
    return;
  }
  if (event.target.closest("[data-close-specification]")) {
    model.currentSpecification = null;
    model.selectedSpecificationRevisionNumber = null;
    renderSpecifications();
    return;
  }
  const target = event.target.closest("[data-open-item]");
  if (target) {
    const itemId = target.getAttribute("data-open-item");
    if (itemId) void openItem(itemId);
    return;
  }
  const moveTarget = event.target.closest("[data-move-item]");
  if (moveTarget) {
    const item = model.items.find((candidate) => candidate.id === moveTarget.getAttribute("data-move-item"));
    if (item) openTransition(item);
  }
});
document.querySelectorAll(".close-dialog").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});
elements.createSpecification.addEventListener("click", () => openSpecificationForm("create"));
elements.specificationForm.addEventListener("submit", (event) => { void submitSpecificationForm(event); });
for (const dialog of [elements.specificationDialog, elements.itemDialog, elements.transitionDialog, elements.workItemDialog, elements.scenarioDialog, elements.taskWorkflowDialog]) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}
elements.board.addEventListener("dragstart", (event) => {
  const card = event.target.closest("[data-card-id]");
  if (!card) return;
  model.draggedItemId = card.getAttribute("data-card-id");
  card.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", model.draggedItemId);
});
elements.board.addEventListener("dragend", (event) => {
  event.target.closest("[data-card-id]")?.classList.remove("is-dragging");
  elements.board.querySelectorAll(".is-drop-target").forEach((column) => column.classList.remove("is-drop-target"));
  model.draggedItemId = null;
});
elements.board.addEventListener("dragover", (event) => {
  const lane = event.target.closest("[data-drop-state]");
  if (!lane) return;
  event.preventDefault();
  lane.closest(".board-column").classList.add("is-drop-target");
});
elements.board.addEventListener("dragleave", (event) => {
  const column = event.target.closest(".board-column");
  if (column && !column.contains(event.relatedTarget)) column.classList.remove("is-drop-target");
});
elements.board.addEventListener("drop", (event) => {
  const lane = event.target.closest("[data-drop-state]");
  const itemId = event.dataTransfer.getData("text/plain") || model.draggedItemId;
  if (!lane || !itemId) return;
  event.preventDefault();
  const item = model.items.find((candidate) => candidate.id === itemId);
  const targetState = lane.getAttribute("data-drop-state");
  lane.closest(".board-column").classList.remove("is-drop-target");
  if (!item || !(transitions[item.state] ?? []).includes(targetState)) {
    toast("Esse movimento não é permitido pelo workflow atual.", true);
    return;
  }
  openTransition(item, targetState);
});
elements.board.addEventListener("keydown", (event) => {
  const card = event.target.closest("[data-card-id]");
  if (card && (event.key === "Enter" || event.key === " ") && event.target === card) {
    event.preventDefault();
    void openItem(card.getAttribute("data-card-id"));
  }
});

