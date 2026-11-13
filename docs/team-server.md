# Servidor MCP para uma equipe

Este runbook descreve como publicar um servidor SSDD por Streamable HTTP para vários clientes e como limitar cada identidade a um ou mais projetos. O modo recomendado hoje é **uma instância SSDD em um host**, acessada por clientes remotos através de um proxy TLS com OAuth/OIDC. O servidor atende vários clientes concorrentes e projetos no mesmo workspace; a persistência SQLite não torna segura uma implantação ativa em múltiplos nós.

## Topologia suportada

```mermaid
flowchart LR
  C1[Cliente MCP 1] -->|HTTPS + token OIDC| P[Proxy TLS]
  C2[Cliente MCP 2] -->|HTTPS + token OIDC| P
  C3[Cliente MCP N] -->|HTTPS + token OIDC| P
  P -->|loopback /mcp| S[ssdd-mcp serve]
  S --> DB[(Workspace SQLite local)]
  S --> IDP[Issuer OIDC / JWKS]
  S -->|projectId + RBAC| PR[Projetos autorizados]
```

- O processo escuta somente em `127.0.0.1`; não há opção para bind em interface pública.
- O proxy publica `POST/GET/DELETE /mcp` e o metadata OAuth `GET /.well-known/oauth-protected-resource/mcp` em HTTPS. Mantenha `Host` público ao encaminhar para o processo.
- `/healthz` e `/readyz` são probes mínimos para a rede local do operador; não os publique externamente.
- O diretório `.ssdd` e seu banco devem estar em armazenamento persistente local do mesmo host do processo. Não use NFS/SMB nem execute dois processos `serve` ativos sobre o mesmo arquivo.
- O protocolo moderno `2026-07-28` é sem sessão de transporte. Clientes que negociam uma versão anterior podem usar sessão legacy mantida em memória; reiniciar o processo desconecta essas sessões, e balancear clientes legacy exigiria afinidade de sessão. Essas propriedades do protocolo não removem o limite de escrita do SQLite desta aplicação. Consulte a [especificação Streamable HTTP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx) e o [guia de serving do SDK TypeScript](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md).

## Preparar workspace e projetos

Use Node.js 24 ou 26 e npm 10 ou superior. No host de serviço:

```sh
npm ci
npm run build
node dist/src/cli.js init --workspace /srv/ssdd --key PAY --name "Pagamentos" --goal "Pagamentos confiáveis" --timezone America/Sao_Paulo
node dist/src/cli.js init --workspace /srv/ssdd --key CRM --name "Relacionamento" --goal "Relacionamento com clientes" --timezone America/Sao_Paulo
node dist/src/cli.js doctor --workspace /srv/ssdd
```

Cada `init` com uma chave nova registra outro projeto no mesmo `.ssdd/ssdd.sqlite`; repetir a mesma configuração é idempotente. Uma chave já usada com configurações divergentes falha sem substituir dados.

## Configurar identidade e autorização

### Bootstrap admin e authKey

No primeiro startup do host MCP, o principal local do usuário de sistema operacional que inicia o servidor vira o administrador singleton da instância. O processo gera uma chave `ssdd_...` e a imprime uma vez em `stderr`. Capture-a no console/secret manager durante a configuração inicial; ela não pode ser recuperada do banco. Se o serviço já estiver ativo, faça esse bootstrap antes de ativá-lo como serviço, em uma sessão controlada com o mesmo workspace. A chave do admin pode ser rotacionada por `user_auth_key_rotate` enquanto houver outro acesso administrativo confiável.

Conecte uma vez com `Authorization: Bearer <authKey-do-admin>` e perfil `admin` ou `full`. Use `user_create` para informar nome, tipo (`human`, `agent`, `service`), projetos e papéis mínimos por projeto. O retorno traz a authKey do novo usuário apenas naquela resposta; entregue-a por canal seguro. O admin pode consultar prefixo/uso por `user_list`, trocar a chave por `user_auth_key_rotate` ou bloquear conexões com `user_auth_key_revoke`. Um replay idempotente não revela novamente a chave.

AuthKey é um método de autenticação do SSDD, independente do issuer OIDC. HTTP recebe `Authorization: Bearer <authKey>` em `/mcp`; quando OIDC está configurado, o handler aceita uma chave SSDD válida ou um JWT OIDC válido. A chave deve trafegar somente por HTTPS no proxy. Para stdio, o operador passa `SSDD_AUTH_KEY` no ambiente do processo do cliente. Sem authKey em loopback e sem OIDC, a compatibilidade local continua usando a conta do sistema operacional que roda o servidor.

O cliente também pode escolher um perfil para reduzir tools, prompts e skills listados. HTTP envia `X-SSDD-Profile` com um destes valores: `refinement`, `specification`, `dev`, `test_design`, `qa`, `tech_lead`, `security_review`, `po`, `facilitator`, `release`, `devops`, `admin` ou `full`. No stdio use `SSDD_PROFILE`; `full` é padrão. O perfil deve corresponder à etapa esperada, mas não substitui papéis de projeto nem gates humanos. Em sessões legacy HTTP, o perfil é fixo no handshake; na modalidade sem sessão, é aplicado por requisição. A matriz por perfil e os limites estão em [docs/mcp.md](mcp.md#identidade-perfis-e-busca-sem%C3%A2ntica).

Crie um resource no provedor OIDC com issuer público estável e tokens de acesso JWT assinados por algoritmo assimétrico. O access token deve conter `iss`, `sub`, `exp`, `aud` compatível com a URL do MCP e o scope `ssdd:mcp`. O servidor valida descoberta/JWKS e não emite tokens nem aceita token opaco.

Depois de iniciar o modo OIDC, provisiona-se cada identidade `iss+sub` no banco e concede-se o menor conjunto de papéis necessário por projeto. Rode o comando administrativo localmente como principal com papel `admin`:

```sh
node dist/src/cli.js access grant --workspace /srv/ssdd --project PAY \
  --issuer https://login.example.com/tenant --subject "subject-from-token" \
  --display-name "Ana Souza" --type human --roles po,developer \
  --reason "Acesso de engenharia ao projeto PAY"
```

Repita o grant para `CRM` somente se a pessoa ou serviço também precisar desse projeto. Use `--type agent` ou `--type service` para automações; esses tipos não passam gates que exigem pessoa humana. Revogue papéis com `access revoke`. Claims de papéis do token não concedem acesso. Mutações feitas por agentes/serviços continuam sujeitas aos mecanismos de aprovação de uso único do SSDD.

Configure issuer, URL canônica e porta. A URL do resource precisa ser HTTPS pública e terminar em `/mcp`:

```sh
node dist/src/cli.js serve --workspace /srv/ssdd --port 4319 \
  --oidc-issuer https://login.example.com/tenant \
  --resource-url https://mcp.example.com/mcp
```

Se um cliente legítimo enviar `Origin`, `--allowed-origin <hostname>` adiciona hostnames à verificação de origem, apenas no modo OIDC. Passe somente hostname, sem esquema, porta ou caminho. Isso não habilita CORS. Não inclua origem de navegador sem necessidade.

## Proxy TLS de referência (Nginx)

Configure certificado e política TLS no bloco `server` público. Encaminhe somente `/mcp`; ajuste o caminho do upstream e preserve o Host canônico usado em `--resource-url`:

```nginx
server {
    listen 443 ssl;
    server_name mcp.example.com;

    # ssl_certificate e ssl_certificate_key são configurados pela operação TLS.

    location = /mcp {
        proxy_pass http://127.0.0.1:4319/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location = /.well-known/oauth-protected-resource/mcp {
        proxy_pass http://127.0.0.1:4319/.well-known/oauth-protected-resource/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location / {
        return 404;
    }
}
```

Não exponha `4319` na interface de rede, não encaminhe o dashboard local e não encaminhe `/healthz` ou `/readyz`. O caminho de metadata é necessário para o discovery OAuth do resource server. A configuração acima é um exemplo de roteamento; autenticação de acesso à rede, certificados, rate limits e política de logs pertencem à infraestrutura da organização.

## Executar como serviço no Linux

Instale o pacote/build em `/opt/ssdd-mcp`, crie uma conta de serviço sem shell interativo e deixe `/srv/ssdd/.ssdd` gravável somente por ela. Configure integrações opcionais em `/etc/ssdd-mcp.env` com permissões `root:root 0600`; essa unidade não grava segredo no repositório.

```ini
# /etc/systemd/system/ssdd-mcp.service
[Unit]
Description=SSDD MCP Streamable HTTP server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ssdd
Group=ssdd
WorkingDirectory=/opt/ssdd-mcp
Environment=NODE_ENV=production
EnvironmentFile=-/etc/ssdd-mcp.env
ExecStart=/usr/bin/node /opt/ssdd-mcp/dist/src/cli.js serve --workspace /srv/ssdd --port 4319 --oidc-issuer https://login.example.com/tenant --resource-url https://mcp.example.com/mcp
Restart=on-failure
RestartSec=5s
KillSignal=SIGTERM
TimeoutStopSec=35s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/ssdd/.ssdd

[Install]
WantedBy=multi-user.target
```

Adapte o caminho do Node, issuer, URL, usuário e workspace. Aplique com `systemctl daemon-reload` e `systemctl enable --now ssdd-mcp`; acompanhe `systemctl status ssdd-mcp` e `journalctl -u ssdd-mcp`. `SIGTERM` fecha o listener, handlers e sessões legacy antes de o processo sair. Reinício encerra qualquer sessão legacy que ainda estivesse conectada.

## Conectar um cliente e escolher o projeto

Configure o cliente MCP como servidor remoto Streamable HTTP usando `https://mcp.example.com/mcp` e o fluxo OAuth compatível do cliente/provedor. O metadata OAuth precisa estar acessível em `https://mcp.example.com/.well-known/oauth-protected-resource/mcp`. A forma do arquivo de configuração varia por cliente; use o campo de URL HTTP remoto, não `command/args` stdio.

O projeto é escolhido no cliente/agente e enviado **em cada chamada**:

1. Ao conectar, chame `project_list`; a resposta já contém somente projetos autorizados para a identidade autenticada (authKey ou OIDC) e lista os papéis concedidos.
2. Se houver mais de um, peça à pessoa para escolher por chave/nome. Guarde o UUID retornado como contexto do cliente.
3. Use esse UUID no argumento `projectId` de cada ferramenta; valide o projeto com `project_get` antes de iniciar uma operação mutável.
4. Para trocar de projeto, escolha outro UUID de `project_list`. Cada chamada ainda passa autorização no servidor, inclusive para um UUID que o cliente tente enviar diretamente.

Não existe “projeto ativo” global no processo nem estado escondido compartilhado entre conexões. Essa escolha evita que dois clientes concorrentes alterem sem querer o contexto um do outro. O prompt pode receber um `projectId`, mas o valor precisa vir da seleção anterior do cliente.

## Verificar, monitorar e operar

```sh
curl --fail http://127.0.0.1:4319/healthz
curl --fail http://127.0.0.1:4319/readyz
node dist/src/cli.js doctor --workspace /srv/ssdd
node dist/src/cli.js backup --workspace /srv/ssdd --output /srv/backup/ssdd.sqlite
```

- `/healthz` confirma que o processo HTTP responde; `/readyz` confirma uma leitura SQL mínima. Ambos retornam apenas um estado fixo e `GET` é o único método aceito.
- Faça backup e valide restore antes de atualizar o schema. As migrations v25/v26/v27 acrescentam sessões/deployments, o mapeamento estável de IDs do roadmap e índices temporais para o retrato histórico; o arquivo SQLite continua sendo o registro operacional único.
- A migration v28 adiciona principals autenticados por authKey, auditoria administrativa global, filtro de atribuição e cache local de embeddings. O doctor deve reportar o schema aplicado; a chave em texto claro nunca deve aparecer em arquivos do workspace nem em logs persistidos.
- A migration v29 adiciona um índice composto para localizar eventos de estimativa por projeto, tipo e item; o backup/restore mantém o índice ao recriar o banco com as migrações da versão instalada.
- A migration v30 adiciona workflows versionados por tarefa, passos e eventos de progresso append-only e revisão pinada às sessões. Faça o backup normal antes do upgrade; tarefas existentes não recebem workflow automaticamente. Sem workflow publicado, a UI e a API retornam progresso desconhecido e os gates legados continuam valendo.
- Para filtrar o trabalho pessoal, `work_item_list` aceita `assignedToMe: true`; atribuição e autoria usam o principal autenticado. Busca semântica é opcional: configure `SSDD_EMBEDDING_ENDPOINT` e `SSDD_EMBEDDING_MODEL`, e opcionalmente `SSDD_EMBEDDING_API_KEY`, em um secret manager. O conteúdo dos itens e consultas é enviado ao endpoint configurado; sem as variáveis, o servidor não faz chamada de embeddings.
- Para registrar execução, consulte `task_start_check`, atribua a tarefa ao Developer e use `task_start` para mover Ready a `in_progress` e abrir a sessão atomicamente; para retomar trabalho já em andamento, use `development_session_start`. `task_workflow_get` mostra o plano publicado; `task_workflow_propose` cria Draft e só Tech Lead humano publica após fechar sessões abertas. Etapas avançam em ordem e o progresso soma apenas etapas Concluídas; isso não substitui execução/certificação QA ou gates de Done. O mesmo Developer pausa/retoma/conclui sua sessão. Horários são UTC do servidor. Sessões ativas não são fechadas automaticamente por encerramento abrupto: revise-as após recuperação e peça ao Developer que pause ou conclua a sessão.
- Homologação e produção são eventos de deployment separados de `Done`. Registre pelo MCP apenas o resultado realmente observado; produção aprovada exige build com homologação aprovada. A UI mostra as datas no detalhe da tarefa e métricas individuais agregam horas/sessões concluídas.
- Observabilidade opt-in (SSDD-915), por variáveis de ambiente do processo `serve`: `SSDD_MCP_ACCESS_LOG=1` grava em stderr uma linha JSON por requisição (`timestamp`, `level`, `correlationId`, `method`, `route`, `status`, `durationMs`, `rateLimited`), sem corpo, cabeçalhos, query string nem tokens; `route` é uma de `mcp|health|webhook|metrics|other`, então cardinalidade é limitada. `SSDD_MCP_METRICS=1` habilita `GET /metrics` (texto Prometheus, só para chamadas de loopback; use um coletor no mesmo host ou sidecar): `ssdd_http_requests_total{route,status_class}`, `ssdd_http_rate_limited_total` e o histograma `ssdd_http_request_duration_ms`. `SSDD_MCP_RATE_LIMIT_PER_MINUTE=N` limita cada endereço remoto a N requisições por janela fixa de um minuto (exceto `/healthz`, `/readyz` e `/metrics`) e responde `429` com `Retry-After: 60`; atrás de proxy o endereço é o do proxy, então aplique o limite fino também nele. Toda resposta carrega `X-Correlation-Id`.
- Retenção: o SSDD não apaga eventos de auditoria; logs de acesso são do supervisor (journald, arquivo rotacionado ou coletor) e a retenção deles é definida pela organização, sugerindo 30 dias para operação e o prazo regulatório para auditoria. Backups seguem a regra abaixo.
- Alertas sugeridos: `/readyz` falhando por mais de 1 minuto; razão `5xx/total` da rota `mcp` acima de 2% em 5 minutos; p95 do histograma acima de 500 ms em 10 minutos; qualquer crescimento sustentado de `ssdd_http_rate_limited_total` (cliente em laço ou abuso); backup mais antigo que o RPO. Em cada alerta, correlacione pelo `correlationId` do log e confira `doctor` antes de reiniciar. Não há tracing distribuído nem métricas por ferramenta ou projeto, de propósito, para não vazar conteúdo nem explodir cardinalidade.
- Faça backups regulares para destino protegido, aplique retenção e criptografia definidas pela organização e teste `restore` em workspace separado. Pare o serviço antes de restaurar ou atualizar o banco.
- Armazene variáveis de integração em um secret manager e injete-as ao processo. Não grave tokens nos arquivos do repositório nem nos argumentos de ferramentas.
- Em qualquer restart, clientes modern protocol podem reconectar por requisição. Clientes legacy precisam inicializar a sessão novamente.

## Limites de implantação

| Necessidade | Suporte atual |
|---|---|
| Vários clientes MCP simultâneos | Sim, por uma instância Streamable HTTP e um arquivo SQLite local |
| Vários projetos isolados logicamente | Sim, no mesmo workspace; descoberta via `project_list` e autorização por projeto |
| Identidade remota e papéis | Sim, OAuth/OIDC JWT provisionado como `iss+sub`, RBAC por projeto |
| Instâncias ativas em vários nós usando o mesmo banco | Não; SQLite/WAL requer processos no mesmo host e este runbook suporta uma instância ativa |
| Alta disponibilidade automática/failover sem desconexão | Não; ainda exige desenho e testes de persistência/coordenação |
| Sessões modernas persistentes | Não se aplicam ao protocolo moderno; sessão legacy é volátil e mantida em memória |
| Sessões de desenvolvimento e esforço individual | Sim; sessões explícitas, pausas, duração ativa, atribuição histórica e calibração por horas, com aviso para amostras abaixo de cinco tarefas |
| Data de homologação e produção separadas de Done | Sim; derivadas de eventos imutáveis e vinculados a build/tarefa; a UI lê o histórico e a gravação é feita pelo MCP |
| Recuperação automática de sessão ativa após queda abrupta | Não; sessão precisa de revisão e pausa/conclusão explícita quando o serviço voltar |

A decisão de topologia e seleção explícita de projeto está no [ADR 0016](adr/0016-implantacao-compartilhada-http.md). Para detalhe de protocolo e catálogo, consulte [docs/mcp.md](mcp.md); para banco e segurança, [docs/architecture.md](architecture.md).
