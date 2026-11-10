# ADR 0011: vários times por projeto

- **Status:** Aceita
- **Data:** 2026-11-10
- **Contexto:** Sprint 8 precisa suportar mais de um time por projeto sem quebrar bancos que foram criados quando a tabela `teams` aceitava apenas um time. Configurações de capacidade e sprints referenciam `(project_id, team_id)`; os históricos são append-only e precisam continuar ligados ao mesmo time.

## Decisão

- A migration v22 reconstrói `teams` sem `UNIQUE(project_id)` e mantém `UNIQUE(project_id, team_id)`, a chave estrangeira composta usada pelas tabelas de histórico.
- IDs, versões, gerações, configurações, membros, feriados, ausências, DoD, sprints e snapshots existentes são copiados sem alteração.
- Cada projeto legado sem time recebe um time padrão com UUID v5 derivado do `project_id`, `current_version = 0` e `current_generation = 0`. A leitura de capacidade não configurada responde `NOT_FOUND`; a primeira configuração reutiliza o ID determinístico.
- Para o rebuild SQLite, a conexão migradora desativa foreign keys antes da transação imediata e as restaura depois. O SQL, o seed e `PRAGMA foreign_key_check` são executados antes do commit dentro da transação. Qualquer erro reverte schema, seed e registro da migration.
- O sistema não implementa downgrade destrutivo. Um backup v21 feito antes da atualização continua sendo aberto pelo conjunto de migrações da versão anterior.
- A v22 muda o armazenamento. A v23 e SSDD-802 completam a propagação de `teamId`, a regra de seleção inequívoca e a separação de sprints/snapshots por time; ver [ADR 0012](0012-isolamento-de-times-por-projeto.md).

## Consequências

- A tabela aceita vários times sem regravar configurações ou sprints históricas.
- Projetos legados que ainda não tinham capacidade passam a ter um registro de time, mas nenhuma configuração de capacidade até o PO configurá-la.
- A implementação evita um downgrade potencialmente destrutivo e mantém a recuperação baseada no backup verificado.
- A migration foi testada com configurações e snapshots referenciados, inclusão de um segundo time, IDs determinísticos em upgrades independentes, rollback com FK inválida e leitura de backup v21 usando a lista antiga de migrações.
