# ADR 0019 · Autenticação, perfis de ferramentas e busca semântica

- **Status:** Aceito
- **Data:** 2026-11-11
- **Contexto:** uma única instalação MCP precisa identificar pessoas e agentes em vários clientes, preservar autoria nas tarefas e reduzir as tools expostas por função. A busca textual FTS5 não cobre consultas por significado. A implantação continua single-host com SQLite.

## Decisões

1. No primeiro startup do host, o principal humano local do sistema operacional torna-se o único administrador da instância. O servidor emite uma authKey aleatória de 256 bits, imprime-a uma vez em `stderr` e persiste somente SHA-256 e metadados. O admin cria identidades `human`, `agent` e `service`, memberships por projeto e authKeys. Chaves são rotacionáveis/revogáveis, no máximo uma fica ativa por principal e nenhum segredo entra em auditoria ou resposta idempotente.
2. HTTP autentica authKeys com `Authorization: Bearer`; OIDC continua como alternativa. O stdio aceita `SSDD_AUTH_KEY`; sem chave, preserva o principal local. A identidade resolvida vira o único `principalId` usado por autorização de projeto, atribuição, sessões, execuções e auditoria. Autenticação não concede acesso a projetos: memberships, papéis, tipo de principal, aprovações e gates continuam obrigatórios.
3. O operador pode fornecer `X-SSDD-Profile` no HTTP ou `SSDD_PROFILE` no stdio para filtrar ferramentas registradas. Os perfis são `full`, `dev`, `qa`, `tech_lead`, `po`, `facilitator`, `release` e `admin`. Perfis não são papéis de domínio. Sessões HTTP legacy são fixadas ao perfil do handshake; no protocolo moderno sem sessão a seleção é por requisição. `task_context_get.profile` continua sendo uma seleção separada de conteúdo.
4. A lista de tarefas e a indexação/busca semântica aceitam `assignedToMe`, sempre resolvido pelo principal autenticado. Cursores incluem principal e filtros relevantes.
5. Busca vetorial é opt-in e usa endpoint de embeddings OpenAI-compatible definido pelo operador. Só HTTPS é aceito, exceto loopback HTTP para provedor local. Título, descrição, critérios e consulta são enviados ao endpoint; vetores derivados são armazenados no SQLite separados por projeto/modelo/item e invalidados logicamente pelo hash do conteúdo. Indexação é paginada e a busca exata tem limite de 10.000 tarefas.

## Consequências

- O bootstrap inicial precisa ocorrer em uma sessão de operação capaz de capturar a saída `stderr`; depois, a authKey deve ser guardada em um secret manager.
- A equipe pode autenticar vários clientes sem instâncias adicionais. A proteção de rede remota continua exigindo TLS no proxy; OIDC é recomendado para federação corporativa.
- O perfil diminui o catálogo de tools injetado no contexto, mas não é uma fronteira de segurança. Toda chamada ainda é autorizada pelo projeto e pelo domínio.
- Sem provedor de embeddings, FTS5 segue disponível e nenhuma chamada externa é feita. Com provedor externo, o operador deve classificar os dados e avaliar o destino antes de habilitar o recurso.
- Vetores ocupam espaço no banco e podem ser reconstruídos. Não há dependência de banco vetorial adicional nem suporte multi-instância.

## Alternativas consideradas

- **Somente OIDC:** não cobre uso local/stdio nem integração direta de agentes sem issuer.
- **Papel como único filtro de tools:** papéis pertencem ao domínio e não são sempre o perfil de contexto desejado; mantê-los separados evita que um nome de perfil conceda autorização.
- **Serviço vetorial externo obrigatório:** aumenta custo e operação para quem só precisa de FTS5; embeddings opcionais evitam egress por padrão.

## Validação

Migração v28, testes de bootstrap/rotação/revogação, autenticação HTTP e stdio, superfície por perfil, atribuição `assignedToMe`, paginação/cursor, cache e contrato de embeddings são cobertos pela suíte `npm run check`.
