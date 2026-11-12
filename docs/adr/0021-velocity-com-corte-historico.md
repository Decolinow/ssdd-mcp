# ADR 0021: velocity respeita corte histórico e geração de time

- **Status:** Proposta implementada localmente; `SSDD-BR-METRICS-01`, revisão 1, publicada no MCP após revisão PO. O cenário QA associado permanece Draft, sem execução ou certificação.
- **Data:** 2026-11-11
- **Contexto:** `metrics_get` e o dashboard recebem `asOfDate`, mas a consulta de velocity lia sprints fechadas sem limitar a data. A mesma lista também podia combinar sprints de gerações diferentes de composição de time. Isso fazia consultas históricas mostrarem entregas futuras e misturava amostras incomparáveis.

## Decisão

1. Interpretar `asOfDate` como o fim do dia no fuso do projeto. A consulta SQL exclui sprints fechadas a partir do início do dia local seguinte.
2. Selecionar, no mesmo corte, a geração de composição do time cuja configuração versionada estava vigente. A projeção informa `selectedTeamGenerationNumber` e a amostra contém somente essa geração.
3. Calcular média e mediana de pontos por sprint sobre a amostra comparável, preservando sprints fechadas com zero pontos. Consultas sem sprints comparáveis retornam amostra vazia; não inventam taxa.
4. Definir velocidade oficial como pontos aceitos por sprint. `pointsPerHour` continua disponível como razão descritiva entre pontos aceitos e capacidade congelada. O forecast v2 não usa essa razão: reamostra pontos por sprint e ajusta os resultados pela capacidade disponível. Snapshots v1 continuam reproduzíveis com o algoritmo antigo.
5. Tratar os dados por desenvolvedor como esforço e calibração em horas. A contagem de tarefas concluídas é descritiva, não é velocidade de pontos individual nem ranking.

## Consequências

- Uma data histórica não incorpora sprints fechadas depois do dia selecionado.
- Mudanças de composição iniciam uma nova amostra de velocity; datas anteriores continuam usando a geração histórica correspondente.
- A UI apresenta média, mediana, tamanho da amostra e geração selecionada, e rotula pontos/hora como referência.
- Três sprints são o mínimo técnico do forecast v2, não uma garantia estatística de previsão confiável. A única sprint do workspace SSDD é uma simulação solo de 5 pontos e 60 horas, explicitamente insuficiente para caracterizar velocidade de produção.
- A busca da geração histórica usa o índice da chave `(project_id, team_id, version)` sobre as configurações imutáveis e uma leitura SQLite consistente; nenhuma migração é necessária.

## Validação

- `tests/application/metrics.test.ts` cobre exclusão de sprints posteriores ao corte e isolamento após troca de geração.
- A revisão de performance encontrou leitura de estimativas que percorria o histórico de auditoria inteiro. A migração v29 indexa `(project_id, event_type, entity_id, occurred_at, sequence)`; a consulta ordena primeiro pelo item, preservando a cronologia independente de cada tarefa e permitindo o plano indexado.
- `tests/application/forecasts.test.ts` cobre corte local, amostra mínima, sprints zero, isolamento de geração e reprodução determinística.
- `tests/dashboard/api.test.ts` cobre a geração retornada e mantém paridade do JSON entre API e `metrics_get`.
- No benchmark Windows/Node 24.18.0 com 10.000 itens e 50.000 eventos, a leitura MCP fria concorrente p95 caiu de 427 ms antes do índice para 177 ms depois; a reconstrução p95 ficou em 125 ms, leitura aquecida em 45 ms e gravação em 70 ms. Os números são referência deste host e fixture, não SLO universal.
- A revisão PO da regra está concluída e a revisão publicada é o contrato de negócio vigente. Os testes automatizados não substituem a publicação, execução e certificação do cenário de QA por uma pessoa QA.

## Referências

- [Especificação funcional](../specification.md#s%C3%A9ries-e-unidades)
- [Dashboard e projeções](../dashboard.md#s%C3%A9ries-e-unidades)
- [Catálogo MCP](../specification-catalog.md)
- `src/application/dashboard-metrics.ts`
- `src/application/metrics-queries.ts`
- `src/application/forecast-queries.ts`
