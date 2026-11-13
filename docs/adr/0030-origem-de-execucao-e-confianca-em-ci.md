# ADR 0030: Origem de execução de teste e confiança em CI

- **Status:** Proposta implementada localmente (fatia 1 de SSDD-941); aguarda revisão de Tech Lead humano
- **Data:** 2026-11-13
- **Contexto:** `test_run_record` gravava apenas "alguém disse que passou". Um agente podia registrar `passed` sem nenhuma prova independente, e nada distinguia essa observação de um resultado vindo de pipeline.

## Decisão

1. Cada execução (`test_runs`) ganha `origin` (`agent`, `human`, `ci`; padrão `agent`) e `evidence_sha256` opcional (64 hex minúsculos) para o anexo.
2. `agent` e `human` continuam sendo **observações**, como antes. Certificar segue exigindo QA humano (ADR do gate de certificação); a origem não substitui a certificação.
3. `origin: "ci"` só é aceito quando o `buildId` tem a forma `git-<sha>` (7–40 hex) **e** existe, para o projeto, um evento `workflow_run` recebido por webhook com `status=completed`, `conclusion=success` e `head_sha` começando por esse `<sha>`. Sem isso o comando falha com `VALIDATION_FAILED` e diz o que falta. O registro continua sendo feito por Developer ou QA; a origem `ci` afirma que há um workflow de sucesso para o mesmo commit, não que o resultado foi lido do pipeline.
4. A origem faz parte do payload auditado (`test_run.recorded`) e é exposta em `test_run_list` e nos resultados por build de `scenario_criterion_search`.

## Fora desta fatia (segue como backlog)

- Importar JUnit/Cucumber e associar resultados a cenários por tag.
- Política de projeto exigindo origem `ci` para cenários `automated`.
- Evidência `verified` derivada diretamente do `workflow_run` (hoje só se valida a existência do run de sucesso).
- Qualquer verificação contra a API do GitHub: o servidor só confia em eventos já recebidos pelo webhook assinado.

## Consequências

- Registros antigos migram com `origin = agent` e sem hash.
- Sem webhook configurado, `ci` fica indisponível; a recusa é explícita. Isso é intencional: confiança não se declara.
- O vínculo é por SHA do commit, não por job nem por resultado de teste individual. Um workflow de sucesso para o commit não prova que aquele cenário foi executado.

## Verificação

- `tests/application/scenarios.test.ts` cobre padrão `agent`, `human`, hash normalizado e rejeitado, `ci` recusado sem run, com run em falha, com SHA diferente, e aceito com run de sucesso do mesmo commit; confere a listagem.
