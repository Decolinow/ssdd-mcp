# ADR 0027: Relatório de entrega por critério

- **Status:** Proposta implementada localmente; aguarda revisão de Tech Lead humano
- **Data:** 2026-11-13
- **Contexto:** "Entregar igual ao esperado" depende de o executor declarar, critério a critério, o que foi cumprido. Hoje a evidência é livre e a passagem para revisão não compara esperado e entregue.

## Decisão

1. `task_delivery_report_submit` grava um relatório por tarefa em `in_progress`, com uma entrada para **cada** critério do PBI pai e **cada** item do checklist da própria tarefa: `status` (`met`, `partial`, `not_met`, `not_applicable`), `evidence`, `assumptions` e `deviations`. `met` e `partial` exigem evidência; `not_applicable` exige a suposição que o justifica.
2. Relatórios são imutáveis (triggers de `UPDATE`/`DELETE`) e numerados por tarefa (`report_number`). Reenviar cria o próximo número; o último vale.
3. `in_progress → in_review` é bloqueado (`GATE_BLOCKED`) quando o último relatório tem `not_met` ou não cobre mais os critérios vigentes. **Sem relatório**, a transição é permitida por padrão para não quebrar fluxos existentes; o host pode exigir o relatório com `SSDD_REQUIRE_DELIVERY_REPORT=1` (política de adoção gradual, sem mudar o contrato).
4. A Definition of Done vigente no `task_start` é pinada por tarefa (SSDD-943) e entra no relatório como entradas `scope: dod` (chave = ID do critério da DoD). O gate Done do PBI `definition-of-done-attested` exige `met` ou `not_applicable` nelas; revisão posterior da DoD gera apenas aviso no contexto.
5. O relatório aceita `changeSet` (branch, commits, caminhos) e a tarefa pode declarar um escopo de caminhos (`task_scope_set`, SSDD-944); caminhos fora do escopo viram o achado `out_of_scope_change`, nunca bloqueio.
6. `task_delivery_report_get` devolve o esperado e os relatórios para comparar esperado × entregue.

## Consequências

- O revisor vê exatamente o que o executor afirmou, com suposições e desvios de escopo explícitos.
- `task_accept` não gera relatório: com `SSDD_REQUIRE_DELIVERY_REPORT=1` ele falha no gate e reverte a cadeia até que um relatório seja enviado.
- A visão lado a lado no dashboard fica fora desta entrega; a comparação é feita por `task_delivery_report_get`.

## Verificação

- `tests/application/task-delivery-reports.test.ts` cobre cobertura total, evidência obrigatória, numeração, imutabilidade, bloqueio por `not_met` e o modo opt-in.
