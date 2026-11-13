# Instruções para agentes e contribuidores

- Leia `README.md` e os documentos afetados antes de mudar comportamento; a visão geral da documentação está na tabela do README.
- Mantenha documentação e implementação sincronizadas na mesma alteração: `docs/mcp.md` para contratos e ferramentas, `docs/specification.md` para regras de domínio, `docs/architecture.md` para componentes e persistência, `docs/dashboard.md` e os manuais para projeções e interface, e `CHANGELOG.md` para mudanças visíveis.
- Registre decisões técnicas duradouras em `docs/adr/`.
- Execute `npm run check` quando alterar código (e `npm run test:browser` para o dashboard). Não afirme aceite sem evidência dos testes.
- Se mudou tools ou dashboard, regenere as matrizes de paridade (`UPDATE_PARITY_MATRIX=1`, `UPDATE_UI_MATRIX=1`) e, se mudou a interface, as imagens dos manuais.
- Não versione `.ssdd/`, bancos SQLite, `authKey`, tokens nem dados pessoais.
- Identificadores `SSDD-###` em ADRs e matrizes são históricos do backlog interno original.
