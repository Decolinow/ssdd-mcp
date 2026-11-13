# ADR 0020 · Catálogos por etapa e busca semântica eficiente

- **Status:** Aceita
- **Data:** 2026-11-11
- **Contexto:** os perfis existentes filtravam `tools/list`, porém todos os agentes ainda descobriam os mesmos prompts e skills. O catálogo comum de tools também misturava etapas. A busca semântica lia e decodificava um conjunto inteiro de candidatos e executava uma consulta SQLite por item.

## Decisão

1. Um perfil MCP representa a superfície de trabalho esperada numa etapa: `refinement`, `specification`, `dev`, `test_design`, `qa`, `tech_lead`, `security_review`, `po`, `facilitator`, `release`, `devops`, `admin` ou `full`.
2. O perfil seleciona separadamente os nomes de tools, prompts e skills. Tools continuam chamando os mesmos serviços; o perfil não adiciona autorização nem muda papéis ou gates de domínio.
3. `security_review` é somente leitura e não apresenta busca/indexação semântica, porque essas operações podem enviar texto ao provedor externo configurado. A skill `ssdd-system-administrator` só é servida ao administrador singleton autenticado, inclusive no perfil `full`.
4. As dez skills da pasta `skills/` são a fonte canônica dos agentes; o instalador nativo mantém a mesma lista, e testes falham quando uma tool registrada não está coberta por nenhum perfil curado.
5. A busca semântica lê o cache em join, percorre os candidatos com o iterador do SQLite, mantém somente top-K em memória por inserção binária e carrega detalhes completos apenas dos resultados. Atualizações de vetores verificam conteúdo atual em lote dentro da transação de persistência. O escopo é contado e recusado acima de 10.000 antes de qualquer chamada ao provedor. O limite de vetor é 8.192 dimensões.

## Consequências

- Perfis direcionados reduzem a lista de capacidades que o host injeta ou mostra ao agente; `full` continua disponível para exploração e ferramentas ainda obedecem a autorização por projeto.
- A habilidade de administrar chaves deixa de aparecer a um usuário comum que seleciona `admin` ou `full` por conveniência.
- A busca usa O(n × dimensão + n × limit) no pior caso, com vetor e ranking limitados ao candidato corrente e top-K; não reordena toda a lista de resultados em cada item. O teto de 10.000 itens mantém o custo explícito, e SSDD-923 registra a medição p50/p95 antes de fixar SLOs.
- Não há migração de banco. A mudança de perfil é configuração de runtime e a otimização consulta os mesmos vetores existentes.

## Verificação

- Testes de unidade conferem a matriz de perfil, os prompt/skills permitidos e o limite read-only de segurança.
- Um teste compara o registro MCP à união dos perfis curados; testes stdio e Streamable HTTP exercitam descoberta de catálogo.
- Testes da busca conferem autorização, filtro, cache, cursor, dimensão, ordenação determinística de top-K, limite anterior à rede e paginação de indexação.

Regras de operação e configuração estão em [docs/mcp.md](../mcp.md#identidade-perfis-e-busca-sem%C3%A2ntica).
