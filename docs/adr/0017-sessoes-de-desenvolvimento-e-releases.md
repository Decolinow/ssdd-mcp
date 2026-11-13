# ADR 0017 · Sessões de desenvolvimento e releases por tarefa

- **Status:** aceito
- **Data:** 2026-11-11
- **Contexto:** a transição de uma tarefa e sua estimativa planejada não registram quem executou o trabalho, por quanto tempo, quais revisões foram usadas ou quando a entrega foi homologada/implantada. Os clientes MCP modernos não têm sessão de transporte persistente e `Done` representa aceite do workflow/QA, não uma implantação.

## Decisão

- Manter sessão de desenvolvimento como entidade do domínio, com UUID próprio, tarefa, principal Developer, referência externa opcional, timestamps UTC, pausas, duração ativa, versão otimista e eventos append-only. O transporte/chat MCP não é a sessão de execução.
- Permitir start somente após a tarefa estar `in_progress` e atribuída ao principal Developer autenticado. Só o dono altera a própria sessão. Reatribuição preserva o histórico e a autoria da pessoa que trabalhou.
- Fixar no início as revisões publicadas das especificações `implements` diretamente ligadas e dos cenários QA associados à tarefa. Runs podem apontar para tarefa(s), revisão publicada e build exatas; `task_context_get` diferencia links diretos de decisões herdadas e alerta drift.
- Separar deployments do workflow. Eventos imutáveis guardam ambiente, build, release/pipeline, ator, data, resultado e rollback, com relações a tarefas/PBIs/marcos. Uma produção aprovada precisa de `Done` e homologação aprovada do mesmo build. Falhas e rollbacks não apagam eventos anteriores.
- Manter a velocidade de equipe em story points. Exibir esforço individual em horas, estimativas confirmadas e throughput. Datas usam o fuso local do projeto; cada item pertence à coorte pela última transição para Done dentro do intervalo e seu esforço inclui sessões encerradas até essa conclusão. Variação e fator usam somente tarefas da coorte com estimativa de horas confirmada; o fator `horas reais ÷ horas estimadas` exige ao menos cinco dessas tarefas. Não atualiza estimativas automaticamente nem ranqueia pessoas.
- Persistir aliases `SSDD-###` por projeto em uma tabela separada da chave de work item. O alias mapeado tem precedência ao resolver uma string ambígua; UUID é a forma segura de pedir a chave gerada que colide.
- Manter SQLite em um host e uma instância ativa. Sessões ativas sobrevivem a uma queda abrupta e exigem revisão humana; heartbeat/lease/recovery automático é uma lacuna conhecida. Não declarar alta disponibilidade nem tempos precisos durante indisponibilidade.

## Consequências

- Ferramentas MCP e dashboard compartilham serviços de aplicação; dashboard apresenta datas/histórico e métricas, mas as mutações de sessão/release são feitas pelo MCP nesta versão.
- Datas resumidas na tarefa derivam do primeiro início de sessão, última conclusão de sessão e último evento bem-sucedido de homologação/produção. O histórico completo permanece consultável.
- Tasks com múltiplos Developers atribuem horas estimadas/registradas na proporção das sessões encerradas até a conclusão. Horas em todas as tarefas concluídas e horas na coorte estimada são retornadas separadamente para preservar comparabilidade e compatibilidade do contrato. O forecast de time não mistura horas com story points.
- Upgrade adiciona migrações v25 e v26; fazer backup antes da atualização e testar restore conforme ADR 0005.

## Referências

- [Contrato MCP](../mcp.md)
- [Especificação funcional](../specification.md)
- [Dashboard](../dashboard.md)
- [Runbook do servidor de equipe](../team-server.md)
