# Demo local: PO → Tech Lead → Dev → QA → Release

## Rodar a demo reproduzível

Com Node.js 24 ou 26 e npm 10 ou superior:

```sh
npm ci
npm run demo
```

O comando compila o MCP, cria um workspace temporário, conecta um cliente MCP stdio real e executa uma trilha completa. A demo cria um épico, feature e PBI, publica um cenário coberto pelo critério, confirma estimativa, verifica os gates de Ready, cria a baseline, anexa evidência ao build, registra uma execução aprovada, certifica QA e transiciona o PBI para Done. O workspace temporário é removido ao terminar.

A saída confirma o PBI, a sequência da baseline, o build candidato, a execução certificada e o estado final `done`. O teste equivalente de integração MCP fica em `tests/mcp/workflow-stdio.test.ts` e é executado por `npm run check`.

## E2E de release com papéis e dashboard

```sh
npm run demo:release
```

Este fluxo cria um issuer/JWKS temporário de teste em loopback, provisiona PO, Tech Lead, Developer, QA e Release Manager como identidades distintas e conecta cinco clientes MCP com perfis filtrados. PO cadastra o PBI; Tech Lead publica um contrato API e liga a especificação à tarefa; QA publica cenário ligado ao critério e à tarefa; Developer confirma estimativa, inicia sessão com as revisões técnicas/cenário fixadas, implementa, envia evidência e conclui a tarefa; QA registra e certifica o resultado; Release Manager tenta produção antes da homologação e recebe bloqueio, registra homologação e promove a mesma build a produção. O teste confirma a matriz de tools de cada perfil e que o dashboard servido localmente mostra o PBI em `done`. O workspace e chaves de teste são efêmeros; nenhum tenant externo é usado.

## Configurar um cliente MCP local

Para validar o pacote CLI antes de configurar o cliente:

```sh
npm run build
npm pack
npm install --global ./ssdd-mcp-0.1.0.tgz
ssdd-mcp init --workspace ./payments-demo --key PAY --name "Payments demo" --goal "Entrega rastreável" --timezone America/Sao_Paulo
```

Adicione um servidor stdio à configuração MCP do cliente. O formato abaixo usa `mcpServers`; mantenha o mesmo `command` e `args` se o cliente usar outra estrutura JSON:

```json
{
  "mcpServers": {
    "ssdd": {
      "command": "ssdd-mcp",
      "args": [
        "stdio",
        "--workspace",
        "C:\\work\\payments-demo"
      ],
      "env": { "SSDD_PROFILE": "dev" }
    }
  }
}
```

No modo local, o processo usa a identidade do sistema operacional e `SSDD_PROFILE` pode limitar as tools visíveis. No primeiro startup do host, essa identidade se torna o admin único da instância e recebe uma authKey impressa uma vez em `stderr`; admin cria usuários/chaves por `user_create`. Para uma identidade gerenciada no stdio, injete `SSDD_AUTH_KEY` a partir do ambiente/secret manager. Para Streamable HTTP, envie `Authorization: Bearer <authKey>`; no modo de equipe OIDC também pode ser usado com `ssdd-mcp access grant/revoke`. `X-SSDD-Profile` seleciona a superfície HTTP. A autenticação identifica a pessoa, memberships conferem acesso por projeto e perfis não concedem papéis. O transporte local não separa processos que compartilham a mesma conta do sistema. Aprovação delegada de uso único continua em SSDD-602.

## Reproduzir o fluxo pelas ferramentas

Use os IDs e versões devolvidos pelas ferramentas anteriores em cada chamada:

1. PO cria épico, feature e história com critérios. QA cria e publica um cenário para cada critério obrigatório.
2. Developer propõe pontos e uma pessoa Developer confirma. `work_item_gate_check` para `ready` mostra critérios ainda faltantes.
3. PO chama `work_item_transition` para `ready`. A resposta inclui a baseline criada junto com a transição.
4. Developer avança o item, adiciona evidência com `evidence_add` e o `buildId` candidato, e envia para revisão/validação.
5. QA registra o resultado publicado com `test_run_record` e uma pessoa QA chama `test_run_certify` para a execução aprovada mais recente.
6. Developer verifica `work_item_gate_check` para `done` com o mesmo build e conclui o PBI somente quando todos os gates passam.

Contratos, papéis, versões esperadas e erros estão em [Contrato MCP](mcp.md#workflow-evidências-e-certificação).
