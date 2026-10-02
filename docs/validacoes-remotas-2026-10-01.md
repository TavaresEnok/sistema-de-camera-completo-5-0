# Validações remotas adicionais — AjustCam

Data do usuário: 01/10/2026, America/Fortaleza; metadados Docker usam UTC.
Rodada de testes: nenhum serviço de produção reiniciado, modo de câmera alterado
ou pacote instalado. Laboratórios usam containers próprios e descartáveis.

**Não considerar o pipeline completamente aprovado.** Há novos achados na
entrada de vídeo da IB, arranque do detector e exibição do navegador de teste.
As observações de duas horas continuam em andamento, sem conclusão final.

## Testes concluídos

| Validação | Evidência | Resultado / limite |
|---|---|---|
| IA completa | `Ran 355 tests`, `OK`, 25,522 s | 355 aprovados, nenhum pulado |
| Web completo | `tests 553`, `pass 553`, `fail 0`, `skipped 0` | 553 aprovados, 44,308 s |
| API: recuperação/gravação/integridade/watchdog/lote IA | `tests 107`, `pass 107`, `fail 0` | 107 aprovados, 41,308 s; incluem mocks/controles estáticos, não falhas da produção |
| Mobile completo, worktree `ddb2416` no management | `tests 117`, `pass 117`, `fail 0` | 117 aprovados; não equivale a execução nativa em aparelho |
| TypeScript API/web/mobile | `tsc --noEmit`, códigos 0 | Aprovados |
| Vibe, observação 15 min | 902,9 s, 28 amostras, 0 erros de coleta/reinícios de contador; quatro serviços healthy/restarts 0 | Três câmeras ~5 FPS durante a carga; primeira janela antiga foi descartada por desalinhamento temporal do medidor |
| IB, observação 3 min | 182,5 s, seis amostras, zero erros/reinícios; CPU host 0,63–1,76% | Sem IA normal ativa: 28 câmeras continuam manual; não é teste de frota IA na IB |
| Navegação SPA real Vibe | Três ciclos grid→perímetro→câmera→perfil→grid; quatro vídeos reproduzindo | Após 70 s, zero vídeos/peers abertos; zero exceções JS |
| Simulação em câmera manual | Botão habilitado e vídeo na simulação de movimento; modos preservados | Vibe 31 manual/3 motion; IB 28 manual |
| Falha HTTP no browser | 5 s offline e retorno; quatro vídeos reproduzindo depois | 18 falhas HTTP esperadas; não derruba mídia UDP por si só, não prova rede móvel real |
| Falhas do laboratório SRS→MediaMTX→análise/gravação | Fonte/encaminhador/sink interrompidos por 8 s | Análise recuperou em 12,512/4,756/13,263 s após restauração; gravação voltou a crescer |
| Latência sintética até apresentação | 599 amostras, 0 inválidas: mediana 83 ms, p95 101 ms, máximo 113 ms | Watermark no quadro, mesmo host: inclui geração/encode/SRS/MediaMTX/browser; **não é câmera real→tela** |

Navegação usa token temporário de conta administrativa existente, somente em
memória. Apenas a resposta de `/auth/refresh` é fornecida pelo diagnóstico;
demais chamadas, permissões, planos, players e páginas são reais. Não valida
login/cookie real. No ensaio inicial, referências a peers fechados eram mantidas
pelo observador: heap dessas rodadas não prova ausência de vazamento de memória.
O ensaio prolongado usa `WeakRef`.

DELETEs 404 na limpeza depois de fechar peers não foram classificados como
vazamento: todos os ciclos terminaram com zero peers. Polls de detecção pararam
nas páginas sem vídeo.

## Carga e TURN na Vibe

Quatro análises adicionais, alvo 5, 60 s: 100001/100002/100006/100007 entregaram
5,000 FPS cada; captura 19,967–20,017 FPS, zero descarte/erro reportado.
Processo adicional 1,615 núcleo, RSS 253,9 MiB; CPU total host **74,75%**.

Havia três análises normais, três leitores TLS, navegação com até quatro players
e laboratório sintético. Ocupação do grid variou. **Chromium de teste roda no
servidor**, portanto CPU inclui cliente, não só custo do servidor para clientes
remotos. Não dimensiona 50/100 câmeras nem demonstra capacidade máxima.
Uma janela de 33 s da observação geral chegou a 80,42%; FPS normais continuaram ~5.

Três leitores TLS por ~600 s: 12.018–12.019 quadros por leitor, zero perda RTP/
descarte RTP, RTT 27 ms; 4/5/6 freezes totalizando 1,077/1,286/1,562 s.
DELETEs 200. Não apresentado como teste sem travamentos.

Repetição com menos carga, três leitores TLS, 180 s: 3.571 quadros por leitor,
zero perdas/descartes/freezes, RTT 26–27 ms, DELETEs 200. Consistente com contenção
sob carga, mas janelas/cena diferentes impedem conclusão causal definitiva.
Após os probes: zero sessões; quatro sessões do grid prolongado são intencionais.

TCP MediaMTX, namespace do serviço, 600,25 s: OutSegs 1.057.264, RetransSegs 3.745
(0,3542% dos segmentos), InErrs 0, OutRsts 3. Agrega conexões e inclui troca de
players; não equivale a perda de quadros.

## IB: novo achado antes do navegador

| Transporte | Tempo | Decodificados | Perda RTP | Freezes | Tempo acumulado |
|---|---:|---:|---:|---:|---:|
| TLS | 60 s | 1.215 | 0 | 25 | 7,581 s |
| UDP | 60 s | 1.218 | 0 | 37 | 11,405 s |
| TLS, repetição | 90 s | 1.787 | 0 | 40 | 12,190 s |

Últimos dois probes: `icePolicy=relay`, candidatos relay coletados e transporte
selecionado `udp/tls`; DELETE 200. Chrome reportou `candidateType=prflx`. O primeiro
harness recusava esse rótulo apesar do vídeo/limpeza; agora verifica política,
candidatos coletados e transporte conjuntamente, não um único rótulo.

100002, antes do transcode: HEVC 640×360/30 FPS, três janelas ~20 s:

- FPS 29,575 / 29,993 / 30,028;
- maior intervalo 493,899 / 407,850 / 381,746 ms;
- 12/17/20 pausas acima de 150 ms.

Grid H.264: 640×360/~20 FPS, máximo 428,536 ms, cinco pausas >400 ms.
Configuração: libx264/veryfast/zerolatency, GOP 30. São leituras sequenciais;
não demonstram que toda pausa do navegador tenha a mesma causa.

Fonte configurada: **160.19.47.74:45554**, republicada em path interno antes da
conversão. Esse endpoint não consta nos quatro acessos administrativos fornecidos.
Não foi atribuído a uma VM/equipamento específico nem presumido como câmera direta.

Captura passiva na entrada RTSP da IB, cabeçalhos apenas, 40 s: 1.715 pacotes,
2.336.733 bytes; pausas >20 ms: mediana 43,172 ms, p95 88,669 ms; máximo 2.162,521 ms.
Inclui inicialização da conexão: máximo não apresentado como atraso recorrente
de reprodução estável. Nenhum payload/imagem/chave armazenado.

Logs MediaMTX agregados, últimos 10 min: zero marcadores `reader is too slow`,
`discarding`, `non-monoton`, `could not find ref`, `corrupt`, `connection timed out`.

Hipótese de segunda espera de 500 ms no SRS local **não sustentada nesse fluxo**:
captura sem pacotes e CurrEstab=0. Não substituir SRS 6.0.184 da instalação pela
correção SRS 5 do gateway às cegas.

## Problemas/prioridades

| Etapa | Problema e evidência | Impacto | Próxima ação / risco |
|---|---|---|---|
| Entrada IB | Pausas antes da conversão, máximos ~400–494 ms; freezes UDP e TLS | Alto | Investigar TCP/proxy/buffers/timestamps da entrada; leitura baixo risco, mudança de buffer/transporte médio. Não aumentar FPS para esconder pausa de origem |
| Caminho da 100002 | Entrada 160.19.47.74:45554 sem acesso administrativo fornecido | Alto para localização da causa | Identificar infraestrutura responsável; não atribuir defeito a equipamento sem evidência |
| Arranque do detector | 160 quadros sintéticos idênticos: contraste ligado gerou movimento nos quadros 46/47/48; desligado só na instância offline: zero | Médio: falso alerta/gravação no arranque | Revisar inicialização do histórico de contraste de 50 entradas 0/255 versus warmup MOG2 de 30. Risco médio; preservar baixa luz/eventos reais, não desligar contraste global nem estender cegueira |
| Confirmação temporal | 5 FPS, presença 200 ms: capturada em 8/8 fases, confirmada 0/8; 400 ms: 8/8 | Alto para passagens curtas; comportamento intencional | Separar captura e confirmação; revisar política com controles de falso positivo. Risco alto se remover confirmação indiscriminadamente |
| Exibição do cliente de teste | ~5 min de grid: descartes de exibição 304/327/422/343 versus descartes RTP 0/1/0/0 e zero pacotes perdidos | Médio no teste, não comprovado em clientes reais | Três vídeos 1080p + um 640×480, Chromium sem GPU. Separar renderização/recepção; testar fonte/substream. Transcode menor troca custo do cliente por CPU do servidor, exige benchmark |
| Latência absoluta | Startup WHEP e RTT não medem chegada→tela do mesmo quadro real | Ainda incompleta | Timestamp comum/sincronização na infraestrutura; risco médio se reencodar stream real |

## Movimento rápido sem teste físico

Detector real/default, retângulo móvel de alto contraste, fundo fixo, oito fases
de alinhamento por caso. 200 quadros de estabilização e controle estático quieto.
Primeira tentativa com 40 quadros foi descartada: falso movimento de arranque
confundia o resultado e motivou controle específico. Não converter em km/h nem
tratar oito fases como acurácia estatística de rua.

| FPS | Confirmações, 200 ms | 400 ms | 800 ms |
|---:|---:|---:|---:|
| 3 | 0/8 | 2/8 | 8/8 |
| 5 | 0/8 | 8/8 | 8/8 |
| 7 | 4/8 | 8/8 | 8/8 |
| 10 | 8/8 | 8/8 | 8/8 |

50/100 ms: zero confirmações nas quatro taxas. Mesmo 10 FPS amostrou 100 ms
em 8/8 fases sem confirmar. Código exige dois quadros para componente grande,
três para pequeno (`detectors/motion.py`). Aumentar FPS ajuda, mas não substitui
dados que não chegaram a tempo nem uma política de confirmação validada.

## Ensaios de duas horas ativos, ainda não aprovados

Vibe, CPU/serviços/FPS: unidade de usuário
`ajustcam-readonly-validation-20261001.service`, saída
`/tmp/ajustcam-validation-20261001.w3fIvp/stability-2h.ndjson`.
Início 23:34 de 01/10, término esperado ~01:34 de 02/10, Fortaleza.
7.200 s, intervalo 60 s, CPUQuota=20% de um núcleo para observador,
MemoryMax=256 MiB, RuntimeMaxSec=7400. Resumo final inclui erros/reinícios/
amostras anormais e médias/limites FPS/CPU.

IB: mesma unidade de usuário/duração/limites, saída
`/tmp/ajustcam-validation-20261001.TyKhKp/stability-2h.ndjson`.
Não liga IA normal nas câmeras manual.

Vibe, quatro players reais por 7.200 s: unidade de usuário
`ajustcam-grid-validation-20261001.service`, saída
`/tmp/ajustcam-validation-20261001.w3fIvp/grid-2h.ndjson`.
Token temporário somente em memória, perfil incognito, `WeakRef`; métricas de
heap/DOM/listeners/frames/peers/exceções/falhas por minuto. Ao concluir, sai da
grade e verifica limpeza após 70 s. Interrompe **o teste** se CPU host >75% por
20 s ou MemAvailable <512 MiB; não derruba serviços de produção. Chromium sem
GPU no próprio servidor: limite experimental. Quota do observador não é quota
dos processos Chromium dentro do container.

Arquivos 0600, diretórios 0700, somente contadores. Unidades transitórias de
diagnóstico, encerramento automático. Nenhuma senha/chave/JWT nos arquivos,
scripts ou commits. Resultados pendentes não foram contados como aprovados.

## Reprodução

Na worktree release:

```sh
python3 tools/validate-pipeline-stability.py --seconds 900 --interval 30
python3 tools/validate-web-navigation.py
python3 tools/probe-video-browser.py --seconds 180 --transport tls --readers 3
python3 tools/probe-video-browser.py --seconds 60 --transport udp --installation ib
python3 tools/probe-ready-frame-arrival.py --installation ib --camera 100002 --source grid
python3 tools/probe-ready-frame-arrival.py --installation ib --camera 100002 --source input
python3 tools/validate-isolated-recovery.py
python3 tools/validate-synthetic-latency.py
systemctl --user show ajustcam-readonly-validation-20261001.service -p ActiveState -p Result
systemctl --user show ajustcam-grid-validation-20261001.service -p ActiveState -p Result
```

Não rodar probes na mesma porta CDP simultaneamente: vídeo 9224, navegação/grid
9225, watermark 9226. Captura guarda credenciais em stdin/memória, não argumentos;
`--source input` abre somente path interno republicado, não URL direta de câmera.
Controles SSH autenticados precisam estar disponíveis.

Laboratórios removeram só seus containers/vídeos sintéticos em tmpfs. Nenhuma
gravação de cliente apagada. Queda do sink reinicia tmpfs vazio por definição;
não valida persistência de disco de produção. Após perdas de encaminhador/sink,
publicador sintético foi reiniciado: não prova autorreconexão de firmware.

Próximo: concluir os três ensaios prolongados; localizar entrada RTSP IB;
candidato isolado para contraste com regressões de baixa luz/ruído/cena real;
comparar custo/qualidade de grid; política de confirmação com falso positivo.
Não aplicado ajuste de detector, transporte ou modo de gravação nesta rodada.

Excluídos conforme pedido: aparelhos físicos, rede móvel real, veículos reais e
medição física de velocidade. Instalações sem acesso e segmento anterior à entrada
administrativamente acessível continuam fora da cobertura.
