# SSDD MCP

Servidor Model Context Protocol para desenvolvimento guiado por especificações, com backlog, sprints e rastreabilidade entre regras de negócio, código e testes. Pensado para equipes que trabalham com agentes de IA no editor, no terminal ou em automações.

Um agente de Product Owner registra uma história com critérios de aceite. Um agente de Dev consulta as regras e decisões técnicas vigentes antes de implementar uma tarefa. Um agente de QA registra evidência para os cenários vinculados. O time acompanha o trabalho no board, percorre QA e auditoria e consulta retrospectivas versionadas com ações atribuídas a pessoas responsáveis.

## Começar no repositório

Requer Node.js 24 ou 26 e npm 10 ou superior.

```sh
npm ci
npm run check
npm run build
node dist/src/cli.js init --workspace . --key PAY --name "Pagamentos" --goal "Pagamentos confiáveis" --timezone America/Sao_Paulo
npm start
# Em outro terminal, para habilitar o adaptador HTTP local do dashboard:
node dist/src/cli.js dashboard --workspace . --port 4318
# Para conectar um cliente MCP pelo transporte HTTP local:
node dist/src/cli.js serve --workspace . --port 4319
# Para acesso de equipe, mantenha o processo em loopback atrás de um proxy TLS:
node dist/src/cli.js serve --workspace . --oidc-issuer https://id.example/tenant --resource-url https://mcp.example.com/mcp
```

`init` cria o banco, aplica migrações, registra o projeto e prepara a identidade local. `npm start` inicia o transporte stdio no diretório atual. `ssdd-mcp serve` oferece o mesmo MCP por Streamable HTTP em `http://127.0.0.1:4319/mcp`. Sem configuração adicional, usa a identidade do sistema operacional. Para equipe, configure `--oidc-issuer` e `--resource-url`; o servidor valida tokens JWT de acesso por descoberta OIDC/JWKS e exige o escopo `ssdd:mcp`. O processo permanece em loopback para receber tráfego de um proxy TLS, e cada identidade `iss+sub` precisa ser concedida a um projeto por um administrador local com `ssdd-mcp access grant`. Papéis vêm das associações do projeto; valores de papel enviados no token não são usados. `ssdd-mcp access revoke` remove papéis e registra auditoria. Mutações selecionadas por agentes e serviços exigem aprovação humana de uso único, vinculada à ferramenta, projeto, argumentos, versão e executor; `approval_issue` e `approval_revoke` são restritas a admins humanos. Configure `SSDD_WEBHOOK_SECRET_GITHUB__PAY` e `SSDD_GITHUB_REPOSITORY_PAY=acme/payments` para receber PRs e workflows assinados em `POST /webhooks/github/PAY`. O receptor valida o repositório mapeado e registra recibos, auditoria e snapshots imutáveis sem guardar segredo ou corpo bruto. `github_reference_list` consulta PRs, SHAs e runs ligados a itens sem alterar estado ou certificar QA. O servidor também publica ferramentas e resources MCP para projetos, backlog, especificações versionadas, rastreabilidade, QA, contexto de tarefa, workflow, evidências, capacidade, marcos com escopo aprovado, métricas, Definition of Done, sprints e retrospectivas. Uma história pode avançar de Draft a Ready quando tem conteúdo publicado, critérios cobertos, pontos confirmados e regras vigentes; a transição fixa a baseline na mesma transação. A conclusão exige evidência ligada à baseline e ao build candidato, cenários da baseline aprovados nesse build e certificação de uma pessoa QA. O planejamento de sprint cria snapshots auditáveis de escopo, capacidade e DoD. Um marco fixa os PBIs aprovados, suas baselines e estimativas, e mantém o histórico das inclusões e remoções. `ssdd-mcp dashboard` inicia a interface local de Product Backlog e board, visões de métricas, qualidade, atividade e retrospectivas, junto da API que compartilha projeções e autorização com o MCP. O acesso ao dashboard começa pela URL de uso único impressa no terminal.

Os projetos podem ter vários times. Use `team_list` para obter IDs e `team_create` para adicionar um time com calendário e composição próprios. Capacidade, sprints e previsão aceitam `teamId`; sem seleção, o fluxo só assume o time quando o projeto tem exatamente um. O dashboard oferece o seletor global de time para sprints, retrospectivas, velocidade e previsão.

Para importar issues GitHub, configure também `SSDD_GITHUB_ISSUES_TOKEN_PAY` com acesso read-only. `github_issue_import_preview` consulta sem gravar; revise `planHash` e aplique com `github_issue_import_apply`. O apply exige PO humano e cria itens em Draft sob a Feature escolhida; veja a [configuração detalhada](docs/mcp.md#importação-unidirecional-de-issues-github).

O Azure Boards também pode ser importado por `azure_work_item_import_preview/apply`, usando `SSDD_AZURE_DEVOPS_ORGANIZATION_PAY`, `SSDD_AZURE_DEVOPS_PROJECT_PAY` e um PAT organizacional read-only em `SSDD_AZURE_DEVOPS_TOKEN_PAY`. O fluxo mapeia `User Story` para `story` e `Bug` para `bug`, exige PO humano para aplicar e só executa consultas read-only; veja a [configuração detalhada](docs/mcp.md#importação-unidirecional-do-azure-boards).

O MCP publica prompts operacionais para PO, Developer, QA e Release e serve quatro skills com instruções por papel. Os prompts guiam o agente sem executar mutações ao serem carregados; clients compatíveis podem listar e validar os arquivos da extensão MCP Skills. Consulte [prompts e skills](docs/mcp.md#prompts-e-skills-para-agentes) e o [backlog de habilitação de agentes](ROADMAP.md#backlog-de-habilitação-de-agentes).

Comandos de operação: `ssdd-mcp doctor [--workspace <diretório>]` verifica a saúde do banco sem alterá-lo; `ssdd-mcp backup [--workspace <diretório>] [--output <arquivo.sqlite>]` cria um backup online e manifesto `.manifest.json`; `ssdd-mcp restore --backup <arquivo.sqlite> [--workspace <workspace limpo>]` valida e restaura em um diretório com `.ssdd` ausente ou vazio; e `ssdd-mcp export [--workspace <diretório>] --format json|markdown|gherkin [--output <arquivo>]` exporta dados do projeto ou revisões publicadas de cenários sem credenciais. O formato Gherkin pode ser salvo como `.feature`; exportação não substitui backup. O fluxo, os limites e a recuperação estão em [ADR 0005](docs/adr/0005-workspace-backup-restore-export.md).

## Distribuição local e container

`npm pack` gera um tarball instalável para validar ou distribuir uma versão local. O pacote continua privado e não é publicado no registry. `Dockerfile` constrói runtime Node 24 com dependências de produção e usuário sem privilégios; `compose.yaml` monta o volume nomeado `ssdd-data` em `/data` e mantém o processo MCP em stdio, sem publicar uma porta.

```sh
docker compose build
docker compose run --rm ssdd-mcp init --workspace /data --key PAY --name "Pagamentos" --goal "Pagamentos confiáveis" --timezone America/Sao_Paulo
docker compose run --rm -i ssdd-mcp
```

Configure o cliente MCP para executar `docker compose run --rm -i ssdd-mcp`. Cada sessão cria um container novo, mas usa o volume persistente. Para deployment compartilhado, mantenha o fluxo atrás de proxy TLS com OIDC; não publique diretamente uma porta do container. A tarefa SSDD-604 adiciona smoke test de pacote e recriação do container ao workflow de CI.

`npm run check` executa lint, verificação de tipos e os testes unitários e de integração. A CI repete a verificação em Linux, macOS e Windows com Node 24 e 26.

`npm run demo:release` roda o fluxo integrado com PO, Developer e QA em clientes OIDC MCP separados e confirma o resultado no dashboard local, usando um issuer de teste em loopback.

## Documentação

| Documento | Conteúdo |
|---|---|
| [Especificação funcional](docs/specification.md) | Domínio, rastreabilidade, papéis, fluxos de trabalho e critérios de aceite |
| [Arquitetura e operação](docs/architecture.md) | Runtime, módulos, persistência, auditoria, concorrência e segurança |
| [Contrato MCP](docs/mcp.md) | Ferramentas, filtros, contexto por tarefa, formatos e erros |
| [Prompts e skills de agente](docs/mcp.md#prompts-e-skills-para-agentes) | Fluxos por papel, ferramentas recomendadas e gates humanos |
| [Dashboard e projeções](docs/dashboard.md) | Board, capacidade, burndown, velocidade e previsão |
| [Roadmap](ROADMAP.md) | Épicos, sprints, tarefas estimadas, dependências e entregas verificáveis |
| [Demo local](docs/demo.md) | Trilha PO → Dev → QA, configuração de cliente stdio e validação do pacote |
| [Notas de release v0.2.0 (rascunho)](docs/release-v0.2.md) | Compatibilidade, upgrade, instalação e gate de publicação |
| [Status](docs/status.md) | Sprint atual, tarefas iniciadas, evidências e próximo passo |
| [Desenvolvimento](docs/development.md) | Instalação, comandos, fluxo de contribuição e atualização da documentação |
| [Decisão inicial de stack](docs/adr/0001-stack-inicial.md) | Versões escolhidas e premissas ainda abertas |
| [Decisão de Streamable HTTP local](docs/adr/0002-streamable-http-local.md) | Transporte e limites de rede do adaptador MCP HTTP |
| [Decisão de OAuth/OIDC](docs/adr/0003-oauth-oidc-resource-server.md) | Autenticação de equipe, provisionamento e papéis |
| [Decisão de aprovações delegadas](docs/adr/0004-single-use-tool-approvals.md) | Vínculo, validade, consumo atômico e auditoria de execução por agente |
| [Decisão de webhooks](docs/adr/0007-receptor-de-webhooks.md) | Assinatura HMAC, segredo por projeto, recibo idempotente e auditoria |
| [Decisão de referências GitHub](docs/adr/0008-referencias-github.md) | Mapeamento de repositório, allowlist, snapshots e consulta autorizada |
| [Decisão de importação GitHub](docs/adr/0009-importacao-github.md) | Preview hash-bound, leitura unidirecional e vínculo idempotente de issues |
| [Decisão de importação Azure Boards](docs/adr/0010-importacao-azure-boards.md) | WIQL/batch read-only, tipos mapeados e aplicação humana idempotente |
| [Decisão de isolamento de times](docs/adr/0012-isolamento-de-times-por-projeto.md) | Seleção explícita, composição independente, reservas de PBI e snapshots por time |
| [Decisão de recuperação do workspace](docs/adr/0005-workspace-backup-restore-export.md) | Backup online, manifesto, restauração atômica, diagnóstico e exportação |

## Status

O projeto já tem fluxos locais executáveis para backlog, especificações, rastreabilidade, QA, entrega, capacidade, marcos e ciclo de vida de sprint: cenários versionados, baselines com impactos, transições auditadas, evidência por item, certificação QA humana, planejamento com snapshots, fechamento de itens aceitos/incompletos e retrospectivas imutáveis com ações acompanháveis. A camada de aplicação reconstrói burndown, burnup, velocidade, WIP e cobertura com watermark e corte temporal, e calcula previsões Monte Carlo P25/P50/P75 e probabilidade até a meta com seed e histórico imutáveis, capacidade futura explícita e bloqueios sem data estimada. O dashboard e a ferramenta MCP `metrics_get` usam a mesma projeção e autorização; filtros e watermark ficam alinhados. A cobertura entrega até 20 linhas de detalhe e mantém totais do projeto; um cache por watermark reduz leituras repetidas. O benchmark local verifica reconstrução fria, cinco clientes MCP, leituras concorrentes e gravações em fixture com 10 mil itens e 50 mil eventos. O dashboard também entrega Product Backlog, board responsivo, detalhe de item, cobertura de critérios, execuções/certificações, timeline de auditoria e histórico da retrospectiva, além de drag and drop e movimentos por teclado. A sessão de loopback protege as ações com origem e CSRF. Consulte o [status detalhado](docs/status.md) antes de iniciar uma tarefa.

## Licença

[Apache License 2.0](LICENSE).
