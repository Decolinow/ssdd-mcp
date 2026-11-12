# ADR 0025: Início do dashboard por papel de trabalho

- **Status:** Aceita
- **Data:** 2026-11-12
- **Contexto:** O dashboard autenticava a pessoa e abria direto em Métricas. Isso ajudava a acompanhar o projeto, mas não respondia primeiro quais ações cabiam ao principal conectado nem oferecia um caminho controlado para assumir trabalho elegível.

## Decisão

1. A aba **Início** será a entrada do dashboard autenticado e usará os papéis funcionais concedidos ao principal no projeto.
2. Quando há mais de um papel, o usuário pode selecionar uma perspectiva de trabalho entre esses papéis. O seletor altera somente a apresentação; rotas e serviços continuam autorizando cada operação pelo principal e pelo RBAC do projeto.
3. Uma projeção de aplicação entrega filas curtas para Developer, QA, PO e Tech Lead. Os demais papéis recebem atalhos para as áreas de acompanhamento. A UI declara os limites das listas e mostra estados vazios explícitos.
4. Developer pode assumir uma tarefa apenas quando ela está Ready, não tem responsável e todos os gates de início exceto a atribuição passam. O servidor revalida versão e gates, grava atribuição e auditoria idempotentemente e não inicia sessão. O fluxo existente `task_start` abre a sessão após o claim.
5. A escolha da perspectiva do dashboard é distinta de `SSDD_PROFILE`, que limita o catálogo de ferramentas disponível numa conexão MCP.

## Consequências

- A home conecta a identidade autenticada à fila concreta e aos próximos passos do papel selecionado.
- O usuário não recebe permissões novas por trocar a perspectiva, e um claim concorrente ou bloqueado falha sem atribuição parcial.
- A home não tenta iniciar uma tarefa durante o claim, preservando a confirmação de gates e a sessão rastreável do fluxo existente.
- As listas são um resumo de acesso rápido; backlog, board, qualidade, métricas, roadmap e histórico continuam acessíveis nas próprias abas.
- A projeção usa os dados atuais e o estado de autorização do servidor; ela não reconstrói uma fila histórica.
