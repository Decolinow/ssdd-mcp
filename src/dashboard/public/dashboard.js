/* global crypto, document, fetch, URL, URLSearchParams, window */
(() => {
  "use strict";

  const states = ["ready", "in_progress", "in_review", "in_validation", "done"];
  const stateLabels = {
    draft: "Rascunho",
    ready: "Ready",
    in_progress: "Em progresso",
    in_review: "Em revisão",
    in_validation: "Em validação",
    done: "Done",
    cancelled: "Cancelado",
    active: "Ativa",
    closed: "Fechada",
  };
  const typeLabels = { story: "História", bug: "Bug" };
  const typeMarks = { story: "H", bug: "B" };
  const transitions = {
    draft: ["ready", "cancelled"],
    ready: ["in_progress", "cancelled"],
    in_progress: ["in_review", "cancelled"],
    in_review: ["in_validation", "in_progress", "cancelled"],
    in_validation: ["done", "in_progress", "cancelled"],
    done: ["in_progress"],
    cancelled: [],
  };

  const elements = {
    projectSelect: document.querySelector("#project-select"),
    teamSelect: document.querySelector("#team-select"),
    principalName: document.querySelector("#principal-name"),
    lastUpdated: document.querySelector("#last-updated"),
    sprintSummary: document.querySelector("#sprint-summary"),
    filters: document.querySelector(".filters"),
    metricsTab: document.querySelector("#metrics-tab"),
    metricsView: document.querySelector("#metrics-view"),
    metricsMilestone: document.querySelector("#metrics-milestone"),
    metricsSprint: document.querySelector("#metrics-sprint"),
    metricsDate: document.querySelector("#metrics-date"),
    metricsToday: document.querySelector("#metrics-today"),
    metricsMeta: document.querySelector("#metrics-meta"),
    metricsError: document.querySelector("#metrics-error"),
    metricsContent: document.querySelector("#metrics-content"),
    backlogTab: document.querySelector("#backlog-tab"),
    boardTab: document.querySelector("#board-tab"),
    qualityTab: document.querySelector("#quality-tab"),
    activityTab: document.querySelector("#activity-tab"),
    retrospectiveTab: document.querySelector("#retrospective-tab"),
    backlogView: document.querySelector("#backlog-view"),
    boardView: document.querySelector("#board-view"),
    qualityView: document.querySelector("#quality-view"),
    activityView: document.querySelector("#activity-view"),
    retrospectiveView: document.querySelector("#retrospective-view"),
    board: document.querySelector("#board"),
    boardTitle: document.querySelector("#board-title"),
    boardDescription: document.querySelector("#board-description"),
    boardTabCount: document.querySelector("#board-tab-count"),
    qualityCount: document.querySelector("#quality-count"),
    qualityList: document.querySelector("#quality-list"),
    activityList: document.querySelector("#activity-list"),
    activityWatermark: document.querySelector("#activity-watermark"),
    loadMoreActivity: document.querySelector("#load-more-activity"),
    activityEntityType: document.querySelector("#activity-entity-type"),
    activityEntityId: document.querySelector("#activity-entity-id"),
    retrospectiveSprint: document.querySelector("#retrospective-sprint"),
    retrospectiveContent: document.querySelector("#retrospective-content"),
    applyActivityFilter: document.querySelector("#apply-activity-filter"),
    backlogCount: document.querySelector("#backlog-count"),
    boardCount: document.querySelector("#board-count"),
    backlogList: document.querySelector("#backlog-list"),
    search: document.querySelector("#search-input"),
    typeFilter: document.querySelector("#type-filter"),
    loading: document.querySelector("#loading-state"),
    error: document.querySelector("#error-state"),
    errorMessage: document.querySelector("#error-message"),
    retry: document.querySelector("#retry-button"),
    refresh: document.querySelector("#refresh-button"),
    toast: document.querySelector("#toast"),
    itemDialog: document.querySelector("#item-dialog"),
    itemKicker: document.querySelector("#item-kicker"),
    itemTitle: document.querySelector("#item-title"),
    itemDetails: document.querySelector("#item-details"),
    detailMove: document.querySelector("#detail-move-button"),
    transitionDialog: document.querySelector("#transition-dialog"),
    transitionForm: document.querySelector("#transition-form"),
    transitionItemLabel: document.querySelector("#transition-item-label"),
    targetState: document.querySelector("#target-state"),
    reason: document.querySelector("#transition-reason"),
    buildIdField: document.querySelector("#build-id-field"),
    buildId: document.querySelector("#build-id"),
    submitTransition: document.querySelector("#submit-transition"),
  };

  const model = {
    session: null,
    projects: [],
    projectId: null,
    teams: [],
    selectedTeamId: null,
    project: null,
    items: [],
    qualitySummaries: [],
    activityEvents: [],
    activityCursor: null,
    activityWatermark: 0,
    sprint: null,
    closedSprints: [],
    selectedRetrospectiveSprintId: null,
    retrospective: null,
    dashboardMetrics: null,
    selectedMetricsMilestoneId: null,
    selectedMetricsSprintId: null,
    selectedMetricsDate: null,
    metricsFiltersInitialized: false,
    metricsLoading: false,
    metricsRefreshPending: false,
    currentItem: null,
    currentQuality: null,
    pendingMove: null,
    draggedItemId: null,
    loading: false,
    projectReloadPending: false,
    toastTimer: null,
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/gu, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  function itemTypeLabel(type) {
    return typeLabels[type] ?? type;
  }

  function stateLabel(state) {
    return stateLabels[state] ?? state;
  }

  async function api(path, options = {}) {
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

  function toast(message, isError = false) {
    elements.toast.textContent = message;
    elements.toast.classList.toggle("is-error", isError);
    elements.toast.hidden = false;
    if (model.toastTimer !== null) window.clearTimeout(model.toastTimer);
    model.toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, isError ? 7_000 : 3_500);
  }

  function showError(error) {
    const detail = error?.details ? `\n${JSON.stringify(error.details, null, 2)}` : "";
    elements.errorMessage.textContent = `${error?.code ? `${error.code}: ` : ""}${error?.message ?? "Erro inesperado."}${detail}`;
    if (error?.code === "SESSION_REQUIRED") {
      elements.errorMessage.textContent += "\nA sessão local expirou. Reinicie `ssdd-mcp dashboard` e abra a nova URL de acesso impressa no terminal.";
    }
    elements.error.hidden = false;
    elements.loading.hidden = true;
    elements.backlogView.hidden = true;
    elements.boardView.hidden = true;
    elements.qualityView.hidden = true;
    elements.activityView.hidden = true;
    elements.retrospectiveView.hidden = true;
    elements.metricsView.hidden = true;
  }

  function showWorkspace() {
    elements.error.hidden = true;
    elements.loading.hidden = true;
    const selectedTab = document.querySelector('[role="tab"][aria-selected="true"]')?.id;
    elements.backlogView.hidden = selectedTab !== "backlog-tab";
    elements.boardView.hidden = selectedTab !== "board-tab";
    elements.qualityView.hidden = selectedTab !== "quality-tab";
    elements.activityView.hidden = selectedTab !== "activity-tab";
    elements.retrospectiveView.hidden = selectedTab !== "retrospective-tab";
    elements.metricsView.hidden = selectedTab !== "metrics-tab";
    elements.filters.hidden = selectedTab === "metrics-tab";
  }

  async function loadWorkItems(projectId) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const items = [];
      let cursor = null;
      try {
        do {
          const params = new URLSearchParams();
          params.append("type", "story");
          params.append("type", "bug");
          params.set("limit", "100");
          if (cursor) params.set("cursor", cursor);
          const page = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/work-items?${params}`);
          items.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);
        return items;
      } catch (error) {
        if (error.code !== "STALE_CURSOR" || attempt === 2) throw error;
      }
    }
    return [];
  }

  async function loadProjectData() {
    if (!model.projectId) return;
    if (model.loading) {
      model.projectReloadPending = true;
      return;
    }
    model.loading = true;
    elements.loading.hidden = model.items.length > 0;
    elements.error.hidden = true;
    try {
      const projectId = model.projectId;
      const teamResult = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/teams`);
      model.teams = teamResult.teams;
      if (!model.teams.some((team) => team.teamId === model.selectedTeamId)) {
        model.selectedTeamId = model.teams.length === 1 ? model.teams[0].teamId : null;
      }
      renderTeamSelect();
      const teamFilter = model.selectedTeamId ? `&teamId=${encodeURIComponent(model.selectedTeamId)}` : "";
      const activeSprints = model.selectedTeamId
        ? api(`/api/v1/projects/${encodeURIComponent(projectId)}/sprints?status=active&limit=10${teamFilter}`)
        : Promise.resolve({ sprints: [] });
      const closedSprints = model.selectedTeamId
        ? api(`/api/v1/projects/${encodeURIComponent(projectId)}/sprints?status=closed&limit=100${teamFilter}`)
        : Promise.resolve({ sprints: [] });
      const [projectResult, sprintResult, items, qualityResult, activityPage, closedSprintResult] = await Promise.all([
        api(`/api/v1/projects/${encodeURIComponent(projectId)}`),
        activeSprints,
        loadWorkItems(projectId),
        api(`/api/v1/projects/${encodeURIComponent(projectId)}/quality`),
        loadActivityFirstPage(projectId),
        closedSprints,
      ]);
      model.project = projectResult.project;
      model.sprint = sprintResult.sprints.length > 0
        ? (await api(`/api/v1/projects/${encodeURIComponent(projectId)}/sprints/${encodeURIComponent(sprintResult.sprints[0].id)}`)).sprint
        : null;
      model.items = items;
      model.qualitySummaries = qualityResult.items;
      model.activityEvents = activityPage.events;
      model.activityCursor = activityPage.nextCursor;
      model.activityWatermark = activityPage.watermark;
      model.closedSprints = closedSprintResult.sprints;
      if (!model.closedSprints.some((sprint) => sprint.id === model.selectedRetrospectiveSprintId)) {
        model.selectedRetrospectiveSprintId = model.closedSprints[0]?.id ?? null;
      }
      model.retrospective = model.selectedRetrospectiveSprintId === null
        ? null
        : (await api(`/api/v1/projects/${encodeURIComponent(projectId)}/sprints/${encodeURIComponent(model.selectedRetrospectiveSprintId)}/retrospective`)).retrospective;
      render();
      elements.lastUpdated.textContent = `Atualizado às ${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date())}`;
      showWorkspace();
    } catch (error) {
      showError(error);
    } finally {
      model.loading = false;
      if (model.projectReloadPending) {
        model.projectReloadPending = false;
        void loadProjectData();
      } else if (document.querySelector('[role="tab"][aria-selected="true"]')?.id === "metrics-tab") {
        void loadDashboardMetrics();
      }
    }
  }

  function renderTeamSelect() {
    const placeholder = model.teams.length > 1
      ? `<option value="">Selecione um time</option>`
      : model.teams.length === 0 ? `<option value="">Nenhum time configurado</option>` : "";
    elements.teamSelect.innerHTML = `${placeholder}${model.teams.map((team) => {
      const label = team.name ?? `Time ${team.teamId.slice(0, 8)}`;
      const state = team.isConfigured ? "" : " · sem configuração";
      return `<option value="${escapeHtml(team.teamId)}">${escapeHtml(label)}${state}</option>`;
    }).join("")}`;
    elements.teamSelect.value = model.selectedTeamId ?? "";
    elements.teamSelect.disabled = model.teams.length === 0;
  }

  async function loadDashboardMetrics() {
    if (!model.projectId) return;
    if (model.metricsLoading) {
      model.metricsRefreshPending = true;
      return;
    }
    model.metricsLoading = true;
    elements.metricsError.hidden = true;
    if (model.teams.length > 1 && model.selectedTeamId === null) {
      elements.metricsMeta.textContent = "Selecione um time para consultar sprints, velocidade e previsão.";
      elements.metricsContent.innerHTML = "";
      model.metricsLoading = false;
      return;
    }
    elements.metricsMeta.textContent = "Atualizando métricas…";
    const projectId = model.projectId;
    const teamId = model.selectedTeamId;
    try {
      const params = new URLSearchParams();
      if (model.selectedTeamId) params.set("teamId", model.selectedTeamId);
      if (model.metricsFiltersInitialized) {
        params.set("milestoneId", model.selectedMetricsMilestoneId ?? "none");
        params.set("sprintId", model.selectedMetricsSprintId ?? "none");
      }
      if (model.selectedMetricsDate) params.set("asOfDate", model.selectedMetricsDate);
      const suffix = params.size ? `?${params}` : "";
      const result = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/dashboard-metrics${suffix}`);
      if (projectId !== model.projectId || teamId !== model.selectedTeamId) {
        model.metricsRefreshPending = true;
        return;
      }
      model.dashboardMetrics = result;
      if (!model.metricsFiltersInitialized) {
        model.selectedMetricsMilestoneId = result.selectedMilestoneId ?? "none";
        model.selectedMetricsSprintId = result.selectedSprintId ?? "none";
        model.metricsFiltersInitialized = true;
      }
      renderMetrics();
    } catch (error) {
      elements.metricsError.textContent = `${error.code ?? "Erro"}: ${error.message}`;
      elements.metricsError.hidden = false;
      elements.metricsMeta.textContent = "As métricas não puderam ser atualizadas.";
    } finally {
      model.metricsLoading = false;
      if (model.metricsRefreshPending) {
        model.metricsRefreshPending = false;
        void loadDashboardMetrics();
      }
    }
  }

  async function initialize() {
    const query = new URLSearchParams(window.location.search);
    if (query.has("token")) {
      query.delete("token");
      const cleanLocation = `${window.location.pathname}${query.size ? `?${query}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", cleanLocation);
    }
    try {
      model.session = await api("/api/v1/session");
      model.projects = model.session.projects;
      elements.principalName.textContent = model.session.principal.displayName;
      elements.projectSelect.innerHTML = model.projects.map((project) =>
        `<option value="${escapeHtml(project.id)}">${escapeHtml(project.key)} · ${escapeHtml(project.name)}</option>`).join("");
      if (model.projects.length === 0) {
        elements.loading.innerHTML = "<strong>Nenhum projeto disponível para este principal.</strong><p>Associe o principal local a um projeto para continuar.</p>";
        return;
      }
      model.projectId = model.projects[0].id;
      await loadProjectData();
      window.setInterval(() => { void loadProjectData(); }, 30_000);
    } catch (error) {
      showError(error);
    }
  }

  function filteredItems(items) {
    const text = elements.search.value.trim().toLocaleLowerCase("pt-BR");
    const type = elements.typeFilter.value;
    return items.filter((item) => {
      if (type !== "all" && item.type !== type) return false;
      if (!text) return true;
      return `${item.key} ${item.title}`.toLocaleLowerCase("pt-BR").includes(text);
    });
  }

  function filteredQualitySummaries() {
    const text = elements.search.value.trim().toLocaleLowerCase("pt-BR");
    const type = elements.typeFilter.value;
    return model.qualitySummaries.filter((item) => {
      if (type !== "all" && item.type !== type) return false;
      if (!text) return true;
      return `${item.itemKey} ${item.title}`.toLocaleLowerCase("pt-BR").includes(text);
    });
  }

  function activeScopeIds() {
    return new Set(model.sprint?.scope.map((item) => item.itemId) ?? []);
  }

  function visibleBoardItems() {
    const scope = activeScopeIds();
    return filteredItems(model.items).filter((item) => states.includes(item.state) && (model.sprint === null || scope.has(item.id)));
  }

  function backlogItems() {
    const scope = activeScopeIds();
    return filteredItems(model.items).filter((item) => model.sprint === null || !scope.has(item.id));
  }

  function render() {
    renderSprintSummary();
    renderBacklog();
    renderBoard();
    renderQuality();
    renderActivity();
    renderRetrospective();
    renderMetrics();
  }

  function renderSprintSummary() {
    if (!model.sprint) {
      elements.sprintSummary.hidden = true;
      elements.boardTitle.textContent = "Fluxo de trabalho";
      elements.boardDescription.textContent = "Arraste um card ou use “Mover item” pelo teclado. Toda mudança exige motivo e passa pelas regras do projeto.";
      return;
    }
    const scope = model.sprint.scope ?? [];
    const capacity = model.sprint.startedSnapshot?.capacity;
    const points = scope.reduce((total, item) => total + item.points, 0);
    elements.sprintSummary.innerHTML = `
      <div class="sprint-copy"><p class="eyebrow">SPRINT ATIVA · ${escapeHtml(model.sprint.key)}</p><h2>${escapeHtml(model.sprint.title)}</h2><p>${escapeHtml(model.sprint.goal)} · ${escapeHtml(model.sprint.startsOn)}–${escapeHtml(model.sprint.endsOn)}</p></div>
      <div class="sprint-metrics"><span class="metric"><strong>${scope.length}</strong><span>PBIs comprometidos</span></span><span class="metric"><strong>${points} pts</strong><span>Escopo atual</span></span><span class="metric"><strong>${capacity ? `${capacity.totalHours} h` : "—"}</strong><span>Capacidade inicial</span></span><span class="status-pill">Em andamento</span></div>`;
    elements.sprintSummary.hidden = false;
    elements.boardTitle.textContent = `Board · ${model.sprint.key}`;
    const outside = model.items.length - scope.length;
    elements.boardDescription.textContent = `${outside} ${outside === 1 ? "item fora" : "itens fora"} da sprint ficam no Product Backlog. Movimentos passam pelos gates do projeto.`;
  }

  function renderBacklog() {
    const items = backlogItems();
    elements.backlogCount.textContent = `${items.length} ${items.length === 1 ? "item" : "itens"}`;
    if (!items.length) {
      elements.backlogList.innerHTML = `<div class="empty-state"><strong>${model.items.length ? "Nenhum item encontrado." : "O Product Backlog está vazio."}</strong><p>${model.items.length ? "Ajuste os filtros de busca ou tipo." : "Crie histórias e bugs pelo fluxo de especificação no MCP."}</p></div>`;
      return;
    }
    elements.backlogList.innerHTML = items.map((item) => `
      <article class="backlog-row">
        <div class="row-key"><span class="type-mark ${escapeHtml(item.type)}">${escapeHtml(typeMarks[item.type] ?? "·")}</span>${escapeHtml(item.key)}</div>
        <div class="row-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <span class="state-badge ${escapeHtml(item.state)}">${escapeHtml(stateLabel(item.state))}</span>
        <span class="row-meta">Prioridade ${escapeHtml(item.priority)}</span>
        <span class="row-meta revision-meta">v${escapeHtml(item.version)} · r${escapeHtml(item.revision)}</span>
        <button class="row-open" type="button" data-open-item="${escapeHtml(item.id)}" aria-label="Abrir ${escapeHtml(item.key)}">›</button>
      </article>`).join("");
  }

  function renderBoard() {
    const items = visibleBoardItems();
    elements.boardCount.textContent = `${items.length} ${items.length === 1 ? "item" : "itens"}`;
    elements.boardTabCount.textContent = String(items.length);
    elements.board.innerHTML = states.map((state) => {
      const columnItems = items.filter((item) => item.state === state);
      return `<section class="board-column" data-state="${state}" aria-label="${escapeHtml(stateLabel(state))}">
        <div class="column-heading"><h3><span class="column-dot" aria-hidden="true"></span>${escapeHtml(stateLabel(state))}</h3><span class="column-count">${columnItems.length}</span></div>
        <div class="column-cards" data-drop-state="${state}">${columnItems.length ? columnItems.map(renderCard).join("") : `<div class="empty-lane">Solte um item aqui</div>`}</div>
      </section>`;
    }).join("");
  }

  function renderQuality() {
    const items = filteredQualitySummaries();
    elements.qualityCount.textContent = `${items.length} ${items.length === 1 ? "PBI" : "PBIs"}`;
    if (!items.length) {
      elements.qualityList.innerHTML = `<div class="empty-state"><strong>${model.qualitySummaries.length ? "Nenhum item encontrado." : "Ainda não há PBIs para analisar."}</strong><p>${model.qualitySummaries.length ? "Ajuste os filtros de busca ou tipo." : "Histórias e bugs aparecem nesta visão após serem criados."}</p></div>`;
      return;
    }
    elements.qualityList.innerHTML = items.map((item) => {
      const percent = item.coveragePercent;
      const ratio = percent === null ? "Sem critério obrigatório" : `${item.coveredRequiredCriteria}/${item.requiredCriteria} critérios obrigatórios · ${percent}%`;
      const baselineLabel = item.baselineSequence === null ? "Preview · sem baseline" : `Baseline ${item.baselineSequence}`;
      const coverageClass = percent === null ? "coverage-unknown" : `coverage-${Math.floor(percent / 10) * 10}`;
      const statusClass = percent === 100 ? "is-current" : item.baselineSequence === null ? "is-missing" : "";
      return `<article class="quality-row">
        <div class="row-key quality-key"><span class="type-mark ${escapeHtml(item.type)}">${escapeHtml(typeMarks[item.type] ?? "·")}</span>${escapeHtml(item.itemKey)}</div>
        <div class="quality-row-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="quality-ratio">${escapeHtml(ratio)}<div class="quality-meter ${coverageClass} ${item.baselineSequence === null ? "is-preview" : ""}" aria-hidden="true"><span></span></div></div>
        <span class="quality-state ${statusClass}">${escapeHtml(baselineLabel)} · ${escapeHtml(stateLabel(item.state))}</span>
        <span class="row-meta quality-version-meta">v${escapeHtml(item.version)}</span>
        <button class="row-open" type="button" data-open-item="${escapeHtml(item.itemId)}" aria-label="Abrir qualidade de ${escapeHtml(item.itemKey)}">›</button>
      </article>`;
    }).join("");
  }

  function eventTitle(event) {
    const titles = {
      "project.initialized": "Projeto inicializado",
      "work_item.created": "PBI criado",
      "work_item.state_transitioned": "Estado do PBI alterado",
      "work_item.evidence_added": "Evidência adicionada",
      "test_run.recorded": "Execução de cenário registrada",
      "test_run.certified": "Execução certificada por QA",
      "work_item.revision.published": "Conteúdo do PBI publicado",
      "work_item.baseline.revalidated": "Baseline revalidada",
    };
    return titles[event.eventType] ?? event.eventType;
  }

  function eventDetail(event) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    if (payload.fromState || payload.toState) {
      const version = payload.itemVersion ? ` · v${payload.itemVersion}` : "";
      const transitionId = payload.transitionId ? ` · transição ${String(payload.transitionId).slice(0, 8)}` : "";
      return `${stateLabel(payload.fromState ?? "")} → ${stateLabel(payload.toState ?? "")}${version}${transitionId}`;
    }
    if (payload.buildId) return `Build ${payload.buildId}`;
    if (payload.kind) return String(payload.kind);
    return event.entityType;
  }

  function renderActivityEvent(event, isTimeline = false) {
    const openItemButton = event.entityType === "work_item"
      ? `<button class="event-entity" type="button" data-open-item="${escapeHtml(event.entityId)}">${escapeHtml(event.entityId)}</button>`
      : `<span class="event-entity">${escapeHtml(event.entityType)}</span>`;
    const reason = event.reason ? escapeHtml(event.reason) : escapeHtml(eventDetail(event));
    return `<article class="${isTimeline ? "timeline-event" : "activity-event"}">
      <span class="event-time">${escapeHtml(formatDate(event.occurredAt))} · #${escapeHtml(event.sequence)}</span>
      <p class="event-title">${escapeHtml(eventTitle(event))} · ${escapeHtml(eventDetail(event))}</p>
      <span class="event-actor">${escapeHtml(event.principalName)}</span>
      <span class="event-reason">${reason}</span>
      ${isTimeline ? "" : openItemButton}
    </article>`;
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
  }

  function renderActivity() {
    elements.activityWatermark.textContent = `Watermark ${model.activityWatermark}`;
    elements.loadMoreActivity.hidden = !model.activityCursor;
    if (!model.activityEvents.length) {
      elements.activityList.innerHTML = `<div class="empty-state"><strong>Nenhuma atividade registrada.</strong><p>As mudanças auditadas do projeto aparecerão aqui.</p></div>`;
      return;
    }
    elements.activityList.innerHTML = model.activityEvents.map((event) => renderActivityEvent(event)).join("");
  }

  function renderRetrospective() {
    elements.retrospectiveSprint.innerHTML = model.closedSprints.map((sprint) =>
      `<option value="${escapeHtml(sprint.id)}">${escapeHtml(sprint.key)} · ${escapeHtml(sprint.title)}</option>`).join("");
    elements.retrospectiveSprint.disabled = model.closedSprints.length === 0;
    elements.retrospectiveSprint.value = model.selectedRetrospectiveSprintId ?? "";
    if (model.closedSprints.length === 0) {
      elements.retrospectiveContent.innerHTML = `<div class="empty-state"><strong>Nenhuma sprint fechada.</strong><p>A retrospectiva aparece aqui depois que uma sprint for encerrada.</p></div>`;
      return;
    }
    const report = model.retrospective;
    if (!report?.retrospective) {
      elements.retrospectiveContent.innerHTML = `<div class="empty-state"><strong>Retrospectiva ainda não registrada.</strong><p>Use a ferramenta <code>sprint_retrospective_set</code> no MCP para salvar os aprendizados e ações desta sprint.</p></div>`;
      return;
    }
    const retrospective = report.retrospective;
    const revisionOptions = report.history.map((entry) =>
      `<option value="${entry.revisionNumber}" ${entry.revisionNumber === report.selectedRevisionNumber ? "selected" : ""}>Revisão ${entry.revisionNumber} · ${escapeHtml(new Date(entry.createdAt).toLocaleDateString("pt-BR"))}</option>`).join("");
    const renderList = (title, entries) => `<section class="retro-section"><h3>${title}</h3>${entries.length ? `<ul>${entries.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul>` : `<p class="retro-empty">Nenhum item registrado.</p>`}</section>`;
    const actions = retrospective.actions.length
      ? `<div class="retro-actions">${retrospective.actions.map((action) => `<article class="retro-action"><div><strong>${escapeHtml(action.title)}</strong><span>Responsável: ${escapeHtml(action.ownerDisplayName)}</span></div>${action.linkedWorkItemKey ? `<a class="retro-pbi" href="#" data-open-item="${escapeHtml(action.linkedWorkItemId)}">${escapeHtml(action.linkedWorkItemKey)} · ${escapeHtml(action.linkedWorkItemTitle)}</a>` : `<span class="retro-pbi is-unlinked">Sem PBI vinculado</span>`}</article>`).join("")}</div>`
      : `<p class="retro-empty">Nenhuma ação acompanhável registrada.</p>`;
    const history = report.history.map((entry) => `<article class="retro-history-row"><strong>Revisão ${entry.revisionNumber}</strong><span>${escapeHtml(entry.summary)}</span><small>${escapeHtml(new Date(entry.createdAt).toLocaleString("pt-BR"))} · ${escapeHtml(entry.reason)}</small></article>`).join("");
    elements.retrospectiveContent.innerHTML = `
      <div class="retro-toolbar"><label for="retrospective-revision">Histórico de revisões<select id="retrospective-revision">${revisionOptions}</select></label><span class="count-label">Versão ${report.version}</span></div>
      <article class="retro-card"><div class="retro-card-heading"><div><p class="eyebrow">${escapeHtml(report.sprint.key)} · FECHADA</p><h3>${escapeHtml(report.sprint.title)}</h3></div><span class="count-label">Revisão ${retrospective.revisionNumber}</span></div><p class="retro-summary">${escapeHtml(retrospective.summary)}</p>
        <div class="retro-learning-grid">${renderList("Continuar", retrospective.keepDoing)}${renderList("Interromper", retrospective.stopDoing)}${renderList("Experimentar", retrospective.tryNext)}</div>
        <section class="retro-section"><h3>Ações acordadas</h3>${actions}</section>
        <p class="retro-meta">Registrada em ${escapeHtml(new Date(retrospective.createdAt).toLocaleString("pt-BR"))} · ${escapeHtml(retrospective.reason)}</p>
      </article>
      <section class="retro-history"><h3>Histórico imutável</h3>${history}</section>`;
  }

  function metricNumber(value) {
    return value === null || value === undefined
      ? "—"
      : new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(value);
  }

  function metricDate(value) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeZone: "UTC" })
      .format(new Date(`${value}T12:00:00.000Z`));
  }

  function metricStatusLabel(status) {
    return ({
      complete: "Concluído",
      incomplete_scope: "Escopo incompleto",
      blocked: "Bloqueado",
      insufficient_data: "Dados insuficientes",
      forecast_ready: "Previsão disponível",
      zero_velocity: "Velocidade zero",
      no_capacity: "Sem capacidade",
      horizon_exceeded: "Além do horizonte",
    })[status] ?? status;
  }

  function renderMetricChart(series, lines, label) {
    if (!series?.length) {
      return `<div class="metrics-empty-chart">${escapeHtml(label)} ainda não tem série para este corte.</div>`;
    }
    const points = series.slice(-90);
    const width = 720;
    const height = 232;
    const left = 48;
    const right = 18;
    const top = 18;
    const bottom = 36;
    const values = points.flatMap((point) => lines.map((line) => point[line.key]))
      .filter((value) => Number.isFinite(value));
    const maximum = Math.max(1, ...values);
    const x = (index) => points.length === 1
      ? (width + left - right) / 2
      : left + index * (width - left - right) / (points.length - 1);
    const y = (value) => height - bottom - (value / maximum) * (height - top - bottom);
    const grid = [0, 1, 2, 3].map((division) => {
      const value = maximum * division / 3;
      const coordinate = y(value);
      return `<line class="chart-grid" x1="${left}" y1="${coordinate}" x2="${width - right}" y2="${coordinate}"></line><text class="chart-axis-label" x="${left - 8}" y="${coordinate + 4}" text-anchor="end">${escapeHtml(metricNumber(value))}</text>`;
    }).join("");
    const lineMarkup = lines.map((line) => {
      const coordinates = points.flatMap((point, index) => {
        const value = point[line.key];
        return Number.isFinite(value) ? [{ date: point.date, value, x: x(index), y: y(value) }] : [];
      });
      const path = coordinates.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
      const dots = coordinates.map((point) => `<circle class="chart-dot ${line.className} ${point.date === model.selectedMetricsDate ? "is-selected" : ""}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3.5" role="button" tabindex="0" data-metric-date="${escapeHtml(point.date)}" aria-label="${escapeHtml(line.label)} ${escapeHtml(metricNumber(point.value))} pontos em ${escapeHtml(point.date)}"><title>${escapeHtml(point.date)} · ${escapeHtml(line.label)} ${escapeHtml(metricNumber(point.value))} pts</title></circle>`).join("");
      return `<path class="chart-line ${line.className}" d="${path}"></path>${dots}`;
    }).join("");
    const firstDate = escapeHtml(points[0].date);
    const lastDate = escapeHtml(points.at(-1).date);
    const legend = lines.map((line) => `<span><i class="chart-legend-dot ${line.className}"></i>${escapeHtml(line.label)}</span>`).join("");
    return `<div class="chart-legend">${legend}</div><svg class="metrics-chart" viewBox="0 0 ${width} ${height}" role="group" aria-label="${escapeHtml(label)}; selecione um ponto para abrir a composição daquele dia"><title>${escapeHtml(label)}</title>${grid}${lineMarkup}<text class="chart-axis-label" x="${left}" y="${height - 10}">${firstDate}</text><text class="chart-axis-label" x="${width - right}" y="${height - 10}" text-anchor="end">${lastDate}</text></svg><p class="chart-hint">Selecione um ponto para ver os PBIs que compõem a série naquele dia.</p>`;
  }

  function summarizeScopeItems(items) {
    return items.reduce((total, item) => {
      total.scopePoints += item.points;
      if (item.state === "done") total.completedPoints += item.points;
      else if (item.state === "cancelled") total.cancelledPoints += item.points;
      else total.remainingPoints += item.points;
      return total;
    }, { scopePoints: 0, remainingPoints: 0, completedPoints: 0, cancelledPoints: 0 });
  }

  function renderScopeBreakdown(title, series, items, date, type) {
    const point = type === "sprint" ? series.at(-1) : series.find((entry) => entry.date === date);
    if (!point) return `<div class="metrics-empty-chart">Selecione uma data com dados para abrir a composição.</div>`;
    const totals = summarizeScopeItems(items);
    const reconciles = ["scopePoints", "remainingPoints", "completedPoints", "cancelledPoints"]
      .every((key) => Math.abs(totals[key] - point[key]) < 0.01);
    const rows = [...items].sort((left, right) => left.itemKey.localeCompare(right.itemKey, "pt-BR")).map((item) => `
      <tr><td><button class="metric-item-link" type="button" data-open-item="${escapeHtml(item.itemId)}">${escapeHtml(item.itemKey)}</button><span>${escapeHtml(item.title)}</span></td><td>${escapeHtml(stateLabel(item.state))}</td><td>${escapeHtml(metricNumber(item.points))} pts</td></tr>`).join("");
    return `<div class="breakdown-heading"><div><h4>${escapeHtml(title)} · ${escapeHtml(metricDate(point.date))}</h4><p>Os PBIs abaixo reproduzem os totais mostrados na série.</p></div><span class="reconcile-badge ${reconciles ? "is-valid" : "is-invalid"}">${reconciles ? "Série reconciliada" : "Revisar composição"}</span></div>
      <div class="breakdown-totals"><span>Escopo <strong>${escapeHtml(metricNumber(totals.scopePoints))} pts</strong></span><span>Restante <strong>${escapeHtml(metricNumber(totals.remainingPoints))} pts</strong></span><span>Concluído <strong>${escapeHtml(metricNumber(totals.completedPoints))} pts</strong></span><span>Cancelado <strong>${escapeHtml(metricNumber(totals.cancelledPoints))} pts</strong></span></div>
      ${rows ? `<div class="metric-table-wrap"><table class="metric-table"><thead><tr><th>PBI</th><th>Estado no corte</th><th>Pontos</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="metrics-empty-chart">Nenhum PBI ativo no escopo nesse corte.</div>`}`;
  }

  function renderForecastPanel(forecast) {
    if (!forecast) {
      if (model.dashboardMetrics?.forecastUnavailableReason === "before_milestone_created") {
        return `<div class="metrics-empty-chart">O marco ainda não existia no corte selecionado.</div>`;
      }
      return `<div class="metrics-empty-chart">Crie um marco com escopo aprovado para acompanhar previsão de entrega.</div>`;
    }
    const scenarios = forecast.scenarios.map((scenario) => `
      <article class="forecast-scenario ${scenario.key}"><div class="forecast-scenario-heading"><strong>${({ cautious: "Cauteloso · P75", base: "Base · P50", favorable: "Favorável · P25" })[scenario.key]}</strong><span class="forecast-state">${escapeHtml(metricStatusLabel(scenario.status))}</span></div><strong class="forecast-date">${escapeHtml(metricDate(scenario.estimatedDate))}</strong><div class="forecast-facts"><span>${scenario.workingDaysToComplete === null ? "Sem data no horizonte" : `${scenario.workingDaysToComplete} dias úteis`}</span><span>${scenario.onTime === null ? "Meta sem comparação" : scenario.onTime ? "Faixa até a meta" : "Faixa após a meta"}</span></div></article>`).join("");
    const blockers = forecast.blockers.map((blocker) => `<li><strong>${escapeHtml(blocker.itemKey)}</strong> · ${blocker.kind === "external_dependency" ? `aguarda ${escapeHtml(blocker.dependencyItemKey)} (${escapeHtml(stateLabel(blocker.dependencyState))})` : `impacto aberto em ${escapeHtml(blocker.specificationKey)} r${escapeHtml(blocker.publishedRevision)}`}</li>`).join("");
    const risks = forecast.risks.map((risk) => `<li>${escapeHtml(risk.itemKey)} depende de ${escapeHtml(risk.dependencyItemKey)} (${escapeHtml(stateLabel(risk.dependencyState))})</li>`).join("");
    const capacity = forecast.capacityBases.map((basis) => `<li>${escapeHtml(metricDate(basis.startDate))}–${escapeHtml(metricDate(basis.endDate))}: ${basis.source === "active_sprint_snapshot" ? "capacidade congelada" : basis.source === "planned_sprint_configuration" ? `plano ${escapeHtml(basis.sprintKey)}` : "hipótese da configuração atual"}</li>`).join("");
    const targetChance = forecast.probabilityOnTime === null
      ? forecast.targetDateWithinHorizon ? "Chance indisponível" : "Meta além do horizonte"
      : `${(forecast.probabilityOnTime * 100).toFixed(1)}% de chance até a meta`;
    return `<div class="forecast-toolbar"><span class="status-pill">${escapeHtml(metricStatusLabel(forecast.status))}</span><span>${forecast.sample.length}/${forecast.minimumSampleSize} sprints comparáveis · geração ${forecast.teamGenerationNumber ?? "—"}</span><span>${forecast.simulationCount.toLocaleString("pt-BR")} simulações · seed ${forecast.seed}</span><span>${escapeHtml(targetChance)}</span><span>Meta ${escapeHtml(metricDate(forecast.targetDate))}</span></div>
      <div class="forecast-grid">${scenarios}</div>
      <div class="forecast-explanations"><section><h4>Bloqueios</h4>${blockers ? `<ul>${blockers}</ul>` : `<p>Nenhum bloqueio externo ou impacto aberto.</p>`}</section><section><h4>Riscos internos</h4>${risks ? `<ul>${risks}</ul>` : `<p>Nenhuma dependência interna aberta.</p>`}</section><section><h4>Premissas de capacidade</h4>${capacity ? `<ul>${capacity}</ul>` : `<p>Capacidade indisponível no horizonte.</p>`}</section></div>`;
  }

  function renderMetrics() {
    const data = model.dashboardMetrics;
    if (!data) return;
    elements.metricsMilestone.innerHTML = `<option value="none">Sem marco</option>${data.milestones.map((milestone) => `<option value="${escapeHtml(milestone.id)}">${escapeHtml(milestone.key)} · ${escapeHtml(milestone.title)}</option>`).join("")}`;
    elements.metricsSprint.innerHTML = `<option value="none">Sem sprint</option>${data.sprints.map((sprint) => `<option value="${escapeHtml(sprint.id)}">${escapeHtml(sprint.key)} · ${escapeHtml(stateLabel(sprint.status))}</option>`).join("")}`;
    elements.metricsMilestone.value = model.selectedMetricsMilestoneId ?? data.selectedMilestoneId ?? "none";
    elements.metricsSprint.value = model.selectedMetricsSprintId ?? data.selectedSprintId ?? "none";
    elements.metricsDate.value = model.selectedMetricsDate ?? "";
    elements.metricsMeta.textContent = `Corte ${metricDate(data.asOfDate)} · watermark ${data.watermarkSequence} · atualizado ${formatDate(data.observedAt)}`;
    elements.metricsError.hidden = true;

    const burnup = data.milestoneMetrics;
    const burnupPoint = burnup?.series.find((point) => point.date === data.asOfDate) ?? burnup?.series.at(-1);
    const milestoneItems = burnup?.items ?? [];
    const scopeSummary = summarizeScopeItems(milestoneItems);
    const forecastBase = data.forecast?.scenarios.find((scenario) => scenario.key === "base");
    const coverage = data.coverage;
    const kpis = `
      <article class="metric-kpi"><span>Escopo do marco</span><strong>${burnup ? `${escapeHtml(metricNumber(scopeSummary.scopePoints))} pts` : "—"}</strong><small>${milestoneItems.length} PBIs · ${escapeHtml(metricNumber(scopeSummary.completedPoints))} pts concluídos</small></article>
      <article class="metric-kpi"><span>Restante estimado</span><strong>${burnup ? `${escapeHtml(metricNumber(scopeSummary.remainingPoints))} pts` : "—"}</strong><small>${milestoneItems.filter((item) => !["done", "cancelled"].includes(item.state)).length} PBIs abertos no corte</small></article>
      <article class="metric-kpi"><span>Previsão base · P50</span><strong>${escapeHtml(metricDate(forecastBase?.estimatedDate))}</strong><small>${escapeHtml(metricStatusLabel(forecastBase?.status ?? data.forecast?.status ?? "insufficient_data"))}${data.forecast ? ` · ${data.forecast.sample.length} sprints na amostra` : ""}</small></article>
      <article class="metric-kpi"><span>WIP atual</span><strong>${data.wip.totalWipCount}</strong><small>${data.wip.blockedByOpenImpactCount} com impacto aberto · watermark ${data.wip.watermarkSequence}</small></article>
      <article class="metric-kpi"><span>Cobertura certificada</span><strong>${coverage.certifiedCoveragePercent === null ? "—" : `${coverage.certifiedCoveragePercent}%`}</strong><small>${coverage.certifiedRequiredCriteria}/${coverage.requiredCriteria} critérios · build: todos</small></article>`;
    const velocityRows = data.velocity.sprints.slice(-8).reverse().map((sprint) => `<tr><td>${escapeHtml(sprint.sprintKey)}</td><td>${escapeHtml(metricDate(sprint.closedAt.slice(0, 10)))}</td><td>${escapeHtml(metricNumber(sprint.deliveredPoints))} pts</td><td>${escapeHtml(metricNumber(sprint.capacityHours))} h</td><td>${escapeHtml(metricNumber(sprint.pointsPerHour))} pts/h</td></tr>`).join("");
    const wipRows = data.wip.items.slice(0, 20).map((item) => `<tr><td><button class="metric-item-link" type="button" data-open-item="${escapeHtml(item.itemId)}">${escapeHtml(item.itemKey)}</button><span>${escapeHtml(item.title)}</span></td><td>${escapeHtml(stateLabel(item.state))}</td><td>${item.ageDays} dias</td><td>${item.openImpactCount ? `<span class="blocker-pill">${item.openImpactCount} impacto(s)</span>` : "—"}</td></tr>`).join("");
    const coverageRows = coverage.items.slice(0, 20).map((item) => `<tr><td><button class="metric-item-link" type="button" data-open-item="${escapeHtml(item.itemId)}">${escapeHtml(item.itemKey)}</button><span>${escapeHtml(item.title)}</span></td><td>${item.coveredRequiredCriteria}/${item.requiredCriteria}</td><td>${item.certifiedRequiredCriteria}/${item.requiredCriteria}</td><td>${item.hasOpenImpact ? `<span class="blocker-pill">Impacto</span>` : "—"}</td></tr>`).join("");
    elements.metricsContent.innerHTML = `
      <div class="metric-kpi-grid">${kpis}</div>
      <div class="metrics-grid">
        <article class="metrics-panel"><div class="metrics-panel-heading"><div><p class="eyebrow">EXECUTIVO</p><h3>${burnup ? `${escapeHtml(burnup.milestoneKey)} · ${escapeHtml(data.milestones.find((entry) => entry.id === burnup.milestoneId)?.title ?? "Marco")}` : "Burnup do marco"}</h3><p>Pontos no escopo, entregues e restantes. Pontos representam estimativa relativa.</p></div><span class="unit-tag">pontos</span></div>${renderMetricChart(burnup?.series, [{ key: "scopePoints", label: "Escopo", className: "scope" }, { key: "completedPoints", label: "Concluído", className: "completed" }, { key: "remainingPoints", label: "Restante", className: "remaining" }], "Burnup do marco")}</article>
        <article class="metrics-panel"><div class="metrics-panel-heading"><div><p class="eyebrow">EXECUTIVO</p><h3>${data.sprintMetrics ? `${escapeHtml(data.sprintMetrics.sprintKey)} · Burndown` : "Burndown da sprint"}</h3><p>Restante real e linha ideal a partir do escopo congelado no início.</p></div><span class="unit-tag">pontos</span></div>${renderMetricChart(data.sprintMetrics?.series, [{ key: "remainingPoints", label: "Restante", className: "remaining" }, { key: "idealRemainingPoints", label: "Ideal", className: "ideal" }], "Burndown da sprint")}</article>
        <article class="metrics-panel metrics-panel-wide"><div class="metrics-panel-heading"><div><p class="eyebrow">EXECUTIVO</p><h3>Previsão Monte Carlo</h3><p>Distribuição empírica de sprints comparáveis, com capacidade futura e chance até a meta. Story points não são convertidos em horas.</p></div><span class="unit-tag">${data.forecast?.remainingPoints === undefined ? "sem marco" : `${escapeHtml(metricNumber(data.forecast.remainingPoints))} pts restantes`}</span></div>${renderForecastPanel(data.forecast)}</article>
        <article class="metrics-panel metrics-panel-wide"><div class="metrics-panel-heading"><div><p class="eyebrow">DRILL-DOWN · MARCO</p><h3>Composição do burnup</h3><p>Totais reconstruídos a partir dos PBIs ativos no corte selecionado.</p></div><span class="unit-tag">${burnupPoint ? escapeHtml(metricDate(burnupPoint.date)) : "sem série"}</span></div>${renderScopeBreakdown("Escopo aprovado", burnup?.series ?? [], milestoneItems, data.asOfDate, "milestone")}</article>
        <article class="metrics-panel metrics-panel-wide"><div class="metrics-panel-heading"><div><p class="eyebrow">DRILL-DOWN · SPRINT</p><h3>Itens do burndown</h3><p>O estado e os pontos correspondem ao último dia da série exibida.</p></div><span class="unit-tag">${data.sprintMetrics?.series.length ? escapeHtml(metricDate(data.sprintMetrics.series.at(-1).date)) : "sem série"}</span></div>${renderScopeBreakdown("Escopo da sprint", data.sprintMetrics?.series ?? [], data.sprintMetrics?.items ?? [], data.asOfDate, "sprint")}</article>
        <article class="metrics-panel"><div class="metrics-panel-heading"><div><p class="eyebrow">TÉCNICO</p><h3>WIP e bloqueios</h3><p>Idade desde a entrada no estado; bloqueios por impacto de especificação.</p></div><span class="unit-tag">${data.wip.totalWipCount} itens</span></div><div class="metric-table-wrap"><table class="metric-table"><thead><tr><th>Item</th><th>Estado</th><th>Idade</th><th>Bloqueio</th></tr></thead><tbody>${wipRows || `<tr><td colspan="4">Nenhum item em andamento.</td></tr>`}</tbody></table></div>${data.wip.itemsTruncated ? `<p class="table-note">Lista limitada a ${data.wip.items.length} itens; o total considera todo o projeto.</p>` : ""}</article>
        <article class="metrics-panel"><div class="metrics-panel-heading"><div><p class="eyebrow">TÉCNICO</p><h3>Cobertura de critérios</h3><p>Critérios cobertos e certificações aprovadas por build.</p></div><span class="unit-tag">${coverage.coveragePercent === null ? "—" : `${coverage.coveragePercent}%`}</span></div><div class="metric-table-wrap"><table class="metric-table"><thead><tr><th>PBI</th><th>Cobertos</th><th>Certificados</th><th>Impacto</th></tr></thead><tbody>${coverageRows || `<tr><td colspan="4">Nenhum critério obrigatório para analisar.</td></tr>`}</tbody></table></div>${coverage.itemsTotal > 20 ? `<p class="table-note">Exibindo 20 de ${coverage.itemsTotal} PBIs; os detalhes estão limitados a ${coverage.items.length}. Totais consideram todo o projeto.</p>` : ""}</article>
        <article class="metrics-panel metrics-panel-wide"><div class="metrics-panel-heading"><div><p class="eyebrow">TÉCNICO</p><h3>Velocidade recente</h3><p>Pontos entregues por sprint e horas de capacidade registradas; amostra segmentada por time/geração.</p></div><span class="unit-tag">${data.velocity.sampleSize} sprints</span></div><div class="metric-table-wrap"><table class="metric-table"><thead><tr><th>Sprint</th><th>Fechada</th><th>Entregue</th><th>Capacidade</th><th>Taxa histórica</th></tr></thead><tbody>${velocityRows || `<tr><td colspan="5">Feche sprints para formar uma série de velocidade.</td></tr>`}</tbody></table></div></article>
      </div>`;
  }

  async function loadSelectedRetrospective(revisionNumber) {
    if (!model.projectId || !model.selectedRetrospectiveSprintId) return;
    try {
      const params = new URLSearchParams();
      if (revisionNumber) params.set("revisionNumber", revisionNumber);
      const suffix = params.size ? `?${params}` : "";
      const response = await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/sprints/${encodeURIComponent(model.selectedRetrospectiveSprintId)}/retrospective${suffix}`);
      model.retrospective = response.retrospective;
      renderRetrospective();
    } catch (error) {
      toast(`${error.code ?? "Erro"}: ${error.message}`, true);
    }
  }

  function renderQualityDetail(report) {
    const baseline = report.baseline
      ? `Baseline ${report.baseline.sequence} · fixada para este fluxo`
      : "Preview · ainda sem baseline fixada";
    const coverage = report.coveragePercent === null
      ? "Sem critérios obrigatórios"
      : `${report.coveredRequiredCriteria}/${report.requiredCriteria} critérios obrigatórios cobertos · ${report.coveragePercent}%`;
    const criteria = report.criteria.length ? report.criteria.map((entry) => {
      const scenarios = entry.scenarios.length ? entry.scenarios.map((scenario) => {
        const runs = scenario.latestRuns.length ? scenario.latestRuns.map(({ run, certification }) => `
          <div class="quality-run"><span class="run-result ${escapeHtml(run.result)}">${escapeHtml(run.result)}</span>
            <span>Build ${escapeHtml(run.buildId)}</span><span>Execução ${escapeHtml(run.id.slice(0, 8))}</span>
            <span>${escapeHtml(formatDate(run.executedAt))}</span>
            ${certification ? `<span class="certified-mark">Certificado por QA · ${escapeHtml(formatDate(certification.certifiedAt))}</span>` : "<span>Sem certificação para esta baseline</span>"}
            ${run.notes ? `<span>${escapeHtml(run.notes)}</span>` : ""}
          </div>`).join("") : "<div class=\"quality-run\">Nenhuma execução registrada.</div>";
        return `<div class="quality-scenario"><strong>${escapeHtml(scenario.scenario.key)}@${escapeHtml(scenario.revision.revisionNumber)} · ${escapeHtml(scenario.scenario.title)}</strong>${runs}</div>`;
      }).join("") : "<p>Nenhuma revisão de cenário cobre este critério nesta baseline.</p>";
      return `<div class="detail-section"><h3>${escapeHtml(entry.criterion.key)}${entry.criterion.required ? " · obrigatório" : ""} · ${entry.covered ? "coberto" : "sem cobertura"}</h3><p>${escapeHtml(entry.criterion.description)}</p><div class="quality-scenarios">${scenarios}</div></div>`;
    }).join("") : "<div class=\"detail-section\"><p>Nenhum critério foi registrado.</p></div>";
    const evidence = report.evidence.length ? `<ul>${report.evidence.map((entry) => {
      let link = escapeHtml(entry.uri);
      try {
        const url = new URL(entry.uri);
        if (url.protocol === "https:" || url.protocol === "http:") {
          link = `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.uri)}</a>`;
        }
      } catch { /* Keep invalid or non-web evidence as text. */ }
      return `<li>${escapeHtml(entry.kind)} · ${escapeHtml(entry.description)}${entry.buildId ? ` · build ${escapeHtml(entry.buildId)}` : ""}<br>${link}</li>`;
    }).join("")}</ul>` : "<p>Nenhuma evidência vinculada ao PBI.</p>";
    return `<section id="quality-report-section" class="detail-section"><h3>QA · ${escapeHtml(baseline)}</h3><p>${escapeHtml(coverage)}</p>${criteria}<section class="detail-section"><h3>Evidências</h3>${evidence}${report.nextEvidenceCursor ? `<button class="button button-secondary" type="button" data-load-evidence>Carregar mais evidências</button>` : ""}</section></section>`;
  }

  function renderItemTimeline(events) {
    if (!events.length) return "<p>Nenhuma mudança auditada encontrada para este item.</p>";
    return `<div class="detail-timeline">${events.map((event) => renderActivityEvent(event, true)).join("")}</div>`;
  }

  async function loadMoreEvidence(button) {
    if (!model.currentItem || !model.currentQuality?.nextEvidenceCursor) return;
    button.disabled = true;
    button.textContent = "Carregando…";
    try {
      const params = new URLSearchParams({ cursor: model.currentQuality.nextEvidenceCursor });
      const base = `/api/v1/projects/${encodeURIComponent(model.projectId)}/work-items/${encodeURIComponent(model.currentItem.id)}/quality`;
      const result = await api(`${base}?${params}`);
      model.currentQuality = {
        ...model.currentQuality,
        evidence: [...model.currentQuality.evidence, ...result.quality.evidence],
        nextEvidenceCursor: result.quality.nextEvidenceCursor,
      };
      const section = document.querySelector("#quality-report-section");
      if (section) section.outerHTML = renderQualityDetail(model.currentQuality);
    } catch (error) {
      toast(`${error.code ?? "ERRO"}: ${error.message}`, true);
      button.disabled = false;
      button.textContent = "Carregar mais evidências";
    }
  }

  async function loadMoreActivity() {
    if (!model.activityCursor) return;
    try {
      const page = await loadActivityPage(model.projectId, model.activityCursor);
      model.activityEvents.push(...page.events);
      model.activityCursor = page.nextCursor;
      renderActivity();
    } catch (error) {
      toast(`${error.code ?? "ERRO"}: ${error.message}`, true);
      if (error.code === "STALE_CURSOR") await loadProjectData();
    }
  }

  async function loadActivityPage(projectId, cursor = null) {
    const params = new URLSearchParams({ limit: "50" });
    if (elements.activityEntityType.value) params.set("entityType", elements.activityEntityType.value);
    if (elements.activityEntityId.value.trim()) params.set("entityId", elements.activityEntityId.value.trim());
    if (cursor) params.set("cursor", cursor);
    return api(`/api/v1/projects/${encodeURIComponent(projectId)}/audit?${params}`);
  }

  async function loadActivityFirstPage(projectId = model.projectId) {
    return loadActivityPage(projectId);
  }

  async function applyActivityFilters() {
    try {
      const page = await loadActivityFirstPage();
      model.activityEvents = page.events;
      model.activityCursor = page.nextCursor;
      model.activityWatermark = page.watermark;
      renderActivity();
    } catch (error) {
      toast(`${error.code ?? "ERRO"}: ${error.message}`, true);
    }
  }

  function renderCard(item) {
    const moveTargets = transitions[item.state] ?? [];
    return `<article class="work-card" draggable="true" data-card-id="${escapeHtml(item.id)}" tabindex="0" aria-label="${escapeHtml(item.key)} ${escapeHtml(item.title)}, ${escapeHtml(stateLabel(item.state))}">
      <div class="card-topline"><span class="card-key">${escapeHtml(item.key)}</span><span class="priority">P${escapeHtml(item.priority)}</span></div>
      <p class="card-title">${escapeHtml(item.title)}</p>
      <div class="card-foot"><span class="card-type">${escapeHtml(itemTypeLabel(item.type))} · v${escapeHtml(item.version)}</span><div class="card-actions"><button type="button" data-open-item="${escapeHtml(item.id)}">Detalhes</button>${moveTargets.length ? `<button type="button" data-move-item="${escapeHtml(item.id)}" aria-label="Mover ${escapeHtml(item.key)}">Mover item</button>` : ""}</div></div>
    </article>`;
  }

  function formatEstimate(estimate) {
    return `${estimate.value} ${estimate.unit === "points" ? "pts" : "h"}`;
  }

  async function openItem(itemId) {
    try {
      const base = `/api/v1/projects/${encodeURIComponent(model.projectId)}/work-items/${encodeURIComponent(itemId)}`;
      const [result, qualityResult, timeline] = await Promise.all([
        api(base),
        api(`${base}/quality?limit=100`),
        api(`${base}/timeline?limit=100`),
      ]);
      const item = result.workItem;
      model.currentItem = item;
      model.currentQuality = qualityResult.quality;
      elements.itemKicker.textContent = `${item.key} · ${itemTypeLabel(item.type)} · ${stateLabel(item.state)}`;
      elements.itemTitle.textContent = item.title;
      const criteria = item.criteria.length
        ? `<ul>${item.criteria.map((criterion) => `<li>${escapeHtml(criterion.key)}${criterion.required ? " · obrigatório" : ""}: ${escapeHtml(criterion.description)}</li>`).join("")}</ul>`
        : "<p>Nenhum critério de aceite registrado.</p>";
      const estimates = item.estimates.length
        ? `<div class="estimate-list">${item.estimates.map((estimate) => `<span class="estimate-chip">${escapeHtml(formatEstimate(estimate))}</span>`).join("")}</div>`
        : "<p>Sem estimativa confirmada.</p>";
      const parent = item.parentId ? `<p>${escapeHtml(item.parentId)}</p>` : "<p>Sem item pai.</p>";
      elements.itemDetails.innerHTML = `
        <div class="detail-meta"><span class="state-badge ${escapeHtml(item.state)}">${escapeHtml(stateLabel(item.state))}</span><span class="count-label">Versão ${escapeHtml(item.version)}</span><span class="count-label">Revisão ${escapeHtml(item.revision)}</span><span class="count-label">Prioridade ${escapeHtml(item.priority)}</span></div>
        <section class="detail-section"><h3>Descrição</h3><p>${escapeHtml(item.description || "Sem descrição registrada.")}</p></section>
        <section class="detail-section"><h3>Critérios de aceite</h3>${criteria}</section>
        <section class="detail-section"><h3>Estimativas confirmadas</h3>${estimates}</section>
        <section class="detail-section"><h3>Item pai</h3>${parent}</section>
        <section class="detail-section"><h3>Responsável</h3><p>${escapeHtml(item.assigneeId || "Não atribuído")}</p></section>
        ${renderQualityDetail(qualityResult.quality)}
        <section class="detail-section"><h3>Timeline do PBI · watermark ${timeline.watermark}</h3>${renderItemTimeline(timeline.events)}</section>`;
      elements.detailMove.hidden = (transitions[item.state] ?? []).length === 0;
      elements.itemDialog.showModal();
    } catch (error) {
      toast(`${error.code ?? "ERRO"}: ${error.message}`, true);
    }
  }

  function openTransition(item, preferredState = null) {
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
  }

  function updateBuildField() {
    const requiresBuild = elements.targetState.value === "done";
    elements.buildIdField.hidden = !requiresBuild;
    elements.buildId.required = requiresBuild;
  }

  async function submitTransition(event) {
    event.preventDefault();
    if (!model.pendingMove) return;
    const item = model.pendingMove;
    const targetState = elements.targetState.value;
    elements.submitTransition.disabled = true;
    elements.submitTransition.textContent = "Validando gates…";
    try {
      await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/work-items/${encodeURIComponent(item.key)}/transition`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SSDD-CSRF": model.session.csrfToken,
        },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          targetState,
          expectedVersion: item.version,
          reason: elements.reason.value.trim(),
          ...(elements.buildId.value.trim() ? { buildId: elements.buildId.value.trim() } : {}),
        }),
      });
      elements.transitionDialog.close();
      model.pendingMove = null;
      toast(`${item.key} atualizado para ${stateLabel(targetState)}.`);
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

  function setView(view) {
    const views = {
      metrics: [elements.metricsTab, elements.metricsView],
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
    elements.filters.hidden = view === "metrics";
    if (view === "metrics") void loadDashboardMetrics();
  }

  elements.projectSelect.addEventListener("change", () => {
    model.projectId = elements.projectSelect.value;
    model.teams = [];
    model.selectedTeamId = null;
    model.items = [];
    model.sprint = null;
    model.dashboardMetrics = null;
    model.selectedMetricsMilestoneId = null;
    model.selectedMetricsSprintId = null;
    model.selectedMetricsDate = null;
    model.metricsFiltersInitialized = false;
    elements.loading.hidden = false;
    void loadProjectData();
  });
  elements.teamSelect.addEventListener("change", () => {
    model.selectedTeamId = elements.teamSelect.value || null;
    model.sprint = null;
    model.closedSprints = [];
    model.selectedRetrospectiveSprintId = null;
    model.retrospective = null;
    model.dashboardMetrics = null;
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
  elements.metricsTab.addEventListener("click", () => setView("metrics"));
  elements.backlogTab.addEventListener("click", () => setView("backlog"));
  elements.boardTab.addEventListener("click", () => setView("board"));
  elements.qualityTab.addEventListener("click", () => setView("quality"));
  elements.activityTab.addEventListener("click", () => setView("activity"));
  elements.retrospectiveTab.addEventListener("click", () => setView("retrospective"));
  const tabs = [elements.metricsTab, elements.backlogTab, elements.boardTab, elements.qualityTab, elements.activityTab, elements.retrospectiveTab];
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + offset + tabs.length) % tabs.length];
      next.focus();
      setView(["metrics", "backlog", "board", "quality", "activity", "retrospective"][(index + offset + tabs.length) % tabs.length]);
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
  elements.metricsContent.addEventListener("click", (event) => {
    const point = event.target.closest("[data-metric-date]");
    if (!point) return;
    model.selectedMetricsDate = point.getAttribute("data-metric-date");
    elements.metricsDate.value = model.selectedMetricsDate;
    void loadDashboardMetrics();
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
  document.addEventListener("click", (event) => {
    if (event.target.closest(".retro-pbi")) event.preventDefault();
    const evidenceButton = event.target.closest("[data-load-evidence]");
    if (evidenceButton) {
      void loadMoreEvidence(evidenceButton);
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
  for (const dialog of [elements.itemDialog, elements.transitionDialog]) {
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

  void initialize();
})();
