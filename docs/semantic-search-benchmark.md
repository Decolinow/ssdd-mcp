# Benchmark e SLOs da busca semântica (SSDD-923)

`tests/application/semantic-search-benchmark.test.ts` mede a busca exata (`work_item_semantic_index` / `work_item_semantic_search`) com um provedor determinístico offline (vetores de 384 dimensões derivados de hash), sem rede nem credencial, em workspaces temporários com 1.000, 5.000 e 10.000 itens. `SSDD_BENCH_SCALES=1000,5000` reduz as escalas em máquinas lentas. O teste imprime um JSON por execução.

## Baseline (Node 24, Windows 11, SQLite local, 2026-11-12)

| Itens | Indexação total | Por item | Busca fria p50 / p95 | Busca aquecida p50 / p95 | Consultas SQL por busca | Banco | Heap extra na busca |
|---:|---:|---:|---|---|---:|---:|---:|
| 1.000 | 187 ms | 0,19 ms | 27,9 / 32,4 ms | 21,8 / 24,0 ms | 7 | 9,0 MB | 3,9 MB |
| 5.000 | 995 ms | 0,20 ms | 131,5 / 135,0 ms | 113,7 / 127,2 ms | 7 | 40,1 MB | 6,8 MB |
| 10.000 | 1.927 ms | 0,19 ms | 321,5 / 341,1 ms | 305,6 / 319,3 ms | 7 | 78,8 MB | 6,7 MB |

- **Escala:** o custo da busca é linear nos itens (varredura exata) e o número de consultas SQL é constante (7). O banco cresce cerca de 7,9 KB por item com 384 dimensões.
- **Frio × aquecido:** fria é a primeira busca em conexão recém-aberta; a diferença é pequena porque a varredura domina.
- **Rede:** a indexação usa lotes de até 200 itens (71 a 204 chamadas ao provedor conforme a escala); uma busca com índice completo faz uma chamada (a consulta).
- **Rejeição antes da rede:** um projeto com mais de 10.000 itens falha com `SEMANTIC_SEARCH_PROJECT_TOO_LARGE` sem nenhuma chamada ao provedor (teste dedicado).

## SLOs adotados (verificados pelo teste)

Valores propositalmente folgados (cerca de 10× a baseline) para pegar regressões de ordem de grandeza, não ruído de máquina:

| Métrica | Limite |
|---|---|
| Indexação | ≤ 5 ms por item |
| Busca aquecida p95 | ≤ 400 ms (1.000), ≤ 1.500 ms (5.000), ≤ 3.000 ms (10.000) |
| Crescimento de heap durante buscas | ≤ 512 MB |
| Itens por projeto na busca exata | ≤ 10.000 |

Acima de 10.000 itens a evolução é um índice aproximado (fora do escopo desta tarefa). Dimensões reais maiores (até 8.192) aumentam banco e tempo proporcionalmente; reexecute o benchmark ao trocar de modelo.
