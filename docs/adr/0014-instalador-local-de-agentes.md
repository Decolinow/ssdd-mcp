# ADR 0014: Instalador local de agentes por repositório

**Status:** Aceita
**Data:** 2026-11-10

## Contexto

Na data desta decisão (10/11/2026), o runtime do SSDD MCP e suas quatro skills funcionavam por MCP stdio, mas Claude Code, Codex e OpenCode esperavam caminhos e formatos de projeto diferentes para servidores, skills e agentes. O pacote permanece privado, então um projeto alvo precisa receber uma instalação local sem depender de publicação no registry. Repositórios podem já ter configuração própria, que não deve ser substituída. A revisão atual disponibiliza cinco skills e mantém o instalador alinhado à fonte canônica `skills/`.

## Decisão

- O checkout SSDD fornece `npm run agents:install`; o alvo precisa ser um diretório dentro de um repositório Git.
- O comando padrão é read-only e apresenta o plano. `--check` verifica drift/conflitos; `--apply` constrói o pacote quando necessário, empacota a versão local e instala dependências em staging sob `.ssdd` no alvo.
- O runtime fica em `.ssdd/agent-runtime`, separado do banco `.ssdd/ssdd.sqlite`. O manifesto registra versão, hash dos arquivos gerados e valores de configuração gerenciados.
- Skills canônicas residem em `skills/`; o instalador gera `.agents/skills` para Codex e compatibilidade OpenCode, `.claude/skills` para Claude e `.opencode/skills` no caminho nativo do OpenCode. Os agentes são renderizados em `.claude/agents`, `.codex/agents` e `.opencode/agents`, sem modelo fixado e referenciando a skill do cliente.
- Claude usa `.mcp.json` com `CLAUDE_PROJECT_DIR`; Codex recebe bloco marcado em `.codex/config.toml`; OpenCode V2 recebe merge do JSON/JSONC em `mcp.servers.ssdd_mcp`.
- Configurações e arquivos fora das entradas gerenciadas são preservados. O instalador recusa nome ocupado sem manifesto, link simbólico em caminho de escrita e arquivo gerenciado cujo hash mudou.
- Apply prepara o tarball e as dependências antes de gravar; troca o runtime por staging e restaura snapshots dos arquivos/runtime se uma gravação falhar. O runtime é ignorado pelo Git.

## Consequências

- O usuário executa a instalação a partir do checkout SSDD e pode validar o plano antes de qualquer alteração no repositório alvo.
- O instalador não inventa chave, objetivo ou fuso do projeto. Um workspace novo é inicializado explicitamente com `ssdd-mcp init` depois da instalação.
- O conteúdo pode ser atualizado sem exigir publicação npm, e a origem das skills continua única.
- O usuário ainda precisa confiar/aprovar configurações de projeto conforme cada cliente. A ferramenta não altera configurações globais, concede confiança, inicia clientes GUI ou armazena credenciais.
- Dependências de produção são instaladas localmente e o addon SQLite pode precisar do ambiente de compilação suportado pelo npm/Node da máquina.
- Não existe comando automático de desinstalação; a remoção de configurações gerenciadas permanece uma operação explícita do mantenedor do repositório.

## Referências oficiais consultadas em 2026-11-10

- [Claude Code MCP](https://code.claude.com/docs/en/mcp), [skills](https://code.claude.com/docs/en/skills) e [subagentes](https://code.claude.com/docs/en/sub-agents).
- [Codex MCP](https://developers.openai.com/codex/mcp), [skills](https://developers.openai.com/codex/skills), [subagentes](https://learn.chatgpt.com/docs/agent-configuration/subagents) e [configuração avançada](https://learn.chatgpt.com/docs/config-file/config-advanced).
- [OpenCode MCP](https://opencode.ai/docs/mcp-servers/), [skills](https://opencode.ai/docs/skills/) e [agentes](https://opencode.ai/docs/agents/).
