# ADR 0026: Contrato de erros das tools e recuperação dos agentes

- **Status:** Proposta implementada localmente; aguarda revisão de Tech Lead humano
- **Data:** 2026-11-12
- **Contexto:** Agentes automatizam chamadas MCP e precisam distinguir sucesso, erro de domínio, conflito concorrente, falha interna e resultado de mutação incerto após timeout. A resposta não pode expor argumentos, credenciais ou mensagens inesperadas da infraestrutura.

## Decisão

1. Erros de aplicação em tools MCP retornam `isError: true` com envelope JSON textual contendo `code`, `message`, `details`, `retryable` e `correlationId`; o retorno de erro não inclui `structuredContent` com o schema de sucesso.
2. Exceções inesperadas são normalizadas para `INTERNAL_ERROR` com mensagem genérica. O host escreve `correlationId` e classe da exceção em `stderr`, sem registrar mensagem, payload, credenciais ou detalhes fornecidos pelo cliente.
3. `retryable` na resposta é a única indicação de retry; clientes não inferem retry pela família do código. Retry tem backoff limitado e mantém o mesmo `requestId` e payload para comandos idempotentes.
4. Timeout/erro de transporte durante mutação deixa o resultado desconhecido para o cliente: ele deve consultar o estado antes de emitir uma nova mutação. Conflito de versão/cursor exige releitura e reconciliação.
5. Instruções geradas para Claude Code, Codex e OpenCode devem ordenar os agentes a reconhecer `isError`, parar o fluxo dependente e preservar/repassar `correlationId` em `INTERNAL_ERROR`.

## Consequências

- Agentes não confundem respostas de erro que têm conteúdo textual com envelopes de sucesso.
- A mensagem enviada ao agente não revela exceções internas; operadores podem localizar a ocorrência pelo ID de correlação no `stderr` do host.
- O indicador `retryable` continua específico da causa. A interface HTTP retorna `409` para conflitos de estado/versão no claim da home.

## Verificação

- Testes MCP verificam envelope genérico, redaction e correlação para falha inesperada transacional.
- Testes do instalador verificam as instruções de erro/retry nos agentes dos três clientes.
- Testes do dashboard verificam status 409 e `retryable=false` nos conflitos de claim.

## Referências

- [Contrato MCP](../mcp.md)
- [Instalação de agentes](../agent-installer.md)
- [Início da tarefa e claim](0022-inicio-atomico-e-coordenacao-de-agentes.md)
