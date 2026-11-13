# Análise do catálogo de ferramentas MCP (2026-11-13)

Pedido: o catálogo parece grande demais; refinar, procurar redundância e melhorias. Medição com `node scripts/mcp-context-cost.mjs` (tamanho serializado de `tools/list`, ~3,6 bytes por token).

## Diagnóstico

- **124 ferramentas.** Conectar um agente custa o `tools/list` do perfil dele, não o do catálogo inteiro. Antes desta análise: `full` ≈ 180 mil tokens, `po` ≈ 106 mil, `tech_lead` ≈ 99 mil, `dev` ≈ 70 mil.
- **O custo vinha menos da quantidade e mais de schemas de saída duplicados.** As 7 tools de sprint pesavam ~23 KB cada porque `sprintSchema` embutia `teamCapacityReport` e `definitionOfDone` várias vezes. `task_context_get`/`task_briefing_get` repetiam 9 vezes o mesmo schema de entrada e `task_workflow_get` embutia a revisão três vezes.

## Já aplicado (esta revisão)

| Mudança | Efeito |
| --- | --- |
| `.meta({ id })` nos schemas reutilizados (capacidade, DoD, escopo de sprint, entrada de contexto, etapa e revisão de workflow): o JSON Schema passa a usar `$ref`. | `task_workflow_get` 15,7 → 7,7 KB; `task_context_get` e `task_briefing_get` menores. |
| Snapshots e histórico de `Sprint` tipados como objetos abertos com descrição (contrato em `docs/mcp.md`). | Cada tool de sprint 23 → ~7 KB. |
| `scripts/mcp-context-cost.mjs` e `tests/scripts/mcp-context-cost.test.ts`: limite por perfil em bytes (catraca). | Regressões de custo falham no `npm run check`. |

Resultado: `full` 646 → 502 KB (-22%); `po` 106 → 77 mil tokens; `facilitator` 74 → 39 mil; `dev` 70 → 63 mil; `tech_lead` 99 → 92 mil.

## Aplicado depois: consolidações seguras

- `adr_create` e `adr_search` removidas: eram aliases exatos de `spec_create` (`kind: "adr"`) e `spec_list` (`kind: "adr"`, `search`). Catálogo: 124 → 122 tools. Perfis, anotações, aprovações, hints, testes, docs e a matriz de UI foram atualizados.
- As demais candidatas abaixo continuam abertas por mudarem contrato ou fluxo de gate (get/list, métricas, importadores, sessão).

## Redundâncias e consolidações candidatas

Ordenadas por ganho. Nenhuma foi aplicada: mudam contrato, skills, perfis e a matriz de paridade, então exigem decisão.

1. **`adr_create` e `adr_search` duplicam `spec_create` (tipo ADR) e `spec_list`.** O dashboard já cria ADR pelo fluxo de especificações. Manter só `adr_link_task` (ou virar `trace_link_add`). -2 tools.
2. **Pares `get`/`list` do mesmo recurso** (`sprint`, `milestone`, `scenario`, `spec`, `team_list`/`team_capacity_get`): uma tool com chave opcional devolve um item ou a lista paginada. -4 a -5 tools.
3. **Transições de sprint (`sprint_start`, `sprint_close`, `sprint_cancel`)** poderiam ser `sprint_transition` com `toState`, como `work_item_transition`. Cada uma exige campos próprios e gate humano diferente, então o ganho é menor que o risco; avaliar só se o orçamento de `facilitator` voltar a apertar.
4. **`task_start` e `development_session_start`**: o primeiro já abre a sessão atomicamente. Se nenhum fluxo usa a sessão sozinha, aposentar a segunda. -1.
5. **`task_briefing_get` e `task_context_get`**: o briefing já embute o contexto com os mesmos parâmetros. Uma tool com `view: "briefing" | "context"` evita dois schemas de ~14 KB. -1.
6. **Quatro tools de métricas** (`metrics_get`, `flow_metrics_get`, `developer_execution_metrics_get`, `delivery_quality_metrics_get`): um `metrics_get` com `report` enumerado. SSDD-951 as separou de propósito para manter `metrics_get` enxuto; o `report` atende ao mesmo objetivo se o schema de saída ficar aberto por relatório. -3.
7. **`file_claim_*` (4 tools)**: `acquire` e `renew` são a mesma operação idempotente (renovar uma posse existente). -1 a -2.
8. **Manutenção que não precisa de agente**: `roadmap_id_bind/list/resolve` (o alias `SSDD-###` já é resolvido pelo parâmetro de item), `work_item_semantic_index`, `development_session_recover/stale_list`. Mover para CLI/script ou limitar ao perfil `admin`. -3 a -6 no catálogo de agente.
9. **Importadores**: `github_*` e `azure_*` (4 tools) viram `work_item_import_preview/apply` com `provider`. -2.
10. **Configuração do projeto**: `gate_policy_get/set` e `project_guidance_get/set` poderiam ser um par `project_config_*`. -2.

Somando os itens 1, 2, 4, 5, 6 e 9 (sem mexer em fluxos de gate humano): de 124 para cerca de 105 tools, mais perfis menores.

## Melhorias independentes de consolidar

- **Orçamento em bytes, não em contagem**: a catraca nova mede o que o agente paga. O teste antigo de contagem por perfil continua.
- **`work_item_quality_get` (13 KB)** é agora o maior: avaliar o mesmo tratamento de snapshots abertos.
- **Descrições**: `tool-hints.ts` anexa pré-condição e erro comum a toda escrita; vale auditar as 20 maiores descrições (`approval_issue` com 6,5 KB é suspeita).
- **Perfil `tech_lead` com 85 tools** ainda acumula leitura de todos os perfis; reavaliar se precisa do `refinement` e `test_design` completos.
- **Paridade com o dashboard**: 57 das 124 tools não têm UI (ver [dashboard-parity-matrix.md](dashboard-parity-matrix.md)); consolidar antes de construir UI evita trabalho duplicado.

## Como medir de novo

```bash
npm run build && node scripts/mcp-context-cost.mjs
```
