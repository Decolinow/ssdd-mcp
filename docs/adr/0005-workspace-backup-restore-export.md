# ADR 0005: Backup e manutenção do workspace

- **Status:** aceito para SSDD-603
- **Data:** 2026-11-09

## Contexto

O workspace guarda estado atual, revisões imutáveis, eventos append-only, snapshots e as fontes das projeções. Uma cópia de arquivo feita sem coordenar o WAL pode não representar um snapshot consistente. A recuperação precisa detectar arquivos incompletos/corrompidos, evitar sobrescrever outro workspace e permitir que dados sejam inspecionados/exportados sem reproduzir credenciais.

## Decisão

- `backup` usa a API online do SQLite, executa `integrity_check` e `foreign_key_check`, e grava um arquivo novo sem substituir um existente. Um manifesto JSON versionado registra nome do banco, instante, tamanho, SHA-256, versão do schema e chaves dos projetos.
- `restore` requer o manifesto correspondente e confere hash, tamanho, schema e projetos. Só instala quando o diretório `.ssdd` do destino não existe ou está vazio. A cópia é preparada em staging, recebe as migrações suportadas, passa por checagens de integridade/FKs e é instalada por criação atômica do link no mesmo diretório.
- `doctor` abre a base read-only e informa presença, engine, journal, integridade, FKs, histórico de migrações, FTS/JSON e quantidade de projetos. Mensagens são minimizadas para não revelar tokens/chaves de identidade.
- `export` produz JSON versionado ou Markdown para dados dos projetos do workspace. Não inclui tabelas de aprovação, idempotência, migração ou sequências internas; omite colunas sensíveis e redige campos de identidade/credenciais em JSON aninhado. A exportação não é um backup restaurável.
- O operador para o servidor antes do restore e mantém backup antes de atualizar versão. Dados SQLite permanecem em um host e não há coordenação entre processos em hosts diferentes.

## Consequências

- Backups são consistentes enquanto a aplicação segue em execução, e podem ser verificados antes de uma recuperação.
- Manifestos são parte do par de backup; perder ou alterar um impede o restore. Eles verificam integridade acidental, mas não são assinatura de autenticidade contra alguém capaz de alterar banco e manifesto juntos.
- Migrações suportadas são aplicadas durante restore. O destino preserva espaço para uma recuperação sem destruir dados existentes.
- Export é adequado para consulta e compartilhamento controlado, mas não preserva dados operacionais necessários para restore e não promete importar novamente.

## Verificação

Testes cobrem snapshot online, restauração em workspace limpo, integridade de revisões/histórico e consulta de métricas após restore, hash adulterado, destino ocupado, arquivos sensíveis em export e diagnóstico de workspace ausente. O contrato da CLI é exercitado por comandos `doctor`, `backup`, `restore` e os dois formatos de exportação.
