# ADR 0013: previsão de entrega por Monte Carlo

- **Status:** Aceita
- **Data:** 2026-11-10
- **Contexto:** A previsão v1 aplicava percentis lineares de pontos por hora e retornava datas por cenário, sem estimar a probabilidade de cumprir a data alvo. A Sprint 8 exige representar a variação observada entre sprints, respeitar a capacidade pós-corte e manter resultados repetíveis.

## Decisão

- Usar até seis sprints fechadas, no mesmo time e geração do corte, com mínimo de três observações. Sprints sem itens aceitos permanecem na distribuição como entrega zero.
- Executar 10.000 tentativas. Para cada período futuro com capacidade, sortear com reposição uma sprint observada e acumular seu resultado em pontos até completar o restante do marco.
- Ajustar os pontos sorteados pela razão entre as horas disponíveis no período futuro e as horas registradas na sprint histórica sorteada. Isso mantém a unidade entregue em pontos e evita estimar horas necessárias; assume relação proporcional entre disponibilidade e entrega dentro do período.
- Usar a janela real e o snapshot de capacidade de sprint ativa ou planejada. Em períodos sem sprint planejada, criar janelas com a duração mediana das amostras e calcular capacidade pela configuração vigente, marcada como hipótese.
- Mapear P25/P50/P75 do tempo de conclusão para Favorável/Base/Cauteloso. A probabilidade até a meta é a fração das tentativas concluídas até essa data. Uma tentativa que não conclui no horizonte é censurada; se a meta exceder 365 dias e o escopo não estiver concluído, a probabilidade fica nula. Percentis que não são alcançados no horizonte não recebem data.
- Derivar uma seed uint32 estável do algoritmo, data de corte, escopo restante, time/geração e amostra. A data alvo e a capacidade futura não entram na seed, para manter os mesmos sorteios ao comparar metas ou mudanças de capacidade. Persistir seed, contagem, todas as entradas, resultado, versão e watermark em snapshot imutável.
- Manter o algoritmo v1 disponível para recalcular snapshots existentes. O algoritmo v2 usa a tabela da migration v17 e a chave de algoritmo existente; não requer alteração de schema.

## Consequências

- Chamadas repetidas com as mesmas fontes reutilizam o snapshot e `recalculate` reproduz percentis e probabilidade exatamente.
- Comparações entre metas e mudanças de capacidade usam a mesma sequência de sorteios; a redução de capacidade não melhora a previsão por ruído de uma nova seed.
- O modelo deixa explícita a hipótese de proporcionalidade da entrega à capacidade. Mais dados de times com capacidade variável podem justificar um modelo não linear em uma versão futura.
- Estados distintos informam escopo incompleto, amostra insuficiente, capacidade indisponível, velocidade zero, bloqueios e escopo concluído.

## Validação

Testes verificam amostras da mesma geração, seed estável, recálculo v2, recálculo legado v1, efeito monotônico de redução de capacidade, sprints sem entrega, zero velocidade, bloqueios, conclusão, datas antes/depois do horizonte e seleção do time no dashboard.
