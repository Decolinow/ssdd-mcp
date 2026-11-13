# Contrato MCP

## Protocolo

Usar `@modelcontextprotocol/server` 2.4.0, com negociação de versão segundo a especificação MCP `2026-07-28`. O servidor publica os transportes stdio e Streamable HTTP; ambos usam o mesmo catálogo base, filtrado pelo perfil selecionado. Os testes usam clientes oficiais em processo separado. A tabela lista as ferramentas registradas hoje para projeto, backlog, revisões, rastreabilidade, QA, capacidade, marcos, métricas, planejamento de sprint e retrospectivas. Resources dão leitura paginada de contexto e acesso a revisões publicadas. A API local do dashboard é outro adaptador sobre os mesmos serviços, com sessão descrita em [docs/dashboard.md](dashboard.md). Ferramentas futuras permanecem no roadmap até serem registradas e testadas. [Especificação MCP](https://modelcontextprotocol.io/specification/2026-07-28) · [SDK TypeScript v2](https://ts.sdk.modelcontextprotocol.io/v2/)

Entradas e saídas têm JSON Schema e tipos compartilhados com os adaptadores. Nomes da tabela são públicos. Reads devolvem `structuredContent` e resumo textual serializável para clientes que leem somente `content`. Resultado de comando inclui versão atual e `auditEventIds`. Os limites de itens, profundidade e texto são aplicados pelo servidor. O cliente pode pedir continuação sem expandir todo o grafo.

Uma instância HTTP atende vários clientes e projetos do mesmo workspace. Na conexão, o cliente chama `project_list`, pede seleção humana se houver mais de um projeto e envia o UUID selecionado em `projectId` em cada chamada; não existe estado global de projeto ativo. A autorização do projeto é repetida em toda ferramenta. Para bind, TLS/OIDC, proxy, probes locais, backup e limites de topologia, siga o [runbook do servidor de equipe](team-server.md).

Para a versão moderna `2026-07-28`, o transporte é sem sessão e serve cada requisição sem estado de conexão MCP. Clientes anteriores que iniciam handshake continuam atendidos por sessão legacy em memória. Um restart encerra essas sessões antigas; o servidor ainda usa um processo SQLite único, portanto a ausência de sessão moderna não habilita várias instâncias da aplicação. A implementação expõe `GET /healthz` e `GET /readyz` somente para monitoramento local; publique externamente apenas `/mcp`.

## Ferramentas e autorizações

A matriz gerada `docs/mcp-parity-matrix.md` lista cada tool com mutabilidade, paginação, perfis e skills consumidoras; um teste de contrato a mantém igual ao catálogo e confere a paridade entre stdio e HTTP.

Toda entrada de domínio inclui `projectId` após descoberta, exceto `project_list`. A sigla H indica confirmação humana. O mesmo ator pode possuir vários papéis e a configuração do projeto pode reduzir o conjunto de permissões.

| Ferramentas | Entradas específicas e resultado | Acesso |
|---|---|---|
| `project_list`, `project_get` | Projetos visíveis, objetivo, fuso e papéis concedidos ao principal autenticado | Leitura de projeto |
| `work_item_list`, `work_item_get`, `work_item_create` | Lista filtra por tipo, estado, pai, texto e `assignedToMe` com paginação; consulta aceita UUID ou chave legível. Criação respeita hierarquia e tipo | Leitura; criação por PO/Dev/QA conforme o tipo |
| `work_item_revision_list`, `work_item_revision_propose`, `work_item_revision_publish` | Critérios com campos opcionais estruturados `given`/`when`/`then`/`verification` (`automated`, `manual`, `inspection`)/`example` (até 2000 caracteres cada; omitir todos mantém a estrutura anterior do critério; revisões antigas continuam legíveis); histórico de snapshots, conteúdo candidato, prioridade P1–P4, score opcional 0–100 com justificativa e versão/revisão alvo | PO/Developer/QA propõem por tipo; publicação exige PO humano |
| `work_item_transition`, `work_item_gate_check`, `work_item_rank`, `work_item_assign` | Transição com versão/motivo, diagnóstico de Ready/Done, posição entre vizinhos ou responsável elegível; tarefa Ready não pode iniciar por transição direta | PO humano aprova PBI Ready/cancelamento; Developer/QA podem preparar tarefa; início de tarefa usa `task_start` |
| `work_item_quality_get` | `projectId`, `itemIdOrKey`, `evidenceCursor?`; consolida cobertura, revisões, execuções por build, certificações e evidências | Leitura autorizada de história/bug; evidências continuam paginadas |
| `work_item_estimate`, `work_item_estimate_confirm` | Unidade, valor, justificativa, proposta, versão esperada e estimativa vigente | Developer/QA propõe pontos para história/bug ou horas para tarefa. Uma pessoa Developer confirma a proposta |
| `comment_add`, `comment_list` | Texto imutável e consulta paginada vinculada ao projeto e item | PO/Developer/QA/Tech Lead/facilitador |
| `spec_list`, `spec_get`, `spec_create`, `spec_revision_propose`, `spec_revision_publish`, `spec_revision_withdraw`, `adr_link_task` | Busca paginada por tipo/texto (ADR = `kind: "adr"`); consulta e revisões imutáveis; criação de ADR Draft via `spec_create`; retirada auditada de proposta obsoleta; relação `implements`/`relates_to` validada entre tarefa e ADR | Leitura por projeto. PO/Tech Lead propõe e retira por tipo; publicação requer papel e principal humano; ADR só pode ser ligado por Tech Lead |
| `scenario_create`, `scenario_list`, `scenario_get`, `scenario_criterion_search`, `scenario_revision_propose`, `scenario_revision_publish` | Cenário versionado, passos, pré-condições, cobertura por critério/regra e histórico | QA propõe; revisão só é publicada por QA humano |
| `test_run_list`, `test_run_record`, `test_run_certify` | Lista execuções recentes com filtros por cenário/build/resultado e cursor; grava observação por revisão publicada; certifica execução de baseline | Leitura por membro; Developer/QA registra observação imutável; somente QA humano certifica execução aprovada da baseline |
| `trace_link_add`, `trace_link_remove`, `trace_query` | Núcleo atual: `implements`, `relates_to`, `depends_on`; endpoints por UUID/chave, direção, profundidade e orçamento de nós | PO/Dev/QA/Tech Lead conforme ação e tipo de ligação |
| `evidence_add`, `evidence_list` | Tipo, URI, descrição e build opcional; consulta paginada por item retorna baseline capturada e autoria | PO/Developer/QA/Tech Lead; registros são imutáveis |
| `baseline_fix`, `baseline_get`, `impact_list`, `baseline_revalidate` | Revisões congeladas do PBI, especificações ligadas, cenários cobertos e impactos abertos/resolvidos | PO fixa quando Ready; revalidação exige principal humano PO ou Tech Lead |
| `task_context_get` | `projectId`, `taskIdOrKey`, perfil opcional, seções incluídas, `maxChars` e cursor. Retorna hierarquia, critérios, especificações/regras, cenários, runs por build, proveniência, relações `implements`/`relates_to`, warnings de baseline e `nextCursor` | Leitura de tarefa autorizada no projeto |
| `task_execution_queue_get`, `project_feature_roadmap_get` | Fila por gates/readiness, prioridade e valor herdado; Features por prioridade/valor, progresso confirmado, escopo pendente e timeline por sprint/data | Leitura por membro; os tools não iniciam tarefa nem alteram sprint |
| `development_session_stale_list`, `development_session_recover` | Admin/Tech Lead lista sessões ativas/pausadas sem evento há `staleAfterHours` (padrão 24, 1–2160) e as encerra (`cancel`/`complete`) com motivo de 10–500 caracteres, `expectedVersion` e `requestId` idempotente | Papéis `admin` ou `tech_lead`; aprovável; `recover` preserva a autoria do desenvolvedor e o tempo registrado, registra o recuperador no evento (`[recovery]`) e na auditoria (`development_session.recovered`), nunca credita o tempo desde a última retomada (`unreliableSeconds`/`discardedUnreliableSeconds`) e falha com `SESSION_NOT_STALE` antes do limite |
| `file_claim_acquire`, `file_claim_renew`, `file_claim_release`, `file_claim_list` | Reservas por lease de arquivos/diretórios (caminhos relativos ao repositório, até 50 por chamada, lease de 60 s a 4 h, padrão 30 min) para agentes paralelos; sobreposição arquivo/diretório com reserva ativa de outra pessoa falha com `CLAIM_CONFLICT` listando dono, caminho, branch/worktree e expiração; reserva expirada ou liberada nunca bloqueia | Developer/Tech Lead (list: qualquer membro); só o dono renova; liberar reserva alheia exige Tech Lead/Admin e motivo de 10+ caracteres; idempotente por `requestId`, tudo auditado (`file_claim.acquired/renewed/released`). **Coordenação, não enforcement do Git**: confira branch/worktree/diff e não sobrescreva edição alheia |
| `delivery_quality_metrics_get` | Qualidade de entrega no período (padrão 30 dias): aceite na primeira passagem (tarefas Done sem devolução), devoluções por etapa e motivo, critérios `partial`/`not_met` do último relatório de entrega e bugs ligados a histórias Done; segmentado pelo tipo de principal que enviou à revisão; taxas `null` abaixo de 5 amostras; `limitations` informa que bloqueios de gate ainda não são eventos (SSDD-951) | Leitura para PO, Facilitador e Tech Lead; agregado, sem ranking individual |
| `flow_metrics_get` | Fluxo de entrega de tarefas no período (padrão 30 dias, corte `asOf` explícito): lead (criação→Done), ciclo (primeiro `in_progress`→Done), espera (Ready + revisão + validação), trabalho (`in_progress`) e espera por dependência, cada um com amostra, mediana e P85 (`null` abaixo de 5 tarefas); idade do WIP aberto como amostra censurada; caminho crítico só quando `depends_on` entre tarefas abertas forma um DAG com horas estimadas em todos os nós (`computed`, `not_a_dag`, `missing_estimates`, `no_open_dependencies`) | Leitura para membros com a tool visível (Tech Lead e `full`); agregado, sem ranking individual; lista `limitations` na resposta |
| `question_open`, `question_answer`, `question_list` | Perguntas em aberto por item (chaves `Q-N`); a pergunta bloqueante impede Ready (gate `no-blocking-questions`) e aparece como aviso `BLOCKING_QUESTION_OPEN` em `task_context_get`. Abrir: developer/po/qa/tech_lead/facilitator; responder: po/tech_lead/stakeholder | Aprovação em agentes; `question_list` filtra por item e status |
| `task_briefing_get` | Primeiro passo de uma tarefa em uma chamada: `context` (mesmos `profile`/`include`/`maxChars`/`cursor` de `task_context_get`), `startReadiness` (bloqueios e avisos de `task_start_check`), `workflow` (progresso), `openQuestions`, `glossaryTerms` citados e `nextAction` determinística | Somente leitura; o orçamento de `maxChars` vale para o `context`; a skill `ssdd-developer` o usa antes de `task_context_get` |
| `project_guidance_get`, `project_guidance_set` | Orientações do projeto em revisões imutáveis (até 30 convenções e 20 comandos de verificação) com autor, data e motivo; entram na seção `guidance` do contexto da tarefa junto das ações da retrospectiva vigente e dos motivos das últimas devoluções do mesmo PBI, cada entrada com `provenance` | `set`: PO/Tech Lead humano, motivo de 10+ caracteres, `expectedRevision`, com aprovação em agentes |
| `gate_policy_get`, `gate_policy_set` | Política de gates do projeto em revisões imutáveis: `lite` (sem cenário publicado exigido no Ready), `standard` (padrão) e `strict` (relatório de entrega e revisão humana independente obrigatórios); todo `work_item_gate_check` traz `policy` (ADR 0029) | `set`: PO/Tech Lead humano, motivo de 10+ caracteres, `expectedRevision`, com aprovação em agentes |
| `task_scope_set` | Declara (substitui) os caminhos esperados da tarefa; o relatório de entrega aceita `changeSet` (`branch`, `commits`, `paths`) e `task_delivery_report_get`/`work_item_readiness_review` listam `outOfScopePaths` como achado `out_of_scope_change`, sem bloquear (SSDD-944) | Developer/Tech Lead/PO, com aprovação em agentes; o webhook de PR só traz branch e SHA, não caminhos |
| `template_set` | Define (versiona, `expectedRevision`) um modelo do projeto: checklist de critérios e etapas de workflow com peso em % (soma 100). Revisões imutáveis (SSDD-949) | Tech Lead/PO, com aprovação em agentes |
| `template_apply` | Aplica um modelo a uma tarefa gerando Drafts do checklist e do workflow, idempotente (`requestId`); nada é publicado sem revisão (SSDD-949) | Developer/Tech Lead/PO |
| `template_list` | Lista modelos atuais (ou revisões de uma `key`) (SSDD-949) | Papéis do projeto |
| `review_record`, `review_list` | Revisão independente imutável por tarefa (`approved`/`changes_requested` + achados por critério); revisor sem sessão de desenvolvimento na tarefa; principal não humano é consultivo; `changes_requested` bloqueia `in_review → in_validation` e `SSDD_REQUIRE_INDEPENDENT_REVIEW=1` exige aprovação humana do relatório vigente (ADR 0028) | Developer/QA/Tech Lead, com aprovação em agentes |
| `task_delivery_report_submit`, `task_delivery_report_get` | Relatório de entrega imutável e numerado por tarefa: por critério do PBI e item do checklist, `met`/`partial`/`not_met`/`not_applicable` com evidência, suposições e desvios; `not_met` bloqueia `in_progress → in_review` (ADR 0027; `SSDD_REQUIRE_DELIVERY_REPORT=1` exige o relatório) | Developer/QA/Tech Lead enviam, com aprovação em agentes; `get` devolve esperado × entregue |
| `work_item_readiness_review` | Achados determinísticos (sem modelo): `no_observable_outcome`, `vague_term`, `term_not_in_glossary` (termos entre aspas/crases ausentes do glossário), `criterion_without_scenario`, `task_without_checklist`, `blocking_question_open` | Somente leitura; só a pergunta bloqueante é `blocking`, o resto é `warning` |
| `task_accept` | Fecha uma tarefa Draft/Ready numa única chamada (atribuir a si, estimar em horas, Ready, `task_start`, evidência, concluir sessão, `in_review`, `in_validation`, `done`) e devolve só `{key,state,version,steps,evidenceId,sessionId,alreadyDone,auditEventCount}` (a descrição da evidência precisa ter 20+ caracteres e não pode ser placeholder; a trilha completa fica em `audit_event_list`) | Developer responsável; passa pelos mesmos gates; uma transação (falha reverte tudo); `requestId` derivado por etapa torna o retry idempotente; aprovável (uma aprovação cobre a cadeia) |
| `task_start_check`, `task_start` | Diagnóstico de gates; transição Ready→`in_progress` e abertura da sessão de desenvolvimento na mesma transação | Developer autenticado, responsável atribuído e papéis do projeto; status, PBI/baseline, dependências, ADRs, versão e sessões são revalidados atomicamente |
| `task_workflow_get`, `task_workflow_propose`, `task_workflow_publish`, `task_workflow_step_transition` | Consulta da revisão publicada, Draft e histórico; proposta versionada de 1–50 etapas com esforço total de 100,00%; publicação; progresso auditado por etapa | Leitura por membro; proposta por Developer/Tech Lead; publicação por Tech Lead humano sem sessão aberta; progresso por Developer atribuído em sessão ativa pinada à revisão |
| `development_session_start`, `development_session_transition`, `development_session_list` | Compatibilidade de sessão para item já em `in_progress`; pausa, retomada, conclusão/cancelamento e consulta | Start/resume exigem Developer atribuído; retomar após reatribuição é proibido; uma sessão ativa por tarefa; sessão pausada de outro Developer bloqueia handoff |
| `developer_execution_metrics_get` | Período local inclusivo e Developer opcional; horas ativas, tarefas concluídas/estimadas, estimativa versus execução e fator de calibração com no mínimo cinco tarefas estimadas | Leitura por membro; dados individuais são descritivos e não formam ranking |
| `audit_event_list` | Timeline de auditoria do projeto, somente leitura, do evento mais recente ao mais antigo, com filtros `entityType`/`entityId`/`actorPrincipalId`, `limit` 1–100 (padrão 50) e `cursor` por watermark | Qualquer membro do projeto; `payload` de `tool_approval` e `principal` só aparece para administradores (`payloadRedacted: true` caso contrário). Cursor de outro projeto, principal ou filtro dá `VALIDATION_FAILED`; mudança no projeto após a leitura dá `STALE_CURSOR` |
| `deployment_event_record`, `deployment_event_list` | Eventos imutáveis de homologação/produção com build, versão, pipeline, ator, timestamp UTC, resultado, rollback e vínculos a tarefas/PBIs/marcos | Homologação: Admin/QA/PO/Tech Lead; produção: Admin/PO/Tech Lead; produção aprovada exige Done e homologação aprovada do mesmo build |
| `roadmap_id_bind`, `roadmap_id_resolve`, `roadmap_id_list` | Vincula ID estável `SSDD-###` a UUID/chave gerada, resolve um ID e lista vínculos persistidos por projeto | Bind por Admin/PO; resolver/listar por membro |
| `definition_of_done_set`, `definition_of_done_get` | Revisão de critérios versionada; configuração com `expectedVersion`, leitura atual ou histórica | Alteração por pessoa PO/facilitadora; leitura por membro do projeto |
| `sprint_list`, `sprint_get`, `sprint_draft`, `sprint_scope_change`, `sprint_start`, `sprint_close`, `sprint_cancel` | Planejamento por `teamId`, seleção de PBIs Ready, alterações de escopo, snapshots e histórico de estado | Leitura por membro; seleção explícita em projetos com vários times; edição de rascunho por PO/Developer/facilitador; início por PO humano; escopo ativo exige PO humano; fechamento/cancelamento por PO ou facilitador humano |
| `sprint_retrospective_get`, `sprint_retrospective_set` | Leitura da revisão corrente ou histórica; registro versionado de aprendizados e ações com responsável e PBI opcional | Leitura por membro; escrita após fechamento por facilitador humano; responsáveis precisam ser pessoas humanas do projeto |
| `milestone_create`, `milestone_get`, `milestone_list`, `milestone_scope_change`, `milestone_forecast_history`, `milestone_forecast_recalculate` | Objetivo e data alvo; PBIs aprovados com baseline, revisão e pontos; histórico do escopo e snapshots de previsão, com recálculo verificável | Leitura por membro; criação e mudança do escopo por PO humano; consultas de previsão não gravam |
| `metrics_get` | `teamId`, `milestoneId`, `sprintId` (UUID ou chave), `asOfDate`; retorna burnup, previsão, série da sprint, velocidade, geração selecionada, WIP, cobertura, watermark e opções | Leitura por membro; time obrigatório quando o projeto tem vários; pode registrar snapshot imutável de previsão |
| `github_reference_list` | `workItemIdOrKey` opcional e `limit` de 1 a 100; retorna o PR e workflow run mais recente por referência | Leitura por membro do projeto |
| `github_issue_import_preview`, `github_issue_import_apply` | Repositório, Feature destino, tipo `story`/`bug`, limite; apply recebe `expectedPlanHash` e `requestId` | Preview por membro; apply só por PO humano |
| `azure_work_item_import_preview`, `azure_work_item_import_apply` | Organização/projeto, Feature destino, `azureWorkItemType` (`User Story`/`Bug`) e limite; apply recebe `expectedPlanHash` e `requestId` | Preview por membro; apply só por PO humano |
| `team_list`, `team_create`, `team_capacity_get`, `team_capacity_set` | Lista times; cria time com configuração inicial; consulta horas por dia/pessoa; configura calendário, disponibilidade e `generationNumber` por `teamId` | Leitura por membro do projeto; criação/configuração por pessoa PO/facilitadora |
| `approval_issue`, `approval_revoke` | Emissão idempotente ou revogação de aprovação vinculada a executor, tool, hash de argumentos, projeto, versão e expiração | Admin humano do projeto; executor precisa ter papel para a operação aprovada |
| `user_create`, `user_list`, `user_auth_key_rotate`, `user_auth_key_revoke` | Cria identidade com papéis por projeto, lista metadados, troca ou revoga authKeys | Administrador único da instância; chave secreta só é devolvida na emissão, nunca no replay |
| `work_item_semantic_index`, `work_item_semantic_search` | Indexação vetorial paginada e busca por significado; aceita `assignedToMe`, tipos/estados e limite | Membro autorizado no projeto; requer embeddings configurados; indexar só atualiza cache derivado |

### Versão nas escritas

`work_item_estimate`, `work_item_revision_propose` e `work_item_revision_publish` devolvem `version`: a versão otimista corrente do item após a escrita, para encadear a próxima chamada com `expectedVersion` sem reler o item. As tools `task_*` aceitam `itemIdOrKey` como sinônimo de `taskIdOrKey` (exatamente um dos dois); a normalização ocorre depois da checagem de aprovação, então argumentos aprovados continuam idênticos ao que foi enviado.

### Anotações das tools

Toda tool declara `readOnlyHint`, `destructiveHint`, `idempotentHint` e `openWorldHint` em `tools/list`, classificadas em `src/mcp/tool-annotations.ts`. São dicas para o cliente decidir auto-aprovação e confirmação; não substituem RBAC, aprovações delegadas nem gates.

| Classe | Hints | Exemplos |
|---|---|---|
| Leitura | `readOnly=true`, `destructive=false` | `work_item_get`, `task_context_get`, `trace_query` |
| Leitura externa | leitura + `openWorld=true` | `github_issue_import_preview`, `azure_work_item_import_preview` |
| Cache ou snapshot derivado | `readOnly=false`, `destructive=false` | `metrics_get`, `work_item_semantic_search` |
| Mutação aditiva | `readOnly=false`, `destructive=false` | `work_item_create`, `task_start`, `evidence_add` |
| Importação aplicada | aditiva + `openWorld=true` | `github_issue_import_apply`, `azure_work_item_import_apply` |
| Encerra, retira ou revoga | `readOnly=false`, `destructive=true` | `trace_link_remove`, `sprint_cancel`, `sprint_close`, `work_item_transition`, `approval_revoke` |

`idempotentHint` é verdadeiro em todas: leituras não mudam estado e mutações repetem o resultado original com o mesmo `requestId` e payload. `destructive` significa que o estado vigente é substituído ou encerrado; o histórico continua append-only. Uma tool sem classificação falha em `tests/mcp/tool-annotations.test.ts`.

## Identidade, perfis e busca semântica

Na primeira inicialização do host MCP, a identidade humana local do sistema operacional é gravada como administrador único da instância e recebe uma authKey aleatória. O servidor imprime essa chave uma vez em `stderr`; não há recuperação da chave em texto claro. Guarde-a em um cofre de segredos. Se for perdida, o administrador ainda pode rotacioná-la por outra conexão local confiável. O evento de bootstrap e os comandos administrativos são auditados em tabela global imutável.

O administrador usa `user_create` com `requestId`, nome, tipo (`human`, `agent` ou `service`), um ou mais projetos com papéis `admin`, `po`, `developer`, `qa`, `tech_lead` e/ou `facilitator`, e motivo. A resposta devolve `principalId`, `authKeyId` e a authKey apenas na criação confirmada; um retry idempotente devolve `authKey: null`, pois o segredo não é recuperável. `user_auth_key_rotate` revoga a chave ativa e emite outra uma vez; `user_auth_key_revoke` bloqueia uma chave específica ou todas as chaves do usuário. `user_list` mostra nomes, associações, prefixos, último uso e revogações, sem expor hashes ou segredos. O request ID é global para comandos administrativos e não pode ser reutilizado com outro payload.

Se a authKey inicial não tiver sido guardada, conecte-se por uma sessão local confiável sem `SSDD_AUTH_KEY` (ou sem Bearer em loopback), use o perfil `admin`, chame `user_list` para identificar o principal com `isInstanceAdministrator: true` e passe esse `principalId` a `user_auth_key_rotate`, com novo `requestId` e motivo. Guarde a chave devolvida em um cofre de segredos; o banco contém somente seu hash.

Em Streamable HTTP, envie `Authorization: Bearer <authKey>`. A chave identifica o principal, mas não substitui associação nem papel do projeto. O transporte OIDC existente continua disponível. Sem OIDC, requisições sem Bearer em loopback mantêm a identidade local do processo por compatibilidade; esse modo é para uso confiável local. No stdio, `SSDD_AUTH_KEY` escolhe explicitamente o principal; sem ela, usa-se a identidade local. Rotacionar/revogar afeta imediatamente novas requisições autenticadas pela chave.

O perfil de conexão seleciona tools, prompts e skills expostos ao cliente para reduzir o contexto carregado em cada etapa; não é uma role e não concede acesso. O default é `full`. HTTP aceita `X-SSDD-Profile`, e o stdio lê `SSDD_PROFILE`. Perfis disponíveis:

| Perfil | Etapa e superfície principal |
|---|---|
| `refinement` | Análise de necessidade e backlog; consulta de critérios/regras e proposta de itens, sem execução de QA ou planejamento de release |
| `specification` | Desenho técnico, especificações e rastreabilidade `implements`; sem tools de QA, sprint ou deployment |
| `dev` | Implementação, sessões, workflows (ler/propor/atualizar etapa, sem publicar), estimativas, transição/evidência e consulta do contexto completo |
| `test_design` | Consulta de critérios e cobertura, busca e autoria/versionamento de cenários; não registra nem certifica execuções |
| `qa` | Desenho de cenários, execução, histórico e certificação QA, leitura de workflows, gates e evidências |
| `tech_lead` | Superfície combinada de arquitetura, desenvolvimento, proposta/publicação/correção de workflow e gestão técnica de especificações/baselines |
| `security_review` | Contexto, especificações, rastreabilidade, qualidade e operação em modo somente leitura |
| `po` | Backlog, negócio, priorização, escopo de sprint/marco e integrações de importação; consulta capacidade, mas não administra calendário/DoD |
| `facilitator` | Capacidade, calendário, Definition of Done, ciclo de sprint e retrospectiva |
| `release` | Prontidão de release, previsões e histórico/registro de deployment |
| `devops` | Escopo e gates de release, CI recebida por webhook, ambientes e eventos de deployment |
| `admin` | Leitura do contexto necessário para administrar identidades e revisar aprovações; sem tools de facilitação, e tools de usuário apenas ao administrador da instância |
| `full` | Catálogo completo de tools, prompts e skills compatível com a identidade; tools de usuário continuam restritas ao administrador da instância |

No HTTP com sessão legacy, principal e perfil ficam vinculados ao handshake; enviar outro perfil ou principal recebe `403`. No protocolo moderno sem sessão, o header é aplicado a cada requisição. No stdio, o ambiente vale durante a vida daquele processo. O perfil `admin` não transforma o principal em admin. A autorização de projeto, tipo de principal, aprovações delegadas e gates humanos continuam aplicados pelo domínio. Os mesmos filtros são aplicados a `tools/list`, `prompts/list` e à extensão `skills/list`; resources autorizados permanecem sujeitos ao RBAC. Esse filtro de conexão é independente do parâmetro `task_context_get.profile`, que seleciona o conteúdo Dev/QA/PO retornado para uma tarefa.

Cada perfil de etapa declara sua própria lista de tools em vez de herdar todo o catálogo de leitura. Os perfis operacionais mais estreitos expõem entre 17 e 39 tools; `dev` inclui consulta/proposta/atualização de workflow, mas não publicação. `tech_lead` e `po` chegam a 58 tools por cobrirem respectivamente execução técnica e escopo de produto. `full` mantém o catálogo inteiro com 97 tools. Os limites de domínio continuam autoritativos: um perfil enxuto reduz o contexto MCP, mas não substitui RBAC, autorização por projeto, aprovações nem gates.

`work_item_list` aceita `assignedToMe: true` e filtra pelo principal autenticado, sem permitir que o chamador escolha um UUID de outra pessoa nesse atalho. O cursor inclui a identidade e os filtros. `work_item_assign` continua obedecendo papéis e elegibilidade existentes; sessões, execuções de teste, comentários e auditoria gravam o mesmo `principalId` autenticado.

Busca textual FTS5 permanece disponível em `work_item_list.search`. Para busca semântica, configure `SSDD_EMBEDDING_ENDPOINT` e `SSDD_EMBEDDING_MODEL`; `SSDD_EMBEDDING_API_KEY` é opcional. O endpoint deve ser HTTPS, exceto HTTP em loopback para provedores locais, e seguir o contrato OpenAI-compatible `POST .../embeddings`. Respostas têm limite de 8 MiB; vetores precisam ter dimensão consistente entre 1 e 8.192. Sem configuração, a tool retorna `EMBEDDINGS_NOT_CONFIGURED` e não faz chamadas externas. O admin/operador escolhe o provedor; o serviço envia ao endpoint títulos, descrições, critérios e a consulta textual. Não habilite um provedor externo para projetos com conteúdo que não possa ser enviado a esse terceiro.

`work_item_semantic_index` processa até 200 itens por página e retorna `nextCursor`; repita até `null` para indexar o escopo completo. `work_item_semantic_search` pode indexar automaticamente a primeira página de 50 e retorna similaridade, `missingEmbeddingCount`, `indexComplete` e cursor de indexação. A busca conta primeiro o escopo autorizado e recusa projetos com mais de 10.000 itens antes de chamar o provedor ou indexar conteúdo; `assignedToMe` reduz esse escopo ao principal autenticado. Filtros de tipo/estado reduzem o custo do ranking. O índice de candidatos usa uma consulta join e leitura incremental; o vetor é decodificado um por vez e uma inserção binária mantém apenas os primeiros `limit` resultados ordenados em memória, carregando títulos e descrições somente para eles. A classificação exata continua O(itens × dimensão) e limitada a 10.000 itens. Vetores ficam em cache SQLite, particionados por projeto/item/modelo e invalidados pelo hash do conteúdo atual; a busca nunca ultrapassa a autorização do projeto.

`approval_issue` e `approval_revoke` são tools de administração e exigem principal `human` com papel `admin` no projeto. A emissão é idempotente por `requestId`; o executor precisa ser `agent` ou `service` provisionado no mesmo projeto. O admin aprova uma ferramenta elegível, os argumentos completos, `expectedVersion` (ou `null` quando a ferramenta não tem versão), executor e prazo de 30 a 600 segundos. `arguments.projectId` deve ser igual ao projeto da aprovação. Os argumentos são ordenados e serializados canonicamente antes de gerar SHA-256, então a ordem das chaves JSON não muda o vínculo.

Para executar, o cliente do agente inclui o ID em `_meta` na chamada MCP:

```ts
await agentClient.callTool({
  name: "work_item_create",
  arguments: {
    projectId,
    requestId: "agent-create-001",
    type: "epic",
    title: "Confiabilidade de pagamentos",
  },
  _meta: { "com.ssdd-mcp/approval-id": approvalId },
});
```

Agentes e serviços precisam de aprovação para `baseline_fix`, `baseline_revalidate`, `work_item_create`, `work_item_revision_propose`, `work_item_revision_publish`, `work_item_assign`, `work_item_rank`, `comment_add`, `work_item_estimate`, `work_item_estimate_confirm`, `spec_create`, `spec_revision_propose`, `spec_revision_publish`, `scenario_create`, `scenario_revision_propose`, `scenario_revision_publish`, `test_run_record`, `test_run_certify`, `milestone_create`, `milestone_scope_change`, `team_create`, `team_capacity_set`, `definition_of_done_set`, `sprint_draft`, `sprint_scope_change`, `sprint_start`, `sprint_close`, `sprint_cancel`, `sprint_retrospective_set`, `work_item_transition`, `evidence_add`, `trace_link_add` e `trace_link_remove`. Leituras não consomem aprovação. Uma aprovação não concede papéis e não substitui gates que exigem atuação humana; o executor ainda precisa da associação e do papel exigidos pela ferramenta.

A validação e o consumo do ID acontecem na mesma transação SQLite da execução da ferramenta. A aprovação só é consumida quando o resultado do comando não é erro; a mutação e o consumo são revertidos juntos em falha de commit. Chamadas concorrentes não conseguem reutilizar o mesmo ID. O evento `tool_approval.consumed` grava o executor como ator, registra o aprovador, ferramenta, versão, hash dos argumentos e IDs da auditoria da mutação. Expiração, revogação, replay ou qualquer divergência retornam erro sem executar a mutação. Se o comando falhar por conflito de versão, atualize os argumentos e solicite nova aprovação.

## Ferramentas disponíveis

`ssdd-mcp init --key PAY --name Pagamentos --goal "Pagamentos confiáveis" --timezone America/Sao_Paulo` inicializa o projeto. `ssdd-mcp stdio --workspace <diretório>` inicia o servidor stdio. `ssdd-mcp serve --workspace <diretório> [--port 4319]` inicia Streamable HTTP em `/mcp` com a identidade local. Para habilitar OIDC, informe juntos `--oidc-issuer <issuer>` e `--resource-url <URL-canônica-do-MCP>`.

### Transporte Streamable HTTP local

O comando `serve` atende `/mcp` com os dois modos do protocolo MCP suportados pelo SDK: clientes padrão usam a era com handshake (`2025-11-25` e anteriores), e clientes que optam pela negociação automática podem usar a era moderna sem sessão (`2026-07-28`). A classificação de mensagens fica a cargo do SDK; os mesmos tools/resources são registrados nas duas eras. A era com handshake mantém sessões em memória e precisa ser reinicializada depois de um reinício do processo. A era moderna cria uma instância de servidor por requisição. As respostas são JSON ou SSE conforme o tipo de resposta MCP.

Sem OIDC, o servidor valida `Host` e `Origin` contra `localhost`, `127.0.0.1` e `[::1]`. Com OIDC, também aceita o hostname da URL canônica do resource e hostnames adicionais passados por `--allowed-origin`. Esse parâmetro é somente uma allowlist de origem e não habilita CORS. O processo continua vinculado a `127.0.0.1`; publique por proxy reverso com TLS e encaminhe o Host canônico. Corpos continuam limitados a 1 MiB. Um identificador de sessão ausente em `GET`/`DELETE` da era com handshake retorna 400; sessão desconhecida retorna 404; origem ou host fora da allowlist retorna 403; versão não suportada retorna 400; corpo acima do limite retorna 413.

Quando OIDC está configurado, todas as chamadas ao endpoint MCP exigem Bearer token JWT válido. O servidor busca a descoberta em `/.well-known/openid-configuration` sob o issuer e valida a assinatura assimétrica com `jwks_uri`, `iss`, `aud`, `exp`, `sub` e `nbf` quando presente. O scope obrigatório é `ssdd:mcp`; o issuer deve corresponder exatamente à configuração e a audiência deve conter a URL de `--resource-url`. Tokens opacos não são suportados. O servidor não emite tokens.

O endpoint Protected Resource Metadata fica em `/.well-known/oauth-protected-resource/mcp` e aponta para o issuer. O cliente recebe `401 invalid_token` com o endereço de metadata quando não apresenta token válido e `403 insufficient_scope` quando o token não tem `ssdd:mcp`. Token válido cuja identidade `iss+sub` não foi provisionada recebe `403 identity_not_provisioned`. A sessão legacy fica vinculada ao principal que a inicializou; outro principal recebe `403 SESSION_PRINCIPAL_MISMATCH`.

### Recepção de webhooks

O mesmo processo `serve` pode receber `POST /webhooks/{provider}/{projectKey}`. Configure o segredo correspondente por variável de ambiente, por exemplo `SSDD_WEBHOOK_SECRET_GITHUB__PAY`; o valor deve ter 32–4096 bytes e não é impresso nem persistido. Use um segredo separado por projeto/provider.

Para `github`, envie `X-GitHub-Delivery`, `X-GitHub-Event` e `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 do corpo bruto>`. Outros providers configurados usam `X-SSDD-Delivery-Id`, `X-SSDD-Event` e `X-SSDD-Signature` no mesmo formato. O content type precisa ser `application/json`; o corpo UTF-8 deve ser um objeto JSON de até 1 MiB. Limite, formato e assinatura são validados antes de interpretar o objeto. A resposta `202` contém `receiptId`, provider, delivery ID, tipo de evento, horário e `status: accepted`; uma repetição idêntica devolve exatamente o mesmo recibo e inclui `X-SSDD-Webhook-Replay: true`. Reuso do provider + delivery ID com evento ou conteúdo diferente retorna `409 WEBHOOK_DELIVERY_CONFLICT`. Assinatura inválida retorna 401, payload inválido 400, provider/projeto não configurado 404 e corpo acima do limite 413.

Cada aceitação grava `webhook.received` no projeto da rota e cria um principal de serviço sem papéis, junto do recibo imutável, em uma transação SQLite. O banco guarda apenas hash e metadados do recibo; corpo e segredo não são persistidos. O evento GitHub passa por validação de repositório e normalização dentro da mesma transação; falhas revertem o recibo e a auditoria.

### Referências GitHub de PR e CI

Além do segredo HMAC, configure o repositório esperado por projeto, por exemplo `SSDD_GITHUB_REPOSITORY_PAY=acme/payments`. `repository.full_name` do payload deve corresponder a `owner/repository`, sem diferenciar maiúsculas/minúsculas. Mapeamento ausente ou divergente responde 404 e não grava recibo.

O evento `pull_request` cria snapshot para `opened`, `reopened`, `synchronize`, `edited`, `closed`, `ready_for_review` e `converted_to_draft`. `workflow_run` cria snapshot somente para `action: completed`. Outros eventos e ações permitidos pela assinatura recebem o recibo genérico sem criar referências. Snapshots incluem número/URL/título/estado do PR, branches e SHAs head/base, além de número/URL/status/conclusão/branch/SHA e PRs associados do workflow. A resolução da chave procura `<PROJECT_KEY>-<número>` no branch e depois no título; quando o item ainda não existe, a chave fica registrada sem `workItemId`.

Migração v20 mantém os snapshots append-only e ligados ao recibo. `github_reference_list` retorna somente o snapshot mais recente de cada PR e workflow run; use `workItemIdOrKey` para filtrar por item e `limit` (padrão 50, máximo 100) para limitar cada lista. A consulta verifica associação do principal ao projeto. A integração apenas registra referências externas: não move work items, não considera um workflow como evidência certificada e não chama `test_run_certify`.

### Importação unidirecional de issues GitHub

Configure `SSDD_GITHUB_ISSUES_TOKEN_<PROJECT_KEY>` com um token read-only que possa ler issues e mantenha o mapeamento `SSDD_GITHUB_REPOSITORY_<PROJECT_KEY>=<owner>/<repository>`. O token fica só no ambiente do processo, não é incluído em respostas/logs/banco e as chamadas usam o host oficial `api.github.com`, método GET e paginação pelo cabeçalho `Link`. A API de issues também retorna pull requests; o importador os identifica por `pull_request` e os exclui. [API de issues do GitHub](https://docs.github.com/en/rest/issues/issues) · [Paginação REST](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)

`github_issue_import_preview` recebe `projectId`, `parentFeatureIdOrKey`, `workItemType` (`story` ou `bug`) e `limit` (padrão 50, máximo 100). Faz a consulta e validação sem gravar no workspace; a resposta indica quais issues seriam criadas, quais já têm vínculo externo e quais seriam ignoradas, além de um `planHash` SHA-256 que vincula fonte, destino e tipo escolhidos.

`github_issue_import_apply` refaz a consulta, exige o mesmo `expectedPlanHash` e `requestId` e recusa um plano que mudou desde a prévia. A aplicação requer principal `human` com papel `po`. Cada item novo começa em `draft` sob a Feature indicada; title e body preenchem os campos locais, com título limitado a 200 caracteres e descrição a 10.000. O vínculo provider/repositório/ID, snapshot normalizado da origem e auditoria são gravados junto ao item na mesma transação. Repetir o mesmo request retorna a resposta original; outro request para uma issue já importada não cria duplicata. Se a origem mudar, um novo snapshot append-only pode ser registrado, sem substituir o título/descrição locais. Migração v21 mantém vínculo, snapshots e execuções de importação imutáveis. O fluxo não envia POST/PATCH/PUT/DELETE ao GitHub.

### Importação unidirecional do Azure Boards

Configure as três variáveis para cada projeto SSDD que importará do Azure Boards: `SSDD_AZURE_DEVOPS_ORGANIZATION_<PROJECT_KEY>`, `SSDD_AZURE_DEVOPS_PROJECT_<PROJECT_KEY>` e `SSDD_AZURE_DEVOPS_TOKEN_<PROJECT_KEY>`. O token fica no ambiente do processo e deve ter apenas leitura de work items. No MVP, use PAT restrito à organização, com escopo mínimo e validade curta, via HTTP Basic Auth; para um serviço de longa duração, prefira Microsoft Entra ID e credencial de workload. A Microsoft informa que PATs globais deixam de funcionar em 27 de janeiro de 2027. Toda chamada usa o host fixo `dev.azure.com`, recusa redirects e limita cada resposta a 5 MiB. O endpoint Query By WIQL retorna IDs; Get Work Items Batch lê os campos em blocos de até 200. Esses endpoints oficiais usam POST para consulta, mas o código não chama operações de criação, atualização ou exclusão. [WIQL Query By WIQL](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql?view=azure-devops-rest-7.1) · [Get Work Items Batch](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-items-batch?view=azure-devops-rest-7.1) · [Autenticação e ciclo de vida de PAT](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops)

`azure_work_item_import_preview` e `azure_work_item_import_apply` recebem `projectId`, `parentFeatureIdOrKey`, `azureWorkItemType` (`User Story` ou `Bug`) e `limit` (padrão 50, máximo 100). O mapeamento é fixo e explícito: `User Story → story`, `Bug → bug`; cada chamada consulta somente o tipo selecionado. A resposta do preview mostra `sourceType` e ignora tipos ausentes, desconhecidos ou diferentes do escolhido. O hash inclui tipo externo e local, projeto/escopo, Feature e snapshots de origem.

Apply refaz WIQL e batch, exige o mesmo `expectedPlanHash` e `requestId` e requer principal `human` com papel `po`. Itens novos começam em `draft` sob a Feature. O escopo externo é organização/projeto e o ID Azure é a identidade única; vínculo, snapshot inicial, PBI e auditoria são gravados na mesma transação SQLite. Repetir o request retorna a resposta original; novas leituras de um item já ligado podem anexar snapshot sem sobrescrever título ou descrição local. Migração v21 mantém vínculos, snapshots e recibos imutáveis. Não são enviados PATCH, PUT nem DELETE ao Azure.

Provisione um usuário depois de `init`, usando um principal local com papel `admin` naquele projeto:

```sh
ssdd-mcp access grant --workspace . --project PAY \
  --issuer https://id.example/tenant --subject user-123 \
  --display-name "Alice" --type human --roles po,developer \
  --reason "Entrada no time de pagamentos"
```

`--type` pode ser `human`, `agent` ou `service`. Os papéis aceitos são `admin`, `po`, `developer`, `qa`, `tech_lead`, `facilitator` e `stakeholder`. As permissões são associações por projeto e os gates existentes recusam agente/serviço onde uma pessoa é exigida. Para remover papéis, use `ssdd-mcp access revoke` com issuer, subject, lista de papéis e motivo. Ambos os comandos gravam auditoria; `--request-id` opcional pode ser fornecido para repetir a mesma chamada idempotentemente. Principal OIDC sem qualquer associação de projeto não consegue usar ferramentas; conceder um papel em outro projeto o reativa.

Para publicar uma aprovação, um admin humano chama `approval_issue` com `projectId`, `requestId`, `toolName`, os argumentos completos que o agente usará, `expectedVersion`, `executorPrincipalId`, `expiresInSeconds` e `reason`. O ID e a expiração retornados são a credencial de uso único. `approval_revoke` cancela uma aprovação ainda pendente e também exige motivo e `requestId`.

`project_list` não recebe argumentos e retorna somente projetos nos quais o principal autenticado tem associação. No modo stdio e HTTP sem OIDC, o principal vem do sistema operacional. No modo OIDC, ele vem do vínculo previamente provisionado entre issuer e subject. `project_get` recebe o `projectId` interno retornado pela lista. Os dois retornam `structuredContent` e conteúdo textual equivalente.

```json
{
  "projects": [{
    "id": "3e4c2639-51ad-4d42-b15a-f49ee70897b9",
    "key": "PAY",
    "name": "Pagamentos",
    "timezone": "America/Sao_Paulo",
    "version": 1,
    "roles": ["admin", "developer", "facilitator", "po", "qa", "stakeholder", "tech_lead"]
  }]
}
```

```json
{
  "project": {
    "id": "3e4c2639-51ad-4d42-b15a-f49ee70897b9",
    "key": "PAY",
    "name": "Pagamentos",
    "productGoal": "Pagamentos confiáveis",
    "timezone": "America/Sao_Paulo",
    "version": 1,
    "createdAt": "2026-11-09T12:00:00.000Z",
    "roles": ["admin", "developer", "facilitator", "po", "qa", "stakeholder", "tech_lead"]
  }
}
```

O principal local inicial recebe todos os papéis na instalação single-user. Identidades OIDC são administradas fora do catálogo MCP pelo CLI local; não recebem acesso automaticamente e papéis presentes no token são ignorados.

### Work items

`work_item_create` recebe `projectId`, `requestId`, `type`, `title` e, conforme o tipo, `parentId`, `relatedStoryId`, `description`, `priority`, `businessValueScore`, `businessValueRationale` e `criteria`. `parentId` e `relatedStoryId` aceitam UUID ou chave legível. A sequência obrigatória é épico sem pai, feature sob épico, história ou bug sob feature e tarefa sob história ou bug. Bug pode apontar opcionalmente para uma história do mesmo projeto. Critérios de aceite são criados em histórias e bugs; em tarefas, critérios só entram por `work_item_revision_propose` e formam o checklist de saída da tarefa (SSDD-938). Prioridade vai de 1 (mais alta) a 4. O score de negócio é opcional, inteiro 0–100, permitido em épico, feature e tarefa; quando informado, exige justificativa de até 1000 caracteres.

Papéis mínimos aceitos por tipo: PO cria épicos; PO ou Developer cria features; PO, Developer ou QA cria histórias; Developer ou QA cria bugs e tarefas. A identidade precisa também estar associada ao projeto. Criação grava o item, os critérios ordenados (`AC-1`, `AC-2`...), um snapshot imutável da revisão 1, evento de auditoria e resposta idempotente na mesma transação. O item começa em `draft`. `version` é a versão otimista do registro e `revision` é a revisão de conteúdo; os tools de proposta e publicação mantêm versões posteriores no histórico.

Exemplo de chamada e resultado resumido:

```json
{
  "projectId": "3e4c2639-51ad-4d42-b15a-f49ee70897b9",
  "requestId": "create-story-001",
  "type": "story",
  "parentId": "PAY-8",
  "title": "Entrar com fator adicional",
  "criteria": [{"description": "O segundo fator é solicitado após a senha"}]
}
```

```json
{
  "workItem": {
    "id": "a0a92460-a48e-4479-95d0-9ae428ca24a1",
    "projectId": "3e4c2639-51ad-4d42-b15a-f49ee70897b9",
    "key": "PAY-9",
    "type": "story",
    "parentId": "75de4603-2153-46f7-9038-bb78b88e2460",
    "relatedStoryId": null,
    "title": "Entrar com fator adicional",
    "description": null,
    "state": "draft",
    "priority": 2,
    "version": 1,
    "revision": 1,
    "createdByPrincipalId": "c1ae1c0c-96e4-45d6-a3cd-0d8d4e6e8d96",
    "createdAt": "2026-11-09T12:00:00.000Z",
    "updatedAt": "2026-11-09T12:00:00.000Z",
    "criteria": [{
      "id": "1c25ca1b-8e8b-4b64-b65e-f16dc135fc6c",
      "key": "AC-1",
      "description": "O segundo fator é solicitado após a senha",
      "required": true,
      "position": 1
    }]
  },
  "auditEventIds": ["29c9947b-d55e-4f85-b69b-5e87cda7a2bb"]
}
```

`work_item_get` recebe `projectId` e `itemIdOrKey`, aceita UUID ou chave como `PAY-9`, e devolve dados atuais, critérios e estimativas confirmadas. `work_item_list` recebe filtros `types` e `states` (valores de cada lista se combinam por OR), `parentId`, `search`, `assignedToMe`, `limit` (padrão 25, máximo 100) e `cursor`; cada resumo inclui `assigneeId`, `rank`, `businessValueScore` e `businessValueRationale`. `assignedToMe=true` filtra pelo principal autenticado, nunca por identidade fornecida pelo agente. Grupos de filtros se combinam por AND. A busca tokeniza até 10 termos em título e descrição, sem diferenciar maiúsculas ou acentos. A ordenação é por rank e usa chave/ID para desempate. O cursor fica associado ao projeto, principal, filtros, limite e watermark de auditoria; mudança auditada torna o cursor obsoleto e retorna `STALE_CURSOR`. A autorização do projeto é checada antes das consultas.

Prioridade e valor no contexto do item seguem as regras de [ADR 0024](adr/0024-prioridade-valor-e-roadmap-por-feature.md). A prioridade efetiva da tarefa é o menor número (mais alto) entre tarefa, PBI, Feature e épico. Valor efetivo vem do nível explícito mais específico entre tarefa, Feature e épico. `NULL` significa não avaliado; agentes não criam score ou justificativa por inferência.

`task_execution_queue_get` devolve até 50 tarefas atribuídas ao principal (padrão) ou permite explicitamente consultar todas. Examina no máximo 500 candidatas e devolve `candidateLimitReached` se truncar. Só as tarefas cujos mesmos gates de `task_start_check` passam aparecem em `tasks`; até três impedidas aparecem em `blocked` com códigos. Ordem é: startable, prioridade efetiva crescente, valor efetivo decrescente (ausentes depois), rank de Feature, rank de tarefa e chave. Quando nenhuma tarefa pode iniciar, `emptyReason` (`no_ready_tasks` ou `ready_tasks_blocked`) diz por quê e `upNext` lista até 5 tarefas ainda não Ready (Draft etc.), com dependências abertas por último, e para cada uma `unmetDependencies`, `missing` (`not_ready_state`, `assignee`, `estimate`, `business_value`, `dependencies`) e `nextAction`. Dependências abertas se dividem em `unmetDependencies` (trabalho pendente de verdade) e `dependenciesAwaitingAcceptance` (já entregues localmente, só sem aceite formal); `task_start` continua exigindo as duas fechadas. Tarefas já `in_progress`, `in_review` ou `in_validation` aparecem em `inFlight` (chave, estado, responsável) e nunca em `upNext`. Tarefas cuja descrição traz o registro do sincronizador (`Registro factual em docs/status.md (data): Concluíd…/Implementad…`) são entregues localmente sem aceite formal: ficam fora de `upNext` e aparecem em `awaitingAcceptance` (até 10 chaves) e `awaitingAcceptanceCount`, para que o histórico não esconda o trabalho realmente pendente. Assim a ordem de prioridade continua legível sem promover o backlog automaticamente. A fila não muda estado nem atribuição. O agente escolhe a primeira tarefa liberada, relê seu contexto e chama `task_start_check` antes de `task_start`. Para economizar contexto, a resposta omite por padrão `businessValueRationale`, `businessValueSource` e `prioritySource` (cerca de metade dos bytes de uma fila com cinco `upNext`); `verbose=true` os devolve e `work_item_get` traz a justificativa.

`project_feature_roadmap_get` aceita `teamId` e `asOfDate`, ordena Features por prioridade efetiva e valor, e retorna progresso por story points confirmados, lacunas de estimativa, dependências e timeline. Datas P25/P50/P75 só existem com pelo menos três sprints fechadas comparáveis, escopo conhecido e sem bloqueio externo; caso contrário `forecastUnavailableReason` e o estado por Feature explicam a ausência. As janelas sintéticas de timeline começam depois do corte e da sprint ativa, nunca no passado. A simulação é read-only e não reserva escopo nem cria sprints.

`work_item_rank` exige `expectedVersion` e exatamente um vizinho (`beforeIdOrKey` ou `afterIdOrKey`). A posição só muda entre itens do mesmo tipo e pai. A operação reindexa os irmãos em passos de 1024 e incrementa versão somente nos itens que mudaram de posição, em uma transação auditada e idempotente. `work_item_assign` também exige a versão esperada; atribuir `null` remove o responsável e outra identidade precisa ter papel elegível no mesmo projeto.

`work_item_revision_propose` aceita título, descrição, prioridade, `businessValueScore`, `businessValueRationale` e critérios como substituição completa opcional; campo omitido mantém o valor publicado, `description: null` limpa a descrição e uma lista de critérios vazia remove todos da projeção corrente. Score de 0–100 exige justificativa PO de até 1000 caracteres; score pode ser `null` quando a avaliação deve ser removida. Um critério existente é identificado pelo `id`; seu `key` continua estável. Critérios omitidos da nova lista ficam inativos na projeção, mas continuam nos snapshots imutáveis. Critério sem ID recebe nova identidade e chave. A proposta não altera o conteúdo publicado e só pode haver um rascunho aberto por item. `work_item_revision_publish` exige versão e revisão mais recente, aplica o novo conteúdo na mesma transação, supersede a revisão publicada anterior e registra ator e horário. `work_item_revision_list` devolve o histórico completo, incluindo o rascunho aberto.

`comment_add` grava texto de 1 a 5000 caracteres como histórico imutável e recebe `requestId`; `comment_list` usa cursor vinculado ao projeto, principal e item, com páginas de 1 a 100 (padrão 25). Comentário novo entre páginas retorna `STALE_CURSOR`. `work_item_estimate` registra uma proposta inteira entre 1 e 10000 com justificativa e versão esperada. Mais de uma proposta pode ficar pendente. `work_item_estimate_confirm` referencia proposta pendente e versão; exige principal humano com papel Developer, confirma a proposta escolhida, supersede outras propostas pendentes e a estimativa confirmada anterior da mesma unidade, atualiza a projeção corrente e registra auditoria.

Repetir um comando com o mesmo `requestId` e payload normalizado retorna a resposta e os eventos originais; reutilizar a chave com outro payload retorna `IDEMPOTENCY_CONFLICT`. A lista filtra por `assignedToMe` e devolve responsável e ordenação. Os filtros de sprint, área, tags, bloqueio manual, atualização, ligações e cobertura descritos adiante dependem das entidades planejadas e ainda não são aceitos por `work_item_list`.

### Especificações versionadas

Os tipos aceitos são `business_rule`, `glossary`, `api_contract`, `adr` e `non_functional`. A chave é única sem diferenciar maiúsculas/minúsculas dentro do projeto. `content` é um objeto JSON não vazio; a estrutura interna específica de cada tipo ainda não é validada.

`spec_create` cria a identidade e a revisão 1 em `draft`. `spec_revision_propose` exige `expectedVersion`, cria o próximo snapshot imutável e impede outra proposta enquanto houver rascunho aberto. `spec_revision_publish` exige versão e número da revisão mais recente; na mesma transação publica a candidata e marca a publicação anterior como `superseded`. Só uma revisão pode ficar `published` por especificação. O conteúdo de revisão não pode ser editado nem removido. A publicação exige PO para regra/glossário ou Tech Lead para contrato/ADR/requisito não funcional e rejeita principals de agente ou serviço; a aprovação delegada não substitui esse gate humano.

`spec_revision_withdraw` encerra uma revisão Draft/In Review sem publicá-la, exigindo versão, revisão mais recente, motivo auditável e pessoa humana com papel correspondente ao tipo. A revisão permanece na trilha com status `withdrawn`, não entra no contexto vigente e não bloqueia uma nova proposta. Revisão publicada não pode ser retirada; deve ser substituída por outra publicação. Use a retirada quando uma proposta foi abandonada ou ficou comprovadamente obsoleta, nunca para apagar uma decisão vigente.

`spec_get` aceita UUID ou chave e devolve todas as revisões. `spec_list` aceita filtro por tipo e busca opcional de 2–160 caracteres em chave, título e conteúdo JSON da última revisão; comparação ignora caixa e acentos. Entrega páginas estáveis de 1–100 resumos (padrão 25), com `latestRevision`, `latestStatus`, `publishedRevision`, `nextCursor` e `watermark`. A busca varre os documentos candidatos em ordem e mantém no máximo `limit+1` resumos na memória; seu tempo é linear no catálogo do tipo consultado. O cursor vincula projeto, principal, filtro normalizado e limite; mudança auditada retorna `STALE_CURSOR`, filtro diferente retorna `VALIDATION_FAILED`. Cada mutação é autorizada, auditada e idempotente. Erros de versão retornam `VERSION_CONFLICT`; chave duplicada retorna `SPECIFICATION_KEY_CONFLICT`.

ADRs são especificações do tipo `adr`: `spec_create` com `kind: "adr"` cria a revisão Draft e `spec_list` com `kind: "adr"` e `search` os pesquisa (as antigas `adr_create` e `adr_search` foram aposentadas por serem aliases dessas chamadas). `adr_link_task` valida que a origem seja tarefa e o destino ADR e cria uma aresta `implements` ou `relates_to`. Uma relação `implements` significa decisão necessária à implementação: o ADR precisa ter revisão publicada antes do início da tarefa e a sessão fixa essa revisão. `relates_to` é apenas referência contextual e não bloqueia o início. A publicação de ADR continua sujeita a Tech Lead humano.

A busca considera chave, título e conteúdo da revisão atual e respeita cursor/watermark. Percorre candidatos do projeto em ordem mantendo apenas `limit+1` resumos, portanto a memória por página é limitada, mas o custo de leitura é linear no catálogo consultado. Use `spec_get` para inspecionar o histórico imutável de revisões. CRUD, busca e vínculo estão disponíveis no MCP; o dashboard ainda não oferece catálogo visual de ADR (SSDD-98).

### Grafo de rastreabilidade

`trace_link_add` aceita `depends_on` entre dois work items, `implements` de work item para especificação e `relates_to` entre work items/especificações. Referências entre projetos e combinações de tipos inválidas são recusadas. Relações `relates_to` são normalizadas como arestas simétricas. A dependência é dirigida do consumidor ao pré-requisito; a verificação de ciclo e a gravação usam a mesma transação imediata. Uma ligação ativa duplicada retorna `TRACE_LINK_EXISTS`.

`trace_link_remove` registra autor e data da retirada, mantendo o registro histórico. `trace_query` aceita `inbound`, `outbound` ou `both`, profundidade 1–3, tipos de ligação e limite de 1–100 nós; relações simétricas podem ser seguidas nas duas direções. O resultado lista nós e arestas encontradas e marca `truncated` quando um limite omite novos nós. Cobertura cenário→critério/regra já tem tabela histórica e busca própria por critério. Evidências estão associadas diretamente ao item e à baseline; a aresta `verifies` no grafo geral continua planejada.

### Cenários e execuções de teste

`scenario_create` cria a identidade e a revisão 1 em rascunho. `scenario_revision_propose` exige `expectedVersion`, uma revisão publicada e nenhum rascunho aberto; cria snapshot imutável com título, pré-condições, passos e lista completa de cobertura. Cobertura aceita `criterion` ou `specification`; a referência de critério pode ser UUID ou `PAY-9:AC-2`, e a especificação pode ser UUID ou chave. `scenario_revision_publish` exige versão, revisão mais recente, papel QA e principal humano. A publicação supersede a versão anterior e registra auditoria.

`scenario_get` retorna o histórico; `scenario_list` aceita filtro opcional por tipo e entrega páginas estáveis de 1–100 resumos (padrão 25), com `nextCursor` e `watermark`. O cursor tem as mesmas regras de vínculo e obsolescência de `spec_list`. `scenario_criterion_search` recebe o UUID do critério ou a referência `item:AC-N`, percorre apenas revisões publicadas/supersedidas e devolve para cada uma a última execução de cada build. Revisões em rascunho não aparecem e ainda não podem receber execução.

`test_run_import_junit` importa um relatório JUnit (até 2 MB, sem DOCTYPE): cada `testcase` cujo nome, `classname` ou `<property name="scenario">` contém, como token inteiro, a chave de um cenário publicado vira uma execução por cenário na revisão publicada mais recente (qualquer falha ou erro vence; `skipped` só se todos foram ignorados). O SHA-256 do XML vai em `evidenceSha256`, a origem padrão é `agent` e `ci` segue a regra do ADR 0030. Casos sem cenário voltam em `unmatched`; sem nenhum cenário reconhecido a chamada falha. É idempotente por `requestId` e cenário, mas não atômica: uma falha no meio deixa as execuções já gravadas e a repetição conclui o resto.

`test_run_record` registra resultado `passed`, `failed`, `blocked` ou `skipped`, revisão publicada, `buildId`, notas, URI opcional de evidência, `evidenceSha256` opcional (64 hex) e `origin` (`agent` padrão, `human` ou `ci`). `ci` só é aceito com `buildId` `git-<sha>` e um `workflow_run` concluído com sucesso recebido por webhook para esse commit; caso contrário falha com `VALIDATION_FAILED` (ADR 0030). A origem não substitui a certificação humana. Com a política de gates `strict` (ADR 0029), `test_run_certify` só aceita execução de origem `ci` para cenário que não seja `manual`. Execuções são append-only, idempotentes por `requestId` e auditadas. Repetir um cenário/build registra nova observação; a busca retorna a de maior sequência para aquele par. `test_run_list` permite descobrir o histórico por projeto, filtrar opcionalmente por ID/chave de cenário, build e resultado, e ler páginas de 1–100 registros (padrão 25). A ordem é mais recente primeiro. `nextCursor` é vinculado ao projeto, principal, filtros, limite e maior sequência correspondente; uma nova execução que corresponda à consulta invalida o cursor com `STALE_CURSOR`. Use a página sem cursor para reiniciar a leitura. `test_run_certify` exige PBI em `in_validation`, versão esperada, execução aprovada da revisão de cenário fixada na baseline e a execução mais recente desse cenário/revisão/build. O principal precisa ter papel QA e tipo `human`; o comando incrementa a versão do PBI e grava certificação imutável. Uma execução registrada por agente permanece observação e não satisfaz o gate.

### Baselines e impactos

`baseline_fix` exige item no estado `ready`, `expectedVersion`, motivo e papel PO. A operação fixa a revisão publicada do item, revisões publicadas das especificações em ligações `implements` ativas e revisões de cenários publicados que cobrem critérios atuais do item ou essas especificações. É mantida para itens Ready anteriores ao workflow; novas entradas em Ready criam a primeira baseline na própria transação de `work_item_transition`. `baseline_get` resolve uma sequência histórica; omitindo `sequence`, retorna a mais recente.

Ao publicar uma revisão de especificação, o servidor procura itens `ready`, `in_progress`, `in_review`, `in_validation` ou `done` cuja baseline mais recente inclua uma versão anterior dessa regra. Para cada item cria impacto auditado e incrementa a versão do item, tornando comandos lidos antes da publicação obsoletos. Se não existe baseline fixada para o item, a publicação não cria impacto ainda.

`impact_list` filtra pelo item e status `open`/`revalidated`. `baseline_revalidate` exige impacto aberto **ou deriva da baseline** (revisão publicada do PBI, specs ligadas ou cenários publicados cobrindo seus critérios diferem da última baseline; ex.: critério que virou obrigatório ou cenário publicado depois), nova versão esperada, justificativa e uma pessoa PO ou Tech Lead; cria uma baseline nova com as revisões atuais e resolve os impactos capturados nela. A baseline anterior e seus snapshots continuam consultáveis.

### Workflow, evidências e certificação

`work_item_gate_check` também devolve `warnings` não bloqueantes; hoje `self_validation` (tarefa a concluir pelo mesmo principal que a executou ou é responsável), que torna visível a falta de revisão independente sem impedir a transição. `work_item_gate_check` recebe `projectId`, item por UUID/chave e `targetState` (`ready` ou `done`), com `buildId` obrigatório para avaliar a conclusão de um PBI. Retorna cada gate, resultado, mensagem e detalhes diagnósticos, mais `transitionPath`: os estados a percorrer a partir do estado atual até o alvo (por exemplo `in_review`, `in_validation`, `done` para uma tarefa `in_progress`), pois `work_item_transition` não pula etapas. Para cenário sem execução no build, os detalhes listam builds disponíveis. `work_item_transition` recebe `targetState`, `expectedVersion` e motivo; só executa transições permitidas, registra a transição e evento de auditoria e devolve o novo número de versão. Erros `GATE_BLOCKED` carregam o relatório de gates no campo `details`.

`work_item_quality_get` reúne critérios da revisão congelada na baseline ou, sem baseline, da revisão corrente em modo `preview`. Cada critério indica cobertura e inclui cenários elegíveis, revisão e última execução de cada build; certificações e evidências da baseline aparecem junto do run/item correspondente. A resposta inclui contagem e percentual dos critérios obrigatórios. `evidenceCursor` continua a página de evidências, sem recalcular ou alterar o relatório de domínio. O endpoint de qualidade do dashboard também pagina os resumos por `limit` e `cursor`; o cliente lê as páginas sequencialmente e reinicia se um cursor ficar obsoleto. Use `test_run_list` quando precisar percorrer execuções antigas que não sejam a última de cada build.

Entrada de PBI em Ready exige revisão publicada, critérios, cenário publicado para cada critério obrigatório, estimativa de pontos confirmada e especificações `implements` publicadas. A baseline inicial é gravada de forma atômica com a transição. Para tarefas, Ready exige pai PBI em Ready/em andamento, baseline herdada, responsável e descrição de saída esperada. Dependências incompletas bloqueiam início e conclusão.

`task_start_check` explica se o Developer atual pode iniciar: tarefa em Ready ou já em andamento sem sessão aberta, papel e atribuição correspondentes, PBI pai ativo com baseline, dependências diretas em Done e ADRs `implements` publicados. Uma sessão ativa sempre bloqueia outra. Uma sessão pausada do mesmo Developer deve ser retomada; sessão pausada de outra pessoa exige que o dono conclua/cancele antes da troca. `task_start` repete os checks sob `BEGIN IMMEDIATE`, compara `expectedVersion`, transiciona Ready→`in_progress` e inicia a sessão no mesmo comando idempotente; qualquer erro reverte estado, transição, sessão e auditoria. `work_item_transition` não permite a transição direta de tarefa Ready para `in_progress`; use `task_start`. O erro `USE_TASK_START` orienta clientes antigos para o fluxo seguro. Uma implementação `implements` sem ADR publicado bloqueia; o vínculo pode ser alterado para `relates_to` apenas quando não expressar uma decisão necessária.

O dashboard também expõe `GET /api/v1/projects/{projectId}/quick-access` para a projeção inicial e `POST /api/v1/projects/{projectId}/work-items/{id}/claim` para o Developer assumir uma tarefa Ready sem responsável. O claim não é uma nova tool MCP: ele é a operação HTTP da home e só persiste atribuição depois de revalidar todos os gates de início exceto atribuição; iniciar sessão ainda exige `task_start`. A interface de papel não substitui `SSDD_PROFILE` do transporte e não muda o RBAC da conexão.

#### Workflow ponderado por tarefa

`task_workflow_get(projectId, taskIdOrKey, revisionNumber?)` retorna a revisão publicada atual, o Draft, a revisão selecionada e até 50 resumos de histórico. Com `revisionNumber`, pode consultar uma revisão histórica específica mesmo que ela não esteja entre os 50 resumos; `revisionHistoryTruncated` avisa quando a lista resumida foi cortada. O plano publicado inclui IDs, posição, título, instruções, peso, status e autoria/data da última alteração, além de progresso, esforço restante e `allStepsDone`. Revisões Draft não têm percentual calculado.

`task_workflow_propose` requer `requestId`, `expectedTaskVersion`, `expectedWorkflowVersion` (0 se ainda não há revisão), `steps` e motivo. Cada passo aceita `id` existente da revisão anterior opcional, `title` de 1–160 caracteres, `description` de 1–4.000 e `effortPercent` de 0,01 a 100,00 com no máximo duas casas. IDs ausentes recebem UUIDs novos. Deve haver 1–50 passos e a soma inteira em pontos base precisa ser exatamente 10.000 (100,00%). Só task pode ter workflow e proposta só é aceita quando task está Draft, Ready ou `in_progress`; Developer e Tech Lead podem propor. Um novo Draft retira o Draft anterior, sem excluir sua revisão/eventos. Versão vencida retorna `VERSION_CONFLICT`; conteúdo inválido retorna `VALIDATION_FAILED`.

`task_workflow_publish` recebe `revisionNumber`, `expectedTaskVersion`, `requestId` e motivo. Somente Tech Lead humano pode publicar a revisão Draft mais recente enquanto a task está Draft, Ready ou `in_progress`, e nenhuma sessão pode estar ativa ou pausada. A publicação incrementa a versão da tarefa, supersede a revisão publicada anterior e grava eventos para etapas carregadas/resetadas. Etapas com mesmo ID, título e instruções mantêm o status se sua nova posição continua sequencialmente válida; alteração de definição ou reordenação incompatível reseta para Pendente. Mudança isolada de peso mantém status e recalcula o percentual pelo peso novo. A resposta informa `preservedStepIds`, `resetStepIds` e percentual anterior. `WORKFLOW_SESSION_OPEN` recusa publicação com sessão aberta.

`task_workflow_step_transition` recebe revisão, `stepId`, `expectedTaskVersion`, status alvo (`pending`, `in_progress`, `done`), request ID e motivo. Developer atribuído precisa de sessão ativa própria que tenha pinado exatamente a revisão publicada atual. O caminho normal é Pendente → Em andamento → Concluída; não se pode concluir sem iniciar nem avançar enquanto houver etapa anterior incompleta. Percentual é a soma dos pesos de etapas Concluídas, arredondada por definição de centésimos; Em andamento conta 0%. Etapa Em andamento pode voltar a Pendente quando etapas posteriores estão pendentes. Corrigir uma etapa Concluída para Pendente exige Tech Lead humano, nenhuma sessão aberta e etapas posteriores reabertas antes, em ordem inversa. Cada mudança incrementa a versão da tarefa e gera evento append-only de auditoria. Status inválido, versão/pinagem divergente, sessão/atribuição ausente e violação de ordem retornam erros de domínio (`VALIDATION_FAILED`, `VERSION_CONFLICT`, `FORBIDDEN` ou `INVALID_TRANSITION`).

Se há um Draft inicial sem revisão publicada, Ready/início e Done ficam bloqueados até publicar ou retirar o Draft; ao propor revisão de uma task que já possui workflow publicado, a revisão corrente continua executável até a nova publicação. Sem workflow publicado, lista/contexto retorna progresso `null` e as regras legadas de início/conclusão permanecem. Com workflow publicado, Ready exige que não haja Draft inicial e Done exige todas as etapas Concluídas. Mesmo 100% não significa aceite, teste, evidência ou certificação QA: `work_item_gate_check`, baseline, dependências, evidência e política de QA continuam valendo.

O início via `task_start` ou `development_session_start` grava uma referência imutável à revisão publicada então corrente. Isso torna a sessão reproduzível e impede que uma nova versão altere o plano já iniciado; revisão nova só pode ser publicada depois de encerrar sessões ativas/pausadas. `work_item_list` projeta `taskWorkflowRevisionNumber`, `taskWorkflowProgressPercent`, `taskWorkflowCompletedSteps` e `taskWorkflowTotalSteps` para tarefas, todos `null` quando não há workflow publicado.

`evidence_add` recebe um URI absoluto, `kind`, descrição e `buildId` opcional. A referência é associada à baseline atual do PBI, inclusive quando adicionada a uma tarefa. O servidor guarda metadados e não busca o URI. `evidence_list` pagina por sequência do item; novos registros tornam o cursor anterior `STALE_CURSOR`. Evidência e histórico de transições são append-only.

Para concluir um PBI, informe o build candidato. O gate exige baseline sem impacto aberto, tarefas ativas concluídas, evidência do PBI associada àquela baseline e ao build, e a última execução de cada cenário fixado aprovada no mesmo build e certificada por pessoa QA. Evidência de outro build, execução falha ou certificação ausente bloqueia Done. Tarefa exige evidência própria associada à baseline herdada. Na política atual, `ready` para PBI exige PO humano; tarefa pode ser preparada por Developer/QA; `done` do PBI exige Developer humano; cancelamento exige PO humano. Retorno de revisão/QA a `in_progress` requer motivo.

### Time, calendário e capacidade

`team_create` recebe projeto, `requestId`, nome, fuso IANA, horas padrão por dia, dias ISO de trabalho (`1` = segunda, `7` = domingo), composição de 1–100 pessoas, dedicação de 0–100%, datas opcionais de vigência, feriados, ausências e motivo. Cria um ID estável, versão 1 e geração 1; o retry devolve a mesma resposta e evento de auditoria. `team_list` retorna IDs, nomes, configuração corrente e membros. Cada pessoa da composição deve ser humana e membro do projeto; a mesma pessoa pode estar em times diferentes e cada dedicação é calculada separadamente.

`team_capacity_set` recebe `teamId` opcional, `expectedVersion`, nome e os mesmos campos de calendário/composição; sem `teamId`, a configuração corrente é inferida apenas se houver exatamente um time. `expectedVersion=0` configura o registro legado ainda não configurado ou a única configuração inicial; não cria um segundo time. Projetos com vários times exigem ID explícito, e o erro `VALIDATION_FAILED` traz `teamOptions` para seleção. Cada atualização gera versão imutável; a versão anterior permanece consultável. Escrita exige PO ou facilitadora humana. `generationNumber` inicia em 1 e só avança quando membros, dedicação ou vigência mudam. Calendário, fuso, feriados e ausências criam nova versão sem trocar a geração. Em bancos atualizados para v16, configurações anteriores ficam em geração 0, pois a composição histórica não é inferível com segurança.

`team_capacity_get` recebe intervalo inclusivo `startDate`/`endDate`, `teamId` opcional e `configVersion` opcional; o intervalo pode ter até 367 dias. Retorna dias úteis, horas totais, capacidade por pessoa e série diária somente do time escolhido. Feriados removem o dia do calendário. Para cada pessoa ativa em um dia útil, a capacidade é `max(0, horasPorDia - horasDeAusência) × dedicaçãoPercentual / 100`. A resposta registra fuso e datas civis. O cálculo de 9 a 20 de novembro de 2026 com duas pessoas, 6 h/dia, dedicação 100% e 50%, e um dia de ausência integral da primeira pessoa resulta em 84 horas.

### Marcos e escopo aprovado

`milestone_create` recebe chave, título, objetivo, data alvo, 1–100 PBIs por UUID/chave e motivo. Chaves são únicas sem distinção de caixa dentro do projeto. Somente PO humano pode criar e aprovar o escopo inicial. Cada PBI deve ser história ou bug em Ready ou além, ter pontos confirmados, baseline que inclua sua revisão publicada atual e nenhum impacto de especificação aberto. IDs e chaves equivalentes são tratados como o mesmo PBI.

`milestone_scope_change` adiciona e/ou remove PBIs em uma única chamada e exige `expectedVersion`; a mesma identidade de PBI não pode aparecer nos dois lados. Cada alteração grava um evento append-only com estado no momento, pontos, ID da baseline, revisão, autor, motivo e data. O retorno mantém a lista atual e o histórico completo. O PBI pode ser removido e aprovado novamente mais tarde; nenhum evento anterior é apagado. `milestone_get` aceita ID ou chave, e `milestone_list` retorna resumo com quantidade e soma de pontos do escopo corrente.

### Métricas e previsão do projeto

`metrics_get` recebe `projectId`, `teamId` opcional, `milestoneId`, `sprintId` e `asOfDate`. Em projeto com vários times, informe `teamId`; quando há um só, a aplicação seleciona esse time para manter o fluxo simples. Sprint, velocidade e previsão são filtradas pelo time selecionado; marco, WIP e cobertura continuam sendo projeções do projeto. Referências de marco e sprint aceitam UUID ou chave. O valor `none` desativa a seleção correspondente; `asOfDate` é data civil no fuso do projeto e vale até o fim desse dia.

A velocidade só inclui sprints fechadas antes do início do dia local seguinte e usa a geração de composição do time vigente no corte. A resposta retorna essa geração em `selectedTeamGenerationNumber`. Média, mediana e tamanho da amostra se referem a essa geração, preservando fechamentos com zero pontos. `pointsPerHour` é apenas a razão descritiva entre pontos aceitos e capacidade da sprint; não é a unidade de velocity e não alimenta a previsão v2.

A resposta inclui `projectId`, `asOfDate`, `observedAt`, `watermarkSequence`, IDs selecionados, `selectedTeamGenerationNumber`, motivo para previsão indisponível, opções de marcos/sprints e os objetos `milestoneMetrics`, `forecast`, `sprintMetrics`, `velocity`, `wip` e `coverage`. `velocity` contém as sprints da amostra e seus pontos/capacidade, mais `byTeamGeneration` com contagem, média e mediana de pontos por sprint. O forecast v2 inclui `algorithmVersion`, `seed`, `simulationCount`, `teamId`, geração, amostras de sprints comparáveis, datas P25/P50/P75 e `probabilityOnTime` (fração entre 0 e 1). `targetDateWithinHorizon` indica se essa probabilidade pode ser calculada dentro dos 365 dias; estados sem previsão usam `null`. Cobertura inclui os totais globais, `itemsTotal`, `itemsTruncated` e no máximo 20 registros em `items`; o painel apresenta 20 e o detalhe de PBI permite buscar outros itens. Percentuais e contagens consideram todos os itens, não somente os detalhes retornados. A cobertura certificada só conta uma execução aprovada e certificada por QA se ela ainda for a execução mais recente da revisão do cenário no build filtrado ou, sem filtro de build, entre todos os builds; um run posterior em outro build supera a certificação anterior e deixa de contar como validação certificada. A rota `GET /api/v1/projects/{projectId}/dashboard-metrics` chama o mesmo serviço de aplicação e devolve a mesma projeção para filtros e watermark equivalentes. `observedAt` registra quando essa projeção foi montada e pode ser compartilhado por chamadas que reutilizam o cache. WIP e cobertura representam a situação atual, enquanto burnup, sprint, velocity e previsão respeitam o corte.

Cada chamada valida a associação do principal ao projeto e consulta o watermark dentro de uma transação SQLite. Uma projeção em memória pode ser reutilizada por até 1 s para a mesma conexão SQLite, principal, projeto, filtros e watermark; a autorização é checada novamente e qualquer evento auditado invalida o valor. Se houver um marco elegível no corte, a previsão pode gravar ou reutilizar um snapshot imutável da tabela de forecast criada na v17; o algoritmo v2 usa a chave de algoritmo existente, sem nova migration. Seed e entradas persistidas permitem reprodução exata. Snapshots de algoritmo v1 mantêm recálculo pela implementação original. O registro não altera o escopo nem cria evento de domínio. Projeto sem associação retorna `FORBIDDEN`, como nas demais ferramentas. Corte anterior à criação do marco retorna `forecastUnavailableReason: "before_milestone_created"` e métricas de marco/previsão nulas.

`milestone_forecast_history` recebe marco, `teamId` opcional e limite de 1–20 (padrão 10); retorna snapshots recentes sem incluir o vetor de capacidade/insumos completo da simulação. Em projetos com vários times, informe `teamId`. `milestone_forecast_recalculate` recebe `forecastId` de um snapshot e reproduz o algoritmo versionado com os insumos imutáveis persistidos; retorna status, percentis, cenários, seed e probabilidade recalculados, sem criar snapshot nem evento.

### Definition of Done e planejamento de sprint

`definition_of_done_set` recebe `expectedVersion`, 1–50 critérios e motivo; `0` cria a revisão inicial. Cada revisão é imutável, e uma versão vencida retorna `VERSION_CONFLICT`. IDs omitidos são gerados pelo servidor e preservados no retry idempotente. `definition_of_done_get` retorna a versão corrente ou a indicada por `revisionNumber`. Escrita exige pessoa PO ou facilitadora.

`sprint_draft` recebe `teamId` opcional, chave, título, Sprint Goal, intervalo civil de até 367 dias, PBIs por UUID/chave e motivo. O projeto precisa ter capacidade configurada no time escolhido e Definition of Done configurada. Cada item selecionado precisa ser PBI (`story`/`bug`) em Ready, com baseline e pontos confirmados. Um PBI só pode estar reservado em um rascunho ou sprint ativa do projeto; conflito retorna `VALIDATION_FAILED`. O rascunho fixa time, versão de capacidade e revisão de DoD. Sem seleção de time, a regra de time único se aplica. `sprint_scope_change` adiciona ou remove PBIs mantendo eventos append-only com snapshot, motivo, autor e data. No rascunho, PO, Developer ou facilitador podem editar o escopo; em sprint ativa, somente PO humano pode fazê-lo. Toda alteração usa `expectedVersion`.

`sprint_start` só inicia rascunho com escopo não vazio e exige PO humano. O servidor confirma que estado, revisão publicada, baseline e pontos dos PBIs não mudaram desde o planejamento e calcula capacidade pelo snapshot do time. Um índice e o gate limitam cada time a uma sprint ativa; times diferentes podem executar em paralelo. A abertura preserva capacidade diária e por pessoa, comprometimentos, Definition of Done e autor/motivo na trilha de transição.

`sprint_close` exige sprint ativa, resumo de review e conjunto de PBIs aceitos. Cada aceito deve estar no escopo corrente e em Done; as transições/gates de Done já aplicam QA, evidência e baseline. O encerramento congela aceitos, incompletos, resumo, capacidade de abertura e revisão de DoD. PBIs incompletos mantêm seu estado e estimativa no backlog quando a sprint deixa de ser ativa; o escopo fechado permanece disponível como histórico. Fechamento e cancelamento exigem pessoa PO ou facilitadora. `sprint_cancel` aceita apenas rascunho ou sprint ativa, guarda motivo e preserva escopo/transições.

`sprint_retrospective_set` recebe `expectedVersion` (`0` cria a primeira revisão), resumo, listas `keepDoing`, `stopDoing` e `tryNext`, ações, e motivo. Cada revisão e suas ações são imutáveis; o retry com o mesmo `requestId` devolve os IDs gerados originalmente. Em nova revisão, os IDs das ações atuais devem ser enviados para preservar a identidade das ações mantidas. Cada ação exige título e responsável humano associado ao projeto; o PBI opcional aceita UUID ou chave de história/bug do mesmo projeto. Só facilitador humano pode gravar, e somente após a sprint estar fechada. Versão desatualizada retorna `VERSION_CONFLICT`. `sprint_retrospective_get` devolve a versão atual ou uma revisão selecionada e a lista do histórico mais recente primeiro.

## Filtros

- Filtros diferentes se combinam por AND. Valores dentro de um filtro multivalorado se combinam por OR. Campos e operadores fora do catálogo retornam `VALIDATION_FAILED`.
- `work_item_list` já aceita `types`, `states`, `parentId` e `search` em título/descrição, ordena por `rank` e devolve `assigneeId`. O vínculo do backlog com a sprint e os filtros `sprintId`, `epicId`, `featureId`, `assigneeIds`, `areaIds`, `tags`, `blocked`, `updatedSince`, `linkedSpecIds` e `coverage` ainda serão expostos nas tarefas do board.
- `spec_list` e `scenario_list` filtram por tipo e paginam com cursor estável de 1–100 itens. Filtros por item relacionado e área ainda não estão disponíveis; use `task_context_get` para combinar hierarquia, critérios, especificações ligadas, cenários, execuções e baseline com proveniência. `trace_query` suporta `inbound`, `outbound` ou `both`, tipos de aresta, profundidade de 1 a 3, até 100 nós e lista de nós visitados por percurso. Omissões por orçamento são sinalizadas.
- Listas têm 25 registros por página por padrão, máximo 100. Cursor opaco tem ordenação estável com ID para desempate e vínculo ao projeto, principal e filtro. Se o watermark do conjunto mudar de modo a invalidar a paginação, devolver `STALE_CURSOR` e exigir reinício. Auditoria pagina por sequência com teto de snapshot.
- `fields` limita projeção e `include` escolhe relações ou seções. Campos sensíveis são controlados pela política, independentemente da projeção solicitada. Datas em ISO 8601 e enums em inglês.

## Sessões, calibração e releases

`development_session_start` permanece para clientes compatíveis e só inicia uma tarefa já em `in_progress` atribuída ao Developer autenticado; em Ready, prefira `task_start` para evitar transição sem sessão. A sessão recebe UUID de domínio, horário UTC e referência opcional da conversa. Fixa ADRs/regras `implements` publicadas e revisões de cenário associadas à tarefa. `development_session_transition` exige dono, versão e motivo; pause/resume acumula apenas intervalos ativos. Um Developer reatribuído pode concluir/cancelar sua sessão anterior, mas não retomá-la. O serviço detecta sessão ativa concorrente e retorna `SESSION_CONFLICT` em vez de expor erro de índice SQLite. Reatribuir não muda autoria. O agente conclui a sessão quando encerra seu esforço, mesmo que a tarefa siga em revisão/QA.

`developer_execution_metrics_get` mantém story points na velocidade de time. `from`/`to` são dias inclusivos no fuso local do projeto. A visão individual separa sessões encerradas no período da coorte de tarefas cuja última transição para Done ocorreu no período; estimação e esforço dessa coorte usam sessões encerradas até a conclusão. Em tarefas com vários Developers, a estimativa é distribuída na proporção do esforço registrado até a conclusão. `estimateVariancePercent` e `effortCalibrationFactor` comparam horas reais e confirmadas nas mesmas tarefas com estimativa de horas; o fator só aparece com ao menos cinco tarefas estimadas. `activeHoursOnCompletedTasks` mantém o total histórico em tarefas concluídas para compatibilidade, e `activeHoursOnEstimatedCompletedTasks` mostra o subconjunto comparável à estimativa. É uma referência descritiva; não modifica estimativas, forecast ou avaliação de pessoas automaticamente. Com no mínimo cinco tarefas na amostra, cada desenvolvedor traz também `cycleTimeHours` (tempo de relógio da primeira sessão na tarefa até Done, pausas incluídas: mediana e P85) e `effortRatioRange` (faixa P15–P85 do fator real/estimado por tarefa, intervalo empírico de previsão individual); abaixo disso ambos são `null`. Os campos são descritivos, não formam ranking e não convertem story points.

`deployment_event_record` registra resultado observado no ambiente; não infere deploy a partir de CI ou do estado `Done`. Rollback é um evento separado que aponta para deploy bem-sucedido do mesmo ambiente. Deploy de produção aprovado valida que cada item esteja `Done` e tenha homologação aprovada para o mesmo `buildId`. `deployment_event_list` preserva falhas e rollbacks. O detalhe da tarefa no dashboard mostra início/fim de desenvolvimento e as datas mais recentes de homologação/produção aprovadas.

Os IDs estáveis do roadmap são aliases persistidos e imutáveis, sem consumir o namespace das chaves geradas. Quando um `SSDD-###` estiver mapeado, `work_item_get` e as tools de leitura/proposta/publicação de revisão de item tratam essa forma como o ID estável. Outras tools aceitam o UUID ou a chave gerada conforme o contrato descrito nesta página; use `roadmap_id_resolve` antes de chamar uma operação que não declare alias estável. Se a chave gerada de outro item tiver a mesma grafia, use o UUID para endereçar a chave sem ambiguidade.

## Contexto de uma tarefa

`task_context_get` exige um work item do tipo tarefa e percorre a hierarquia até o épico. Usa a baseline mais recente do PBI pai quando ela existe; caso contrário, resolve revisões publicadas correntes e marca o resultado como `preview`, com warning `NO_BASELINE_PREVIEW`. Revisões de PBI, especificação e cenário são identificadas por número e URI. Links ativos `implements` (tarefa → especificação) e `relates_to` (entre tarefa e especificação, em qualquer direção) são consultados na hierarquia; a origem informa se o link é direto ou herdado e, quando aplicável, inclui `traceLinkType`. `implements` afirma que o trabalho implementa aquela especificação; `relates_to` só fornece contexto e não deve ser tratado como prova de implementação. Regras ligadas depois da baseline e revisões publicadas mais recentes aparecem como warnings; o conteúdo de uma baseline permanece o conteúdo consultado.

Especificações publicadas dos tipos regra de negócio, API, ADR e requisito não funcional podem aparecer nas seções de contexto conforme o perfil. O tipo `glossary` é omitido pelo resolver; agentes que precisem esclarecer termos devem ler a revisão publicada com `spec_get`. Conteúdo extenso pode ser resumido com URI para resource (`ENTRY_MOVED_TO_RESOURCE`); se `truncated` for `true`, continue com `nextCursor` antes de concluir que uma referência não está presente.

Os perfis escolhem seções padrão. `dev` recebe hierarquia, critérios, regras de negócio, decisões técnicas e cenários; `qa` recebe hierarquia, critérios, regras, cenários e última execução por build; `po` recebe o conjunto mais amplo, incluindo decisões, resultados e resumo da baseline. `include` substitui a seleção padrão; prompts e skills de implementação/QA pedem explicitamente também `testRuns` e `baseline`. Cada cenário e run pode carregar chaves/UUIDs das tarefas que cobre; contexto de tarefa inclui cenário publicado associado diretamente e runs registrados para aquela tarefa, além das relações obtidas por cobertura. O run conserva a revisão publicada e o build exatos. O perfil só filtra contexto; a autorização continua baseada no principal e no projeto. Se uma seção não tiver referências, sua lista vem vazia.

```json
{
  "projectId": "3d8a2c36-4de5-4a8a-9411-23c98db1b3ce",
  "taskIdOrKey": "PAY-13",
  "profile": "dev",
  "include": ["hierarchy", "acceptanceCriteria", "businessRules", "technicalDecisions", "scenarios", "testRuns", "baseline"],
  "maxChars": 8000
}
```

```json
{
  "task": { "id": "f72152ec-4240-4b16-b050-bf114b6586c7", "key": "PAY-13", "title": "Implementar cancelamento", "state": "ready", "version": 5, "parentId": "73fd1985-c450-44f0-8224-29a53c114099" },
  "profile": "dev",
  "mode": "pinned",
  "baseline": { "id": "2520ab4e-f375-46f3-b727-5a65fc47466f", "sequence": 1, "kind": "ready" },
  "sections": {
    "hierarchy": [{ "section": "hierarchy", "key": "PAY-12", "title": "Cancelar Pix", "source": { "entityType": "work_item_revision", "entityId": "73fd1985-c450-44f0-8224-29a53c114099", "key": "PAY-12", "revisionNumber": 2, "mode": "pinned", "uri": "ssdd://projects/3d8a2c36-4de5-4a8a-9411-23c98db1b3ce/work-items/PAY-12/revisions/2" }, "content": { "type": "story", "state": "ready", "description": "" } }],
    "acceptanceCriteria": [],
    "businessRules": [{ "section": "businessRules", "key": "BR-04", "title": "Instante de corte", "source": { "entityType": "specification_revision", "entityId": "c34c58ad-847f-43b5-877a-49e79f03a729", "key": "BR-04", "revisionNumber": 3, "mode": "pinned", "uri": "ssdd://projects/3d8a2c36-4de5-4a8a-9411-23c98db1b3ce/specs/BR-04/revisions/3" }, "content": { "text": "O cancelamento ocorre antes do instante de corte." } }],
    "technicalDecisions": [],
    "scenarios": [],
    "testRuns": [],
    "baseline": []
  },
  "warnings": [],
  "truncated": true,
  "nextCursor": "opaque-cursor"
}
```

Seções disponíveis: `hierarchy`, `acceptanceCriteria`, `businessRules`, `technicalDecisions`, `scenarios`, `testRuns`, `baseline`, `definitionOfDone` e `guidance` (SSDD-948: orientações do projeto, ações da retrospectiva e devoluções recentes, todas com `provenance`); `definitionOfDone` é (a DoD vigente no `task_start`, pinada por tarefa; revisão posterior gera o aviso `DOD_REVISED_AFTER_PIN` sem reprocessar itens concluídos; o relatório de entrega inclui entradas `scope: "dod"`, com `criterionKey` igual ao ID do critério da DoD). `maxChars` aceita de 2.000 a 30.000 caracteres e o padrão é 8.000. Entradas são mantidas inteiras; se a página não comporta o próximo registro, `truncated` fica `true` e `nextCursor` retoma após o último registro entregue. O cursor vincula tarefa, projeto, principal, perfil, seções, orçamento e watermark de auditoria. Mudança de dados invalida a continuação com `STALE_CURSOR`; filtros diferentes ou token inválido retornam `VALIDATION_FAILED`.

O servidor publica os templates `ssdd://projects/{projectId}/tasks/{taskIdOrKey}/context{?profile}`, `ssdd://projects/{projectId}/work-items/{itemIdOrKey}/revisions/{revisionNumber}`, `ssdd://projects/{projectId}/specs/{specIdOrKey}/revisions/{revisionNumber}`, `ssdd://projects/{projectId}/scenarios/{scenarioIdOrKey}/revisions/{revisionNumber}` e `ssdd://projects/{projectId}/test-runs/{runId}`. O resource de contexto aceita o perfil opcional e usa o orçamento padrão de 8.000 caracteres; para escolher seções, mudar o orçamento ou avançar cursor, use a ferramenta `task_context_get`. Resources de revisão recusam conteúdo em rascunho e repetem a autorização do projeto. Conteúdo maior que o orçamento é resumido na página com URI para leitura completa.

## Prompts e skills para agentes

`prompts/list` publica oito fluxos sem efeito colateral. O perfil restringe quais são listados:

| Prompt | Argumentos | Uso |
|---|---|---|
| `ssdd_refine_backlog` | `projectId`, `epicIdOrKey?`, `outcome?` | Refina necessidade em história/bug, critérios e tarefas sem inventar chaves ou gravar sem solicitação |
| `ssdd_refine_technical_design` | `projectId`, `itemIdOrKey`, `outcome?` | Refina design, tarefas testáveis, workflows ponderados, migrações e vínculo work item → specification sem assumir aprovação de negócio |
| `ssdd_plan_sprint` | `projectId`, `epicIdOrKey?`, `sprintGoal?` | Refinar objetivo, critérios, dependências e capacidade como PO/facilitador |
| `ssdd_start_task` | `projectId`, `taskIdOrKey` | Abrir contexto Dev, consultar workflow e gates, iniciar sessão de forma atômica e seguir a revisão pinada sem confundir 100% com QA |
| `ssdd_validate_quality` | `projectId`, `itemIdOrKey`, `buildId?` | Começar em `work_item_quality_get`, usar etapas para orientar cobertura, investigar histórico e conferir gates/evidências sem inventar resultados |
| `ssdd_release_readiness` | `projectId`, `milestoneIdOrKey?` | Revisar escopo, métricas, gates, CI, pacote, guias e histórico de deployment; registrar eventos após resultado observado |
| `ssdd_design_tests` | `projectId`, `itemIdOrKey` | Desenhar matriz critério → regra/especificação → cenário → tarefa, sem fingir execução |
| `ssdd_security_review` | `projectId`, `itemIdOrKey?`, `focus?` | Fazer revisão de engenharia somente leitura com evidência, severidade justificada e mitigação |

Matriz do conteúdo disponibilizado ao agente:

| Perfil | Prompts | Skills/agentes |
|---|---|---|
| `refinement` | `ssdd_refine_backlog` | `ssdd-business-analyst`, `ssdd-product-owner` |
| `specification` | `ssdd_refine_technical_design` | `ssdd-technical-lead` |
| `dev` | `ssdd_start_task` | `ssdd-developer` |
| `test_design` | `ssdd_design_tests` | `ssdd-test-designer` |
| `qa` | `ssdd_design_tests`, `ssdd_validate_quality` | `ssdd-test-designer`, `ssdd-quality-assurance` |
| `tech_lead` | `ssdd_refine_technical_design`, `ssdd_start_task`, `ssdd_design_tests` | `ssdd-technical-lead`, `ssdd-developer` |
| `security_review` | `ssdd_security_review` | `ssdd-security-reviewer` |
| `po` | `ssdd_refine_backlog`, `ssdd_plan_sprint` | `ssdd-business-analyst`, `ssdd-product-owner` |
| `facilitator` | `ssdd_plan_sprint` | `ssdd-delivery-facilitator` |
| `release` | `ssdd_release_readiness` | `ssdd-release-manager` |
| `devops` | `ssdd_release_readiness` | `ssdd-release-manager` |
| `admin` | Nenhum | `ssdd-system-administrator`, somente ao administrador singleton |
| `full` | Todos os oito | As dez skills; a skill de administração apenas ao administrador singleton |

Os prompts apenas orientam o agente sobre chamadas e decisões; não executam ferramentas nem alteram estado ao serem obtidos. Eles distinguem fatos verificados de hipóteses, preservam os gates humanos e instruem o agente a não inventar testes, builds, evidências ou certificações.

O servidor também declara a extensão MCP Skills do SDK para clientes compatíveis. O catálogo contém dez agentes/playbooks: `ssdd-business-analyst`, `ssdd-product-owner`, `ssdd-technical-lead`, `ssdd-developer`, `ssdd-test-designer`, `ssdd-quality-assurance`, `ssdd-security-reviewer`, `ssdd-delivery-facilitator`, `ssdd-release-manager` e `ssdd-system-administrator`. Cada perfil recebe apenas o subconjunto aplicável; `full` recebe os dez. `skills/get` e a leitura de arquivos servem os documentos de `skills/`, e clientes podem validar o digest antes de carregar uma skill. O pacote npm inclui esses arquivos. O instalador gera os agentes nativos a partir da mesma fonte canônica. Um agente que não implementa a extensão ainda pode ler as skills diretamente do repositório ou do pacote.

Para instalar os playbooks no escopo do projeto Codex, copie os diretórios de `skills/` para `.agents/skills/`. Em outros hosts, use o mecanismo de skills do host ou leia `SKILL.md` pela extensão MCP. As instruções reforçam critérios testáveis, testes de regressão, sincronização da documentação e aprovação humana nas mutações.

## Mutações e erros

```json
{
  "projectId": "pay",
  "itemId": "PAY-13",
  "targetState": "in_review",
  "expectedVersion": 5,
  "requestId": "01JST000000000000000000001",
  "reason": "Implementação e teste unitário vinculados ao PR."
}
```

| Código da aplicação | Ação do cliente |
|---|---|
| `VALIDATION_FAILED`, `INVALID_TRANSITION` | Corrigir campos ou seguir transições permitidas |
| `PROJECT_CONFIGURATION_CONFLICT` | A chave de projeto já existe com outra configuração; o comando `init` não sobrescreve projetos |
| `NOT_FOUND`, `FORBIDDEN` | Entidade ausente/invisível ou ação não autorizada em entidade visível |
| `APPROVAL_REQUIRED`, `APPROVAL_NOT_FOUND`, `APPROVAL_MISMATCH` | Solicitar aprovação válida para o executor, projeto, ferramenta, argumentos e versão exatos |
| `APPROVAL_EXPIRED`, `APPROVAL_REVOKED`, `APPROVAL_ALREADY_USED` | Solicitar nova aprovação; um ID consumido ou revogado nunca pode ser reativado |
| `VERSION_CONFLICT`, `STALE_CURSOR` | Recarregar e reconciliar. Cursor exige reinício |
| `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_EXPIRED` | Manter a chave para o payload original; após a janela, consultar o estado antes de emitir outro comando |
| `SPECIFICATION_KEY_CONFLICT` | Consultar a especificação existente ou escolher outra chave estável no projeto |
| `TRACE_LINK_EXISTS` | Consultar o grafo; uma ligação ativa igual já existe |
| `GATE_BLOCKED`, `DEPENDENCY_CYCLE` | Resolver os gates indicados em `details` ou remover a aresta de dependência inválida |
| `INTERNAL_ERROR` | Não inferir se a mutação teve sucesso; reconciliar o estado e fornecer `correlationId` ao operador |
| `retryable: true` | Respeitar o backoff limitado do cliente. Para comando idempotente, repetir somente com o mesmo `requestId` e payload; o indicador da resposta é a fonte de verdade, não o prefixo do código |

Erros de domínio aparecem em resultado de ferramenta com `isError: true` e envelope JSON no bloco de texto com `code`, `message`, `details`, `retryable` e `correlationId`; o resultado de erro não tem `structuredContent` do formato de sucesso. Erros de validação do protocolo permanecem no JSON-RPC. As exceções inesperadas viram `INTERNAL_ERROR` genérico: o host escreve em `stderr` somente o `correlationId` e a classe da exceção, nunca mensagem/argumentos/credenciais. Um agente deve tratar `isError: true` como falha, não continuar como se a mutação tivesse funcionado, usar `details` para corrigir bloqueios, repetir apenas quando `retryable` for verdadeiro e reconciliar timeout/conflitos antes de emitir uma nova mutação. `VERSION_CONFLICT` exige releitura e novo payload/versão; não é retry cego. No modo OIDC, falhas de autenticação usam respostas HTTP Bearer `401 invalid_token` ou `403 insufficient_scope`; identidade válida sem provisionamento recebe `403 identity_not_provisioned`. Uma transição bloqueada deve indicar as referências faltantes ou incompatíveis para orientar o cliente.

## Custo de contexto de `tools/list` (U19)

Medido em 2026-11-12: o catálogo `full` tem 106 tools e ≈554 KB em `tools/list`, dos quais ≈459 KB (83%) são `outputSchema`; `dev` tem 44 tools e ≈193 KB; `tech_lead` 67 tools e ≈276 KB. As tools de sprint pesam ≈23 KB cada porque embutem o mesmo schema de sprint. Para clientes que carregam todos os schemas no contexto, `SSDD_MCP_OMIT_OUTPUT_SCHEMAS=1` remove `outputSchema` do catálogo (redução de ~80%); as respostas continuam trazendo `structuredContent`. Combine com `SSDD_PROFILE` (ex.: `dev`) e, para fechar tarefas, prefira `task_accept` a ~10 chamadas separadas. O padrão continua com schemas para não quebrar clientes que os validam.

### `project_feature_roadmap_get` — progresso (2026-11-13)

`progressPercent` = tarefas concluídas / tarefas não canceladas da feature (fallback: `deliveredPercent` quando não há tarefas). `deliveredPercent` = pontos de histórias/bugs Done. `taskTotal`/`taskDone` detalham a conta; `epics[]` (cada épico com `key`, `title`, contagens e progresso) traz o rollup por épico (`key`, `featureCount`, `taskTotal`, `taskDone`, `progressPercent`).
