# ADR 0016 · Implantação compartilhada por Streamable HTTP

- **Status:** aceito
- **Data:** 2026-11-10
- **Contexto:** equipes precisam conectar vários clientes MCP a uma instalação que contém mais de um projeto. O servidor HTTP atual usa SQLite em arquivo local, combina clientes modernos stateless e clientes legacy com sessão em memória e aplica RBAC por projeto.

## Decisão

- Executar uma instância ativa do SSDD por workspace, no mesmo host do arquivo SQLite. O endpoint HTTP permanece em `127.0.0.1` e é publicado por proxy TLS com OIDC.
- Publicar `/mcp` e `/.well-known/oauth-protected-resource/mcp`; manter `/healthz` e `/readyz` apenas na rede operacional interna.
- Selecionar projeto no cliente chamando `project_list`, pedir uma escolha explícita quando houver mais de um e enviar o UUID selecionado em todo argumento `projectId`. Não manter “projeto ativo” global ou ligado à sessão do transporte.
- Tratar `2026-07-28` como protocolo sem sessão. Clientes legacy podem ter sessão em memória; restart exige reconexão e futura escala horizontal legacy exigiria afinidade de sessão.
- Não considerar esta topologia uma implantação multi-node/HA. Protocolo stateless não altera os limites de concorrência do banco SQLite compartilhado.

## Consequências

- Vários clientes e projetos podem compartilhar com segurança uma instância OIDC com autorização revalidada por chamada e por projeto.
- Um cliente não pode alterar o contexto de outro cliente ao trocar de projeto; a seleção pertence à chamada e ao estado explícito do próprio cliente.
- O operador mantém disponibilidade por supervisor, probes internas, backup e restauração testada. Failover automático e métricas completas continuam no roadmap.
- Sessões legacy são voláteis. O identificador de futura sessão de desenvolvimento será dado de domínio independente de `Mcp-Session-Id`.

## Referências

- [Runbook do servidor de equipe](../team-server.md)
- [Contrato MCP](../mcp.md)
- [MCP Streamable HTTP 2026-07-28](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx)
- [SDK TypeScript · serving HTTP](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)
