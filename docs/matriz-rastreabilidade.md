# Matriz de rastreabilidade do backlog (SSDD-925 / tarefa SSDD-127)

**Auditado em:** 2026-11-13, via grafo MCP (`trace_links`) e `work_item_get`.

## Resultado

| Medida | Antes | Depois |
| --- | ---: | ---: |
| Tarefas não canceladas | 122 | 122 |
| Sem especificação ligada | 33 | 1 (SSDD-144, ver abaixo) |
| Histórias com critério obrigatório e cenário publicado | 18 de 19 | 18 de 19 |
| Critérios obrigatórios certificados | 43/43 | 43/43 |

32 vínculos novos. Cada vínculo foi escolhido pelo escopo do título da tarefa; não houve associação em lote com um documento genérico. Todos são `relates_to`: nenhuma tarefa foi marcada como `implements` porque as especificações descrevem o domínio, não uma única tarefa.

## Vínculos criados em 2026-11-13

| Especificação | Tarefas |
| --- | --- |
| `SSDD-NFR-OPS-01` | SSDD-7 (workspace/CI), SSDD-8 (SQLite/WAL/FTS5), SSDD-132 (worktrees e reservas) |
| `SSDD-ARCH-2026-01` | SSDD-9 (CLI e schema), SSDD-156 (dividir server.ts), SSDD-157 (modularizar dashboard) |
| `SSDD-BR-CORE-01` | SSDD-10, 130, 142, 145, 146, 150, 152, 160, 162 (identidade, ADR, prontidão, revisão independente, DoD, política de gates, modelos, baseline) |
| `SSDD-API-MCP-01` | SSDD-11, 129, 131, 140, 147, 148, 149, 151, 153, 155, 158, 161 (transporte, início de tarefa, sessões, home por papel, briefing, tools, skills) |
| `SSDD-BR-QUALITY-01` | SSDD-141, 143 (critérios estruturados, relatório de entrega) |
| `SSDD-BR-METRICS-01` | SSDD-133, 154 (tempo de ciclo, qualidade de entrega) |
| `SSDD-BR-PRIORITY-01` | SSDD-159 (fila entregue-local) |

## Lacunas e warnings declarados

- **SSDD-144 (evidência verificada por CI):** só recebe especificação quando a decisão sobre origem de execução for publicada; ver o escopo da tarefa.
- **Draft sem cenário permanece não pronto:** 4 épicos e 14 features seguem em Draft e sem critérios próprios. Eles são agrupadores; a cobertura QA vive nas histórias e tarefas filhas.
- **Testes automatizados não viram certificação humana.** A certificação das 18 histórias em Done foi feita por delegação do QA, sobre builds locais, e está declarada assim nas notas dos runs.
- **Paginação:** `work_item_list` com `limit` 100 devolveu todos os 41 itens abertos em uma página (`nextCursor` nulo).
