# ADR 0015 · Histórico de execuções QA no MCP

**Status:** Aceita  
**Data:** 2026-11-10

## Contexto

A aplicação já registrava execuções QA de forma imutável e o dashboard consultava as 100 mais recentes. O catálogo MCP permitia registrar/certificar execuções e consultar um run por ID conhecido, mas não permitia descobrir o histórico completo por cenário/build. O agente precisava adivinhar o ID ou repetir consultas por critério.

## Decisão

- Expor `test_run_list` como consulta read-only com filtros opcionais por cenário, build e resultado, limite de 1–100 e ordenação por sequência decrescente.
- Usar paginação keyset (`sequence < beforeSequence`) e vincular o cursor ao projeto, principal, filtros, limite e maior sequência que corresponde à consulta.
- Retornar `STALE_CURSOR` se uma nova execução compatível com os filtros for registrada; outras consultas não invalidam o cursor.
- Criar índices `(project_id, sequence DESC)` e `(project_id, scenario_id, sequence DESC)` em migração aditiva, preservando os registros append-only.
- Orientar prompts e skill QA a consultar `test_run_list` e chamar `test_run_record` somente após observação real de uma execução.

## Consequências

Agentes podem revisar resultados anteriores sem permissão de escrita e continuar páginas de forma estável. Gravações de execução continuam exigindo papel, auditoria e aprovação humana para agentes/serviços; a consulta não substitui certificação QA. Os dois índices aumentam modestamente o custo de escrita/armazenamento em troca de consultas previsíveis no histórico crescente.

## Validação

Testes cobrem filtros, ordem, paginação, cursor associado à identidade e filtros, invalidação após nova execução, migração dos índices e uso da tool por cliente MCP stdio.
