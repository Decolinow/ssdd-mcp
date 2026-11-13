/* global URLSearchParams */
import { localDateFormatters } from "./constants.js";
import { elements } from "./elements.js";
import { model } from "./model.js";
import { escapeHtml, itemTypeLabel, scenarioKindLabel, specificationKindLabel, stateLabel, api } from "./ui.js";
import { eventTitle, formatDate } from "./views.js";
import { metricDate } from "./metrics.js";

export function projectLocalDate(value, timezone) {
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

export function metricTimestampDate(value) {
  if (!value) return null;
  const timezone = model.project?.timezone;
  return timezone ? projectLocalDate(new Date(value), timezone) : value.slice(0, 10);
}

export function isHistoryDateSelectable(value = elements.historyDate.value) {
  return Boolean(value && value >= elements.historyDate.min && value <= elements.historyDate.max);
}

export function historyDateBoundsMessage() {
  return `Selecione uma data entre ${metricDate(elements.historyDate.min)} e ${metricDate(elements.historyDate.max)} no fuso ${model.project.timezone}.`;
}

export async function loadProjectHistory(cursor = null) {
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

export function renderProjectHistory() {
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
