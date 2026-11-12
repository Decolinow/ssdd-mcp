# ADR 0024: Prioridade, valor de negócio e roadmap por Feature

- **Status:** Aceita
- **Data:** 2026-11-12
- **Decisores:** Product Owner e Tech Lead
- **Escopo:** épicos, Features, tarefas, fila de execução e timeline de Features
- **Registro MCP vigente:** `SSDD-PRIORITY-ADR-24` revisão 2 e `SSDD-BR-PRIORITY-01` revisão 2

## Contexto

O campo de prioridade existente não expressava impacto de negócio, e a interface não mostrava uma ordem de entrega por Feature. Agentes precisavam inferir a próxima tarefa em várias consultas e podiam escolher trabalho bloqueado ou de prioridade menor. O projeto tem apenas uma sprint comparável, insuficiente para prever datas de entrega com confiança.

## Decisão

Prioridade usa a escala existente de 1 a 4: P1 é a mais alta e P4 a mais baixa. Valor de negócio é uma avaliação PO entre 0 e 100, com justificativa obrigatória. O score soma cinco dimensões qualitativas, cada uma de 0 a 20: impacto para usuário/negócio, redução de risco/segurança/compliance, alinhamento estratégico, habilitação/reuso e urgência/custo do atraso. A justificativa registra a decomposição e a base da avaliação. O score é ordinal, não representa receita, ROI observado ou probabilidade de entrega. O campo é opcional em épicos, Features e tarefas. A ausência é desconhecida, não zero; clientes e agentes não inferem nem inventam avaliações.

Em uma hierarquia, a prioridade efetiva é o menor número entre a tarefa, o PBI pai, a Feature e o épico. O valor efetivo é o valor explicitamente definido no nível mais específico disponível (tarefa, Feature e depois épico). História e Bug continuam usando prioridade, mas não recebem valor de negócio nesta decisão.

`task_execution_queue_get` é a fonte recomendada para o próximo trabalho. Primeiro lista tarefas startable; depois ordena por prioridade efetiva crescente, valor de negócio decrescente, rank de Feature, rank de tarefa e chave. Valores desconhecidos ficam depois dos avaliados dentro da mesma prioridade. A fila é uma recomendação de ordenação e não muda atribuição, escopo ou gates. Antes de iniciar, o agente chama `task_start_check`; `task_start` continua sendo a operação atômica autorizada.

`project_feature_roadmap_get` ordena Features por prioridade efetiva, valor herdado/definido, rank e chave. Conclusão usa pontos confirmados em histórias/bugs e mostra itens ativos sem estimativa e dependências externas. Datas de previsão só aparecem com pelo menos três sprints fechadas do mesmo time e geração, escopo estimado e sem bloqueio que impeça a alocação sequencial. A projeção usa velocidade histórica para alocar escopo em série segundo a ordem; não é compromisso de calendário. Sem dados suficientes, a tela mostra status e motivo, sem fabricar data.

Não há backfill automático. Em 2026-11-12, o PO revisou e publicou scores explícitos para os quatro épicos e 14 Features com base nos objetivos/aceites do roadmap; as dimensões e racionales estão nas revisões MCP. Essa avaliação inicial é qualitativa e deve ser recalibrada quando houver evidência de clientes, uso ou mudança estratégica. Novos itens sem base suficiente permanecem com valor nulo. Tarefas herdam o score da Feature e só recebem score direto quando existir uma avaliação específica.

## Consequências

- Cadastro e revisão de épicos, Features e tarefas aceitam valor e justificativa; revisões publicadas preservam ambos.
- Fila de execução, roadmap gráfico e planejamento de sprint usam regras compartilhadas, visíveis e testadas.
- Histórico sem valor permanece explicitamente desconhecido e pode ser priorizado por P1–P4/rank até refinamento do PO.
- Os 18 valores atuais constituem avaliação PO inicial documentada, não telemetria nem retorno financeiro.
- Previsões de Feature ficam indisponíveis no estado atual do projeto enquanto não houver três sprints comparáveis.
- A fila não força serialização de agentes; tarefas independentes ainda podem rodar em paralelo com atribuições e worktrees próprios.

## Verificação

Os testes cobrem validação de score/justificativa, persistência em revisões, herança e ordenação da fila, bloqueios reais de início e roadmap sem amostra suficiente. `npm run check` é o gate local obrigatório. A timeline visual informa ausência de previsão quando as condições estatísticas ou de escopo não são cumpridas.
