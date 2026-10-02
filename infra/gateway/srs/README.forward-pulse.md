# Piloto de encaminhamento SRS

Não alterar o gateway antes de validar a comparação sintética e preparar rollback.
Base exata: ossrs/srs tag `v5.0-r3`, commit
`313913737f13f97d9816dbc3d729e7bcd454a531` (SRS 5.0.213).

Aplicar `forward-pulse.patch` na raiz do checkout dessa versão. Compilar em
container Ubuntu 20.04, limitado a 2 CPUs/2 GiB, com gcc, g++, make, patch, unzip,
perl, git, libasan5, tclsh, cmake, pkg-config, autoconf, automake e libtool.
Nenhum pacote precisa ser instalado no host de produção.

Na pasta `trunk`: `./configure --sanitizer=off --gb28181=on --jobs=2 && make -j2`.
Usar `Dockerfile.forward-pulse` com contexto na raiz do checkout SRS. A imagem
runtime permanece o digest SRS 5 já usado no gateway; somente o binário é trocado.

Configuração candidata: `SRS_FORWARDER_PULSE_MS=50` no container SRS.
Sem variável, vazio, inválido ou fora de 10..500: conserva 500 ms.
Não altera codec, resolução, FPS do vídeo ou gravação.

Piloto usa rede Docker interna, sem portas publicadas, `pilot-forward.conf` e
`pilot-sink.yml`. FFmpeg gera `testsrc2=size=640x360:rate=20`, H.264 ultrafast,
zerolatency, GOP 20, um thread, para `rtmp://drac-srs-pilot-forward/live/pilot`.
`tools/probe-synthetic-frame-arrival.py` mede a chegada via RTSP do sink:
5 s de aquecimento e 20 s de amostra. Comparar 500 e 50 ms com a mesma imagem.

O teste mede regularidade da entrega, não qualidade de detecção nem latência
câmera→tela. Em produção, repetir captura passiva e FPS/CPU antes de concluir
ganho. Aumentar frequência de despertar pode aumentar CPU do encaminhador.
