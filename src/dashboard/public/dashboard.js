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
    paused: "Pausada",
    completed: "Concluída",
    closed: "Fechada",
  };
  const typeLabels = { epic: "Épico", feature: "Feature", story: "História", bug: "Bug", task: "Tarefa" };
  const typeMarks = { epic: "E", feature: "F", story: "H", bug: "B", task: "T" };
  const metricNumberFormatter = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
  const metricDateFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeZone: "UTC" });
  const localDateFormatters = new Map();
  const workProfileLabels = {
    admin: "Administração", po: "Product Owner", developer: "Developer", qa: "QA",
    tech_lead: "Tech Lead", facilitator: "Facilitador", stakeholder: "Stakeholder",
  };
  const workProfileOrder = ["developer", "qa", "po", "tech_lead", "facilitator", "stakeholder", "admin"];
  const scenarioKindLabels = {
    acceptance: "Aceitação", regression: "Regressão", integration: "Integração",
    performance: "Performance", security: "Segurança", manual: "Manual",
  };
  const specificationKindLabels = {
    business_rule: "Regra de negócio", glossary: "Glossário", api_contract: "Contrato de API",
    adr: "Decisão de arquitetura", non_functional: "Requisito não funcional",
  };
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
    loginScreen: document.querySelector("#login-screen"),
    loginForm: document.querySelector("#login-form"),
    authKey: document.querySelector("#auth-key"),
    loginError: document.querySelector("#login-error"),
    loginSubmit: document.querySelector("#login-submit"),
    appShell: document.querySelector("#app-shell"),
    projectSelect: document.querySelector("#project-select"),
    teamSelect: document.querySelector("#team-select"),
    principalName: document.querySelector("#principal-name"),
    lastUpdated: document.querySelector("#last-updated"),
    sprintSummary: document.querySelector("#sprint-summary"),
    homeTab: document.querySelector("#home-tab"),
    homeView: document.querySelector("#home-view"),
    homeTitle: document.querySelector("#quick-access-title"),
    homeDescription: document.querySelector("#quick-access-description"),
    homeProfile: document.querySelector("#work-profile"),
    firstUseGuidance: document.querySelector("#first-use-guidance"),
    homeSummary: document.querySelector("#quick-access-summary"),
    homeActions: document.querySelector("#quick-access-actions"),
    filters: document.querySelector(".filters"),
    metricsTab: document.querySelector("#metrics-tab"),
    metricsView: document.querySelector("#metrics-view"),
    roadmapTab: document.querySelector("#roadmap-tab"),
    roadmapView: document.querySelector("#roadmap-view"),
    roadmapDate: document.querySelector("#roadmap-date"),
    roadmapMeta: document.querySelector("#roadmap-meta"),
    roadmapError: document.querySelector("#roadmap-error"),
    roadmapContent: document.querySelector("#roadmap-content"),
    historyTab: document.querySelector("#history-tab"),
    historyView: document.querySelector("#history-view"),
    historyDate: document.querySelector("#history-date"),
    historyDateHelp: document.querySelector("#history-date-help"),
    historyApply: document.querySelector("#history-apply"),
    historyToday: document.querySelector("#history-today"),
    historyMeta: document.querySelector("#history-meta"),
    historyError: document.querySelector("#history-error"),
    historyContent: document.querySelector("#history-content"),
    specificationsTab: document.querySelector("#specifications-tab"),
    specificationsView: document.querySelector("#specifications-view"),
    specificationKind: document.querySelector("#specification-kind"),
    specificationSearch: document.querySelector("#specification-search"),
    applySpecificationFilter: document.querySelector("#apply-specification-filter"),
    specificationsCount: document.querySelector("#specifications-count"),
    specificationsMeta: document.querySelector("#specifications-meta"),
    specificationsError: document.querySelector("#specifications-error"),
    specificationList: document.querySelector("#specification-list"),
    specificationDetail: document.querySelector("#specification-detail"),
    metricsMilestone: document.querySelector("#metrics-milestone"),
    metricsSprint: document.querySelector("#metrics-sprint"),
    metricsDate: document.querySelector("#metrics-date"),
    metricsToday: document.querySelector("#metrics-today"),
    metricsEffortFrom: document.querySelector("#metrics-effort-from"),
    metricsEffortTo: document.querySelector("#metrics-effort-to"),
    metricsDeveloper: document.querySelector("#metrics-developer"),
    metricsEffortApply: document.querySelector("#metrics-effort-apply"),
    metricsEffortReset: document.querySelector("#metrics-effort-reset"),
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
    logout: document.querySelector("#logout-button"),
    toast: document.querySelector("#toast"),
    itemDialog: document.querySelector("#item-dialog"),
    itemKicker: document.querySelector("#item-kicker"),
    itemTitle: document.querySelector("#item-title"),
    itemDetails: document.querySelector("#item-details"),
    taskWorkflowDialog: document.querySelector("#task-workflow-dialog"),
    taskWorkflowForm: document.querySelector("#task-workflow-form"),
    taskWorkflowFormTitle: document.querySelector("#task-workflow-form-title"),
    taskWorkflowFormHelp: document.querySelector("#task-workflow-form-help"),
    taskWorkflowStepList: document.querySelector("#task-workflow-step-list"),
    addTaskWorkflowStep: document.querySelector("#add-task-workflow-step"),
    taskWorkflowTotal: document.querySelector("#task-workflow-total"),
    taskWorkflowValidation: document.querySelector("#task-workflow-validation"),
    taskWorkflowReason: document.querySelector("#task-workflow-reason"),
    submitTaskWorkflow: document.querySelector("#submit-task-workflow"),
    publishTaskWorkflow: document.querySelector("#publish-task-workflow"),
    detailMove: document.querySelector("#detail-move-button"),
    transitionDialog: document.querySelector("#transition-dialog"),
    transitionForm: document.querySelector("#transition-form"),
    transitionItemLabel: document.querySelector("#transition-item-label"),
    transitionStartHint: document.querySelector("#transition-start-hint"),
    targetState: document.querySelector("#target-state"),
    reason: document.querySelector("#transition-reason"),
    buildIdField: document.querySelector("#build-id-field"),
    buildId: document.querySelector("#build-id"),
    submitTransition: document.querySelector("#submit-transition"),
    createWorkItem: document.querySelector("#create-work-item"),
    detailEdit: document.querySelector("#detail-edit-button"),
    workItemDialog: document.querySelector("#work-item-form-dialog"),
    workItemForm: document.querySelector("#work-item-form"),
    workItemFormTitle: document.querySelector("#work-item-form-title"),
    workItemType: document.querySelector("#work-item-type"),
    workItemParentField: document.querySelector("#work-item-parent-field"),
    workItemParentLabel: document.querySelector("#work-item-parent-label"),
    workItemParent: document.querySelector("#work-item-parent"),
    workItemTitle: document.querySelector("#work-item-title"),
    workItemDescription: document.querySelector("#work-item-description"),
    workItemPriority: document.querySelector("#work-item-priority"),
    workItemBusinessValue: document.querySelector("#work-item-business-value"),
    workItemBusinessRationale: document.querySelector("#work-item-business-rationale"),
    workItemValueField: document.querySelector("#work-item-value-field"),
    workItemRationaleField: document.querySelector("#work-item-rationale-field"),
    workItemCriteriaField: document.querySelector("#work-item-criteria-field"),
    workItemCriteria: document.querySelector("#work-item-criteria"),
    submitWorkItem: document.querySelector("#submit-work-item"),
    qaRunChart: document.querySelector("#qa-run-chart"),
    scenarioList: document.querySelector("#scenario-list"),
    createScenario: document.querySelector("#create-scenario"),
    scenarioDialog: document.querySelector("#scenario-form-dialog"),
    scenarioForm: document.querySelector("#scenario-form"),
    scenarioFormTitle: document.querySelector("#scenario-form-title"),
    scenarioKey: document.querySelector("#scenario-key"),
    scenarioKind: document.querySelector("#scenario-kind"),
    scenarioTitle: document.querySelector("#scenario-title"),
    scenarioPreconditions: document.querySelector("#scenario-preconditions"),
    scenarioActions: document.querySelector("#scenario-actions"),
    scenarioExpectations: document.querySelector("#scenario-expectations"),
    scenarioCoverage: document.querySelector("#scenario-coverage"),
    scenarioTasks: document.querySelector("#scenario-tasks"),
    submitScenario: document.querySelector("#submit-scenario"),
    testRunForm: document.querySelector("#test-run-form"),
    testRunScenario: document.querySelector("#test-run-scenario"),
    testRunBuild: document.querySelector("#test-run-build"),
    testRunResult: document.querySelector("#test-run-result"),
    testRunNotes: document.querySelector("#test-run-notes"),
    testRunEvidence: document.querySelector("#test-run-evidence"),
    testRunTasks: document.querySelector("#test-run-tasks"),
    submitTestRun: document.querySelector("#submit-test-run"),
    testRunHistory: document.querySelector("#test-run-history"),
  };

  const model = {
    session: null,
    projects: [],
    projectId: null,
    teams: [],
    selectedTeamId: null,
    project: null,
    quickAccess: null,
    workProfile: null,
    historySnapshot: null,
    historyDate: null,
    historyCursor: null,
    historyLoading: false,
    historyRequestId: 0,
    specifications: [],
    specificationKind: "",
    specificationSearch: "",
    specificationLoading: false,
    specificationRequestId: 0,
    specificationSearchTimer: null,
    currentSpecification: null,
    selectedSpecificationRevisionNumber: null,
    items: [],
    qualitySummaries: [],
    scenarios: [],
    testRuns: [],
    parentFeatures: [],
    parentWorkItems: [],
    activityEvents: [],
    activityCursor: null,
    activityWatermark: 0,
    sprint: null,
    closedSprints: [],
    selectedRetrospectiveSprintId: null,
    retrospective: null,
    dashboardMetrics: null,
    projectRoadmap: null,
    roadmapLoading: false,
    selectedMetricsMilestoneId: null,
    selectedMetricsSprintId: null,
    selectedMetricsDate: null,
    metricsFiltersInitialized: false,
    developerMetricsFrom: null,
    developerMetricsTo: null,
    developerMetricsRangeCustomized: false,
    selectedMetricsDeveloperId: null,
    metricsVelocityWindow: 8,
    metricsLoading: false,
    metricsRefreshPending: false,
    currentItem: null,
    currentQuality: null,
    currentTaskContext: null,
    currentTaskWorkflow: null,
    currentTaskSessions: [],
    workflowEditorDirty: false,
    currentRevisions: [],
    editingItem: null,
    editingScenario: null,
    pendingMove: null,
    draggedItemId: null,
    loading: false,
    projectReloadPending: false,
    toastTimer: null,
    refreshTimer: null,
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/gu, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  function itemTypeLabel(type) {
    return typeLabels[type] ?? type;
  }

  function scenarioKindLabel(kind) {
    return scenarioKindLabels[kind] ?? kind;
  }

  function specificationKindLabel(kind) {
    return specificationKindLabels[kind] ?? kind;
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

  function showWorkspace() {
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

  async function loadProjectCollection(projectId, collectionName, collectionField) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const values = [];
      let cursor = null;
      try {
        do {
          const params = new URLSearchParams({ limit: "100" });
          if (cursor) params.set("cursor", cursor);
          const page = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/${collectionName}?${params}`);
          values.push(...page[collectionField]);
          cursor = page.nextCursor;
        } while (cursor);
        return values;
      } catch (error) {
        if (error.code !== "STALE_CURSOR" || attempt === 2) throw error;
      }
    }
    return [];
  }

  async function loadQualitySummaries(projectId) {
    return loadProjectCollection(projectId, "quality", "items");
  }

  async function loadScenarioSummaries(projectId) {
    return loadProjectCollection(projectId, "scenarios", "scenarios");
  }

  async function loadParentFeatures(projectId) {
    const params = new URLSearchParams({ type: "feature", limit: "100" });
    return (await api(`/api/v1/projects/${encodeURIComponent(projectId)}/work-items?${params}`)).items;
  }

  async function loadParentItems(projectId) {
    const types = ["epic", "feature", "story", "bug"];
    const results = await Promise.all(types.map(async (type) => {
      const items = [];
      let cursor = null;
      do {
        const params = new URLSearchParams({ type, limit: "100" });
        if (cursor) params.set("cursor", cursor);
        const page = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/work-items?${params}`);
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return items;
    }));
    return results.flat();
  }

  async function loadChildTasks(projectId, parentId) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const tasks = [];
      let cursor = null;
      try {
        do {
          const params = new URLSearchParams({ type: "task", parentId, limit: "100" });
          if (cursor) params.set("cursor", cursor);
          const page = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/work-items?${params}`);
          tasks.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);
        return tasks;
      } catch (error) {
        if (error.code !== "STALE_CURSOR" || attempt === 2) throw error;
      }
    }
    return [];
  }

  async function loadTaskContext(projectId, taskId) {
    const params = new URLSearchParams({ profile: "dev", maxChars: "30000" });
    for (const section of ["hierarchy", "acceptanceCriteria", "businessRules", "technicalDecisions", "scenarios", "testRuns", "baseline"]) {
      params.append("include", section);
    }
    return api(`/api/v1/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(taskId)}/context?${params}`);
  }

  async function fetchSpecifications(projectId, filters = {}) {
    const specifications = [];
    let cursor = null;
    do {
      const params = new URLSearchParams({ limit: "100" });
      if (filters.kind) params.set("kind", filters.kind);
      if (filters.search) params.set("search", filters.search);
      if (cursor) params.set("cursor", cursor);
      const page = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/specifications?${params}`);
      specifications.push(...page.specifications);
      cursor = page.nextCursor;
    } while (cursor);
    return specifications;
  }

  function specificationFilters() {
    const search = model.specificationSearch.trim();
    return {
      ...(model.specificationKind ? { kind: model.specificationKind } : {}),
      ...(search.length >= 2 ? { search } : {}),
    };
  }

  async function loadSpecifications() {
    if (!model.projectId) return;
    const projectId = model.projectId;
    const requestId = ++model.specificationRequestId;
    model.specificationLoading = true;
    elements.specificationsError.hidden = true;
    elements.specificationsMeta.textContent = "Carregando especificações…";
    try {
      const specifications = await fetchSpecifications(projectId, specificationFilters());
      if (requestId !== model.specificationRequestId || projectId !== model.projectId) return;
      model.specifications = specifications;
      if (model.currentSpecification && !specifications.some((specification) => specification.key === model.currentSpecification.key)) {
        model.currentSpecification = null;
      }
      renderSpecifications();
    } catch (error) {
      if (requestId !== model.specificationRequestId || projectId !== model.projectId) return;
      elements.specificationsError.textContent = `${error.code ?? "ERRO"}: ${error.message}`;
      elements.specificationsError.hidden = false;
      elements.specificationsMeta.textContent = "Não foi possível carregar as especificações.";
      elements.specificationList.innerHTML = "";
    } finally {
      if (requestId === model.specificationRequestId) model.specificationLoading = false;
    }
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
      const [projectResult, sprintResult, items, qualityResult, activityPage, closedSprintResult, scenariosResult, testRunsResult, parentFeatures, quickAccess, specifications] = await Promise.all([
        api(`/api/v1/projects/${encodeURIComponent(projectId)}`),
        activeSprints,
        loadWorkItems(projectId),
        loadQualitySummaries(projectId),
        loadActivityFirstPage(projectId),
        closedSprints,
        loadScenarioSummaries(projectId),
        api(`/api/v1/projects/${encodeURIComponent(projectId)}/test-runs?limit=100`),
        loadParentFeatures(projectId),
        api(`/api/v1/projects/${encodeURIComponent(projectId)}/quick-access`),
        fetchSpecifications(projectId, specificationFilters()),
      ]);
      model.project = projectResult.project;
      model.quickAccess = quickAccess;
      model.specifications = specifications;
      syncWorkProfileOptions();
      const minimumHistoryDate = projectLocalDate(new Date(model.project.createdAt), model.project.timezone);
      const maximumHistoryDate = projectLocalDate(new Date(), model.project.timezone);
      elements.historyDate.min = minimumHistoryDate;
      elements.historyDate.max = maximumHistoryDate;
      if (model.historyDate === null || model.historyDate < minimumHistoryDate || model.historyDate > maximumHistoryDate) {
        model.historyDate = maximumHistoryDate;
      }
      elements.historyDate.value = model.historyDate;
      if (!elements.roadmapDate.value) elements.roadmapDate.value = maximumHistoryDate;
      elements.historyDateHelp.textContent = `Disponível de ${metricDate(minimumHistoryDate)} a ${metricDate(maximumHistoryDate)} · ${model.project.timezone}`;
      model.sprint = sprintResult.sprints.length > 0
        ? (await api(`/api/v1/projects/${encodeURIComponent(projectId)}/sprints/${encodeURIComponent(sprintResult.sprints[0].id)}`)).sprint
        : null;
      model.items = items;
      model.qualitySummaries = qualityResult;
      model.scenarios = scenariosResult;
      model.testRuns = testRunsResult.runs;
      model.parentFeatures = parentFeatures;
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
      if (document.querySelector('[role="tab"][aria-selected="true"]')?.id === "history-tab") {
        await loadProjectHistory();
      }
    } catch (error) {
      showError(error);
    } finally {
      model.loading = false;
      if (model.projectReloadPending) {
        model.projectReloadPending = false;
        void loadProjectData();
      } else if (document.querySelector('[role="tab"][aria-selected="true"]')?.id === "metrics-tab") {
        void loadDashboardMetrics();
      } else if (document.querySelector('[role="tab"][aria-selected="true"]')?.id === "roadmap-tab") {
        void loadProjectRoadmap();
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
      const developerParams = new URLSearchParams();
      if (!model.developerMetricsRangeCustomized) {
        model.developerMetricsFrom = `${result.asOfDate.slice(0, 7)}-01`;
        model.developerMetricsTo = result.asOfDate;
      } else {
        if (model.developerMetricsTo > result.asOfDate) model.developerMetricsTo = result.asOfDate;
        if (model.developerMetricsFrom > model.developerMetricsTo) model.developerMetricsFrom = model.developerMetricsTo;
      }
      developerParams.set("from", model.developerMetricsFrom);
      developerParams.set("to", model.developerMetricsTo);
      const developerExecutionMetrics = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/developer-execution-metrics?${developerParams}`);
      if (projectId !== model.projectId || teamId !== model.selectedTeamId) {
        model.metricsRefreshPending = true;
        return;
      }
      model.dashboardMetrics = { ...result, developerExecutionMetrics };
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

  async function loadProjectRoadmap() {
    if (!model.projectId || model.roadmapLoading) return;
    if (model.teams.length > 1 && model.selectedTeamId === null) {
      elements.roadmapMeta.textContent = "Selecione um time para filtrar velocity e projeção por geração.";
      elements.roadmapContent.innerHTML = "";
      return;
    }
    model.roadmapLoading = true;
    elements.roadmapError.hidden = true;
    elements.roadmapMeta.textContent = "Calculando ordem e timeline por feature…";
    try {
      const params = new URLSearchParams();
      if (model.selectedTeamId) params.set("teamId", model.selectedTeamId);
      if (elements.roadmapDate.value) params.set("asOfDate", elements.roadmapDate.value);
      const suffix = params.size ? `?${params}` : "";
      const roadmap = await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/feature-roadmap${suffix}`);
      if (roadmap.projectId !== model.projectId || roadmap.teamId !== model.selectedTeamId) return;
      model.projectRoadmap = roadmap;
      renderProjectRoadmap();
    } catch (error) {
      elements.roadmapError.textContent = `${error.code ?? "Erro"}: ${error.message}`;
      elements.roadmapError.hidden = false;
      elements.roadmapMeta.textContent = "O roadmap não pôde ser carregado.";
      elements.roadmapContent.innerHTML = "";
    } finally {
      model.roadmapLoading = false;
    }
  }

  function renderProjectRoadmap() {
    const roadmap = model.projectRoadmap;
    if (!roadmap || !elements.roadmapContent) return;
    const features = roadmap.features ?? [];
    const valueMissing = features.filter((feature) => feature.businessValueScore === null).length;
    const sample = `${roadmap.velocitySampleSize}/${roadmap.minimumVelocitySamples} sprints comparáveis`;
    const team = roadmap.teamName ? `${roadmap.teamName} · geração ${roadmap.teamGenerationNumber}` : "time não selecionado";
    elements.roadmapMeta.textContent = `${team} · corte ${metricDate(roadmap.asOfDate)} · ${sample} · ${valueMissing} feature(s) sem valor de negócio definido · watermark ${roadmap.watermarkSequence}`;
    if (!features.length) {
      elements.roadmapContent.innerHTML = `<div class="metrics-empty-chart">Nenhuma feature cadastrada para este projeto.</div>`;
      return;
    }
    const timeline = roadmap.sprintTimeline ?? [];
    const chart = timeline.length && features.some((feature) => feature.forecast.status === "forecast_ready")
      ? `<div class="roadmap-axis"><span>Feature</span><span>${timeline.slice(0, 6).map((sprint) => `<span title="${escapeHtml(metricDate(sprint.startsOn))}–${escapeHtml(metricDate(sprint.endsOn))}">S${sprint.index} · ${escapeHtml(metricDate(sprint.endsOn))}</span>`).join("")}${timeline.length > 6 ? "<span title=\"Sprints após a sexta janela visível\">S7+</span>" : ""}</span></div>`
      : "";
    const rows = features.map((feature, index) => {
      const value = feature.businessValueScore === null
        ? "Valor pendente"
        : `Valor ${feature.businessValueScore}/100${feature.businessValueSource ? ` · ${escapeHtml(feature.businessValueSource)}` : ""}`;
      const valueRationale = feature.businessValueRationale ? ` title="${escapeHtml(feature.businessValueRationale)}"` : "";
      const progress = feature.progressPercent === null ? null : Number(feature.progressPercent);
      const forecast = feature.forecast;
      const ready = forecast.status === "forecast_ready" && timeline.length > 0;
      const visibleTimelineLength = Math.min(timeline.length > 6 ? 7 : 6, timeline.length);
      const startPercent = ready ? ((Math.min(visibleTimelineLength, Math.max(1, forecast.favorableSprint ?? 1)) - 1) / visibleTimelineLength) * 100 : 0;
      const endPercent = ready ? (Math.min(visibleTimelineLength, forecast.cautiousSprint ?? visibleTimelineLength) / visibleTimelineLength) * 100 : 0;
      const medianPercent = ready ? ((Math.min(visibleTimelineLength, Math.max(1, forecast.baseSprint ?? 1)) - 1) / visibleTimelineLength) * 100 : 0;
      const progressMarkup = progress === null
        ? `<small class="roadmap-unknown">Progresso sem estimativa publicada</small>`
        : `<div class="roadmap-progress"><progress max="100" value="${progress}" aria-label="${escapeHtml(feature.key)}: ${progress}% dos pontos estimados concluídos"></progress><small>${escapeHtml(metricNumber(progress))}% · ${escapeHtml(metricNumber(feature.completedPoints))}/${escapeHtml(metricNumber(feature.completedPoints + feature.remainingPoints))} pts</small></div>`;
      const timelineMarkup = ready
        ? `<div class="roadmap-track" role="img" aria-label="${escapeHtml(feature.key)}: conclusão provável entre sprint ${forecast.favorableSprint} e ${forecast.cautiousSprint}, mediana ${forecast.baseDate ? metricDate(forecast.baseDate) : "indisponível"}" style="--roadmap-slot:${100 / visibleTimelineLength}%"><span class="roadmap-range" style="left:${startPercent}%;width:${Math.max(1, endPercent - startPercent)}%"></span><span class="roadmap-median" style="left:${medianPercent}%"></span></div><small class="roadmap-date">P25 S${forecast.favorableSprint > 6 ? "7+" : forecast.favorableSprint} · ${escapeHtml(metricDate(forecast.favorableDate))} · P50 S${forecast.baseSprint > 6 ? "7+" : forecast.baseSprint} · ${escapeHtml(metricDate(forecast.baseDate))} · P75 S${forecast.cautiousSprint > 6 ? "7+" : forecast.cautiousSprint} · ${escapeHtml(metricDate(forecast.cautiousDate))}</small>`
        : `<small class="roadmap-unknown">${escapeHtml(roadmapForecastReason(forecast.status, feature, roadmap.forecastUnavailableReason))}</small>`;
      const dependencyNote = feature.externalBlockers.length
        ? `<small class="roadmap-blockers">Dependências: ${feature.externalBlockers.map((dependency) => escapeHtml(`${dependency.key} (${stateLabel(dependency.state)})`)).join(", ")}</small>`
        : "";
      return `<article class="roadmap-feature" aria-label="Feature ${escapeHtml(index + 1)}: ${escapeHtml(feature.key)}">
        <div class="roadmap-feature-heading"><span class="roadmap-order">${index + 1}</span><div><button class="link-button" type="button" data-open-item="${escapeHtml(feature.id)}"><strong>${escapeHtml(feature.key)}</strong> · ${escapeHtml(feature.title)}</button><small>Prioridade efetiva P${escapeHtml(feature.effectivePriority)} · <span${valueRationale}>${escapeHtml(value)}</span> · ${escapeHtml(stateLabel(feature.state))}</small></div></div>
        <div class="roadmap-feature-progress">${progressMarkup}<div class="roadmap-timeline-cell">${timelineMarkup}${dependencyNote}</div></div>
      </article>`;
    }).join("");
    const warning = roadmap.forecastUnavailableReason
      ? `<div class="roadmap-warning" role="status"><strong>Previsão por data indisponível.</strong> ${escapeHtml(roadmapForecastReason(null, null, roadmap.forecastUnavailableReason))}</div>`
      : `<p class="table-note">${escapeHtml(roadmap.forecastAssumption)} Valores ausentes continuam sem posição de negócio até avaliação do PO.</p>`;
    elements.roadmapContent.innerHTML = `${warning}${chart}<div class="roadmap-features">${rows}</div>`;
  }

  function roadmapForecastReason(status, feature, reason) {
    const reasonLabels = {
      team_required: "Selecione um time para definir a geração de velocity.",
      insufficient_velocity_samples: `A amostra tem menos de ${model.projectRoadmap?.minimumVelocitySamples ?? 3} sprints fechadas comparáveis; não mostramos datas estimadas.`,
      unknown_feature_scope: "Há itens sem estimativa em story points; complete a avaliação para calcular a sequência.",
      external_dependency: "Há dependência externa não concluída; resolva a dependência antes de assumir uma data.",
      zero_velocity: "As sprints comparáveis não registraram entrega de pontos.",
    };
    if (reason) return reasonLabels[reason] ?? "A projeção não tem dados suficientes.";
    if (status === "completed") return "Escopo estimado concluído.";
    if (status === "incomplete_scope") return "Escopo sem estimativa; data omitida.";
    if (status === "blocked") return `Bloqueada por dependência: ${(feature?.externalBlockers ?? []).map((item) => item.key).join(", ")}.`;
    if (status === "zero_velocity") return reasonLabels.zero_velocity;
    return "Data ainda indisponível para esta feature.";
  }

  function applyDeveloperMetricFilters() {
    const from = elements.metricsEffortFrom.value;
    const to = elements.metricsEffortTo.value;
    const cutoff = model.dashboardMetrics?.asOfDate;
    if (!from || !to) {
      elements.metricsError.textContent = "Informe as datas inicial e final do período de esforço.";
      elements.metricsError.hidden = false;
      return;
    }
    if (from > to) {
      elements.metricsError.textContent = "A data inicial do período não pode ser posterior à data final.";
      elements.metricsError.hidden = false;
      return;
    }
    if (cutoff && to > cutoff) {
      elements.metricsError.textContent = "A data final do esforço não pode ultrapassar a data de corte do projeto.";
      elements.metricsError.hidden = false;
      return;
    }
    model.developerMetricsFrom = from;
    model.developerMetricsTo = to;
    model.developerMetricsRangeCustomized = true;
    elements.metricsError.hidden = true;
    void loadDashboardMetrics();
  }

  function showLogin(message = "") {
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

  async function claimQuickAccessTask(button) {
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

  async function startAuthenticatedDashboard(session) {
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

  function scheduleRefresh() {
    if (model.refreshTimer !== null) {
      window.clearInterval(model.refreshTimer);
      model.refreshTimer = null;
    }
    if (document.hidden || model.session === null) return;
    model.refreshTimer = window.setInterval(() => { void loadProjectData(); }, 30_000);
  }

  async function submitLogin(event) {
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

  async function logout() {
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

  async function initialize() {
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

  function syncWorkProfileOptions() {
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

  function readStoredWorkProfile(storageKey) {
    try { return window.sessionStorage.getItem(storageKey); } catch { return null; }
  }

  function storeWorkProfile(storageKey, profile) {
    try { window.sessionStorage.setItem(storageKey, profile); } catch { return; }
  }

  function quickStat(value, label, attention = false) {
    return `<article class="quick-stat${attention ? " is-attention" : ""}"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></article>`;
  }

  function blockerLabel(code) {
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

  function renderQuickTask(item, mode = "open") {
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

  function quickPanel(title, description, items, emptyMessage, mode = "open") {
    const content = items.length > 0
      ? `<ul class="quick-task-list">${items.map((item) => renderQuickTask(item, mode)).join("")}</ul>`
      : `<p class="quick-empty">${escapeHtml(emptyMessage)}</p>`;
    return `<section class="quick-panel"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p>${content}</section>`;
  }

  function renderFirstUseGuidance() {
    const isFirstUse = model.items.length === 0 && model.parentFeatures.length === 0;
    elements.firstUseGuidance.hidden = !isFirstUse;
    if (!isFirstUse) {
      elements.firstUseGuidance.innerHTML = "";
      return;
    }
    elements.firstUseGuidance.innerHTML = `<section class="first-use-card" aria-labelledby="first-use-title"><p class="eyebrow">PRIMEIRO USO</p><h3 id="first-use-title">Este projeto ainda não tem backlog</h3><p>O dashboard acompanha o trabalho; a autoria principal acontece pelas ferramentas MCP. Comece pelo backlog e depois configure a execução.</p><ol><li>Crie épicos, Features, histórias e tarefas com <code>work_item_create</code>. Publique revisões de PBI quando o conteúdo estiver estável.</li><li>Registre regras e ADRs com <code>spec_create</code> e cenários de aceite com <code>scenario_create</code>.</li><li>Crie o time, defina capacidade/DoD e prepare uma sprint com <code>team_create</code>, <code>team_capacity_set</code> e <code>sprint_draft</code>.</li></ol><p class="first-use-note">As abas mostram um estado vazio até existir dado compatível. Use o botão Atualizar no topo após cadastrar pelo MCP.</p><div class="quick-task-actions"><button class="button button-primary" type="button" data-home-view="backlog">Abrir Product Backlog</button><button class="button button-secondary" type="button" data-home-view="roadmap">Abrir Roadmap</button></div></section>`;
  }

  function renderQuickAccess() {
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

  function render() {
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

  function projectLocalDate(value, timezone) {
    let formatter = localDateFormatters.get(timezone);
    if (formatter === undefined) {
      formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      });
      localDateFormatters.set(timezone, formatter);
    }
    const parts = formatter.formatToParts(value);
    const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${fields.year}-${fields.month}-${fields.day}`;
  }

  function metricTimestampDate(value) {
    if (!value) return null;
    const timezone = model.project?.timezone;
    return timezone ? projectLocalDate(new Date(value), timezone) : value.slice(0, 10);
  }

  function isHistoryDateSelectable(value = elements.historyDate.value) {
    return Boolean(value && value >= elements.historyDate.min && value <= elements.historyDate.max);
  }

  function historyDateBoundsMessage() {
    return `Selecione uma data entre ${metricDate(elements.historyDate.min)} e ${metricDate(elements.historyDate.max)} no fuso ${model.project.timezone}.`;
  }

  async function loadProjectHistory(cursor = null) {
    if (!model.projectId || !elements.historyDate.value) return;
    if (!isHistoryDateSelectable()) {
      model.historySnapshot = null;
      model.historyCursor = null;
      elements.historyApply.disabled = false;
      elements.historyError.textContent = historyDateBoundsMessage();
      elements.historyError.hidden = false;
      elements.historyMeta.textContent = "A data escolhida está fora do período disponível.";
      elements.historyContent.innerHTML = "";
      return;
    }
    const projectId = model.projectId;
    const asOfDate = elements.historyDate.value;
    const requestId = ++model.historyRequestId;
    model.historyLoading = true;
    elements.historyError.hidden = true;
    elements.historyApply.disabled = true;
    elements.historyMeta.textContent = `Reconstruindo o estado de ${metricDate(asOfDate)}…`;
    if (cursor === null) {
      model.historySnapshot = null;
      model.historyCursor = null;
      elements.historyContent.innerHTML = '<div class="history-empty">Carregando o retrato histórico…</div>';
    }
    else elements.historyContent.setAttribute("aria-busy", "true");
    try {
      const params = new URLSearchParams({ asOfDate });
      if (cursor) params.set("cursor", cursor);
      const snapshot = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/history?${params}`);
      if (requestId !== model.historyRequestId || projectId !== model.projectId || asOfDate !== elements.historyDate.value) return;
      const previousItems = cursor === null ? [] : model.historySnapshot?.workItems.items ?? [];
      model.historySnapshot = {
        ...snapshot,
        workItems: { ...snapshot.workItems, items: [...previousItems, ...snapshot.workItems.items] },
      };
      model.historyCursor = snapshot.workItems.nextCursor;
      model.historyDate = asOfDate;
      renderProjectHistory();
    } catch (error) {
      if (requestId !== model.historyRequestId) return;
      if (cursor !== null && error.code === "STALE_CURSOR") {
        model.historySnapshot = null;
        model.historyCursor = null;
        await loadProjectHistory();
        return;
      }
      elements.historyError.textContent = `${error.code ?? "ERRO"}: ${error.message}`;
      elements.historyError.hidden = false;
      elements.historyMeta.textContent = "Não foi possível reconstruir o retrato para esta data.";
      if (cursor === null) elements.historyContent.innerHTML = "";
    } finally {
      if (requestId === model.historyRequestId) {
        model.historyLoading = false;
        elements.historyApply.disabled = false;
        elements.historyContent.removeAttribute("aria-busy");
        renderProjectHistory();
      }
    }
  }

  function renderProjectHistory() {
    const snapshot = model.historySnapshot;
    if (!snapshot) return;
    const observedCutoff = formatDate(snapshot.cutoffAt);
    const range = snapshot.asOfDate < snapshot.historyFromDate
      ? `sem atividade até ${metricDate(snapshot.asOfDate)}`
      : `${metricDate(snapshot.historyFromDate)}–${metricDate(snapshot.asOfDate)}`;
    elements.historyMeta.textContent = `Corte ${observedCutoff} (${snapshot.timezone}) · atividade ${range} · watermark ${snapshot.asOfWatermark}/${snapshot.sourceWatermark} · consultado ${formatDate(snapshot.capturedAt)}`;
    const summary = snapshot.summary;
    const resultCounts = summary.testRunsByResult;
    const cards = [
      [summary.workItemsTotal, "itens de trabalho"],
      [`${summary.specificationsPublished}/${summary.specificationsTotal}`, "especificações publicadas"],
      [`${summary.scenariosPublished}/${summary.scenariosTotal}`, "cenários publicados"],
      [summary.testRunsTotal, "execuções QA"],
      [`${summary.developmentSessionsActive}/${summary.developmentSessionsTotal}`, "sessões de desenvolvimento ativas"],
      [summary.deploymentsTotal, "eventos de homologação e produção"],
      [summary.sprintsTotal, "sprints"],
      [summary.milestonesTotal, "marcos"],
    ];
    const stateOrder = ["draft", "ready", "in_progress", "in_review", "in_validation", "done", "cancelled"];
    const stateRows = stateOrder.map((state) => {
      const count = summary.workItemsByState[state] ?? 0;
      const width = summary.workItemsTotal ? Math.round(count / summary.workItemsTotal * 100) : 0;
      return `<div class="history-state-row"><span>${escapeHtml(stateLabel(state))}</span><div class="history-meter" role="img" aria-label="${escapeHtml(stateLabel(state))}: ${count} de ${summary.workItemsTotal}"><span style="width:${width}%"></span></div><strong>${count}</strong></div>`;
    }).join("");
    const itemRows = snapshot.workItems.items.map((item) => `
        <tr>
        <th scope="row"><span class="history-item-key">${escapeHtml(item.key)}</span><span class="history-item-title">${escapeHtml(item.title)}</span></th>
        <td>${escapeHtml(itemTypeLabel(item.type))}</td>
        <td><span class="state-badge ${escapeHtml(item.state)}">${escapeHtml(stateLabel(item.state))}</span></td>
        <td>${item.revisionNumber ? `r${item.revisionNumber}` : "—"}</td>
      </tr>`).join("");
    const specRows = snapshot.specifications.map((item) => `<li><strong>${escapeHtml(item.key)}</strong><span>${escapeHtml(item.title)}</span><small>${escapeHtml(specificationKindLabel(item.kind))} · ${item.revisionNumber ? `r${item.revisionNumber}` : "sem publicação no corte"}</small></li>`).join("");
    const scenarioRows = snapshot.scenarios.map((item) => `<li><strong>${escapeHtml(item.key)}</strong><span>${escapeHtml(item.title)}</span><small>${escapeHtml(scenarioKindLabel(item.kind))} · ${item.revisionNumber ? `r${item.revisionNumber}` : "sem publicação no corte"}</small></li>`).join("");
    const runRows = snapshot.testRuns.map((run) => `<li><span class="run-result result-${escapeHtml(run.result)}">${escapeHtml(run.result)}</span><strong>${escapeHtml(run.scenarioKey)} · r${run.revisionNumber}</strong><span>${escapeHtml(run.buildId)} · ${escapeHtml(run.workItemKeys.join(", ") || "sem tarefa vinculada")}</span><time datetime="${escapeHtml(run.executedAt)}">${escapeHtml(formatDate(run.executedAt))}</time><small>${escapeHtml(run.executedBy)}</small></li>`).join("");
    const sessionRows = snapshot.developmentSessions.map((session) => `<li><span class="history-session-status status-${escapeHtml(session.status)}">${escapeHtml(stateLabel(session.status))}</span><strong>${escapeHtml(session.itemKey)} · ${escapeHtml(session.developerName)}</strong><span>${escapeHtml(session.reference ?? "sem referência")}</span><time datetime="${escapeHtml(session.startedAt)}">Início ${escapeHtml(formatDate(session.startedAt))}</time><small>${(session.activeSeconds / 3600).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} h ativas${session.endedAt ? ` · fim ${escapeHtml(formatDate(session.endedAt))}` : ""}</small></li>`).join("");
    const environmentLabels = { homologation: "Homologação", production: "Produção" };
    const outcomeLabels = { succeeded: "Aprovado", failed: "Falhou", rolled_back: "Rollback" };
    const deploymentRows = snapshot.deployments.map((deployment) => `<li><span class="history-deployment-status outcome-${escapeHtml(deployment.outcome)}">${escapeHtml(environmentLabels[deployment.environment])} · ${escapeHtml(outcomeLabels[deployment.outcome])}</span><strong>${escapeHtml(deployment.buildId)}</strong><span>${escapeHtml(deployment.itemKeys.join(", ") || "sem tarefa vinculada")}</span><time datetime="${escapeHtml(deployment.deployedAt)}">${escapeHtml(formatDate(deployment.deployedAt))}</time><small>${escapeHtml(deployment.principalName)}${deployment.notes ? ` · ${escapeHtml(deployment.notes)}` : ""}</small></li>`).join("");
    const sprintRows = snapshot.sprints.map((sprint) => `<li><strong>${escapeHtml(sprint.key)}</strong><span>${escapeHtml(sprint.title)}</span><small>${escapeHtml(stateLabel(sprint.status))} · ${escapeHtml(metricDate(sprint.startsOn))}–${escapeHtml(metricDate(sprint.endsOn))} · ${sprint.scopeItemCount} itens no escopo</small></li>`).join("");
    const milestoneRows = snapshot.milestones.map((milestone) => `<li><strong>${escapeHtml(milestone.key)}</strong><span>${escapeHtml(milestone.title)}</span><small>Meta ${escapeHtml(metricDate(milestone.targetDate))} · ${milestone.scopeItemCount} itens no escopo</small></li>`).join("");
    const activityRows = snapshot.activity.map((event) => `<li><time datetime="${escapeHtml(event.occurredAt)}">${escapeHtml(formatDate(event.occurredAt))}</time><strong>${escapeHtml(eventTitle(event))}</strong><span>${escapeHtml(event.entityType)} · ${escapeHtml(event.principalName)}</span><small>${escapeHtml(event.reason ?? event.eventType)}</small></li>`).join("");
    const resultTotal = Math.max(summary.testRunsTotal, 1);
    const resultLegend = [["passed", "Aprovado"], ["failed", "Reprovado"], ["blocked", "Bloqueado"], ["skipped", "Ignorado"]]
      .map(([key, label]) => `<span><i class="qa-swatch result-color-${key}" aria-hidden="true"></i>${label} <strong>${resultCounts[key] ?? 0}</strong> · ${Math.round((resultCounts[key] ?? 0) / resultTotal * 100)}%</span>`).join("");
    elements.historyContent.innerHTML = `
      <div class="history-summary-grid">${cards.map(([value, label]) => `<article class="history-summary-card"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></article>`).join("")}</div>
      <p class="history-limits"><strong>Escopo do retrato:</strong> estados e conteúdo publicado de PBIs, publicações de especificações/cenários, escopos de sprint/marco, execuções QA, sessões, releases e auditoria. Sessões abertas contam tempo até a consulta. Responsável de PBI, ordenação e estimativas não são apresentados como históricos porque esta visão não reconstrói esses campos. Métricas da aba própria continuam mostrando os indicadores definidos nela.</p>
      <section class="history-panel"><div class="history-panel-heading"><div><h3>Estado dos itens</h3><p>${snapshot.workItems.items.length} de ${summary.workItemsTotal} itens carregados · estados no fim do dia selecionado</p></div><span class="history-total">${summary.workItemsTotal} itens</span></div>
        <div class="history-state-grid">${stateRows}</div>
        ${snapshot.workItems.items.length ? `<div class="history-table-wrap"><table class="history-table"><thead><tr><th scope="col">Item de trabalho</th><th scope="col">Tipo</th><th scope="col">Estado no corte</th><th scope="col">Revisão</th></tr></thead><tbody>${itemRows}</tbody></table></div>` : `<div class="history-empty">Nenhum item existia nesta data.</div>`}
        <div class="history-more-wrap"><button id="history-load-more" class="button button-secondary" type="button" ${model.historyCursor && !model.historyLoading ? "" : "hidden"}>Carregar mais itens</button></div>
      </section>
      <div class="history-two-column">
        <section class="history-panel"><div class="history-panel-heading"><div><h3>Especificações</h3><p>Revisão mais recente publicada até o corte</p></div><span class="history-total">${summary.specificationsTotal}</span></div>${specRows ? `<ul class="history-entity-list">${specRows}</ul>` : `<div class="history-empty">Nenhuma especificação existia nesta data.</div>`}${snapshot.specificationsTruncated ? `<p class="history-truncated">Mostrando 200 especificações.</p>` : ""}</section>
        <section class="history-panel"><div class="history-panel-heading"><div><h3>Cenários</h3><p>Revisão mais recente publicada até o corte</p></div><span class="history-total">${summary.scenariosTotal}</span></div>${scenarioRows ? `<ul class="history-entity-list">${scenarioRows}</ul>` : `<div class="history-empty">Nenhum cenário existia nesta data.</div>`}${snapshot.scenariosTruncated ? `<p class="history-truncated">Mostrando 200 cenários.</p>` : ""}</section>
      </div>
      <section class="history-panel"><div class="history-panel-heading"><div><h3>Execuções QA até o corte</h3><p>Resultados imutáveis associados à data real da execução</p></div><span class="history-total">${summary.testRunsTotal}</span></div>${summary.testRunsTotal ? `<div class="history-result-legend">${resultLegend}</div><ul class="history-run-list">${runRows}</ul>${snapshot.testRunsTruncated ? `<p class="history-truncated">Mostrando as 200 execuções mais recentes.</p>` : ""}` : `<div class="history-empty">Nenhuma execução QA existia nesta data.</div>`}</section>
      <div class="history-two-column">
        <section class="history-panel"><div class="history-panel-heading"><div><h3>Sessões de desenvolvimento</h3><p>Estado reconstituído pelo log de iniciar, pausar, retomar e concluir</p></div><span class="history-total">${summary.developmentSessionsActive} ativas / ${summary.developmentSessionsTotal}</span></div>${sessionRows ? `<ul class="history-run-list history-session-list">${sessionRows}</ul>${snapshot.developmentSessionsTruncated ? `<p class="history-truncated">Mostrando as 200 sessões mais recentes.</p>` : ""}` : `<div class="history-empty">Nenhuma sessão existia nesta data.</div>`}</section>
        <section class="history-panel"><div class="history-panel-heading"><div><h3>Homologação e produção</h3><p>Eventos de release registrados até a data escolhida</p></div><span class="history-total">${summary.deploymentsTotal} eventos</span></div>${deploymentRows ? `<ul class="history-run-list history-deployment-list">${deploymentRows}</ul>${snapshot.deploymentsTruncated ? `<p class="history-truncated">Mostrando os 200 releases mais recentes.</p>` : ""}` : `<div class="history-empty">Nenhum evento de release existia nesta data.</div>`}</section>
      </div>
      <div class="history-two-column">
        <section class="history-panel"><div class="history-panel-heading"><div><h3>Sprints</h3><p>Estado e escopo reconstituídos pelas transições registradas</p></div><span class="history-total">${summary.sprintsTotal}</span></div>${sprintRows ? `<ul class="history-entity-list">${sprintRows}</ul>${snapshot.sprintsTruncated ? `<p class="history-truncated">Mostrando 200 sprints.</p>` : ""}` : `<div class="history-empty">Nenhuma sprint existia nesta data.</div>`}</section>
        <section class="history-panel"><div class="history-panel-heading"><div><h3>Marcos</h3><p>Escopo aprovado na data selecionada</p></div><span class="history-total">${summary.milestonesTotal}</span></div>${milestoneRows ? `<ul class="history-entity-list">${milestoneRows}</ul>${snapshot.milestonesTruncated ? `<p class="history-truncated">Mostrando 200 marcos.</p>` : ""}` : `<div class="history-empty">Nenhum marco existia nesta data.</div>`}</section>
      </div>
      <section class="history-panel"><div class="history-panel-heading"><div><h3>Atividade mais recente</h3><p>Até ${snapshot.activity.length} eventos auditados anteriores ao fim do corte</p></div></div>${activityRows ? `<ul class="history-activity-list">${activityRows}</ul>` : `<div class="history-empty">Nenhum evento auditado existia nesta data.</div>`}</section>`;
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
      elements.backlogList.innerHTML = `<div class="empty-state"><strong>${model.items.length ? "Nenhum item encontrado." : "O Product Backlog está vazio."}</strong><p>${model.items.length ? "Ajuste os filtros de busca ou tipo." : "Crie itens de trabalho pelo botão Novo PBI ou pelas ferramentas MCP."}</p></div>`;
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
    renderScenarioManager();
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

  function safeEvidenceUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  function renderScenarioManager() {
    const resultOrder = ["passed", "failed", "blocked", "skipped"];
    const resultLabels = { passed: "Aprovado", failed: "Reprovado", blocked: "Bloqueado", skipped: "Ignorado" };
    const resultColors = { passed: "#24815b", failed: "#c54b43", blocked: "#c3831d", skipped: "#8090a6" };
    const counts = Object.fromEntries(resultOrder.map((result) => [result, 0]));
    for (const run of model.testRuns) counts[run.result] = (counts[run.result] ?? 0) + 1;
    const total = model.testRuns.length;
    elements.qaRunChart.innerHTML = total === 0
      ? `<div class="empty-state"><strong>Sem execuções registradas.</strong><p>Crie e publique um cenário para registrar o primeiro resultado.</p></div>`
      : `<svg class="qa-result-chart" viewBox="0 0 600 42" role="img" aria-label="${resultOrder.map((result) => `${resultLabels[result]}: ${counts[result]}`).join(", ")}">${resultOrder.map((result, index) => {
        const prior = resultOrder.slice(0, index).reduce((sum, key) => sum + counts[key], 0);
        const x = prior / total * 600;
        const width = counts[result] / total * 600;
        return counts[result] ? `<rect x="${x}" y="4" width="${Math.max(width, 1)}" height="34" fill="${resultColors[result]}" rx="${index === 0 || prior + counts[result] === total ? 5 : 0}"><title>${resultLabels[result]}: ${counts[result]}</title></rect>` : "";
      }).join("")}</svg><div class="qa-chart-legend">${resultOrder.map((result) => `<span><i class="qa-swatch result-color-${result}" aria-hidden="true"></i>${resultLabels[result]} <strong>${counts[result]}</strong></span>`).join("")}</div>`;

    elements.scenarioList.innerHTML = model.scenarios.length === 0
      ? `<div class="empty-state"><strong>Nenhum cenário cadastrado.</strong><p>Crie um cenário e publique a primeira revisão para habilitar execuções.</p></div>`
      : model.scenarios.map((scenario) => {
        const hasDraft = scenario.latestRevision > (scenario.publishedRevision ?? 0);
        const publishButton = hasDraft
          ? `<button class="button button-secondary" type="button" data-publish-scenario="${escapeHtml(scenario.key)}" data-revision="${scenario.latestRevision}">Publicar r${scenario.latestRevision}</button>`
          : "";
        const reviseButton = scenario.publishedRevision !== null && !hasDraft
          ? `<button class="button button-secondary" type="button" data-revise-scenario="${escapeHtml(scenario.key)}">Propor revisão</button>`
          : "";
        const published = scenario.publishedRevision === null ? "Sem revisão publicada" : `Publicada r${scenario.publishedRevision}`;
        return `<article class="scenario-row"><div><strong>${escapeHtml(scenario.key)} · ${escapeHtml(scenario.title)}</strong><span>${escapeHtml(scenarioKindLabel(scenario.kind))} · ${escapeHtml(published)} · v${scenario.version}</span></div><div class="scenario-actions">${publishButton}${reviseButton}</div></article>`;
      }).join("");

    const publishedScenarios = model.scenarios.filter((scenario) => scenario.publishedRevision !== null);
    elements.testRunScenario.innerHTML = publishedScenarios.length
      ? publishedScenarios.map((scenario) => `<option value="${escapeHtml(scenario.id)}|${scenario.publishedRevision}">${escapeHtml(scenario.key)} · r${scenario.publishedRevision} · ${escapeHtml(scenario.title)}</option>`).join("")
      : `<option value="">Publique um cenário para continuar</option>`;
    elements.testRunScenario.disabled = publishedScenarios.length === 0;
    elements.submitTestRun.disabled = publishedScenarios.length === 0;
    elements.testRunHistory.innerHTML = total === 0
      ? ""
      : `<h4>Histórico recente</h4><div class="run-history-list">${model.testRuns.map((run) => {
        const evidenceUrl = safeEvidenceUrl(run.evidenceUri);
        const evidence = evidenceUrl ? `<a href="${escapeHtml(evidenceUrl)}" target="_blank" rel="noreferrer">Evidência</a>` : "";
        return `<article class="run-history-row"><span class="run-result result-${escapeHtml(run.result)}">${escapeHtml(resultLabels[run.result] ?? run.result)}</span><strong>${escapeHtml(run.scenarioKey)} · r${run.revisionNumber}</strong><span>${escapeHtml(run.buildId)}</span><time datetime="${escapeHtml(run.executedAt)}">${escapeHtml(new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(run.executedAt)))}</time>${evidence}</article>`;
      }).join("")}</div>`;
  }

  function eventTitle(event) {
    const titles = {
      "project.initialized": "Projeto inicializado",
      "work_item.created": "PBI criado",
      "work_item.assigned": "Responsável alterado",
      "work_item.comment_added": "Comentário adicionado",
      "work_item.estimate_proposed": "Estimativa proposta",
      "work_item.estimate_confirmed": "Estimativa confirmada",
      "work_item.ranked": "Ordem do item alterada",
      "work_item.state_transitioned": "Estado do PBI alterado",
      "work_item.evidence_added": "Evidência adicionada",
      "work_item.baseline_fixed": "Baseline criada",
      "work_item.baseline_revalidated": "Baseline revalidada",
      "test_run.recorded": "Execução de cenário registrada",
      "test_run.certified": "Execução certificada por QA",
      "work_item.revision_proposed": "Revisão de PBI proposta",
      "work_item.revision_published": "Conteúdo do PBI publicado",
      "specification.revision_proposed": "Revisão de especificação proposta",
      "specification.revision_published": "Especificação publicada",
      "milestone.created": "Marco criado",
      "milestone.scope_changed": "Escopo do marco alterado",
      "sprint.scope_changed": "Escopo da sprint alterado",
      "sprint.retrospective_recorded": "Retrospectiva registrada",
      "sprint.retrospective_revised": "Retrospectiva revisada",
      "project.definition_of_done_revised": "Definição de pronto revisada",
      "tool_approval.issued": "Aprovação de ferramenta emitida",
      "tool_approval.revoked": "Aprovação de ferramenta revogada",
      "external_identity.roles_granted": "Papéis de identidade concedidos",
      "external_identity.roles_revoked": "Papéis de identidade revogados",
      "roadmap_id.bound": "Identificador do roadmap associado",
      "trace_link.added": "Vínculo de rastreabilidade criado",
      "trace_link.removed": "Vínculo de rastreabilidade removido",
      "specification.created": "Especificação criada",
      "scenario.created": "Cenário de teste criado",
      "scenario.revision_proposed": "Revisão de cenário proposta",
      "scenario.revision_published": "Cenário publicado",
      "sprint.drafted": "Sprint planejada",
      "sprint.started": "Sprint iniciada",
      "sprint.closed": "Sprint encerrada",
      "sprint.cancelled": "Sprint cancelada",
      "development_session.started": "Sessão de desenvolvimento iniciada",
      "task.development_started": "Tarefa iniciada para desenvolvimento",
      "development_session.paused": "Sessão de desenvolvimento pausada",
      "development_session.resumed": "Sessão de desenvolvimento retomada",
      "development_session.completed": "Sessão de desenvolvimento concluída",
      "deployment.recorded": "Evento de implantação registrado",
    };
    return titles[event.eventType] ?? event.eventType;
  }

  function eventDetail(event) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const relatedEntities = Array.isArray(event.relatedEntities) ? event.relatedEntities : [];
    if (relatedEntities.length > 0) {
      const linkLabels = { depends_on: "depende de", relates_to: "relacionado a", implements: "implementa" };
      const relationship = linkLabels[payload.type] ?? "vinculado a";
      return relatedEntities.map((entity) => entity.label ?? entity.key ?? entity.entityType).join(" " + relationship + " ");
    }
    if (payload.fromState || payload.toState) {
      const version = payload.itemVersion ? ` · v${payload.itemVersion}` : "";
      const transitionId = payload.transitionId ? ` · transição ${String(payload.transitionId).slice(0, 8)}` : "";
      return `${stateLabel(payload.fromState ?? "")} → ${stateLabel(payload.toState ?? "")}${version}${transitionId}`;
    }
    if (payload.buildId) return `Build ${payload.buildId}`;
    if (payload.kind) return String(payload.kind);
    return event.entityReference?.label ?? event.entityType;
  }

  function renderActivityEvent(event, isTimeline = false) {
    const entityLabel = event.entityReference?.label ?? event.entityId;
    const openItemButton = event.entityType === "work_item"
      ? `<button class="event-entity" type="button" data-open-item="${escapeHtml(event.entityId)}" title="${escapeHtml(entityLabel)}">${escapeHtml(entityLabel)}</button>`
      : `<span class="event-entity" title="${escapeHtml(event.entityId)}">${escapeHtml(entityLabel)}</span>`;
    const reason = event.reason ? escapeHtml(event.reason) : escapeHtml(eventDetail(event));
    return `<article class="${isTimeline ? "timeline-event" : "activity-event"}">
      <span class="event-time">${escapeHtml(formatDate(event.occurredAt))} · #${escapeHtml(event.sequence)}</span>
      <p class="event-title">${escapeHtml(eventTitle(event))}</p>
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

  const specificationRevisionStatusLabels = {
    draft: "Rascunho",
    in_review: "Em revisão",
    published: "Publicada",
    superseded: "Substituída",
    withdrawn: "Retirada",
  };
  const specificationContentLabels = {
    summary: "Resumo",
    description: "Descrição",
    context: "Contexto",
    decision: "Decisão",
    consequences: "Consequências",
    alternatives: "Alternativas",
    rationale: "Justificativa",
    status: "Status",
    rules: "Regras",
    rule: "Regra",
    terms: "Termos",
    term: "Termo",
    definition: "Definição",
    contract: "Contrato",
    endpoints: "Endpoints",
    request: "Requisição",
    response: "Resposta",
    errors: "Erros",
    requirements: "Requisitos",
    requirement: "Requisito",
    category: "Categoria",
    target: "Alvo",
    metric: "Métrica",
    constraints: "Restrições",
    assumptions: "Premissas",
    references: "Referências",
    sourceReferences: "Referências de origem",
    version: "Versão",
    schemaVersion: "Versão do schema",
    title: "Título",
    name: "Nome",
    id: "ID",
    key: "Chave",
    type: "Tipo",
    priority: "Prioridade",
    owner: "Responsável",
    transport: "Transporte",
    identity: "Identidade",
    profiles: "Perfis",
    toolContracts: "Contratos de ferramentas",
    taskContext: "Contexto de tarefa",
    dashboard: "Dashboard",
    traceability: "Rastreabilidade",
    filtering: "Filtragem",
    authorization: "Autorização",
    projectSelection: "Seleção de projeto",
    stdio: "stdio",
    streamableHttp: "HTTP",
    scope: "Escopo",
    purpose: "Propósito",
    behavior: "Comportamento",
    notes: "Notas",
    example: "Exemplo",
    examples: "Exemplos",
    values: "Valores",
    fields: "Campos",
    attributes: "Atributos",
    ownerRole: "Papel responsável",
    linkedTasks: "Tarefas vinculadas",
    implementation: "Implementação",
    validation: "Validação",
    limits: "Limites",
    openQuestions: "Questões abertas",
    glossary: "Glossário",
  };

  function specificationRevisionStatusLabel(status) {
    return specificationRevisionStatusLabels[status] ?? status;
  }

  function specificationFieldLabel(key) {
    if (specificationContentLabels[key]) return specificationContentLabels[key];
    const spaced = String(key)
      .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .replace(/[_-]+/gu, " ")
      .trim();
    return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : String(key);
  }

  function renderSpecificationScalar(value) {
    if (value === null || value === undefined) return '<span class="specification-empty">—</span>';
    if (typeof value === "boolean") return value ? "Sim" : "Não";
    if (typeof value === "object") return JSON.stringify(value);
    return escapeHtml(String(value));
  }

  function renderSpecificationValue(value) {
    if (value === null || value === undefined) return '<span class="specification-empty">—</span>';
    if (typeof value !== "object") return `<span class="specification-scalar">${renderSpecificationScalar(value)}</span>`;
    if (Array.isArray(value)) {
      if (value.length === 0) return '<span class="specification-empty">Nenhum item.</span>';
      const isPrimitive = value.every((item) => item === null || typeof item !== "object");
      if (isPrimitive) {
        return `<ul class="specification-inline-list">${value.map((item) => `<li>${renderSpecificationScalar(item)}</li>`).join("")}</ul>`;
      }
      return `<ol class="specification-array">${value.map((item) => `<li>${renderSpecificationValue(item)}</li>`).join("")}</ol>`;
    }
    const entries = Object.entries(value);
    if (entries.length === 0) return '<span class="specification-empty">Sem conteúdo.</span>';
    return `<dl class="specification-fields">${entries.map(([childKey, childValue]) => `<div class="specification-field"><dt>${escapeHtml(specificationFieldLabel(childKey))}</dt><dd>${renderSpecificationValue(childValue)}</dd></div>`).join("")}</dl>`;
  }

  function renderSpecifications() {
    const specifications = model.specifications;
    const filtered = Boolean(model.specificationKind || model.specificationSearch.trim());
    elements.specificationsCount.textContent = `${specifications.length} ${specifications.length === 1 ? "especificação" : "especificações"}`;
    elements.specificationsMeta.textContent = specifications.length
      ? `${specifications.length} ${specifications.length === 1 ? "especificação" : "especificações"}${filtered ? " no filtro atual" : ""} · catálogo somente leitura · autoria pelo MCP`
      : filtered ? "Nenhuma especificação corresponde ao filtro atual." : "Nenhuma especificação registrada no projeto.";
    if (!specifications.length) {
      elements.specificationList.innerHTML = `<div class="empty-state"><strong>${filtered ? "Nenhuma especificação corresponde ao filtro." : "Ainda não há especificações registradas."}</strong><p>${filtered ? "Ajuste o tipo ou a busca para consultar o catálogo." : "Registre regras, glossários, contratos, ADRs e requisitos pelo MCP com spec_create e publique as revisões lá."}</p></div>`;
      renderSpecificationDetail();
      return;
    }
    elements.specificationList.innerHTML = specifications.map((specification) => {
      const published = specification.publishedRevision === null
        ? "Sem publicação vigente"
        : `Publicada r${specification.publishedRevision}`;
      const latestNote = specification.latestStatus === "draft"
        ? "rascunho pendente"
        : specification.latestStatus === "in_review"
          ? "em revisão"
          : specification.latestStatus === "superseded"
            ? "última revisão substituída"
            : specification.latestStatus === "withdrawn"
              ? "última revisão retirada"
              : "";
      const selected = model.currentSpecification?.key === specification.key;
      return `<article class="specification-row${selected ? " is-selected" : ""}">
        <div class="specification-row-main">
          <span class="specification-key">${escapeHtml(specification.key)}</span>
          <strong>${escapeHtml(specification.title)}</strong>
          <span class="specification-row-meta">${escapeHtml(specificationKindLabel(specification.kind))} · ${escapeHtml(published)} · r${specification.latestRevision}${latestNote ? ` · ${escapeHtml(latestNote)}` : ""}</span>
        </div>
        <button class="row-open" type="button" data-open-specification="${escapeHtml(specification.key)}" aria-label="Abrir ${escapeHtml(specification.key)}">›</button>
      </article>`;
    }).join("");
    renderSpecificationDetail();
  }

  function renderSpecificationNotice(specification, selectedRevision) {
    if (!selectedRevision || selectedRevision.status === "published") return "";
    const revisionLabel = `r${selectedRevision.revisionNumber} (${specificationRevisionStatusLabel(selectedRevision.status)})`;
    if (selectedRevision.status === "superseded") {
      const replacement = specification.publishedRevision === null
        ? "Consulte o catálogo para identificar a publicação vigente."
        : `A publicação vigente é r${specification.publishedRevision}.`;
      return `<p class="specification-warning specification-notice-historical" role="status"><strong>Revisão histórica (substituída).</strong> Você está lendo ${escapeHtml(revisionLabel)}, que já foi publicada e depois substituída. ${escapeHtml(replacement)} O conteúdo é mantido apenas para consulta.</p>`;
    }
    if (selectedRevision.status === "withdrawn") {
      const current = specification.publishedRevision === null
        ? "Não há publicação vigente nesta especificação."
        : `A publicação vigente continua sendo r${specification.publishedRevision}.`;
      return `<p class="specification-warning specification-notice-historical" role="status"><strong>Revisão retirada.</strong> Você está lendo ${escapeHtml(revisionLabel)}, retirada do catálogo. ${escapeHtml(current)}</p>`;
    }
    const unpublishedExplanation = specification.publishedRevision === null
      ? "Esta especificação ainda não tem revisão publicada; o conteúdo exibido é apenas a revisão selecionada."
      : `Esse conteúdo não substitui a última revisão publicada (r${specification.publishedRevision}).`;
    return `<p class="specification-warning" role="status"><strong>Revisão não publicada.</strong> Você está lendo ${escapeHtml(revisionLabel)}. ${escapeHtml(unpublishedExplanation)}</p>`;
  }

  function renderSpecificationDetail() {
    const specification = model.currentSpecification;
    if (!specification) {
      elements.specificationDetail.hidden = true;
      elements.specificationDetail.innerHTML = "";
      return;
    }
    const revisions = specification.revisions ?? [];
    const selectedRevision = revisions.find((revision) => revision.revisionNumber === model.selectedSpecificationRevisionNumber)
      ?? revisions.at(-1)
      ?? null;
    const publishedLabel = specification.publishedRevision === null
      ? "Sem publicação vigente"
      : `Publicação vigente r${specification.publishedRevision}`;
    const revisionRows = revisions.length
      ? revisions.map((revision) => `<li><button class="specification-revision${revision.revisionNumber === selectedRevision?.revisionNumber ? " is-selected" : ""}" type="button" data-spec-revision="${revision.revisionNumber}" aria-pressed="${revision.revisionNumber === selectedRevision?.revisionNumber}"><span class="specification-revision-number">r${revision.revisionNumber}</span><span class="specification-revision-status status-${escapeHtml(revision.status)}">${escapeHtml(specificationRevisionStatusLabel(revision.status))}</span><time datetime="${escapeHtml(revision.createdAt)}">${escapeHtml(formatDate(revision.createdAt))}</time></button></li>`).join("")
      : "<li class=\"specification-empty\">Nenhuma revisão registrada.</li>";
    elements.specificationDetail.hidden = false;
    elements.specificationDetail.innerHTML = `
      <div class="specification-detail-header">
        <div>
          <p class="eyebrow">${escapeHtml(specificationKindLabel(specification.kind))}</p>
          <h3>${escapeHtml(specification.key)} · ${escapeHtml(specification.title)}</h3>
          <p class="specification-detail-meta">Versão ${escapeHtml(specification.version)} · ${escapeHtml(publishedLabel)} · criada em ${escapeHtml(formatDate(specification.createdAt))}</p>
        </div>
        <button class="icon-button" type="button" data-close-specification aria-label="Fechar detalhe da especificação">×</button>
      </div>
      ${renderSpecificationNotice(specification, selectedRevision)}
      <div class="specification-content">${renderSpecificationValue(selectedRevision?.content ?? {})}</div>
      <section class="specification-revisions-list" aria-label="Revisões da especificação"><h4>Revisões (${revisions.length})</h4><ul>${revisionRows}</ul></section>`;
  }

  async function openSpecification(key) {
    if (!model.projectId) return;
    const projectId = model.projectId;
    elements.specificationDetail.hidden = false;
    elements.specificationDetail.innerHTML = `<div class="empty-state"><span class="loading-dot" aria-hidden="true"></span><p>Carregando ${escapeHtml(key)}…</p></div>`;
    try {
      const result = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/specifications/${encodeURIComponent(key)}`);
      if (projectId !== model.projectId) return;
      model.currentSpecification = result.specification;
      model.selectedSpecificationRevisionNumber = result.specification.revisions.at(-1)?.revisionNumber ?? null;
      renderSpecifications();
      elements.specificationDetail.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch (error) {
      if (projectId !== model.projectId) return;
      model.currentSpecification = null;
      model.selectedSpecificationRevisionNumber = null;
      renderSpecifications();
      elements.specificationDetail.hidden = false;
      elements.specificationDetail.innerHTML = `<div class="empty-state error-state"><strong>Não foi possível abrir ${escapeHtml(key)}.</strong><p>${escapeHtml(error.code ?? "ERRO")}: ${escapeHtml(error.message)}</p></div>`;
    }
  }

  function metricNumber(value) {
    return value === null || value === undefined
      ? "—"
      : metricNumberFormatter.format(value);
  }

  function metricDate(value) {
    if (!value) return "—";
    return metricDateFormatter.format(new Date(`${value}T12:00:00.000Z`));
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

  function medianMetric(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  }

  function signedMetric(value) {
    return `${value > 0 ? "+" : ""}${metricNumber(value)}`;
  }

  function renderSprintSnapshot(sprintMetrics) {
    const lastPoint = sprintMetrics?.series.at(-1);
    if (!sprintMetrics || !lastPoint) return "";
    const scopeChanges = sprintMetrics.series.reduce((total, point) => ({
      added: total.added + point.addedPoints,
      removed: total.removed + point.removedPoints,
      reestimated: total.reestimated + point.reestimatedPoints,
    }), { added: 0, removed: 0, reestimated: 0 });
    return `<div class="sprint-snapshot-grid" aria-label="Resumo do escopo da sprint até o corte">
      <div class="sprint-snapshot-cell"><span>Compromisso inicial</span><strong>${escapeHtml(metricNumber(sprintMetrics.plannedScopePoints))} pts</strong></div>
      <div class="sprint-snapshot-cell"><span>Escopo no corte</span><strong>${escapeHtml(metricNumber(lastPoint.scopePoints))} pts</strong></div>
      <div class="sprint-snapshot-cell"><span>Concluído no corte</span><strong>${escapeHtml(metricNumber(lastPoint.completedPoints))} pts</strong></div>
      <div class="sprint-snapshot-cell"><span>Mudanças acumuladas</span><strong>+${escapeHtml(metricNumber(scopeChanges.added))} / −${escapeHtml(metricNumber(scopeChanges.removed))} pts</strong><small>Reestimativa líquida ${escapeHtml(signedMetric(scopeChanges.reestimated))} pts</small></div>
    </div>`;
  }

  function renderSprintComparison(sprintMetrics, data, windowSize) {
    if (!sprintMetrics) return `<div class="sprint-comparison"><strong>Comparação com sprints anteriores</strong><p>Selecione uma sprint para calcular a referência histórica.</p></div>`;
    if (sprintMetrics.status !== "closed") {
      return `<div class="sprint-comparison"><strong>Comparação com sprints anteriores</strong><p>A sprint selecionada ainda não está encerrada; a comparação usa somente pontos aceitos em sprints fechadas.</p></div>`;
    }
    if (!data.selectedTeamId || data.selectedTeamGenerationNumber === null) {
      return `<div class="sprint-comparison"><strong>Comparação com sprints anteriores</strong><p>Não há uma geração de time configurada no corte; a comparação fica indisponível para evitar misturar equipes ou gerações.</p></div>`;
    }
    if (data.selectedTeamGenerationNumber !== null && sprintMetrics.teamGenerationNumber !== data.selectedTeamGenerationNumber) {
      return `<div class="sprint-comparison"><strong>Comparação com sprints anteriores</strong><p>Esta sprint pertence à geração ${escapeHtml(sprintMetrics.teamGenerationNumber)}. A amostra atual é da geração ${escapeHtml(data.selectedTeamGenerationNumber)}; as gerações não são misturadas.</p></div>`;
    }
    const selected = data.velocity.sprints.find((entry) => entry.sprintId === sprintMetrics.sprintId);
    if (!selected) {
      return `<div class="sprint-comparison"><strong>Comparação com sprints anteriores</strong><p>A sprint não está entre as até 12 sprints comparáveis disponíveis neste corte.</p></div>`;
    }
    const previous = data.velocity.sprints.filter((entry) => entry.teamId === selected.teamId &&
      entry.teamGenerationNumber === selected.teamGenerationNumber && entry.closedAt < selected.closedAt).slice(-windowSize);
    if (!previous.length) {
      return `<div class="sprint-comparison"><strong>Comparação com sprints anteriores</strong><p>${escapeHtml(selected.sprintKey)}: ${escapeHtml(metricNumber(selected.deliveredPoints))} pts aceitos. Não há sprint anterior comparável nesta geração.</p></div>`;
    }
    const previousMedian = medianMetric(previous.map((entry) => entry.deliveredPoints));
    const delta = selected.deliveredPoints - previousMedian;
    return `<div class="sprint-comparison"><strong>Comparação de entregas aceitas</strong><p>${escapeHtml(selected.sprintKey)} entregou ${escapeHtml(metricNumber(selected.deliveredPoints))} pts; a mediana das ${previous.length} sprints anteriores comparáveis foi ${escapeHtml(metricNumber(previousMedian))} pts. Diferença: ${escapeHtml(signedMetric(delta))} pts.</p></div>`;
  }

  function renderMetrics() {
    const data = model.dashboardMetrics;
    if (!data) return;
    elements.metricsMilestone.innerHTML = `<option value="none">Sem marco</option>${data.milestones.map((milestone) => `<option value="${escapeHtml(milestone.id)}">${escapeHtml(milestone.key)} · ${escapeHtml(milestone.title)}</option>`).join("")}`;
    elements.metricsSprint.innerHTML = `<option value="none">Sem sprint</option>${data.sprints.map((sprint) => `<option value="${escapeHtml(sprint.id)}">${escapeHtml(sprint.key)} · ${escapeHtml(stateLabel(sprint.status))}</option>`).join("")}`;
    elements.metricsMilestone.value = model.selectedMetricsMilestoneId ?? data.selectedMilestoneId ?? "none";
    elements.metricsSprint.value = model.selectedMetricsSprintId ?? data.selectedSprintId ?? "none";
    elements.metricsDate.value = model.selectedMetricsDate ?? data.asOfDate;
    elements.metricsEffortFrom.value = model.developerMetricsFrom ?? "";
    elements.metricsEffortTo.value = model.developerMetricsTo ?? "";
    elements.metricsEffortTo.max = data.asOfDate;
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
    const velocityWindow = [4, 8, 12].includes(model.metricsVelocityWindow) ? model.metricsVelocityWindow : 8;
    model.metricsVelocityWindow = velocityWindow;
    const sameGenerationSprints = data.selectedTeamId === null || data.selectedTeamGenerationNumber === null
      ? []
      : data.velocity.sprints.filter((sprint) => sprint.teamId === data.selectedTeamId &&
        sprint.teamGenerationNumber === data.selectedTeamGenerationNumber);
    const visibleVelocitySprints = sameGenerationSprints.slice(-velocityWindow);
    const velocityPoints = visibleVelocitySprints.map((sprint) => sprint.deliveredPoints);
    const velocityAverage = velocityPoints.length ? velocityPoints.reduce((total, points) => total + points, 0) / velocityPoints.length : null;
    const velocityMedian = medianMetric(velocityPoints);
    const velocityRows = [...visibleVelocitySprints].reverse().map((sprint) => `<tr><td>${escapeHtml(sprint.sprintKey)}</td><td>${escapeHtml(metricDate(metricTimestampDate(sprint.closedAt)))}</td><td>${escapeHtml(metricNumber(sprint.deliveredPoints))} pts</td><td>${escapeHtml(metricNumber(sprint.capacityHours))} h</td><td>${escapeHtml(metricNumber(sprint.pointsPerHour))} pts/h</td></tr>`).join("");
    const velocitySeries = visibleVelocitySprints.map((sprint) => ({ date: metricTimestampDate(sprint.closedAt), deliveredPoints: sprint.deliveredPoints }));
    const developerMetrics = data.developerExecutionMetrics;
    const developers = developerMetrics?.developers ?? [];
    if (model.selectedMetricsDeveloperId && !developers.some((developer) => developer.principalId === model.selectedMetricsDeveloperId)) {
      model.selectedMetricsDeveloperId = null;
    }
    elements.metricsDeveloper.innerHTML = `<option value="">Todos os desenvolvedores</option>${developers.map((developer) => `<option value="${escapeHtml(developer.principalId)}">${escapeHtml(developer.name)}</option>`).join("")}`;
    elements.metricsDeveloper.value = model.selectedMetricsDeveloperId ?? "";
    const visibleDevelopers = developers.filter((developer) => !model.selectedMetricsDeveloperId || developer.principalId === model.selectedMetricsDeveloperId);
    const developerRows = visibleDevelopers.map((developer) => `<tr><td>${escapeHtml(developer.name)}</td><td>${developer.completedTasks}</td><td>${escapeHtml(metricNumber(developer.activeHours))} h</td><td>${escapeHtml(metricNumber(developer.activeHoursOnEstimatedCompletedTasks))} h</td><td>${escapeHtml(metricNumber(developer.estimatedHoursOnCompletedTasks))} h</td><td>${developer.effortCalibrationFactor === null ? "—" : `${escapeHtml(metricNumber(developer.effortCalibrationFactor))}×`}</td><td>${developer.estimateVariancePercent === null ? "—" : `${developer.estimateVariancePercent > 0 ? "+" : ""}${escapeHtml(metricNumber(developer.estimateVariancePercent))}%`}</td><td>${developer.sampleSufficient ? `${developer.estimatedCompletedTasks} tarefas estimadas` : `Amostra baixa · ${developer.estimatedCompletedTasks}/${developerMetrics.minimumSampleTasks} estimadas`}</td></tr>`).join("");
    const wipRows = data.wip.items.slice(0, 20).map((item) => `<tr><td><button class="metric-item-link" type="button" data-open-item="${escapeHtml(item.itemId)}">${escapeHtml(item.itemKey)}</button><span>${escapeHtml(item.title)}</span></td><td>${escapeHtml(stateLabel(item.state))}</td><td>${item.ageDays} dias</td><td>${item.openImpactCount ? `<span class="blocker-pill">${item.openImpactCount} impacto(s)</span>` : "—"}</td></tr>`).join("");
    const coverageRows = coverage.items.slice(0, 20).map((item) => `<tr><td><button class="metric-item-link" type="button" data-open-item="${escapeHtml(item.itemId)}">${escapeHtml(item.itemKey)}</button><span>${escapeHtml(item.title)}</span></td><td>${item.coveredRequiredCriteria}/${item.requiredCriteria}</td><td>${item.certifiedRequiredCriteria}/${item.requiredCriteria}</td><td>${item.hasOpenImpact ? `<span class="blocker-pill">Impacto</span>` : "—"}</td></tr>`).join("");
    elements.metricsContent.innerHTML = `
      <p class="metrics-cut-note">O corte histórico se aplica às séries de marco/sprint, à velocidade e à previsão. WIP e cobertura mostram o estado atual observado em ${escapeHtml(formatDate(data.observedAt))}; eles não são reconstruídos para uma data passada.</p>
      <div class="metric-kpi-grid">${kpis}</div>
      <div class="metrics-grid">
        <article class="metrics-panel"><div class="metrics-panel-heading"><div><p class="eyebrow">EXECUTIVO</p><h3>${burnup ? `${escapeHtml(burnup.milestoneKey)} · ${escapeHtml(data.milestones.find((entry) => entry.id === burnup.milestoneId)?.title ?? "Marco")}` : "Burnup do marco"}</h3><p>Pontos no escopo, entregues e restantes. Pontos representam estimativa relativa.</p></div><span class="unit-tag">pontos</span></div>${renderMetricChart(burnup?.series, [{ key: "scopePoints", label: "Escopo", className: "scope" }, { key: "completedPoints", label: "Concluído", className: "completed" }, { key: "remainingPoints", label: "Restante", className: "remaining" }], "Burnup do marco")}</article>
        <article class="metrics-panel"><div class="metrics-panel-heading"><div><p class="eyebrow">EXECUTIVO</p><h3>${data.sprintMetrics ? `${escapeHtml(data.sprintMetrics.sprintKey)} · Burndown` : "Burndown da sprint"}</h3><p>Restante real e linha ideal a partir do escopo congelado no início.</p></div><span class="unit-tag">pontos</span></div>${renderMetricChart(data.sprintMetrics?.series, [{ key: "remainingPoints", label: "Restante", className: "remaining" }, { key: "idealRemainingPoints", label: "Ideal", className: "ideal" }], "Burndown da sprint")}${renderSprintSnapshot(data.sprintMetrics)}${renderSprintComparison(data.sprintMetrics, data, velocityWindow)}</article>
        <article class="metrics-panel metrics-panel-wide"><div class="metrics-panel-heading"><div><p class="eyebrow">EXECUTIVO</p><h3>Previsão Monte Carlo</h3><p>Distribuição empírica de sprints comparáveis, com capacidade futura e chance até a meta. Story points não são convertidos em horas.</p></div><span class="unit-tag">${data.forecast?.remainingPoints === undefined ? "sem marco" : `${escapeHtml(metricNumber(data.forecast.remainingPoints))} pts restantes`}</span></div>${renderForecastPanel(data.forecast)}</article>
        <article class="metrics-panel metrics-panel-wide"><div class="metrics-panel-heading"><div><p class="eyebrow">DRILL-DOWN · MARCO</p><h3>Composição do burnup</h3><p>Totais reconstruídos a partir dos PBIs ativos no corte selecionado.</p></div><span class="unit-tag">${burnupPoint ? escapeHtml(metricDate(burnupPoint.date)) : "sem série"}</span></div>${renderScopeBreakdown("Escopo aprovado", burnup?.series ?? [], milestoneItems, data.asOfDate, "milestone")}</article>
        <article class="metrics-panel metrics-panel-wide"><div class="metrics-panel-heading"><div><p class="eyebrow">DRILL-DOWN · SPRINT</p><h3>Itens do burndown</h3><p>O estado e os pontos correspondem ao último dia da série exibida.</p></div><span class="unit-tag">${data.sprintMetrics?.series.length ? escapeHtml(metricDate(data.sprintMetrics.series.at(-1).date)) : "sem série"}</span></div>${renderScopeBreakdown("Escopo da sprint", data.sprintMetrics?.series ?? [], data.sprintMetrics?.items ?? [], data.asOfDate, "sprint")}</article>
        <article class="metrics-panel"><div class="metrics-panel-heading"><div><p class="eyebrow">TÉCNICO</p><h3>WIP e bloqueios</h3><p>Idade desde a entrada no estado; bloqueios por impacto de especificação.</p></div><span class="unit-tag">${data.wip.totalWipCount} itens</span></div><div class="metric-table-wrap"><table class="metric-table"><thead><tr><th>Item</th><th>Estado</th><th>Idade</th><th>Bloqueio</th></tr></thead><tbody>${wipRows || `<tr><td colspan="4">Nenhum item em andamento.</td></tr>`}</tbody></table></div>${data.wip.itemsTruncated ? `<p class="table-note">Lista limitada a ${data.wip.items.length} itens; o total considera todo o projeto.</p>` : ""}</article>
        <article class="metrics-panel"><div class="metrics-panel-heading"><div><p class="eyebrow">TÉCNICO</p><h3>Cobertura de critérios</h3><p>Critérios cobertos e certificações aprovadas por build.</p></div><span class="unit-tag">${coverage.coveragePercent === null ? "—" : `${coverage.coveragePercent}%`}</span></div><div class="metric-table-wrap"><table class="metric-table"><thead><tr><th>PBI</th><th>Cobertos</th><th>Certificados</th><th>Impacto</th></tr></thead><tbody>${coverageRows || `<tr><td colspan="4">Nenhum critério obrigatório para analisar.</td></tr>`}</tbody></table></div>${coverage.itemsTotal > 20 ? `<p class="table-note">Exibindo 20 de ${coverage.itemsTotal} PBIs; os detalhes estão limitados a ${coverage.items.length}. Totais consideram todo o projeto.</p>` : ""}</article>
        <article class="metrics-panel metrics-panel-wide"><div class="metrics-panel-heading"><div><p class="eyebrow">TÉCNICO</p><h3>Velocidade recente</h3><p>Pontos aceitos por sprint até o corte · geração ${escapeHtml(data.selectedTeamGenerationNumber ?? "indisponível")}. A comparação usa até ${velocityWindow} sprints desta geração.</p></div><label class="metrics-window-control" for="metrics-velocity-window">Janela<select id="metrics-velocity-window"><option value="4" ${velocityWindow === 4 ? "selected" : ""}>4 sprints</option><option value="8" ${velocityWindow === 8 ? "selected" : ""}>8 sprints</option><option value="12" ${velocityWindow === 12 ? "selected" : ""}>12 sprints</option></select></label></div><span class="unit-tag">${visibleVelocitySprints.length}/${velocityWindow} sprints · média ${escapeHtml(metricNumber(velocityAverage))} · mediana ${escapeHtml(metricNumber(velocityMedian))} pts/sprint</span>${renderMetricChart(velocitySeries, [{ key: "deliveredPoints", label: "Pontos aceitos", className: "completed" }], "Velocidade por sprint")}<div class="metric-table-wrap"><table class="metric-table"><thead><tr><th>Sprint</th><th>Fechada</th><th>Entregue</th><th>Capacidade</th><th>Pts/h · ref.</th></tr></thead><tbody>${velocityRows || `<tr><td colspan="5">Nenhuma sprint comparável fechada até esta data de corte.</td></tr>`}</tbody></table></div><p class="table-note">Capacidade e pts/h são referências descritivas; pts/h não converte pontos em esforço nem alimenta a previsão v2. Uma sprint sem entrega permanece na média e na mediana como zero.</p></article>
        <article class="metrics-panel metrics-panel-wide"><div class="metrics-panel-heading"><div><p class="eyebrow">FLUXO DE DESENVOLVIMENTO</p><h3>Esforço por desenvolvedor</h3><p>${developerMetrics ? `${escapeHtml(metricDate(developerMetrics.period.from))}–${escapeHtml(metricDate(developerMetrics.period.to))} · datas no fuso do projeto · período limitado ao corte` : "Dados de sessões de desenvolvimento"}</p></div><span class="unit-tag">Horas e tarefas</span></div><div class="metric-table-wrap"><table class="metric-table"><thead><tr><th>Desenvolvedor</th><th>Tarefas concluídas</th><th>Horas ativas no período</th><th>Horas em tarefas estimadas</th><th>Estimativa confirmada</th><th>Fator de calibração</th><th>Variação</th><th>Amostra</th></tr></thead><tbody>${developerRows || `<tr><td colspan="8">Nenhuma tarefa concluída ou sessão no período para este filtro.</td></tr>`}</tbody></table></div><p class="table-note">A variação e o fator comparam horas de sessão com horas estimadas nas mesmas tarefas concluídas e estimadas. Só exibimos o fator com pelo menos ${developerMetrics?.minimumSampleTasks ?? 5} tarefas estimadas. Sessões ativas consideram o período escolhido; esforço e estimativas da coorte usam sessões encerradas até cada conclusão. A métrica apoia planejamento, não ranking nem ajuste automático. Velocidade do time é medida em story points.</p></article>
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

  function renderTaskContext(context) {
    if (!context) return "";
    const labels = {
      hierarchy: "Hierarquia e descrição",
      acceptanceCriteria: "Critérios de aceite",
      businessRules: "Regras de negócio",
      technicalDecisions: "Especificações e decisões técnicas",
      scenarios: "Cenários de teste",
      testRuns: "Execuções de teste",
      baseline: "Baseline",
    };
    const relationshipLabels = {
      parent_baseline: "fixado na baseline do PBI",
      hierarchy_link: "herdado da hierarquia",
      task_direct_link: "vinculado diretamente à tarefa",
      scenario_coverage: "cobertura de requisito",
      task_run_link: "execução vinculada diretamente à tarefa",
    };
    const warnings = context.warnings.length
      ? `<ul class="context-warnings">${context.warnings.map((warning) => `<li><strong>${escapeHtml(warning.code)}</strong>${warning.key ? ` · ${escapeHtml(warning.key)}` : ""}: ${escapeHtml(warning.message)}</li>`).join("")}</ul>`
      : "<p>Sem alertas de baseline ou rastreabilidade.</p>";
    const sections = Object.entries(labels).map(([key, label]) => {
      const entries = context.sections[key] ?? [];
      const content = entries.length ? entries.map((entry) => {
        const source = entry.source;
        const revision = source.revisionNumber === null ? "" : ` · r${source.revisionNumber}`;
        const linkType = source.traceLinkType === "implements" ? " · implementa" : source.traceLinkType === "relates_to" ? " · relacionado" : "";
        const relationship = source.relationship ? ` · ${relationshipLabels[source.relationship] ?? source.relationship}` : "";
        const mode = source.mode === "pinned" ? " · versão fixada" : " · versão corrente";
        return `<article class="task-context-entry"><div><strong>${escapeHtml(entry.key)} · ${escapeHtml(entry.title)}</strong><span>${escapeHtml(`${revision}${relationship}${linkType}${mode}`)}</span></div><pre>${escapeHtml(JSON.stringify(entry.content, null, 2))}</pre></article>`;
      }).join("") : "<p>Nenhum registro relacionado.</p>";
      return `<section class="detail-section"><h4>${escapeHtml(label)} · ${entries.length}</h4>${content}</section>`;
    }).join("");
    const more = context.nextCursor
      ? `<button class="button button-secondary" type="button" data-load-task-context>Carregar mais contexto</button>`
      : "";
    return `<section id="task-context-report" class="detail-section"><h3>Contexto para desenvolvimento · ${escapeHtml(context.mode === "pinned" ? "baseline fixada" : "preview corrente")}</h3>${warnings}${sections}${context.truncated ? "<p>O contexto está paginado; carregue as próximas entradas para ver todos os vínculos.</p>" : ""}${more}</section>`;
  }

  async function loadMoreTaskContext(button) {
    const context = model.currentTaskContext;
    const item = model.currentItem;
    if (!context?.nextCursor || !item) return;
    button.disabled = true;
    button.textContent = "Carregando…";
    try {
      const params = new URLSearchParams({ profile: "dev", maxChars: "30000", cursor: context.nextCursor });
      for (const section of ["hierarchy", "acceptanceCriteria", "businessRules", "technicalDecisions", "scenarios", "testRuns", "baseline"]) {
        params.append("include", section);
      }
      const next = await api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/work-items/${encodeURIComponent(item.id)}/context?${params}`);
      const mergedSections = Object.fromEntries(Object.keys(context.sections).map((section) => [
        section,
        [...context.sections[section], ...next.sections[section]],
      ]));
      model.currentTaskContext = {
        ...next,
        sections: mergedSections,
        warnings: [...new Map([...context.warnings, ...next.warnings].map((warning) => [`${warning.code}:${warning.key ?? ""}`, warning])).values()],
      };
      const report = document.querySelector("#task-context-report");
      if (report) report.outerHTML = renderTaskContext(model.currentTaskContext);
    } catch (error) {
      toast(`${error.code ?? "ERRO"}: ${error.message}`, true);
      button.disabled = false;
      button.textContent = "Carregar mais contexto";
    }
  }

  function renderTaskExecution(item, sessions, events) {
    if (item.type !== "task") return "";
    const latestSuccessful = (environment) => events
      .filter((event) => event.environment === environment && event.outcome === "succeeded")
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0] ?? null;
    const firstSession = [...sessions].sort((left, right) => left.startedAt.localeCompare(right.startedAt))[0] ?? null;
    const lastCompletedSession = sessions
      .filter((session) => session.status === "completed" && session.endedAt)
      .sort((left, right) => right.endedAt.localeCompare(left.endedAt))[0] ?? null;
    const homologation = latestSuccessful("homologation");
    const production = latestSuccessful("production");
    const dateValue = (value) => value ? formatDate(value) : "Ainda não registrada";
    const dateCards = [
      ["Início do desenvolvimento", firstSession?.startedAt],
      ["Fim do desenvolvimento", lastCompletedSession?.endedAt],
      ["Última homologação aprovada", homologation?.occurredAt],
      ["Última produção aprovada", production?.occurredAt],
    ].map(([label, value]) => `<div class="detail-date-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(dateValue(value))}</strong></div>`).join("");
    const sessionRows = sessions.map((session) => `<li><strong>${escapeHtml(session.developerName)}</strong> · ${escapeHtml(session.status)} · ${escapeHtml(formatDate(session.startedAt))}${session.endedAt ? `–${escapeHtml(formatDate(session.endedAt))}` : ""} · ${escapeHtml(metricNumber(session.activeSeconds / 3600))} h${session.sessionReference ? ` · ${escapeHtml(session.sessionReference)}` : ""}</li>`).join("");
    const eventRows = events.map((event) => `<li><strong>${escapeHtml(event.environment === "homologation" ? "Homologação" : "Produção")}</strong> · ${escapeHtml(event.outcome)} · build ${escapeHtml(event.buildId)} · ${escapeHtml(formatDate(event.occurredAt))}${event.releaseVersion ? ` · ${escapeHtml(event.releaseVersion)}` : ""}${event.rollbackOfEventId ? " · rollback" : ""}</li>`).join("");
    return `<section class="detail-section"><h3>Execução e releases</h3><div class="detail-date-grid">${dateCards}</div><p>As datas de homologação e produção mostram o evento aprovado mais recente. Falhas e rollbacks permanecem no histórico.</p><h4>Sessões de desenvolvimento</h4>${sessionRows ? `<ul>${sessionRows}</ul>` : "<p>Nenhuma sessão iniciada.</p>"}<h4>Histórico de implantação</h4>${eventRows ? `<ul>${eventRows}</ul>` : "<p>Nenhum evento de implantação registrado.</p>"}</section>`;
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

  function renderWorkflowProgress(item) {
    if (item.taskWorkflowRevisionNumber === null || item.taskWorkflowProgressPercent === null) return "<small class=\"workflow-not-configured\">Sem workflow publicado</small>";
    const percent = Number(item.taskWorkflowProgressPercent);
    const complete = item.taskWorkflowCompletedSteps ?? 0;
    const total = item.taskWorkflowTotalSteps ?? 0;
    return `<span class="workflow-summary"><span>r${escapeHtml(item.taskWorkflowRevisionNumber)} · ${escapeHtml(metricNumber(percent))}%</span><progress max="100" value="${escapeHtml(percent)}" aria-label="${escapeHtml(item.key)}: ${escapeHtml(metricNumber(percent))}% do esforço concluído"></progress><small>${complete}/${total} etapas concluídas</small></span>`;
  }

  function formatEstimate(estimate) {
    return `${estimate.value} ${estimate.unit === "points" ? "pts" : "h"}`;
  }

  async function openItem(itemId) {
    try {
      const base = `/api/v1/projects/${encodeURIComponent(model.projectId)}/work-items/${encodeURIComponent(itemId)}`;
      const result = await api(base);
      const item = result.workItem;
      const [qualityResult, timeline, revisionsResult, sessionsResult, deploymentResult, childTasks, taskContext, workflowResult] = await Promise.all([
        item.type === "story" || item.type === "bug" ? api(`${base}/quality?limit=100`) : Promise.resolve(null),
        api(`${base}/timeline?limit=100`),
        api(`${base}/revisions`),
        item.type === "task"
          ? api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/development-sessions?itemIdOrKey=${encodeURIComponent(item.id)}&limit=200`)
          : Promise.resolve({ sessions: [] }),
        item.type === "task"
          ? api(`/api/v1/projects/${encodeURIComponent(model.projectId)}/deployment-events?itemIdOrKey=${encodeURIComponent(item.id)}&limit=200`)
          : Promise.resolve({ events: [] }),
        item.type === "story" || item.type === "bug" ? loadChildTasks(model.projectId, item.id) : Promise.resolve([]),
        item.type === "task" ? loadTaskContext(model.projectId, item.id) : Promise.resolve(null),
        item.type === "task" ? api(`${base}/task-workflow`) : Promise.resolve(null),
      ]);
      model.currentItem = item;
      model.currentQuality = qualityResult?.quality ?? null;
      model.currentTaskContext = taskContext;
      model.currentTaskWorkflow = workflowResult?.workflow ?? null;
      model.currentTaskSessions = sessionsResult.sessions;
      model.currentRevisions = revisionsResult.revisions;
      elements.itemKicker.textContent = `${item.key} · ${itemTypeLabel(item.type)} · ${stateLabel(item.state)}`;
      elements.itemTitle.textContent = item.title;
      const criteria = item.criteria.length
        ? `<ul>${item.criteria.map((criterion) => `<li>${escapeHtml(criterion.key)}${criterion.required ? " · obrigatório" : ""}: ${escapeHtml(criterion.description)}</li>`).join("")}</ul>`
        : "<p>Nenhum critério de aceite registrado.</p>";
      const estimates = item.estimates.length
        ? `<div class="estimate-list">${item.estimates.map((estimate) => `<span class="estimate-chip">${escapeHtml(formatEstimate(estimate))}</span>`).join("")}</div>`
        : "<p>Sem estimativa confirmada.</p>";
      const parentReference = taskContext?.sections.hierarchy.find((entry) => entry.source.entityId === item.parentId);
      const parent = item.parentId ? `<p>${escapeHtml(parentReference ? `${parentReference.key} · ${parentReference.title}` : item.parentId)}</p>` : "<p>Sem item pai.</p>";
      const businessValue = item.businessValueScore === null
        ? "Ainda não avaliado"
        : `${item.businessValueScore}/100 · ${item.businessValueRationale ? escapeHtml(item.businessValueRationale) : "sem justificativa"}`;
      const children = childTasks.length
        ? `<ul class="child-task-list">${childTasks.map((task) => `<li><div><button class="link-button" type="button" data-open-item="${escapeHtml(task.id)}"><strong>${escapeHtml(task.key)}</strong> · ${escapeHtml(task.title)}</button><span>${escapeHtml(stateLabel(task.state))} · ${escapeHtml(task.assigneeId || "sem responsável")}</span></div>${renderWorkflowProgress(task)}</li>`).join("")}</ul>`
        : "<p>Nenhuma tarefa filha cadastrada.</p>";
      const draftRevision = model.currentRevisions.find((revision) => revision.status === "draft");
      const revisions = model.currentRevisions.map((revision) => `<li>r${revision.revisionNumber} · ${escapeHtml(revision.status)} · ${escapeHtml(new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(new Date(revision.createdAt)))}</li>`).join("");
      elements.itemDetails.innerHTML = `
        <div class="detail-meta"><span class="state-badge ${escapeHtml(item.state)}">${escapeHtml(stateLabel(item.state))}</span><span class="count-label">Versão ${escapeHtml(item.version)}</span><span class="count-label">Revisão ${escapeHtml(item.revision)}</span><span class="count-label">Prioridade P${escapeHtml(item.priority)}</span>${["epic", "feature", "task"].includes(item.type) ? `<span class="count-label">Valor ${businessValue}</span>` : ""}</div>
        <section class="detail-section"><h3>Descrição</h3><p>${escapeHtml(item.description || "Sem descrição registrada.")}</p></section>
        <section class="detail-section"><h3>Critérios de aceite</h3>${criteria}</section>
        <section class="detail-section"><h3>Estimativas confirmadas</h3>${estimates}</section>
        <section class="detail-section"><h3>Item pai</h3>${parent}</section>
        ${item.type === "story" || item.type === "bug" ? `<section class="detail-section"><h3>Tarefas de desenvolvimento · ${childTasks.length}</h3>${children}</section>` : ""}
        ${item.type === "task" ? renderTaskWorkflow(item, workflowResult.workflow) : ""}
        <section class="detail-section"><h3>Responsável</h3><p>${escapeHtml(item.assigneeId || "Não atribuído")}</p></section>
        <section class="detail-section"><h3>Revisões de conteúdo</h3><ul>${revisions || "<li>Nenhuma revisão.</li>"}</ul>${draftRevision ? `<button class="button button-secondary" type="button" data-publish-item-revision="${draftRevision.revisionNumber}">Publicar rascunho r${draftRevision.revisionNumber}</button>` : ""}</section>
        ${qualityResult ? renderQualityDetail(qualityResult.quality) : renderTaskContext(taskContext)}
        ${renderTaskExecution(item, sessionsResult.sessions, deploymentResult.events)}
        <section class="detail-section"><h3>Timeline · watermark ${timeline.watermark}</h3>${renderItemTimeline(timeline.events)}</section>`;
      elements.detailMove.hidden = (transitions[item.state] ?? []).length === 0;
      elements.detailEdit.hidden = false;
      elements.itemDialog.showModal();
    } catch (error) {
      toast(`${error.code ?? "ERRO"}: ${error.message}`, true);
    }
  }

  function renderTaskWorkflow(item, workflowView) {
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

  function workflowEditorRow(step = {}, position = 1) {
    const effort = step.effortPercent === undefined ? "" : Number(step.effortPercent).toFixed(2);
    return `<fieldset class="workflow-step-editor"><legend>Etapa ${position}</legend><input type="hidden" data-workflow-step-id value="${escapeHtml(step.id ?? "")}"><div class="workflow-editor-order"><button class="button button-secondary" type="button" data-workflow-up aria-label="Mover etapa ${position} para cima" ${position === 1 ? "disabled" : ""}>↑</button><button class="button button-secondary" type="button" data-workflow-down aria-label="Mover etapa ${position} para baixo">↓</button><button class="button button-secondary" type="button" data-workflow-remove>Remover</button></div><label>Título<input data-workflow-title maxlength="160" required value="${escapeHtml(step.title ?? "")}"></label><label>Instruções e resultado esperado<textarea data-workflow-description rows="3" maxlength="4000" required>${escapeHtml(step.description ?? "")}</textarea></label><label>Esforço (%)<input data-workflow-effort type="number" min="0.01" max="100" step="0.01" required value="${escapeHtml(effort)}"></label></fieldset>`;
  }

  function updateWorkflowEditorOrder() {
    const rows = [...elements.taskWorkflowStepList.querySelectorAll(".workflow-step-editor")];
    rows.forEach((row, index) => {
      row.querySelector("legend").textContent = `Etapa ${index + 1}`;
      row.querySelector("[data-workflow-up]").disabled = index === 0;
      row.querySelector("[data-workflow-down]").disabled = index === rows.length - 1;
      row.querySelector("[data-workflow-up]").setAttribute("aria-label", `Mover etapa ${index + 1} para cima`);
      row.querySelector("[data-workflow-down]").setAttribute("aria-label", `Mover etapa ${index + 1} para baixo`);
    });
  }

  function updateWorkflowEditorState() {
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

  function openTaskWorkflowEditor() {
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

  async function submitTaskWorkflowForm(event) {
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

  async function publishTaskWorkflowDraft() {
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

  async function changeTaskWorkflowStep(button) {
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

  async function loadTaskWorkflowRevision(revisionNumber) {
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

  async function openWorkItemEditor(item = null) {
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

  function updateWorkItemParentOptions(selectedParentId = elements.workItemParent.value) {
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

  function updateWorkItemValueFields() {
    const type = elements.workItemType.value;
    const supportsBusinessValue = ["epic", "feature", "task"].includes(type);
    const supportsCriteria = ["story", "bug"].includes(type);
    elements.workItemValueField.hidden = !supportsBusinessValue;
    elements.workItemRationaleField.hidden = !supportsBusinessValue;
    elements.workItemCriteriaField.hidden = !supportsCriteria;
  }

  function parseWorkItemCriteria(value, existing = []) {
    return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
      const match = /^([A-Z0-9._-]{1,32}):\s*(.+)$/iu.exec(line);
      const criterion = match ? existing.find((entry) => entry.key.toLocaleLowerCase() === match[1].toLocaleLowerCase()) : undefined;
      return {
        ...(criterion ? { id: criterion.id, required: criterion.required, description: match[2].trim() } : { description: match ? match[2].trim() : line, required: true }),
      };
    });
  }

  async function submitWorkItemForm(event) {
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

  async function openScenarioEditor(scenarioSummary = null) {
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

  function lines(value) {
    return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  }

  async function submitScenarioForm(event) {
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

  async function publishScenario(scenarioKey, revisionNumber) {
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

  async function submitTestRun(event) {
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

  async function publishWorkItemRevision(revisionNumber) {
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
    void updateTransitionStartHint();
  }

  async function updateTransitionStartHint() {
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

  function setView(view) {
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
  for (const dialog of [elements.itemDialog, elements.transitionDialog, elements.workItemDialog, elements.scenarioDialog, elements.taskWorkflowDialog]) {
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
