# Correções da página de Perímetro — 26/09/2026

Referência: [auditoria exclusiva da página](auditoria-perimetro-2026-09-26.md). Estado do workspace após implementação e testes; sem implantação remota nesta etapa.

## Resultado

| Achado | Estado | Mudança aplicada |
|---|---|---|
| PER-01 | Corrigido | `include`/`exclude` passam a limitar também o tripwire; simulador e detector usam a mesma precedência e exigem origem/destino em área válida |
| PER-02 | Corrigido | `LINE_CROSSED` não passa pelo agrupamento genérico por tipo; cada travessia confirmada é preservada |
| PER-03 | Corrigido | revisão salva viaja até o processador; UI mostra aplicando/aplicado/não confirmado; PATCH recusa revisão concorrente |
| PER-04 | Corrigido na UI | estado separa regra ausente, análise, aplicação e habilitação de alarmes; tela não chama análise ativa de proteção completa |
| PER-05 | Corrigido | API rejeita pontos repetidos, área desprezível/colinear e auto-interseção |
| PER-06 | Corrigido | tripwire guarda o último lado estável e usa faixa neutra; tocar/recuar não cruza |
| PER-07 | Corrigido na experiência | modo virou “Simular regras”, deixou de tratar entrada em `include` como intrusão e explica a diferença entre gesto simulado e atividade real |
| PER-08 | Corrigido | edição apenas para admin, coerente com a API; health filtrado passou a ser consultável pelo viewer |
| PER-09 | Corrigido | sensibilidade removida de área `exclude`, onde a máscara já elimina os pixels |
| PER-10 | Corrigido parcialmente | salvar e continuar fica bloqueado durante desenho; rascunho, aviso de saída e guards existentes permanecem. Histórico interno continua protegido principalmente pelo rascunho recuperável |
| PER-11 | Corrigido | todas as câmeras ativas acessíveis aparecem; as sem análise recebem estado/ação explicativos; busca inclui nome, código e grupo |
| PER-12 | Corrigido | alvos dos vértices ampliados, foco/ESC no modo ampliado, estados semânticos e labels acessíveis adicionados |
| PER-13 | Corrigido no escopo existente | resumo explica travessia, áreas, classes e resposta efetiva da câmera; ações por regra continuam sendo evolução de produto |
| PER-14 | Corrigido | desenhos recebem nome sobre a imagem e a tela explica precedência de exclusões sobre inclusões |
| PER-15 | Corrigido | regressões de máscara, toque/recuo, geometria inválida e preservação de travessias foram adicionadas às suítes |

## Comportamento percebido

- O operador vê se a configuração está sendo aplicada e se o detector confirmou a mesma revisão.
- “Análise ativa” e “alertas ligados” aparecem como condições distintas.
- Áreas verdes e vermelhas têm efeito coerente tanto na simulação quanto nas linhas reais.
- Passar por uma linha registra a ocorrência sem apagar outra pessoa/linha do mesmo instante.
- Encostar na linha e voltar deixa de produzir uma falsa passagem.
- Um desenho inválido é recusado antes de criar um perímetro silenciosamente inoperante.
- Operadores sem autorização entram em consulta; o botão de salvar não promete uma permissão que a API recusará.
- A lista inclui câmeras que ainda precisam ter a análise ativada, facilitando a configuração inicial.

## Validação

- Build TypeScript da API aprovado.
- Build de produção Web aprovado.
- API: 19 testes direcionados de geometria, linha e alarmes aprovados.
- IA: suíte completa com 326/326 testes aprovados.
- Web: typecheck, build de produção e suíte completa com 529/529 testes aprovados.
- `git diff --check` e compilação Python aprovados.

## Limites preservados com transparência

O produto ainda não possui agenda e ações independentes por regra de perímetro. A tela agora descreve apenas o comportamento existente. O modo de simulação valida geometria e mostra detecções ao vivo; ele não substitui um ensaio operacional com confirmação de evento, alarme e entrega de push. Esses dois itens exigem evolução de produto e contrato de dados, não apenas ajuste visual.
