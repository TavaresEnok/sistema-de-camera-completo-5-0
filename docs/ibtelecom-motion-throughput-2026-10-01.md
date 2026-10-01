# IBTelecom: queda da taxa de análise de movimento

## Ensaio e resultados

24 fontes RTSP habilitadas, com vídeo e movimento simultâneos. Todas as 28 câmeras cadastradas permaneceram em gravação manual. Os ensaios usaram processadores isolados, as zonas reais do banco e `simulationOnly=true`: sem eventos, gravações ou detector de objetos. O novo `tests/bench_stream_fleet.py` executa o mesmo `StreamProcessor` da aplicação, com captura e análise em threads distintas.

A comparação anterior com `bench_fleet_motion.py` não representava exatamente esse caminho: captura e inferência aconteciam na mesma thread. Não utilizar aqueles números como capacidade comprovada da aplicação.

Original: commit `93433b8`, amostras de 20 s por taxa. Correção: amostras de 30 s por taxa, após todas as 24 fontes entregarem imagens. Ordem 3, 5, 7 e 10; cenas, tráfego e condições da rede variaram. FPS abaixo é média das análises concluídas, não configuração ou FPS declarado pela câmera. CPU total inclui MediaMTX, conversão dos vídeos e demais serviços do host (30 CPUs lógicas).

| Meta por câmera | FPS real original | FPS real corrigido | CPU total original | CPU total corrigida | CPU só do processo corrigido (núcleos) |
|---|---:|---:|---:|---:|---:|
| 3 | 1,913 | 2,737 | 28,88% | 24,78% | 2,143 |
| 5 | 2,592 | 3,964 | 32,48% | 26,10% | 2,487 |
| 7 | 3,148 | 5,667 | 33,48% | 25,74% | 2,691 |
| 10 | 3,154 | 6,283 | 32,93% | 27,73% | 3,086 |

Em outra rodada, com a mesma seleção contínua e timeout de leitura menor, 19/24 fontes atingiram pelo menos 90% da meta de 5, com média total 4,396 FPS. A variação entre rodadas reforça a necessidade de acompanhar a entrega real da origem, não apenas CPU ou configuração.

Na rodada final, as outras 20 fontes tiveram médias de 2,995 / 4,417 / 6,328 / 7,087 FPS. Os IDs públicos 100001, 100012, 100014 e 100015 apresentaram interrupções ou entrega concentrada em rajadas. Não retirar essas fontes da média total para prometer cumprimento da meta. Aumentar para 10 não resolveu suas falhas.

A 7 FPS, CPU do processo caiu de 5,253 para 2,691 núcleos; memória máxima de aproximadamente 1.152 para 413 MiB. Esses são resultados de amostras curtas noturnas, não garantia para cenas diurnas muito movimentadas.

## Causas corrigidas no software

- Seleção pelo relógio na captura ignorava as imagens que chegavam entre horários de análise. Movimento agora mantém continuamente o último quadro, com fila de tamanho 1, e controla a cadência no consumidor. Não duplica imagem para completar FPS nem cria fila de imagens antigas.
- `read()` após a drenagem avançava um quadro adicional. Captura agora usa `grab()` + `retrieve()` do mesmo quadro.
- Decoder automático criava muitas threads por câmera; OpenCV também tinha 30 threads internas. Os dois passam a usar 1 por padrão, aproveitando o paralelismo já existente entre câmeras. Threads e timeouts de FFmpeg são fornecidos ao abrir o vídeo, porque configurá-los depois não funcionava.
- Medianas dos 48 blocos de iluminação causavam disputa entre threads Python. O cálculo foi agrupado, preservando as medianas e as decisões originais, comprovado por teste contra o algoritmo anterior.
- Flags forçadas `nobuffer/low_delay` agravavam alguns H.264. Removidas do padrão; uma sonda isolada da mesma fonte passou de 2,37 para 10,20 quadros decodificados/s, mas isso não eliminou suas interrupções nas medições longas.
- Corrigida corrida entre produtor/consumidor que podia abandonar a imagem nova se a fila fosse esvaziada simultaneamente.
- A validação após publicar revelou outra causa real de interrupção: a API encerrava a simulação a cada dois ciclos de limpeza (aproximadamente um minuto), porque a câmera manual tinha `aiEnabled=false`. Logs confirmaram o encerramento das duas câmeras do ensaio e de uma simulação aberta pelo navegador. A limpeza agora preserva somente sessões de perímetro ativas, explicitamente temporárias e sem emissão de eventos. Sessões comuns e simulações expiradas continuam sujeitas à limpeza; não foi ligado o toggle nem alterado o modo de gravação das câmeras.
- A simulação de movimento agora utiliza `MOTION_DETECTION_FPS`, como a detecção normal, sem valor 7 escondido apenas na simulação. IBTelecom permanece com meta 7 nos dois caminhos; o padrão para outras instalações é 5, ajustável por capacidade.
- `/health` informa `motion_fps`, `motion_infer_runs`, tempo médio/p95 do detector, threads do decoder e substituições intencionais da imagem disponível. Taxa recente zera após interrupção, em vez de continuar mostrando uma média antiga.

## Limite ainda observado na origem/rede

Nomes no cadastro: 100001 = Grupo Flash Cam-05; 100012 = Cam-06; 100014 = Cam-04; 100015 = Cam-08.

Um leitor independente, sem detector, apresentou pausas de 2,87 / 3,28 / 4,62 / 5,34 s no H.264 de 100001. FFmpeg independente também recebeu apenas 108 quadros para aproximadamente 20 s de vídeo nesse caminho. Uma sonda direta da origem, sem passar pelo MediaMTX, também não sustentou a taxa declarada. O stream principal alternativo não foi solução: entregou apenas 18 quadros em aproximadamente 15 s na amostra. Nenhuma configuração da câmera foi alterada.

Mesmo uma fonte convertida com aproximadamente 20 FPS teve intervalos de chegada de 0,3–0,42 s. As conexões TCP com `160.19.47.74` mostraram RTT por volta de 260–290 ms e contadores elevados de pacotes recebidos fora de ordem; a interface física do servidor tinha zero erros/drops nos contadores consultados. Isso é evidência compatível com as rajadas, não identificação definitiva do equipamento ou enlace responsável. O ensaio UDP direto não entregou vídeo útil; não foi aplicado à produção.

Timeout limitado de leitura de 15 s evita interromper prematuramente um quadro em conexões que já apresentaram pausas maiores que 5 s. Não recupera instantes ausentes na origem. Resolver definitivamente as quatro fontes exige investigar o equipamento/enlace que as entrega; não afirmar que o software captura movimentos durante intervalos sem imagens.

## Estimativa para 50 e 100 câmeras

Apenas movimento, extrapolando os 2,691 núcleos medidos com 24 câmeras a 7 FPS: aproximadamente 5,61 núcleos (18,7% do host) para 50 e 11,21 (37,4%) para 100. **Não inclui** abrir/converter todos esses vídeos, gravação, objetos ou piora da concorrência.

Se todo o consumo total desta frota fosse proporcional ao número de fontes, 25,74% para 24 indicaria aproximadamente 54% para 50 e mais de 100% para 100. Essa extrapolação é grosseira, não um teste nem uma garantia: parte do custo é fixa, codecs variam e rede/concorrência podem saturar antes. Não aprovar 100 câmeras com vídeo e movimento simultâneos neste host com base neste ensaio.

## Evidências operacionais

JSONLs preservados no servidor: `/tmp/ib-motion-original-stream.jsonl`, `/tmp/ib-motion-fixed-plain.jsonl`, `/tmp/ib-motion-capture-only.jsonl`, `/tmp/ib-motion-latest-frame.jsonl` e `/tmp/ib-motion-final-fleet.jsonl`. Não contêm senhas ou imagens; podem ser removidos pela limpeza de temporários, portanto os resultados relevantes foram registrados aqui.

Os testes automatizados verificam medianas idênticas, cadência 3/5/7/10, imagens únicas, ausência de rajadas de compensação, corrida da fila, parâmetros do decoder, taxas recentes e igualdade entre detecção normal e simulação. Os testes de equivalência BGR/luminância foram estabilizados fornecendo os mesmos instantes para os dois detectores, sem alterar suas expectativas ou o algoritmo.

## Implantação e conferência após publicar

Código implantado: `b6f0007` (captura/cadência) e `0045c7a` (limpeza da simulação). AI e API foram reconstruídas e publicadas; saudáveis e sem reinicializações espontâneas. `DRAC_VERSION=0045c7a99a353c918d63b414336d84f199327a91`, `MOTION_DETECTION_FPS=7.0`, OpenCV e decoder com 1 thread. A página pública respondeu HTTP 200, conferida de fora do servidor (o acesso do servidor ao próprio IP público não funciona por esse caminho).

Validação no serviço real, via suas rotas internas, sem substituir processos/sessões que já existiam: câmeras 100002 e 100004, duração medida 90,708 s. Meta 7; médias reais 6,604 e 6,637 análises/s; captura próxima de 20 FPS. Ambas permaneceram `simulation_only=true`, `emit_events=false`, com sessão de perímetro ativa. Sobreviveram a mais de dois ciclos da limpeza automática. Encerrar cada sessão devolveu `processor_stopped=true`. As outras sessões do usuário não foram encerradas pelo teste. Consulta final do banco confirmou **28/28 câmeras em gravação manual**.

Verificações finais: 339 testes Python, 36 testes de política/limpeza e 54 testes críticos de API aprovados; compilação TypeScript sem erros.

Rollback anterior à implantação: ambiente em `/tmp/ib-motion-deploy-YzdLwh/env.before`; imagens `infra-ai-service:before-motion-capture-20261001` e `infra-api:before-motion-capture-20261001`. O arquivo de ambiente contém segredos e não foi incluído no Git.
