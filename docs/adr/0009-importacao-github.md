# ADR 0009 · Importação unidirecional de issues GitHub

- **Status:** aceito para SSDD-704
- **Data:** 2026-11-10
- **Contexto:** equipes podem começar com issues já existentes no GitHub. A primeira carga precisa preservar a origem, evitar duplicatas e deixar o modelo SSDD como fonte de verdade após a importação.

## Decisão

- Usar `SSDD_GITHUB_REPOSITORY_<PROJECT_KEY>` para o repositório e `SSDD_GITHUB_ISSUES_TOKEN_<PROJECT_KEY>` para credencial read-only. O cliente chama somente `GET https://api.github.com/repos/{owner}/{repo}/issues`, fixa `state=all`, usa até 100 resultados, segue somente links `next` do endpoint/repositório esperado, rejeita redirects externos e limita cada resposta a 5 MiB.
- Excluir pull requests mesmo que retornados pela API de issues. Cada objeto de origem normalizado inclui ID/número, título/corpo, estado, labels, URL e timestamps; conteúdo do usuário não é executado ou convertido em HTML.
- Disponibilizar `github_issue_import_preview` para consulta sem persistência. O hash do plano SHA-256 inclui projeto, repositório, Feature destino, tipo local e hash/status das issues; `github_issue_import_apply` refaz a leitura e exige o mesmo hash.
- Permitir apply somente a principal `human` com papel `po`. A confirmação cria histórias/bugs em Draft sob uma Feature existente, com limite de 200 caracteres no título e 10.000 na descrição local. Snapshot imutável conserva o conteúdo de origem (até 100.000 caracteres de corpo) e informa o hash que o descreve.
- Usar provider + escopo externo + ID para identidade única. Cada PBI do projeto tem no máximo um vínculo externo. O vínculo, snapshot inicial, novo work item e auditoria são atômicos; `requestId` da aplicação é idempotente e mudança de plano sob mesma chave retorna conflito.
- Se os dados externos mudarem após a primeira importação, anexar um snapshot novo e não atualizar qualquer campo publicado/local. `external_work_item_import_runs` conserva a resposta exata de um request repetido. Não enviar escrita ao GitHub.
- Guardar vínculo, fonte e runs em tabelas append-only da migração v21. Triggers bloqueiam update/delete; SQLite backup/restore mantém os registros.

## Consequências

- A primeira carga é uma operação humana explícita depois de conferir preview e plano. Agentes/serviços podem consultar preview, mas não executam apply.
- O usuário escolhe explicitamente Feature pai e tipo (`story` ou `bug`). O estado do issue externo não vira estado de workflow local; todo item novo começa em Draft, então Ready/QA/Done continuam dependendo dos gates SSDD.
- Repetir a mesma operação retorna o mesmo recibo, e executar um plano novo ignora vínculos já existentes sem reescrever o item. Alterações externas ficam consultáveis por snapshots da origem.
- Token inválido, rate limit, resposta fora do host de paginação ou plano obsoleto não cria itens, vínculos, snapshots nem eventos de auditoria da importação.

## Validação

`npm run check` cobre preview sem escrita, paginação com PR embutido, host de paginação inválido, token inválido, hash obsoleto, request replay/conflito, vínculo/snapshot únicos, reimportação após mudança de origem sem sobrescrever edição local, limites de texto, tool MCP por cliente HTTP e ausência de métodos de escrita ao GitHub. O cliente usa a [API oficial de issues](https://docs.github.com/en/rest/issues/issues) e o [mecanismo REST de paginação](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api).
