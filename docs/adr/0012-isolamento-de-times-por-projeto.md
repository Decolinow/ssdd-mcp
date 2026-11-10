# ADR 0012: Isolamento de times dentro do projeto

**Status:** Aceita  
**Data:** 2026-11-10

## Contexto

A migração v22 permitiu vários times por projeto, mas as consultas ainda escolhiam a primeira equipe. O índice de sprint ativa e a chave de snapshot do forecast também eram globais por projeto. Isso permitiria misturar calendários, amostras e planos sem que o solicitante percebesse.

## Decisão

- Capacidade, configuração, sprints, velocidade, forecast, histórico de forecast e dashboard recebem `teamId`.
- Uma seleção omitida é aceita quando existe exatamente um time. Com vários times, a aplicação retorna `VALIDATION_FAILED` com `teamOptions`; um ID fora do projeto retorna `NOT_FOUND`.
- `team_create` cria um novo ID e a configuração imutável inicial de forma idempotente. `team_list` expõe diretório, configuração corrente e membros.
- Uma pessoa pode participar de mais de um time. Dedicação, vigência, calendário, ausências e geração são próprios de cada configuração; capacidades não são somadas entre equipes.
- Cada time pode ter uma sprint ativa. O backlog continua no nível de projeto, e um PBI pode ser reservado por no máximo um rascunho ou sprint ativa no projeto. Fechar ou cancelar libera a reserva.
- Migração v23 troca o índice de sprint ativa para `(project_id, team_id)` e reconstrói snapshots de forecast para incluir `team_id` na chave única, preservando JSON histórico e imutabilidade. O dashboard usa a seleção global para escopo de sprint, retrospectiva, velocidade e previsão; WIP, cobertura e backlog continuam project-wide.

## Consequências

Clientes precisam listar os times e enviar um `teamId` quando o projeto tiver mais de um. Seleção antiga continua funcionando em projeto de time único. Membros podem dividir dedicação entre equipes explicitamente, e a composição de cada uma tem sua própria geração. A política de reserva de PBI evita compromissos simultâneos incompatíveis enquanto mantém o backlog compartilhado.

## Alternativas consideradas

- Inferir time pelo principal ou pela lista de membros foi recusado: uma pessoa pode pertencer a vários times e uma pessoa de serviço não representa composição de sprint.
- Permitir o mesmo PBI em sprints concorrentes foi recusado: cada time poderia contar a mesma entrega, baseline e estimativa sob capacidade diferente.
- Migrar snapshots antigos sem preservar a tabela original foi recusado: o JSON e a relação de histórico permanecem consultáveis; o campo de time é derivado do snapshot já armazenado.

