# Instruções do repositório

- Leia `README.md`, `docs/status.md` (retrato atual, curto) e os documentos afetados antes de mudar comportamento. Consulte `ROADMAP.md` pela seção da tarefa ou do backlog ativo, sem ler o arquivo inteiro; use o índice "Como navegar" no topo.
- Histórico datado vive em `docs/changelog.md` e decisões detalhadas das sprints concluídas em `docs/roadmap-refinements.md`. Leia-os só quando precisar da origem de uma decisão.
- Mantenha documentação e implementação sincronizadas na mesma alteração. Atualize `docs/mcp.md` para contratos ou ferramentas, `docs/specification.md` para regras de domínio, `docs/architecture.md` para componentes e persistência, `docs/dashboard.md` para projeções e interface, e `docs/status.md`/`ROADMAP.md` para progresso.
- Em `docs/status.md`, mantenha o resumo "Estado atual" curto e a tabela `| SSDD-### | Estado | Evidência |` (lida por `scripts/sync-roadmap-to-mcp.mjs`); registre narrativas datadas em `docs/changelog.md`.
- Registre decisões técnicas duradouras em `docs/adr/`.
- Execute `npm run check` quando alterar código. Não marque aceite sem evidência dos testes e da verificação aplicável.
- Use as tarefas e dependências de `ROADMAP.md`; IDs `SSDD-###` são estáveis.
