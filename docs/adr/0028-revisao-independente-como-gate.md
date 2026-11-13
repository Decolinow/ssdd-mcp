# ADR 0028: Revisão independente como gate

- **Status:** Proposta implementada localmente; aguarda revisão de Tech Lead humano
- **Data:** 2026-11-13
- **Contexto:** O mesmo principal costuma implementar e concluir a tarefa (aviso `self_validation`). O gate precisa de uma revisão registrada, de alguém que não trabalhou na tarefa, ligada ao relatório de entrega.

## Decisão

1. `review_record` grava `approved` ou `changes_requested` com achados opcionalmente ligados a critérios (`changes_requested` exige ao menos um achado). A tarefa precisa estar em `in_review`. O revisor não pode ter sessão de desenvolvimento na tarefa (`FORBIDDEN`).
2. A revisão guarda o número do último relatório de entrega (ADR 0027) no momento, ou `null` se não houver. Revisões são imutáveis; a mais recente vale.
3. Revisão por principal não humano é gravada como **consultiva** (`advisory`): aparece no histórico, mas não satisfaz o gate estrito.
4. `in_review → in_validation` é sempre bloqueado quando a revisão mais recente é `changes_requested`. Com `SSDD_REQUIRE_INDEPENDENT_REVIEW=1` também exige uma aprovação humana não consultiva para o relatório vigente. O padrão continua permissivo para não quebrar fluxos existentes; a ativação é decisão do host.

## Consequências

- Reenviar o relatório invalida aprovações antigas no modo estrito, porque o número do relatório muda.
- Agentes operam muitas vezes com a identidade do humano; o gate só distingue por tipo de principal e por sessão de desenvolvimento, não por pessoa física.
- `task_accept` falha no gate com `SSDD_REQUIRE_INDEPENDENT_REVIEW=1`, pois ele conclui em um único principal.

## Verificação

- `tests/application/task-reviews.test.ts` cobre impedimento do executor, bloqueio por `changes_requested`, imutabilidade, revisão consultiva e modo estrito.
