# ADR 0022 · Início atômico de tarefa e coordenação de agentes

- **Status:** proposta implementada localmente; aguarda revisão de Tech Lead
- **Data:** 2026-11-12
- **Contexto:** transicionar uma tarefa Ready e abrir sua sessão em chamadas separadas deixa uma janela em que o item pode aparecer em desenvolvimento sem responsável/sessão, ou mais de um agente pode tentar começar. Dependências diretas e decisões técnicas também precisam ser verificadas sempre no momento da escrita. O estado atual ainda não tem reserva de arquivos Git nem eventos gerais de bloqueio.

## Decisão proposta

1. Expor `task_start_check` como diagnóstico read-only, sem reserva ou promessa de que os gates permanecerão válidos.
2. Expor `task_start` como comando idempotente: sob `BEGIN IMMEDIATE`, reler versão, estado, papel e atribuição, PBI pai/baseline, dependências diretas, ADRs `implements` e sessões; se válido, gravar transição Ready → `in_progress`, sessão, pinning de revisões e auditoria na mesma transação. Rejeitar o bypass por `work_item_transition` com `USE_TASK_START`.
3. Não permitir exceção humana para iniciar com dependência direta incompleta. Um ADR marcado `implements` precisa de revisão publicada; `relates_to` continua apenas informativo. A aprovação/publicação do ADR é um gate humano separado.
4. Tratar uma sessão pausada como handoff explícito. O Developer dono retoma sua própria sessão ou a encerra/cancela; uma pessoa reatribuída não herda nem pode retomar a autoria anterior. A reassociação não fecha o histórico.
5. Para agentes em paralelo, exigir atribuição e sessão por tarefa e recomendar branch/worktree Git isolado. Declarar que isso reduz colisões locais, mas ainda não há lock de arquivo ou enforcement no MCP. Reserva auditável de caminhos e recuperação auditada de sessões órfãs são tarefas futuras SSDD-929 e SSDD-928.
6. Não chamar impactos abertos de “bloqueio manual”: hoje são gates calculados, dependências e impactos de especificação. Evento e duração de bloqueio, tempo de espera/ciclo e caminho crítico dependem de SSDD-930. A análise futura deve indicar cortes/watermarks, amostra e tarefas abertas censuradas, sem ranking de pessoas.

## Alternativas consideradas

- Manter `work_item_transition` e `development_session_start` separados: rejeitada por permitir transição sem sessão e duplicar a sequência nos clientes.
- Fazer `task_start_check` adquirir lock temporário: rejeitada porque diagnóstico é uma leitura potencialmente longa e um lock prévio não resolve concorrência após expiração. A escrita revalida a condição dentro da transação.
- Considerar qualquer relação a ADR como bloqueante: rejeitada; só `implements` declara decisão necessária, enquanto `relates_to` é informativa.
- Usar apenas sessions como exclusão mútua de agentes: rejeitada porque sessão serializa início da mesma tarefa, mas não concorrência sobre arquivos compartilhados entre tarefas.

## Consequências

- Qualquer tentativa de iniciar tarefa Ready deve passar por uma única operação MCP/API com controle otimista e idempotência.
- Falhas antes do commit não deixam estado `in_progress`, sessão ou auditoria parcial.
- A consistência dos metadados de tarefa é garantida pelo SQLite; a consistência dos arquivos Git continua a cargo do fluxo de worktrees e da revisão humana até existir claim de caminhos.
- Métricas temporais de bloqueio não podem ser deduzidas corretamente do estado atual e não devem aparecer como se fossem observadas.

## Validação

- Testes da aplicação verificam dependência pendente, ADR Draft em `implements`, handoff de sessão pausada, idempotência, versão concorrente, bypass da transição direta e rollback sem efeitos parciais.
- Testes MCP e HTTP devem verificar a mesma regra e contrato do dashboard, incluindo CSRF e retorno de impedimentos.
- Testes de ADR verificam criação Draft, busca paginada, tipos de endpoints e a diferença funcional entre `implements` e `relates_to`.
- A decisão só passa a aceita depois de revisão humana de Tech Lead e de sincronização da revisão correspondente ao catálogo MCP.

## Referências

- [Especificação funcional](../specification.md#workflow)
- [Contrato MCP](../mcp.md#workflow-evid%C3%AAncias-e-certifica%C3%A7%C3%A3o)
- [Dashboard](../dashboard.md#in%C3%ADcio-seguro-de-tarefa)
- [Arquitetura](../architecture.md#componentes)
