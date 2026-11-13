# Desenvolvimento

## Preparar o ambiente

- Node.js 24 ou 26; Node 26 é recomendado pelo `.nvmrc`.
- npm 10 ou superior.

Para testar os dois ABIs na mesma máquina sem substituir o Node global, execute a verificação com o runtime Node 26 isolado. `better-sqlite3` é nativo, então recompile-o para o runtime antes da suíte e recompile-o de volta para o Node ativo depois:

```sh
npm exec --yes --package=node@26 -- npm rebuild better-sqlite3
npm exec --yes --package=node@26 -- npm run check
npm rebuild better-sqlite3
```

Na raiz do repositório:

```sh
npm ci
npm audit --audit-level=moderate
npm run check
npm run build
npm run demo
node dist/src/cli.js init --workspace . --key PAY --name "Pagamentos" --goal "Pagamentos confiáveis" --timezone America/Sao_Paulo
npm start
node dist/src/cli.js dashboard --workspace . --port 4318
node dist/src/cli.js serve --workspace . --port 4319
```

`npm run check` executa `lint`, `typecheck` e `test`, nessa ordem. `npm run build` compila fontes/testes em `dist/` e copia os arquivos de `src/dashboard/public` para o pacote. `npm run demo` conecta um cliente MCP real a um workspace temporário e executa a trilha PO → Dev → QA até Done; `npm run demo:release` simula cinco clientes OIDC em perfis PO, Tech Lead, Developer, QA e Release, incluindo spec→task→sessão→cenário/run e os gates de homologação/produção. A demo de cliente e os passos manuais estão em [docs/demo.md](demo.md). `npm run benchmark:metrics` constrói uma fixture temporária com 10 mil PBIs, 50 mil eventos, uma sprint planejada e três sprints históricas válidas; as projeções fazem 10 mil simulações Monte Carlo. O script mede 12 reconstruções frias, uma onda fria com cinco clientes MCP, 100 leituras concorrentes aquecidas e 100 gravações, invalida o cache com eventos sintéticos, falha se a previsão ou as metas p95 não forem atendidas e remove a fixture ao terminar. `init` é repetível para a mesma configuração e recusa mudanças implícitas. `npm start` inicia o servidor MCP por stdio no diretório atual. `ssdd-mcp serve` oferece o mesmo catálogo pelo transporte Streamable HTTP, sempre em loopback. No primeiro host startup, o principal local passa a administrador da instância; authKeys entram por `SSDD_AUTH_KEY` (stdio) ou `Authorization: Bearer` (HTTP), e `SSDD_PROFILE`/`X-SSDD-Profile` filtram a lista de tools sem substituir RBAC. Para federação de equipe, configure issuer e URL do resource para ativar OIDC e use `ssdd-mcp access grant|revoke` para provisionar papéis por projeto. `user_create` administra principals locais, papéis e authKeys. A busca semântica é opcional e envia o texto de tarefas/consultas ao provedor OpenAI-compatible configurado; FTS5 não depende dessa integração. `approval_issue` e `approval_revoke` dão a admins humanos controle sobre aprovações de uso único que os agentes enviam em `_meta`. `ssdd-mcp dashboard` inicia a API e o dashboard em loopback e imprime a URL de entrada com token de bootstrap de uso único; o login por authKey MCP, sessão, APIs e comportamento da UI estão em [docs/dashboard.md](dashboard.md).

## Iniciar o workspace e carregar o roadmap

Depois do build, crie um workspace privado no diretório do projeto e confira o schema:

```sh
node dist/src/cli.js init --workspace . --key SSDD --name "SSDD MCP" --goal "Entrega guiada por especificação" --timezone America/Sao_Paulo
node dist/src/cli.js doctor --workspace .
```

O banco fica em `.ssdd/ssdd.sqlite`, que é ignorado pelo Git. Para importar as tarefas descritas em `ROADMAP.md` ao projeto `SSDD`, execute o sincronizador com a versão compilada do servidor:

```sh
npm run build
node scripts/sync-roadmap-to-mcp.mjs --apply
```

`--help` mostra o uso sem iniciar o MCP; a execução exige `--apply` para evitar escrita implícita. O script usa um cliente MCP stdio real, cria épicos/features/histórias de meta/tarefas, adiciona as dependências `depends_on` e confere o grafo importado. `SSDD_WORKSPACE` e `SSDD_PROJECT_KEY` permitem selecionar outro workspace/chave. IDs de requisição e chaves de roadmap evitam duplicação; a suíte repete a importação após mudar o status no Markdown. A reimportação não altera automaticamente títulos, critérios, descrições, estado de workflow ou dependências de itens existentes; mudanças de conteúdo devem seguir o fluxo versionado de revisão e aprovação no MCP. `docs/status.md` é o registro factual local da implementação; ele não publica a tarefa nem muda seu estado de workflow. A importação inicial deixa os itens em Draft: texto de roadmap/status não representa aprovação, baseline, evidência nem aceite dos gates. Mantenha o estado local junto das alterações em [ROADMAP.md](../ROADMAP.md).

Para receber GitHub webhooks no mesmo processo `serve`, configure o segredo HMAC e o repositório permitido por projeto:

```powershell
$env:SSDD_WEBHOOK_SECRET_GITHUB__PAY = '<segredo-forte-com-pelo-menos-32-bytes>'
$env:SSDD_GITHUB_REPOSITORY_PAY = 'acme/payments'
$env:SSDD_GITHUB_ISSUES_TOKEN_PAY = '<token-read-only-com-pelo-menos-20-bytes>'
node dist/src/cli.js serve --workspace . --port 4319
```

Use o mesmo segredo forte cadastrado no webhook e mantenha tokens em um gerenciador de segredos no servidor; não os coloque no Git, em argumentos do processo ou em logs. Cada par provider/projeto usa um segredo independente. O receptor valida HMAC antes de parsear JSON, limita o corpo a 1 MiB e exige que `repository.full_name` corresponda ao mapeamento. O token de issues precisa de leitura do repositório e é usado somente em GET; preview não grava e apply requer hash vigente e PO humano. Consulte o contrato HTTP/MCP em [docs/mcp.md](mcp.md), [ADR 0007](adr/0007-receptor-de-webhooks.md), [ADR 0008](adr/0008-referencias-github.md) e [ADR 0009](adr/0009-importacao-github.md).

Para importar do Azure Boards, configure organização, nome exato do projeto e um PAT organizacional com o menor escopo de leitura de work items e validade curta. PATs globais deixam de funcionar em 27 de janeiro de 2027. A consulta fica restrita a `dev.azure.com` e os três valores são configurados por projeto SSDD:

```powershell
$env:SSDD_AZURE_DEVOPS_ORGANIZATION_PAY = 'acme-dev'
$env:SSDD_AZURE_DEVOPS_PROJECT_PAY = 'Payments Core'
$env:SSDD_AZURE_DEVOPS_TOKEN_PAY = '<pat-read-only>'
node dist/src/cli.js serve --workspace . --port 4319
```

`azure_work_item_import_preview` permite conferir tipo remoto, Feature destino, itens ignorados e `planHash`; `azure_work_item_import_apply` exige PO humano e revalida a leitura. WIQL e batch são POSTs de consulta sem efeitos no Azure. Mantenha credenciais em um gerenciador de segredos e prefira Microsoft Entra ID para um serviço de longa duração, conforme a [orientação oficial de PAT](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops). Veja [contrato MCP](mcp.md#importação-unidirecional-do-azure-boards) e [ADR 0010](adr/0010-importacao-azure-boards.md).

## Instalar agentes em outro repositório

O comando roda na raiz do checkout SSDD e aceita como alvo um diretório dentro de um repositório Git. O padrão é dry-run; a aplicação empacota e instala o build local somente depois da revisão do plano:

```powershell
npm run agents:install -- --target ..\meu-projeto --dry-run
npm run agents:install -- --target ..\meu-projeto --apply
npm run agents:install -- --target ..\meu-projeto --check
```

O runtime vai para `.ssdd/agent-runtime`, com manifesto de hashes e instalação em staging. Entradas nativas são mescladas em `.mcp.json`, `.codex/config.toml` e `opencode.json/jsonc`; skills e agentes são gerados nos diretórios de cada cliente. O instalador falha diante de colisões ou arquivos gerenciados editados e preserva as configurações fora dos caminhos SSDD. Veja formatos, confiança, recuperação e testes em [docs/agent-installer.md](agent-installer.md) e a decisão em [ADR 0014](adr/0014-instalador-local-de-agentes.md).

O `npm audit --audit-level=moderate` verifica dependências diretas e transitivas e é gate obrigatório da CI. `package.json` fixa `minimatch` em 11.0.1 por overrides restritos às dependências de ESLint e TypeScript-ESLint, cujas versões atuais ainda declaram a linha 10, afetada pelo [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). A versão corrigida foi validada com lint, typecheck e testes em Node 24 e 26. `allowScripts` aprova somente o script nativo do `better-sqlite3@12.11.1`, que tenta instalar o binário pré-compilado e recorre ao `node-gyp`; a versão e o script foram revisados para o [npm approve-scripts](https://docs.npmjs.com/cli/v11/commands/npm-approve-scripts/). Remova os overrides quando as dependências upstream aceitarem a versão corrigida sem eles.

## Operação do workspace

```sh
node dist/src/cli.js doctor --workspace .
node dist/src/cli.js backup --workspace . --output ../pay.sqlite
node dist/src/cli.js restore --backup ../pay.sqlite --workspace ../pay-restored
node dist/src/cli.js export --workspace . --format json --output ../pay-export.json
node dist/src/cli.js export --workspace . --format markdown --output ../pay-export.md
node dist/src/cli.js export --workspace . --format gherkin --output ../pay-scenarios.feature
```

O formato Gherkin exporta a revisão publicada corrente de cada cenário e omite rascunhos; cada recurso recebe tags estáveis de projeto, cenário, tipo e revisão. Quebras de linha do conteúdo são achatadas para uma linha para impedir que texto de cenário gere passos adicionais.

O backup gera ao lado um manifesto `.manifest.json` com SHA-256, tamanho, versão do schema e chaves de projeto. Restore valida esse manifesto, precisa que `.ssdd` não exista ou esteja vazio e instala o banco após migração e checagens de integridade/FKs. Pare os processos que usam o workspace antes de restaurar. Exportação é uma visão de dados por projeto, omite tabelas operacionais e remove campos sensíveis; não serve como substituto de backup. `doctor` é somente leitura e retorna JSON com erros e avisos sem dados de identidade. Detalhes da decisão em [ADR 0005](adr/0005-workspace-backup-restore-export.md).

## Migrações SQLite

As migrações são consecutivas, versionadas por checksum e executadas em transações imediatas. Quando uma mudança de SQLite exige rebuild de tabela pai referenciada, documente o motivo, desative foreign keys somente na conexão migradora antes da transação e valide `PRAGMA foreign_key_check` dentro dela antes do commit; a conexão deve restaurar o modo original mesmo em erro. Comportamento pós-SQL precisa de uma `checksumKey` estável para participar da detecção de drift. A v22 permite vários times e mantém as chaves compostas; UUIDs legados sem configuração são UUID v5 estáveis. A v23 reconstrói snapshots de forecast para isolar histórico por time e troca a unicidade de sprint ativa para time. A v24 adiciona índices do histórico de execuções QA sem alterar os dados; v25/v26 registram sessões/releases e aliases do roadmap; v27 adiciona índices temporais; v28 adiciona bootstrap admin, chaves autenticadas, log administrativo, índice de atribuição e cache de embeddings; v29 indexa eventos de estimativa por projeto, tipo e item para reduzir scans no cálculo das métricas; v30 adiciona revisões, passos, eventos append-only e pinagem da revisão do workflow nas sessões. A migration de workflow não altera tarefas existentes: sem publicação seu progresso permanece `null` e os gates legados se aplicam. Cobertura da migração deve partir de schema anterior com dados reais, preservar snapshots e manter os backups que a versão anterior ainda precisa ler. Decisões em [ADR 0011](adr/0011-times-multiplos-por-projeto.md), [ADR 0012](adr/0012-isolamento-de-times-por-projeto.md), [ADR 0015](adr/0015-historico-de-execucoes-qa-no-mcp.md), [ADR 0019](adr/0019-autenticacao-perfis-e-busca-semantica.md) e proposta [ADR 0023](adr/0023-workflow-ponderado-por-tarefa.md).

## Pacote e container

```sh
npm run build
mkdir -p ../packages
tarball="$(npm pack --json --pack-destination ../packages | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8"))[0].filename')"
npm install --global --prefix ../ssdd-mcp-install "../packages/$tarball"
docker compose build
docker compose run --rm ssdd-mcp init --workspace /data --key PAY --name "Pagamentos" --goal "Pagamentos confiáveis" --timezone America/Sao_Paulo
docker compose run --rm ssdd-mcp doctor --workspace /data
docker compose run --rm -i ssdd-mcp
```

O pacote é validado como tarball local; `private: true` impede publicação acidental no npm. O container usa Node 24, runtime de produção, usuário `node`, filesystem raiz somente leitura e volume `ssdd-data`. A interface continua em stdio; use `docker compose run --rm -i ssdd-mcp` como comando do cliente, não `compose up -d`. Uma nova execução consulta a mesma base no volume. A CI instala o tarball em um prefixo isolado e executa `init`/`doctor`; no Linux, constrói a imagem, inicializa o banco em um volume nomeado e verifica-o em um container novo.

## Testes

- Testes usam `node:test` e ficam em `tests/`, próximos ao módulo que cobrem.
- Testes de SQLite devem usar diretórios temporários e fechar conexões ao terminar.
- `tests/scripts/sync-roadmap-to-mcp.test.ts` exercita o importador com workspace temporário e cliente MCP real, incluindo reexecução após mudança do status descritivo sem criar itens duplicados.
- `tests/scripts/install-agent-stack.test.ts` cobre preview read-only, conflitos, instalação/atualização por manifesto, preservação de JSONC/TOML e handshake do runtime instalado com cliente MCP stdio real.
- `npm run demo:release` compila e executa a trilha integrada OIDC PO/Developer/QA → MCP Streamable HTTP → dashboard; usa fixture local sem tenant externo.
- Backup/restore usa bancos temporários com WAL e manifesto; cubra corrupção/hash inválido, alvo não vazio, histórico após restauração e consultas read-only de projeções. Exportações devem ter fixture com credenciais em colunas e JSON aninhado e provar que nenhum segredo aparece.
- Testes de transporte devem usar um workspace temporário e um cliente MCP real. Stdio reserva stdout ao protocolo e envia diagnósticos a stderr; Streamable HTTP testa a era legacy com handshake e a era moderna `2026-07-28`, ferramentas, sessões, negociação de versão, validação de Host/Origin e limites de payload. A fixture OIDC assina tokens localmente e cobre descoberta, JWKS, claims obrigatórios, scope, provisionamento e isolamento de sessão. Aprovações usam cliente MCP real para verificar metadata, consumo concorrente, replay, revogação e rollback da mutação junto da aprovação.
- A CI executa o mesmo `npm run check` em Node 24 e 26, em Linux, macOS e Windows.
- Um teste que cobre uma regra de domínio inclui cenário válido e as condições recusadas relevantes. A aceitação da tarefa deve apontar para o comportamento testado.

## Imagens dos manuais

`docs/images/` é gerado por `scripts/capture-dashboard-screenshots.mjs <url-com-token> docs/images`, que abre cada aba e diálogo do dashboard em Chrome (`SSDD_BROWSER_CHANNEL` troca o canal). Rode-o depois de mudar a interface e revise as imagens antes de commitar; use uma cópia do workspace para não expor dados reais. Os textos estão em [manual-usuario.md](manual-usuario.md) e [manual-administrador.md](manual-administrador.md).

## Fluxo por tarefa

1. Selecione uma tarefa pronta em [ROADMAP.md](../ROADMAP.md), respeitando pré-requisitos. IDs como `SSDD-103` são referências estáveis.
2. Mantenha o escopo da mudança ligado ao aceite da tarefa e registre decisões que afetam mais de uma implementação em `docs/adr/`.
3. Atualize, na mesma alteração, a documentação de domínio, contrato MCP, arquitetura, dashboard ou operação que tenha sido afetada.
4. Execute `npm run check`. Não marque a tarefa concluída sem evidência do aceite e da verificação aplicável.
5. Atualize [docs/status.md](status.md) (resumo e linha da tarefa), registre a narrativa datada em [docs/changelog.md](changelog.md) e atualize o status do roadmap junto com a entrega.

## Definição de pronto

Uma tarefa só fica concluída quando o comportamento atende aos critérios de aceite, as verificações aplicáveis passam e a documentação descreve o comportamento entregue. Mudanças de contrato também atualizam exemplos e erros. Alterações de persistência incluem cobertura de migração e recuperação quando aplicável. Uma sprint só fecha quando o fluxo da meta funciona em uma fixture reproduzível.
