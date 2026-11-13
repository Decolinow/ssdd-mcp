# Dashboard e projeções

## Início e próximas ações

Após autenticar, o dashboard abre na aba **Início**. Ela mostra as próximas ações para o papel de trabalho escolhido entre os papéis que a identidade autenticada possui no projeto. A escolha é apenas uma preferência de navegação e apresentação; todas as operações continuam autorizadas pelo principal e pelos papéis persistidos no servidor. Ela não corresponde ao `SSDD_PROFILE` do transporte MCP, que filtra as ferramentas expostas por conexão.

Para Developer, a home apresenta até oito tarefas atribuídas elegíveis para iniciar sessão (Ready ou Em andamento), até oito tarefas em andamento atribuídas, até três impedimentos e até oito tarefas Ready sem responsável que podem ser assumidas. A lista de claim usa a mesma ordem de prioridade e valor do projeto e só inclui tarefas cujos outros gates de início passaram. **Assumir** grava a atribuição com versão, auditoria e idempotência, mas não inicia sessão; após assumir, abra o detalhe e use o fluxo **Iniciar e abrir sessão**, que repete os gates atomicamente. Uma atualização concorrente ou gate recém-bloqueado é recusado e a fila é recarregada.

Para QA, a home destaca itens em validação e leva à área de cenários/execuções. Para PO, mostra histórias e bugs em Draft que precisam de refinamento. Para Tech Lead, separa itens aguardando revisão de tarefas em Draft. Facilitador vê a sprint do time selecionado e atalhos para Board/retrospectiva. Stakeholder e administração recebem atalhos para roadmap, métricas e histórico. As listas de ação mostram até oito itens e declaram esse limite; a busca global não altera essas listas.

Quando o projeto ainda não tem itens de trabalho, a home exibe um bloco **Primeiro uso** com a ordem recomendada: criar o backlog por `work_item_create`, registrar regras/ADRs com `spec_create` e cenários com `scenario_create`, depois configurar time, capacidade/DoD e sprint. O bloco aponta para Product Backlog e Roadmap, orienta a atualizar após cadastrar pelo MCP e não cria dados nem contorna autorização. As demais abas mantêm mensagens explícitas de estado vazio, em vez de gráficos ou listas sem contexto. Os atalhos das abas usam delegação de evento, então continuam funcionando quando são renderizados dinamicamente nos painéis da home.

## Abas disponíveis hoje

O dashboard atual tem dez abas. A aba Roadmap reúne Features ordenadas por prioridade/valor, progresso em pontos confirmados, bloqueios e timeline de conclusão quando há dados suficientes. A aba Especificações oferece um catálogo somente leitura de regras, glossários, contratos de API, ADRs e requisitos não funcionais.

| Aba | O que permite fazer |
|---|---|
| Início | Abrir na fila do papel selecionado, ver pendências, impedimentos, tarefas que podem ser assumidas e atalhos para as áreas principais. |
| Métricas | Consultar burndown, burnup, previsão, velocidade, WIP, bloqueios e cobertura; filtrar por time, marco, sprint e data de corte; abrir a composição dos indicadores disponíveis e o esforço/calibração por Developer. |
| Roadmap | Ver a ordem de entrega de Features por prioridade e valor de negócio, o progresso de cada Feature e as datas P25/P50/P75 somente quando três sprints comparáveis e escopo estimado permitem uma previsão. |
| Histórico | Selecionar uma data local do projeto e reconstruir itens, revisões publicadas, QA, sessões, releases, sprints, marcos e atividade auditada. |
| Especificações | Consultar o catálogo por tipo e busca, abrir uma especificação, navegar pelas revisões e ler o conteúdo JSON de forma estruturada. Distingue rascunho/em revisão, revisão substituída e revisão retirada. Não cria, edita, publica nem vincula. |
| Product Backlog | Pesquisar histórias e bugs, filtrar por tipo, prioridade, estado e versão, cadastrar um PBI e consultar seus detalhes, tarefas filhas, progresso ponderado e revisões. |
| Board | Consultar o fluxo dos itens, abrir detalhes e propor transições por arrastar/soltar ou controles de teclado; gates e autorização são validados pelo serviço de aplicação. |
| Qualidade | Criar cenários, associá-los a tarefas e critérios, propor/publicar revisões como QA humano, registrar execuções ligadas à revisão publicada, build e tarefas verificadas e consultar resultados recentes. |
| Atividade | Consultar eventos de auditoria do projeto em páginas, com ator, motivo, transição e watermark. |
| Retrospectiva | Consultar retrospectivas de sprints fechadas e revisões históricas. |

### Início seguro de tarefa

Ao mover uma tarefa Ready para Em andamento pelo dashboard, o formulário consulta `GET /api/v1/projects/{projectId}/work-items/{id}/start-readiness` e mostra as condições pendentes. **Iniciar e abrir sessão** envia `POST /api/v1/projects/{projectId}/work-items/{id}/start`; o serviço repete os gates e grava a transição e a sessão atomicamente. Mudança concorrente em estado, versão, responsável, pai/baseline, dependência, ADR ou sessão faz a operação falhar sem deixar uma transição incompleta. A tentativa pelo endpoint genérico retorna `USE_TASK_START`.

`GET /api/v1/projects/{projectId}/quick-access` exige uma sessão autenticada e associação ao projeto. Ele retorna os papéis da sessão, a fila atribuída e as listas curtas de validação/refinamento pertinentes. `POST /api/v1/projects/{projectId}/work-items/{id}/claim` exige CSRF, papel Developer, versão esperada e motivo. A operação revalida Ready, ausência de responsável e todos os gates, exceto a própria atribuição; atualiza responsável, versão e auditoria em uma transação idempotente. Uma tarefa com outros impedimentos não aparece como disponível e não pode ser assumida pela API. `TASK_NOT_STARTABLE`, `TASK_ALREADY_ASSIGNED` e `VERSION_CONFLICT` retornam HTTP 409 com o envelope padrão; a interface mostra o motivo e atualiza a home. O conflito de versão não é retryable: recarregue a tarefa e confirme os gates antes de emitir nova tentativa.

O gate exige dependências diretas concluídas, baseline herdada do PBI pai e revisões publicadas para ADRs ligados como `implements`; `relates_to` é apenas informativo. Uma sessão pausada de outro Developer deve ser concluída/cancelada pelo dono antes do handoff. A tela lista impedimentos calculados, mas não existe hoje um estado de bloqueio manual nem duração genérica de bloqueio. Criação, pesquisa e vínculo de ADR estão disponíveis no MCP; catálogo e edição no dashboard continuam planejados em SSDD-98.

### Workflow ponderado da tarefa

No detalhe da tarefa, a seção **Workflow de execução** apresenta a revisão publicada, a soma do esforço das etapas concluídas, esforço restante, barra com rótulo acessível, etapas ordenadas e histórico de status com autoria, data e motivo. A lista de tarefas filhas no detalhe do PBI apresenta resumo de revisão, percentual e contagem concluída/total. Quando não existe revisão publicada, a interface diz **Sem workflow publicado** e não converte ausência em 0%; um Draft inicial aparece no detalhe e continua sujeito à aprovação.

Developer e Tech Lead podem criar uma proposta com 1–50 etapas, reordená-las por botões acessíveis, definir título/instruções e ajustar os pesos até a soma exata de 100,00%. Salvar cria Draft imutável; um Draft anterior passa a withdrawn e segue no histórico. Somente Tech Lead humano pode publicar. A interface pede motivo e confirmação; o servidor exige tarefa em estado elegível e nenhuma sessão ativa/pausada. Revisões publicadas antigas podem ser selecionadas no histórico para leitura; não podem ser alteradas. A publicação informa etapas preservadas e reiniciadas quando a definição/ordem mudou.

Durante a execução, controles para iniciar, concluir ou retornar uma etapa a Pendente respeitam o papel e o estado retornado pelo MCP. A sessão do Developer deve estar ativa, ser do responsável e ter pinado aquela revisão. Passos só avançam em ordem; a etapa Concluída soma seu peso, enquanto Pendente/Em andamento não somam. Reabrir uma etapa concluída requer Tech Lead humano, todas as sessões fechadas e etapas posteriores reabertas antes, em ordem inversa. Erros de versão recarregam o detalhe; ordem inválida, sessão ausente e Draft inicial exibem o motivo do gate. O percentual é esforço relativo concluído, nunca evidência ou certificação QA.

## Especificações técnicas na interface

A aba **Especificações** é um catálogo somente leitura. Ela consulta `GET /api/v1/projects/{projectId}/specifications` com filtros opcionais `kind`, `search`, `limit` e `cursor`, e `GET /api/v1/projects/{projectId}/specifications/{specIdOrKey}` para o detalhe. A lista mostra chave, título, tipo, última revisão, status dessa revisão (rascunho pendente, em revisão, substituída ou retirada) e publicação vigente; o detalhe permite alternar entre revisões e renderiza o conteúdo JSON arbitrário com rótulos em português para as chaves mais comuns.

O aviso do detalhe depende do status da revisão selecionada. Draft e em revisão exibem **Revisão não publicada** e deixam claro que aquele conteúdo não substitui a publicação vigente — ou que a especificação ainda não tem revisão publicada, quando for o caso. Uma revisão **substituída** exibe **Revisão histórica (substituída)** e informa a publicação vigente, sem tratá-la como conteúdo nunca publicado. Uma revisão **retirada** exibe **Revisão retirada** e informa se existe publicação vigente. Revisões publicadas não mostram aviso. O catálogo não cria, edita, publica, retira nem vincula especificações; essas operações continuam nas tools MCP `spec_list`, `spec_get`, `spec_create`, `spec_revision_propose`, `spec_revision_publish`, `spec_revision_withdraw` e `trace_*`.

No detalhe de uma tarefa, o dashboard reutiliza `task_context_get`: especificações publicadas ligadas à hierarquia ou à tarefa aparecem na seção **Especificações e decisões técnicas**, com revisão e proveniência. Uma especificação Draft sem pin de baseline/sessão não aparece como decisão; o contexto exibe `SPEC_WITHOUT_PUBLICATION`. A revisão cruzada de `SSDD-ARCH-2026-01` confirmou a mesma resposta no MCP, na API HTTP e na tela de detalhe.

O catálogo de leitura reduz a lacuna de visibilidade, mas CRUD completo de especificações/ADRs no dashboard continua planejado em `SSDD-98`; `SSDD-100` exige a matriz de paridade MCP/dashboard. Ambos permanecem Draft e não indicam que a implementação esteja concluída.

A interface atualiza os dados automaticamente a cada 30 segundos enquanto a aba está visível e também oferece atualização manual. Ao voltar para a aba, a interface atualiza imediatamente e retoma o ciclo; o polling fica pausado enquanto o documento está oculto. Os filtros, a data observada e o watermark aparecem nas consultas de métricas. Cada gráfico tem informação equivalente em texto ou tabela onde aplicável. O detalhe de PBI lista tarefas filhas navegáveis. O detalhe de tarefa mostra hierarquia, critérios, regras, decisões técnicas, cenários, runs/builds, alertas de drift, datas derivadas de sessões e eventos de release e o histórico de Developers, falhas e rollbacks. Contexto extenso tem paginação explícita.

O dashboard é uma aplicação local de loopback. Para vários usuários no mesmo host, cada pessoa entra com a `authKey` já administrada pelo MCP; o servidor resolve o principal e os projetos dessa identidade. Papéis por projeto continuam sendo verificados pelos serviços de aplicação compartilhados com o MCP. O dashboard não implementa o fluxo de login interativo OIDC; essa autenticação permanece disponível aos clientes do servidor MCP.

## Retrato histórico por data

Na aba **Histórico**, selecione a data no fuso configurado do projeto e escolha **Ver retrato**. O limite é o fim daquele dia local; o controle começa na criação do projeto e não permite datas futuras. **Hoje** consulta a data atual do projeto. A resposta mostra o corte UTC, o fuso, o horário da consulta e os watermarks de auditoria no corte e na fonte atual.

O retrato reconstitui dados a partir dos registros históricos próprios do SSDD: estado e conteúdo publicado de PBI, revisões publicadas de especificações e cenários, execuções QA e seus vínculos existentes naquela data, eventos de sessão (incluindo início, pausa, retomada e encerramento), eventos de homologação/produção, transições de sprint, mudanças de escopo de sprint/marco e atividade auditada. Sessões ainda abertas acumulam tempo somente até o instante da consulta; o sistema não soma o restante do dia no futuro. Os totais cobrem todo o projeto. Listas mostram até 200 registros por seção; a lista de itens tem **Carregar mais itens**, as demais indicam quando a amostra visível foi truncada e a atividade mostra os 30 eventos mais recentes. O cursor é opaco e vinculado ao projeto, data, watermark e horário da captura: se o workspace mudar entre páginas, o dashboard refaz a primeira página para manter o retrato consistente.

Este retrato é somente leitura e não substitui as abas operacionais. O histórico disponível não é temporal para todos os campos: responsável e ordenação de PBI, bem como estimativas neste painel, não são reconstituídos nem apresentados como valores históricos. Na aba Métricas, WIP e cobertura continuam representando a situação atual conforme definido pela projeção, enquanto as séries de sprint/marco respeitam o corte. Essa distinção evita misturar valores correntes com snapshots passados.

```mermaid
flowchart LR
  DATE[Data local selecionada] --> API[API autenticada do dashboard]
  API --> CUTOFF[Corte no fim do dia e fuso do projeto]
  CUTOFF --> ITEMS[Revisões publicadas e transições]
  CUTOFF --> QA[Execuções, sessões e releases]
  CUTOFF --> PLAN[Escopos de sprint e marco]
  CUTOFF --> AUDIT[Watermark e atividade auditada]
  ITEMS --> SNAPSHOT[Retrato somente leitura]
  QA --> SNAPSHOT
  PLAN --> SNAPSHOT
  AUDIT --> SNAPSHOT
```

## Abrir o dashboard

No checkout do projeto, compile o pacote e inicialize o workspace uma vez antes do primeiro uso. Os comandos de preparação estão no [início rápido do README](../README.md#preparar-um-workspace). Em seguida, inicie o servidor:

```sh
node dist/src/cli.js dashboard --workspace . --port 4318
```

Abra no mesmo computador a URL com token de uso único impressa no terminal. O primeiro acesso troca o token por um cookie de sessão local e remove o token da barra de endereço. Mantenha o processo ativo durante o uso; `Ctrl+C` encerra o dashboard. Para outro workspace, informe seu caminho em `--workspace`; use outra porta se 4318 já estiver ocupada. Se a porta não puder ser aberta, o comando informa o erro e termina com código diferente de zero, para que scripts e supervisores detectem a falha.

## Autenticação e sessão web

Também é possível abrir a origem local sem o token de bootstrap e entrar com a mesma `authKey` emitida por `user_create` ou pelo bootstrap de administrador do MCP. O formulário envia a chave por `POST /api/v1/session/login` no corpo JSON; a aplicação não a grava em SQLite, cookie, URL, `localStorage` ou `sessionStorage`, e não a devolve na resposta. O host compara o hash persistido, retorna nome/principal e somente os projetos autorizados.

`GET /api/v1/session` devolve a identidade e os projetos da sessão. O login cria uma sessão web aleatória de 12 horas mantida em memória pelo processo; o navegador recebe apenas um cookie `HttpOnly`, `SameSite=Strict`, além do token CSRF da sessão. Todas as mutações exigem `Origin` igual à origem local e `X-SSDD-CSRF`. `POST /api/v1/session/logout` revoga a sessão atual e expira o cookie. Chave rotacionada/revogada deixa de autorizar sessões existentes na próxima chamada protegida.

O login é limitado ao dashboard em `127.0.0.1`: valide host e origem, não exponha essa porta diretamente à rede. Um proxy remoto, fluxo de login OIDC no browser, persistência de sessão após reinício e sessões distribuídas não fazem parte desta interface. O token de bootstrap de uso único impresso pelo processo continua sendo um caminho de entrada para a identidade local do host; proteja o terminal e abra a URL somente em uma sessão local confiável. Para cadastrar pessoas, associar papéis ou rotacionar/revogar chaves, use as ferramentas administrativas `user_create`, `user_list`, `user_auth_key_rotate` e `user_auth_key_revoke` no MCP.

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

A aba **Métricas** reúne burndown da sprint, burnup do marco, cenários de previsão P25/P50/P75, velocidade recente, WIP, bloqueios, cobertura e esforço por desenvolvedor. O seletor global de time filtra sprints, velocidade e previsão; os filtros da aba selecionam marco, sprint e data local de corte. Em projetos com vários times, o usuário escolhe explicitamente um time; uma única equipe é selecionada automaticamente. A janela de velocidade pode usar as últimas 4, 8 ou 12 sprints fechadas da geração comparável; média e mediana são recalculadas para essa janela. As datas de fechamento na tabela de velocidade usam o fuso do projeto, não UTC. A sprint escolhida também é comparada, em pontos aceitos, com a mediana das sprints anteriores da mesma equipe e geração. O resumo do burndown distingue compromisso inicial, escopo no corte, conclusão e alterações acumuladas.

O corte histórico é aplicado às séries de marco/sprint, velocidade e previsão. **WIP e cobertura representam o estado observado agora**, mesmo quando o usuário consulta uma data passada; a interface identifica essa diferença acima dos indicadores para não sugerir reconstrução histórica que esses dois relatórios não fazem. A tela informa a data observada e o watermark; séries usam pontos como unidade explícita e a previsão mostra geração, tamanho de amostra, capacidade e riscos.

Os gráficos exibem até 90 pontos recentes e cada ponto pode ser selecionado pelo mouse ou teclado. A seleção recalcula a leitura no corte daquele dia e lista os PBIs ativos com estado e estimativa usados no total. O detalhamento do marco valida que escopo, restante, concluído e cancelado reconciliam com a série. O detalhamento da sprint usa o último dia efetivo da janela, respeitando seu fechamento. A tabela de WIP lista idade e impactos, a tabela de cobertura abre cada PBI e a tabela de velocidade mostra pontos entregues e horas registradas sem transformar uma unidade na outra.

Os filtros avançados de esforço aceitam data inicial/final e desenvolvedor. As datas usam o fuso do projeto, e a data final é limitada ao corte selecionado; “Usar mês do corte” restaura o intervalo padrão do primeiro dia daquele mês até o corte. Horas ativas incluem sessões concluídas nesse período. A coorte de tarefas usa a última transição para Done no período e considera sessões encerradas até aquela conclusão. Variação e fator comparam horas reais e estimadas apenas nas mesmas tarefas com estimativa de horas confirmada; a amostra mínima de cinco é contada sobre essas tarefas estimadas. Amostras menores continuam visíveis, mas não produzem fator de calibração. A métrica é consultiva, não um ranking, e não altera estimativas automaticamente. A tabela de esforço acrescenta as colunas “Ciclo mediana · P85” e “Faixa real/estimado P15–P85”, exibidas só com amostra mínima.

Quando não há time, marco, sprint, amostras ou itens, a aba explica qual dado está ausente. `GET /api/v1/projects/{projectId}/teams` lista os IDs, nomes, configuração e composição disponíveis. `GET /api/v1/projects/{projectId}/dashboard-metrics` e o tool MCP `metrics_get` chamam a mesma projeção de aplicação, dentro de uma transação SQLite comum. Ambos aceitam `teamId`, `milestoneId`, `sprintId` e `asOfDate`; projeto com vários times exige seleção explícita e time inválido retorna opções disponíveis. `none` desativa a seleção de marco ou sprint. A seleção é incluída na chave do cache e na consulta de forecast, velocidade e opções de sprint; previsões persistem snapshots separados por time. A primeira consulta pode gravar um snapshot após a migração v23 sem alterar o escopo nem adicionar evento de domínio. O cache em memória dura até 1 s, após nova checagem de autorização e watermark.

## Capacidade

O resumo da sprint ativa mostra a capacidade calculada e congelada na abertura, junto do objetivo, intervalo e itens. A configuração de calendários, membros, dedicação, feriados ou ausências é feita pelo MCP usando `team_create` e `team_capacity_set`; `team_capacity_get` consulta o resultado. Consulte a seção [Time, calendário e capacidade](mcp.md#time-calend%C3%A1rio-e-capacidade) no contrato MCP.

Por pessoa e dia útil, capacidade = máximo entre 0 e horas padrão menos ausência, multiplicado pela dedicação. A capacidade da sprint é a soma. Dedicação fica entre 0 e 100%. Exemplo: com dois membros, dez dias e seis horas úteis, A com um dia de ausência e dedicação integral contribui 54 h; B a 50% contribui 30 h; total 84 h. A capacidade planejada fica registrada na abertura e correções são auditadas. Horas restantes de tarefas são comparáveis à capacidade; story points representam estimativa relativa do PBI e não são convertidos diretamente para horas.

O MCP calcula capacidade a partir de configurações imutáveis, calendário, dedicação e ausências. `sprint_draft` fixa a versão da configuração e `sprint_start` guarda o cálculo detalhado por dia e pessoa. Planejamento e capacidade também são consultáveis pela API local. O backlog `SSDD-97–100` planeja completar operações de planejamento e paridade no dashboard.

## Backlog e board local

O Product Backlog lista histórias e bugs do projeto com busca por chave/título, filtro por tipo, prioridade, estado e versão. O seletor de time escolhe a sprint ativa e as retrospectivas disponíveis para o planejamento; com vários times, nenhuma sprint é inferida até uma seleção. Quando há sprint ativa no time escolhido, o board limita-se ao escopo comprometido e o Product Backlog reúne o restante; sem sprint ativa, o board mostra os itens que já entraram no fluxo. O resumo da sprint expõe objetivo, datas, quantidade de PBIs, pontos e horas de capacidade da abertura.

Cards de PBI abrem detalhe com descrição, critérios, estimativas, pai, responsável, versões e lista de tarefas filhas navegável. No detalhe da tarefa, a interface consulta o contexto autorizado pelo serviço MCP, junto da timeline, sessões de desenvolvimento, deploys e revisões. Exibe regra de negócio e especificação com revisão, origem (baseline, herança ou vínculo direto) e tipo de link. `implements` sinaliza implementação declarada; `relates_to` fornece contexto relacionado. Cenários e execuções identificam relação por cobertura ou vínculo direto e preservam revisão/build. Drag and drop e o botão “Mover item” por teclado abrem o mesmo formulário de transição. A pessoa informa o motivo e, para Done, a build candidata. A interface chama o endpoint HTTP compartilhado com `expectedVersion`, `requestId` e CSRF; as regras de autorização, workflow, baseline e gates continuam no serviço de aplicação. Um gate recusado mantém o card no estado atual e mostra o diagnóstico. Conflito de versão mantém o estado atual, informa `VERSION_CONFLICT` e recarrega a lista para apresentar a versão mais recente. A tela atualiza a cada 30 segundos enquanto a aba está visível, ao voltar para a aba e também por ação manual.

O botão **Novo PBI** cadastra histórias e bugs com Feature pai, descrição, prioridade e critérios. Em detalhes, **Editar conteúdo** propõe uma revisão imutável; um PO humano publica o rascunho pelo próprio detalhe. Revisões publicadas e rascunhos permanecem visíveis. As operações de atribuição, estimativa, comentários, ranking e vínculos ainda estão planejadas no backlog `SSDD-89`.

Os formulários de épico, Feature e tarefa também aceitam valor de negócio de 0 a 100 e uma justificativa PO obrigatória. O MCP mantém score direto em quatro épicos e 14 Features, com decomposição pelas cinco dimensões da rubrica; tarefas herdam o score da Feature ou épico e podem ter uma avaliação direta quando houver motivo específico. Novos itens sem avaliação mostram **Não avaliado**; a interface nunca interpreta ausência como zero. A prioridade e o score são dimensões distintas. Consulte [ADR 0024](adr/0024-prioridade-valor-e-roadmap-por-feature.md) para regras de herança, rubrica e limites da simulação.

### Visão geral e ordem de entrega

A aba **Roadmap** lê `GET /api/v1/projects/{projectId}/feature-roadmap`, que chama a mesma projeção MCP `project_feature_roadmap_get`. Filtros de time e data local alinham a amostra de velocity à equipe e ao corte; a ordem usa prioridade efetiva ascendente (P1 primeiro), score herdado/definido descendente, rank e chave. Cada Feature mostra valor, pontos concluídos/restantes, percentual quando os pontos confirmados permitem cálculo, itens ativos sem estimativa e dependências externas. Com dados suficientes, a linha do tempo mostra uma faixa P25–P75 e marcador P50 por Feature, sequenciados por sprint na ordem aprovada; datas P25/P50/P75 só são desenhadas quando há pelo menos três sprints fechadas comparáveis da mesma geração e o escopo permite alocação. Sprints planejadas usam as datas reais; quando não há plano, as janelas sintéticas começam depois do corte e da sprint ativa, nunca em datas passadas. Sem esses dados, a interface mantém a ordem e o progresso visíveis, mostra o motivo e omite faixas/datas; isso evita apresentar um cronograma sem base. No workspace atual existe uma sprint fechada comparável de cinco pontos, menos que o mínimo de três, e diversas Features sem estimativa confirmada; a interface mostra `insufficient_velocity_samples` sem datas. A fila de tarefas é um tool de agente separado: `task_execution_queue_get` verifica os gates reais e mostra primeiro o trabalho que pode começar. Hoje não há tarefas em estado Ready atribuídas e startable; isso aparece como fila vazia, sem promover o backlog Draft automaticamente.

Para executar o fluxo de QA, crie um cenário na aba Qualidade, associe-o ao PBI/critério pela cobertura e às tarefas verificadas pelo campo **Tarefas associadas**, proponha sua revisão e publique-a como QA humano. Registre uma execução escolhendo essa revisão publicada e informando build, resultado, notas, URI de evidência e tarefas verificadas. Uma revisão em rascunho não aceita execução. A execução é imutável e conserva as tarefas exatas que validou, a revisão e a build. Para certificar um resultado compatível com a baseline, use `test_run_certify` pelo MCP; certificação não é feita pela interface nesta versão.

## Paridade ferramenta MCP → UI

[dashboard-parity-matrix.md](dashboard-parity-matrix.md) mapeia cada ferramenta do MCP para a operação do dashboard, cobertura parcial ou lacuna futura explícita. É gerada de `src/dashboard/tool-ui-matrix.ts` e um teste falha se uma ferramenta nova ficar sem classificação. As lacunas mais relevantes: comentários, estimativas, ordenação (`work_item_rank`), rastreabilidade editável, impactos, revalidação de baseline, certificação QA e política de gates.

## Operações do item de backlog (SSDD-89)

Na aba de detalhe do PBI, cada execução aprovada sem certificação mostra **Certificar (QA)** (`test_run_certify`, mesma rota `backlog/:operation`), que abre o diálogo com o `runId` preenchido; execuções não aprovadas e PBIs fora de validação mostram o motivo em vez do botão, e o gate do MCP (papel QA humano, baseline, revisão e build exatos) explica qualquer recusa. No detalhe do item, o botão **Operações** abre o mesmo diálogo com sete operações: `work_item_assign`, `work_item_rank`, `comment_add`, `work_item_estimate`, `work_item_estimate_confirm`, `trace_link_add` e `trace_link_remove`, via `POST /api/v1/projects/:id/backlog/:operation` (CSRF, origem e idempotência por `requestId`). O corpo é validado e executa o comando de aplicação homônimo do MCP, então papel, versão esperada (409) e auditoria vêm de lá. `GET …/work-items/:key/comments` e `…/trace` leem comentários e o rastro. Como no planejamento, o formulário usa payload JSON pré-preenchido com a chave e a versão do item.

## Baseline e impactos (SSDD-97, SCN-97-AC1)

O detalhe de histórias e bugs ganha o painel **Baseline e impactos**: baseline vigente (sequência, tipo, revisões fixadas sem os snapshots), impactos abertos e revalidados com a especificação, a revisão fixada e a publicada, e o botão **Revalidar baseline** que abre o diálogo Operações em `baseline_revalidate`. Leituras: `GET /api/v1/projects/:id/work-items/:key/baseline` e `…/impacts?status=open|revalidated`. Escritas: `POST …/backlog/baseline_revalidate` (PO ou Tech Lead, motivo obrigatório, versão esperada) e `…/backlog/baseline_fix` (PO), ambas pelos comandos do MCP, com CSRF e idempotência. Fora de escopo: comparar snapshots lado a lado.

## Operações de planejamento (SSDD-99)

O botão **Planejamento** abre um diálogo com as dez operações de times e sprint: `team_create`, `team_capacity_set`, `definition_of_done_set`, `milestone_create`, `milestone_scope_change`, `sprint_draft`, `sprint_scope_change`, `sprint_start`, `sprint_close` e `sprint_cancel`. Cada uma chama `POST /api/v1/projects/:id/planning/:operation` (CSRF e origem obrigatórios), que valida o corpo e executa o mesmo comando de aplicação da tool MCP homônima: versão esperada (409), gates, snapshots de capacidade/DoD e auditoria vêm da camada de aplicação, não do formulário. O diálogo usa um payload JSON pré-preenchido por operação (mesmos campos da tool, `requestId` gerado pelo cliente); formulários campo a campo, seleção de times e confirmação explícita antes de iniciar/encerrar sprint continuam como evolução.

## Qualidade e atividade

A tabela de cobertura da aba Métricas mostra até 20 histórias e bugs, com percentual de critérios obrigatórios cobertos, estado da baseline e versão do item. Sem baseline, a linha é identificada como preview; a cobertura não é apresentada como aprovação. A resposta também informa `itemsTotal` e `itemsTruncated`; contagens e percentuais consideram todos os PBIs do projeto, mesmo quando os detalhes são limitados. A cobertura certificada é conservadora: só conta quando a execução certificada por QA ainda é a observação mais recente da revisão do cenário entre os builds; uma execução posterior em outro build remove a certificação anterior da contagem agregada. Abra o detalhe do PBI para consultar seu snapshot completo. No detalhe, o relatório reconstrói os critérios fixados e lista as revisões de cenário incluídas na baseline, última execução por build, certificação compatível e evidências anexadas, com paginação das evidências.

A aba **Qualidade** mostra um gráfico agregado dos 100 runs mais recentes por `passed`, `failed`, `blocked` e `skipped`, com tabela acessível equivalente (botões por resultado, operáveis por teclado, fazem o drill-down da lista de execuções). Filtros de build, cenário, tarefa/PBI e período (De/Até, inclusivos) são aplicados no cliente sobre os runs carregados; os totais do gráfico e da tabela sempre reconciliam com a lista filtrada. Sem execuções, ou sem correspondência aos filtros, aparecem estados vazios distintos, e um watermark informa quantas execuções foram carregadas (limite de 100). Um painel de cobertura resume PBIs cobertos, com lacunas, sem critério obrigatório e sem baseline; cada linha é um botão (teclado) que filtra a lista de PBIs abaixo, e de lá o detalhe do PBI abre critérios, cenários e execuções. Validade de execução e baseline desatualizada ainda não entram no agregado (a lista de qualidade não expõe esses campos). O histórico mostra cenário, revisão exata, build e link seguro para evidência HTTP(S). Certificação pela UI continua planejada em `SSDD-93` e `SSDD-96`.

### Roadmap: progresso por tarefas (2026-11-13)

A barra de cada feature mostra tarefas concluídas / não canceladas (`progressPercent`) e, ao lado, os pontos entregues (`deliveredPercent`). Uma seção "Épicos" acima da lista exibe o rollup de tarefas por épico (`epics[]`).
