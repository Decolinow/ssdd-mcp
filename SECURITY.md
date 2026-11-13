# Política de segurança

## Versões suportadas

Apenas o beta mais recente recebe correções de segurança.

| Versão | Suporte |
|---|---|
| `0.3.0-beta.*` | Sim |
| anteriores | Não |

## Como reportar uma vulnerabilidade

Use o **relato privado de vulnerabilidades do GitHub** (aba *Security* → *Report a vulnerability* deste repositório). Não abra issue pública nem publique detalhes antes da correção.

Inclua versão, passos para reproduzir, impacto esperado e, se possível, uma prova de conceito mínima. Você receberá uma confirmação de recebimento e atualizações até a correção; por se tratar de um projeto beta mantido por poucas pessoas, não há SLA formal.

## Escopo e modelo de ameaça

O SSDD MCP é um **servidor local por padrão**: dashboard e MCP HTTP escutam somente em loopback; acesso compartilhado deve ficar atrás de proxy TLS com OIDC ([docs/team-server.md](docs/team-server.md)). Controles relevantes: `authKey` com hash, sessão web efêmera com verificação de origem e CSRF, RBAC por projeto, auditoria imutável, aprovações humanas de uso único para agentes, webhooks assinados com HMAC e importações somente leitura.

Dentro do escopo: bypass de autenticação/autorização, vazamento entre projetos, injeção (SQL, XML/XXE no importador JUnit, XSS no dashboard), exposição de segredos em exportações/logs e burla de gates humanos. Fora do escopo: exposição deliberada do dashboard na rede sem proxy, perda da `authKey` pelo operador e vulnerabilidades de dependências sem caminho explorável (reporte-as ao projeto de origem).

## Limites conhecidos

Este beta ainda não passou por revisão de segurança independente. Trate-o como software de avaliação em ambientes confiáveis.
