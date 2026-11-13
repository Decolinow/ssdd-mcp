/* global document, URLSearchParams */
import { elements } from "./elements.js";
import { model } from "./model.js";
import { escapeHtml, stateLabel, api, showError, showWorkspace } from "./ui.js";
import { syncWorkProfileOptions, render } from "./quick-access.js";
import { projectLocalDate, loadProjectHistory } from "./history.js";
import { renderSpecifications } from "./specifications.js";
import { metricNumber, metricDate, renderMetrics } from "./metrics.js";
import { loadActivityFirstPage } from "./details.js";

export async function loadWorkItems(projectId) {
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

export async function loadProjectCollection(projectId, collectionName, collectionField) {
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

export async function loadQualitySummaries(projectId) {
  return loadProjectCollection(projectId, "quality", "items");
}

export async function loadScenarioSummaries(projectId) {
  return loadProjectCollection(projectId, "scenarios", "scenarios");
}

export async function loadParentFeatures(projectId) {
  const params = new URLSearchParams({ type: "feature", limit: "100" });
  return (await api(`/api/v1/projects/${encodeURIComponent(projectId)}/work-items?${params}`)).items;
}

export async function loadParentItems(projectId) {
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

export async function loadChildTasks(projectId, parentId) {
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

export async function loadTaskContext(projectId, taskId) {
  const params = new URLSearchParams({ profile: "dev", maxChars: "30000" });
  for (const section of ["hierarchy", "acceptanceCriteria", "businessRules", "technicalDecisions", "scenarios", "testRuns", "baseline"]) {
    params.append("include", section);
  }
  return api(`/api/v1/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(taskId)}/context?${params}`);
}

export async function fetchSpecifications(projectId, filters = {}) {
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

export function specificationFilters() {
  const search = model.specificationSearch.trim();
  return {
    ...(model.specificationKind ? { kind: model.specificationKind } : {}),
    ...(search.length >= 2 ? { search } : {}),
  };
}

export async function loadSpecifications() {
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

export async function loadProjectData() {
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

export function renderTeamSelect() {
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

export async function loadDashboardMetrics() {
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

export async function loadProjectRoadmap() {
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

export function renderProjectRoadmap() {
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

export function roadmapForecastReason(status, feature, reason) {
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

export function applyDeveloperMetricFilters() {
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
