# ADR 0007 · Recepção autenticada de webhooks

- **Status:** aceito para SSDD-702
- **Data:** 2026-11-10
- **Contexto:** integrações externas precisam enviar eventos ao mesmo workspace que opera por Streamable HTTP. O servidor deve autenticar a origem, evitar processamento duplicado e auditar eventos sem persistir credenciais ou payloads brutos.

## Decisão

- Atender webhooks no listener `ssdd-mcp serve`, em `POST /webhooks/{provider}/{projectKey}`. Reutilizar as validações de Host/Origin e a política de bind em loopback; acesso externo continua exigindo proxy TLS.
- Configurar um segredo HMAC-SHA256 por provider/projeto em `SSDD_WEBHOOK_SECRET_<PROVIDER>__<PROJECT_KEY>`. Nomes de provider usam maiúsculas e `_` representa `-`; segredos têm de 32 a 4096 bytes e permanecem apenas na memória do processo. O caminho também fixa o projeto de auditoria.
- Limitar o corpo a 1 MiB e exigir `application/json`. Verificar a assinatura sobre os bytes recebidos com comparação em tempo constante antes de decodificar UTF-8 e parsear um objeto JSON. GitHub usa `X-GitHub-Delivery`, `X-GitHub-Event` e `X-Hub-Signature-256`; outros providers usam `X-SSDD-Delivery-Id`, `X-SSDD-Event` e `X-SSDD-Signature`.
- Persistir apenas provider, delivery ID, projeto, principal de serviço, tipo de evento, hash SHA-256, recibo original e horário. Não persistir segredo nem corpo bruto. O principal de serviço não ganha associação nem papel no projeto.
- Tornar provider + delivery ID globalmente únicos. Em `BEGIN IMMEDIATE`, uma entrega nova insere recibo imutável e evento `webhook.received` juntos. Repetição com o mesmo hash e tipo devolve o status e JSON originais; divergência no mesmo ID retorna conflito. Payload inválido, assinatura inválida, rota sem configuração ou projeto inexistente não grava estado.
- Deixar interpretação de eventos de domínio para handlers das tarefas seguintes. Esses handlers processarão o JSON verificado em memória e gravarão apenas campos normalizados necessários, junto do recibo/auditoria.

## Consequências

- A chave da integração não aparece em argumentos, logs ou banco. A rotação do segredo requer atualizar o ambiente e reiniciar o processo; o estado de recibos não muda.
- Uma entrega aceita nesta etapa gera recibo e auditoria, sem alterar backlog, build, QA ou estado do projeto. SSDD-703 adicionará allowlist e mapeamento de repositório antes de associar PRs/builds.
- O esquema v19 pode ser aplicado automaticamente ao abrir workspace existente; os triggers impedem alteração ou remoção de recibos. Backup/restore mantém esses registros porque fazem parte do SQLite.
- O endpoint exige HTTPS no tráfego externo, um segredo aleatório por integração e controle de acesso ao ambiente de execução. Não publicar diretamente o socket local do processo.
