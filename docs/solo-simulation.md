# Simulação de projeto solo no MCP

**Data do ciclo:** 2026-11-10
**Projeto:** `SSDD` · SSDD MCP (`3aac48de-8447-4294-abff-f1a57ecd960e`)
**Workspace:** local, em `.ssdd/ssdd.sqlite` (ignorado pelo Git)
**Objetivo:** exercitar um projeto inteiro no MCP e verificar que os fluxos de planejamento, execução, QA e agentes funcionam para uma única pessoa.

## Perfil e capacidade

O time `SSDD Solo` tem uma pessoa humana, dedicação de 100%, calendário de segunda a sexta, fuso `America/Sao_Paulo` e seis horas por dia. Para 2026-11-09 a 2026-11-20, a capacidade calculada é de dez dias úteis e 60 horas. O cadastro é um cenário de trabalho, não uma previsão de produção.

A mesma identidade humana tem os papéis de PO, Developer, QA e facilitador no projeto. Isso permite simular todos os gates sem inventar participantes. Autoria por papel fica no histórico, mas esta execução não oferece revisão independente nem segregação entre quem implementa e quem certifica.

## Definition of Done v1

1. O PBI descreve benefício e tem critérios de aceite publicados e verificáveis.
2. Cada critério obrigatório é coberto por cenário QA publicado e fixado na baseline.
3. A história tem estimativa de pontos confirmada e baseline criada ao entrar em Ready.
4. Cada tarefa filha tem responsável, saída descrita, horas confirmadas e evidência vinculada ao build candidato.
5. Lint, typecheck, build e testes automatizados relevantes passam; os resultados citam comando, revisão e saída real.
6. QA registra execução aprovada para a revisão e o build exatos, e uma pessoa QA autorizada a certifica.
7. Documentação e roadmap refletem o comportamento entregue, e todos os gates de Done passam.

## Ciclo executado

| Elemento | Registro no MCP | Resultado |
|---|---|---|
| Feature pai | Habilitação de agentes (`SSDD-61`) | Já existente no roadmap importado |
| História | Validar fluxos de agentes no MCP (`SSDD-64`) | Done; 5 story points confirmados; baseline fixada |
| Tarefa 1 | Validar prompts e skills via MCP stdio e HTTP (`SSDD-65`) | Done; responsável humano; 4 h estimadas |
| Tarefa 2 | Validar pacote e documentação de agente (`SSDD-66`) | Done; mesmo responsável; 2 h estimadas |
| Cenário QA | `SSDD-SOLO-QA-20261109` | Publicado; cobre os três critérios da história |
| Execução QA | Build `local-d89b251` | Passed e certificada por QA humano na mesma identidade |
| Marco | `SSDD-SIM-20261109` | Escopo de 1 PBI; métricas registram 5 pontos concluídos em 2026-11-10 |
| Sprint | `SSDD-SOLO-20261109` | Fechada antecipadamente em 2026-11-10; 1 item aceito |
| Retrospectiva | Revisão 1 da sprint | Registrada com 1 ação: medir velocidade após uma sprint de produção |

Story points e horas permanecem unidades separadas: a história tem 5 pontos e as tarefas somam 6 horas. A sprint piloto usou uma janela de dez dias com 60 horas configuradas, mas foi encerrada no primeiro dia de execução; esses valores não são uma observação de throughput real.

## Evidências e validação

- `npm run check` passou lint, typecheck, build e **137 testes em 25 suítes** no candidato local baseado em `d89b251`.
- `npm pack --dry-run --json` listou 89 arquivos e incluiu as quatro skills `skills/{ssdd-product-owner,ssdd-developer,ssdd-quality-assurance,ssdd-release-manager}/SKILL.md`.
- A verificação via cliente MCP stdio leu a história, as tarefas, a capacidade, o DoD, o marco, a sprint, a retrospectiva, as evidências e os gates. Os gates de Done da história e das duas tarefas passaram.
- `test_run_certify` ficou associado ao cenário publicado, à baseline da história e ao build `local-d89b251`; o gate retornou a certificação correspondente.
- No piloto de 10/11, o catálogo MCP apresentou quatro prompts e `SkillsClient` validou o digest das quatro skills então empacotadas. Esses números são evidência histórica daquela revisão; na revisão atual o MCP publica seis prompts e cinco skills, conforme o [contrato MCP](mcp.md#prompts-e-skills-para-agentes) e o [guia do instalador](agent-installer.md).
- `doctor --workspace .` retornou `ok`, schema 23 atual, integridade SQLite válida e zero violações de chave estrangeira.

Os logs locais usados como evidência estão sob `.ssdd/evidence/d89b251/`; esse diretório privado não é versionado. A execução não afirma que a CI remota passou. GitHub Actions segue bloqueado antes da inicialização dos jobs por cobrança da conta.

## Próximos passos

1. Criar/refinar um PBI de demanda real e validar critérios, dependências e escopo com PO.
2. Reconfirmar o calendário e a capacidade antes de planejar uma sprint de produção.
3. Não usar a sprint piloto no forecast ou como velocidade observada; coletar sprints de produção encerradas primeiro.
4. Após desbloquear a cobrança, executar a matriz remota Linux/macOS/Windows × Node 24/26 e os gates de pacote/container da release v0.2.0.

O roteiro técnico original permanece em [ROADMAP.md](../ROADMAP.md); o estado consolidado está em [docs/status.md](status.md).
