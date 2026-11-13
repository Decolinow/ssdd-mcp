/* global URL */
import { states, typeMarks } from "./constants.js";
import { elements } from "./elements.js";
import { model } from "./model.js";
import { escapeHtml, scenarioKindLabel, stateLabel } from "./ui.js";
import { filteredQualitySummaries, visibleBoardItems, backlogItems } from "./quick-access.js";
import { renderCard } from "./details.js";
import { aggregateCoverage, aggregateRuns, filterRuns, qaResultLabels, qaResultOrder } from "./qa-runs.js";

export function renderSprintSummary() {
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

export function renderBacklog() {
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

export function renderBoard() {
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

export function renderQuality() {
  renderScenarioManager();
  const coverage = aggregateCoverage(model.qualitySummaries);
  elements.qaCoverage.innerHTML = coverage.total === 0
    ? `<div class="empty-state"><strong>Ainda não há PBIs para analisar.</strong></div>`
    : `<table class="qa-result-table"><caption class="visually-hidden">PBIs por situação de cobertura</caption><thead><tr><th scope="col">Situação</th><th scope="col">PBIs</th></tr></thead><tbody>${[
      ["Cobertos (100% dos critérios obrigatórios)", coverage.covered],
      ["Com critérios descobertos", coverage.uncovered],
      ["Sem critério obrigatório", coverage.noCriteria],
      ["Sem baseline (apenas preview)", coverage.withoutBaseline],
    ].map(([label, count]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${count}</td></tr>`).join("")}</tbody></table><p class="qa-watermark">${coverage.total} PBIs considerados · sem execução certificada não há validação (BR-QA-001).</p>`;
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

export function safeEvidenceUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function renderScenarioManager() {
  const resultOrder = qaResultOrder;
  const resultLabels = qaResultLabels;
  const resultColors = { passed: "#24815b", failed: "#c54b43", blocked: "#c3831d", skipped: "#8090a6" };
  const baseRuns = filterRuns(model.testRuns, { ...model.qaFilters, result: "" });
  const runs = filterRuns(model.testRuns, model.qaFilters);
  const { counts } = aggregateRuns(baseRuns);
  const total = baseRuns.length;
  const watermark = `${runs.length} de ${model.testRuns.length} execuções carregadas${model.testRuns.length >= 100 ? " (limite de 100 mais recentes)" : ""}${model.qaFilters.result ? ` · resultado: ${resultLabels[model.qaFilters.result]}` : ""}`;
  const filtersActive = Object.values(model.qaFilters).some(Boolean);
  const scenarioKeys = [...new Set(model.testRuns.map((run) => run.scenarioKey))].sort();
  if (elements.qaFilterScenario) {
    const selected = model.qaFilters.scenario;
    elements.qaFilterScenario.innerHTML = `<option value="">Todos</option>${scenarioKeys.map((key) => `<option value="${escapeHtml(key)}"${key === selected ? " selected" : ""}>${escapeHtml(key)}</option>`).join("")}`;
  }
  elements.qaRunChart.innerHTML = model.testRuns.length === 0
    ? `<div class="empty-state"><strong>Sem execuções registradas.</strong><p>Crie e publique um cenário para registrar o primeiro resultado.</p></div>`
    : total === 0
      ? `<div class="empty-state"><strong>Nenhuma execução corresponde aos filtros.</strong><p>Ajuste build, cenário, tarefa ou período.</p></div><p class="qa-watermark">${escapeHtml(watermark)}</p>`
      : `<svg class="qa-result-chart" viewBox="0 0 600 42" role="img" aria-label="${resultOrder.map((result) => `${resultLabels[result]}: ${counts[result]}`).join(", ")}">${resultOrder.map((result, index) => {
        const prior = resultOrder.slice(0, index).reduce((sum, key) => sum + counts[key], 0);
        const x = prior / total * 600;
        const width = counts[result] / total * 600;
        return counts[result] ? `<rect x="${x}" y="4" width="${Math.max(width, 1)}" height="34" fill="${resultColors[result]}" rx="${index === 0 || prior + counts[result] === total ? 5 : 0}"><title>${resultLabels[result]}: ${counts[result]}</title></rect>` : "";
      }).join("")}</svg>
      <table class="qa-result-table"><caption class="visually-hidden">Execuções por resultado (use os botões para filtrar a lista abaixo)</caption><thead><tr><th scope="col">Resultado</th><th scope="col">Execuções</th><th scope="col">Detalhar</th></tr></thead><tbody>${resultOrder.map((result) => `<tr><th scope="row"><i class="qa-swatch result-color-${result}" aria-hidden="true"></i>${resultLabels[result]}</th><td>${counts[result]}</td><td><button type="button" class="button button-secondary" data-qa-result="${result}" aria-pressed="${model.qaFilters.result === result}"${counts[result] === 0 ? " disabled" : ""}>Ver ${counts[result]} ${counts[result] === 1 ? "execução" : "execuções"}</button></td></tr>`).join("")}</tbody></table>
      <p class="qa-watermark" role="status">${escapeHtml(watermark)}</p>${filtersActive ? `<button type="button" class="button button-secondary" data-qa-clear>Limpar filtros</button>` : ""}`;

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
  elements.testRunHistory.innerHTML = runs.length === 0
    ? ""
    : `<h4>Histórico recente (${runs.length})</h4><div class="run-history-list">${runs.map((run) => {
      const evidenceUrl = safeEvidenceUrl(run.evidenceUri);
      const evidence = evidenceUrl ? `<a href="${escapeHtml(evidenceUrl)}" target="_blank" rel="noreferrer">Evidência</a>` : "";
      return `<article class="run-history-row"><span class="run-result result-${escapeHtml(run.result)}">${escapeHtml(resultLabels[run.result] ?? run.result)}</span><strong>${escapeHtml(run.scenarioKey)} · r${run.revisionNumber}</strong><span>${escapeHtml(run.buildId)}</span><time datetime="${escapeHtml(run.executedAt)}">${escapeHtml(new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(run.executedAt)))}</time>${evidence}</article>`;
    }).join("")}</div>`;
}

export function eventTitle(event) {
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

export function eventDetail(event) {
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

export function renderActivityEvent(event, isTimeline = false) {
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

export function formatDate(value) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

export function renderActivity() {
  elements.activityWatermark.textContent = `Watermark ${model.activityWatermark}`;
  elements.loadMoreActivity.hidden = !model.activityCursor;
  if (!model.activityEvents.length) {
    elements.activityList.innerHTML = `<div class="empty-state"><strong>Nenhuma atividade registrada.</strong><p>As mudanças auditadas do projeto aparecerão aqui.</p></div>`;
    return;
  }
  elements.activityList.innerHTML = model.activityEvents.map((event) => renderActivityEvent(event)).join("");
}

export function renderRetrospective() {
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
