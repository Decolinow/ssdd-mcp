# SSDD MCP v0.2.0 — rascunho das notas de release

**Estado:** rascunho para revisão. Não criar a tag nem publicar estas notas antes do aceite da CI e do pacote/container.

## Destaques

- MCP local por stdio e MCP Streamable HTTP em `/mcp`, usando o mesmo catálogo de ferramentas e recursos.
- Acesso de equipe com OAuth/OIDC, papéis provisionados por projeto e aprovações humanas de uso único para mutações delegadas.
- Product Backlog, board acessível por teclado e drag and drop, visão de QA, timeline de auditoria e dashboard de sprint e métricas.
- Planejamento e fechamento de sprint, capacidade por equipe, marcos e previsão de entrega Monte Carlo reproduzível.
- Backup online, restauração validada, diagnóstico read-only, exportação JSON/Markdown/Gherkin, webhooks assinados e importações read-only de GitHub Issues e Azure Boards.
- Distribuição local por tarball e container Docker com volume SQLite persistente.

## Compatibilidade e operação

- Runtime suportado: Node.js 24 ou 26, com npm 10 ou superior.
- O transporte HTTP atende clientes com handshake MCP `2025-11-25` e anteriores, além da era stateless `2026-07-28` negociada pelo SDK.
- Sem OIDC, o acesso usa a identidade local. Com OIDC, cada identidade `iss+sub` precisa ser provisionada em cada projeto; o servidor exige o scope `ssdd:mcp`.
- O servidor HTTP permanece vinculado a `127.0.0.1`. Para acesso de equipe, use proxy reverso com TLS e configure a URL canônica do resource.

## Upgrade e recuperação

- Antes de atualizar, gere um backup com `ssdd-mcp backup` e confira o workspace com `ssdd-mcp doctor`.
- O schema atual é a versão 23. A próxima inicialização aplica migrações pendentes e valida seus checksums; faça o backup antes de abrir um workspace existente com uma versão nova.
- `ssdd-mcp restore` valida o manifesto, integridade e chaves estrangeiras, e só instala em um workspace com `.ssdd` ausente ou vazio.
- Não há downgrade destrutivo automático. Para voltar à versão anterior, restaure um backup compatível com ela.

## Instalação e distribuição

- O pacote npm permanece privado e não é publicado em registry. `npm pack` gera o tarball local para instalação em um prefixo isolado.
- O container usa Node.js 24, usuário sem privilégios, filesystem raiz read-only e volume nomeado em `/data`; o transporte stdio não publica porta de rede.
- Os comandos completos de instalação e operação estão em [Desenvolvimento](development.md#pacote-e-container) e [Contrato MCP](mcp.md).

## Gate de publicação

Finalizar estas notas e criar a tag v0.2.0 somente depois da matriz Linux/macOS/Windows × Node 24/26, do smoke de instalação do tarball, do container com volume persistente e da demo integrada PO → Developer → QA → Done passarem na CI.
