# Instalação local para agentes de codificação

O instalador conecta um repositório Git existente ao runtime local do SSDD MCP e prepara dez skills e dez agentes para Claude Code, Codex e OpenCode. Ele vem neste repositório SSDD e instala um tarball local; o pacote permanece privado e não precisa ser publicado no npm. As skills canônicas de Tech Lead, Developer, desenho de testes e QA descrevem a proposta, publicação, execução ordenada e limites do workflow ponderado por tarefa. O instalador copia essas instruções para os três clientes e atualiza seus agentes gerados sem uma etapa específica ou artefato manual por produto.

## Pré-requisitos

- Node.js 24 ou 26 (`engines`: `^24.0.0 || ^26.0.0`) e npm 10 ou superior, no computador que executa o instalador.
- Este repositório SSDD com dependências instaladas (`npm install`).
- Um repositório Git existente como alvo; o instalador não cria o repositório.
- Acesso de escrita ao alvo. A instalação das dependências de produção do runtime é local, a partir do tarball gerado aqui.

## Uso

Execute os comandos na raiz deste repositório SSDD. O alvo deve ser um diretório dentro de um repositório Git. Sem opção de modo, o comando executa `--dry-run` e não grava arquivos nem instala dependências.

```powershell
npm run agents:install -- --target ..\meu-projeto
npm run agents:install -- --target ..\meu-projeto --check
npm run agents:install -- --target ..\meu-projeto --apply
npm run agents:install -- --target ..\meu-projeto --apply --profile tech_lead
```

`--check` termina com código 0 quando o alvo corresponde à versão local e com código 1 quando faltam arquivos, há divergência ou existe conflito. `--apply` constrói o pacote se os arquivos compilados estiverem desatualizados, gera um tarball privado local e instala as dependências de produção em `.ssdd/agent-runtime/node_modules/ssdd-mcp` no alvo.

`--profile` é opcional e grava o perfil MCP na configuração nativa do Claude Code (`env.SSDD_PROFILE`), Codex (`mcp_servers.ssdd_mcp.env.SSDD_PROFILE`) e OpenCode (`environment.SSDD_PROFILE`). Use o mesmo argumento em `--check` e `--apply`; isso limita as ferramentas, prompts e skills que o host anuncia. Opções: `full`, `refinement`, `specification`, `dev`, `test_design`, `qa`, `tech_lead`, `security_review`, `po`, `facilitator`, `release`, `devops` e `admin`. Sem `--profile`, o servidor usa o perfil padrão `full`.

O instalador prepara o servidor, mas não inventa a chave, o objetivo ou o fuso do projeto. As instruções geradas para Claude Code, Codex e OpenCode incluem o mesmo contrato de falha: agentes devem tratar `isError=true` como chamada malsucedida, ler `code/details/retryable/correlationId`, não declarar mutações concluídas em erro, repetir somente quando `retryable=true` e reconciliar o estado após timeout/conflitos. Em comandos idempotentes, a repetição segura conserva o `requestId` e o payload; erros internos são reportados pelo `correlationId` sem revelar credenciais.

Se o alvo ainda não tiver workspace SSDD, inicialize-o com os dados escolhidos pela equipe antes de iniciar o cliente:

```powershell
node .ssdd/agent-runtime/node_modules/ssdd-mcp/dist/src/cli.js init --workspace . --key PAY --name "Pagamentos" --goal "Pagamentos confiáveis" --timezone America/Sao_Paulo
```

## Recuperação

- **`--check` retorna 1:** rode `--dry-run` para ver o que falta, diverge ou está em conflito. Divergência por edição local: reverta a edição ou atualize a skill/template canônico e aplique de novo. Conflito com o nome `ssdd_mcp`: renomeie ou remova a entrada que não é do SSDD e repita `--apply`.
- **`--apply` falhou:** o instalador restaura os arquivos e o runtime anteriores; rode `--check` para confirmar o estado e repita `--apply` depois de corrigir a causa (rede, permissão, versão do Node).
- **Cliente não enxerga o servidor:** reinicie o cliente e aprove o servidor MCP/confie no repositório (veja "Formatos nativos e confiança").
- **Banco do workspace suspeito:** `node .ssdd/agent-runtime/node_modules/ssdd-mcp/dist/src/cli.js doctor --workspace .` valida schema, integridade e chaves estrangeiras; `backup` grava uma cópia e `restore --backup <arquivo.sqlite>` a restaura com as instâncias do workspace paradas, exigindo `.ssdd` ausente ou vazio e o manifesto do backup ao lado do arquivo.

## Arquivos criados ou atualizados

| Destino | Conteúdo |
|---|---|
| `.ssdd/agent-runtime/` | Runtime privado local e manifesto `ssdd-agent-stack.json` com hashes e configuração gerenciada |
| `.mcp.json` | Servidor stdio `ssdd_mcp` project-scope do Claude Code |
| `.codex/config.toml` | Bloco TOML gerenciado `[mcp_servers.ssdd_mcp]` do Codex |
| `opencode.json` ou `opencode.jsonc` | Servidor local em `mcp.servers.ssdd_mcp` na configuração V2 do OpenCode |
| `.agents/skills/<id>/SKILL.md` | Dez skills canônicas, descobertas pelo Codex e pelo OpenCode |
| `.claude/skills/<id>/SKILL.md` | Dez cópias para a descoberta nativa de skills do Claude Code |
| `.opencode/skills/<id>/SKILL.md` | Dez cópias para a descoberta nativa de skills do OpenCode |
| `.claude/agents/*.md` | Dez agentes nativos de Claude Code |
| `.codex/agents/*.toml` | Dez agentes nativos de Codex |
| `.opencode/agents/*.md` | Dez agentes nativos de OpenCode |

O instalador preserva chaves, comentários e outros servidores existentes. JSONC é editado por caminho; o bloco do Codex fica entre marcadores SSDD para que alterações fora dele permaneçam intactas. Se o nome `ssdd_mcp` já estiver ocupado sem um manifesto SSDD que comprove sua propriedade, o instalador informa o conflito e interrompe a aplicação. Alterações locais em skills ou perfis gerados também são detectadas pelos hashes.

O runtime é instalado em staging no próprio diretório `.ssdd` do alvo. Só depois de confirmar o pacote e suas dependências o instalador troca o `node_modules` local e grava as configurações. Se a aplicação falha, ele restaura os arquivos e o runtime anteriores. O diretório do runtime é ignorado pelo Git; se as regras existentes não o ignorarem, o instalador adiciona `/.ssdd/agent-runtime/` ao `.gitignore` sem remover outras regras.

## Formatos nativos e confiança

As configurações seguem a documentação oficial verificada em **10/11/2026**:

| Cliente | Configuração MCP | Skills | Agentes |
|---|---|---|---|
| Claude Code | `.mcp.json`, `type: "stdio"`; caminho e workspace usam `${CLAUDE_PROJECT_DIR:-.}`; perfil opcional em `env` | `.claude/skills/<id>/SKILL.md` | `.claude/agents/<id>.md`, com skill carregada pelo agente |
| Codex | `.codex/config.toml`, tabela `[mcp_servers.ssdd_mcp]`; perfil opcional em `env` | `.agents/skills/<id>/SKILL.md` | `.codex/agents/<id>.toml`, com `name`, `description` e `developer_instructions` |
| OpenCode V2 | `opencode.json`/`.jsonc`, `mcp.servers.<id>`, `type: "local"`; perfil opcional em `environment` | `.opencode/skills/<id>/SKILL.md` (e `.agents/skills` como compatibilidade compartilhada) | `.opencode/agents/<id>.md`, `mode: subagent` |

O Claude Code pede aprovação para o servidor MCP configurado no projeto. O Codex carrega configuração de projeto depois que o repositório é confiável. O instalador prepara os arquivos, mas não concede essa confiança nem aprova o servidor em nome da pessoa. Nenhum perfil de agente fixa um modelo ou armazena segredos.

`--profile` limita a superfície anunciada pelo MCP para aquela conexão, e a autorização continua validada em cada operação. O perfil fica na entrada compartilhada do servidor: agentes nativos do mesmo cliente herdam a mesma superfície; para executar uma etapa diferente, aplique o perfil correspondente e reinicie o cliente. `full` anuncia o catálogo completo, mas aumenta o contexto. `task_context_get.profile` seleciona conteúdo de tarefa, não tools. Injete `SSDD_AUTH_KEY`/tokens por um secret manager do cliente ou do host; não grave segredos em arquivos gerados ou no Git.

Fontes oficiais:

- Claude Code: [servidores MCP](https://code.claude.com/docs/en/mcp), [skills](https://code.claude.com/docs/en/skills) e [subagentes](https://code.claude.com/docs/en/sub-agents).
- Codex: [servidores MCP](https://developers.openai.com/codex/mcp), [skills](https://developers.openai.com/codex/skills), [subagentes](https://learn.chatgpt.com/docs/agent-configuration/subagents) e [configuração avançada](https://learn.chatgpt.com/docs/config-file/config-advanced).
- OpenCode: [servidores MCP](https://opencode.ai/docs/mcp-servers/), [skills](https://opencode.ai/docs/skills/) e [agentes](https://opencode.ai/docs/agents/).

## Fluxo de atualização

1. Atualize as skills canônicas ou os formatos gerados no pacote SSDD.
2. Rode `npm run agents:install -- --target <repositório> --dry-run` e revise conflitos e arquivos a atualizar.
3. Aplique com `--apply` e confirme com `--check`.
4. Reinicie ou atualize o cliente para ele carregar os perfis e o servidor MCP.

Não edite os arquivos gerados para manter mudanças permanentes: atualize a skill ou o template canônico neste repositório. Configurações não gerenciadas são preservadas; se uma entrada SSDD gerenciada for editada ou removida, resolva o conflito explicitamente antes de atualizar.

## Testes e evidências

`tests/scripts/install-agent-stack.test.ts` cobre dry-run sem escrita, conflitos, preservação de JSONC/TOML, instalação num repositório temporário, nova verificação idempotente, alteração local e handshake com um cliente MCP stdio real. O teste lê ferramentas e skills do servidor instalado. A suíte não afirma ter iniciado as interfaces gráficas dos três clientes nem substitui a revisão de confiança/aprovação de cada um.

O backlog está em [ROADMAP.md](../ROADMAP.md#backlog-de-instala%C3%A7%C3%A3o-para-claude-code-codex-e-opencode), com estimativas e dependências. A decisão de manter o runtime local e as regras de atualização está no [ADR 0014](adr/0014-instalador-local-de-agentes.md).
