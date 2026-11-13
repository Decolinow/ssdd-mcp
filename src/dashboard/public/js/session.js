/* global crypto, document, URLSearchParams, window */
import { elements } from "./elements.js";
import { model } from "./model.js";
import { escapeHtml, api, toast, showError } from "./ui.js";
import { loadProjectData } from "./data.js";
import { syncWorkProfileOptions } from "./quick-access.js";
import { openItem } from "./details.js";

export function showLogin(message = "") {
  model.session = null;
  if (model.refreshTimer !== null) {
    window.clearInterval(model.refreshTimer);
    model.refreshTimer = null;
  }
  elements.appShell.hidden = true;
  elements.loginScreen.hidden = false;
  elements.loginError.textContent = message;
  elements.loginError.hidden = !message;
  elements.loading.hidden = true;
  elements.authKey.focus();
}

export async function claimQuickAccessTask(button) {
  const taskKey = button.getAttribute("data-home-claim");
  const expectedVersion = Number(button.getAttribute("data-task-version"));
  if (!taskKey || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !model.session?.csrfToken) return;
  button.disabled = true;
  try {
    const result = await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/work-items/${encodeURIComponent(taskKey)}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SSDD-CSRF": model.session.csrfToken },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        expectedVersion,
        reason: "Tarefa assumida a partir da visão de próximas ações do dashboard.",
      }),
    });
    toast(`${result.task.key} atribuída a você. Confira os gates antes de iniciar a sessão.`);
    await loadProjectData();
    await openItem(result.task.id);
  } catch (error) {
    const details = error.details ? ` ${JSON.stringify(error.details)}` : "";
    toast(`${error.code ?? "ERRO"}: ${error.message}${details}`, true);
    if (["VERSION_CONFLICT", "TASK_NOT_STARTABLE", "TASK_ALREADY_ASSIGNED", "STALE_CURSOR"].includes(error.code)) await loadProjectData();
  } finally {
    button.disabled = false;
  }
}

export async function startAuthenticatedDashboard(session) {
  model.session = session;
  model.projects = session.projects;
  elements.loginScreen.hidden = true;
  elements.appShell.hidden = false;
  elements.principalName.textContent = session.principal.displayName;
  elements.projectSelect.innerHTML = model.projects.map((project) =>
    `<option value="${escapeHtml(project.id)}">${escapeHtml(project.key)} · ${escapeHtml(project.name)}</option>`).join("");
  if (model.projects.length === 0) {
    elements.loading.innerHTML = "<strong>Nenhum projeto disponível para este principal.</strong><p>Solicite associação a um projeto ao administrador.</p>";
    elements.loading.hidden = false;
    return;
  }
  model.projectId = model.projects[0].id;
  model.quickAccess = null;
  syncWorkProfileOptions();
  await loadProjectData();
  scheduleRefresh();
}

export function scheduleRefresh() {
  if (model.refreshTimer !== null) {
    window.clearInterval(model.refreshTimer);
    model.refreshTimer = null;
  }
  if (document.hidden || model.session === null) return;
  model.refreshTimer = window.setInterval(() => { void loadProjectData(); }, 30_000);
}

export async function submitLogin(event) {
  event.preventDefault();
  elements.loginError.hidden = true;
  elements.loginSubmit.disabled = true;
  const submittedKey = elements.authKey.value.trim();
  try {
    const session = await api("/api/v1/session/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authKey: submittedKey }),
    });
    elements.authKey.value = "";
    await startAuthenticatedDashboard(session);
  } catch (error) {
    elements.loginError.textContent = error?.code === "ORIGIN_NOT_ALLOWED"
      ? "A origem do dashboard não foi validada. Recarregue a página local e tente novamente."
      : "Não foi possível autenticar. Verifique a authKey ou confirme com o administrador se ela continua ativa.";
    elements.loginError.hidden = false;
  } finally {
    elements.authKey.value = "";
    elements.loginSubmit.disabled = false;
  }
}

export async function logout() {
  try {
    await api("/api/v1/session/logout", {
      method: "POST",
      headers: { "X-SSDD-CSRF": model.session.csrfToken },
    });
  } catch (error) {
    if (error?.code !== "SESSION_REQUIRED" && error?.code !== "SESSION_INVALID") {
      toast("Não foi possível encerrar a sessão. Tente novamente.", true);
      return;
    }
  }
  elements.appShell.hidden = true;
  showLogin("Sessão encerrada.");
}

export async function initialize() {
  const query = new URLSearchParams(window.location.search);
  if (query.has("token")) {
    query.delete("token");
    const cleanLocation = `${window.location.pathname}${query.size ? `?${query}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", cleanLocation);
  }
  try {
    await startAuthenticatedDashboard(await api("/api/v1/session"));
  } catch (error) {
    if (error?.code === "SESSION_REQUIRED" || error?.code === "SESSION_INVALID") showLogin();
    else showError(error);
  }
}
