# Movimento pequeno na VIBE NOBRE FRENTE

## Escopo

Correção do piso inicial de sensibilidade e limpeza menos agressiva nas zonas
em alta. Mantidos 7 FPS, análise 320×180, captura/decoder, modelos e política
de objetos. Não implementado recorte de maior detalhe: era a alternativa
condicional caso os primeiros ajustes não fossem suficientes.

## Evidência e implementação

O detector exigia ao menos 69 pixels no primeiro filtro, antes de aceitar
componentes de 34 pixels na área em alta. O primeiro filtro agora respeita
o menor limiar das áreas efetivamente monitoradas. Áreas excluídas não reduzem
esse piso. O piso adaptativo de ruído continua aplicado.

A limpeza 5×5 pode apagar componentes finos antes da checagem de tamanho.
Zonas em alta usam 3×3; média/baixa mantêm 5×5. Configurações e máscaras são
calculadas uma vez por alteração de zona. Quando toda a área monitorada está
em alta, não se executam duas limpezas; zonas mistas combinam os resultados
apenas onde alta foi escolhida. A máscara de exclusão é reaplicada após a
limpeza para impedir expansão nas bordas. Blur, sombra, compensação de luz,
atividade crônica, periodicidade e confirmação temporal permanecem ativos.
O endpoint de saúde informa resolução, piso efetivo e tipo de limpeza.

## Alteração de câmera e reversão

Somente `VIBE NOBRE FRENTE`, id `dd846c2a-7900-4e02-917d-89bda5e80a63`,
teve sua área existente colocada em alta pela API autenticada, com controle de
concorrência `expectedDetectionZones` e auditoria. HTTP 200,
`aiApplyStatus=started`, pontos inalterados, gravação permanece `motion`.
Credencial temporária de 60 segundos criada exclusivamente em memória, sem
impressão ou persistência. Nenhuma credencial de câmera foi consultada.

Estado anterior para restauração via a mesma API (comparando antes com a
configuração atual, sem sobrescrever alterações posteriores do operador):

```json
[{"id":"zone-1790969532329-8btey","kind":"include","name":"Monitorar 1","points":[[0.0596,0.2552],[0.0486,0.8781],[0.9279,0.8614],[0.8605,0.1966],[0.4718,0.1072],[0.1019,0.1407],[0.0564,0.2524]]}]
```

Deploy Vibe: `drac-pipeline-ai:20261002-small-motion` sobre a imagem anterior
`drac-pipeline-ai:20261002-motion-fixes`, preservada para reversão. Alterado
somente o serviço `ai-service` no override persistente. API, frontend,
MediaMTX, ingestão e banco não precisam ser reiniciados. Após iniciar,
os três processadores reapareceram; câmera alvo confirmou piso 34/alta e
demais câmeras piso 69/limpeza original. Nenhuma implantação nas outras
instalações ou demo nesta alteração.

## Testes e custo isolado

96 testes/cenários aprovados (67 unittest de movimento/perímetro, incluindo
13 novos; 22 de iluminação, atividade crônica e periodicidade; 7 cenários
adicionais de ruído/contraste). Regressões cobrem
movimento fino, filtro inicial, zonas mistas/excluídas, atualização em execução,
compatibilidade sem zonas, ruído, luz e movimento com MOG2 real.

Benchmark offline na imagem anterior, carregando detector corrigido do volume
somente leitura; OpenCV com uma thread, sem rede/câmeras. Cinco repetições,
120 quadros por repetição, ordem antiga/nova alternada, mediana de tempo de CPU
do detector por quadro. Não inclui decode nem mede o servidor inteiro.

| Áreas | Antes ms | Depois ms | Variação |
|---|---:|---:|---:|
| Sem alta | 6,4808 | 6,5281 | +0,73% |
| Toda área em alta | 8,0905 | 7,6881 | −4,97% |
| Alta/média mistas | 7,8702 | 8,1474 | +3,52% |

Execução: imagem anterior com `PYTHONPATH=/app`, fonte montada em `/workspace`
e `tools/bench-small-motion.py` montado somente leitura como `/bench.py`.
Estes números têm variação de execução; não representam ganho garantido de CPU.
Contagem de quadros emitidos não equivale à quantidade de pessoas detectadas:
o benchmark mede custo, enquanto os testes de regressão comprovam cenários.

Limitação observada no teste adversarial: cena totalmente lisa com ruído forte
pode produzir disparos durante aprendizado inicial em ambas as versões.
Teste A/B de 300 quadros: antiga 49, corrigida 56; após os primeiros 100,
zero em ambas. Cena texturizada com o mesmo ruído: zero em ambas.
Não afirmar eliminação de todo falso positivo ou alcance em metros.

## Medições de produção

`tools/measure-motion-pipeline.py` agora mede também CPU acumulada do cgroup
da IA (100% equivale a um núcleo) e quantas inferências avançadas ocorreram
durante a amostra, para não confundir movimento com simulação de objetos.
As primeiras amostras foram descartadas da comparação porque o operador
estava alternando a simulação de objetos durante a medição.

Amostra anterior final, 30,89 s, três câmeras, sem inferência avançada:
IA 114,98% de um núcleo, servidor 38,40%; FPS 6,960 / 6,960 / 7,025
(última: NOBRE FRENTE). Arquivo de métricas sem imagens/credenciais:
`/tmp/drac-small-motion-before-final.jsonl`.

Depois, 45,94 s: IA 207,95%, servidor 50,48%; NOBRE FRENTE 4,244 FPS.
Houve 107 inferências avançadas nessa câmera durante a amostra. Nova amostra
de 30,86 s: IA 153,96%, servidor 44,47%; NOBRE FRENTE 5,996 FPS, com 26
inferências avançadas. Outras câmeras ficaram em aproximadamente 6,8–6,9 FPS.
Arquivos `/tmp/drac-small-motion-after.jsonl` e
`/tmp/drac-small-motion-after-final.jsonl`.

Essas amostras posteriores **não são comparação limpa de CPU para movimento**:
a simulação de objetos estava sendo alternada pelo operador. Não foi desligada
por nossa conta para forçar um benchmark. Na arquitetura atual, a inferência
avançada acontece no mesmo consumidor da análise de movimento; ela pode reduzir
o FPS efetivo mesmo com 7 configurado. Isso é uma limitação distinta do ajuste
de sensibilidade/limpeza. O tempo médio da etapa `motion` na câmera alvo foi
24,506 ms antes e 22,137 ms na última amostra, mas as cenas e cargas não foram
controladas. Para o custo causal da alteração, usar o benchmark offline acima;
não atribuir a variação da CPU geral à correção nem prometer 7 efetivos durante
a simulação de objetos.

Validação final: HTTPS da Vibe HTTP 200; IA pronta, três processadores ativos;
SHA256 do detector em produção igual ao arquivo testado
`2c65d0adde5506ad60104a576ca10f0ad7b9f4c3d36809dfc66b8bd6c904217f`.
Uptimes de API, web, MediaMTX e ingestão RTMP mantidos. Não verificados alcance
físico em metros nem eliminação de toda perda de movimento.
