# ADR 0029: Política de gates por projeto

- **Status:** Proposta implementada localmente; aguarda revisão de Tech Lead humano
- **Data:** 2026-11-13
- **Contexto:** Projetos pequenos ou em descoberta não precisam do mesmo rigor de um projeto em release, e os endurecimentos recentes (relatório de entrega, revisão independente) hoje dependem de variáveis de ambiente do host.

## Decisão

1. Cada projeto tem uma política `lite`, `standard` ou `strict`, em revisões imutáveis e numeradas (`gate_policy_revisions`), definida por `gate_policy_set` (PO ou Tech Lead **humano**, motivo de 10+ caracteres, `expectedRevision`) e auditada. Sem revisão, vale `standard`.
2. `standard` é o comportamento anterior à política: nada muda.
3. `lite` dispensa apenas o gate de **cenário publicado por critério obrigatório** para o Ready de PBI. Baseline, evidência, certificação humana, bloqueio por `not_met` no relatório e por `changes_requested` na revisão continuam valendo. A certificação de QA já não exige pessoa diferente da execução, então `lite` não altera esse ponto.
4. `strict` torna **obrigatórios** o relatório de entrega (ADR 0027) antes de `in_review` e uma revisão humana independente aprovada para o relatório vigente (ADR 0028) antes de `in_validation`.
5. `SSDD_REQUIRE_DELIVERY_REPORT=1` e `SSDD_REQUIRE_INDEPENDENT_REVIEW=1` continuam como forçadores do host e valem acima da política.
6. Todo relatório de gates (`work_item_gate_check`) traz `policy.level` e `policy.revisionNumber`.

## Consequências

- Mudar a política não reprocessa itens já concluídos; ela vale a partir da próxima avaliação de gate.
- `task_accept` em projeto `strict` falha no gate de relatório, como já ocorria com as variáveis de ambiente.
- Rebaixar o rigor exige papel humano e deixa motivo e autor no histórico.

## Verificação

- `tests/application/gate-policy.test.ts` cobre padrão, versionamento, conflito de revisão, imutabilidade, bloqueio de agente, `lite` no Ready e `strict` nos dois gates.
