# Análise de qualidade e plano de melhorias

**Data:** 2026-11-12 · **Escopo:** revisão do produto SSDD MCP (v0.2.0 candidata) com foco em uma pergunta: *o que falta para que a entrega de um agente seja igual ao que foi pedido?*

**Método:** leitura de `README.md`, `ROADMAP.md`, `docs/status.md`, `docs/mcp.md`, `docs/specification.md`, skills canônicas e inspeção de `src/mcp/server.ts`, `src/application/work-item-workflow.ts`, perfis, CI e estrutura de testes. `npm run check` passou nesta revisão com lint, typecheck e 197 testes em 31 suítes. Os itens `SSDD-938` em diante são **propostas**: não têm estimativa confirmada e não entram em sprint sem refinamento do PO.

**Registro no MCP (2026-11-12):** as 18 propostas foram criadas como tarefas Draft `SSDD-141`–`SSDD-158` sob a história `SSDD-102` (Feature `SSDD-101`), com os aliases estáveis `SSDD-938`–`SSDD-955` vinculados na mesma ordem por `roadmap_id_bind`. Fase, pontos sugeridos, dependências e aceite proposto estão na descrição de cada item. As 25 dependências das seções 4.1–4.3 foram gravadas como arestas `depends_on` (trace_link_add), sem ciclos. `.ssdd/roadmap-id-map.json` não foi regenerado.

## 1. Resumo

O projeto é forte em **governança e rastreabilidade** e fraco em **verificação**. Ele registra muito bem *quem disse o quê, sobre qual revisão, em que ordem*; mas quase tudo o que afirma que uma entrega está correta é uma declaração do próprio agente (evidência por URI não conferida, execução de teste autodeclarada, build como texto livre). A única barreira real é a certificação humana de QA, que vira gargalo.

Três constatações orientam o plano:

1. **O esperado é pouco preciso.** Critérios de aceite são texto livre, tarefas não têm critérios próprios, o conteúdo das especificações não é validado por tipo e não há registro de dúvidas em aberto.
2. **O entregue não é comparado com o esperado.** Não existe relatório de entrega por critério, revisão independente, vínculo com o diff real nem uso do resultado de CI nos gates. A Definition of Done é versionada, mas não é aplicada a nenhum item.
3. **O processo é pesado demais para ser usado.** No próprio workspace há 140 itens: 134 Draft, 3 Done, zero tarefas iniciáveis — e o código foi implementado mesmo assim. Quando o caminho oficial custa caro, o agente trabalha por fora e as garantias deixam de valer.

## 2. O que está bem resolvido

| Área | Avaliação |
|---|---|
| Modelo de domínio | Revisões imutáveis, baseline fixada no Ready, impacto ao publicar regra nova, histórico append-only. É a base certa para "entregar contra uma versão conhecida". |
| Concorrência e repetição | `expectedVersion`, `requestId` idempotente, cursores presos a watermark, `task_start` atômico. Protege bem contra agentes paralelos e retries. |
| Limites de autonomia | Gates humanos por tipo de principal, aprovação de uso único vinculada a hash de argumentos, perfil separado de RBAC. |
| Contexto por tarefa | `task_context_get` com proveniência, modo pinned/preview, warnings de drift e orçamento de caracteres. |
| Contrato de erros | Envelope com `code`, `details`, `retryable`, `correlationId`; `INTERNAL_ERROR` sem vazamento. |
| Operação | `doctor`, backup com manifesto, restore validado, export, container sem privilégios. |
| Testes e documentação | Suíte com clientes MCP reais em processo separado, benchmark de 10 mil itens, 26 ADRs, documentação sincronizada com o código. |

## 3. Lacunas encontradas

### 3.1 Fidelidade da entrega (prioridade máxima)

| # | Lacuna | Evidência | Efeito |
|---|---|---|---|
| L1 | Verificação declarativa | `evidence_add` guarda o URI sem buscá-lo; `test_run_record` aceita `passed` sem anexo; `buildId` é texto livre; snapshots de `workflow_run` do GitHub "não alteram item nem certificam QA" (`docs/mcp.md`). | Um agente pode satisfazer os gates sem ter executado nada. A certificação humana vira carimbo. |
| L2 | DoD não aplicada | `definition-of-done` só é referenciada em sprint; `work-item-workflow.ts` não consulta a DoD em nenhum gate e `task_context_get` não a entrega. | A definição de pronto do time não chega ao agente nem bloqueia Done. |
| L3 | Revisão vazia | `in_review → in_validation` exige apenas papel `developer`; não há registro de revisão, de achados, nem regra revisor ≠ autor. | O estado existe, o controle não. |
| L4 | Esperado ambíguo | Critério = `description` livre; tarefa só tem "descrição de saída"; `content` de especificação é "objeto JSON não vazio" sem schema por tipo. | Duas leituras válidas do mesmo item; o gate de Ready passa mesmo assim. |
| L5 | Sem dúvidas rastreadas | Questões de refinamento são comentários; comentários não são seção do contexto de tarefa. | O agente não sabe o que ficou em aberto e preenche com suposição. |
| L6 | Sem vínculo com o código | Não há arquivos alterados, commits ou escopo de caminhos por tarefa; reserva de arquivos (SSDD-929) está pendente. | Mudança fora de escopo e colisão entre agentes não são detectadas. |
| L7 | Sem relatório de entrega | Nenhuma tool pede ao agente "critério por critério, o que foi atendido, com qual evidência, e o que desviou". | QA e PO reconstroem a comparação à mão. |

### 3.2 Uso pelos agentes

| # | Lacuna | Evidência | Efeito |
|---|---|---|---|
| L8 | Fricção alta | 134/140 itens Draft; fila sem tarefa iniciável; Ready de PBI exige cenário publicado por QA humano para cada critério. | O fluxo oficial é contornado, inclusive neste repositório. |
| L9 | Muitas chamadas para começar | A skill de Dev pede `task_execution_queue_get` → `work_item_get` → `task_context_get` → `task_workflow_get` → `task_start_check` → `task_start`. | Custo de contexto e chance de pular passo. |
| L10 | Tools sem anotações | Zero ocorrências de `readOnlyHint`/`destructiveHint`/`idempotentHint` em 97 tools. | Clientes não distinguem leitura de mutação para auto-aprovação. |
| L11 | Contexto incompleto | Glossário omitido pelo resolver; DoD, comentários, lições de retrospectiva e comandos de verificação do repositório ficam fora. | O agente decide sem informação que o time já tem. |
| L12 | Skills densas | Cada passo das skills é um parágrafo com 8–12 regras. | Regras do meio do parágrafo são as primeiras a serem esquecidas. |
| L13 | Sessões frágeis | Sessão não fecha após queda; sem heartbeat (SSDD-928 pendente). | Tempo e autoria de agentes ficam pouco confiáveis. |

### 3.3 Engenharia do projeto

| # | Lacuna | Evidência |
|---|---|---|
| L14 | Arquivos monolíticos | `src/mcp/server.ts` 4.654 linhas, com 110 registros dentro de uma única função; `dashboard.js` 3.262 linhas; `migrations.ts` 2.807. |
| L15 | Frontend sem teste de comportamento | Testes do dashboard cobrem API e presença de assets; polling, formulários e drag and drop não têm teste DOM. Vários smokes visuais constam como "não executados" em `docs/status.md`. |
| L16 | Documentos obrigatórios grandes demais | `AGENTS.md` manda ler `ROADMAP.md` (~35 mil tokens) e `docs/status.md` (~39 mil tokens) antes de qualquer mudança; ambos excedem o limite de leitura de uma chamada. `status.md` acumula registros históricos já superados. |
| L17 | Release não fechada | CI remota nunca verificada, candidato sem commit/push, tag v0.2.0 pendente. |
| L18 | Sem medida de resultado | Não há taxa de aceite na primeira passagem, retrabalho, motivo de bloqueio de gate ou defeito escapado; tempo de ciclo (SSDD-930) pendente. Não há avaliação automatizada de skills/prompts. |

## 4. Propostas

Pontos são sugestão inicial para refinamento. "Depende de" usa IDs existentes do roadmap.

### 4.1 Fase A — Entregar igual ao esperado

| ID | Proposta | Pts | Depende de | Aceite proposto |
|---|---|---:|---|---|
| SSDD-938 | Critérios de aceite estruturados e critérios em tarefas | 5 | 206 | Critério ganha campos opcionais `given/when/then`, `verification` (`automated`, `manual`, `inspection`) e exemplo; tarefa aceita checklist de saída com IDs estáveis; revisões antigas continuam legíveis; contexto e relatório de qualidade exibem os campos. |
| SSDD-939 | Revisão de prontidão e perguntas em aberto | 8 | 938 | `work_item_readiness_review` devolve achados determinísticos (critério sem resultado observável, termo vago, termo fora do glossário, critério sem cenário, tarefa sem checklist). Entidade *pergunta* com `question_open/answer/list`; pergunta aberta marcada como bloqueante impede Ready e aparece no contexto da tarefa. |
| SSDD-940 | Relatório de entrega por critério | 8 | 938, 926 | `task_delivery_report_submit` exige, para cada critério/checklist da baseline, status (`met`, `partial`, `not_met`, `not_applicable`), evidência, suposições e desvios de escopo; é imutável e versionado; `in_progress → in_review` passa a exigir relatório sem `not_met`; dashboard mostra esperado × entregue lado a lado. |
| SSDD-941 | Evidência verificada por CI | 8 | 703, 304 | Execução ganha `origin` (`agent`, `human`, `ci`) e hash de anexo; `workflow_run` concluído cujo SHA corresponde ao build vira evidência `verified`; import de JUnit/Cucumber associa resultados a cenários por tag; política do projeto pode exigir origem `ci` para cenários `automated`. Execução de agente continua sendo observação. |
| SSDD-942 | Revisão independente como gate | 5 | 940 | `review_record` grava decisão (`approved`, `changes_requested`) e achados ligados a critérios; revisor não pode ter sessão de desenvolvimento na tarefa; `in_review → in_validation` exige aprovação vigente para a revisão do relatório; revisão por agente é registrada como consultiva conforme política. |
| SSDD-943 | Definition of Done aplicada por item | 5 | 402, 940 | DoD pinada entra em `task_context_get` (seção `definitionOfDone`); relatório de entrega atesta cada critério da DoD; gate Done do PBI falha com critério não atestado; revisão de DoD posterior gera warning, não reprocessa itens Done. |
| SSDD-944 | Vínculo entre tarefa e mudança de código | 5 | 703, 940 | Relatório e webhook de PR registram branch, commits e caminhos alterados; tarefa pode declarar escopo de caminhos esperado; alteração fora do escopo vira achado visível na revisão, não bloqueio automático. Prepara SSDD-929. |

### 4.2 Fase B — Menos fricção, mais contexto

| ID | Proposta | Pts | Depende de | Aceite proposto |
|---|---|---:|---|---|
| SSDD-945 | Briefing de tarefa em uma chamada | 5 | 303, 933, 943 | `task_briefing_get` reúne contexto, workflow, gates de início, DoD, termos de glossário citados, perguntas abertas e próxima ação recomendada, com o mesmo orçamento/cursor do contexto; skills passam a usá-lo como primeiro passo. |
| SSDD-946 | Anotações e descrições das tools | 3 | 906 | Toda tool declara `readOnlyHint`, `destructiveHint` e `idempotentHint` coerentes; descrição cita pré-condição e erro mais comum; teste de contrato falha para tool sem anotação. |
| SSDD-947 | Política de gates por projeto | 8 | 304 | Projeto escolhe `lite`, `standard` ou `strict` em revisão versionada e auditada; `lite` permite Ready sem cenário publicado e certificação pelo mesmo humano, mantendo baseline, relatório e evidência; a política vigente aparece em todo relatório de gates. ADR registra o que cada nível dispensa. |
| SSDD-948 | Orientações do projeto no contexto | 5 | 406, 945 | Seção `guidance` com convenções do repositório (comandos de verificação, padrões), ações de retrospectiva vigentes e motivos das últimas devoluções do mesmo PBI; conteúdo versionado e com proveniência. |
| SSDD-949 | Modelos de item e de workflow | 3 | 931 | Modelos versionados por tipo de trabalho (ex.: endpoint, migração, correção) pré-preenchem checklist e etapas ponderadas; uso é opcional e auditado. |
| SSDD-950 | Skills em formato de checklist | 2 | 920 | Cada skill tem no máximo uma instrução por linha, com seções *sempre*, *nunca* e *quando bloqueado*; instalador sem drift nos três clientes. |

### 4.3 Fase C — Medir e sustentar

| ID | Proposta | Pts | Depende de | Aceite proposto |
|---|---|---:|---|---|
| SSDD-951 | Métricas de qualidade de entrega | 5 | 940, 942 | `metrics_get` expõe aceite na primeira passagem, devoluções por motivo, gates mais bloqueantes, critérios `partial/not_met` e bugs ligados a histórias Done, segmentados por tipo de principal; sem ranking individual. |
| SSDD-952 | Avaliação automatizada de skills e prompts | 8 | 950 | Roteiros de fixture verificam ordem de chamadas, recusa de fabricar evidência e tratamento de `isError`; resultado entra no `npm run check` de forma determinística (sem chamada a modelo) e há modo opcional com modelo real fora da CI. |
| SSDD-953 | Dividir `src/mcp/server.ts` por domínio | 5 | 906 | Registro de tools em módulos por área com helper único de resultado/erro; catálogo, schemas e testes de paridade inalterados. |
| SSDD-954 | Modularizar e testar o dashboard | 8 | 404 | `dashboard.js` em módulos ES; smoke de navegador no CI cobre login, board, transição recusada por gate e formulário de PBI. |
| SSDD-955 | Reduzir a leitura obrigatória | 3 | — | `docs/status.md` vira retrato atual (até ~150 linhas) e o histórico vai para `docs/changelog.md`; `ROADMAP.md` separa backlog ativo de sprints concluídas; `AGENTS.md` aponta para os arquivos curtos. |

### 4.4 Itens existentes que devem subir de prioridade

| ID | Motivo |
|---|---|
| Release v0.2.0 (SSDD-605) | Commit do candidato, CI remota verde e tag. Tudo o que vem depois depende de uma base publicada. |
| SSDD-928 | Sessões órfãs distorcem métricas e bloqueiam handoff entre agentes. |
| SSDD-929 | Necessária para agentes paralelos; SSDD-944 entrega metade do caminho. |
| SSDD-906 | Paridade automatizada evita que as novas tools nasçam sem documentação/perfil. |
| SSDD-930 | Tempo de ciclo e espera completam SSDD-951. |
| SSDD-925 | Só faz sentido depois de SSDD-947; hoje o custo de curar 134 Drafts é o próprio sintoma. |

## 5. Ordem recomendada

1. **Fechar a base:** release v0.2.0, SSDD-955, SSDD-946.
2. **Destravar o uso:** SSDD-947 e, com ela, passar o backlog do próprio projeto pelos gates (dogfooding).
3. **Precisar o esperado:** SSDD-938, SSDD-939.
4. **Comparar o entregue:** SSDD-940, SSDD-943, SSDD-942.
5. **Verificar de fato:** SSDD-941, SSDD-944.
6. **Ergonomia:** SSDD-945, SSDD-948, SSDD-950, SSDD-949.
7. **Medir e sustentar:** SSDD-951, SSDD-952, SSDD-953, SSDD-954, mais SSDD-928/929/930.

Fases A–C somam 99 pontos propostos (A: 44, B: 26, C: 29).

## 6. Como saber se funcionou

| Indicador | Hoje | Alvo após Fase A |
|---|---|---|
| Itens do próprio projeto que passaram pelos gates | 3 de 140 | Todo trabalho novo |
| PBIs aceitos sem devolução de QA/revisão | Não medido | Medido e em alta por três sprints |
| Critérios com verificação de origem `ci` | 0 | Maioria dos critérios `automated` |
| Done com relatório de entrega completo | Não existe | 100% |
| Chamadas MCP até iniciar uma tarefa | 6 | 2 (`task_briefing_get`, `task_start`) |

## 7. Decisões que precisam de ADR

- Níveis de política de gates e o que cada um dispensa (SSDD-947).
- Origem e grau de confiança de execuções e evidências; quando CI substitui ou complementa certificação humana (SSDD-941).
- Formato e imutabilidade do relatório de entrega e sua relação com baseline (SSDD-940).
- Revisão por agente: consultiva ou válida para o gate (SSDD-942).

## 8. Limites desta análise

- Leitura de código foi dirigida (gates, transições, registro de tools, CI); não houve auditoria linha a linha nem revisão de segurança.
- O dashboard não foi aberto em navegador nesta revisão.
- Os números de backlog vêm de `docs/status.md`; o banco do workspace só foi consultado e alterado depois, para registrar as propostas como Draft.

## Achados do uso do próprio MCP (2026-11-12)

Ao seguir a fila do MCP para escolher e fechar a SSDD-158, apareceram atritos reais. Os dois primeiros foram corrigidos na hora; os demais viraram tarefas.

| # | Achado | Situação |
| --- | --- | --- |
| U1 | Fila vazia não dizia o motivo nem a próxima tarefa. | Corrigido: `emptyReason` e `upNext` em `task_execution_queue_get`. |
| U2 | `work_item_gate_check` para Done não indicava que `in_progress → done` exige `in_review` e `in_validation`; a transição direta falhou. | Corrigido: campo `transitionPath`. |
| U3 | ~70 tarefas históricas entregues localmente continuam Draft ("permanece Draft") e dominam `upNext`; também bloqueiam por dependência as novas SSDD-141–157. A fila reflete a burocracia, não o trabalho pendente. | Tarefa SSDD-956 (rótulo "entregue localmente, aceite pendente" na fila e fechamento retroativo com evidência). |
| U4 | O mesmo principal implementa, revisa, valida e conclui a tarefa; o MCP aceita. A SSDD-158 foi fechada assim e a razão da transição teve de registrar a autorrevisão. | Tarefa SSDD-957 (política de independência de revisão/validação, ao menos como aviso nos gates). |
| U5 | Nomes de parâmetro inconsistentes (`itemIdOrKey` vs `taskIdOrKey`) e comandos de escrita que não devolvem `version` (estimate, propose), forçando releitura ou tentativa e erro com `expectedVersion`. | Tarefa SSDD-958 (devolver `version` em todo resultado de escrita; aceitar alias de parâmetro). |
| U6 | O servidor roda uma cópia instalada em `.ssdd/agent-runtime`; mudanças do código só chegam após `agents:install --apply` e reinício do processo. | Documentado; candidato a um comando `dev:reload`. |
| U7 | Critério marcado como obrigatório exige cenário publicado; a falha só aparece no gate. | Mensagem do gate já lista os critérios; avaliar aviso na proposta de revisão. |
| U8 | Uma tarefa `in_progress` do próprio executor aparece em `blocked` com `task_session_already_active`, em vez de aparecer como "em andamento, continue". A fila mistura bloqueio de início com trabalho já em curso. | Corrigido: `inFlight` em `task_execution_queue_get`. |
| U9 | Entrega parcial não tem estado próprio: a SSDD-159 entregou uma das duas partes do aceite e ficou em `in_review` com a ressalva só no motivo da transição. | Pendente: critérios de aceite por tarefa (hoje só PBIs têm critérios). |
| U10 | Dependências entregues localmente mas Draft pareciam trabalho pendente. | Corrigido: `dependenciesAwaitingAcceptance` na fila. |
| U11 | Aceite retroativo de uma cadeia de 13 tarefas custou ~8 chamadas por tarefa (atribuir, Ready, `task_start`, evidência, sessão, três transições) mais criar critério/estimativa/Ready nas 3 histórias. Nada indica o custo antes de começar. | Pendente: ferramenta de aceite retroativo em lote, com evidência e motivo únicos e marca `retroactive` na auditoria. |
| U12 | `work_item_list` aceitou `type` e `state` e devolveu épicos, features e itens `done` misturados: o filtro foi ignorado sem erro. | Pendente: investigar nomes de filtro e rejeitar parâmetros desconhecidos. |
| U13 | `work_item_gate_check` só aceita `ready` e `done`; não há como ver os gates de `in_review`/`in_validation` antes de tentar a transição. | Pendente: aceitar qualquer estado alvo ou listar os gates por transição em `transitionPath`. |
| U14 | A SSDD-305 pede "Tag v0.1", mas o pacote já está em 0.2.0 e não há tags: o critério ficou obsoleto sem que o MCP perceba. | Pendente: decisão de release do usuário; a tarefa ficou `in_review`. |
| U15 | A fila devolve a chave gerada (`SSDD-105`), mas `task_context_get`/`task_start_check` resolvem `SSDD-105` como o alias do roadmap (item SSDD-11): chave gerada e alias colidem e a resolução escolhe o alias sem avisar. | Pendente: a fila deve devolver também o `id` como forma canônica de chamada, ou a resolução deve avisar a ambiguidade (`roadmap_id_resolve`). |
| U16 | Tarefa implementada fora do MCP, com a sessão aberta só depois (ordem invertida na SSDD-903), não deixa rastro de que o código veio antes do `task_start`. | Pendente: campo opcional `startedAfterImplementation` ou checagem do commit de evidência contra a data do início. |
