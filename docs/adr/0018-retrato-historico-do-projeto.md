# ADR 0018 · Retrato histórico do projeto por data

**Estado:** Aceito  
**Data:** 2026-11-11

## Contexto

A aba Métricas já aceita uma data de corte, mas os demais painéis mostram projeções atuais. Reutilizar a mesma tela com uma data antiga faria WIP, cobertura, responsáveis e listas correntes parecerem históricos sem que os dados permitissem essa afirmação. O projeto já mantém fontes temporais fortes para parte do domínio: revisões publicadas imutáveis, transições, escopos append-only, execuções QA, eventos de sessão e de release e auditoria.

## Decisão

Adicionar `GET /api/v1/projects/{projectId}/history` e uma aba **Histórico** separada. A consulta é somente leitura, valida autorização do projeto e monta uma projeção dentro de uma transação SQLite. `asOfDate` representa o fim do dia no fuso configurado do projeto; datas futuras são recusadas. Sem `asOfDate`, a API usa a data atual no fuso do projeto.

O retrato cobre:

- criação, conteúdo publicado e estado de PBIs no corte;
- publicações de especificações e cenários até o corte;
- execuções QA e vínculos de tarefa registrados até o corte;
- estado e tempo ativo de sessões reconstruídos pelos eventos;
- deployments registrados para homologação/produção;
- estado e escopo de sprints e escopo aprovado de marcos;
- atividade auditada e watermarks da fonte e do corte.

A lista de itens usa cursor opaco vinculado ao projeto, à data, ao watermark de auditoria e ao horário da primeira captura. Alteração auditada entre páginas retorna `STALE_CURSOR`, e o dashboard reinicia a consulta para não misturar snapshots. Totais são calculados para o projeto inteiro; as listas de apoio são limitadas e identificam truncamento. A migração v27 acrescenta índices por projeto/data para consultas de transições, publicações, auditoria, QA, sessões, releases e escopos.

Sessões abertas acumulam tempo somente até o instante de captura, mesmo quando o corte do dia corrente ainda está no futuro. O painel explicita que responsável, ordenação e estimativas de PBI não são reconstruídos nessa visão. Valores correntes da aba Métricas permanecem em uma seção separada e não são interpolados para o passado.

## Consequências

- A experiência oferece uma leitura temporal consistente das principais trilhas imutáveis existentes sem alterar o formato de armazenamento nem adicionar eventos artificiais.
- A projeção evita chamar dados atuais de históricos e mostra o limite exato do corte e o watermark da fonte.
- Campos que ainda podem mudar sem uma trilha temporal própria ficam fora do snapshot. Uma demanda futura por esses campos requer histórico append-only ou revisão bitemporal e uma nova decisão de domínio.
- Consultas históricas não viram uma ferramenta MCP nova nesta entrega; a interface local usa os mesmos serviços e autorização do projeto.
