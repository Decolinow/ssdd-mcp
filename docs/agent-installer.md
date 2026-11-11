# Instalação local para agentes de codificação

O instalador conecta um repositório Git existente ao runtime local do SSDD MCP e prepara os perfis de PO, Technical Lead, Developer, QA e Release para Claude Code, Codex e OpenCode. Ele vem neste repositório SSDD e instala um tarball local; o pacote permanece privado e não precisa ser publicado no npm.

## Uso

Execute os comandos na raiz deste repositório SSDD. O alvo deve ser um diretório dentro de um repositório Git. Sem opção de modo, o comando executa `--dry-run` e não grava arquivos nem instala dependências.

```powershell
npm run agents:install -- --target ..\meu-projeto
npm run agents:install -- --target ..\meu-projeto --check
npm run agents:install -- --target ..\meu-projeto --apply
```

`--check` termina com código 0 quando o alvo corresponde à versão local e com código 1 quando faltam arquivos, há divergência ou existe conflito. `--apply` constrói o pacote se os arquivos compilados estiverem desatualizados, gera um tarball privado local e instala as dependências de produção em `.ssdd/agent-runtime/node_modules/ssdd-mcp` no alvo.

O instalador prepara o servidor, mas não inventa a chave, o objetivo ou o fuso do projeto. Se o alvo ainda não tiver workspace SSDD, inicialize-o com os dados escolhidos pela equipe antes de iniciar o cliente:

```powershell
node .ssdd/agent-runtime/node_modules/ssdd-mcp/dist/src/cli.js init --workspace . --key PAY --name "Pagamentos" --goal "Pagamentos confiáveis" --timezone America/Sao_Paulo
```

## Arquivos criados ou atualizados

| Destino | Conteúdo |
|---|---|
| `.ssdd/agent-runtime/` | Runtime privado local e manifesto `ssdd-agent-stack.json` com hashes e configuração gerenciada |
| `.mcp.json` | Servidor stdio `ssdd_mcp` project-scope do Claude Code |
| `.codex/config.toml` | Bloco TOML gerenciado `[mcp_servers.ssdd_mcp]` do Codex |
| `opencode.json` ou `opencode.jsonc` | Servidor local em `mcp.servers.ssdd_mcp` na configuração V2 do OpenCode |
| `.agents/skills/<id>/SKILL.md` | Cinco skills canônicas, descobertas pelo Codex e pelo OpenCode |
| `.claude/skills/<id>/SKILL.md` | Cinco cópias para a descoberta nativa de skills do Claude Code |
| `.opencode/skills/<id>/SKILL.md` | Cinco cópias para a descoberta nativa de skills do OpenCode |
| `.claude/agents/*.md` | Cinco agentes nativos de Claude Code |
| `.codex/agents/*.toml` | Cinco agentes nativos de Codex |
| `.opencode/agents/*.md` | Cinco agentes nativos de OpenCode |

O instalador preserva chaves, comentários e outros servidores existentes. JSONC é editado por caminho; o bloco do Codex fica entre marcadores SSDD para que alterações fora dele permaneçam intactas. Se o nome `ssdd_mcp` já estiver ocupado sem um manifesto SSDD que comprove sua propriedade, o instalador informa o conflito e interrompe a aplicação. Alterações locais em skills ou perfis gerados também são detectadas pelos hashes.

O runtime é instalado em staging no próprio diretório `.ssdd` do alvo. Só depois de confirmar o pacote e suas dependências o instalador troca o `node_modules` local e grava as configurações. Se a aplicação falha, ele restaura os arquivos e o runtime anteriores. O diretório do runtime é ignorado pelo Git; se as regras existentes não o ignorarem, o instalador adiciona `/.ssdd/agent-runtime/` ao `.gitignore` sem remover outras regras.

## Formatos nativos e confiança

As configurações seguem a documentação oficial verificada em **10/11/2026**:

| Cliente | Configuração MCP | Skills | Agentes |
|---|---|---|---|
| Claude Code | `.mcp.json`, `type: "stdio"`; caminho e workspace usam `${CLAUDE_PROJECT_DIR:-.}` | `.claude/skills/<id>/SKILL.md` | `.claude/agents/<id>.md`, com skill carregada pelo agente |
| Codex | `.codex/config.toml`, tabela `[mcp_servers.ssdd_mcp]` | `.agents/skills/<id>/SKILL.md` | `.codex/agents/<id>.toml`, com `name`, `description` e `developer_instructions` |
| OpenCode V2 | `opencode.json`/`.jsonc`, `mcp.servers.<id>`, `type: "local"` | `.opencode/skills/<id>/SKILL.md` (e `.agents/skills` como compatibilidade compartilhada) | `.opencode/agents/<id>.md`, `mode: subagent` |

O Claude Code pede aprovação para o servidor MCP configurado no projeto. O Codex carrega configuração de projeto depois que o repositório é confiável. O instalador prepara os arquivos, mas não concede essa confiança nem aprova o servidor em nome da pessoa. Nenhum perfil fixa um modelo ou armazena segredos.

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
