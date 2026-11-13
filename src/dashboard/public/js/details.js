/* global document, URL, URLSearchParams */
import { transitions } from "./constants.js";
import { elements } from "./elements.js";
import { model } from "./model.js";
import { escapeHtml, itemTypeLabel, stateLabel, api, toast } from "./ui.js";
import { loadChildTasks, loadTaskContext, loadProjectData } from "./data.js";
import { renderActivityEvent, formatDate, renderActivity, renderRetrospective } from "./views.js";
import { metricNumber } from "./metrics.js";
import { renderTaskWorkflow } from "./task-workflow.js";

export async function loadSelectedRetrospective(revisionNumber) {
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

function certifyControl(run) {
  const item = model.currentItem;
  if (run.result !== "passed") return `<span>Sem certificação: só execuções aprovadas são certificáveis (${escapeHtml(run.result)}).</span>`;
  if (item?.state !== "in_validation") return "<span>Sem certificação: o PBI precisa estar em validação.</span>";
  return `<button class="button button-secondary" type="button" data-certify-run="${escapeHtml(run.id)}">Certificar (QA)</button>`;
}

export function renderQualityDetail(report) {
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
          ${certification ? `<span class="certified-mark">Certificado por QA · ${escapeHtml(formatDate(certification.certifiedAt))}</span>` : certifyControl(run)}
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

export function renderItemTimeline(events) {
  if (!events.length) return "<p>Nenhuma mudança auditada encontrada para este item.</p>";
  return `<div class="detail-timeline">${events.map((event) => renderActivityEvent(event, true)).join("")}</div>`;
}

export function renderTaskContext(context) {
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

export async function loadMoreTaskContext(button) {
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

export function renderTaskExecution(item, sessions, events) {
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

export async function loadMoreEvidence(button) {
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

export async function loadMoreActivity() {
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

export async function loadActivityPage(projectId, cursor = null) {
  const params = new URLSearchParams({ limit: "50" });
  if (elements.activityEntityType.value) params.set("entityType", elements.activityEntityType.value);
  if (elements.activityEntityId.value.trim()) params.set("entityId", elements.activityEntityId.value.trim());
  if (cursor) params.set("cursor", cursor);
  return api(`/api/v1/projects/${encodeURIComponent(projectId)}/audit?${params}`);
}

export async function loadActivityFirstPage(projectId = model.projectId) {
  return loadActivityPage(projectId);
}

export async function applyActivityFilters() {
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

export function renderCard(item) {
  const moveTargets = transitions[item.state] ?? [];
  return `<article class="work-card" draggable="true" data-card-id="${escapeHtml(item.id)}" tabindex="0" aria-label="${escapeHtml(item.key)} ${escapeHtml(item.title)}, ${escapeHtml(stateLabel(item.state))}">
    <div class="card-topline"><span class="card-key">${escapeHtml(item.key)}</span><span class="priority">P${escapeHtml(item.priority)}</span></div>
    <p class="card-title">${escapeHtml(item.title)}</p>
    <div class="card-foot"><span class="card-type">${escapeHtml(itemTypeLabel(item.type))} · v${escapeHtml(item.version)}</span><div class="card-actions"><button type="button" data-open-item="${escapeHtml(item.id)}">Detalhes</button>${moveTargets.length ? `<button type="button" data-move-item="${escapeHtml(item.id)}" aria-label="Mover ${escapeHtml(item.key)}">Mover item</button>` : ""}</div></div>
  </article>`;
}

export function renderWorkflowProgress(item) {
  if (item.taskWorkflowRevisionNumber === null || item.taskWorkflowProgressPercent === null) return "<small class=\"workflow-not-configured\">Sem workflow publicado</small>";
  const percent = Number(item.taskWorkflowProgressPercent);
  const complete = item.taskWorkflowCompletedSteps ?? 0;
  const total = item.taskWorkflowTotalSteps ?? 0;
  return `<span class="workflow-summary"><span>r${escapeHtml(item.taskWorkflowRevisionNumber)} · ${escapeHtml(metricNumber(percent))}%</span><progress max="100" value="${escapeHtml(percent)}" aria-label="${escapeHtml(item.key)}: ${escapeHtml(metricNumber(percent))}% do esforço concluído"></progress><small>${complete}/${total} etapas concluídas</small></span>`;
}

export function formatEstimate(estimate) {
  return `${estimate.value} ${estimate.unit === "points" ? "pts" : "h"}`;
}

export async function openItem(itemId) {
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
