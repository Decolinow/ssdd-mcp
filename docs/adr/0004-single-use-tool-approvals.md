# ADR 0004: Aprovações delegadas de uso único

- **Status:** aceito para SSDD-602
- **Data:** 2026-11-09

## Contexto

Agentes autenticados por OIDC precisam executar comandos delegados sem transformar a aprovação humana em permissão genérica ou reutilizável. A autorização deve especificar a chamada, preservar o RBAC existente e permitir auditar quem aprovou e quem executou.

## Decisão

- Apenas um principal `human` com papel `admin` no projeto pode emitir ou revogar aprovação. O executor deve ser `agent` ou `service`, estar provisionado no mesmo projeto e ainda cumprir o papel necessário à operação.
- `approval_issue` aceita uma ferramenta mutável elegível, o objeto JSON completo de argumentos, projeto, `expectedVersion` (ou `null` quando ausente), executor, motivo e validade de 30 a 600 segundos. A emissão usa `requestId` idempotente. `approval_revoke` cancela uma aprovação pendente; aprovações consumidas não podem ser reativadas nem revogadas.
- Os argumentos são serializados em JSON canônico com chaves ordenadas e resumidos por SHA-256. A chamada do agente fornece o ID em `tools/call.params._meta["com.ssdd-mcp/approval-id"]`. A comparação inclui o hash dos argumentos, projeto, ferramenta, executor e versão.
- A aprovação não concede papéis nem substitui gates que exigem uma pessoa. Ferramentas de leitura não requerem aprovação. A lista explícita de ferramentas elegíveis fica no contrato MCP e no módulo `application/command-approvals`.
- Persistir bindings e estado na tabela `command_approvals` da migração v18. Os campos de binding são imutáveis; o estado só pode passar uma vez de pendente para consumido ou revogado.
- Os handlers MCP são síncronos. O servidor inicia uma transação `BEGIN IMMEDIATE`, valida aprovação, executa o comando de domínio em savepoint, consome o ID e grava `tool_approval.consumed` com executor e aprovador. Mutação, consumo e auditoria confirmam ou revertem juntos. Resposta de erro de domínio mantém a aprovação pendente; uma nova chamada concorrente depois do consumo recebe `APPROVAL_ALREADY_USED`.

## Consequências

- Cada autorização cobre apenas uma chamada e tem validade curta. Uma operação com payload ou versão diferente requer nova aprovação.
- Aprovação pode ser emitida por um cliente MCP humano e usada por um cliente MCP agente, sem inventar uma API ou token de autorização paralelo.
- O servidor persiste metadados de aprovação e auditoria, nunca o access token OIDC. O aprovador não substitui o executor como ator do evento de mutação.
- Uma aprovação não serve para contornar separação de funções, por exemplo publicar especificação ou certificar QA por agente. Esses gates humanos permanecem no serviço de domínio.
- A camada de servidor assume que os handlers aprovados não introduzirão `await` dentro da transação. Qualquer futuro handler assíncrono precisa preservar a mesma atomicidade antes de ser incluído na lista aprovável.

## Verificação

Testes cobrem emissão/replay, admin humano, executor provisionado, validade, hash independente da ordem das chaves, argumentos/projeto/ferramenta/executor/versão divergentes, expiração, revogação, consumo concorrente, replay e rollback da mutação se a auditoria de consumo falhar.
