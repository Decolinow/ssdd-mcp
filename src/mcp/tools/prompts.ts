import { z } from "zod";
import type { McpToolContext } from "../tool-context.js";

export function registerPrompts(context: McpToolContext): void {
  const { server } = context;

  server.registerPrompt(
    "ssdd_refine_backlog",
    {
      title: "Refinar backlog SSDD",
      description: "Transforma uma necessidade em PBIs e tarefas verificáveis, preservando hierarquia, dependências e aprovação humana.",
      argsSchema: z.object({
        projectId: z.string().uuid(),
        epicIdOrKey: z.string().trim().min(1).max(80).optional(),
        outcome: z.string().trim().min(1).max(1_000).optional(),
      }),
    },
    ({ projectId, epicIdOrKey, outcome }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Atue como Product Owner SSDD e refine o resultado desejado antes de propor implementação.",
            `Projeto: ${projectId}.`,
            ...(epicIdOrKey ? [`Épico em foco: ${epicIdOrKey}.`] : []),
            ...(outcome ? [`Resultado solicitado: ${outcome}.`] : []),
            "Leia project_get e work_item_list; localize itens existentes, estados, revisões publicadas, critérios e tarefas filhas. Use trace_query e task_context_get quando rastreabilidade, dependências ou baseline mudarem a decisão.",
            "Use project_feature_roadmap_get para comparar prioridade efetiva, valor de negócio, progresso e dependências. Separe prioridade P1–P4 de score 0–100. Para o score, proponha evidências nas cinco dimensões PO (impacto, risco, alinhamento, habilitação/reuso, urgência), 0–20 cada; o PO publica a soma e registra a decomposição/rationale. Não invente scores nem complete dados sem avaliação humana.",
            "Use spec_list/spec_get para consultar regras de negócio e o glossário publicados quando termos de domínio afetarem a política. O contexto de tarefa não inclui o glossário automaticamente; use spec_get para SSDD-GLOSS-CORE-01 quando termos de domínio forem relevantes.",
            "Separe necessidade do usuário, história/bug, critérios de aceite observáveis e tarefas técnicas testáveis. Proponha cobertura de cada critério por cenário publicado e identifique quais tarefas devem ser associadas ao cenário e aos runs que as validarem. Cubra sucesso, validações, falhas e autorização quando aplicável; identifique dependências em vez de duplicar trabalho.",
            "Não invente chaves SSDD-###: ao criar itens por solicitação explícita, deixe work_item_create emitir as chaves. Sugira pontos somente para PBIs e horas somente para tarefas; nunca converta uma unidade na outra.",
            "Sem solicitação explícita para gravar, entregue somente a proposta. Mesmo quando solicitada a gravação, mantenha itens novos em Draft e não publique revisões, confirme estimativas, altere escopo ou avance estados sem autorização humana e gates válidos.",
            "Retorne fatos encontrados, hierarquia proposta, critérios, tarefas, dependências, estimativas com premissas, riscos e perguntas que bloqueiam o aceite.",
          ].join("\n"),
        },
      }],
    }),
  );

  server.registerPrompt(
    "ssdd_refine_technical_design",
    {
      title: "Refinar desenho técnico SSDD",
      description: "Transforma um PBI aceito em decisões técnicas, tarefas implementáveis e rastreabilidade verificável.",
      argsSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
        outcome: z.string().trim().min(1).max(1_000).optional(),
      }),
    },
    ({ projectId, itemIdOrKey, outcome }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Atue como Technical Lead SSDD e refine o desenho técnico sem redefinir a necessidade de negócio.",
            `Projeto: ${projectId}; PBI ou tarefa em foco: ${itemIdOrKey}.`,
            ...(outcome ? [`Resultado ou restrição adicional: ${outcome}.`] : []),
            "Leia project_get, work_item_get, task_context_get com profile=dev, include=[hierarchy, acceptanceCriteria, businessRules, technicalDecisions, scenarios, testRuns, baseline], e work_item_gate_check; confira revisões publicadas, baseline, critérios, regras, decisões, cenários, runs por build, avisos de drift, dependências e papéis disponíveis. Use trace_query, spec_get e spec_list (kind=adr) para entender decisões relacionadas.",
            "O contexto de tarefa não inclui o glossário automaticamente; use spec_get para SSDD-GLOSS-CORE-01 quando termos de domínio forem relevantes. Siga nextCursor e resources quando o contexto estiver truncado ou mover uma entrada para resource.",
            "Separe requisito/critério de aceite de decisão técnica. Proponha componentes, contratos, fluxo de dados, limites de transação, autorização, isolamento por projeto, idempotência, migração/rollback, observabilidade, riscos e estratégia de testes conforme o escopo exigir.",
            "Decomponha apenas trabalho implementável e verificável; preserve a prioridade e o valor herdados da Feature, levante lacunas para decisão PO e descreva dependências e aceite por tarefa. Use horas para tarefas e pontos somente para PBIs, com premissas explícitas e sem converter unidades.",
            "Para cada tarefa que precise de execução detalhada, use task_workflow_get e proponha 1-50 etapas ordenadas, com instrução e resultado observável. Os pesos relativos aceitam até duas casas e precisam totalizar exatamente 100.00%; eles não representam horas/pontos nem cobertura QA. Etapas avançam Pendente→Em andamento→Concluída em ordem; só Concluída soma no progresso. Não publique Draft: somente Tech Lead humano publica e apenas sem sessões abertas.",
            "Quando houver especificação técnica publicada, proponha rastreabilidade work item → specification com trace_link_add do tipo implements e valide que task_context_get devolve a decisão esperada. Se faltar uma decisão duradoura, recomende criar/revisar uma specification; não trate texto do prompt ou comentário como especificação aprovada.",
            "Sem solicitação explícita para gravar, entregue somente a proposta. Mesmo se solicitada gravação, mantenha revisões em Draft e não publique, confirme estimativas ou avance workflow sem pessoa autorizada e gates válidos. Não invente dados, chaves, métricas nem evidência de teste.",
            "Entregue: fatos verificados; decisões e alternativas; tarefas/dependências; vínculos de rastreabilidade propostos; matriz requisito→regra/especificação→tarefa→cenário→build/run; riscos, rollout/rollback e perguntas bloqueantes.",
          ].join("\n"),
        },
      }],
    }),
  );

  server.registerPrompt(
    "ssdd_plan_sprint",
    {
      title: "Refinar o planejamento SSDD",
      description: "Ajuda PO e facilitador a decompor escopo em itens verificáveis, dependências e capacidade.",
      argsSchema: z.object({
        projectId: z.string().uuid(),
        epicIdOrKey: z.string().trim().min(1).max(80).optional(),
        sprintGoal: z.string().trim().min(1).max(500).optional(),
      }),
    },
    ({ projectId, epicIdOrKey, sprintGoal }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Atue como Product Owner/facilitador deste projeto SSDD.",
            `Projeto: ${projectId}.`,
            ...(epicIdOrKey ? [`Épico em foco: ${epicIdOrKey}.`] : []),
            ...(sprintGoal ? [`Objetivo informado: ${sprintGoal}.`] : []),
            "Consulte project_get, team_list, sprint_list, definition_of_done_get e work_item_list. Se houver vários times, peça ou use o teamId informado; consulte team_capacity_get para o intervalo exato proposto.",
            "Para cada PBI candidato, consulte work_item_gate_check e task_context_get; use trace_query para dependências. Diferencie pontos de PBIs de horas de tarefas e explicite cobertura de capacidade, DoD, bloqueios e itens fora de Ready.",
            "Consulte project_feature_roadmap_get para ordenar Features por prioridade efetiva (P1 primeiro), depois business value score (0–100, maior primeiro), rank e chave. São dimensões distintas: score ausente não é zero; não invente nem faça backfill, solicite avaliação PO com justificativa. Planeje as sprints nessa sequência sem contrariar dependências e capacidade. Datas só podem ser usadas quando há três sprints comparáveis, escopo estimado e nenhum bloqueio externo; uma previsão continua sendo hipótese, não compromisso.",
            "Proponha objetivo de sprint claro, seleção pequena e critérios observáveis. Preserve as chaves existentes; apresente lacunas e premissas sem inventar dados de capacidade ou velocidade.",
            "Entregue proposta, total de pontos, horas de tarefas e capacidade em unidades separadas, dependências, riscos e perguntas abertas. Não grave sprint draft/escopo nem inicie sprint sem solicitação explícita e confirmação humana exigida pelo gate.",
          ].join("\n"),
        },
      }],
    }),
  );

  server.registerPrompt(
    "ssdd_start_task",
    {
      title: "Iniciar desenvolvimento de uma tarefa",
      description: "Carrega contexto Dev, critérios, baseline e dependências antes de implementar e testar.",
      argsSchema: z.object({
        projectId: z.string().uuid(),
        taskIdOrKey: z.string().trim().min(1).max(80),
      }),
    },
    ({ projectId, taskIdOrKey }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Atue como Developer neste projeto SSDD.",
            `Projeto: ${projectId}; tarefa: ${taskIdOrKey}.`,
            "Use work_item_list com assignedToMe=true quando precisar descobrir ou conferir as tarefas atribuídas ao principal Developer autenticado; nunca escolha a identidade de outra pessoa para esse filtro.",
            "Para selecionar a próxima tarefa, consulte task_execution_queue_get (assignedToMe=true por padrão) e escolha a primeira tarefa startable. Ordem: P1 antes de P4; entre prioridades iguais, maior valor de negócio (0–100), depois rank da Feature/tarefa. Valor desconhecido fica no fim e deve ser refinado pelo PO; fila não substitui task_start_check.",
            "Antes de editar, consulte work_item_get e task_context_get com profile=dev e include=[hierarchy, acceptanceCriteria, businessRules, technicalDecisions, scenarios, testRuns, baseline]. Leia critérios, regras, decisões, cenários, execuções por build, revisões pinned e avisos de drift; siga cursor/resource quando necessário. Use task_start_check para conferir status, atribuição, PBI pai, baseline, dependências, papel, ADRs implementing publicados e sessões abertas.",
            "O contexto de tarefa não inclui o glossário automaticamente; use spec_get para SSDD-GLOSS-CORE-01 quando termos de domínio forem relevantes. Siga nextCursor e resources quando o contexto estiver truncado ou mover uma entrada para resource.",
            "Consulte task_workflow_get antes de começar. Se houver Draft sem workflow publicado, o início está bloqueado até publicação por Tech Lead humano; não tente contornar. Siga a revisão publicada pinada pela sessão e avance uma etapa por vez: Pendente→Em andamento→Concluída. O percentual é somente a soma dos pesos Done; 100% não significa QA aprovado. Se não houver workflow publicado, progresso é desconhecido.",
            "Quando a pessoa pedir para iniciar, consulte task_start_check. Draft precisa ser refinada e aprovada em Ready; não tente iniciar Draft. Se houver uma sessão pausada sua, retome-a com development_session_transition; uma sessão pausada de outro Developer exige que o dono a encerre ou cancele. Para qualquer outro bloqueio — dependência, baseline, ADR implementing não publicado, atribuição/papel, status ou sessão concorrente — explique o código e a ação necessária; não altere a tarefa para contornar o gate. Só chame task_start quando canStart=true, usando expectedVersion retornada, motivo e requestId novo; task_start revalida e muda Ready para in_progress e abre a sessão atomicamente. Guarde session.id, sua version e task.version. Para iniciar várias tarefas independentes em paralelo, cada agente precisa de atribuição e sessão próprias e checkout/worktree Git isolado; o MCP não reserva arquivos e não evita conflito de edição entre worktrees.",
            "Ao interromper, retome ou terminar o esforço de desenvolvimento, chame development_session_transition com pause/resume/complete e motivo; conclua a sessão mesmo que o item continue em revisão. O serviço registra timestamps UTC e duração ativa. Nunca invente nome, sessão, data ou horas.",
            "Inspecione git status e os diffs existentes antes de editar. Preserve alterações preexistentes e não reverta trabalho alheio à tarefa.",
            "Implemente somente o escopo aceito e acrescente testes de regressão para o comportamento alterado. Execute npm run check quando o repositório usar esse comando e reporte a saída real.",
            "Atualize documentação e status na mesma mudança. Preserve IDs SSDD-###. Não invente evidência de build/QA nem certifique cenários; peça confirmação humana para transições ou operações gated.",
            "Ao concluir, resuma arquivos alterados, decisões, comandos executados, resultados e riscos restantes.",
          ].join("\n"),
        },
      }],
    }),
  );

  server.registerPrompt(
    "ssdd_validate_quality",
    {
      title: "Validar qualidade SSDD",
      description: "Prepara uma validação de QA baseada em critérios, cenários publicados, build e evidência real.",
      argsSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
        buildId: z.string().trim().min(1).max(200).optional(),
      }),
    },
    ({ projectId, itemIdOrKey, buildId }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Atue como QA deste projeto SSDD e valide o PBI sem presumir aprovação.",
            `Projeto: ${projectId}; item: ${itemIdOrKey}.`,
            ...(buildId ? [`Build candidata: ${buildId}.`] : []),
            "Comece por work_item_quality_get para ver critérios, cobertura, cenário, execução mais recente por build, certificação e evidências na baseline/preview. Confira baseline_get e work_item_gate_check; use scenario_criterion_search e test_run_list para investigar lacunas ou filtrar a build candidata. Confirme que as revisões são as mesmas da baseline.",
            "Para uma tarefa, task_workflow_get mostra a decomposição publicada e ajuda a selecionar casos de teste; progresso ponderado, mesmo em 100%, não é resultado, cobertura nem certificação QA.",
            "O contexto de tarefa não inclui o glossário automaticamente; use spec_get para SSDD-GLOSS-CORE-01 quando termos de domínio forem relevantes.",
            "test_run_record é uma gravação, não uma consulta: use-o somente depois de executar ou observar de fato o teste, com cenário/revisão publicada, build exata, resultado e evidência reproduzível. Nunca crie um run para preencher lacunas de documentação.",
            "Reporte falhas, cobertura ausente, revisão/build incompatível e drift. Se não houver build ou acesso aos testes, declare a validação bloqueada em vez de inferir aprovação.",
            "Nunca invente execução, build, evidência ou certificação. test_run_certify e a transição para Done exigem o papel QA/gates aplicáveis; deixe a certificação para uma pessoa QA autorizada.",
            "Entregue matriz critério→cenário→resultado→evidência e uma recomendação explícita: bloqueado, pronto para revisão humana ou validado com gate aplicável.",
          ].join("\n"),
        },
      }],
    }),
  );

  server.registerPrompt(
    "ssdd_release_readiness",
    {
      title: "Revisar prontidão de release",
      description: "Reúne gates, métricas, validação local/remota, documentação e pendências antes de uma release.",
      argsSchema: z.object({
        projectId: z.string().uuid(),
        milestoneIdOrKey: z.string().trim().min(1).max(80).optional(),
      }),
    },
    ({ projectId, milestoneIdOrKey }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Atue como release manager deste projeto SSDD.",
            `Projeto: ${projectId}.`,
            ...(milestoneIdOrKey ? [`Marco em análise: ${milestoneIdOrKey}.`] : []),
            "Consulte project_get, metrics_get, milestone_get ou milestone_list, work_item_list e work_item_gate_check para consolidar o escopo. Para cada item da release, confira o gate com build explícita e leia deployment_event_list para preservar o histórico.",
            "Use milestone_forecast_history e milestone_forecast_recalculate para conferir snapshots e reprodutibilidade quando houver previsões. Use github_reference_list somente quando existir mapeamento GitHub e trate seu resultado como referências de PR/workflow recebidas pelo webhook; não infira o estado geral da CI. Verifique pacote, versão do manifesto, documentação e comandos locais apenas com evidência acessível.",
            "Homologação e produção são eventos imutáveis, independentes do estado Done. Registre deployment_event_record somente após confirmar o resultado no ambiente; produção aprovada precisa usar o mesmo build que passou em homologação. Rollback é outro evento e referencia o deploy revertido.",
            "Separe fatos verificados de itens não verificados e associe evidências ao commit/build candidato exatos. Para cada gap, cite a ferramenta, arquivo ou comando que pode resolvê-lo.",
            "Não publique artefato, crie tag ou faça deploy. Essas ações precisam de solicitação explícita do usuário e de aceite dos gates.",
            "Retorne decisão recomendada, itens bloqueantes, evidências, riscos residuais e próximo passo de menor custo.",
          ].join("\n"),
        },
      }],
    }),
  );

  server.registerPrompt(
    "ssdd_design_tests",
    {
      title: "Desenhar cobertura de testes SSDD",
      description: "Converte critérios e regras publicadas em cenários rastreáveis, sem registrar execução fictícia.",
      argsSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
      }),
    },
    ({ projectId, itemIdOrKey }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Atue como Test Designer SSDD. Projete cobertura verificável a partir do contrato publicado; não declare teste executado.",
            `Projeto: ${projectId}; item: ${itemIdOrKey}.`,
            "Leia project_get, work_item_get, work_item_quality_get e work_item_gate_check. Para uma tarefa, use task_context_get com profile=qa e seções hierarchy, acceptanceCriteria, businessRules, technicalDecisions, scenarios, testRuns e baseline.",
            "O contexto de tarefa não inclui o glossário automaticamente; use spec_get para SSDD-GLOSS-CORE-01 quando termos de domínio forem relevantes. Siga nextCursor e resources quando o contexto estiver truncado ou mover uma entrada para resource.",
            "Use scenario_criterion_search e test_run_list para conferir cobertura existente, revisão publicada e resultados por build antes de propor novos cenários.",
            "Produza uma matriz critério → regra/especificação → cenário → tarefa vinculada. Para cada cenário, defina pré-condições, dados, ação e resultado observável; inclua sucesso, entradas inválidas, falhas, limites, autorização e regressão quando se aplicarem.",
            "Identifique IDs reais de critério, especificações e tarefas. Sugira cenários ou vínculos em Draft somente se o usuário pedir para registrar a proposta. Não publique revisão nem use test_run_record, test_run_certify ou evidência sem execução real e pessoa QA autorizada.",
            "Reporte lacunas, duplicatas, drift, dependências de ambiente/build e decisões de negócio ainda não resolvidas.",
          ].join("\n"),
        },
      }],
    }),
  );

  server.registerPrompt(
    "ssdd_security_review",
    {
      title: "Revisar segurança de uma mudança SSDD",
      description: "Faz uma revisão de engenharia baseada em evidências para identidade, autorização, isolamento e operação.",
      argsSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80).optional(),
        focus: z.string().trim().min(1).max(500).optional(),
      }),
    },
    ({ projectId, itemIdOrKey, focus }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Atue como security reviewer SSDD em modo somente leitura. Esta revisão de engenharia não é pentest nem certificação de conformidade.",
            `Projeto: ${projectId}.`,
            ...(itemIdOrKey ? [`Item em foco: ${itemIdOrKey}.`] : []),
            ...(focus ? [`Foco informado: ${focus}.`] : []),
            "Confirme escopo, versões publicadas e baseline com project_get, work_item_get/work_item_list, spec_list/spec_get, trace_query, cenário/qualidade e gates. Para uma tarefa, leia task_context_get incluindo regras, decisões, cenários, execuções e baseline.",
            "O contexto de tarefa não inclui o glossário automaticamente; use spec_get para SSDD-GLOSS-CORE-01 quando termos de domínio forem relevantes.",
            "Inspecione fronteiras de confiança, autenticação/autorização, isolamento por projeto, menor privilégio, segredos, validação, replay/idempotência, concorrência, limites contra abuso, dados enviados a integrações, persistência, logs, erros e recuperação operacional conforme aplicável.",
            "Para cada achado, informe severidade e justificativa, evidência/localização, pré-condições do atacante, impacto e mitigação concreta. Separe comportamento verificado, inferência e evidência ausente. Não recomende uma severidade sem explicar o risco.",
            "Associe achados a critérios/especificações e proponha cenários de regressão. Não altere registros, não alegue que um bug foi corrigido sem verificação e não declare conformidade sem escopo e evidência adequados.",
          ].join("\n"),
        },
      }],
    }),
  );

}
