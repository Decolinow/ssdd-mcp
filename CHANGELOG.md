# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento [SemVer](https://semver.org/lang/pt-BR/). Durante os betas (`0.x`), contratos MCP e o esquema do banco podem mudar entre versões; as migrações do banco rodam automaticamente.

## [0.3.0-beta.1] - 2026-11-13 (beta-01)

Primeiro beta público.

### Funcionalidades
- Servidor MCP (stdio e Streamable HTTP em loopback) com backlog hierárquico, revisões versionadas, critérios de aceite estruturados, especificações versionadas e rastreabilidade por vínculos.
- QA rastreável: cenários com revisões publicadas, execuções por build, evidência com hash, **certificação humana** de QA e origem de execução (`agent`, `human`, `ci`); importação de relatórios JUnit (`test_run_import_junit`) e, sob a política `strict`, certificação de cenários automatizados somente a partir de execuções `ci` comprovadas por `workflow_run` de sucesso ([ADR 0030](docs/adr/0030-origem-de-execucao-e-confianca-em-ci.md)).
- Política de gates por projeto (`lite`, `standard`, `strict`) e aprovações humanas de uso único para ações de agentes.
- Planejamento: times, capacidade, Definition of Done, marcos, sprints, retrospectivas, velocidade e previsão Monte Carlo.
- Sessões de desenvolvimento, início atômico de tarefa, workflows ponderados, eventos de release e métricas de execução.
- Importação somente leitura de issues do GitHub e itens do Azure Boards; receptor de webhooks GitHub com HMAC.
- Dashboard local em dez abas (Início, Métricas, Roadmap, Histórico, Especificações, Product Backlog, Board, Qualidade, Atividade, Retrospectiva) com acesso por papel e formulários guiados para planejamento e operações de item.
- Instalador de skills e agentes para Claude Code, Codex e OpenCode; `doctor`, `backup`, `restore` e `export`.
- Manuais do [usuário](docs/manual-usuario.md) e do [administrador](docs/manual-administrador.md) com imagens geradas por script.

### Qualidade
- 265 testes automatizados (`npm run check`) e smoke de navegador (`npm run test:browser`); CI em Node 24 e 26 no Linux, macOS e Windows.
- Revisão de usabilidade do dashboard: legibilidade, listas com rolagem interna, alinhamento, rótulos e foco visível.

### Limitações conhecidas
Nó único (SQLite), sem alta disponibilidade; origem `ci` exercitada só com eventos de teste; importação de resultados apenas JUnit; sem revisão independente humana de segurança; macOS sem validação manual; pacote privado (não publicado no npm). Veja o [README](README.md#limitações-conhecidas-do-beta-01).

[0.3.0-beta.1]: https://github.com/Decolinow/ssdd-mcp/releases/tag/v0.3.0-beta.1
