/* global crypto, document, window */
import { transitions } from "./constants.js";
import { elements } from "./elements.js";
import { model } from "./model.js";
import { escapeHtml, stateLabel, api, toast } from "./ui.js";
import { loadSpecifications, loadProjectData, loadDashboardMetrics, loadProjectRoadmap } from "./data.js";
import { scheduleRefresh, submitLogin, logout } from "./session.js";
import { syncWorkProfileOptions, storeWorkProfile, renderQuickAccess, render } from "./quick-access.js";
import { loadProjectHistory } from "./history.js";

export function openTransition(item, preferredState = null) {
  const targets = transitions[item.state] ?? [];
  if (!targets.length) {
    toast("Este item não tem transições disponíveis.", true);
    return;
  }
  model.pendingMove = item;
  elements.transitionItemLabel.textContent = `${item.key} · ${item.title} · Versão atual ${item.version}`;
  elements.targetState.innerHTML = targets.map((state) => `<option value="${escapeHtml(state)}">${escapeHtml(stateLabel(state))}</option>`).join("");
  if (preferredState && targets.includes(preferredState)) elements.targetState.value = preferredState;
  elements.reason.value = "";
  elements.buildId.value = "";
  updateBuildField();
  if (elements.itemDialog.open) elements.itemDialog.close();
  elements.transitionDialog.showModal();
  elements.targetState.focus();
  void updateTransitionStartHint();
}

export async function updateTransitionStartHint() {
  const item = model.pendingMove;
  const isTaskStart = item?.type === "task" && item.state === "ready" && elements.targetState.value === "in_progress";
  elements.submitTransition.textContent = isTaskStart ? "Iniciar e abrir sessão" : "Confirmar mudança";
  elements.transitionStartHint.hidden = !isTaskStart;
  elements.transitionStartHint.classList.remove("is-blocked");
  if (!isTaskStart) return;
  elements.transitionStartHint.textContent = "Conferindo responsável, PBI pai, baseline, dependências, ADRs e sessões abertas…";
  try {
    const result = await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/work-items/${encodeURIComponent(item.key)}/start-readiness`);
    if (model.pendingMove?.id !== item.id || elements.targetState.value !== "in_progress") return;
    const readiness = result.readiness;
    const messages = readiness.blockers.map((blocker) => `• ${blocker.message}`);
    const warnings = readiness.warnings.map((warning) => `• Aviso: ${warning.message}`);
    elements.transitionStartHint.classList.toggle("is-blocked", !readiness.canStart);
    elements.transitionStartHint.textContent = readiness.canStart
      ? `Pronta para iniciar. A confirmação muda o estado e abre a sessão juntos.${warnings.length ? `\n${warnings.join("\n")}` : ""}`
      : `A tarefa ainda não pode iniciar:\n${messages.join("\n")}`;
  } catch (error) {
    if (model.pendingMove?.id !== item.id) return;
    elements.transitionStartHint.classList.add("is-blocked");
    elements.transitionStartHint.textContent = `Não foi possível validar os gates. ${error.message}`;
  }
}

export function updateBuildField() {
  const requiresBuild = elements.targetState.value === "done";
  elements.buildIdField.hidden = !requiresBuild;
  elements.buildId.required = requiresBuild;
}

export async function submitTransition(event) {
  event.preventDefault();
  if (!model.pendingMove) return;
  const item = model.pendingMove;
  const targetState = elements.targetState.value;
  const startsTask = item.type === "task" && item.state === "ready" && targetState === "in_progress";
  elements.submitTransition.disabled = true;
  elements.submitTransition.textContent = "Validando gates…";
  try {
    const body = {
      requestId: crypto.randomUUID(),
      expectedVersion: item.version,
      reason: elements.reason.value.trim(),
      ...(elements.buildId.value.trim() ? { buildId: elements.buildId.value.trim() } : {}),
    };
    if (startsTask) {
      const check = await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/work-items/${encodeURIComponent(item.key)}/start-readiness`);
      if (!check.readiness.canStart) {
        elements.transitionStartHint.classList.add("is-blocked");
        elements.transitionStartHint.hidden = false;
        elements.transitionStartHint.textContent = `A tarefa ainda não pode iniciar:\n${check.readiness.blockers.map((blocker) => `• ${blocker.message}`).join("\n")}`;
        return;
      }
      await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/work-items/${encodeURIComponent(item.key)}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-SSDD-CSRF": model.session.csrfToken },
        body: JSON.stringify(body),
      });
    } else {
      await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/work-items/${encodeURIComponent(item.key)}/transition`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SSDD-CSRF": model.session.csrfToken,
      },
        body: JSON.stringify({ ...body, targetState }),
      });
    }
    elements.transitionDialog.close();
    model.pendingMove = null;
    toast(startsTask ? `${item.key} iniciada e sessão de desenvolvimento aberta.` : `${item.key} atualizado para ${stateLabel(targetState)}.`);
    await loadProjectData();
  } catch (error) {
    const details = error.details ? ` ${JSON.stringify(error.details)}` : "";
    toast(`${error.code ?? "ERRO"}: ${error.message}${details}`, true);
    if (["VERSION_CONFLICT", "STALE_CURSOR"].includes(error.code)) await loadProjectData();
  } finally {
    elements.submitTransition.disabled = false;
    elements.submitTransition.textContent = "Confirmar mudança";
  }
}

export function setView(view) {
  const views = {
    home: [elements.homeTab, elements.homeView],
    metrics: [elements.metricsTab, elements.metricsView],
    roadmap: [elements.roadmapTab, elements.roadmapView],
    history: [elements.historyTab, elements.historyView],
    specifications: [elements.specificationsTab, elements.specificationsView],
    backlog: [elements.backlogTab, elements.backlogView],
    board: [elements.boardTab, elements.boardView],
    quality: [elements.qualityTab, elements.qualityView],
    activity: [elements.activityTab, elements.activityView],
    retrospective: [elements.retrospectiveTab, elements.retrospectiveView],
  };
  for (const [name, [tab, panel]] of Object.entries(views)) {
    const selected = name === view;
    tab.classList.toggle("is-active", selected);
    tab.setAttribute("aria-selected", String(selected));
    panel.hidden = !selected;
  }
  elements.filters.hidden = view === "home" || view === "metrics" || view === "history" || view === "roadmap" || view === "specifications";
  if (view === "home") renderQuickAccess();
  if (view === "metrics") void loadDashboardMetrics();
  if (view === "roadmap") void loadProjectRoadmap();
  if (view === "history") void loadProjectHistory();
  if (view === "specifications") void loadSpecifications();
}

elements.loginForm.addEventListener("submit", (event) => { void submitLogin(event); });
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
