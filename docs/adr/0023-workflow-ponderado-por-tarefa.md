# ADR 0023 · Workflow versionado e progresso ponderado por tarefa

- **Status:** proposta implementada localmente; Draft registrada no MCP; aguarda revisão de Tech Lead humano
- **Data:** 2026-11-12
- **Especificação MCP:** `SSDD-TASK-WF-ADR-02`, revisão 1 Draft; regra `SSDD-BR-TASK-WF-01`, revisão 1 Draft
- **Tarefas:** SSDD-931–933

`SSDD-TASK-WF-ADR-01` é a proposta inicial Draft e continua imutável porque o contrato MCP atual não oferece operação para retirar um Draft de especificação. Ela foi ligada a esta revisão por `relates_to`; a revisão 2 corrigida foi cadastrada sob `SSDD-TASK-WF-ADR-02`. Ambas seguem sem publicação/aprovação humana.

## Contexto

Uma tarefa registra o resultado e os gates, mas não descreve necessariamente as etapas que conduzem à entrega nem quanto cada parte representa do esforço total. Percentual manual não tem critério verificável, histórico nem relação consistente com o trabalho realmente concluído. Alterar uma decomposição durante a execução também pode mudar o denominador e confundir progresso com QA ou previsão de horas.

## Decisão proposta

1. Permitir workflow opcional somente em work items do tipo task. Cada revisão tem 1–50 etapas ordenadas com ID, título de 1–160 caracteres, instruções de 1–4.000 caracteres e esforço positivo em centésimos de percentual. A soma inteira em pontos base precisa ser exatamente 10.000 (100,00%). O peso representa esforço relativo da tarefa; não é hora, story point, duração ou cobertura.
2. Versionar definições de forma imutável. Developer ou Tech Lead pode propor Draft com motivo e versões esperadas. A proposta mais nova retira o Draft anterior sem apagar história. Só Tech Lead humano publica a revisão mais recente, com tarefa em Draft, Ready ou `in_progress`, e todas as sessões ativas/pausadas fechadas. A escrita é auditada e usa controle otimista/idempotência.
3. Definir estados de etapa `pending`, `in_progress` e `done`. O caminho normal exige início explícito: Pendente → Em andamento → Concluída; pular de Pendente para Concluída é inválido. Etapas só iniciam/concluem na ordem, depois que todas as anteriores estão Concluídas. Uma etapa em andamento pode voltar a Pendente se não houver etapas posteriores abertas.
4. Calcular o progresso pela soma dos pesos de etapas Concluídas. Etapas Pendentes ou Em andamento contribuem zero. Sem workflow publicado, progresso é desconhecido (`null`), nunca 0%. O serviço calcula e valida no banco; clientes não fornecem percentuais de progresso.
5. Exigir Developer autenticado, atribuído, com sessão ativa na tarefa e revisão pinada correspondente para avançar etapas. Corrigir uma etapa concluída para Pendente exige Tech Lead humano, nenhuma sessão aberta e reabertura das etapas posteriores em ordem inversa, com motivo e auditoria.
6. Fixar a revisão publicada no início da sessão. Uma mudança não altera sessão aberta: exige handoff/encerramento de todas as sessões e publica revisão nova. Etapa com mesmo ID, título e instruções pode carregar o status se a ordem anterior continuar válida. Mudança de definição reseta etapa; reordenação incompatível reseta etapas afetadas e posteriores. Mudança de peso sozinha preserva status e recalcula progresso pelo peso revisado. A resposta de publicação enumera estados carregados/resetados e percentual anterior; histórico por revisão mantém os valores antigos consultáveis.
7. Bloquear Ready, início e Done quando só existe um Draft e nunca houve workflow publicado, até publicar ou retirar o Draft. Um Draft de revisão não interrompe o workflow publicado corrente. Se não há workflow configurado, manter os gates legados. Com publicação, Done exige todas as etapas em `done` além dos outros gates de tarefa.
8. Tratar 100% exclusivamente como progresso do plano técnico. Não satisfaz evidência, cobertura de cenário, execução, certificação QA, baseline, dependências, aprovação humana ou deployment.
9. Persistir em SQLite por migration aditiva: revisões, etapas, eventos append-only e referências imutáveis entre sessão e revisão. Índices e triggers protegem escopo por projeto/tarefa, revisão, estados e pesos. O dashboard mostra resumo da lista de tarefas filhas, detalhe completo, histórico, proposta e publicação sob sessão/CSRF e autorização existentes.

## Alternativas consideradas

- Percentual manual sobre a tarefa: rejeitado porque não identifica entrega concluída nem guarda proveniência.
- Mutar etapa/peso no lugar: rejeitado porque alteraria retrospectivamente escopo, denominador e autoria.
- Exigir workflow em todas as tarefas legadas: rejeitado para preservar compatibilidade; plano é opt-in.
- Considerar uma etapa `in_progress` como progresso parcial: rejeitado porque a medida seria subjetiva e a etapa já tem peso fechado; somente `done` conta.
- Permitir alteração com sessão aberta ou retomada fora de ordem: rejeitado porque mistura revisões e deixa o progresso inconsistente.

## Consequências

- A publicação humana de Tech Lead e o encerramento de sessões acrescentam um handoff para alterar o plano.
- A alteração isolada de peso muda o percentual da nova revisão, mas não reescreve o percentual da revisão antiga.
- O progresso pode chegar a 100% antes de evidência/QA e não deve aparecer como status `Done` ou taxa de aceitação.
- Workflows opcionais deixam tarefas antigas sem percentual até uma revisão ser publicada.
- O histórico é consultável por revisão, mas a lista resumida expõe no máximo 50 versões por resposta e sinaliza truncamento.

## Verificação exigida

- Testar soma inválida, limites/precisão, Draft substituído, idempotência, versão concorrente, aplicação apenas a task, e autorização Developer/Tech Lead/humano.
- Testar progresso 0/parcial/100, transição Pendente→Concluída recusada, ordem de avanço, reset reverso, sessão sem pin e pin velho.
- Testar migration v30 em banco legado com integridade/FKs, auditoria e referência imutável à sessão.
- Validar os mesmos contratos em MCP stdio, API autenticada/CSRF, projeção de lista e gate Ready/Done.
- Verificar prompts/skills/agentes e instalador; executar `npm run check` e validar a atualização do roadmap via MCP.

## Referências

- [Especificação funcional](../specification.md#workflow-ponderado-de-uma-tarefa)
- [Contrato MCP](../mcp.md#workflow-ponderado-por-tarefa)
- [Dashboard](../dashboard.md#workflow-ponderado-da-tarefa)
- [Arquitetura](../architecture.md#fatia-implementada)
