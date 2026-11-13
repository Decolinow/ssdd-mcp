# Manual do administrador

Guia operacional para instalar, acessar, proteger e manter o SSDD MCP. Para o uso diário do dashboard veja o [manual do usuário](manual-usuario.md); para servidor compartilhado, OIDC e Nginx veja [team-server.md](team-server.md); para a instalação nos clientes de IA, [agent-installer.md](agent-installer.md).

## 1. Requisitos

- Node.js 24 ou 26 e npm 10+; Windows, Linux ou WSL (macOS não foi validado nesta versão).
- Armazenamento **local e persistente** para `.ssdd`. Não use NFS/SMB nem rode dois processos `serve` sobre o mesmo banco.
- Chrome ou Edge apenas para o smoke de navegador e para regenerar as imagens dos manuais.

## 2. Instalação e primeiro projeto

```sh
npm ci
npm run check            # lint, typecheck e todos os testes (esperado: 265/265)
npm run build
node dist/src/cli.js init --workspace . --key PAY --name "Pagamentos" --goal "Pagamentos confiáveis" --timezone America/Sao_Paulo
```

`init` cria o banco SQLite, aplica as migrações, registra o projeto e prepara a identidade local. Rode uma vez por workspace.

Para registrar o servidor MCP nos clientes de IA (Claude Code, Codex, OpenCode) use o instalador repetível:

```sh
npm run agents:install -- --apply --target .
```

Reinicie o cliente depois da instalação para que o servidor seja respawnado com a versão nova.

## 3. Modos de execução

| Comando | Para que serve |
|---|---|
| `ssdd-mcp stdio` | MCP por stdio (cliente local). Autenticação por `SSDD_AUTH_KEY`; filtro opcional `SSDD_PROFILE`. |
| `ssdd-mcp serve --port 4319` | MCP Streamable HTTP em loopback, `/mcp`, com `/healthz` e `/readyz` locais. OIDC opcional (`--oidc-issuer`, `--resource-url`). |
| `ssdd-mcp dashboard --port 4318` | Dashboard e API HTTP em loopback; imprime a URL de entrada com token de uso único. |

O dashboard é **local**: não o exponha na rede nem o encaminhe por proxy. Se a porta estiver ocupada o comando termina com código diferente de zero. Cada URL de bootstrap só vale uma vez; para novo acesso reinicie o comando ou entre com a authKey.

## 4. Identidades, papéis e chaves

1. No primeiro startup do host o principal local vira **administrador da instância** e a `authKey` (`ssdd_…`) aparece **uma única vez em stderr**. Guarde-a em cofre de segredos.
2. Conecte-se com essa chave e use `user_create` para cadastrar pessoas, agentes e serviços: informe nome, tipo (`human`, `agent`, `service`), projetos e os **papéis mínimos** por projeto. O retorno traz a authKey do novo usuário (também uma única vez).
3. `user_list` consulta acessos; `user_auth_key_rotate` troca uma chave; `user_auth_key_revoke` a revoga. Revogue imediatamente a chave de quem sai do projeto.
4. Papéis: `admin`, `po`, `tech_lead`, `developer`, `qa`, `facilitator`, `stakeholder`. Gates que exigem pessoa (certificação de QA, publicação de workflow pelo Tech Lead) **não aceitam** `agent` ou `service`.
5. Com OIDC, provisione cada identidade `iss+sub`:

```sh
node dist/src/cli.js access grant --workspace . --project PAY --issuer https://login.example.com/tenant \
  --subject "<sub-do-token>" --display-name "Ana Souza" --type human --roles po,developer --reason "Acesso ao projeto PAY"
node dist/src/cli.js access revoke --workspace . --project PAY --issuer <issuer> --subject "<sub>" --roles developer --reason "Saída do time"
```

6. Mutações feitas por agentes exigem **aprovação humana de uso único** (`approval_issue`, restrita a admin humano; `approval_revoke` cancela).

### Política de gates

Cada projeto tem nível **lite**, **standard** ou **strict** ([ADR 0029](adr/0029-politica-de-gates-por-projeto.md)). Em `strict`, cenário automatizado só pode ser certificado a partir de execução de origem `ci`, comprovada por `workflow_run` de sucesso do mesmo commit recebido por webhook ([ADR 0030](adr/0030-origem-de-execucao-e-confianca-em-ci.md)). Webhooks usam `SSDD_WEBHOOK_SECRET_<PROVIDER>__<PROJECT_KEY>` e `SSDD_GITHUB_REPOSITORY_<PROJECT_KEY>`.

## 5. Operação e manutenção

| Tarefa | Comando |
|---|---|
| Diagnóstico (integridade, FKs, journal, migração; read-only) | `node dist/src/cli.js doctor --workspace .` |
| Backup online consistente (SQLite + manifesto SHA-256) | `node dist/src/cli.js backup --workspace . --output backup/ssdd-2026-11-13.sqlite` |
| Restauração (instâncias paradas; `.ssdd` ausente ou vazio) | `node dist/src/cli.js restore --backup backup/ssdd-2026-11-13.sqlite --workspace <workspace-limpo>` |
| Exportação redigida (JSON, Markdown ou Gherkin) | `node dist/src/cli.js export --workspace . --format json --output export.json` |

Recomendações: backup diário e antes de cada atualização; guarde o arquivo `.sqlite` **junto do manifesto**; rode `doctor` após restaurar e após atualizar; exportações removem segredos e identificadores sensíveis, mas trate-as como internas.

### Atualização

1. Pare `serve`, `dashboard` e clientes que usem o workspace.
2. Faça backup.
3. `git pull`, `npm ci`, `npm run check`, `npm run build`.
4. `npm run agents:install -- --apply --target .` para atualizar o runtime dos clientes.
5. Inicie de novo; as migrações do banco rodam sozinhas e `doctor` confirma a versão do schema (atual: 43).

## 6. Segurança em resumo

- O dashboard e o MCP HTTP escutam **apenas em loopback**; use proxy reverso só para `/mcp` ([team-server.md](team-server.md)).
- Sessão web com cookie efêmero, verificação de origem e token CSRF em toda mutação.
- RBAC por projeto aplicado nos serviços compartilhados por MCP e dashboard; autorização nunca vem do cliente.
- Auditoria imutável de cada comando (ator, motivo, versão) consultável na aba **Atividade**.
- Importações externas (GitHub Issues, Azure Boards) são somente leitura e usam tokens por projeto em variáveis de ambiente, nunca gravados no banco.

## 7. Solução de problemas

| Sintoma | Verifique |
|---|---|
| Dashboard não abre / porta ocupada | Outro `dashboard` ativo? Encerre-o ou use `--port`. |
| URL de bootstrap "já usada" | Reinicie o comando para gerar outro token, ou use a authKey. |
| Cliente MCP sem as tools novas | Rode `agents:install` e reinicie o cliente (o processo antigo continua com a versão anterior). |
| `VERSION_CONFLICT` frequente | Concorrência real; recarregue antes de reaplicar. |
| Banco suspeito | `doctor`; se necessário `restore` do último backup. |
| Execução `ci` recusada | O `buildId` precisa ser `git-<sha>` e existir `workflow_run` concluído com sucesso para esse commit. |
| Imagens dos manuais desatualizadas | `node scripts/capture-dashboard-screenshots.mjs "<url-com-token>" docs/images`. |

## 8. Limites conhecidos desta versão

Servidor de nó único (sem alta disponibilidade), sem telemetria completa, sem macOS validado, origem `ci` exercitada só com eventos de teste, importação de resultados apenas em JUnit (não Cucumber) e sem tela de importação no dashboard. O estado detalhado está em [status.md](status.md).
