# Catálogo de especificações do projeto SSDD

**Projeto MCP:** `SSDD`  
**UUID:** `3aac48de-8447-4294-abff-f1a57ecd960e`  
**Revisado em:** 2026-11-12

O conteúdo normativo e sua rastreabilidade ficam versionados no banco do projeto MCP (`.ssdd/ssdd.sqlite`). Esta página mantém o índice humano, explica como consultar e declara o estado de aprovação observado. A especificação funcional deste repositório continua sendo a referência de produto e está em [docs/specification.md](specification.md); arquitetura e operação estão em [docs/architecture.md](architecture.md), [docs/mcp.md](mcp.md) e [docs/team-server.md](team-server.md).

## Especificações registradas

| Chave | Tipo | Escopo | Tarefas âncora | Estado |
|---|---|---|---|---|
| `SSDD-ARCH-2026-01` | ADR | Arquitetura observada, componentes, identidade, transports, rastreabilidade, limites e plano de validação | `SSDD-1`, `SSDD-98`, `SSDD-100`, `SSDD-109`, `SSDD-122` | Published, revisão 1 |
| `SSDD-BR-CORE-01` | Regra de negócio | Hierarquia, unidades, revisões, baselines, vínculos, autorização e gates | `SSDD-1`, `SSDD-16`, `SSDD-17`, `SSDD-25`, `SSDD-114`, `SSDD-119`, `SSDD-120` | Published, revisão 1 |
| `SSDD-BR-QUALITY-01` | Regra de negócio | Cobertura por critério, cenários, execuções por build, evidência e certificação humana | `SSDD-22`, `SSDD-23`, `SSDD-25`, `SSDD-97`, `SSDD-100`, `SSDD-112`, `SSDD-114`, `SSDD-127` | Published, revisão 1 |
| `SSDD-BR-METRICS-01` | Regra de negócio | Fórmulas e limites de velocity, forecast, capacidade e calibração individual | `SSDD-38`, `SSDD-39`, `SSDD-40`, `SSDD-60`, `SSDD-99`, `SSDD-111`, `SSDD-113`, `SSDD-118` | Published, revisão 1 |
| `SSDD-API-MCP-01` | Contrato de API | Seleção de projeto, identidade, autorização, profiles, task context, tools e paridade do dashboard | `SSDD-24`, `SSDD-44`, `SSDD-45`, `SSDD-98`, `SSDD-100`, `SSDD-109`, `SSDD-110`, `SSDD-111`, `SSDD-114`, `SSDD-118`, `SSDD-119`, `SSDD-120`, `SSDD-121`, `SSDD-122`, `SSDD-123`, `SSDD-124`, `SSDD-126`, `SSDD-127` | Published, revisão 1 |
| `SSDD-NFR-OPS-01` | Requisito não funcional | Runtime, segurança, isolamento, backup/restore, limites, desempenho e gates de release | `SSDD-44`, `SSDD-45`, `SSDD-46`, `SSDD-47`, `SSDD-110`, `SSDD-111`, `SSDD-112`, `SSDD-116`, `SSDD-118`, `SSDD-119`, `SSDD-121`, `SSDD-123`, `SSDD-124`, `SSDD-125` | Published, revisão 1 |
| `SSDD-GLOSS-CORE-01` | Glossário | Termos e unidades de projeto, principal, PBI, baseline, QA, geração, velocity, capacidade e watermark | `SSDD-1`, `SSDD-16`, `SSDD-17` | Published, revisão 1 |
| `SSDD-TASK-WF-ADR-02` | ADR | Workflow opcional versionado por tarefa, progresso ponderado, ordem de etapas, pinagem de sessão e gates | `SSDD-931`–`SSDD-933` | Published, revisão 1 |
| `SSDD-BR-TASK-WF-01` | Regra de negócio | Soma de pesos, cálculo de progresso, estados/sequência e separação de QA | `SSDD-931`–`SSDD-933` | Published, revisão 1 |
| `SSDD-PRIORITY-ADR-24` | ADR | Prioridade e score PO, herança, fila de execução e timeline de Features | `SSDD-934`–`SSDD-936` | Published, revisão 2 |
| `SSDD-BR-PRIORITY-01` | Regra de negócio | Rubrica de negócio, score/rationale, ordenação, readiness e limites de previsão | `SSDD-934`–`SSDD-936` | Published, revisão 2 |

As chaves na tabela são exemplos de tarefas âncora; a relação completa deve ser consultada no grafo MCP. As seis especificações de domínio/contrato são relacionadas ao retrato arquitetural por `relates_to`. Todas as ligações de contexto são descritivas: não declaram que um item foi publicado, concluído ou aprovado.

Na auditoria complementar de 2026-11-11 foram criadas 31 relações `relates_to` para 15 tarefas de auditoria/implantação e outras 84 relações para 49 tarefas que não recebiam regra ou decisão publicada no contexto de desenvolvimento. A curadoria seguiu o escopo dos itens e relacionou somente regras e contratos aplicáveis. A tarefa `SSDD-126` (`SSDD-924` no roadmap) continua cobrindo a legibilidade da atividade; `SSDD-127` (`SSDD-925`) continua cobrindo a manutenção da matriz de rastreabilidade e cenários. `SSDD-115` e a cópia histórica `SSDD-128` estão canceladas.

No `SSDD-ARCH-2026-01`, `revision.status=published` significa que a revisão MCP está liberada para contexto autorizado. O campo interno `content.status=draft` qualifica o retrato como descrição técnica, sem o aprovar como decisão arquitetural formal; o próprio `purpose` declara esse limite.

## Histórico de propostas retiradas

| Chave | Tipo | Escopo | Tarefas âncora | Estado |
|---|---|---|---|---|
| `SSDD-TASK-WF-ADR-01` | ADR | Proposta inicial do workflow ponderado, substituída pelo ADR 02 | `SSDD-931`–`SSDD-933` | Withdrawn, revisão 1; retirada humana e auditada em 2026-11-12 |

O ADR 01 continua no histórico sem estar disponível como decisão vigente. Foi retirado porque o ADR 02 já aprovado reflete a implementação atual e `spec_revision_withdraw` mantém a razão e autoria auditadas. O ADR 02 e a regra de workflow foram publicados pelo Tech Lead/PO humano, revisão 1. A regra e ADR de prioridade foram publicados na revisão 2 após a rubrica de score receber cinco dimensões mensuráveis em cada avaliação PO. Consulte [ADR 0023](adr/0023-workflow-ponderado-por-tarefa.md) e [ADR 0024](adr/0024-prioridade-valor-e-roadmap-por-feature.md).

No total, há 12 identidades de especificação: 11 com revisão publicada vigente e uma revisão retirada. Nenhuma proposta Draft obsoleta ficou ativa no catálogo. Revisões futuras ainda podem ficar em Draft durante refinamento normal.

## Cenário de validação registrado

`SSDD-VEL-20261111` — **Velocidade histórica respeita corte local e geração do time** — é um cenário de integração publicado, revisão 1, após revisão QA em 2026-11-12. Ele cobre `SSDD-BR-METRICS-01` e se relaciona às tarefas `SSDD-38` e `SSDD-39`. Os passos validam exclusão de sprints futuras, seleção da geração efetiva na data e paridade entre `metrics_get` e a API do dashboard.

O cenário está publicado, mas ainda não tem execução QA registrada. O workspace atual tem uma sprint fechada na geração 1; para cumprir a pré-condição de mudança para geração 2, QA deve preparar dados controlados em fixture/workspace isolado. A validação automatizada da implementação está em `tests/application/metrics.test.ts`, `tests/application/forecasts.test.ts` e `tests/dashboard/api.test.ts`; os resultados desses testes não são apresentados como execução certificada do cenário. QA deve executá-lo contra um build identificado e certificar o resultado compatível com uma baseline para transformá-lo em evidência de release.

## Como consultar pelo MCP

1. `project_list` localiza o UUID do projeto autorizado.
2. `spec_list` lista as especificações do projeto; use `kind`, `limit` e `cursor` para filtrar/paginar.
3. `spec_get` lê uma especificação e suas revisões pelo ID ou chave.
4. `trace_query` percorre relações de uma especificação ou tarefa. `truncated: true` significa que há relações fora da profundidade/limite pedido; consulte o nó diretamente antes de concluir que não existe vínculo.
5. `task_context_get` entrega contexto de implementação com revisão vigente. Conteúdo Draft ligado a uma tarefa gera `SPEC_WITHOUT_PUBLICATION` e não é injetado como decisão vigente.

O contexto é limitado por orçamento; entradas longas podem apontar para um resource MCP (`ENTRY_MOVED_TO_RESOURCE`) e respostas paginadas podem devolver `nextCursor`. Continue a paginação quando `truncated` for verdadeiro. O glossário é publicado, mas o resolver atual não o inclui automaticamente nas seções da tarefa; consulte `spec_get(SSDD-GLOSS-CORE-01)` quando os termos do domínio forem relevantes.

O dashboard ainda não tem catálogo CRUD para especificações: a gestão de conteúdo, revisões, publicação e vínculos é feita pelo MCP. A tela de detalhe da tarefa consome o mesmo contexto autorizado e mostra os avisos de publicação.

## Publicação e governança

Em 2026-11-11, após aprovação humana explícita, as sete especificações base foram publicadas na revisão 1: PO publicou regras de negócio e glossário; Tech Lead publicou API, ADR e requisitos não funcionais. Em 2026-11-12, o Tech Lead publicou ADR 0023 do workflow e a PO publicou a respectiva regra. Também foram publicadas as decisões de prioridade/valor na revisão 2 após revisão da rubrica; QA publicou a definição de `SSDD-VEL-20261111`. Isso torna 11 revisões vigentes disponíveis ao contexto autorizado dos agentes. Publicação de spec ou cenário não aprova automaticamente itens de backlog, execução/certificação QA ou release de produção. O cenário exige uma execução contra um build identificado e certificação QA compatível com baseline para servir de evidência. Perfis de agente ou papéis técnicos não substituem esses gates humanos.

Validação pelo MCP em 2026-11-11 confirmou as sete chaves base com `publishedRevision` igual a `latestRevision` (todas revisão 1), 58 referências de origem para arquivos presentes, 143 relações diretas tarefa–especificação e quatro relações diretas com itens acima de tarefa (três épicos e uma história). Entre as 88 tarefas não canceladas, 83 têm vínculo direto e três recebem especificação publicada por herança; `task_context_get` fornece especificação publicada em 86 contextos. As outras duas tarefas estão concluídas e receberam vínculos depois de um baseline imutável: o MCP sinaliza `SPEC_LINK_AFTER_BASELINE` e mantém a revisão original do baseline, sem retroagir especificações. Esse é um retrato datado da curadoria anterior, não uma contagem atualizada das duas especificações novas.

Na revisão de 2026-11-12, `project_feature_roadmap_get` retorna 14 Features na ordem de prioridade/valor, quatro épicos e todos os 18 itens hierárquicos com score/justificativa publicados. As tarefas herdam valor da Feature/épico; valores específicos de tarefa continuam opcionais. `task_execution_queue_get` retorna zero tarefas startable, pois nenhuma tarefa está Ready e atribuída; isso impede agentes de iniciar trabalho não aceito. Há uma sprint fechada comparável, abaixo das três exigidas para timeline com datas. O dashboard informa ausência de forecast sem fabricar datas. As specs ADR/BR de prioridade estão relacionadas a SSDD-934/935 após a sincronização do roadmap.

O cenário `SSDD-VEL-20261111` está publicado sem execução QA. A suíte automatizada do produto não certifica o cenário, e a pré-condição depende de fixture de geração 2. O catálogo publicado reflete decisões técnicas/negócio vigentes; o backlog e a execução do cenário continuam nos gates de aceite apropriados.

As revisões publicadas registram o contrato vigente do projeto, mas não equivalem a aceite formal de backlog, certificação QA ou aprovação de produção. A especificação de operações registra que CI remota, metas de operação e evidências do ambiente de produção precisam ser confirmadas para o release.
