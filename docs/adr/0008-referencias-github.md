# ADR 0008 · Referências de pull request e CI do GitHub

- **Status:** aceito para SSDD-703
- **Data:** 2026-11-10
- **Contexto:** PRs e resultados de CI precisam aparecer ligados ao backlog para dar contexto de implementação. A integração deve preservar as decisões de domínio do SSDD: uma entrega externa não pode mover um item nem certificar QA.

## Decisão

- Configurar uma relação explícita de projeto para repositório com `SSDD_GITHUB_REPOSITORY_<PROJECT_KEY>=<owner>/<repository>`. O webhook assinado também exige o segredo `SSDD_WEBHOOK_SECRET_GITHUB__<PROJECT_KEY>`. Comparar `repository.full_name` sem diferenciar maiúsculas/minúsculas; repositório ausente/divergente ou projeto inexistente responde 404 e reverte toda gravação.
- Processar `pull_request` somente para `opened`, `reopened`, `synchronize`, `edited`, `closed`, `ready_for_review` e `converted_to_draft`. Processar `workflow_run` somente em `completed`. Outros eventos ou ações assinados podem receber recibo idempotente, mas não criam referência de domínio.
- Extrair uma chave `<PROJECT_KEY>-<número>` primeiro do branch e depois do título do PR. Chave que ainda não existe é mantida como texto sem vínculo a work item. Workflow run guarda seus PRs associados e usa o branch, com fallback ao vínculo do PR mais recente, para associar o item.
- Guardar snapshots normalizados append-only na migração v20 e ligá-los ao recibo imutável de v19. Uma nova entrega produz novo snapshot; repetição do mesmo provider + delivery ID devolve o recibo existente e não reprocessa o evento. A consulta pública `github_reference_list` devolve apenas a última observação de cada PR/run e exige autorização de membro do projeto.
- Guardar campos de repositório, PR, branch, SHA, run, URL, estado/conclusão, associação e chave resolvida. Não guardar corpo bruto, segredo, checks de aprovação ou inferências de qualidade. Cada observação gera evento de auditoria correlacionado ao recibo, na mesma transação.
- Não alterar `work_items`, `test_runs`, certificações QA, gates, baselines ou estado de sprint. O resultado de CI é somente uma referência observada; evidência e certificação continuam sob os fluxos existentes.

## Consequências

- A equipe configura repositório e segredo no ambiente do processo; mudanças nesses valores exigem reinício para serem carregadas.
- PRs e workflows têm uma projeção imutável e consultável sem acesso de escrita ao GitHub. Eventos não suportados continuam auditáveis como recebimento, porém não aparecem em `github_reference_list`.
- A chave de work item pode existir depois do recebimento; nesse caso a referência guarda a chave textual, mas `workItemId` permanece nulo até uma nova entrega permitida trazer a associação.
- Migração e snapshots fazem parte do SQLite e acompanham backup/restore. Triggers impedem alteração e remoção dos snapshots.

## Validação

`npm run check` cobre assinatura, replay, conflito, repositório incompatível/não configurado, ações fora da allowlist, vínculo de PR e workflow a work item, filtros/leitura MCP, imutabilidade, auditoria, isolamento e preservação de estado/certificação QA. Cabeçalhos e assinatura seguem a [documentação oficial do GitHub para validar entregas de webhook](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
