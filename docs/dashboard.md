# Dashboard e projeções

## Abas disponíveis hoje

O dashboard atual tem seis abas; o roadmap detalha a expansão executiva, técnica e de planejamento.

| Aba | O que permite fazer |
|---|---|
| Métricas | Consultar burndown, burnup, previsão, velocidade, WIP, bloqueios e cobertura; filtrar por time, marco, sprint e data de corte; abrir a composição dos indicadores disponíveis e o esforço/calibração por Developer. |
| Product Backlog | Pesquisar histórias e bugs, filtrar por tipo, prioridade, estado e versão, cadastrar um PBI e consultar seus detalhes, tarefas filhas e revisões. |
| Board | Consultar o fluxo dos itens, abrir detalhes e propor transições por arrastar/soltar ou controles de teclado; gates e autorização são validados pelo serviço de aplicação. |
| Qualidade | Criar cenários, associá-los a tarefas e critérios, propor/publicar revisões como QA humano, registrar execuções ligadas à revisão publicada, build e tarefas verificadas e consultar resultados recentes. |
| Atividade | Consultar eventos de auditoria do projeto em páginas, com ator, motivo, transição e watermark. |
| Retrospectiva | Consultar retrospectivas de sprints fechadas e revisões históricas. |

A interface atualiza os dados automaticamente a cada 30 segundos e também oferece atualização manual. Os filtros, a data observada e o watermark aparecem nas consultas de métricas. Cada gráfico tem informação equivalente em texto ou tabela onde aplicável. O detalhe de PBI lista tarefas filhas navegáveis. O detalhe de tarefa mostra hierarquia, critérios, regras, decisões técnicas, cenários, runs/builds, alertas de drift, datas derivadas de sessões e eventos de release e o histórico de Developers, falhas e rollbacks. Contexto extenso tem paginação explícita.

## Abrir o dashboard

No checkout do projeto, compile o pacote e inicialize o workspace uma vez antes do primeiro uso. Os comandos de preparação estão no [início rápido do README](../README.md#preparar-um-workspace). Em seguida, inicie o servidor:

```sh
node dist/src/cli.js dashboard --workspace . --port 4318
```

Abra no mesmo computador a URL com token de uso único impressa no terminal. O primeiro acesso troca o token por um cookie de sessão local e remove o token da barra de endereço. Mantenha o processo ativo durante o uso; `Ctrl+C` encerra o dashboard. Para outro workspace, informe seu caminho em `--workspace`; use outra porta se 4318 já estiver ocupada.

## Como as telas se conectam

```mermaid
flowchart LR
  PBI[PO cadastra PBI] --> REV[Propõe revisão imutável]
  REV --> PUB[PO publica revisão]
  PUB --> SC[QA cadastra cenário e propõe revisão]
  SC -->|associa tarefa(s)| TASK[Tarefa de desenvolvimento]
  SC --> SPUB[QA publica revisão do cenário]
  SPUB --> RUN[Developer ou QA registra execução]
  TASK -->|inclui UUID/chave| RUN
  RUN --> LINK[Execução fica ligada à tarefa, cenário, revisão publicada e build]
  LINK --> CERT[QA certifica pelo MCP]
  CERT --> DONE[Gate Done valida baseline, build, evidências e certificação]
```

O dashboard cobre cadastro/revisão/publicação de PBI, cadastro/revisão/publicação de cenário e registro de execuções. Os formulários de cenário e execução aceitam uma chave ou UUID de tarefa por linha; a edição de cenário pré-carrega os vínculos da revisão publicada para preservar a associação ao propor nova revisão. No detalhe da tarefa, o dashboard mostra os dados versionados consultados por `task_context_get`. Certificar execução é uma operação MCP; os detalhes do PBI exibem certificações já registradas. Essa separação mantém explícitos o papel humano e o gate aplicado ao concluir um item.

## Conteúdo da aba Métricas

A aba **Métricas** é a entrada do dashboard. Ela reúne burndown da sprint, burnup do marco, cenários de previsão P25/P50/P75, velocidade recente, WIP, bloqueios e cobertura. O seletor global de time filtra sprints, velocidade e previsão; os filtros da aba selecionam marco, sprint e data local de corte. Em projetos com vários times, o usuário escolhe explicitamente um time; uma única equipe é selecionada automaticamente. WIP e cobertura continuam sendo métricas do projeto. A tela informa data observada e watermark; séries usam pontos como unidade explícita e a previsão mostra geração, tamanho de amostra, capacidade e riscos.

Os gráficos exibem até 90 pontos recentes e cada ponto pode ser selecionado pelo mouse ou teclado. A seleção recalcula a leitura no corte daquele dia e lista os PBIs ativos com estado e estimativa usados no total. O detalhamento do marco valida que escopo, restante, concluído e cancelado reconciliam com a série. O detalhamento da sprint usa o último dia efetivo da janela, respeitando seu fechamento. A tabela de WIP lista idade e impactos, a tabela de cobertura abre cada PBI e a tabela de velocidade mostra pontos entregues e horas registradas sem transformar uma unidade na outra. A tabela individual exibe horas ativas, tarefas concluídas, estimativa/execução e fator de calibração; o fator só aparece com pelo menos cinco tarefas concluídas com estimativa confirmada. O fator é consultivo e não altera as estimativas automaticamente.

Quando não há time, marco, sprint, amostras ou itens, a aba explica qual dado está ausente. `GET /api/v1/projects/{projectId}/teams` lista os IDs, nomes, configuração e composição disponíveis. `GET /api/v1/projects/{projectId}/dashboard-metrics` e o tool MCP `metrics_get` chamam a mesma projeção de aplicação, dentro de uma transação SQLite comum. Ambos aceitam `teamId`, `milestoneId`, `sprintId` e `asOfDate`; projeto com vários times exige seleção explícita e time inválido retorna opções disponíveis. `none` desativa a seleção de marco ou sprint. A seleção é incluída na chave do cache e na consulta de forecast, velocidade e opções de sprint; previsões persistem snapshots separados por time. A primeira consulta pode gravar um snapshot após a migração v23 sem alterar o escopo nem adicionar evento de domínio. O cache em memória dura até 1 s, após nova checagem de autorização e watermark.

## Capacidade

O resumo da sprint ativa mostra a capacidade calculada e congelada na abertura, junto do objetivo, intervalo e itens. A configuração de calendários, membros, dedicação, feriados ou ausências é feita pelo MCP usando `team_create` e `team_capacity_set`; `team_capacity_get` consulta o resultado. Consulte a seção [Time, calendário e capacidade](mcp.md#time-calend%C3%A1rio-e-capacidade) no contrato MCP.

Por pessoa e dia útil, capacidade = máximo entre 0 e horas padrão menos ausência, multiplicado pela dedicação. A capacidade da sprint é a soma. Dedicação fica entre 0 e 100%. Exemplo: com dois membros, dez dias e seis horas úteis, A com um dia de ausência e dedicação integral contribui 54 h; B a 50% contribui 30 h; total 84 h. A capacidade planejada fica registrada na abertura e correções são auditadas. Horas restantes de tarefas são comparáveis à capacidade; story points representam estimativa relativa do PBI e não são convertidos diretamente para horas.

O MCP calcula capacidade a partir de configurações imutáveis, calendário, dedicação e ausências. `sprint_draft` fixa a versão da configuração e `sprint_start` guarda o cálculo detalhado por dia e pessoa. Planejamento e capacidade também são consultáveis pela API local. O backlog `SSDD-97–100` planeja completar operações de planejamento e paridade no dashboard.

## Backlog e board local

O Product Backlog lista histórias e bugs do projeto com busca por chave/título, filtro por tipo, prioridade, estado e versão. O seletor de time escolhe a sprint ativa e as retrospectivas disponíveis para o planejamento; com vários times, nenhuma sprint é inferida até uma seleção. Quando há sprint ativa no time escolhido, o board limita-se ao escopo comprometido e o Product Backlog reúne o restante; sem sprint ativa, o board mostra os itens que já entraram no fluxo. O resumo da sprint expõe objetivo, datas, quantidade de PBIs, pontos e horas de capacidade da abertura.

Cards de PBI abrem detalhe com descrição, critérios, estimativas, pai, responsável, versões e lista de tarefas filhas navegável. No detalhe da tarefa, a interface consulta o contexto autorizado pelo serviço MCP, junto da timeline, sessões de desenvolvimento, deploys e revisões. Exibe regra de negócio e especificação com revisão, origem (baseline, herança ou vínculo direto) e tipo de link. `implements` sinaliza implementação declarada; `relates_to` fornece contexto relacionado. Cenários e execuções identificam relação por cobertura ou vínculo direto e preservam revisão/build. Drag and drop e o botão “Mover item” por teclado abrem o mesmo formulário de transição. A pessoa informa o motivo e, para Done, a build candidata. A interface chama o endpoint HTTP compartilhado com `expectedVersion`, `requestId` e CSRF; as regras de autorização, workflow, baseline e gates continuam no serviço de aplicação. Um gate recusado mantém o card no estado atual e mostra o diagnóstico. Conflito de versão mantém o estado atual, informa `VERSION_CONFLICT` e recarrega a lista para apresentar a versão mais recente. A tela atualiza a cada 30 segundos e também por ação manual.

O botão **Novo PBI** cadastra histórias e bugs com Feature pai, descrição, prioridade e critérios. Em detalhes, **Editar conteúdo** propõe uma revisão imutável; um PO humano publica o rascunho pelo próprio detalhe. Revisões publicadas e rascunhos permanecem visíveis. As operações de atribuição, estimativa, comentários, ranking e vínculos ainda estão planejadas no backlog `SSDD-89`.

Para executar o fluxo de QA, crie um cenário na aba Qualidade, associe-o ao PBI/critério pela cobertura e às tarefas verificadas pelo campo **Tarefas associadas**, proponha sua revisão e publique-a como QA humano. Registre uma execução escolhendo essa revisão publicada e informando build, resultado, notas, URI de evidência e tarefas verificadas. Uma revisão em rascunho não aceita execução. A execução é imutável e conserva as tarefas exatas que validou, a revisão e a build. Para certificar um resultado compatível com a baseline, use `test_run_certify` pelo MCP; certificação não é feita pela interface nesta versão.

## Qualidade e atividade

A tabela de cobertura da aba Métricas mostra até 20 histórias e bugs, com percentual de critérios obrigatórios cobertos, estado da baseline e versão do item. Sem baseline, a linha é identificada como preview; a cobertura não é apresentada como aprovação. A resposta também informa `itemsTotal` e `itemsTruncated`; contagens e percentuais consideram todos os PBIs do projeto, mesmo quando os detalhes são limitados. Abra o detalhe do PBI para consultar seu snapshot completo. No detalhe, o relatório reconstrói os critérios fixados e lista as revisões de cenário incluídas na baseline, última execução por build, certificação compatível e evidências anexadas, com paginação das evidências.

A aba **Qualidade** mostra um gráfico agregado dos 100 runs mais recentes por `passed`, `failed`, `blocked` e `skipped`, com legenda textual equivalente. O histórico mostra cenário, revisão exata, build e link seguro para evidência HTTP(S). O gráfico ainda não tem filtros de build/período nem drill-down; gráfico de cobertura com drill-down e certificação pela UI continuam planejados em `SSDD-93`, `SSDD-95` e `SSDD-96`.

A atividade do projeto e a timeline do PBI usam `audit_events`; cada transição inclui `transitionId` e aponta para o registro original com ator, motivo, versão e estado anterior/posterior. A atividade tem páginas de até 100 eventos, ordenação mais recente primeiro e cursor vinculado ao watermark do projeto. Uma alteração concorrente invalida o cursor e pede uma leitura nova.

A aba Retrospectiva lista sprints fechadas e mostra resumo, práticas para continuar/interromper/experimentar e ações com responsável humano e PBI opcional. O seletor permite ler uma revisão histórica. A gravação usa `sprint_retrospective_set` pelo MCP; cada atualização preserva uma nova revisão append-only.

## API local e sessão

O comando inicia uma API HTTP somente em `127.0.0.1`. Abrir a URL de bootstrap troca o token por um cookie de sessão `HttpOnly`, `SameSite=Strict`, válido por 12 horas. `GET /api/v1/session` devolve o principal local, projetos autorizados e o token CSRF da sessão. A identidade é a mesma do transporte MCP local; o cliente não pode escolher `principalId` no payload.

Rotas disponíveis:

- `GET /api/v1/health`, `GET /api/v1/projects` e `GET /api/v1/projects/{projectId}`.
- `GET /`, `/dashboard.js` e `/dashboard.css` servem a interface local com políticas de segurança de conteúdo.
- `GET /api/v1/projects/{projectId}/quality` resume cobertura obrigatória por PBI; `GET /api/v1/projects/{projectId}/audit` lista eventos auditados, com filtros `entityType`/`entityId`, `limit` e `cursor`.
- `GET /api/v1/projects/{projectId}/dashboard-metrics` agrega burnup, burndown, previsão, velocidade, WIP e cobertura com opções de marco/sprint e watermark comum; filtros opcionais: `milestoneId`, `sprintId` e `asOfDate`.
- `GET /api/v1/projects/{projectId}/developer-execution-metrics` retorna esforço individual agregado por período e filtro opcional `developerPrincipalId`; a consulta usa as mesmas regras de autorização do MCP.
- `GET /api/v1/projects/{projectId}/development-sessions?itemIdOrKey=...&limit=...` lista sessões da tarefa, com nome do Developer, horários UTC, status e duração ativa.
- `GET /api/v1/projects/{projectId}/deployment-events?itemIdOrKey=...&environment=homologation|production&limit=...` consulta eventos observados, incluindo falha e rollback. O dashboard mostra o último evento aprovado por ambiente como data resumida.
- `GET /api/v1/projects/{projectId}/work-items`, com filtros repetidos `type` e `state`, além de `parentId`, `search`, `limit` e `cursor`.
- `POST /api/v1/projects/{projectId}/work-items` cria PBI; `GET /api/v1/projects/{projectId}/work-items/{itemIdOrKey}/revisions` consulta revisões.
- `POST /api/v1/projects/{projectId}/work-items/{itemIdOrKey}/revisions` propõe conteúdo imutável e `POST .../revisions/{revisionNumber}/publish` publica conforme o papel PO.
- `GET /api/v1/projects/{projectId}/work-items/{itemIdOrKey}`.
- `GET /api/v1/projects/{projectId}/work-items/{taskIdOrKey}/context`, com `profile`, parâmetros repetidos `include`, `maxChars` e `cursor`, retorna a mesma projeção autorizada de `task_context_get` e pode ser paginada.
- `GET /api/v1/projects/{projectId}/work-items/{itemIdOrKey}/quality`, com cursor opcional para continuar as evidências; `GET /api/v1/projects/{projectId}/work-items/{itemIdOrKey}/timeline` mostra eventos do PBI.
- `GET /api/v1/projects/{projectId}/sprints?status=active` e `GET /api/v1/projects/{projectId}/sprints/{sprintIdOrKey}`.
- `GET|POST /api/v1/projects/{projectId}/scenarios` lista e cria cenários; `GET /api/v1/projects/{projectId}/scenarios/{scenarioIdOrKey}` consulta revisões e snapshots.
- `GET /api/v1/projects/{projectId}/scenarios/{scenarioIdOrKey}/revisions/{revisionNumber}/work-items` lista as tarefas vinculadas à revisão, para que a UI preserve as relações ao propor nova revisão.
- `POST /api/v1/projects/{projectId}/scenarios/{scenarioIdOrKey}/revisions` propõe revisão; `POST .../revisions/{revisionNumber}/publish` publica revisão humana QA.
- `GET /api/v1/projects/{projectId}/test-runs?scenario={key}&limit={1..100}` consulta execuções recentes; `POST /api/v1/projects/{projectId}/scenarios/{scenarioIdOrKey}/test-runs` registra execução da revisão publicada, build, resultado e `workItemIdOrKeys` opcional com as tarefas verificadas.
- `GET /api/v1/projects/{projectId}/sprints/{sprintIdOrKey}/retrospective`, com `revisionNumber` opcional para leitura histórica.
- `POST /api/v1/projects/{projectId}/work-items/{itemIdOrKey}/transition`, usando o mesmo comando de transição do MCP.
- `POST /api/v1/projects/{projectId}/sprints/{sprintIdOrKey}/retrospective`, usando o mesmo comando do MCP e proteção CSRF; a autorização de facilitador humano é aplicada no serviço.

O servidor valida `Host` e `Origin` de loopback, não habilita CORS e define políticas de cache, CSP, enquadramento e referrer. Toda escrita exige `Origin` exata e `X-SSDD-CSRF` obtido na sessão. O token de bootstrap é consumido uma vez por processo; a sessão vive em memória e desaparece ao encerrar o servidor. Erros mantêm `code`, `message`, `details`, `retryable` e `correlationId`; uma falta de associação ao projeto produz `FORBIDDEN`, igual ao MCP. Todas as rotas de mutação chamam os serviços de aplicação compartilhados e não escrevem diretamente no SQLite. A interface continua local e não carrega scripts ou fontes externos. As demais operações MCP seguem o roadmap `SSDD-85–100`.

Iniciar/pausar/concluir sessões e gravar homologação/produção são mutações disponíveis pelo MCP nesta versão; o dashboard consome as consultas e apresenta as datas/histórico. Use `ssdd_start_task` ou `development_session_*` para registrar desenvolvimento e `deployment_event_record` para registrar um resultado efetivamente observado no ambiente.

## Séries e unidades

| Métrica | Definição |
|---|---|
| Burndown de pontos | Para cada fechamento de dia no fuso do projeto, somar pontos confirmados dos PBIs integrantes e ainda abertos. Inicia pelos compromissos congelados no início da sprint. Deltas separam inclusão, saída, reestimativa, conclusão e reabertura. Um item removido reduz escopo, sem gerar entrega |
| Linha ideal | Pontos fixados no snapshot de início reduzidos linearmente pelos dias úteis do calendário da sprint. Mudanças aparecem apenas na série real e no histórico de escopo |
| Burnup do marco | Séries diárias de escopo ativo, pontos concluídos e remanescentes reconstruídas a partir dos snapshots de aprovação, mudanças de escopo, estimativas e transições |
| Burndown de horas | Somar horas restantes informadas para tarefas abertas do escopo corrente. Exibir cobertura da informação. Faltantes aparecem separadamente |
| Velocidade | Pontos de PBIs entregues com DoD, presentes no conjunto final de uma sprint fechada e atribuídos a ela. Peso confirmado no instante da conclusão final. Reabertura durante a sprint remove o crédito até nova conclusão. Incompletos e removidos ficam sem crédito. Uma sprint fechada com zero entregas conta como zero |
| Cobertura | Critérios obrigatórios com cenário publicado / critérios obrigatórios. Exibir em separado validação certificada por build e baseline |
| WIP e bloqueios | Contagem por estado com duração desde entrada ou início do bloqueio. Done, rascunhos e cancelados fora do WIP |

Pontos são somados somente em PBIs. A tabela do board pode exibir horas de subtarefas, mas os totais mostram unidade explicitamente. As consultas `application/metrics-queries` já reconstroem burndown, burnup, velocidade, WIP e cobertura em um snapshot de leitura consistente. Cada resposta informa o watermark de auditoria e a data de corte; reabertura remove o crédito dos pontos concluídos, reestimativa não conta como entrega, remoção não conta como entrega e sprint fechada sem aceitos conta como velocidade zero. Datas futuras têm série real vazia. Encerramento antecipado termina a série real na data de fechamento.

## Projeção de entrega

O marco tem escopo aprovado no projeto; os PBIs não pertencem permanentemente a um time. A previsão usa o time selecionado e até seis sprints fechadas dessa mesma geração até o corte local. Exige três amostras válidas e mantém sprints sem entrega como observações de zero pontos. Cada uma das 10.000 simulações sorteia resultados de sprint com reposição. O resultado em pontos é ajustado pela razão entre a capacidade disponível no período futuro e a capacidade da sprint histórica sorteada; a previsão não calcula horas necessárias. Sprints ativa e planejadas conservam as próprias janelas de capacidade; períodos sem plano usam a duração mediana das amostras e a configuração vigente como hipótese identificada. O horizonte cobre 365 dias civis. Dependência incompleta fora do marco e impacto de especificação aberto suprimem as datas; dependências internas são listadas como riscos.

Cada snapshot registra algoritmo v2, seed determinística, quantidade de simulações, amostras, capacidade diária, watermark e data de corte. Repetir a consulta sem mudança de fonte reutiliza o mesmo snapshot; a mesma seed e as mesmas entradas reproduzem exatamente percentis e probabilidade. A probabilidade é a fração de tentativas que termina até a data alvo; se o alvo estiver após o horizonte e o escopo não tiver sido concluído, o campo fica nulo. Os percentis P25/P50/P75 representam datas de conclusão; resultados que não terminam no horizonte são tratados como censurados e podem deixar um percentil sem data. Snapshots v1 permanecem disponíveis e podem ser recalculados pela versão original. Dashboard e `metrics_get` usam o mesmo serviço de aplicação.

Os marcos e snapshots de escopo podem ser criados e consultados pelas ferramentas MCP. A rota local de métricas e previsões e o tool `metrics_get` atendem o dashboard e clientes MCP com filtros e projeção compartilhados; as tabelas de drill-down reconciliam a composição dos totais. O teste de integração compara as duas respostas para os mesmos filtros e watermark; `observedAt` pode ser igual quando ambas reutilizam a mesma projeção em cache.

1. Calcular o restante em pontos dos PBIs abertos no marco. Zero itens abertos resulta em `complete`. Itens sem pontos confirmados resultam em `incomplete_scope` e contagem de lacunas. Exibir cenário provisório apenas com premissa manual explícita, separada do cálculo histórico.
2. Selecionar até seis sprints fechadas comparáveis e do mesmo time/geração, incluindo as que entregaram zero pontos; exigir três amostras com capacidade histórica válida. Sem amostra, responder `insufficient_data`. Geração materialmente diferente nunca entra na amostra.
3. Para cada tentativa, sortear com reposição uma sprint observada para cada janela futura com capacidade. Ajustar os pontos observados pela razão entre a capacidade do período futuro e a capacidade da observação sorteada. O modelo não produz taxa de pontos por hora nem estima horas necessárias.
4. Usar as datas e capacidade congelada da sprint ativa, a configuração fixada em sprints planejadas e a configuração atual como hipótese fora desses planos. Janelas sem sprint usam a duração mediana das amostras. Executar 10.000 tentativas com seed repetível; acumular os pontos simulados até concluir o restante ou alcançar o horizonte de 365 dias. Sem capacidade responde `no_capacity`; amostras de entrega todas zero respondem `zero_velocity`.
5. Retornar datas P25/P50/P75 do tempo de conclusão, mapeadas para Favorável/Base/Cauteloso, e a fração das tentativas que termina até a data alvo. Tentativas sem entrega até o horizonte são censuradas; alvo além do horizonte ou estados que impedem previsão retornam probabilidade nula, exceto quando o escopo já está concluído e a data é conhecida. Persistir seed, entradas, quantidade de tentativas, algoritmo e watermark. Dependência externa bloqueante ou impacto aberto suprime datas; dependências internas permanecem riscos. Snapshots antigos continuam recalculáveis pelo algoritmo gravado.
