# ADR 0006 · Cache de projeção do dashboard de métricas

- **Status:** Aceito
- **Data:** 2026-11-10
- **Contexto:** SSDD-505

## Contexto

O dashboard e `metrics_get` compartilham uma projeção que reconstrói dados de todo o projeto a partir de snapshots e eventos auditados. Em projetos com 10 mil PBIs, reconstruir a projeção para cada requisição concorrente aumenta a latência e serializa o acesso síncrono ao SQLite. A tabela de cobertura também era muito maior que o drill-down visível, embora os totais precisem considerar todos os PBIs.

## Decisão

- Reutilizar em memória a projeção completa por até 1 segundo, com no máximo 32 chaves por conexão SQLite. O cache usa `WeakMap` pela conexão para não cruzar workspaces nem manter conexões fechadas vivas.
- A chave inclui projeto, principal, `asOfDate` normalizada e seleções de marco/sprint.
- Antes de cada reaproveitamento, o serviço valida novamente a associação do principal e lê o watermark de auditoria dentro da transação SQLite. Só reutiliza o valor quando o watermark é igual e a janela de 1 segundo ainda está válida.
- Guardar e devolver `structuredClone` da projeção para que consumidores não alterem o valor em cache. Comando auditado invalida o resultado pelo watermark; a janela curta limita a idade do campo `observedAt` quando não há mudança.
- A projeção de cobertura devolve até 20 registros em `items`. `itemsTotal`, `itemsTruncated`, percentuais e contagens são calculados sobre o projeto inteiro. A interface abre o detalhe do PBI para inspeção individual.
- Não usar cache distribuído nesta fase. Cada processo mantém seu próprio cache efêmero, e a autorização e os dados vêm sempre da base SQLite atual do processo.

## Consequências

- Leituras repetidas com a mesma seleção evitam reconstrução enquanto o watermark não mudar. Uma alteração auditada é visível na próxima chamada.
- A primeira leitura após uma mudança continua executando a reconstrução integral. O limite de 20 itens reduz o payload retornado, mas não reduz o conjunto usado nos agregados globais.
- `observedAt` registra a montagem da projeção e pode ser compartilhado por chamadas que reutilizam o mesmo valor.
- O contrato MCP/API sinaliza detalhes limitados explicitamente; clientes que precisem de mais contexto consultam o detalhe do PBI.

## Validação

Em 2026-11-10, Node 24.18.0, Windows x64 e Intel Core i5-11400H, `npm run benchmark:metrics` usou 10 mil PBIs, 50 mil eventos sintéticos, três sprints históricas válidas e 10 mil simulações Monte Carlo por projeção. Mediu 12 reconstruções frias (p50 119,05 ms; p95 132,18 ms), uma onda fria de cinco clientes MCP (p95 154,74 ms), 100 leituras aquecidas concorrentes (p50 28,35 ms; p95 37,10 ms) e 100 gravações simples (p95 80,07 ms). As metas de leitura p95 ≤ 300 ms e gravação p95 ≤ 500 ms foram atendidas. A previsão retornou `forecast_ready` com três amostras e 10 mil simulações. Testes cobrem os totais com truncagem, isolamento da cópia retornada e invalidação após mudança auditada.
