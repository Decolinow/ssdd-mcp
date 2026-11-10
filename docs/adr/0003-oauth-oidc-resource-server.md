# ADR 0003: OAuth/OIDC para o resource server MCP

**Status:** aceito para a primeira entrega de SSDD-602  
**Data:** 2026-11-09

## Contexto

O modo HTTP precisa identificar cada cliente remoto e aplicar os mesmos papéis por projeto já usados pelos serviços de aplicação. O MCP é um resource server: tokens são emitidos por um provedor externo e não são criados nem armazenados pelo SSDD MCP.

## Decisão

- Configurar o issuer OIDC e a URL canônica do resource MCP (`/mcp`) explicitamente na inicialização. Descobrir `jwks_uri` no documento OpenID Connect do issuer e falhar na inicialização se o documento estiver indisponível, incompleto ou anunciar outro issuer.
- Aceitar somente access tokens JWT com assinatura assimétrica permitida, `iss` correspondente, `aud` contendo a URL do resource, `exp` e `sub`; validar `nbf` quando presente. Exigir o scope `ssdd:mcp`. Tokens opacos/introspection não fazem parte desta entrega.
- Publicar Protected Resource Metadata e os desafios Bearer do SDK MCP. O servidor não implementa o authorization server nem o fluxo de login do cliente.
- Mapear o par exato `iss+sub` para um principal previamente cadastrado. Conceder/revogar os papéis com `ssdd-mcp access grant|revoke`, executado por um principal local que já seja `admin` do projeto. O tipo `human|agent|service` e as associações de papéis são escolhidos explicitamente por esse comando; claims de papel no token são ignoradas.
- Manter o bind do processo em `127.0.0.1`. A publicação externa usa um proxy reverso com TLS e encaminha o Host público configurado em `--resource-url`. Não habilitar CORS no MCP nesta entrega; `--allowed-origin` amplia somente a allowlist de verificação de origem por hostname.
- Fixar o principal na sessão legacy. Uma sessão iniciada por uma identidade não pode ser reutilizada com o token de outro principal. O handler moderno recebe a identidade resolvida por requisição.

## Consequências

Clientes MCP remotos podem autenticar-se com um provedor OIDC compatível cujo access token seja JWT. Acesso ao servidor e RBAC ficam separados: o scope permite entrar no MCP; `project_memberships` define quais projetos e operações são autorizados. Identidade sem provisionamento recebe `403`; operações que já exigem uma pessoa continuam negando principais `agent`/`service`.

A autorização de uma chamada por agente é persistida separadamente do token OIDC e segue a política de vínculo e consumo atômico definida em [ADR 0004](0004-single-use-tool-approvals.md). O dashboard permanece local e não usa essa autenticação.

## Referências

- [Autorização da especificação MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Guia do SDK TypeScript para exigir autorização](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization)
- [Descoberta OpenID Connect](https://openid.net/specs/openid-connect-discovery-1_0.html)
