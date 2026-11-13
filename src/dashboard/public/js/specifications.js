import { elements } from "./elements.js";
import { model } from "./model.js";
import { escapeHtml, specificationKindLabel, api } from "./ui.js";
import { formatDate } from "./views.js";

export const specificationRevisionStatusLabels = {
  draft: "Rascunho",
  in_review: "Em revisão",
  published: "Publicada",
  superseded: "Substituída",
  withdrawn: "Retirada",
};

export const specificationContentLabels = {
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

export function specificationRevisionStatusLabel(status) {
  return specificationRevisionStatusLabels[status] ?? status;
}

export function specificationFieldLabel(key) {
  if (specificationContentLabels[key]) return specificationContentLabels[key];
  const spaced = String(key)
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : String(key);
}

export function renderSpecificationScalar(value) {
  if (value === null || value === undefined) return '<span class="specification-empty">—</span>';
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (typeof value === "object") return JSON.stringify(value);
  return escapeHtml(String(value));
}

export function renderSpecificationValue(value) {
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

export function renderSpecifications() {
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

export function renderSpecificationNotice(specification, selectedRevision) {
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

export function renderSpecificationDetail() {
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

export async function openSpecification(key) {
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
