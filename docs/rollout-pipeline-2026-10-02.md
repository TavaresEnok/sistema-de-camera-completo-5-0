# AjustCam — implementação e validação do pipeline

## Estado confirmado

API/web `9a44dfe` e IA `6a8632a` implantados na Vibe e IB Telecom.
Sem migrações novas de banco. Modos de gravação preservados: Vibe 31 manual/3
movimento; IB 28 manual, conforme conferência do rollout inicial.

Correções: consulta interna de detecções em lote; exibição temporária de movimento
recente apenas na simulação (não dispara regras); redução do trabalho do overlay;
medição limitada em memória dos estágios; entrega HTTP de eventos fora da thread
de análise. A fila de eventos é limitada a um item por câmera, aplica contrapressão
e não repete automaticamente requisições. Não é uma fila durável contra falhas.

Testes: 351 Python, 553 web, 43 API focados; TypeScript API/web passou.
Seis testes relevantes mobile passaram, mas não equivalem a teste em aparelho.
As mudanças mobile estão no código; APK atualizado ainda não foi publicado.

## Movimento: medições anteriores à correção do encaminhador

Vibe, três análises normais: alvo anterior 2 FPS, observados 1,269–1,484 FPS,
CPU total 19,93% em 60,66 s. Com alvo 5 e fila de eventos: 4,094–5,002 FPS,
CPU total 19,29% em 60,57 s. Janelas diferentes: não provam redução causal de CPU.
IB: duas simulações sem eventos, alvo 7, observados 6,513 e 6,712 FPS em 80,153 s.

Teste Vibe com câmeras adicionais distintas das três já analisadas; 20 s por taxa,
45 s de aquecimento, câmera sem evento/gravação alterados:

| Adicionais | Alvo FPS | Média FPS | CPU total |
|---|---:|---:|---:|
| 4 | 3 | 3,000 | 45,39% |
| 4 | 5 | 4,950 | 44,35% |
| 4 | 7 | 4,938 | 49,40% |
| 4 | 10 | 5,763 | 49,47% |
| 8 | 3 | 3,000 | 58,68% |
| 8 | 5 | 4,938 | 62,95% |
| 8 | 7 | 5,419 | 63,14% |
| 8 | 10 | 5,994 | 61,96% |

Com 13 adicionais (16 no total), a proteção interrompeu o teste após CPU acima de
75% por 15 s, antes de concluir a primeira taxa. Não comprova capacidade de 16,
50 ou 100 câmeras. Não extrapolar linearmente estes dados.

## TURN: aplicado e validado

Certificado dedicado Let's Encrypt para `turn.s2cam.com.br`, válido até
2026-12-30, instalado no Coturn. Renovação automática via timer e recarga USR2.
Chave de autenticação preservada; provisionada na configuração protegida da Vibe,
fora do Git. Não há relay anônimo e nenhuma chave privada de outro serviço foi
compartilhada com Coturn.

Teste real Chromium, política ICE relay, credenciais temporárias de 5 minutos:
UDP 3478: 1 candidato relay (também erros ICE 701); TCP 3478: 2 candidatos, sem
erro; TLS 5349: 2 candidatos, sem erro. Não foi ignorada validação TLS.
Esse teste comprova alocação no relay, não vídeo completo em todas as redes.

Vibe e IB tiveram somente MediaMTX recriado para ativar UDP/TCP/TLS. Ambas
retornaram saudáveis; API de configuração confirmou três URLs, clientOnly=true
e autenticação presente. Vibe: 47 caminhos prontos de 66 na verificação. IB:
0 de 48 sem leitores naquele instante; existem fontes sob demanda, portanto
esse número sozinho não comprova falha ou recuperação do vídeo.
Após essa conferência, a câmera IB 100002 respondeu HTTP 200 e playlist HLS
válida (`#EXTM3U`) ao solicitar vídeo; teste somente leitura, sem alterar gravação.

O template `infra/docker-compose.gateway.yml` agora contém os três transportes.
Isso cobre instalações futuras que usam esse template, mas ainda não comprova
o provisionamento de toda instalação existente fora de Vibe/IB.

## Gateway: correção implantada após piloto

SRS 5.0.213, fonte upstream `v5.0-r3`, commit
`313913737f13f97d9816dbc3d729e7bcd454a531`. `SrsForwarder::forward()` espera uma
mensagem de controle antes de transmitir a fila, com timeout de 500 ms.

Captura passiva de cabeçalhos TCP na saída ens18 do gateway para Vibe: 30 s,
1.343 pacotes com payload, 3.804.687 bytes TCP, 59 pausas acima de 400 ms;
mediana das pausas acima de 20 ms: 475,991 ms; p95: 488,553 ms. Medição feita
antes da rede externa; não identifica sozinha todos os problemas de rede.

Patch candidato permite `SRS_FORWARDER_PULSE_MS=50`, preserva 500 ms como padrão
e aceita apenas inteiros entre 10 e 500. Piloto sintético e comparação antes/depois
obrigatórios antes de aplicar ao gateway. Fontes, patch e configuração de piloto
ficam em `infra/gateway/srs/`; não há imagens de clientes nesses testes.

Piloto A/B concluído com a mesma imagem e vídeo sintético de 20 FPS:

| Espera | FPS recebido | Intervalo p95 | Maior intervalo | Pausas >400 ms |
|---|---:|---:|---:|---:|
| 500 ms | 20,021 | 484,907 ms | 493,965 ms | 40 |
| 50 ms | 19,993 | 51,847 ms | 149,948 ms | 0 |

Amostras de aproximadamente 20 s após aquecimento. Resultado demonstra entrega
mais regular no piloto, não garante detecção de todos os movimentos em produção.
Imagem candidata `drac-srs-forward:20261002`, configuração
`ba489cd1c3873e1f960f68ce2ad4f066ef4b6b0aca0040b0d7be6963119a78c7`.
Gateway preserva `drac-srs-rollback:20261002` com a imagem original exata.

Implantado por overlay `docker-compose.forward-pulse.yml`, recriando apenas SRS.
As 30 transmissões reconectaram; as três análises normais da Vibe foram
restabelecidas automaticamente. A primeira janela de medição atravessou reinícios
dos processadores e foi descartada (contadores reiniciados, não FPS negativo).
O medidor foi corrigido para sinalizar reinício de contador com FPS nulo.

Nova captura passiva de 30 s após reconexão: 640 pacotes com payload,
2.478.309 bytes; mediana das pausas 50,448 ms, p95 51,171 ms, máximo 152,213 ms,
zero pausas acima de 400 ms. Fluxo selecionado automaticamente, não necessariamente
a mesma câmera do antes; ganho causal mais bem isolado pelo piloto A/B.
SRS observação pontual com 30 streams: CPU Docker 17,27% de um núcleo;
antes, 13,59%. São amostras pontuais, não médias comparáveis.

Vibe após recuperação das três análises, janela de 60,68 s: 5,010 / 4,993 /
4,993 FPS, alvo 5; CPU total do host 32,60%. Captura/espera/decode p95
93,602 / 101,286 / 93,992 ms. A câmera de 640×480 que antes entregava cerca
de 4,1 análises/s agora atingiu 4,993. CPU observada maior que a janela anterior
de 19,29%; não atribuir toda diferença ao patch sem controlar leitores e carga.

Reteste com as mesmas oito câmeras adicionais, três normais preservadas:

| Alvo FPS | Média antes | Média depois | CPU host depois |
|---:|---:|---:|---:|
| 3 | 3,000 | 3,000 | 67,06% |
| 5 | 4,938 | 5,000 | 77,21% |
| 7 | 5,419 | 6,955 | 74,82% |
| 10 | 5,994 | 9,438 | 78,25% |

Aquecimento 33,1 s, oito fontes capturando; 20 s por taxa. Meta 7: mínimo
6,699, máximo 7,049; meta 10: mínimo 8,9, máximo 9,8. Sem erro de fonte reportado.
CPU não é monotônica entre janelas curtas e carga variável; não concluir que
7 custa menos que 5. Teste encerrado normalmente e container removido; nenhuma
análise extra permaneceu ligada. Permanecem metas normais Vibe 5 e IB 7.
Não há evidência para subir globalmente a 10 ou dimensionar 50/100 câmeras.

## Aprofundamento: captura, TURN completo e novas correções

Novas correções de IA, imagem `drac-pipeline-ai:20261002-deadline`, implantadas
na Vibe e IB após 355 testes Python aprovados (sem testes pulados nessa execução):

- `run_confirm_motion`: prazo agora cobre espera na fila e execução. Antes,
  a espera no semáforo não tinha prazo e, ao exceder o prazo de inferência,
  o handler aguardava a thread acabar para responder. Agora retorna o resultado
  seguro `confirmed=None` no prazo, mantendo a vaga ocupada até o trabalho real
  terminar. Cancelamento do cliente também preserva a vaga. Testes com worker
  bloqueado comprovam retorno antecipado, fila com prazo e concorrência limitada.
- Detector de objetos reserva trabalhador antes de preparar/redimensionar o
  tensor. Com pool ocupado, o quadro já seria descartado; antes o preparo
  consumia CPU desnecessariamente. Testes verificam que preparo não é executado
  nesse caso e que exceção no preparo devolve a vaga ao pool.

Comparação de quatro fontes distintas (100001/100002/100006/100007), meta 5,
30 s por amostra, vídeo ~20 FPS. Captura/conversão com detecção substituída por
função vazia: 1,281 núcleo no processo, CPU host 42,19%. Movimento ligado:
1,405 núcleo, CPU host 44,42%, 4,992 análises/s médias. Amostras sequenciais,
não uma decomposição exata: evidência de custo relevante da captura/decodificação.
Os caminhos sob demanda foram abertos somente para leitura; fonte upstream
precisava já estar publicando. Não alterado modo de gravação.

Vídeo completo no Chromium via WHEP público e política ICE relay, credenciais
temporárias; uma câmera 1080p, 20 s por transporte:

| Transporte TURN | Quadros decodificados | Pacotes perdidos | Travamentos | DELETE |
|---|---:|---:|---:|---:|
| UDP | 348 | 0 | 0 | HTTP 200 |
| TCP | 360 | 0 | 0 | HTTP 200 |
| TLS | 370 | 0 | 0 | HTTP 200 |

Teste TLS ampliado para 90 s: 1.725 quadros decodificados, 0 descartados,
0 pacotes perdidos, 0 travamentos; RTT 26 ms; sessão apagada HTTP 200.
Primeiro quadro em 5.508 ms inclui inicialização ICE/WHEP e espera de quadro
decodificável; não é medida da latência câmera→tela. Jitter buffer acumulado
154,636 s / 1.725 quadros ≈89,6 ms de residência média no buffer.

O primeiro harness fechava o PeerConnection antes do DELETE e recebia 404.
Repetição apagando antes de fechar retorna 200; nenhuma evidência de vazamento
foi atribuída a esse 404. O harness foi corrigido, não o produto.

TCP medido no namespace dos containers de vídeo, não no host apenas:
gateway SRS, 30,11 s: 38 segmentos retransmitidos /65.795 enviados (0,0578%);
Vibe MediaMTX, 30,23 s: 146 /53.383 (0,2735%); zero erros TCP e zero resets
de saída nas amostras. Razão de segmentos, não bytes nem quadros perdidos;
agrega conexões do serviço e não localiza o roteador responsável.

Vibe `vmstat` por 10 s: sem swap-in/swap-out nas amostras posteriores à linha
histórica inicial; CPU ociosa 78–84%, iowait 0–2%. Swap já ocupado (~515 MiB)
não demonstrou troca ativa. Disco de sistema 62% ocupado, 35 GiB disponíveis;
PSI memória avg10/60/300 =0. Nenhuma alteração de swap/disco foi aplicada.

Ferramentas de medição adicionadas: `probe-video-browser.py/.cjs`,
`measure-transport-counters.py`; benchmark admite captura sem detector e
seleção de fontes já publicando cujos caminhos grid estão sob demanda.

Rollback das novas correções: recriar apenas ai-service com
`drac-pipeline-ai:20261001-events`. Vibe seleciona a imagem no overlay
`docker-compose.pipeline-vibe.yml`; IB usa o overlay adicional
`/opt/drac-pipeline-20261001/infra/docker-compose.ai-deadline.yml`.
As imagens originais e as metas Vibe 5 / IB 7 foram preservadas.

Conferência após implantação: Vibe voltou automaticamente às três análises,
5,009 FPS em cada uma na janela de 60,69 s; CPU host 24,39%. Gravação continua
31 manual/3 movimento. IB: nova imagem healthy. Gateway: 30 streams, zero
reinícios do container corrigido. Captura/espera/decode Vibe p95 94–103 ms.

## Pendências que exigem outra cobertura

- Observar estabilidade prolongada; teste pós-correção com oito adicionais concluído.
- Vídeo ponta a ponta forçando relay e teste em rede móvel/aparelhos reais.
- Inventário das demais instalações e verificação do provisionamento TURN.
- Roteador/hipervisor 10.10.0.1: acesso solicitado, ainda não disponível.
- Medição separada de inferência/tracking de objetos e latência câmera→tela ainda
  não concluída. Os tempos atuais têm estágios combinados.
- Não há garantia de recuperar quadros que a câmera/rede de origem não entregou.

## Reversão

Vibe conserva imagens `drac-pipeline-rollback-{api,web,ai}:20261001` e overlay
`/opt/drac/infra/docker-compose.pipeline-rollback.yml`. IB conserva as mesmas
tags locais de rollback. Reverter apenas o serviço necessário, com os overlays
prod/gateway preservados; não usar compose base sozinho.

TURN: para voltar a UDP apenas, remover índices 1 e 2 do overlay gateway e
recriar somente MediaMTX, mantendo índice 0 e segredo. Isso reduz alternativas
de rede e pode interromper sessões. Não remover credenciais nem certificados
para efetuar rollback de imagem da API/IA.

SRS: `sudo docker compose -f /opt/ajustcam-gateway/docker-compose.yml up -d
--no-deps --no-build srs` retorna à imagem original definida no compose base.
Para manter a correção, incluir `-f /opt/ajustcam-gateway/docker-compose.forward-pulse.yml`
nas operações de atualização do SRS. Rollback interrompe brevemente transmissões.
