# ADR 0002 · Transporte Streamable HTTP local

- **Status:** aceito para SSDD-601
- **Data:** 2026-11-09
- **Contexto:** o produto já oferece MCP por stdio e precisa atender clientes que usam Streamable HTTP. O SDK instalado oferece transporte baseado em Fetch `Request`/`Response`; o servidor atual roda em Node.js e compartilha SQLite e registro de ferramentas.

## Decisão

- Adaptar `node:http` ao SDK oficial, sem adicionar outra dependência de transporte. Preservar a era com handshake usando `WebStandardStreamableHTTPServerTransport` e rotear a era moderna por `isLegacyRequest` + `createMcpHandler`.
- Executar um `McpServer` e um transporte stateful por sessão na era com handshake; construir um `McpServer` por requisição moderna. Ambos reutilizam o banco e o principal local do processo.
- Iniciar pelo comando `ssdd-mcp serve`, com bind fixo em `127.0.0.1` e endpoint `/mcp`. Mesmo com OAuth/OIDC ativo, o processo não aceita bind remoto; uma publicação externa passa por proxy TLS conforme ADR 0003.
- Validar Host e Origin com os utilitários oficiais do SDK para `localhost`, `127.0.0.1` e `[::1]`; não habilitar CORS. Limitar cada corpo MCP a 1 MiB e aplicar timeout de requisição.
- Deixar a classificação, negociação de versão e validação do cabeçalho de protocolo a cargo do SDK. Clientes legacy mantêm handshake e sessão; clientes modernos optam por negociação e usam protocolo sem estado.
- Usar o modo de resposta automático da era moderna (JSON ou SSE) e JSON para os pedidos da era com handshake.
- Manter sessões legacy somente em memória; clientes devem inicializar de novo após reinício do processo.

## Consequências

- O registro de ferramentas, resources e regras de autorização é compartilhado com stdio. O cliente oficial consegue inicializar, listar e chamar tools tanto com a era legacy quanto com `2026-07-28`.
- Sem configuração OIDC, o servidor HTTP mantém a identidade local do processo. O resource server OIDC e os papéis explícitos por projeto são definidos em ADR 0003; aprovações delegadas para agente e serviço seguem ADR 0004.
- Sessões legacy não sobrevivem ao reinício. A era moderna cria servidor por requisição; retomada/event store não está habilitada.
- O aceite local é coberto por testes de cliente oficial, negociação legacy/moderna, versão não suportada, Host/Origin remoto, corpo grande e sessão inválida.
