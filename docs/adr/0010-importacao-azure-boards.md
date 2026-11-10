# ADR 0010 · Importação unidirecional do Azure Boards

- **Status:** aceito para SSDD-705
- **Data:** 2026-11-10
- **Contexto:** projetos podem começar com itens no Azure Boards. A carga precisa identificar a origem, preservar as edições feitas no SSDD e não abrir um canal de escrita para o provedor.

## Decisão

- Configurar por chave de projeto SSDD: `SSDD_AZURE_DEVOPS_ORGANIZATION_<PROJECT_KEY>`, `SSDD_AZURE_DEVOPS_PROJECT_<PROJECT_KEY>` e `SSDD_AZURE_DEVOPS_TOKEN_<PROJECT_KEY>`. No MVP, o token é um PAT organizacional via HTTP Basic Auth, restrito a leitura de work items, com escopo mínimo e validade curta. Tokens ficam só no ambiente do processo; PATs globais deixam de funcionar em 27 de janeiro de 2027.
- Fixar todas as chamadas em `https://dev.azure.com`, rejeitar redirects e limitar cada resposta a 5 MiB. Usar API REST 7.1. WIQL seleciona somente o tipo remoto escolhido e limita o resultado a 100 IDs; `workitemsbatch` lê os campos em lotes de até 200.
- Tratar os POSTs de WIQL e batch como consultas documentadas. O cliente não chama criação, atualização ou exclusão e os testes falham se aparecer outro endpoint ou método.
- Publicar `azure_work_item_import_preview` e `azure_work_item_import_apply`. Mapear explicitamente `User Story → story` e `Bug → bug`; mostrar e ignorar tipos ausentes, desconhecidos ou divergentes do filtro escolhido. Exigir Feature de destino.
- Calcular SHA-256 sobre o projeto, escopo organização/projeto, Feature, tipos externo/local e snapshots de origem. Preview não grava. Apply refaz a consulta, requer o mesmo hash e `requestId`, e só é permitido a uma pessoa `human` com papel `po`.
- Criar itens novos em Draft e gravar item, vínculo externo único, snapshot da origem, execução idempotente e auditoria na mesma transação. A origem pode gerar snapshots posteriores, mas nunca sobrescreve título ou descrição local. Migração v21 guarda vínculo, snapshots e execuções como append-only.
- Manter PAT organizacional como caminho MVP para configuração simples; para serviços de longa duração, priorizar Microsoft Entra ID em uma tarefa futura, conforme a orientação oficial de autenticação do Azure DevOps.

## Consequências

- A equipe pode revisar o plano antes de importar e aplicar somente após uma confirmação humana PO.
- Cada chamada importa no máximo 100 work items e o tipo local decorre do tipo Azure selecionado, sem mapeamento arbitrário fornecido pelo cliente.
- Estados remotos não mudam o workflow local. Itens importados continuam em Draft e seguem os gates normais de conteúdo, estimativa, baseline e QA.
- `external_work_item_links` usa provider + organização/projeto + ID externo como identidade global. Replays são idempotentes, vínculos cruzados de projeto não são duplicados e mudanças remotas são preservadas em snapshots.

## Validação

Fixtures verificam WIQL, Basic Auth, API version, limite de lote, campos, tags, URL oficial, respostas com tipo ausente/desconhecido, credenciais inválidas e erro de provedor sanitizado. Um cliente MCP HTTP percorre preview e apply e confirma que todos os POSTs vão somente aos endpoints WIQL/batch. Os testes de aplicação verificam o mapeamento para Draft, seleção de tipo e snapshots.

Referências oficiais: [Query By WIQL REST 7.1](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql?view=azure-devops-rest-7.1), [Get Work Items Batch REST 7.1](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-items-batch?view=azure-devops-rest-7.1), [autenticação e ciclo de vida de PAT](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops) e [orientação para chamadas REST](https://learn.microsoft.com/en-us/azure/devops/integrate/how-to/call-rest-api?view=azure-devops).
