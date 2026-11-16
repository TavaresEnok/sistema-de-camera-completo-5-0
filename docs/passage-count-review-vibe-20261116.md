# Revisão da contagem de passagem — Vibe, 16/11/2026

Escopo de publicação: somente Vibe. Management compila e assina os artefatos.

## Plano conferido

O plano da implementação `2c9364e` previa linhas Alerta/Contagem, sentidos de
entrada e saída, filtro de classes, proteção contra tremor, envio idempotente
por sessão/minuto, retenção de 400 dias, permissões do histórico, metas de
5/8/12 quadros por câmera, relatório por hora/dia e CSV. Esses componentes
existiam, mas a revisão encontrou falhas de integração e recuperação.

## Correções

- Taxa: PATCH de countingFps passa a reaplicar a IA; o store preserva o valor
  e a interface distingue meta configurada de taxa realmente processada.
- Dados: reenvios atrasados não reduzem totais já gravados. Chaves repetidas
  em um lote são consolidadas antes do INSERT.
- Recuperação: lotes de até 500 itens, confirmação por lote e checkpoint
  atômico dos totais confirmados em `/storage/.passage-counts/<camera>.json`.
  O estado reutiliza a sessão para reenviar totais sem duplicar. Não persiste
  vídeo nem identidade de pessoas. Travessias ainda pendentes de confirmação
  podem se perder em uma queda abrupta antes do checkpoint.
- Relatório: pessoas/veículos separados, consultas canceladas ao mudar filtro,
  tratamento de falha e nova tentativa, atualização manual e horário explícito.
- Histórico: remover uma linha não esconde seus dados já armazenados.
- Exportação: nomes são tratados como texto no Excel, inclusive fórmulas.
- Simulação: áreas são avaliadas no ponto de cruzamento, como na IA, permitindo
  conferir entrada e saída quando a linha está no limite de uma área.
- Editor: Carros/Motos/Bicicletas identificados corretamente. Uma linha apenas
  de contagem pede ao detector as classes necessárias à contagem e aos demais
  recursos habilitados, sem ampliar a política da instalação.

## Evidências e limites

Dois pilotos estavam ativos. O CORREDOR VIBE tinha 245 entradas e 224 saídas
acumuladas na amostra; VIBE NOBRE FRENTE tinha duas entradas e uma saída.
São passagens, não visitantes únicos nem ocupação da loja.

A imagem da VIBE NOBRE FRENTE mostrou a linha alta na fachada à esquerda,
sem coincidir com o piso por onde os pés atravessam. Foi solicitada a definição
da entrada de referência antes de alterar esse desenho.

Com meta 8, a amostra real era aproximadamente 2–3 análises de objeto por
segundo em cada câmera, com duas requisições globais e oito threads de
inferência para dez CPUs disponíveis. A meta não é garantia de capacidade;
o novo indicador mostra a diferença. Não foi ampliado o paralelismo global.

Testes cobrem: cruzamentos nos dois sentidos e no limite de áreas; tremor,
repetição e classes; mais de 500 pendências e falha parcial; recuperação do
checkpoint e falha de disco; PostgreSQL real com reenvios fora de ordem,
sessões distintas, permissões, fuso e linhas removidas; aplicação de FPS;
navegador desktop/celular com erro/repetição, troca rápida de filtros e CSV.

Não há amostra de referência com contagem humana rotulada para declarar uma
porcentagem de acerto. Posicionamento da câmera/linha, oclusões e capacidade
real de análise continuam determinando as passagens detectadas.
