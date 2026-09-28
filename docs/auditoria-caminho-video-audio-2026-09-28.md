# Auditoria do caminho de vídeo e áudio — 28/09/2026

## Escopo e estado

Análise de código e observação não destrutiva da Vibe e da Gateway. Base de código: `ac56f4b`, branch `migration/repository-5-0`. Nenhuma correção, reinicialização, alteração de câmera ou implantação realizada nesta auditoria. Este documento é uma proposta para aprovação, não uma certificação de todos os ambientes.

Foram examinados ingestão RTMP, encaminhamento da Gateway, MediaMTX, construção de processos FFmpeg, seleção de perfil pela API, player web, seleção de áudio no app, consumidores de gravação/IA e configurações de transporte. Não foram executados testes de invasão, capturas de câmera adicionais ou testes de carga em produção.

## Conclusão principal

Na **VIBE SALA DE REUNIÃO**, habilitar áudio não é apenas desmutar a reprodução: seleciona `grid-audio`, cria uma saída com **reencodificação de vídeo H.264 e conversão de áudio para Opus**, e substitui a sessão de reprodução. Isso comprova a origem de trabalho adicional e do reinício na transição. **Não comprova, isoladamente, a causa de cada queda para 3–4 FPS.** Faltam métricas simultâneas de quadros na origem, saída do conversor e navegador.

O usuário relatou aproximadamente 20 FPS antes; com áudio, 12–17 FPS e pelo menos uma queda para 4 FPS. O aumento de CPU informado pelo usuário foi de aproximadamente 15% para 43%. Os dados coletados nesta auditoria não constituem um ensaio A/B controlado desses percentuais.

Há dois agravantes comprovados no código: o controle de quantidade de conversões não reconhece o tipo de publicador observado em produção; o indicador de FPS conta callbacks JavaScript, não a diferença de quadros apresentados.

## Caminho observado e caminhos alternativos

| Etapa | Evidência / responsabilidade |
|---|---|
| Câmera da sala | Cadastro ativo `955d87e3-6a07-4206-8f17-cd7d4194d8b7`, modo `rtmp_push`; metadados H.264 1920×1080, 20 FPS. Metadados não equivalem a medição instantânea. |
| Gateway | SRS recebe RTMP público e encaminha o vhost Vibe à instalação. Nginx encaminha HTTP/HTTPS do site. |
| Instalação | Caminho de entrada observado com H.264 + MPEG-4 Audio, fonte `rtmpConn`. Há adaptador SRS local e MediaMTX; a amostra não reconstituiu pacote a pacote qual adaptador a câmera atravessou. |
| API | Resolve a fonte e configura caminhos sob demanda por modalidade de entrega. |
| FFmpeg com áudio | Lê fonte interna; saída observada `libx264` + `libopus`, vídeo limitado a 640×360/20 FPS. |
| MediaMTX | Caminho `grid_audio` pronto, H.264 + Opus, publicado por `rtspSession`, um leitor. |
| Cliente | WHEP negocia a sessão; mídia WebRTC usa conexão ICE direta ou TURN. Rota ICE efetivamente escolhida não foi capturada. |
| Alternativas | HLS segue HTTP; gravação e IA são consumidores adicionais, com políticas próprias. Câmeras RTSP seguem outro ramo, diferente do RTMP da sala. |

O áudio e o vídeo já são trilhas distintas. Transportá-los na mesma sessão não significa transformá-los em uma única trilha ou exigir reencodificação do vídeo.

## Evidências de execução

Janela principal: aproximadamente 14:51–14:55 UTC de 28/09/2026.

- MediaMTX em execução: **v1.18.2**. Host com dez CPUs lógicas; sem quota explícita de CPU no contêiner MediaMTX.
- Antes da ativação observada, os caminhos da câmera estavam sem leitores e não prontos. Portanto essa amostra não serve como baseline de reprodução silenciosa a 20 FPS.
- 14:53:19: início do comando sob demanda `grid_audio`; 14:53:24: saída disponível com H.264 e Opus. Aproximadamente cinco segundos de inicialização nessa ocorrência.
- Processo da câmera: vídeo `libx264`, áudio `libopus`; outro conversor de vídeo estava ativo para outra câmera.
- 14:54:08 / 11 / 14: caminho da câmera permaneceu pronto, com um leitor; bytes recebidos/enviados cresceram de 2.754.944 para 2.914.224 e 3.096.604. Taxa agregada aproximada de 0,42–0,48 Mbps nesses intervalos; **não é medida de FPS**.
- Sessão WebRTC estabelecida, contadores de envio crescendo. `rtpPacketsLost=0` nessa resposta do servidor não prova ausência de perdas no receptor: não substitui os relatórios de entrada do navegador.
- Amostra posterior: fontes prontas `rtspSource: 17`, `rtspSession: 2`, `rtmpConn: 30`; nenhuma `publisher`. O caminho da sala continuava H.264/Opus com um leitor.
- Amostras de CPU do contêiner MediaMTX: aproximadamente 143% e 191%, em momentos diferentes. No Docker esses números representam múltiplos núcleos, não os mesmos percentuais de uso global citados pelo usuário. Não há atribuição causal válida da diferença inteira ao áudio.
- Não houve evidência de dois leitores simultâneos da câmera na janela amostrada. Isso não exclui sobreposição transitória durante trocas.

## Achados e recomendações

Classificação: **confirmado** = código/configuração ou execução demonstra o comportamento; **risco** = caminho plausível sem reprodução do impacto; **pendente** = exige medição adicional. P1 indica alta prioridade; P2, prioridade intermediária. Não se declara P0 de disponibilidade apenas pelo relato de FPS.

### V01 — P1 / confirmado: áudio troca a modalidade e reinicia reprodução

`apps/web/src/components/LiveStreamPlayer.tsx`, seleção de modalidade por volta da linha 519 e controle de áudio por volta de 2737; `apps/mobile/App.tsx`, `definirAudioAoVivo`, por volta de 1321.

No fluxo de grade, o estado de áudio escolhe entre `grid` e `grid-audio`; o app chama novamente `loadStream`. A mudança vai além do volume local e explica a reconstrução da conexão. Dependendo do fluxo, desligar também provoca troca. Proposta: separar qualidade, capacidade de áudio e mute; preservar sessão quando as trilhas necessárias já existem. Receber áudio mutado tem custo de banda/processamento, portanto a política deve ser explícita, não habilitar áudio indiscriminadamente em toda a grade.

### V02 — P1 / confirmado: RTMP com áudio força encode de vídeo

`apps/api/src/camera-stream/mediamtx-proxy.service.ts:2625`. A elegibilidade de cópia em `grid-audio` exige `usingSubStream`. O resolvedor de RTMP não fornece essa condição. Logo, H.264 RTMP também entra em reencode nesse ramo, mesmo que uma fonte já coubesse no limite.

Na câmera da sala a fonte cadastrada é 1080p, acima do limite do perfil leve: **não basta retirar uma condição para prometer a mesma qualidade, mesma banda e menor CPU**. É necessário decidir entre conservar o original com mais banda, usar uma fonte secundária real, ou manter redução compartilhada. O erro arquitetural é vincular essa decisão ao botão de áudio.

### V03 — P1 / confirmado: limitador não conta conversores observados

`mediamtx-proxy.service.ts:543` conta apenas `source.type === 'publisher'`. Os dois publicadores observados são `rtspSession`; o predicado não os contabiliza. Configuração de limite encontrada: dez conversões.

Proposta: registrar conversores geridos e seu ciclo de vida, reconciliar com processos/caminhos reais e testar contra a API da versão instalada. Não trocar simplesmente para contar todo `rtspSession`, pois publicadores externos podem usar o mesmo tipo.

### V04 — P1 / confirmado no código: caminho cadastrado pode contornar admissão

`mediamtx-proxy.service.ts:2534`. Quando o teto é atingido, a existência da configuração do caminho basta para liberar a operação; existência não significa conversor já ativo. Contagem periódica também deixa janela para partidas concorrentes. Proposta: reserva atômica durante inicialização, estados explícitos e liberação idempotente. Preservar leitores já ativos.

### V05 — P2 / confirmado: FPS da interface pode subestimar apresentação

`LiveStreamPlayer.tsx:1981–1994`: incrementa um contador por callback, embora receba `presentedFrames`. Atrasos da thread principal podem pular callbacks. A janela também pode incluir uma troca de sessão; sem novos callbacks, o último número pode permanecer visível.

Usar diferenças de contadores, reiniciar janela por sessão e tratar ausência de amostras. Separar FPS recebidos, decodificados e apresentados. Isso melhora o diagnóstico; **não autoriza chamar a queda relatada de “apenas visual”**. A documentação explica a semântica de [`requestVideoFrameCallback`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback).

### V06 — P2 / confirmado: diagnóstico esconde encode H.264 → H.264

`apps/api/src/camera-stream/camera-stream.controller.ts:506`: o sinal `liveTranscodedForBrowser` exige origem HEVC. A redução da sala reencoda H.264, mas não satisfaz esse diagnóstico. Proposta: campos independentes `videoCopied`, `videoEncoded`, `audioEncoded`, motivo, resolução e perfil efetivo. Diferenciar conversão de compatibilidade de redução de resolução.

### V07 — P1 / risco: vigilância por bytes não detecta vídeo parado com áudio vivo

Watchdog em `mediamtx-proxy.service.ts`, a partir de 526: saúde baseada em prontidão/tráfego agregado não distingue progresso de áudio e vídeo. Proposta: medir quadros/timestamps por trilha e combinar observação do cliente. Não reiniciar câmera automaticamente por um navegador lento.

### V08 — P2 / risco: reconfiguração de caminho compartilhado interrompe leitores

Mesmo serviço, comparação de configuração por volta de 2760 e cálculo de bitrate por volta de 2640. Alterações no comando podem levar à substituição do caminho; bitrate derivado da fonte pode alterar o comando. Não foi demonstrado ciclo repetitivo na janela observada. Proposta: perfis estáveis/versionados e atualização sem destruir uma saída compartilhada ativa por demanda de outro leitor.

### V09 — P2 / confirmado no desenho: fontes privadas por modalidade

`privateSourcePathName`, por volta de 897, deriva o caminho privado do caminho de entrega. Modalidades distintas podem manter conexões próprias à mesma fonte RTSP. Compartilhar por câmera e fonte física quando compatível; não fundir main/sub nem autorizações diferentes.

### V10 — P2 / risco: custos concorrentes de gravação, IA e visualização

`recording-process-manager.service.ts`, por volta de 1422, e `ai-manager.ts`, por volta de 1240: RTSP pode ser aberto diretamente por consumidores diferentes. Há fila curta e descarte de frames antigos no processador de IA, o que é positivo, mas limitar inferências não implica eliminar custo de decodificação. Medir antes de consolidar; preservar gravação original e isolamento da IA.

### V11 — P2 / confirmado: política de áudio pouco informada pelo codec

Com `wantsAudio`, a construção aplica `libopus` e mapeamento opcional de áudio. Isso não distingue fonte AAC de áudio já compatível e pode resultar em saída somente de vídeo quando não há trilha. Proposta: capacidade real da fonte, cópia quando suportada, conversão quando necessária e informação clara ao usuário quando não há áudio.

### V12 — P2 / risco: diferenças entre qualidade e áudio nos clientes

Web seleciona original/grade para qualidade máxima, e instantâneo/`grid-audio` em outro ramo. No app, áudio também pode disparar atualização da URL HD. Não há evidência de equivalência entre todos os estados. Criar matriz única de qualidade × áudio × protocolo × capacidade e testar HD, grade, tela cheia, alternância e retorno do segundo plano.

### V13 — P1 / risco de segurança: Location de sessão WHEP no web

`LiveStreamPlayer.tsx`, por volta de 1617: resolução de `Location` e fluxos de DELETE com credencial merecem proteção explícita de origem, como já existe em fluxo mobile. Validar todos os ramos antes de concluir explorabilidade. Recomenda-se rejeitar destinos inesperados, limitar tempo de limpeza e nunca encaminhar token a origem arbitrária. Nenhum vazamento foi provocado ou observado.

### V14 — P1 / configuração suspeita: proteção RTMP PLAY na Gateway

`infra/gateway/srs/srs.conf` não contém bloqueio de PLAY nem callback de autorização de reprodução. A instalação local tem `deny play all` explícito em `infra/rtmp-ingest/srs.conf:82`. O trecho da configuração de produção consultado na Gateway apresenta vhosts de encaminhamento, mas não basta para certificar a configuração efetiva completa.

O SRS documenta permissividade quando a proteção está desabilitada: [Security](https://ossrs.net/lts/en-us/docs/v4/doc/security). Essa referência é da documentação v4; a Gateway observada usa imagem SRS 5, exigindo confirmação da versão/configuração efetiva. Tratar como prioridade de validação: impedir reprodução direta que contorne ACL da aplicação, sem interromper publicação e forward. **Exposição externa não foi testada nem declarada comprovada.** Revisar também autenticação na entrada, não apenas no destino do encaminhamento.

### V15 — P2 / pendente: ICE, TURN e perdas no cliente

Sem estatísticas do receptor não é possível excluir perda, jitter, RTT alto ou relay. Nginx não transporta os pacotes de uma sessão WebRTC UDP direta, mas participa da sinalização e dos caminhos HTTP/HLS. Confirmar o par ICE escolhido e medir ambos os modos de rede, sem atribuir o problema genericamente à Gateway.

### V16 — P2 / pendente: timestamps, GOP e comportamento do encoder

Não foram capturados FPS efetivos da origem, B-frames, intervalos de keyframe, PTS/DTS ou velocidade do FFmpeg. Flags atuais incluem geração de timestamps, descarte de corrupção e baixa latência. Sua presença não demonstra erro. Medir continuidade e tempo por quadro antes de alterar filtros, buffers ou introduzir ressincronização de áudio.

### V17 — P2 / indício operacional: trabalho para câmera desabilitada

Logs mostraram falhas periódicas de poster para o cadastro antigo/desabilitado “VIBE SALA REUNIÃO”. Não confundir com a câmera ativa. Identificar agendamento, referência e custo; não remover cadastro nem arquivos automaticamente.

### V18 — P2 / pendente: código analisado versus versão entregue

As correções anteriores de app/API chegaram ao Git, mas não houve implantação delas nesta auditoria. Não presumir que o APK instalado ou todos os serviços executem `ac56f4b`. Inventariar versão de API, web, APK e imagens antes do ensaio final para evitar testar implementações diferentes.

## Solução recomendada, sujeita à autorização

1. **Separar áudio de qualidade.** Desmutar uma sessão compatível existente deve ser uma operação local. Se for necessária uma primeira preparação de áudio, assumir e medir essa transição; não prometer custo zero.
2. **Preservar vídeo compatível quando a qualidade escolhida permitir.** H.264 original com cópia + AAC→Opus é a primeira opção a ensaiar para a sala. Pode aumentar banda frente aos atuais 360p; confirmar compatibilidade de perfil/GOP e capacidade do cliente.
3. **Perfil leve como decisão própria.** Preferir substream real adequado. Quando só houver RTMP principal, uma redução compartilhada por câmera/perfil pode continuar necessária; ligar áudio não deve recriá-la nem trocar resolução silenciosamente.
4. **Compartilhar conversões entre espectadores.** Uma saída por fonte/perfil compatível, referência de leitores e fechamento com tolerância. Não criar conversor por usuário e não misturar escopos de autorização.
5. **Corrigir admissão e telemetria antes de expandir carga.** Reservas durante partida, custo distinto para cópia/áudio/vídeo, progresso por trilha e métricas do receptor.
6. **Manter alternativas de reprodução.** HLS pode conservar AAC quando compatível, com latência diferente. Não trocar todo o produto de protocolo sem testes no web e nos apps.

AAC não é um codec de interoperabilidade obrigatória do WebRTC; Opus e G.711 são as opções de base documentadas. Não é necessário converter todo áudio de toda câmera: depende do codec e do destino. Fontes: [RFC 7874](https://www.rfc-editor.org/info/rfc7874/) e [codecs WebRTC — MDN](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/WebRTC_codecs).

Separar áudio e vídeo em conexões/elementos independentes e sincronizar manualmente em JavaScript é possível como arquitetura específica, mas introduz relógios, drift, buffers e políticas de autoplay distintos. Não elimina a necessidade de compatibilidade do codec. Para este caso, recomenda-se conservar trilhas separadas na mesma sessão WebRTC e a sincronização nativa, sem reencodar vídeo apenas por causa do áudio. A cópia H.264 precisa respeitar as [restrições WebRTC do MediaMTX](https://mediamtx.org/docs/features/webrtc-specific-features), inclusive B-frames.

## Plano de verificação antes e depois de implementar

Ensaio inicial com uma câmera e cliente identificados, mesma qualidade e rede; registrar horário, versão e número de espectadores. Capturar pelo menos três janelas comparáveis, incluindo reprodução estável e transições. Testes que criem novos consumidores ou instrumentem produção devem ser combinados antes.

| Camada | Medidas necessárias | Critério de avaliação |
|---|---|---|
| Fonte | FPS/PTS, codec, resolução, GOP, áudio presente | Saber se a queda já chega da câmera |
| Conversor | Quadros/s, velocidade, CPU por processo, timestamps | Não acumular atraso; vídeo em cópia quando essa for a política |
| Servidor | Leitores, processos, partidas, reservas e tráfego | Sem conversão duplicada por espectador; teto efetivo |
| WebRTC receptor | framesReceived/Decoded/Dropped, packetsLost, jitter, jitterBufferDelay, freezeCount, decode time | Localizar perda entre recepção, decode e apresentação |
| Rede | Par ICE, RTT, relay/direto e bitrate | Distinguir rede de CPU e renderização |
| Tela | Delta presentedFrames, long tasks, tempo até primeiro frame | Indicador coerente e ausência de reinício em mute local |
| Áudio | Continuidade e diferença temporal A/V | Sem drift progressivo em sessão prolongada |

Cobrir ainda: câmera sem microfone; AAC, Opus/G.711 quando disponíveis; H.264/HEVC; RTMP/RTSP; main/sub; grade/HD; Chrome/Safari e apps efetivamente suportados; segundo plano; conexão móvel; UDP bloqueado/TURN; múltiplos leitores; parada/retorno da câmera; limite atingido e permissões revogadas. Testar também que gravação e perímetro não sofram regressão.

Aceitação para a sala: comparar com a referência da própria fonte, não exigir 20 FPS se ela não estiver entregando 20. Não aceitar quedas repetidas a 3–4 FPS sem localizar a etapa, nem esconder o problema corrigindo apenas o contador visual. Medir economia de CPU, sem prometer retorno exato a 15% ou 20%.

## Limitações e próxima decisão

Não há captura do navegador/app do usuário, teste controlado da fonte nem inventário completo de firmware/câmeras. As observações de produção são amostras, não monitoramento contínuo. Os riscos acima não equivalem todos a incidentes reproduzidos. A investigação identificou defeitos concretos suficientes para orientar a correção, mas a causa exata de cada oscilação permanece parcialmente aberta.

Próxima etapa proposta: autorização para corrigir política áudio/qualidade, admissão e observabilidade, seguida de validação gradual com a câmera da sala. Questões de segurança devem ser verificadas prioritariamente e tratadas em mudanças próprias. Nenhuma dessas mudanças foi executada por este relatório.
