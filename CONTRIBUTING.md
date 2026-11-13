# Contribuindo

Obrigado pelo interesse! Este projeto está em beta; issues e PRs são bem-vindos.

## Antes de começar

- Leia o [README](README.md) e [docs/development.md](docs/development.md) (ambiente, testes, migrações e empacotamento).
- Para mudanças grandes, abra uma issue antes para alinhar a abordagem. Decisões duradouras viram um ADR em [docs/adr/](docs/adr/).
- Referências `SSDD-###` em ADRs e matrizes são identificadores históricos do backlog interno que originou o projeto.

## Ambiente

Node.js 24 ou 26 e npm 10+.

```sh
npm ci
npm run check          # lint + typecheck + testes (build incluso)
npm run test:browser   # smoke do dashboard (precisa de Chrome; SSDD_BROWSER_CHANNEL=msedge troca o canal)
```

## Pull requests

1. Faça um fork e crie um branch a partir de `main`.
2. Mantenha a mudança focada, com testes para o comportamento novo e para as condições recusadas relevantes.
3. Atualize a documentação afetada na mesma alteração: `docs/mcp.md` (contratos/tools), `docs/specification.md` (regras), `docs/architecture.md` (componentes/persistência), `docs/dashboard.md` e os manuais (interface), além do [CHANGELOG](CHANGELOG.md).
4. Mudou a interface? Regenere as imagens com `scripts/capture-dashboard-screenshots.mjs` (veja [docs/development.md](docs/development.md)).
5. Mudou tools ou o dashboard? Os testes de paridade exigem regenerar as matrizes: `UPDATE_PARITY_MATRIX=1` e `UPDATE_UI_MATRIX=1` (descrito nos próprios testes).
6. Execute `npm run check` e inclua o resultado no PR. Não afirme conclusão sem evidência dos testes.

## Estilo

TypeScript estrito em ESM, `eslint` sem exceções novas, textos de interface e documentação em português do Brasil, mensagens de erro e contratos de tools estáveis. Toda mutação passa pela camada de aplicação (idempotência por `requestId`, versão esperada, autorização por papel e auditoria); não ofereça atalhos que contornem gates.

## Segurança

Não abra issue pública para vulnerabilidades: veja [SECURITY.md](SECURITY.md).

## Licença

Ao contribuir você concorda em licenciar sua contribuição sob a [Apache License 2.0](LICENSE).
