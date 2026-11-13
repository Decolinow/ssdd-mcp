# Roadmap de implementação

Planejamento inicial em sprints de duas semanas. Pontos Fibonacci representam complexidade relativa do trabalho técnico, não compromisso de prazo. São propostas para refinamento, com referência de 3 pontos para uma operação vertical simples com validação e teste. As oito sprints formam uma ordem de trabalho, sem datas de calendário. Uma sprint piloto solo já calculou 60 horas configuradas em dez dias úteis, mas não existe ainda uma amostra de produção para estimar velocidade; consulte [docs/solo-simulation.md](docs/solo-simulation.md). IDs são estáveis para issues e referências de implementação. Cada linha é uma unidade implementável com verificação específica. A execução atual fica registrada em [docs/status.md](docs/status.md); aceite e status precisam ser atualizados junto com cada entrega.

| Épico | Features | Marco |
|---|---|---|
| E1 · Plataforma (P2 · 82/100) | Runtime local, persistência, identidade, auditoria, operação | v0.1 local |
| E2 · Especificação executável (P1 · 96/100) | Backlog, revisões, rastreabilidade, contexto, QA e gates | v0.1 local |
| E3 · Scrum e dashboard (P2 · 86/100) | Sprint, board, qualidade, capacidade e previsão | v0.2 equipe |
| E4 · Compartilhamento e distribuição (P2 · 91/100) | Servidor HTTP, autenticação, backups, pacote e documentação | v0.2 equipe |

## Como navegar

| Procure | Seção |
|---|---|
| Ordem e valor das Features | [Ordem inicial de Features](#ordem-inicial-de-features-por-prioridade-e-valor) |
| Sprints 1–8, concluídas localmente | `## Sprint N` abaixo; decisões detalhadas em [docs/roadmap-refinements.md](docs/roadmap-refinements.md) |
| **Backlog ativo** (não concluído) | Habilitação de agentes, instalador, dashboard operacional, melhorias do MCP, governança enterprise e [propostas de qualidade](#propostas-de-fidelidade-de-entrega-e-qualidade-2026-11-12) |
| Estado atual e evidência por tarefa | [docs/status.md](docs/status.md); histórico em [docs/changelog.md](docs/changelog.md) |

## Ordem inicial de Features por prioridade e valor

Avaliação PO registrada em 2026-11-12. O score usa cinco dimensões qualitativas de 0–20 (impacto, risco, alinhamento, habilitação/reuso e urgência); é uma hipótese inicial baseada no escopo e nos critérios deste roadmap, não uma medição de clientes ou receita. O PO deve revisar os valores quando houver evidência nova. Prioridade é independente do score: P1 vem antes de P2. A fila de tarefas aplica os mesmos campos com dependências, readiness, atribuição e gates de início.

| Ordem | Feature | Prioridade | Valor de negócio | Foco |
|---:|---|---|---:|---|
| 1 | SSDD-12 · Backlog e especificação versionada | P1 | 98 | Regras, decisões e tarefas rastreáveis |
| 2 | SSDD-20 · Dev, QA e release local | P1 | 96 | Entrega verificável e segura |
| 3 | SSDD-101 · Melhorias do MCP e governança enterprise | P1 | 95 | Governança, proteção e colaboração de agentes |
| 4 | SSDD-42 · Servidor compartilhado e release | P1 | 92 | Uso autenticado por equipes no mesmo host |
| 5 | SSDD-85 · Operação completa pelo dashboard | P1 | 90 | Gestão operacional pela interface |
| 6 | SSDD-61 · Habilitação de agentes | P2 | 91 | Contexto e ferramentas por etapa |
| 7 | SSDD-5 · Fundação local | P2 | 88 | Runtime e persistência |
| 8 | SSDD-35 · Métricas e previsão | P2 | 86 | Analytics com limitações explícitas |
| 9 | SSDD-27 · Scrum, board e capacidade | P2 | 80 | Planejamento e fluxo de time |
| 10 | SSDD-56 · Times e previsão probabilística | P2 | 78 | Planejamento com amostra representativa |
| 11 | SSDD-80 · Conformidade do instalador | P2 | 74 | Validação de instalação |
| 12 | SSDD-67 · Instalador local | P2 | 72 | Adoção em repositórios |
| 13 | SSDD-71 · Adaptadores Claude/Codex/OpenCode | P2 | 70 | Integração nos clientes de código |
| 14 | SSDD-49 · Interoperabilidade externa | P2 | 64 | Importações e referências externas |

Esta sequência ordena o roadmap por prioridade, depois valor de negócio e rank. Sprints concretas ainda dependem de readiness, dependências, capacidade, escopo PO e estimativas confirmadas; as oito sprints abaixo são o plano base. O dashboard mostra progresso/pontos por Feature e simula janelas sequenciais. Como há somente uma sprint fechada comparável, a timeline não apresenta datas P25/P50/P75 até acumular pelo menos três sprints da mesma geração.

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
| SSDD-504 | Implementar dashboard executivo e técnico com drill-down | 5 | 404, 503 | Gráficos de burnup/burndown oferecem corte por data, marco e sprint; a lista de PBIs no corte reconcilia os totais e a tela indica unidade, observação e watermark. Complemento de análise registrado em 2026-11-11: janela de velocidade 4/8/12, comparação da sprint selecionada com a mediana das anteriores da mesma geração, filtro de esforço por pessoa/período local e aviso de que WIP/cobertura são atuais, não históricos. |
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

- O modelo operacional é uma instância SSDD compartilhada por vários clientes no mesmo host, usando SQLite local. Multi-instância/HA está fora do escopo atual; se uma necessidade de produto mudar essa decisão, abra novo refinamento com limites de concorrência e recuperação mensurados.
- Busca semântica só entra em sprint quando consultas representativas mostrarem lacunas do FTS5; qualquer resultado precisa trazer proveniência e preservar autorização por projeto.

## Backlog de habilitação de agentes

Entrega transversal ao roadmap. A hierarquia histórica fica Épico E4 → Feature de habilitação → história de fluxo guiado → task. A extensão local para os clientes de codificação está refinada no backlog seguinte.

| ID | Tarefa | Pontos | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-901 | Publicar prompts MCP e skills de agente por papel | 5 | 105, 303, 304 | Entrega inicial: clientes stdio e Streamable HTTP listam seis prompts e cinco skills com digest; instruções seguem contexto, gates humanos e proibição de fabricar evidências. A evolução para oito prompts, dez skills/agentes e catálogos filtrados é SSDD-920. |

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

- As cinco skills canônicas originais são copiadas com conteúdo e digest íntegros para `.claude/skills/<id>/SKILL.md`, `.agents/skills/<id>/SKILL.md` e `.opencode/skills/<id>/SKILL.md`, usando os caminhos nativos e compartilhados documentados pelos clientes.
- Claude recebe cinco arquivos `.claude/agents/*.md`, Codex recebe cinco `.codex/agents/*.toml` e OpenCode recebe cinco `.opencode/agents/*.md`. SSDD-920 adiciona cinco novos agentes usando o mesmo instalador.
- Cada perfil orienta a skill da mesma função e preserva os gates humanos, sem impor modelo, segredo ou permissão excessiva.
- Colisões de caminho, IDs duplicados, frontmatter inválido e arquivos locais modificados são relatados antes da escrita.

| ID | Tarefa | Horas | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-77 | Copiar skills canônicas para os diretórios nativos | 5 | SSDD-69 | Frontmatter e IDs são validados; cópias em `.claude/skills`, `.agents/skills` e `.opencode/skills` correspondem à origem e obedecem ao manifesto de hashes. |
| SSDD-78 | Gerar agentes nativos de Claude Code e Codex | 5 | SSDD-77 | Cinco agentes de cada cliente usam formato nativo, instruções do papel e referência à skill correspondente, sem modelo fixo. |
| SSDD-79 | Gerar agentes nativos de OpenCode | 4 | SSDD-77 | Cinco perfis Markdown têm frontmatter V2 válido, descrição e modo de subagente, sem modelo fixo. |

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

## Backlog do dashboard operacional

O dashboard já oferece métricas, consultas, transições de estado, retrospectivas e auditoria. Esta feature fecha a lacuna entre a interface e as operações de domínio disponíveis ao agente MCP, sempre usando os mesmos serviços de aplicação, autorização por papel, controle otimista de versão, idempotência e auditoria. As histórias continuam Draft até refinamento/aceite formal; os itens abaixo não iniciam uma sprint.

### SSDD-85 · Operação completa pelo dashboard

Levar ao dashboard os fluxos de cadastro, revisão, qualidade, planejamento e acompanhamento que hoje exigem um cliente MCP.

#### SSDD-86 · Criar e editar itens do backlog pela interface (8 pontos)

**História:** Como pessoa do projeto, quero cadastrar e revisar PBIs pelo dashboard sem perder histórico, critérios, autoria ou gates de publicação.

**Critérios de aceite:**

- Criar história e bug com pai válido, descrição, prioridade e critérios; erros de papel, pai e versão aparecem sem mutação parcial.
- Editar conteúdo propõe snapshot imutável e publicar exige papel humano PO; itens atuais e revisões históricas são exibidos claramente.
- Ações de atribuir, estimar, comentar, reordenar e criar/remover vínculos usam os mesmos comandos MCP e deixam auditoria consultável.
- CSRF, idempotência, conflitos de versão e autorização têm testes HTTP negativos e positivos.

| ID | Tarefa | Horas | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-87 | Expor criação e revisões de work item pela API local | 8 | — | POSTs validam payload e sessão/CSRF e chamam create/propose/publish do serviço de aplicação com requestId e expectedVersion; testes verificam auditoria, idempotência e papéis. |
| SSDD-88 | Criar formulários acessíveis de cadastro e edição de PBI | 8 | SSDD-87 | Fluxo permite escolher pai, tipo, prioridade e critérios; revisão proposta distingue rascunho de conteúdo publicado e atualiza detalhes após sucesso. |
| SSDD-89 | Disponibilizar operações de backlog restantes pela interface | 12 | SSDD-88 | Atribuição, comentários, estimativas, ordenação e trace links executam operações MCP equivalentes com papéis, versões, motivo e erros tratados. |

#### SSDD-90 · Gerenciar cenários e execuções de QA pelo dashboard (8 pontos)

**História:** Como QA ou Developer autorizado, quero criar e publicar cenários e registrar execuções na revisão exata para que cobertura e evidência sejam rastreáveis pela interface.

**Critérios de aceite:**

- Cenários podem ser listados, consultados, criados, revisados e publicados pela mesma regra de QA humano aplicada pelo MCP.
- Cada execução referencia uma revisão publicada específica, build, resultado, notas e evidência; revisão rascunho não pode receber execução.
- A interface exibe histórico imutável de execuções por cenário/revisão/build e deixa certificação compatível com baseline explícita.
- Cobertura e resultados têm gráfico legível, tabela equivalente e testes para CSRF, autorização, vínculo de revisão e estados inválidos.

| ID | Tarefa | Horas | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-91 | Expor listagem, criação, revisão e publicação de cenários | 8 | — | Rotas usam scenario-queries/commands; filtros, cobertura, controle de versão, idempotência, papel QA, CSRF e publicação humana são cobertos por testes. |
| SSDD-92 | Registrar execução vinculada à revisão publicada e consultar histórico | 8 | SSDD-91 | UI exige cenário, revisão publicada, build e resultado; API persiste notes/evidenceUri e testes comprovam que cenário, revisão e run retornam associados sem permitir rascunho. |
| SSDD-93 | Mostrar histórico QA e certificar execução compatível com baseline | 6 | SSDD-92 | Detalhe mostra execuções por build/revisão; certificação chama o gate MCP existente e explica divergências, run antigo, resultado reprovado ou baseline incompatível. |

#### SSDD-94 · Explorar qualidade e fluxo com gráficos interativos (5 pontos)

**História:** Como pessoa do projeto, quero comparar cobertura e resultados de QA no tempo e abrir os registros que compõem os gráficos.

**Critérios de aceite:**

- Gráfico de execuções separa passed, failed, blocked e skipped no intervalo selecionado e permite abrir os runs de cada grupo.
- Gráfico de cobertura distingue critérios cobertos, descobertos, execução atual e baseline desatualizada; cores têm rótulos/tabela acessíveis.
- Filtros de build, período, cenário e PBI são aplicados pelo serviço de consulta, com estado vazio e watermark visíveis.

| ID | Tarefa | Horas | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-95 | Implementar gráfico de resultados QA com tabela acessível | 6 | SSDD-92 | Série agregada e drill-down reconciliam com as execuções filtradas, incluem estados sem dados e funcionam por teclado e leitor de tela. |
| SSDD-96 | Implementar gráfico de cobertura com filtros e drill-down | 8 | SSDD-95 | Cobertura respeita baseline e revisão; abrir um segmento apresenta critérios, cenários e execuções que formam o total. |

#### SSDD-97 · Completar operações de planejamento e especificação no dashboard (13 pontos)

**História:** Como PO, Developer ou facilitador, quero preparar e consultar regras, marcos, times, capacidade e sprints sem trocar de cliente, respeitando cada gate humano.

**Critérios de aceite:**

- Especificações, revisões, rastreabilidade, baseline, impactos e revalidações podem ser consultados e alterados somente pelos papéis autorizados.
- Times, calendário, capacidade, Definition of Done, marcos, escopo de sprint, abertura, encerramento e retrospectiva seguem os comandos MCP existentes.
- Métricas, previsão, board, atividade e operações de planejamento compartilham filtros e resultados com o MCP, verificados por testes de contrato.
- Uma matriz inventaria todas as ferramentas MCP de consulta e mutação, mapeando UI disponível ou tarefa explícita de paridade futura.

| ID | Tarefa | Horas | Depende de | Aceite |
|---|---|---:|---|---|
| SSDD-98 | Gerenciar especificações, ADRs, revisões e rastreabilidade | 16 | SSDD-87 | UI pesquisa e consulta regras/ADRs, cadastra Draft, propõe/publica revisões e vincula tarefa a ADR com relação explícita; impactos e snapshots imutáveis preservam autorização, auditoria e gate humano de publicação. |
| SSDD-99 | Gerenciar times, capacidade, DoD, marcos e ciclo de sprint | 16 | SSDD-98 | Formulários aplicam filtros explícitos de time, snapshots, versão e confirmação humana; fixtures cobrem conflitos, gates e paridade MCP. |
| SSDD-100 | Completar matriz de paridade MCP e validar o dashboard integrado | 10 | SSDD-89, SSDD-93, SSDD-96, SSDD-99 | Toda ferramenta MCP registrada é mapeada para leitura/ação de UI ou lacuna deliberada; testes de integração cobrem fluxos críticos e documentação explica o caminho equivalente. |

## Definition of Done da implementação

Uma tarefa tem aceite verificável, migração reversível via backup/restore quando aplicável, teste no caminho normal, autorização e documentação do contrato alterado. Uma sprint entrega o fluxo da meta em fixture reproduzível. Release inclui notas de compatibilidade do protocolo, upgrade e instalação. Features que alteram o histórico têm fixture de regressão com base criada em versão anterior.

## Auditoria e próximas melhorias do MCP

Backlog técnico sem sprint comprometida, refinado após comparação entre serviços de aplicação, ferramentas MCP, dashboard, prompts e skills. O histórico de QA, relatório detalhado de qualidade e reprodução de forecast já foram adicionados nesta revisão. As tarefas seguintes tratam lacunas remanescentes e evitam ampliar o catálogo sem paginação, benchmark ou contrato verificável.

| ID | Tarefa | Pontos | Depende de | Estado | Aceite |
|---|---|---:|---|---|---|
| SSDD-902 | Reconciliar IDs estáveis do roadmap com chaves geradas pelo MCP | 3 | 105, 901 | Implementada localmente; sincronizada ao MCP | O importador mantém mapeamento imutável entre ID estável, UUID e chave MCP em SQLite e `.ssdd/roadmap-id-map.json`; repetição valida identidade sem recriar tarefas. IDs estáveis resolvem corretamente quando a grafia colide com uma chave gerada; UUID endereça a chave ambígua. |
| SSDD-903 | Expor timeline de auditoria paginada para agentes | 3 | 602, 603 | Concluída localmente; aceite formal no MCP (SSDD-104) | Tool read-only aplica autorização do projeto, filtros de entidade, limite e cursor por watermark; testes provam que principal/filtros inválidos falham, mutação concorrente invalida cursor e payloads não autorizados não são retornados. |
| SSDD-904 | Paginar listas de cenários, especificações e resumos de qualidade | 5 | 202, 203, 301 | Implementada localmente nesta revisão; revisão 2 proposta no MCP, permanece Draft | MCP e API retornam páginas de 1–100 resumos (padrão 25), com ordenação estável por chave/UUID, cursor vinculado a projeto, principal, filtro e limite, e watermark auditado; filtros incompatíveis falham, mudança concorrente retorna `STALE_CURSOR`, e o dashboard percorre páginas e reinicia em caso de cursor obsoleto. Testes de serviço cobrem 0, 1, 100 e 101 registros; testes MCP/HTTP cobrem consulta e continuação de cursor. A publicação da revisão 2 exige aceite humano PO. |
| SSDD-905 | Medir e reduzir consultas repetidas no relatório de qualidade | 5 | 301, 405 | Concluído localmente (2026-11-12); sincronizada ao MCP | Fixture representativa cobre até 50 critérios, múltiplos cenários/revisões/builds e histórico. Benchmark registra p50/p95 e quantidade de consultas; eventual consulta em lote preserva resultados de preview/pinned, baseline, última execução por build, certificações e evidências, com teste de equivalência e ganho medido. |
| SSDD-906 | Manter matriz de paridade entre serviços, tools MCP e agentes | 3 | 902 | Parcial nesta revisão; sincronizada ao MCP | Inventário automatizado compara handlers e schemas dos dois transports com documentação; cada operação registra autorização, mutabilidade/aprovação, paginação, prompt/skill consumidora e alternativa deliberada. Mudança do catálogo sem contrato ou teste falha no check. |
| SSDD-907 | Expor histórico QA, qualidade detalhada e reprodução de forecast no MCP | 5 | 301, 405, 803 | Implementada localmente; sincronizada ao MCP | `test_run_list` filtra e pagina por cursor keyset; `work_item_quality_get` expõe a projeção usada pelo dashboard; `milestone_forecast_history/recalculate` consultam snapshots sem gravar. Clientes stdio e Streamable HTTP listam as tools; teste MCP percorre os contratos e o fluxo QA/forecast. |

**Reconciliação de IDs resolvida:** `roadmap_id_bind/resolve/list` persiste por projeto a associação imutável `SSDD-### → UUID/chave MCP`; o script valida o mapa antes/depois do sync e grava uma cópia local em `.ssdd/roadmap-id-map.json`. Referências pelo `SSDD-###` priorizam o alias estável mapeado. Se essa string também for chave gerada de outro item, use o UUID para essa chave. A migração v26 preserva as chaves e work items existentes.

## Implantação de equipe, execução e governança enterprise

Esta evolução separa capacidades implementadas das lacunas de operação. Uma instância atende vários clientes/projetos por Streamable HTTP com OIDC e RBAC por projeto; o armazenamento continua em SQLite local em um único host. Sessões de execução, eventos de homologação/produção e calibração básica por horas já existem. `in_validation` e `done` continuam distintos de um deployment observado.

| ID | Tarefa | Pontos | Depende de | Estado | Aceite |
|---|---|---:|---|---|---|
| SSDD-908 | Adicionar agente e prompt de refinamento técnico | 3 | 901 | Implementada localmente; sincronizada ao MCP | `ssdd-technical-lead` e `ssdd_refine_technical_design` cobrem decomposição, segurança, transações, migração, testes e vínculo `implements`; clientes MCP e instalador listam a nova skill/prompt e têm teste de contrato. |
| SSDD-909 | Documentar servidor Streamable HTTP para equipes e criar probes locais | 5 | 601, 602, 603 | Implementada localmente; sincronizada ao MCP | Runbook reproduzível cobre OIDC, proxy TLS, vários projetos, seleção por `projectId`, backup, serviço Linux, encerramento gracioso, probes e limites single-host; `/healthz` e `/readyz` têm contratos mínimos, teste HTTP e não são roteados publicamente. |
| SSDD-910 | Registrar sessões de execução e timestamps de desenvolvimento | 8 | 105, 601, 902 | Implementada localmente; sincronizada ao MCP; recuperação após queda abrupta pendente | Sessões guardam tarefa, Developer autenticado e ID de domínio; start/pause/resume/complete/cancel são auditados, idempotentes e versionados. Datas são UTC, revisões técnicas/cenários ficam fixadas e reatribuição preserva autoria. A sessão ativa não fecha automaticamente após queda abrupta e exige revisão humana; não alegar precisão automática de tempo offline. |
| SSDD-911 | Registrar eventos de homologação e produção | 8 | 603, 910 | Implementada localmente; sincronizada ao MCP | Eventos append-only registram ambiente/build/ator/data/resultado/rollback e vínculos a tarefas, PBIs e milestones. Datas do último sucesso por ambiente aparecem no detalhe; produção exige mesmo build homologado, Done, autorização e teste MCP/API. |
| SSDD-912 | Calibrar estimativas e velocidade por desenvolvedor sem misturar unidades | 8 | 803, 910, 911 | Parcial; calibração de horas implementada localmente; ciclo estimado permanece pendente; sincronizada ao MCP | Forecast de time continua em story points. Painel individual mostra horas ativas, tarefas concluídas, estimativa versus execução, variação e fator `real/estimado` após cinco tarefas, divide tarefas colaborativas por esforço e não cria ranking. Tempo de ciclo e intervalos de previsão individual ainda não foram implementados. |
| SSDD-913 | Fixar relação entre tarefas, revisões técnicas e cenários de teste | 5 | 202, 203, 301, 902 | Implementada localmente; sincronizada ao MCP | `implements` direto da tarefa e cenários/runs ligados por UUID ficam no contexto; sessão fixa revisões técnicas e de cenário ao início, diferencia herança/vínculo direto e alerta drift. Gates opcionais continuam configuráveis pelo vínculo existente. |
| SSDD-914 | Avaliar persistência e alta disponibilidade multi-instância | 5 | 601, 603, 909 | Fora de escopo; cancelada por decisão de produto em 2026-11-11 | O produto seguirá com uma instância SSDD compartilhada entre clientes no mesmo host. Preservar o item e seu ID estável no histórico sem planejar backend multi-instância/HA. Uma necessidade futura exige novo refinamento. |
| SSDD-915 | Completar observabilidade e políticas operacionais do servidor | 5 | 909 | Pendente; sincronizada ao MCP | Logs estruturados sem conteúdo/token, correlação, duração/código; métricas com cardinalidade limitada, export opt-in, rate limits, retenção e runbook de alertas ainda aguardam implementação e testes. |
| SSDD-916 | Consultar retrato histórico do projeto por data | 8 | 405, 910, 911, 913 | Implementada localmente; validada na suíte atual; sincronizada ao MCP | Dashboard e API autenticada reconstroem o fim do dia no fuso escolhido usando revisões, transições, escopos e eventos imutáveis. Totais cobrem o projeto; itens paginam por cursor vinculado ao watermark/captura e listas limitadas informam truncamento. Testes verificam autorização, data inválida/futura, mudança de estado, QA, corte/fuso/DST, paginação e migração. A UI limita a data à vida do projeto, explicita campos sem histórico temporal e nunca apresenta valores correntes como passado. |

| SSDD-917 | Autenticar usuários MCP e propagar autoria por tarefa | 5 | 104, 602 | Implementada e testada localmente; sincronizada ao MCP; item Draft | O primeiro host cria um administrador singleton e entrega uma authKey uma vez; admin pode criar/listar usuários com memberships por projeto, rotacionar/revogar chaves; banco e auditoria nunca guardam segredo; bearer/OIDC/stdio propagam o principal para autorização, atribuição, sessões, execuções e auditoria. |
| SSDD-918 | Filtrar tools por perfil e consultar tarefas atribuídas ao usuário | 3 | 913, 917 | Implementada e testada localmente; sincronizada ao MCP; item Draft | `full`, `dev`, `qa`, `tech_lead`, `po`, `facilitator`, `release` e `admin` filtram `tools/list` por conexão HTTP/stdio; perfil não concede autorização; `assignedToMe` filtra páginas pelo principal autenticado e vincula cursor a principal/filtros. |
| SSDD-919 | Pesquisar tarefas por similaridade semântica | 5 | 905, 917 | Implementada e testada localmente; sincronizada ao MCP; item Draft | Provedor de embeddings é opcional e desligado por padrão; indexação paginada particiona vetor por projeto/modelo/conteúdo, detecta mudanças, limita batch/cursor/resposta a 8 MiB; busca autorizada retorna similaridade e completude com limite claro de escala e informa o conteúdo enviado ao provedor. |
| SSDD-920 | Curar tools, prompts, skills e agentes por etapa da fábrica | 5 | 901, 908, 918 | Implementada localmente nesta revisão | Perfis de refinamento, especificação, Dev, desenho de testes, QA, Tech Lead, segurança read-only, PO, facilitação, release, DevOps e admin expõem conjuntos próprios, sem herdar leitura global; dez skills canônicas geram agentes; apenas o bootstrap admin recebe a skill de administração. PO propõe escopo de sprint; facilitação administra calendário, DoD e ciclo operacional. Perfil continua separado do RBAC. |
| SSDD-921 | Reduzir consultas e memória da busca semântica | 5 | 919 | Implementada localmente nesta revisão | Cache é lido com join; a verificação pós-embedding consulta lotes em transação; a busca filtra no SQL, itera vetores e mantém top-K ordenado por inserção binária; detalhes completos vêm apenas para o limite retornado. A contagem recusa projetos acima de 10.000 antes de qualquer chamada externa; vetores limitam-se a 8.192 dimensões e testes cobrem filtro, integridade, ranking determinístico, cache e limite. |
| SSDD-922 | Automatizar paridade e limites dos catálogos de perfil | 3 | 918, 920, 921 | Implementada localmente nesta revisão | Teste compara nomes registrados de tools à união dos perfis curados, valida prompts/skills por etapa, superfície read-only de segurança e orçamento por perfil; clientes stdio e HTTP validam os catálogos completos e reduzidos. |
| SSDD-923 | Medir custo e latência da busca semântica | 3 | 921 | Pendente; sincronizada ao MCP | Benchmark reprodutível usa provedor determinístico e workspaces temporários com 1.000, 5.000 e 10.000 itens; mede tempo de indexação, p50/p95 de buscas fria/aquecida, dimensão do vetor, consultas e tamanho do banco. Mede também a rejeição antes de rede acima do limite; baseline publicada define SLOs de CPU, memória e duração sem depender de credencial externa. |
| SSDD-924 | Exibir chaves e títulos legíveis na atividade auditada | 2 | 405 | Implementada e testada localmente; SSDD-126 no MCP continua Draft aguardando gate do pai | Linhas de atividade identificam chave/título de PBI, especificação, cenário, sprint, marco e execução; relações mostram os dois endpoints e o tipo. Mantêm identificadores estáveis, tipo/UUID como fallback, filtros, cursores e watermark. Testes cobrem PBI, especificação, cenário, execução e relação de rastreabilidade. A sessão MCP exige pai Ready com baseline e Developer atribuído. |
| SSDD-925 | Refinar a rastreabilidade e cobertura QA do backlog ativo | 8 | 913, 906 | Draft; registrada após auditoria via MCP | Revisar cada tarefa não cancelada e ligar apenas especificações aplicáveis ou justificar a não aplicabilidade. Para PBIs candidatos a Ready, cada critério obrigatório deve apontar para cenário publicado e run/build/certificação compatíveis com a baseline. Contextos MCP devem mostrar proveniência, warnings e paginação sem promover testes automatizados a certificação humana. |
| SSDD-926 | Validar gates e iniciar tarefa atomicamente | 5 | 910, 913 | Implementada localmente nesta revisão; sincronizada ao MCP como Draft | `task_start_check` diagnostica estado, Developer/atribuição, PBI pai/baseline, pré-requisitos, ADR `implements` publicado e sessão aberta. `task_start` revalida tudo sob transação imediata, move Ready para `in_progress` e abre sessão na mesma transação; falhas não deixam transição parcial. Sessão pausada de outro Developer bloqueia handoff até encerramento/cancelamento; idempotência e conflitos de versão têm teste MCP/aplicação. |
| SSDD-927 | Cadastrar, pesquisar e vincular ADRs às tarefas | 5 | 203, 913 | Implementada localmente nesta revisão; sincronizada ao MCP como Draft | Tools curadas permitem criar ADR Draft, pesquisar por chave/título/conteúdo atual e vincular tarefa por `implements` ou `relates_to`; busca pagina por cursor/watermark em memória limitada a `limit+1`. Draft nunca é apresentada como decisão aprovada; publicar continua gate humano Tech Lead e a revisão publicada fica pinada na sessão. |
| SSDD-928 | Recuperar sessões de desenvolvimento abandonadas com trilha auditada | 3 | 910, 917 | Pendente; tarefa registrada no MCP como Draft | Admin/Tech Lead autorizado pode investigar sessão órfã com idade/heartbeat configuráveis, apresentar identidade, tarefa, último evento e tempo não confiável, e encerrar/cancelar somente após motivo e ação auditada. Operação preserva autoria e duração observada, nunca inventa tempo offline, não altera sessão de outra tarefa e exige confirmação humana idempotente. |
| SSDD-929 | Coordenar worktrees e reservas de arquivos entre agentes paralelos | 8 | 910, 918 | Pendente; tarefa registrada no MCP como Draft | Agentes usam worktree/branch isolados por tarefa quando disponível e registram claims de caminhos relativos ao repositório. Claims usam lease/heartbeat/expiração, detectam sobreposição de arquivo/diretório no mesmo projeto, bloqueiam ou pedem arbitragem humana com conflito explícito, e têm renovação/liberação idempotente auditada. Não tratar locks do MCP como enforcement do Git; ferramentas e skills exigem conferir branch/worktree/diff e não sobrescrever edição alheia. |
| SSDD-930 | Analisar tempo de ciclo, espera, bloqueios e caminho crítico | 8 | 912, 915 | Pendente; tarefa registrada no MCP como Draft | Métricas por sprint/período/Developer derivam transições, sessões, dependências e eventos de bloqueio com watermark/corte; distinguem lead/cycle/wait time, idade de WIP e blocked time. Itens abertos aparecem como amostra censurada; caminho crítico só é calculado para DAG conhecido e estimativas comparáveis. Expor mediana/percentis/amostra e limitações, separar pontos de horas e não criar ranking individual. |
| SSDD-931 | Especificar workflows versionados e ponderados por tarefa | 8 | 913, 927 | Implementada localmente; ADR e regra de domínio registradas no MCP como Draft | Cada tarefa pode ter 1–50 etapas ordenadas com instruções verificáveis e pesos de até duas casas decimais cuja soma é 100,00%. Revisões são imutáveis; só Tech Lead humano publica sem sessões abertas. Alteração de definição reinicia progresso; reordenação que viole a sequência reinicia etapas posteriores incompatíveis. Sem workflow, progresso é desconhecido e gates legados seguem ativos. |
| SSDD-932 | Calcular progresso ponderado e aplicar gates de conclusão | 5 | 931, 926 | Implementada localmente; sincronizada ao MCP como Draft | Percentual é a soma do peso das etapas Done; etapa em andamento não adiciona percentual. Developer atribuído precisa de sessão ativa pinada à revisão publicada; etapas avançam em ordem e correções de conclusão reabrem de trás para frente. Done exige todas as etapas completas, mas nunca substitui QA, evidência, baseline ou aceite humano. |
| SSDD-933 | Integrar workflows ponderados ao MCP, dashboard e agentes | 8 | 931, 932, 920, 922 | Implementada localmente; sincronizada ao MCP como Draft | Quatro tools tipadas permitem consultar histórico, propor, publicar e atualizar etapas por perfil. Dashboard mostra progresso no detalhe de tarefa e lista de tarefas filhas, permite editar/publicar com CSRF, seleção histórica e controles acessíveis. Prompts, skills e os agentes Claude Code, Codex e OpenCode ensinam o fluxo e os limites do percentual. |
| SSDD-934 | Ordenar trabalho por prioridade e valor de negócio | 5 | 933 | Implementada localmente; regras e avaliações PO publicadas no MCP; work item permanece Draft | Prioridade P1–P4 e valor PO 0–100 com justificativa funcionam em épicos, Features e tarefas. Tarefas herdam o score mais específico e podem receber override. A fila só recomenda tarefas liberadas por readiness, dependências, atribuição e gates; revisão publicada preserva histórico. |
| SSDD-935 | Exibir roadmap gráfico e timeline de conclusão por Feature | 5 | 934, 803, 933 | Implementada localmente; previsão de datas indisponível com uma sprint comparável | Dashboard e MCP compartilham Feature roadmap ordenado por prioridade/valor; progresso usa pontos confirmados, mostra escopo sem estimativa e bloqueios. Timeline sequencial só projeta datas com três sprints comparáveis, estimativas e dependências válidas. |
| SSDD-936 | Revisar especificações e curar a prioridade inicial do roadmap | 3 | 934, 935 | Catálogo curado e revisões válidas publicadas; execução QA e backlog continuam em seus gates próprios | Reconciliar decisões publicadas com código/documentação, retirar proposta Draft obsoleta com justificativa, ligar specs às tarefas e publicar definições de cenário após revisão QA. Execução/certificação exigem build/evidência próprios; itens de backlog ainda sem refinamento continuam Draft. |
| SSDD-937 | Transformar a página inicial em acesso rápido por papel | 5 | 926, 934, 935 | Implementada localmente; sincronizada ao MCP como Draft (`SSDD-140`) | Abrir diretamente na fila do papel selecionado entre os papéis concedidos; exibir tarefas atribuídas, validações/refinamentos pendentes e atalhos relevantes. Developer pode assumir somente tarefa Ready sem responsável cujos demais gates passaram; claim é idempotente, versionado, auditado e não abre sessão. Bloqueios e conflitos devem ser acionáveis e não retryable automaticamente. A escolha de visão não concede autorização. |

### SSDD-908 · Refinamento técnico como função explícita

Já existem o refinamento de backlog do PO e prompts de planning, início de desenvolvimento, QA e release. Não havia um papel dedicado de Technical Lead. A implementação local adiciona uma skill e prompt próprios; ambos propõem o desenho e o grafo de tarefas sem publicar decisões ou gravar work items por conta própria. O prompt instrui `trace_link_add` na direção `work item → specification` e exige validar o resultado em `task_context_get`.

### SSDD-909 · Operação remota e seleção de projeto

O runbook em [docs/team-server.md](docs/team-server.md) documenta o comando `serve`, proxy de referência, OIDC, grants por projeto, probes locais e topologia suportada. A seleção ocorre no cliente: `project_list → escolha humana → projectId enviado a cada tool`. Não existe projeto ativo global, para evitar cruzamento entre clientes concorrentes. As probes locais foram implementadas porque o servidor ainda não tinha um endpoint de liveness/readiness.

### SSDD-910–913 · Datas e produtividade baseadas em evidência

- A sessão de desenvolvimento é um agregado do domínio, não o `Mcp-Session-Id`: clientes podem reconectar e uma tarefa pode ter sessões de mais de uma pessoa. O servidor deriva o ator autenticado, persiste horário UTC e emite UUID próprio; referência externa é opcional e não deve conter tokens ou conteúdo privado.
- O início é registrado pelo primeiro start válido; pausas, retomada e conclusão acumulam tempo ativo e preservam autoria após reatribuição. Datas de início/fim são projeções das sessões, não campos editáveis retroativamente. Limitação atual: queda abrupta não fecha a sessão automaticamente; a equipe deve revisar sessões ativas ao recuperar o serviço. Recuperação por lease/heartbeat permanece pendente.
- Homologação e produção são deployments, não estados de tarefa. Cada evento liga ambiente, build imutável, pipeline, executor, timestamp, resultado e rollback. Datas de aprovação por ambiente no item derivam de eventos bem-sucedidos e coexistem com novo deploy ou rollback.
- Velocidade de equipe continua em story points por sprint. A visão de Developer usa horas ativas, tarefas concluídas, estimativa versus execução e fator de calibração após amostra mínima; tarefas colaborativas distribuem esforço. Não pontuar pessoas com story points nem usar a métrica isolada para avaliação de desempenho. Forecast/cycle time individual permanece pendente.
- Forecast individual deve ser opt-in por papel/configuração e agregado por intervalo, nunca buscar sessões/conversas privadas. Definir retenção, visibilidade e auditoria de acesso antes de publicar a métrica.

### SSDD-916 · Retrato histórico do projeto

O dashboard expõe uma aba somente leitura que recebe `asOfDate` no fuso do projeto, fecha o corte ao fim do dia e informa o watermark histórico e da fonte. Reconstitui itens/revisões, especificações/cenários publicados, execuções QA, sessões, deployments, estados de sprint, escopo de sprint/marco e atividade. Sessões ainda abertas acumulam até o instante da consulta. A lista de itens usa cursor opaco vinculado ao watermark e captura; mudança concorrente reinicia a primeira página. Limites de seções e lacunas temporais ficam visíveis. A migração v27 adiciona índices de acesso temporal, sem reescrever o banco. Responsável, rank e estimativas não são projetados historicamente nesta tela até existir um contrato temporal para esses campos. Consulte [ADR 0018](docs/adr/0018-retrato-historico-do-projeto.md) e [guia do dashboard](docs/dashboard.md#retrato-hist%C3%B3rico-por-data).

### SSDD-913 · Rastreabilidade técnica e de QA

O domínio valida `implements` de tarefa para especificação e preserva revisões de baseline; `relates_to` também aparece no contexto como referência sem alegação de implementação. Na sessão de desenvolvimento, as revisões técnicas implementadas e de cenários associadas à tarefa são fixadas. `scenario_create/revise` aceita tarefas vinculadas; `test_run_record` aceita uma ou várias tarefas para que o contexto apresente cenário, revisão executada, build e resultado. Decisões herdadas continuam distintas de links diretos, e warnings sinalizam revisões publicadas depois da sessão. A relação é opcional; nenhum gate global Ready/Done exige artefatos que a equipe não configurou como aplicáveis.

## Propostas de fidelidade de entrega e qualidade (2026-11-12)

Resultado da [análise de qualidade](docs/analise-qualidade-e-melhorias.md). São propostas sem sprint e sem estimativa confirmada. Estão registradas no MCP como tarefas Draft `SSDD-141`–`SSDD-158` sob a história `SSDD-102`, com os aliases estáveis desta tabela vinculados na mesma ordem; as 25 dependências estão gravadas como arestas `depends_on`. Aceites, dependências e ordem recomendada estão no documento.

| ID | Proposta | Pts | Fase |
|---|---|---:|---|
| SSDD-938 | Critérios de aceite estruturados e critérios em tarefas | 5 | A · Entregar igual ao esperado |
| SSDD-939 | Revisão de prontidão e perguntas em aberto | 8 | A |
| SSDD-940 | Relatório de entrega por critério | 8 | A |
| SSDD-941 | Evidência verificada por CI | 8 | A |
| SSDD-942 | Revisão independente como gate | 5 | A |
| SSDD-943 | Definition of Done aplicada por item | 5 | A |
| SSDD-944 | Vínculo entre tarefa e mudança de código | 5 | A |
| SSDD-945 | Briefing de tarefa em uma chamada | 5 | B · Menos fricção, mais contexto |
| SSDD-946 | Anotações e descrições das tools (anotações implementadas localmente; descrições pendentes) | 3 | B |
| SSDD-947 | Política de gates por projeto | 8 | B |
| SSDD-948 | Orientações do projeto no contexto | 5 | B |
| SSDD-949 | Modelos de item e de workflow | 3 | B |
| SSDD-950 | Skills em formato de checklist | 2 | B |
| SSDD-951 | Métricas de qualidade de entrega | 5 | C · Medir e sustentar |
| SSDD-952 | Avaliação automatizada de skills e prompts | 8 | C |
| SSDD-953 | Dividir `src/mcp/server.ts` por domínio | 5 | C |
| SSDD-954 | Modularizar e testar o dashboard | 8 | C |
| SSDD-955 | Reduzir a leitura obrigatória (concluída no MCP como SSDD-158, sem QA independente) | 3 | C |
| SSDD-956 | Distinguir entregue-local de pendente na fila (achado U3) | 5 | A |
| SSDD-957 | Política de independência de revisão e validação (achado U4) | 3 | A |
| SSDD-958 | Devolver `version` em escritas e uniformizar parâmetros (achado U5) | 3 | A |

