/* global window */
import { states, workProfileLabels, workProfileOrder } from "./constants.js";
import { elements } from "./elements.js";
import { model } from "./model.js";
import { escapeHtml, stateLabel } from "./ui.js";
import { renderProjectRoadmap } from "./data.js";
import { renderProjectHistory } from "./history.js";
import { renderSprintSummary, renderBacklog, renderBoard, renderQuality, renderActivity, renderRetrospective } from "./views.js";
import { renderSpecifications } from "./specifications.js";
import { renderMetrics } from "./metrics.js";

export function filteredItems(items) {
  const text = elements.search.value.trim().toLocaleLowerCase("pt-BR");
  const type = elements.typeFilter.value;
  return items.filter((item) => {
    if (type !== "all" && item.type !== type) return false;
    if (!text) return true;
    return `${item.key} ${item.title}`.toLocaleLowerCase("pt-BR").includes(text);
  });
}

export function filteredQualitySummaries() {
  const text = elements.search.value.trim().toLocaleLowerCase("pt-BR");
  const type = elements.typeFilter.value;
  return model.qualitySummaries.filter((item) => {
    if (type !== "all" && item.type !== type) return false;
    if (!text) return true;
    return `${item.itemKey} ${item.title}`.toLocaleLowerCase("pt-BR").includes(text);
  });
}

export function activeScopeIds() {
  return new Set(model.sprint?.scope.map((item) => item.itemId) ?? []);
}

export function visibleBoardItems() {
  const scope = activeScopeIds();
  return filteredItems(model.items).filter((item) => states.includes(item.state) && (model.sprint === null || scope.has(item.id)));
}

export function backlogItems() {
  const scope = activeScopeIds();
  return filteredItems(model.items).filter((item) => model.sprint === null || !scope.has(item.id));
}

export function syncWorkProfileOptions() {
  const projectRoles = model.quickAccess?.roles
    ?? model.project?.roles
    ?? model.projects.find((project) => project.id === model.projectId)?.roles
    ?? [];
  const storageKey = `ssdd-dashboard-work-profile:${model.projectId}`;
  const storedProfile = readStoredWorkProfile(storageKey);
  const defaultProfile = workProfileOrder.find((role) => projectRoles.includes(role)) ?? projectRoles[0] ?? "";
  if (!projectRoles.includes(model.workProfile)) {
    model.workProfile = projectRoles.includes(storedProfile) ? storedProfile : defaultProfile;
  }
  elements.homeProfile.innerHTML = projectRoles.map((role) =>
    `<option value="${escapeHtml(role)}">${escapeHtml(workProfileLabels[role] ?? role)}</option>`).join("");
  elements.homeProfile.value = model.workProfile ?? "";
  elements.homeProfile.disabled = projectRoles.length <= 1;
}

export function readStoredWorkProfile(storageKey) {
  try { return window.sessionStorage.getItem(storageKey); } catch { return null; }
}

export function storeWorkProfile(storageKey, profile) {
  try { window.sessionStorage.setItem(storageKey, profile); } catch { return; }
}

export function quickStat(value, label, attention = false) {
  return `<article class="quick-stat${attention ? " is-attention" : ""}"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></article>`;
}

export function blockerLabel(code) {
  const labels = {
    task_not_ready_for_development: "a tarefa não está Ready",
    developer_role_required: "papel Developer necessário",
    task_unassigned: "sem responsável",
    task_assigned_to_another_user: "atribuída a outra pessoa",
    task_output_missing: "falta descrever a entrega",
    parent_pbi_missing: "falta PBI pai",
    parent_pbi_not_active: "PBI pai fora de Ready/Em andamento",
    parent_baseline_missing: "falta baseline do PBI pai",
    dependencies_incomplete: "dependências pendentes",
    task_session_already_active: "já existe sessão ativa",
    task_session_paused: "há sessão pausada para retomar ou encerrar",
    task_session_handoff_required: "handoff da sessão pendente",
    implementing_adr_unpublished: "ADR ligada ainda não publicada",
    task_workflow_unpublished: "workflow ainda não publicado",
  };
  return labels[code] ?? code.replaceAll("_", " ");
}

export function renderQuickTask(item, mode = "open") {
  const meta = [
    stateLabel(item.state),
    Number.isInteger(item.priority) ? `P${item.priority}` : null,
    item.businessValueScore === null || item.businessValueScore === undefined ? null : `valor ${item.businessValueScore}/100`,
  ].filter(Boolean).join(" · ");
  const blockers = Array.isArray(item.blockerCodes) && item.blockerCodes.length > 0
    ? `<small>${escapeHtml(item.blockerCodes.map(blockerLabel).join("; "))}</small>` : "";
  const action = mode === "claim"
    ? `<button class="button button-primary" type="button" data-home-claim="${escapeHtml(item.key)}" data-task-version="${escapeHtml(item.version)}">Assumir</button>`
    : `<button class="button button-secondary" type="button" data-open-item="${escapeHtml(item.id)}">${item.state === "ready" ? "Ver gates e iniciar" : "Abrir tarefa"}</button>`;
  return `<li class="quick-task"><div class="quick-task-main"><strong>${escapeHtml(item.key)} · ${escapeHtml(item.title)}</strong><span>${escapeHtml(meta || "Sem metadados adicionais")}</span>${blockers}</div><div class="quick-task-actions">${action}</div></li>`;
}

export function quickPanel(title, description, items, emptyMessage, mode = "open") {
  const content = items.length > 0
    ? `<ul class="quick-task-list">${items.map((item) => renderQuickTask(item, mode)).join("")}</ul>`
    : `<p class="quick-empty">${escapeHtml(emptyMessage)}</p>`;
  return `<section class="quick-panel"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p>${content}</section>`;
}

export function renderFirstUseGuidance() {
  const isFirstUse = model.items.length === 0 && model.parentFeatures.length === 0;
  elements.firstUseGuidance.hidden = !isFirstUse;
  if (!isFirstUse) {
    elements.firstUseGuidance.innerHTML = "";
    return;
  }
  elements.firstUseGuidance.innerHTML = `<section class="first-use-card" aria-labelledby="first-use-title"><p class="eyebrow">PRIMEIRO USO</p><h3 id="first-use-title">Este projeto ainda não tem backlog</h3><p>O dashboard acompanha o trabalho; a autoria principal acontece pelas ferramentas MCP. Comece pelo backlog e depois configure a execução.</p><ol><li>Crie épicos, Features, histórias e tarefas com <code>work_item_create</code>. Publique revisões de PBI quando o conteúdo estiver estável.</li><li>Registre regras e ADRs com <code>spec_create</code> e cenários de aceite com <code>scenario_create</code>.</li><li>Crie o time, defina capacidade/DoD e prepare uma sprint com <code>team_create</code>, <code>team_capacity_set</code> e <code>sprint_draft</code>.</li></ol><p class="first-use-note">As abas mostram um estado vazio até existir dado compatível. Use o botão Atualizar no topo após cadastrar pelo MCP.</p><div class="quick-task-actions"><button class="button button-primary" type="button" data-home-view="backlog">Abrir Product Backlog</button><button class="button button-secondary" type="button" data-home-view="roadmap">Abrir Roadmap</button></div></section>`;
}

export function renderQuickAccess() {
  const quickAccess = model.quickAccess;
  if (quickAccess === null) return;
  syncWorkProfileOptions();
  renderFirstUseGuidance();
  const profile = model.workProfile;
  const profileLabel = workProfileLabels[profile] ?? profile ?? "Perfil";
  const displayName = model.session?.principal?.displayName ?? "pessoa usuária";
  elements.homeTitle.textContent = `Olá, ${displayName}`;
  elements.homeDescription.textContent = `Estas são as próximas ações de ${profileLabel} em ${model.project?.name ?? "seu projeto"}. A autorização continua vinculada aos papéis da sua sessão.`;

  if (profile === "developer" && quickAccess.developer !== null) {
    const view = quickAccess.developer;
    const assigned = [...view.startableTasks, ...view.activeTasks]
      .filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index);
    elements.homeSummary.innerHTML = [
      quickStat(view.startableTasks.length, "Elegíveis para iniciar sessão · até 8"),
      quickStat(view.activeTasks.length, "Em andamento · até 8"),
      quickStat(view.blockedCount, "Sem início seguro", view.blockedCount > 0),
      quickStat(view.claimableTasks.length, "Pode assumir · até 8"),
    ].join("");
    elements.homeActions.innerHTML = [
      quickPanel("Minha fila", "Tarefas atribuídas a você, ordenadas por prioridade e gates de início.", assigned,
        "Você não tem tarefas Ready ou em andamento atribuídas neste projeto."),
      quickPanel("Pode assumir", "Só aparecem tarefas Ready sem responsável e com os gates de início aprovados. Assumir não inicia uma sessão.", view.claimableTasks,
        view.claimCandidatesTruncated ? "Não encontramos tarefas elegíveis entre as primeiras candidatas. Use o Product Backlog para consultar mais itens." : "Nenhuma tarefa está liberada para assumir agora.", "claim"),
      quickPanel("Impedimentos", "Até três tarefas com dependências, baseline, ADRs ou sessões que impedem um novo início.", view.blockedTasks,
        "Nenhum impedimento de início foi encontrado na amostra da fila."),
    ].join("");
    return;
  }

  if (profile === "qa" && quickAccess.qa !== null) {
    const items = quickAccess.qa.pendingValidation;
    elements.homeSummary.innerHTML = [quickStat(items.length, "Aguardando validação · até 8", items.length > 0), quickStat(model.scenarios.length, "Cenários carregados"), quickStat(model.testRuns.length, "Execuções recentes")].join("");
    elements.homeActions.innerHTML = `${quickPanel("Próxima validação", "Abra um item em validação para conferir critérios, cenários e evidências.", items, "Não há itens aguardando validação agora.")}<section class="quick-panel"><h3>Atalhos de QA</h3><p>Consulte cobertura, publique revisões de cenário e registre execuções vinculadas ao build.</p><button class="button button-primary" type="button" data-home-view="quality">Abrir Qualidade</button></section>`;
    return;
  }

  if (profile === "po" && quickAccess.productOwner !== null) {
    const drafts = quickAccess.productOwner.drafts;
    elements.homeSummary.innerHTML = [quickStat(drafts.length, "Drafts para refinar · até 8", drafts.length > 0), quickStat(model.items.length, "Histórias e bugs carregados")].join("");
    elements.homeActions.innerHTML = `${quickPanel("Refinamento pendente", "Revise conteúdo, valor de negócio, critérios e vínculos antes de preparar itens para Ready.", drafts, "Não há histórias ou bugs em Draft na amostra atual.")}<section class="quick-panel"><h3>Próximas decisões</h3><p>Use a prioridade e o valor de negócio do backlog para orientar a ordem de refinamento.</p><button class="button button-primary" type="button" data-home-view="backlog">Abrir Product Backlog</button></section>`;
    return;
  }

  if (profile === "tech_lead" && quickAccess.techLead !== null) {
    const review = quickAccess.techLead.awaitingReview;
    const drafts = quickAccess.techLead.draftTasks;
    elements.homeSummary.innerHTML = [quickStat(review.length, "Aguardando revisão · até 8", review.length > 0), quickStat(drafts.length, "Tarefas Draft · até 8")].join("");
    elements.homeActions.innerHTML = [
      quickPanel("Revisões pendentes", "Verifique implementação, rastreabilidade técnica e critérios de aceite.", review, "Não há itens aguardando revisão agora."),
      quickPanel("Tarefas para refinar", "Especifique o plano técnico antes de liberar tarefas para desenvolvimento.", drafts, "Não há tarefas em Draft na amostra atual."),
    ].join("");
    return;
  }

  if (profile === "facilitator") {
    elements.homeSummary.innerHTML = [quickStat(model.sprint?.key ?? "—", "Sprint ativa no time selecionado"), quickStat(model.closedSprints.length, "Sprints encerradas")].join("");
    elements.homeActions.innerHTML = `<section class="quick-panel"><h3>Fluxo da equipe</h3><p>${model.sprint ? `Sprint ${escapeHtml(model.sprint.key)} · ${escapeHtml(model.sprint.title)}` : "Selecione um time com sprint ativa para acompanhar o ciclo."}</p><button class="button button-primary" type="button" data-home-view="board">Abrir Board</button></section><section class="quick-panel"><h3>Fechar o ciclo</h3><p>Consulte aprendizados registrados e acompanhe ações da retrospectiva.</p><button class="button button-secondary" type="button" data-home-view="retrospective">Abrir Retrospectiva</button></section>`;
    return;
  }

  const title = profile === "stakeholder" ? "Acompanhar entrega" : "Atalhos do projeto";
  elements.homeSummary.innerHTML = [quickStat(model.items.length, "PBIs carregados"), quickStat(model.scenarios.length, "Cenários carregados"), quickStat(model.testRuns.length, "Execuções recentes")].join("");
  elements.homeActions.innerHTML = `<section class="quick-panel"><h3>${escapeHtml(title)}</h3><p>Consulte a ordem priorizada das Features, o progresso confirmado e os indicadores do projeto.</p><button class="button button-primary" type="button" data-home-view="roadmap">Abrir Roadmap</button></section><section class="quick-panel"><h3>Estado observado</h3><p>Use a data do projeto para consultar um retrato histórico ou abra as métricas para acompanhar a entrega.</p><div class="quick-task-actions"><button class="button button-secondary" type="button" data-home-view="metrics">Métricas</button><button class="button button-secondary" type="button" data-home-view="history">Histórico</button></div></section>`;
}

export function render() {
  renderQuickAccess();
  renderSprintSummary();
  renderBacklog();
  renderBoard();
  renderQuality();
  renderActivity();
  renderRetrospective();
  renderSpecifications();
  renderMetrics();
  renderProjectRoadmap();
  renderProjectHistory();
}
