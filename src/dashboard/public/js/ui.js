/* global document, fetch, window */
import { stateLabels, typeLabels, scenarioKindLabels, specificationKindLabels } from "./constants.js";
import { elements } from "./elements.js";
import { model } from "./model.js";
import { showLogin } from "./session.js";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function itemTypeLabel(type) {
  return typeLabels[type] ?? type;
}

export function scenarioKindLabel(kind) {
  return scenarioKindLabels[kind] ?? kind;
}

export function specificationKindLabel(kind) {
  return specificationKindLabels[kind] ?? kind;
}

export function stateLabel(state) {
  return stateLabels[state] ?? state;
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.headers ?? {}) },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(body?.message ?? `A solicitação falhou (${response.status}).`);
    error.status = response.status;
    error.code = body?.code ?? "HTTP_ERROR";
    error.details = body?.details;
    throw error;
  }
  return body;
}

export function toast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.hidden = false;
  // A modal dialog sits in the top layer and would hide the toast behind its backdrop; a manual popover joins the top layer above it.
  if (typeof elements.toast.showPopover === "function") {
    try { if (elements.toast.matches(":popover-open")) elements.toast.hidePopover(); elements.toast.showPopover(); } catch { /* keep the in-page toast */ }
  }
  if (model.toastTimer !== null) window.clearTimeout(model.toastTimer);
  model.toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
    try { if (elements.toast.matches(":popover-open")) elements.toast.hidePopover(); } catch { /* already hidden */ }
  }, isError ? 7_000 : 3_500);
}

export function showError(error) {
  if (error?.code === "SESSION_REQUIRED" || error?.code === "SESSION_INVALID") {
    showLogin("Sua sessão expirou ou a authKey foi revogada. Entre novamente para continuar.");
    return;
  }
  const detail = error?.details ? `\n${JSON.stringify(error.details, null, 2)}` : "";
  elements.errorMessage.textContent = `${error?.code ? `${error.code}: ` : ""}${error?.message ?? "Erro inesperado."}${detail}`;
  elements.error.hidden = false;
  elements.loading.hidden = true;
  elements.homeView.hidden = true;
  elements.backlogView.hidden = true;
  elements.boardView.hidden = true;
  elements.qualityView.hidden = true;
  elements.activityView.hidden = true;
  elements.retrospectiveView.hidden = true;
  elements.historyView.hidden = true;
  elements.specificationsView.hidden = true;
  elements.metricsView.hidden = true;
  elements.roadmapView.hidden = true;
}

export function showWorkspace() {
  elements.error.hidden = true;
  elements.loading.hidden = true;
  const selectedTab = document.querySelector('[role="tab"][aria-selected="true"]')?.id;
  elements.homeView.hidden = selectedTab !== "home-tab";
  elements.backlogView.hidden = selectedTab !== "backlog-tab";
  elements.boardView.hidden = selectedTab !== "board-tab";
  elements.qualityView.hidden = selectedTab !== "quality-tab";
  elements.activityView.hidden = selectedTab !== "activity-tab";
  elements.retrospectiveView.hidden = selectedTab !== "retrospective-tab";
  elements.historyView.hidden = selectedTab !== "history-tab";
  elements.specificationsView.hidden = selectedTab !== "specifications-tab";
  elements.metricsView.hidden = selectedTab !== "metrics-tab";
  elements.roadmapView.hidden = selectedTab !== "roadmap-tab";
  elements.filters.hidden = selectedTab === "home-tab" || selectedTab === "metrics-tab" || selectedTab === "history-tab" || selectedTab === "roadmap-tab" || selectedTab === "specifications-tab";
}
