# ADR 0030: Origem de execução de teste e confiança em CI

- **Status:** Proposta implementada localmente (fatias 1 e 2 de SSDD-941/SSDD-163); aguarda revisão de Tech Lead humano
- **Data:** 2026-11-13
- **Contexto:** `test_run_record` gravava apenas "alguém disse que passou". Um agente podia registrar `passed` sem nenhuma prova independente, e nada distinguia essa observação de um resultado vindo de pipeline.

## Decisão

1. Cada execução (`test_runs`) ganha `origin` (`agent`, `human`, `ci`; padrão `agent`) e `evidence_sha256` opcional (64 hex minúsculos) para o anexo.
2. `agent` e `human` continuam sendo **observações**, como antes. Certificar segue exigindo QA humano (ADR do gate de certificação); a origem não substitui a certificação.
3. `origin: "ci"` só é aceito quando o `buildId` tem a forma `git-<sha>` (7–40 hex) **e** existe, para o projeto, um evento `workflow_run` recebido por webhook com `status=completed`, `conclusion=success` e `head_sha` começando por esse `<sha>`. Sem isso o comando falha com `VALIDATION_FAILED` e diz o que falta. O registro continua sendo feito por Developer ou QA; a origem `ci` afirma que há um workflow de sucesso para o mesmo commit, não que o resultado foi lido do pipeline.
4. A origem faz parte do payload auditado (`test_run.recorded`) e é exposta em `test_run_list` e nos resultados por build de `scenario_criterion_search`.

## Fatia 2 (SSDD-163)

5. `test_run_import_junit` lê um relatório JUnit e grava uma execução por cenário, associando por tag: a chave do cenário publicado aparece como token inteiro no nome, no `classname` ou na property `scenario` do `testcase`. Falha vence, `skipped` só se todos foram ignorados, e o SHA-256 do XML vai em `evidence_sha256`. DOCTYPE e entidades são recusados; nada é expandido.
6. Com a política `strict` (ADR 0029), `test_run_certify` só aceita execução de origem `ci` quando o cenário não é `manual`. `lite` e `standard` não mudam.

## Ainda fora do escopo

- Importar Cucumber (só JUnit foi implementado) e relatórios com tag por outro atributo.
- Evidência `verified` derivada diretamente do `workflow_run`: hoje se valida a existência de um run de sucesso para o commit, não o conteúdo do pipeline.
- Qualquer verificação contra a API do GitHub: o servidor só confia em eventos já recebidos pelo webhook assinado.
- O importador aceita o XML como argumento da tool; não busca artefatos de CI sozinho.

## Consequências

- Registros antigos migram com `origin = agent` e sem hash.
- Sem webhook configurado, `ci` fica indisponível; a recusa é explícita. Isso é intencional: confiança não se declara.
- O vínculo é por SHA do commit, não por job nem por resultado de teste individual. Um workflow de sucesso para o commit não prova que aquele cenário foi executado.

## Verificação

- `tests/application/scenarios.test.ts` também cobre o importador (agrupamento, hash, idempotência, DOCTYPE, relatório sem cenário), e `tests/application/work-item-workflow.test.ts` cobre a certificação sob `strict`.
- `tests/application/scenarios.test.ts` cobre padrão `agent`, `human`, hash normalizado e rejeitado, `ci` recusado sem run, com run em falha, com SHA diferente, e aceito com run de sucesso do mesmo commit; confere a listagem.
