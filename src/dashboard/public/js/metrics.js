import { metricNumberFormatter, metricDateFormatter } from "./constants.js";
import { elements } from "./elements.js";
import { model } from "./model.js";
import { escapeHtml, stateLabel } from "./ui.js";
import { metricTimestampDate } from "./history.js";
import { formatDate } from "./views.js";

export function metricNumber(value) {
  return value === null || value === undefined
    ? "—"
    : metricNumberFormatter.format(value);
}

export function metricDate(value) {
  if (!value) return "—";
  return metricDateFormatter.format(new Date(`${value}T12:00:00.000Z`));
}

export function metricStatusLabel(status) {
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

export function renderMetricChart(series, lines, label) {
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

export function summarizeScopeItems(items) {
  return items.reduce((total, item) => {
    total.scopePoints += item.points;
    if (item.state === "done") total.completedPoints += item.points;
    else if (item.state === "cancelled") total.cancelledPoints += item.points;
    else total.remainingPoints += item.points;
    return total;
  }, { scopePoints: 0, remainingPoints: 0, completedPoints: 0, cancelledPoints: 0 });
}

export function renderScopeBreakdown(title, series, items, date, type) {
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

export function renderForecastPanel(forecast) {
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

export function medianMetric(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function signedMetric(value) {
  return `${value > 0 ? "+" : ""}${metricNumber(value)}`;
}

export function renderSprintSnapshot(sprintMetrics) {
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

export function renderSprintComparison(sprintMetrics, data, windowSize) {
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

export function renderMetrics() {
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
  const developerRows = visibleDevelopers.map((developer) => `<tr><td>${escapeHtml(developer.name)}</td><td>${developer.completedTasks}</td><td>${escapeHtml(metricNumber(developer.activeHours))} h</td><td>${escapeHtml(metricNumber(developer.activeHoursOnEstimatedCompletedTasks))} h</td><td>${escapeHtml(metricNumber(developer.estimatedHoursOnCompletedTasks))} h</td><td>${developer.effortCalibrationFactor === null ? "—" : `${escapeHtml(metricNumber(developer.effortCalibrationFactor))}×`}</td><td>${developer.estimateVariancePercent === null ? "—" : `${developer.estimateVariancePercent > 0 ? "+" : ""}${escapeHtml(metricNumber(developer.estimateVariancePercent))}%`}</td><td>${developer.cycleTimeHours ? `${escapeHtml(metricNumber(developer.cycleTimeHours.medianHours))} · ${escapeHtml(metricNumber(developer.cycleTimeHours.p85Hours))} h` : "—"}</td><td>${developer.effortRatioRange ? `${escapeHtml(metricNumber(developer.effortRatioRange.lowFactor))}× – ${escapeHtml(metricNumber(developer.effortRatioRange.highFactor))}×` : "—"}</td><td>${developer.sampleSufficient ? `${developer.estimatedCompletedTasks} tarefas estimadas` : `Amostra baixa · ${developer.estimatedCompletedTasks}/${developerMetrics.minimumSampleTasks} estimadas`}</td></tr>`).join("");
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
      <article class="metrics-panel metrics-panel-wide"><div class="metrics-panel-heading"><div><p class="eyebrow">FLUXO DE DESENVOLVIMENTO</p><h3>Esforço por desenvolvedor</h3><p>${developerMetrics ? `${escapeHtml(metricDate(developerMetrics.period.from))}–${escapeHtml(metricDate(developerMetrics.period.to))} · datas no fuso do projeto · período limitado ao corte` : "Dados de sessões de desenvolvimento"}</p></div><span class="unit-tag">Horas e tarefas</span></div><div class="metric-table-wrap"><table class="metric-table"><thead><tr><th>Desenvolvedor</th><th>Tarefas concluídas</th><th>Horas ativas no período</th><th>Horas em tarefas estimadas</th><th>Estimativa confirmada</th><th>Fator de calibração</th><th>Variação</th><th>Ciclo mediana · P85</th><th>Faixa real/estimado P15–P85</th><th>Amostra</th></tr></thead><tbody>${developerRows || `<tr><td colspan="10">Nenhuma tarefa concluída ou sessão no período para este filtro.</td></tr>`}</tbody></table></div><p class="table-note">A variação e o fator comparam horas de sessão com horas estimadas nas mesmas tarefas concluídas e estimadas. Só exibimos o fator com pelo menos ${developerMetrics?.minimumSampleTasks ?? 5} tarefas estimadas. Sessões ativas consideram o período escolhido; esforço e estimativas da coorte usam sessões encerradas até cada conclusão. A métrica apoia planejamento, não ranking nem ajuste automático. Velocidade do time é medida em story points.</p></article>
    </div>`;
}
