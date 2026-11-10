# Roadmap de implementação

Planejamento inicial em sprints de duas semanas. Pontos Fibonacci representam complexidade relativa do trabalho técnico, não compromisso de prazo. São propostas para refinamento, com referência de 3 pontos para uma operação vertical simples com validação e teste. As oito sprints formam uma ordem de trabalho, sem datas de calendário. Uma sprint piloto solo já calculou 60 horas configuradas em dez dias úteis, mas não existe ainda uma amostra de produção para estimar velocidade; consulte [docs/solo-simulation.md](docs/solo-simulation.md). IDs são estáveis para issues e referências de implementação. Cada linha é uma unidade implementável com verificação específica. A execução atual fica registrada em [docs/status.md](docs/status.md); aceite e status precisam ser atualizados junto com cada entrega.

| Épico | Features | Marco |
|---|---|---|
| E1 · Plataforma | Runtime local, persistência, identidade, auditoria, operação | v0.1 local |
| E2 · Especificação executável | Backlog, revisões, rastreabilidade, contexto, QA e gates | v0.1 local |
| E3 · Scrum e dashboard | Sprint, board, qualidade, capacidade e previsão | v0.2 equipe |
| E4 · Compartilhamento e distribuição | Servidor HTTP, autenticação, backups, pacote e documentação | v0.2 equipe |

## Sprint 1 · Fundação local (19 pontos)

**Meta:** criar um projeto, persistir uma alteração auditada e ler a configuração por MCP após reinício.

| ID | Tarefa | Pontos | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-101 | Inicializar workspace Node/TypeScript, lint, build e CI | 3 | — | Build e verificação automática em Linux, macOS e Windows |
| SSDD-102 | Validar SDK, cliente MCP, driver SQLite, WAL e FTS5 | 3 | 101 | ADR lista versões fixadas e spike comprova stdio e capacidades do banco |
| SSDD-103 | Implementar CLI init, schema inicial, migração e diretório de dados | 5 | 102 | Duas inicializações convergem para a mesma base e falha de migração interrompe abertura |
| SSDD-104 | Implementar principal local, autorização de projeto, auditoria e idempotência | 5 | 103 | Comando negado sem evento de domínio. Repetição autorizada devolve resultado original |
| SSDD-105 | Registrar transport adapter stdio e ferramentas de projeto | 3 | 104 | Cliente real executa initialize, tools/list e project_get. stdout contém apenas protocolo |

## Sprint 2 · Backlog e especificação versionada (26 pontos)

**Meta:** o PO registra uma história, publica uma regra e encontra os itens relacionados.

| ID | Tarefa | Pontos | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-201 | Implementar hierarquia, critérios e snapshot imutável inicial de PBI | 5 | 104 | Pai de tipo errado e vínculo entre projetos são recusados; IDs de critérios ficam no snapshot inicial protegido contra alteração |
| SSDD-202 | Implementar listas, filtros, cursor e busca textual | 3 | 201, 102 | AND/OR e cursor inválido são cobertos por fixture |
| SSDD-203 | Implementar identidade e revisões de regra, glossário, ADR, contrato e requisito não funcional | 5 | 104 | Revisões têm conteúdo imutável; publicação supersede a anterior na mesma transação e mantém só uma vigente |
| SSDD-204 | Implementar ligações tipadas entre work items e especificações | 5 | 201, 203 | `implements`, `relates_to` e `depends_on` são consultáveis por direção; cross-project é recusado e dependência concorrente não cria ciclo |
| SSDD-205 | Implementar ordenação, responsável, comentários e estimativa proposta | 3 | 201 | Ordenação entre irmãos revalida versões; atribuição checa elegibilidade; comentários e propostas preservam histórico; confirmação humana de pontos atualiza projeção e auditoria |
| SSDD-206 | Implementar proposta e publicação de revisões de conteúdo de PBI | 5 | 201, 203 | Revisão publicada permanece imutável; publicar só o rascunho mais recente exige PO humano; critérios preservam IDs e removidos saem da projeção sem perder histórico; conflito de versão é recusado |

## Sprint 3 · Dev, QA e release local (21 pontos)

**Meta:** concluir uma história via MCP com contexto reproduzível e evidências certificadas.

| ID | Tarefa | Pontos | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-301 | Implementar cenários versionados, cobertura e execuções | 5 | 203, 204 | Busca por critério retorna revisão publicada do cenário e última execução por build; rascunhos não são executáveis e todas as publicações/execuções são auditadas |
| SSDD-302 | Fixar baseline, sinalizar impactos e implementar revalidação | 5 | 204, 205, 301 | Baseline Ready congela revisão do PBI, regra ligada e cenários cobertos; regra publicada depois de Ready abre impacto e incrementa versão; revalidação humana fixa nova baseline e a antiga continua resolvível |
| SSDD-303 | Implementar contexto filtrado por tarefa e resources | 3 | 302, 202 | `task_context_get` e resource de tarefa resolvem hierarquia, critérios, baseline e proveniência. Perfis Dev, QA e PO aplicam seções padrão distintas; envelope respeita `maxChars`, pagina por cursor opaco e sinaliza truncamento. Cursor obsoleto, autorização e leitura das revisões referenciadas são cobertos por testes de aplicação e MCP real. |
| SSDD-304 | Implementar workflow, evidência, aprovação local e gates | 5 | 301, 302 | Agente não certifica QA. Falha de cenário ou build divergente bloqueia Done |
| SSDD-305 | Empacotar CLI local, documentar cliente e entregar projeto de demonstração | 3 | 303, 304 | Demo reproduz trilha PO → Dev → QA em máquina limpa. Tag v0.1 após validação |

## Sprint 4 · Scrum, board e capacidade (26 pontos)

**Meta:** planejar, operar e fechar uma sprint pela API e acompanhar o board local.

| ID | Tarefa | Pontos | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-401 | Implementar time, calendário, disponibilidade e capacidade | 3 | 104 | Fixture de dedicação parcial e ausência retorna 84 horas |
| SSDD-402 | Implementar Definition of Done, planejamento, início, mudança de escopo, fechamento e cancelamento | 5 | 304, 401 | Versões de DoD/capacidade são fixadas; sprint inicia com PBI Ready sem drift e capacidade positiva; mudanças ativas exigem PO humano; fechamento aceita apenas PBI Done, congela aceitos/incompletos e preserva histórico |
| SSDD-403 | Implementar API HTTP local e sessão do dashboard, com autorização comum | 5 | 104, 304 | Bind loopback, bootstrap de uso único, cookie/CSRF e rotas de projeto/backlog/sprint usam os serviços existentes; falta de permissão retorna `FORBIDDEN` igual via MCP |
| SSDD-404 | Implementar backlog, board com teclado e drag and drop e detalhe de item | 5 | 402, 403 | Board abre pela URL local; teclado e drag and drop propõem transições via serviço compartilhado; gates recusados preservam o card; versão vencida mostra conflito e atualiza o estado |
| SSDD-405 | Implementar visão de QA e timeline de auditoria | 5 | 301, 404 | Do PBI, operador percorre critério → revisão de cenário → execução/build → certificação/evidência e abre transições originais com ator e motivo; filtros/páginas de auditoria preservam autorização e watermark |
| SSDD-406 | Registrar retrospectiva de sprint e ações acompanháveis | 3 | 402, 405 | Facilitador humano registra aprendizados e ações após sprint fechada; revisões são imutáveis/versionadas, responsáveis são membros humanos e ações podem referenciar PBIs do mesmo projeto |

## Sprint 5 · Métricas e previsão (23 pontos)

**Meta:** mostrar mudanças de escopo e previsão com dados rastreáveis e hipóteses visíveis.

| ID | Tarefa | Pontos | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-501 | Implementar marcos, geração de time e escopo aprovado | 5 | 402 | PO aprova apenas PBI com baseline atual e pontos confirmados; adições e remoções preservam snapshots com ator, motivo e versão |
| SSDD-502 | Projetar burndown, burnup, velocidade, WIP e cobertura | 5 | 402, 501 | Projeções leem snapshots consistentes com corte/watermark; fixture prova reabertura, remoção, reestimativa, zero entregas e reconciliação de cobertura |
| SSDD-503 | Implementar previsão por cenários, snapshots e estados insuficientes | 5 | 401, 502 | Entrega original v1: fixture calcula P25/P50/P75 em 24/20/18 dias úteis, seleciona amostras do time/geração antes do corte e do limite, inclui zero entrega, usa capacidade pós-corte, bloqueio externo suprime datas e snapshot imutável pode ser recalculado; algoritmo substituído pela simulação v2 em SSDD-803 |
| SSDD-504 | Implementar dashboard executivo e técnico com drill-down | 5 | 404, 503 | Gráficos de burnup/burndown oferecem corte por data, marco e sprint; a lista de PBIs no corte reconcilia os totais e a tela indica unidade, observação e watermark |
| SSDD-505 | Expor metrics_get, testar reconstrução e medir performance | 3 | 503, 504 | API e MCP usam a mesma projeção autorizada, preservam filtros e watermark; fixture com 10 mil itens e 50 mil eventos mede reconstrução fria, onda fria com cinco clientes MCP, leituras concorrentes aquecidas e gravações. p95 ≤ 300 ms para leitura fria/aquecida e ≤ 500 ms para gravação simples; detalhes de cobertura limitados sem alterar totais |

## Sprint 6 · Servidor compartilhado e release (21 pontos)

**Meta:** publicar v0.2 com instalação local e em servidor, isolamento entre agentes e recuperação verificada.

| ID | Tarefa | Pontos | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-601 | Implementar Streamable HTTP, negociação, limites e validação de origem | 5 | 105, 403 | Cliente oficial funciona com handshake legacy e opt-in moderno `2026-07-28`, lista/chama tools; versões de protocolo não suportadas, Host/Origin remotos e corpos acima de 1 MiB são recusados |
| SSDD-602 | Integrar OAuth/OIDC, RBAC, perfis de serviço e aprovação vinculada | 5 | 304, 601 | Resource server valida token e provisionamento antes de tools; papéis por projeto e tipos human/agent/service preservam gates; aprovação vinculada a ação/projeto/payload/versão/executor expira, é consumida uma vez e registra executor/aprovador |
| SSDD-603 | Entregar backup, restore, export e diagnóstico | 5 | 103, 602 | Backup online gera manifesto SHA-256 verificável; restore exige `.ssdd` ausente/vazio, aplica migrações e valida integridade/FKs; revisões, histórico e projeções continuam consultáveis; export JSON/Markdown não expõe credenciais/chaves de identidade; `doctor` é somente leitura |
| SSDD-604 | Preparar pacote de distribuição e implantação com volume persistente | 3 | 603 | Tarball instala em prefixo limpo; imagem Node roda como usuário sem privilégios com volume nomeado em `/data` e sem porta MCP publicada; projeto continua visível em novo container após o primeiro encerrar |
| SSDD-605 | Rodar E2E de release e publicar guias operacionais e demo multiagente | 3 | 505, 604 | Fluxo completo de PO/Developer/QA validado com clientes MCP OIDC e dashboard, incluindo gates e autorização; guias de instalação/operação atualizados. Tag v0.2.0 somente após aceite da release |

## Sprint 7 · Interoperabilidade externa (v0.3 · 21 pontos)

**Meta:** compartilhar especificações com ferramentas de QA e receber referências externas sem perder a autoria, o histórico ou a idempotência do SSDD.

| ID | Tarefa | Pontos | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-701 | Exportar revisões publicadas de cenários para Gherkin | 3 | 301, 603 | Export determinístico inclui apenas a revisão publicada corrente, mapeia pré-condições/ações/resultados para Given/When/Then, identifica projeto/cenário/revisão por tags e não permite que quebras de linha no conteúdo criem passos ou cenários injetados |
| SSDD-702 | Criar recepção autenticada e idempotente de webhooks | 5 | 601, 602 | `POST /webhooks/{provider}/{projectKey}` valida HMAC e limite de 1 MiB antes de interpretar JSON; segredo é por provider/projeto, provider + delivery ID são únicos, replay retorna o recibo original, payload inválido não grava estado e todo evento aceito tem auditoria sem persistir segredo nem corpo bruto |
| SSDD-703 | Integrar webhooks de pull request e CI do GitHub | 5 | 702 | Pull requests e workflows concluídos allowlisted validam repositório mapeado, ligam SHA/build e chave de work item em snapshots imutáveis, expõem leitura autorizada no MCP e não alteram item ou certificação QA; replay não duplica referência, ações/eventos fora da allowlist não criam referências e configuração/projeto/repositório inválidos são recusados |
| SSDD-704 | Importar issues do GitHub de forma unidirecional | 4 | 206, 702 | Preview autenticado é read-only e retorna hash do plano; apply humano PO exige hash atual, revalida mapeamento/repositório, exclui PRs, cria items Draft sob Feature escolhido, mantém vínculo externo único e snapshot imutável de origem; retries não duplicam e nenhuma escrita é enviada ao GitHub |
| SSDD-705 | Importar work items do Azure Boards de forma unidirecional | 4 | 206, 702 | WIQL + batch usa apenas `dev.azure.com`, credencial read-only por projeto e mapeamento explícito `User Story→story`/`Bug→bug`; preview sem gravação retorna hash e tipos ignorados; apply humano PO exige hash atual, cria itens Draft sob Feature e registra vínculo/snapshot imutável; retries não duplicam, conteúdo local não é sobrescrito e nenhuma escrita é enviada ao Azure |

## Sprint 8 · Times e previsão probabilística (v0.4 · 21 pontos)

**Meta:** planejar vários times no mesmo projeto e mostrar a incerteza de entrega sem misturar históricos incompatíveis.

| ID | Tarefa | Pontos | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-801 | Migrar o modelo de um time para vários times por projeto | 8 | 401 | Nova entidade de time preserva projetos, associação de pessoas, configurações e snapshots existentes; cada banco legado recebe um time padrão determinístico e upgrade/downgrade via backup são exercitados |
| SSDD-802 | Aplicar capacidade, composição e políticas por time | 5 | 801, 402 | Capacidade, sprints, velocidade e previsão usam o time explícito; consultas rejeitam combinações ambíguas; versões, calendários e snapshots ficam separados, a sprint ativa é única por time e um PBI não fica reservado em duas sprints abertas |
| SSDD-803 | Simular previsão de entrega por Monte Carlo | 8 | 801, 802, 503 | 10.000 simulações usam resultados empíricos de sprints encerradas do mesmo time/geração, capacidade pós-corte e seed registrada; retornam datas P25/P50/P75, probabilidade até a meta, hipóteses e estados para dados insuficientes, sem capacidade, bloqueio, velocidade zero e conclusão; alvos além do horizonte ficam explícitos e snapshots podem ser recalculados sem misturar gerações |

## Evolução condicionada à adoção

- PostgreSQL para múltiplas réplicas só entra em sprint quando benchmark reproduzível demonstrar que a arquitetura single-host SQLite excede os limites acordados; medir primeiro e registrar a decisão em ADR.
- Busca semântica só entra em sprint quando consultas representativas mostrarem lacunas do FTS5; qualquer resultado precisa trazer proveniência e preservar autorização por projeto.

## Backlog de habilitação de agentes

Entrega transversal ao roadmap. A hierarquia histórica fica Épico E4 → Feature de habilitação → história de fluxo guiado → task. A extensão local para os clientes de codificação está refinada no backlog seguinte.

| ID | Tarefa | Pontos | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-901 | Publicar prompts MCP e skills de agente por papel | 5 | 105, 303, 304 | Clientes stdio e Streamable HTTP listam e obtêm prompts PO, Developer, QA e Release; a extensão MCP Skills lista e lê as quatro skills com verificação de digest; prompts e skills seguem contexto, gates humanos e proibição de fabricar evidências; testes e documentação cobrem os dois transports e o pacote npm inclui as skills |

## Backlog de instalação para Claude Code, Codex e OpenCode

Entrega local e reversível em repositório Git. Estimativa conjunta: **26 pontos de história, 49 horas de tarefa**. A referência de capacidade do time solo é 60 h em dez dias úteis (23/11–04/12/2026), deixando 11 h para revisão e imprevistos; nenhuma sprint foi iniciada. Itens permanecem Draft no MCP até que critérios, dependências, estimativas e baseline passem pelos gates formais.

Fluxo proposto: resolver e inspecionar o repositório → gerar plano sem escrita → preparar runtime local e arquivos nativos → validar o MCP por stdio → atualizar a documentação. A implementação usa mudanças idempotentes, manifesto com hashes, detecção de colisões, staging do pacote e rollback das gravações em caso de falha. O detalhamento operacional está em [docs/agent-installer.md](docs/agent-installer.md).

### SSDD-67 · Instalador local e reversível por repositório

Instala o runtime privado em `.ssdd/agent-runtime`, apresenta dry-run por padrão e aplica alterações somente sob a raiz Git selecionada.

#### SSDD-68 · Planejar e aplicar instalação repetível do SSDD MCP (5 pontos)

**História:** Como mantenedor de repositório, quero instalar e atualizar o runtime SSDD MCP com prévia, rastreamento de arquivos gerenciados e detecção de conflitos para habilitar agentes sem perder configuração existente.

**Critérios de aceite:**

- A CLI aceita alvo de repositório e modos dry-run, apply e check; alvo inválido ou fora de uma raiz Git falha antes de escrever.
- Dry-run lista arquivos e configurações a criar/atualizar e conflitos, sem gravar nem executar instalação npm.
- Apply instala o pacote no runtime local, registra versão e hashes, e uma segunda execução idêntica não cria diff.
- Atualização substitui somente conteúdo comprovadamente gerenciado; edição local ou colisão não gerenciada falha sem sobrescrever dados.

| ID | Tarefa | Horas | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-69 | Implementar CLI, resolução do repositório e plano dry-run | 3 | — | Argumentos são validados; a raiz Git é resolvida; o plano inclui os três clientes, skills, agentes, runtime e conflitos; dry-run não altera o alvo. |
| SSDD-70 | Instalar runtime local e aplicar mudanças com rollback | 5 | SSDD-69 | O pacote local é construído e instalado em staging sob `.ssdd/agent-runtime`; hashes protegem arquivos gerenciados; falhas restauram configurações e runtime anteriores. |

### SSDD-71 · Adaptadores nativos para Claude Code, Codex e OpenCode

Registra o servidor stdio e publica skills e agentes nos caminhos nativos dos três clientes, preservando configurações já existentes.

#### SSDD-72 · Registrar o servidor MCP nos três clientes de codificação (8 pontos)

**História:** Como equipe, quero que Claude Code, Codex e OpenCode iniciem o MCP instalado no repositório e usem o workspace correto, sem substituir configurações locais de outros servidores.

**Critérios de aceite:**

- Claude Code recebe entrada stdio em `.mcp.json`, usa `CLAUDE_PROJECT_DIR` com fallback documentado e conserva os outros servidores.
- Codex recebe `[mcp_servers.ssdd_mcp]` em `.codex/config.toml` com comando, args e cwd do projeto; a documentação explica a exigência de confiança.
- OpenCode recebe `mcp.servers.ssdd_mcp` local com comando em array e cwd do workspace em `opencode.json` ou `opencode.jsonc` válido.
- JSON/JSONC e TOML preexistentes mantêm comentários, chaves desconhecidas e outros servidores; nome ocupado por definição não gerenciada é conflito legível.

| ID | Tarefa | Horas | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-73 | Adicionar servidor Claude Code em `.mcp.json` | 4 | SSDD-69, SSDD-70 | Configuração project-scope stdio resolve o workspace e preserva servidores existentes; conflito do nome `ssdd_mcp` não é sobrescrito. |
| SSDD-74 | Adicionar servidor Codex em `.codex/config.toml` | 4 | SSDD-69, SSDD-70 | Bloco TOML aponta para runtime local, define `cwd` do projeto e preserva comentário/configuração fora do bloco gerenciado. |
| SSDD-75 | Adicionar servidor OpenCode em `opencode.json/jsonc` | 5 | SSDD-69, SSDD-70 | Merge da estrutura V2 preserva comentários e outras chaves e configura tipo local, comando em array e cwd explícito. |

#### SSDD-76 · Instalar skills e agentes nativos para cada cliente (8 pontos)

**História:** Como agente de engenharia, quero receber skills SSDD e perfis nativos de agente por papel, com instruções alinhadas e sem fixar um modelo que o usuário não escolheu.

**Critérios de aceite:**

- As quatro skills canônicas são copiadas com conteúdo e digest íntegros para `.claude/skills/<id>/SKILL.md` e `.agents/skills/<id>/SKILL.md`; OpenCode descobre a cópia compatível sem uma terceira duplicação.
- Claude recebe quatro arquivos `.claude/agents/*.md`, Codex recebe quatro `.codex/agents/*.toml` e OpenCode recebe quatro `.opencode/agents/*.md`.
- Cada perfil orienta a skill da mesma função e preserva os gates humanos, sem impor modelo, segredo ou permissão excessiva.
- Colisões de caminho, IDs duplicados, frontmatter inválido e arquivos locais modificados são relatados antes da escrita.

| ID | Tarefa | Horas | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-77 | Copiar skills canônicas para os diretórios descobertos | 5 | SSDD-69 | Frontmatter e IDs são validados; cópias Claude/Codex/OpenCode correspondem à origem e obedecem ao manifesto de hashes. |
| SSDD-78 | Gerar agentes nativos de Claude Code e Codex | 5 | SSDD-77 | Quatro agentes de cada cliente usam formato nativo, instruções do papel e referência à skill correspondente, sem modelo fixo. |
| SSDD-79 | Gerar agentes nativos de OpenCode | 4 | SSDD-77 | Quatro perfis Markdown têm frontmatter V2 válido, descrição e modo de subagente, sem modelo fixo. |

### SSDD-80 · Conformidade, validação e documentação do instalador

Valida instalação em repositórios vazios e preexistentes e documenta operação apoiada pelas versões atuais dos formatos oficiais.

#### SSDD-81 · Validar instalação integrada e documentar operação (5 pontos)

**História:** Como mantenedor e agente de IA, quero verificar uma instalação completa, entender conflitos e atualizações e reproduzir o setup nos três clientes com documentação apoiada em fontes oficiais.

**Critérios de aceite:**

- Teste em diretório temporário instala runtime e três formatos; cliente stdio inicia o servidor gerado e conclui handshake e `tools/list` sem apontar para fora do alvo.
- Testes cobrem reexecução sem diff, dry-run sem mutação, conflitos, edição local, falha de preparação e preservação de caminhos e configurações.
- Guia descreve pré-requisitos, instalação, check, atualização, recuperação e compatibilidade nativa com links oficiais.
- `npm run check` passa; CI remota e testes de GUI só são registrados quando executados.

| ID | Tarefa | Horas | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-82 | Criar testes E2E de instalação e preservação | 6 | SSDD-70, SSDD-73, SSDD-74, SSDD-75, SSDD-77, SSDD-78, SSDD-79 | Fixtures demonstram dry-run, apply, check idempotente, preservação, conflito, alteração gerenciada e ausência de escrita antes do staging. |
| SSDD-83 | Validar configurações com processo MCP real | 4 | SSDD-70, SSDD-73, SSDD-74, SSDD-75 | Runtime instalado completa handshake stdio, lista ferramentas/skills e executa consulta read-only de projeto. |
| SSDD-84 | Documentar instalação, atualização e compatibilidade oficial | 4 | SSDD-82, SSDD-83 | README, guia, status e ADR explicam uso, recuperação, limites e fontes oficiais verificadas em 10/11/2026. |

## Refinamento para a Sprint 7

- **SSDD-701:** exportar a revisão publicada corrente de cada cenário para Gherkin válido, com tags rastreáveis e conteúdo de uma linha; executar o parser oficial para verificar recursos e passos gerados. Rascunhos e revisões supersedidas ficam fora da exportação.
- **SSDD-702:** integrar a recepção ao listener `ssdd-mcp serve` em `POST /webhooks/{provider}/{projectKey}`. Configurar cada segredo no ambiente como `SSDD_WEBHOOK_SECRET_<PROVIDER>__<PROJECT_KEY>` (por exemplo, `SSDD_WEBHOOK_SECRET_GITHUB__PAY`), com pelo menos 32 bytes; o sufixo de provider usa maiúsculas e `_` para representar `-`. O endpoint mantém a validação de Host/Origin, recebe `application/json` até 1 MiB e autentica HMAC-SHA256 sobre os bytes originais antes de interpretar JSON. GitHub usa `X-GitHub-Delivery`, `X-GitHub-Event` e `X-Hub-Signature-256`; outros providers usam `X-SSDD-Delivery-Id`, `X-SSDD-Event` e `X-SSDD-Signature`. Aceitar apenas objeto JSON. Persistir recibo imutável, hash SHA-256 e metadados, nunca corpo nem segredo; associar o recibo ao projeto da rota, criar principal do tipo `service` sem conceder papéis e gravar `webhook.received` na mesma transação. A chave global é provider + delivery ID: replay com mesmo hash e evento devolve status e corpo originais; conteúdo ou evento diferente retorna conflito. Falha de tamanho, assinatura, JSON, projeto ou provider não cria recibo, principal nem auditoria. Testar também migração a partir do schema anterior, payload chunked acima do limite e ausência do segredo no banco/log.
- **SSDD-703:** instalar o handler GitHub após HMAC/JSON e dentro da mesma transação do recibo; configurar `SSDD_GITHUB_REPOSITORY_<PROJECT_KEY>=<owner>/<repository>` em conjunto com `SSDD_WEBHOOK_SECRET_GITHUB__<PROJECT_KEY>`. Exigir `repository.full_name` igual ao mapeamento (sem diferenciar maiúsculas/minúsculas); ausência ou divergência retorna 404 e reverte principal, recibo e auditoria. Processar `pull_request` nas ações `opened`, `reopened`, `synchronize`, `edited`, `closed`, `ready_for_review` e `converted_to_draft`; processar `workflow_run` apenas na ação `completed`. Outros eventos e ações válidos recebem recibo idempotente sem referência de domínio. Extrair a primeira chave `<PROJECT_KEY>-<número>` do branch e, depois, do título do PR; persistir a chave não resolvida quando não houver item atual correspondente. Workflow liga branch e PRs associados. Migração v20 guarda snapshots normalizados append-only de PR/commit e run/build, vinculados ao recibo; tool `github_reference_list` devolve a versão mais recente por PR/run e aceita filtro por item com autorização do projeto. Não persistir corpo bruto/segredo, alterar work item, inferir aprovação de build ou criar certificação QA. Cobrir HMAC, replay, conflito, allowlist, mapeamento, item resolvido/não resolvido, autorização, migração e ausência de efeitos em estado/gates.
- **SSDD-704:** ler `GET /repos/{owner}/{repo}/issues` com token read-only em `SSDD_GITHUB_ISSUES_TOKEN_<PROJECT_KEY>`, `state=all`, paginação oficial e limite de 1 a 100 issues por execução. Filtrar entradas que contenham `pull_request`. Exigir `SSDD_GITHUB_REPOSITORY_<PROJECT_KEY>`, parent Feature UUID/chave e tipo alvo `story` ou `bug`. `github_issue_import_preview` consulta e valida sem gravar; retorna hash SHA-256 do plano, totais e itens ignorados já vinculados/inválidos. `github_issue_import_apply` é restrito a PO humano, recebe `expectedPlanHash` e `requestId`, refaz a leitura e recusa plano alterado. Criar PBI em Draft com título/descrição normalizados, vínculo único `(provider, repository, issue id)` e snapshot da origem na mesma transação. Retry não duplica, importação posterior não sobrescreve campos locais e nenhuma requisição mutável é enviada ao GitHub. Paginação, rate limit, token ausente/inválido, repositório diferente, PR embutido, limite de texto, stale plan e rollback são cobertos por fixture com fetch simulado.
- **SSDD-705:** configurar `SSDD_AZURE_DEVOPS_ORGANIZATION_<PROJECT_KEY>`, `SSDD_AZURE_DEVOPS_PROJECT_<PROJECT_KEY>` e token read-only por chave de projeto. Fixar toda chamada em `https://dev.azure.com`; usar PAT organizacional via Basic Auth no MVP com escopo mínimo de leitura e validade curta; preferir Entra ID para operação de longa duração. PATs globais deixam de funcionar em 27/01/2027. `azure_work_item_import_preview/apply` recebem explicitamente `azureWorkItemType` (`User Story` ou `Bug`), pai Feature e limite de 1 a 100; o mapeamento local é respectivamente `story` ou `bug`. WIQL usa apenas o tipo selecionado e `$top`; leitura em lote solicita campos conhecidos em grupos de no máximo 200 IDs. Os POSTs de WIQL e batch são consultas de leitura; redirects são recusados e respostas têm limite de 5 MiB. Preview não grava no SSDD e produz plano hash; apply humano PO refaz a consulta e exige hash atual. IDs de organização/projeto definem `(provider, escopo, work item id)`; vínculo, snapshot append-only, item Draft e auditoria são transacionais. Tipo remoto ausente, desconhecido ou divergente é exibido como ignorado; dados posteriores nunca sobrescrevem campos locais. Fixtures cobrem WIQL, batch, tipos ausentes/desconhecidos, permissões, reexecução, plano obsoleto, segredo, resposta inválida e ausência de chamadas mutáveis.

## Refinamento e execução da Sprint 8

- **SSDD-801 (implementada localmente):** migration v22 remove a unicidade de `project_id` em `teams`, preservando a chave composta `(project_id, team_id)` exigida pelas configurações e sprints. Para times existentes, preserva UUID, configurações, geração, membros, calendário, ausências, DoD/sprints ligados e snapshots, sem renumerar versões. Para projetos legados sem time, cria um registro padrão com UUID v5 determinístico derivado de `project_id` e versão de configuração 0; a primeira configuração reutiliza esse registro. A leitura sem configuração retorna `NOT_FOUND`. O rebuild desativa FKs só na conexão migradora antes da transação versionada e as restaura após ela; a verificação `foreign_key_check` acontece dentro da transação e qualquer violação reverte o rebuild. Testes cobrem upgrade v21 com/sem time, UUID igual em upgrades independentes, preservação de FKs e snapshots, inclusão de um segundo time, retry idempotente da primeira configuração, rollback e leitura de backup v21 com o conjunto de migrações da versão anterior. Não há downgrade destrutivo.
- **SSDD-802 (implementada localmente):** adicionar `teamId` explícito a configuração, capacidade, sprint, velocidade, forecast e histórico. `team_create/list` usa ID UUID estável e criação idempotente. Seleção omitida é aceita somente com um time; múltiplos retornam `VALIDATION_FAILED` com `teamOptions`; IDs de outro projeto retornam `NOT_FOUND`. Uma pessoa pode pertencer a times diferentes com dedicação e geração próprias; membros de time não concedem papel de projeto e papel de projeto não infere composição. Um PBI pode ficar em no máximo um rascunho/sprint ativa em todo o projeto; fechar/cancelar libera o compromisso. Cada time pode ter uma sprint ativa e capacidade/snapshots permanecem filtrados pelo `team_id`. Migração v23 preserva JSONs de forecast e adiciona team_id à unicidade; o dashboard usa seletor para sprints, retrospectiva, velocidade e previsão, mantendo backlog/WIP/cobertura project-wide. Testes cobrem upgrade v22, capacidade e sprints simultâneas de dois times, scope overlap, ambiguidade, cliente MCP e paridade HTTP.
- **SSDD-803 (implementada localmente):** algoritmo v2 executa 10.000 tentativas por projeto/time/marco/corte com amostras de até seis sprints fechadas da mesma `team_id` e geração, incluindo entregas zero. Cada tentativa sorteia resultados empíricos com reposição e ajusta os pontos pela razão entre capacidade futura e capacidade observada; mantém story points como unidade e não calcula horas necessárias. Sprints ativas/planejadas preservam suas janelas; períodos sem plano usam a mediana de duração histórica e a configuração vigente como hipótese. Seed determinística, entradas, algoritmo, quantidade e watermark ficam no snapshot imutável; recalcular v2 reproduz o resultado, enquanto snapshots v1 continuam usando o algoritmo original. Retorna P25/P50/P75 de datas de conclusão, probabilidade de entrega até a meta, horizonte e estados para dados insuficientes, sem capacidade, velocidade zero, bloqueio e conclusão. Testes cobrem seed/recálculo, capacidade reduzida, teams e gerações, entregas zero, meta antes/depois do horizonte, bloqueio, escopo concluído, forecast do time selecionado no dashboard e compatibilidade v1. ADR 0013 registra as premissas.

## Definition of Done da implementação

Uma tarefa tem aceite verificável, migração reversível via backup/restore quando aplicável, teste no caminho normal, autorização e documentação do contrato alterado. Uma sprint entrega o fluxo da meta em fixture reproduzível. Release inclui notas de compatibilidade do protocolo, upgrade e instalação. Features que alteram o histórico têm fixture de regressão com base criada em versão anterior.

## Refinamento para iniciar a Sprint 1

- **SSDD-101:** inicializar npm, TypeScript estrito, lint, comandos de build/verificação e CI nos três sistemas operacionais com Node 24 e 26. Aceite fecha após execução verde da matriz, não apenas após criar o workflow.
- **SSDD-102:** confirmar SDK MCP, stdio, cliente de teste, driver SQLite, WAL, foreign keys, FTS5 e JSON. Registrar versões e limites em ADR; manter os probes como testes de regressão.
- **SSDD-103:** criar CLI `init`, diretório `.ssdd` privado, schema e migrações com checksum. Testar duas inicializações, conflito de configuração, migração quebrada, drift de checksum e reabertura.
- **SSDD-104:** criar principal local, associação de papéis, autorização por projeto, auditoria e idempotência transacional. Testar autorização negativa, rollback e replay idêntico/conflitante.
- **SSDD-105:** conectar o processo stdio ao armazenamento e registrar `project_list`/`project_get`. Exercitar handshake, `tools/list` e `tools/call` com cliente MCP real; protocolo deve tolerar parsing estrito de stdout.

Os critérios originais de aceite permanecem nas tabelas da Sprint 1. O checklist operacional e as evidências da tarefa corrente ficam em [docs/status.md](docs/status.md).

## Refinamento para iniciar a Sprint 3

- **SSDD-301:** modelar revisões e cobertura antes das execuções. Publicações são humanas; execuções só apontam para revisão publicada e são imutáveis por cenário, revisão e build.
- **SSDD-302:** congelar PBI, regras ligadas e cenários cobertos em baseline. Alteração publicada posterior cria impacto auditado; revalidação gera nova sequência sem apagar o snapshot anterior.
- **SSDD-303:** oferecer contexto pela aplicação e expor a mesma consulta por ferramenta e resource MCP. O perfil `dev` prioriza decisões técnicas; `qa` inclui execução por build; `po` inclui o resumo da baseline. Todas as entradas trazem revisão e URI de origem. Contexto sem baseline fica marcado `preview`; páginas respeitam o orçamento e cursor fica inválido quando o watermark de auditoria muda.
- **SSDD-304:** transições válidas exigem `expectedVersion`, papel adequado e motivo; preparar PBI exige revisão publicada, cobertura obrigatória, pontos confirmados e especificações publicadas. Entrada do PBI em Ready cria a baseline na mesma transação. Tarefa exige PBI preparado, saída descrita e responsável. Guardar transições e evidências como histórico imutável com auditoria e paginação. `test_run_certify` exige principal QA humano, PBI em validação, revisão de cenário na baseline e última execução aprovada. Gate Done cruza impacto, dependências, tarefas ativas, referência de evidência e build candidato; cada cenário da baseline precisa de execução aprovada e certificação no build informado. Retornar gates e builds incompatíveis para orientar correção. Certificação automática de CI, cenários atribuídos a tarefa e exceções de dependência continuam para integração/autorização posterior.
- **SSDD-305:** validar instalação limpa do tarball produzido por `npm pack`, CLI `--version` e `init`; `npm run demo` deve criar workspace temporário, conectar cliente stdio real e concluir PO → Dev → QA → Done. Manter guia com configuração do cliente, comandos de instalação e entradas mínimas do fluxo. A tag v0.1 é criada após a validação em um commit de release versionado.

## Refinamento e decisões da Sprint 4

- **SSDD-401 (escopo original, ampliado em SSDD-801/802):** manter um time por projeto no MVP da Sprint 4. `team_capacity_set` cria ou substitui snapshot versionado de fuso, dias úteis ISO, horas por dia, pessoas humanas do projeto, dedicação, vigência, feriados e ausências; `expectedVersion=0` cria e versões vencidas falham. `team_capacity_get` recebe intervalo civil inclusivo e versão opcional do snapshot, com limite de 367 dias. Calcular `max(0, horas por dia - ausência) × dedicação / 100`, excluindo fim de semana e feriado; persistir auditoria e manter versões anteriores consultáveis. Fixtures devem cobrir dedicação parcial, ausência, feriado, membro fora de vigência, membro não autorizado e o resultado de 84 horas do aceite.
- **SSDD-402:** `definition_of_done_set/get` mantém critérios em revisões imutáveis; alterações usam `expectedVersion`. IDs gerados e versões padrão escolhidas em `sprint_draft` precisam ser estáveis em retries idempotentes. O rascunho fixa configuração de capacidade e revisão de DoD, e aceita somente PBI Ready com baseline e pontos confirmados. `sprint_scope_change` preserva cada inclusão/remoção com o snapshot do item, baseline, revisão, pontos, pessoa e motivo; edição de sprint ativa exige PO humano. `sprint_start` revalida baseline, revisão e estimativa comprometidas, calcula capacidade por pessoa/dia, bloqueia capacidade zero e limita o projeto a uma sprint ativa. `sprint_close` exige resumo de Review e aceita apenas itens Done sob os gates existentes; o snapshot congela aceitos, incompletos, DoD e capacidade da abertura. Incompletos continuam com estado, pontos e baseline disponíveis no backlog após a sprint deixar de estar ativa. Cancelamento de draft/ativa exige PO ou facilitador humano e preserva o motivo original e o histórico. Fixtures cobrem pinning de versões, drift de estimativa, retry idempotente, tentativa concorrente, versão vencida, autorização, inclusão em sprint ativa, QA → Done, cancelamento e consulta via cliente MCP real.
- **SSDD-403:** `ssdd-mcp dashboard` serve API HTTP somente em loopback, valida Host/Origin, cria sessão efêmera com token de bootstrap de uso único, cookie `HttpOnly`/`SameSite=Strict` e CSRF nas mutações. Rotas iniciais cobrem projeto, backlog, sprints e transição do item chamando os mesmos serviços de aplicação do MCP. Não aceitar principal no payload, habilitar CORS ou confiar só em controles do navegador. Teste de paridade usa projeto sem associação e verifica `FORBIDDEN` nos dois adaptadores; testes também cobrem token reutilizado, origem externa e mutação sem CSRF.
- **SSDD-404:** servir HTML, CSS e JavaScript locais no build publicado e abrir a UI direto pela URL de bootstrap; limpar o token da barra de endereço após a troca por sessão. Listar PBIs paginados, filtrar por tipo e texto e separar o escopo da sprint ativa do restante do backlog. Resumir objetivo, datas, pontos e capacidade da sprint. O detalhe mostra descrição, critérios, estimativas, pai, responsável, estado, versão e revisão. Drag and drop e botão acessível por teclado abrem o mesmo formulário de transição, com motivo obrigatório e build para Done; a API envia `expectedVersion`, `requestId` e CSRF. A camada de domínio continua decidindo permissões, transições e gates. Não atualizar o card otimisticamente. Ao receber gate, informar diagnóstico sem mover; em `VERSION_CONFLICT`, recarregar a coleção e informar a versão vigente. Cobrir assets/bootstrap e conflito HTTP em testes, verificar que o pacote inclui os arquivos estáticos e documentar limitações da primeira tela.
- **SSDD-405:** montar uma projeção QA somente a partir de critérios da baseline atual; sem baseline, identificar claramente a leitura como preview e não sugerir certificação válida. Para cada critério, listar revisões de cenário cobertas, última execução por build, certificação humana compatível e evidências do PBI. A timeline do PBI combina eventos de auditoria e transições append-only sem duplicar a mesma transição; a timeline do projeto oferece filtro por entidade, sequência paginada e cursor invalidado por mudança concorrente. A UI permite seguir do PBI ao critério/cenário/execução e à transição original com ator/motivo. Testar baseline pinned, drift, execução anterior, build certificado, isolamento, paginação e cursor obsoleto.
- **SSDD-406:** criar retrospectiva apenas para sprint fechada, exigir principal humano com papel de facilitador, controlar edição por `expectedVersion` e preservar cada revisão. Registrar resumo, práticas a manter/interromper/tentar e ações com responsável humano e PBI opcional do mesmo projeto. Expor leitura no MCP e no dashboard, com validação de autorização e conflito. Testar replay idempotente, alteração concorrente, sprint não fechada, responsável/ligação inválidos e histórico de revisões.

## Refinamento e decisões da Sprint 5

- **SSDD-501:** `milestone_create/get/list/scope_change` cria um marco por chave única no projeto, com objetivo e data alvo, e fixa PBIs de tipo história/bug que estejam Ready ou além, tenham baseline correspondente à revisão publicada atual, pontos confirmados e nenhum impacto aberto. O escopo começa com pelo menos um item. Cada entrada/saída grava evento append-only com estado, pontos, baseline, revisão, pessoa e motivo; alterações exigem PO humano e `expectedVersion`. UUID e chave legível resolvem para o mesmo PBI, aliases duplicados são recusados e nenhum evento pode ser apagado/alterado. `team_capacity_get` e o snapshot de configuração incluem `generationNumber`: uma nova geração começa em 1 e avança quando a composição, dedicação ou vigência de membros muda; calendário, fuso, feriados e ausências criam versão, sem avançar geração. Bancos anteriores à migração v16 mantêm histórico de equipe em geração 0 (histórico não conhecido); a primeira configuração após upgrade inicia a geração 1. Cobrir criação, replay, aprovação, remoção, nova inclusão, alias repetido, autorização, conflito, imutabilidade e upgrade v15.
- **SSDD-502:** projetar métricas a partir de eventos e snapshots imutáveis dentro de um snapshot SQLite de leitura, sempre com watermark de auditoria e corte temporal explícitos. O burndown parte dos compromissos congelados no início; o burnup e a série da sprint distinguem estado atual, mudança de escopo e eventos de entrega. Reabertura remove crédito de conclusão, reestimativa altera pontos sem contar entrega, remoção não conta entrega e sprint sem entregas conta velocidade zero. Segmentar velocidade por time/geração, WIP por estado/idade e cobertura por baseline/build. Testar os casos juntos em um fluxo ponta a ponta antes de expor a série ao dashboard.
- **SSDD-503 (algoritmo v1, substituído pela v2 em SSDD-803):** calcular previsão de marco por até seis sprints fechadas do mesmo time e geração, exigindo três amostras com capacidade positiva. Incluir sprints com zero entrega, calcular P25/P50/P75 por interpolação linear e não converter story points em horas. Projetar 365 dias a partir do próximo dia local, usando snapshot da sprint ativa, configurações de sprints planejadas e configuração vigente identificada como hipótese. Dependência incompleta fora do marco ou impacto aberto suprime datas; dependências internas ficam como riscos. Retornar `complete`, `incomplete_scope`, `blocked`, `insufficient_data` ou `forecast_ready`, com status por cenário para taxa zero/sem capacidade/horizonte excedido. Persistir insumos e resultado por algoritmo/data/watermark, sem mutação, e expor recálculo pela versão original. Reproduzir 24/20/18 dias úteis, geração diferente, reestimativa, bloqueio/remoção de dependência, snapshot repetido e upgrade para v17.
- **SSDD-504:** construir visões executiva e técnica somente sobre projeções auditáveis. Gráficos de burndown/burnup permitem selecionar data, marco e sprint; o drill-down lista PBIs, estados e pontos daquele corte e confere escopo/restante/concluído/cancelado contra a série. WIP mostra idade e impactos; cobertura lista PBIs com métricas de critérios; velocidade mostra pontos e horas em colunas distintas. Exibir unidades, corte, horário observado e watermark comum; indicar explicitamente corte anterior à criação do marco, ausência de dados e truncamento.
- **SSDD-505:** disponibilizar `metrics_get` pela API local e MCP sobre a mesma projeção de aplicação. Aceitar `milestoneId`, `sprintId` (UUID ou chave; `none` desativa a seleção) e `asOfDate`; omissões aplicam os mesmos padrões nas duas superfícies. Em um watermark igual, séries, cenários, snapshots, composição e totais devem coincidir. A autorização vem do mesmo serviço. Cobrir paridade por cliente MCP real + HTTP, projeto não autorizado, corte inválido e truncagem de detalhes sem perda dos totais. Manter cache efêmero de até 1 s por projeto/principal/filtros/watermark, sempre verificando autorização e watermark antes de reutilizar a cópia da projeção. O benchmark reproduzível cria 10 mil work items e 50 mil eventos, mede 12 reconstruções frias, cinco clientes em onda fria, 100 leituras concorrentes aquecidas e 100 gravações. Aceite p95 ≤ 300 ms para leituras frias/aquecidas e ≤ 500 ms para gravação simples; registrar ambiente e p50/p95. A consulta pode inserir snapshot de previsão imutável, sem alterar escopo ou gerar evento de domínio.

## Refinamento para iniciar a Sprint 6

- **SSDD-601:** adicionar `ssdd-mcp serve --workspace <path> [--port 4319]` sobre o SDK Streamable HTTP oficial, com endpoint `/mcp` e o mesmo catálogo `McpServer` registrado no stdio. Roteie a era legacy com sessão pelo transporte web do SDK e a era moderna `2026-07-28` pelo handler stateless do SDK; não implemente a classificação de protocolo no produto. O processo faz bind somente em `127.0.0.1` e usa o principal local quando OIDC não estiver configurado. Validar Host e Origin locais, sem CORS; limitar o corpo a 1 MiB; preservar JSON/SSE definido pelo SDK. Testar handshake legacy, opt-in moderno, `tools/list`, `project_list`, versão não suportada, Host/Origin inválidos, corpo excedente e sessão inexistente com cliente oficial + HTTP.
- **SSDD-602 · resource server e RBAC:** o processo MCP não emite tokens. Receber issuer OIDC e URL canônica `/mcp` explicitamente; descobrir metadata/JWKS, validar assinatura assimétrica, `iss`, `aud`, `exp`, `sub` e `nbf` quando presente, e exigir scope `ssdd:mcp`. Servir Protected Resource Metadata e desafios `401 invalid_token` / `403 insufficient_scope`. Associar o `iss+sub` validado a um principal provisionado; papéis vêm de `project_memberships`, nunca de claims do token. Administrar associações com `ssdd-mcp access grant|revoke`, executado por admin local e com auditoria. `principal_type` distingue `human`, `agent` e `service`; os gates humanos existentes devem continuar recusando agente/serviço. O bind segue loopback; uso externo requer proxy TLS.
- **SSDD-602 · aprovação vinculada:** `approval_issue` e `approval_revoke` são exclusivos de admin humano; a emissão idempotente exige executor agent/service provisionado e ferramenta mutável elegível. A aprovação fixa JSON canônico dos argumentos (SHA-256), projeto, ferramenta, `expectedVersion` explícito ou `null`, executor e prazo de 30–600 s. O ID chega em `_meta["com.ssdd-mcp/approval-id"]`. O consumo e sua auditoria rodam em `BEGIN IMMEDIATE`, junto ao handler de mutação; payload diferente, projeto, executor, ferramenta, versão, expiração, revogação, concorrência e replay são recusados sem efeito parcial. A aprovação preserva o RBAC e não elimina gates que exigem humano. ADR 0004 registra a decisão.
- **SSDD-602 · testes:** usar issuer/JWKS de fixture e tokens assinados, sem depender de tenant externo. Cobrir token ausente, assinatura/issuer/audience/expiração/scope inválidos, identidade sem provisionamento, papéis por projeto, `principal_type`, sessão legacy vinculada e as duas eras MCP. A fixture de aprovação cobre replay de emissão e consumo, expiração, concorrência, revogação, divergências de payload/projeto/executor/ferramenta/versão e rollback transacional da mutação.
- **SSDD-603:** `doctor` abre o workspace somente para leitura e informa presença, versão SQLite, journal, integridade, FKs, migrações pendentes/drift, FTS, JSON e quantidade de projetos sem incluir tokens ou chaves de identidade. `backup` usa a API online do SQLite para obter um snapshot consistente, valida integridade/FKs e grava o banco sem sobrescrever destinos; o manifesto versionado registra tamanho, SHA-256, schema e chaves dos projetos. `restore` exige banco/manifesto íntegros e `.ssdd` ausente ou vazio, migra uma cópia de staging, valida integridade/FKs e instala atomicamente sem sobrescrever conteúdo. `export --format json|markdown` é distinto do backup, limita-se aos projetos do workspace, omite tabelas operacionais internas e remove campos/valores de credenciais e chaves de identidade. Cobrir CLI e serviços, hash divergente, manifesto inválido, destino ocupado, restauração de revisão/histórico e consulta de métricas após restore, export com dados sensíveis e workspace ausente.
- **SSDD-604:** empacotar runtime Node 24 em imagem multi-stage, instalar somente dependências de produção e executar como usuário sem privilégios. Manter SQLite em `/data` com volume nomeado; não publicar MCP stdio como porta de rede. `npm pack` deve instalar em prefixo vazio e completar `--version`, `init` e `doctor`. Smoke test Linux cria projeto em volume nomeado, encerra o container e confirma o projeto por uma nova instância. Registrar o caminho local e as exigências do deployment compartilhado.
- **SSDD-605:** executar trilha com issuer/JWKS local e ao menos dois clientes MCP OIDC com papéis diferentes. PO cria e prepara o PBI, Developer implementa e associa build, QA publica cenário e certifica execução, Developer conclui com gates aprovados. A API/dashboard deve mostrar o mesmo PBI concluído e a baseline; verificar negação de autorização. `npm run demo:release` deve ser reprodutível sem tenant externo. Atualizar guia de release/backup/restore/instalação; a tag v0.2.0 fica para depois do aceite, nunca antes da validação da matriz CI, da imagem e da release.
