# ADR 0001: stack inicial

- **Estado:** aceita para a fundação; revisável com evidência de incompatibilidade.
- **Data:** 2026-11-09.
- **Contexto:** o repositório continha apenas especificações. A fundação precisa validar execução MCP local, SQLite, testes e CI multiplataforma antes de crescer o domínio.

## Decisões

| Área | Decisão inicial | Motivo |
|---|---|---|
| Runtime | Node.js `^24 || ^26`; Node 26 é a versão recomendada no `.nvmrc` | Node 24 e 26 estão em LTS; o runtime 24 também permite executar a fundação na máquina de desenvolvimento atual |
| Linguagem | TypeScript 6.0.3, ESM e `NodeNext`, com compilação estrita | Tipos compartilhados entre o domínio, adaptadores e contratos; saídas compatíveis com Node |
| MCP server | `@modelcontextprotocol/server` 2.4.0, Zod 4.6.7 e protocolo MCP `2026-07-28` | Linha v2 estável do SDK, schemas de entrada/saída explícitos e pacotes separados para servidor e cliente |
| MCP client de teste | `@modelcontextprotocol/client` 2.4.0 | O teste inicia o processo stdio e negocia a conexão com um cliente real do SDK |
| SQLite | `better-sqlite3` 12.11.1 | API síncrona, transações explícitas e instalação com binários pré-compilados para evitar compilação local. A CI vai verificar binários e capacidades nos sistemas suportados |
| Qualidade | ESLint 10, TypeScript ESLint, `node:test` e `npm ci` | Poucas ferramentas, instalação reprodutível e testes sem um runner adicional |

As dependências diretas estão fixadas no `package.json` e `package-lock.json`. O CI testa Node 24 e 26 em Linux, macOS e Windows. Os testes locais desta revisão foram executados em Windows com Node 24.18.0; as seis combinações do CI ainda precisam ser executadas pelo provedor após publicação do workflow.

## Consequências

- Cada conexão SQLite ativa `foreign_keys`, `busy_timeout` de cinco segundos e `synchronous=NORMAL`; arquivos usam WAL. A abertura falha se FTS5, funções JSON ou WAL necessário não estiver disponível.
- As migrações v1 a v7 criam projetos, principals locais, associação de papéis, eventos de auditoria, registros de idempotência, itens hierárquicos, critérios, snapshots iniciais imutáveis de PBI, índice FTS5 sincronizado por gatilhos, revisões versionadas de especificações e grafo tipado de rastreabilidade. Cada migração grava SHA-256 e drift interrompe a inicialização.
- `ssdd-mcp init` cria `.ssdd/ssdd.sqlite` e registra a identidade do usuário do sistema operacional. O principal de bootstrap recebe os papéis locais; a separação entre usuários confiáveis requer contas distintas do sistema operacional.
- O MCP stdio publica ferramentas de projeto, backlog e especificações; as demais ferramentas do contrato seguem nas sprints seguintes.
- Respostas idempotentes ficam retidas por 30 dias; depois hash e resposta são apagados, mantendo um tombstone para impedir replay ou reuso da chave.
- A compatibilidade com os seis ambientes de CI é requisito de conclusão de SSDD-101, não algo provado pelos testes locais.

## Referências

- [Ciclo de suporte do Node.js](https://nodejs.org/en/about/previous-releases)
- [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [Servidor stdio do MCP SDK](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio)
- [Pacote do servidor MCP](https://www.npmjs.com/package/@modelcontextprotocol/server)
- [better-sqlite3](https://www.npmjs.com/package/better-sqlite3)
