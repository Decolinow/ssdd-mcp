# Instruções do repositório

- Leia `README.md`, `ROADMAP.md`, `docs/status.md` e os documentos afetados antes de mudar comportamento.
- Mantenha documentação e implementação sincronizadas na mesma alteração. Atualize `docs/mcp.md` para contratos ou ferramentas, `docs/specification.md` para regras de domínio, `docs/architecture.md` para componentes e persistência, `docs/dashboard.md` para projeções e interface, e `docs/status.md`/`ROADMAP.md` para progresso.
- Registre decisões técnicas duradouras em `docs/adr/`.
- Execute `npm run check` quando alterar código. Não marque aceite sem evidência dos testes e da verificação aplicável.
- Use as tarefas e dependências de `ROADMAP.md`; IDs `SSDD-###` são estáveis.
