# SSDD MCP

Servidor Model Context Protocol para desenvolvimento guiado por especificações, com backlog, sprints e rastreabilidade entre regras de negócio, código e testes. Pensado para equipes que trabalham com agentes de IA no editor, no terminal ou em automações.

Um agente de Product Owner registra uma história com critérios de aceite. Um agente de Dev consulta as regras e decisões técnicas vigentes antes de implementar uma tarefa. Um agente de QA registra evidência para os cenários vinculados. O time acompanha o trabalho no board, percorre QA e auditoria e consulta retrospectivas versionadas com ações atribuídas a pessoas responsáveis.

## Começar no repositório

Requer Node.js 24 ou 26 e npm 10 ou superior.

### Preparar um workspace

```sh
npm ci
npm run check
npm run build
node dist/src/cli.js init --workspace . --key PAY --name "Pagamentos" --goal "Pagamentos confiáveis" --timezone America/Sao_Paulo
```

`init` cria o banco, aplica as migrações, registra o projeto e prepara a identidade local. Execute uma vez por workspace. Se o workspace já foi inicializado, pule esse comando.

### Iniciar o dashboard local

Em um terminal, rode:

```sh
node dist/src/cli.js dashboard --workspace . --port 4318
```

Abra no mesmo computador a URL de uso único impressa no terminal, incluindo o token. Mantenha o processo em execução enquanto usa o dashboard; `Ctrl+C` encerra o servidor. O dashboard é um processo HTTP local separado do servidor MCP e usa o banco do workspace informado.

Hoje a interface oferece Métricas, Product Backlog, Board, Qualidade, Atividade e Retrospectiva. É possível cadastrar histórias e bugs, propor/publicar revisões de PBI, cadastrar/publicar cenários e registrar execuções ligadas a uma revisão publicada e a uma build. Métricas incluem horas e calibração descritiva por Developer. O detalhe de tarefas mostra datas e histórico de sessões de desenvolvimento e releases de homologação/produção. As mutações de sessão e deployment ficam no MCP nesta versão; consulte o [guia do dashboard](docs/dashboard.md) para os fluxos, papéis, filtros e rotas.

### Iniciar o servidor MCP

`npm start` inicia o transporte MCP stdio no diretório atual; clientes MCP normalmente iniciam esse processo por configuração. Para usar Streamable HTTP local, rode em outro terminal:

```sh
node dist/src/cli.js serve --workspace . --port 4319
```

O endpoint local fica em `http://127.0.0.1:4319/mcp`. Para acesso compartilhado, mantenha o servidor em loopback atrás de um proxy TLS e configure `--oidc-issuer` e `--resource-url`. O servidor valida tokens JWT por descoberta OIDC/JWKS e exige o escopo `ssdd:mcp`. Cada identidade `iss+sub` precisa receber acesso aos projetos necessários por administrador local com `ssdd-mcp access grant`; `ssdd-mcp access revoke` remove papéis e registra auditoria. Os papéis vêm das associações do projeto, nunca dos valores de papel declarados no token. Após conectar, o cliente chama `project_list`, deixa a pessoa escolher quando houver vários projetos e envia o UUID escolhido em `projectId` em cada operação. Veja o [runbook de servidor para equipe](docs/team-server.md) para proxy, configuração, probes e limites do SQLite.

Mutações delegadas a agentes e serviços exigem aprovação humana de uso único, vinculada à ferramenta, projeto, argumentos, versão e executor; `approval_issue` e `approval_revoke` são restritas a admins humanos. O MCP oferece ferramentas e resources para backlog, especificações versionadas, rastreabilidade, QA, contexto de tarefa, workflow, evidências, times, capacidade, marcos, métricas, Definition of Done, sprints, retrospectivas, sessões de desenvolvimento e eventos de deployment. `development_session_start/transition/list` registra autoria e duração ativa; `developer_execution_metrics_get` calcula esforço/calibração em horas sem misturar pontos de história. `deployment_event_record/list` separa homologação e produção de `Done` e exige o mesmo build homologado para uma produção aprovada. `roadmap_id_bind/resolve/list` mantém os IDs estáveis sem conflitar com chaves geradas. Consulte o [contrato MCP](docs/mcp.md), a [especificação](docs/specification.md), o [runbook de equipe](docs/team-server.md) e a [arquitetura](docs/architecture.md).

Para receber PRs e workflows assinados do GitHub, configure `SSDD_WEBHOOK_SECRET_GITHUB__PAY` e `SSDD_GITHUB_REPOSITORY_PAY=acme/payments` para o endpoint `POST /webhooks/github/PAY`. O receptor valida o repositório e a assinatura e registra recibos, auditoria e snapshots sem armazenar o segredo ou o corpo bruto. `github_reference_list` consulta PRs, SHAs e runs ligados aos itens sem alterar estado ou certificar QA.

Os projetos podem ter vários times. Use `team_list` para obter IDs e `team_create` para adicionar um time com calendário e composição próprios. Capacidade, sprints e previsão aceitam `teamId`; sem seleção, o fluxo só assume o time quando o projeto tem exatamente um. O dashboard oferece o seletor global de time para sprints, retrospectivas, velocidade e previsão.

Para importar issues GitHub, configure também `SSDD_GITHUB_ISSUES_TOKEN_PAY` com acesso read-only. `github_issue_import_preview` consulta sem gravar; revise `planHash` e aplique com `github_issue_import_apply`. O apply exige PO humano e cria itens em Draft sob a Feature escolhida; veja a [configuração detalhada](docs/mcp.md#importação-unidirecional-de-issues-github).

O Azure Boards também pode ser importado por `azure_work_item_import_preview/apply`, usando `SSDD_AZURE_DEVOPS_ORGANIZATION_PAY`, `SSDD_AZURE_DEVOPS_PROJECT_PAY` e um PAT organizacional read-only em `SSDD_AZURE_DEVOPS_TOKEN_PAY`. O fluxo mapeia `User Story` para `story` e `Bug` para `bug`, exige PO humano para aplicar e só executa consultas read-only; veja a [configuração detalhada](docs/mcp.md#importação-unidirecional-do-azure-boards).

O MCP publica seis prompts operacionais cobrindo refinamento de negócio e técnico, planejamento, Developer, QA e Release, além de cinco skills por papel. Os prompts guiam o agente sem executar mutações ao serem carregados; clientes compatíveis podem listar e validar os arquivos da extensão MCP Skills. Consulte [prompts e skills](docs/mcp.md#prompts-e-skills-para-agentes), o [guia do servidor de equipe](docs/team-server.md) e o [backlog de habilitação de agentes](ROADMAP.md#backlog-de-habilitação-de-agentes).

Para preparar outro repositório Git com runtime local, skills e agentes para Claude Code, Codex e OpenCode, rode o instalador deste projeto. O padrão mostra apenas o plano; `--apply` instala e `--check` valida depois:

```powershell
npm run agents:install -- --target ..\meu-projeto
npm run agents:install -- --target ..\meu-projeto --apply
npm run agents:install -- --target ..\meu-projeto --check
```

O pacote privado é instalado por tarball local em `.ssdd/agent-runtime`; configurações existentes são preservadas e conflitos com arquivos não gerenciados interrompem a aplicação. Consulte o [guia do instalador](docs/agent-installer.md) e os [itens SSDD-67–84](ROADMAP.md#backlog-de-instala%C3%A7%C3%A3o-para-claude-code-codex-e-opencode).

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
| [Instalador de agentes](docs/agent-installer.md) | Runtime local, skills e perfis nativos para Claude Code, Codex e OpenCode |
| [Dashboard e projeções](docs/dashboard.md) | Início local, seis abas atuais, cadastro de PBIs, cenários, execuções, limites e projeções |
| [Roadmap](ROADMAP.md) | Épicos, sprints, tarefas estimadas, dependências e entregas verificáveis |
| [Simulação de projeto solo](docs/solo-simulation.md) | Definition of Done, capacidade, fluxo MCP completo e próximos passos |
| [Demo local](docs/demo.md) | Trilha PO → Dev → QA, configuração de cliente stdio e validação do pacote |
| [Notas de release v0.2.0 (rascunho)](docs/release-v0.2.md) | Compatibilidade, upgrade, instalação e gate de publicação |
| [Status](docs/status.md) | Sprint atual, tarefas iniciadas, evidências e próximo passo |
| [Sessões e releases por tarefa (ADR 0017)](docs/adr/0017-sessoes-de-desenvolvimento-e-releases.md) | Datas, autoria, calibração em horas, gates de promoção e limites de recuperação |
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
| [Decisão do instalador local](docs/adr/0014-instalador-local-de-agentes.md) | Runtime ignorado pelo Git, merge seguro de configuração e atualização por manifesto |

## Status

O projeto já tem fluxos locais executáveis para backlog, especificações, rastreabilidade, QA, entrega, capacidade, marcos e ciclo de sprint: cenários versionados, baselines com impactos, transições auditadas, evidência por item, certificação humana de QA, planejamento com snapshots, fechamento de itens aceitos/incompletos e retrospectivas imutáveis com ações acompanháveis. A camada de aplicação reconstrói burndown, burnup, velocidade, WIP e cobertura com watermark e corte temporal, e calcula previsões Monte Carlo P25/P50/P75 e probabilidade até a meta com seed e histórico imutáveis, capacidade futura explícita e bloqueios sem data estimada. O dashboard e a ferramenta MCP `metrics_get` usam a mesma projeção e autorização; filtros e watermark ficam alinhados. A cobertura entrega até 20 linhas de detalhe e mantém totais do projeto; um cache por watermark reduz leituras repetidas. O benchmark local verifica reconstrução fria, cinco clientes MCP, leituras concorrentes e gravações em fixture com 10 mil itens e 50 mil eventos. Na interface atual, Product Backlog e board permitem consultar e transicionar itens; o dashboard também oferece detalhe de PBI, cadastro/revisão de PBIs e cenários, registro e histórico de execuções, gráfico dos resultados recentes, timeline e retrospectiva. Certificações existentes são exibidas no detalhe; a certificação de execuções continua no MCP. A sessão de loopback protege as ações com origem e CSRF. Consulte o [status detalhado](docs/status.md) antes de iniciar uma tarefa.

## Licença

[Apache License 2.0](LICENSE).
