# Correções publicadas e validações — 02/10/2026

Data civil America/Fortaleza; timestamps Docker em UTC. Revisão da aplicação:
`5d27611`, incluindo `c65bfbc`. Publicado na Vibe e na IB; não extrapolar para
instalações sem acesso fornecido. Testes físicos foram excluídos pelo usuário.

**O pipeline da IB não está totalmente resolvido:** a entrada republicada de
`160.19.47.74:45554` já apresenta pausas antes da conversão. Não há acesso
administrativo fornecido a esse endpoint; identificação/acesso foram solicitados.
Não foi presumido que seja câmera, gateway ou serviço de algum dos hosts conhecidos.

## Correções e riscos

| Etapa | Correção | Evidência | Risco/limite |
|---|---|---|---|
| Movimento: arranque | Inicializar histórico de contraste com percentis reais do primeiro quadro; primeira imagem uniforme mantém identidade | Antes, 160 quadros idênticos disparavam nos quadros 46/47/48; depois, zero; quatro regressões de arranque/baixa luz | Médio; contraste e warmup continuam ativos, sem estender cegueira |
| Movimento curto | Permitir confirmação em um quadro somente para componente forte/compacto, após guardas de luz, ruído, zonas e periodicidade | Sete regressões específicas; a 5 FPS, presença sintética de 200 ms passou de 0/8 para 8/8 confirmações | Médio; não garante acurácia de rua; `MOTION_SINGLE_FRAME_STRONG=false` restaura confirmação anterior |
| Grid/overlay | Reutilizar estado quando caixas visíveis não mudam; filtrar movimento antes de comparar | Quatro testes novos; navegação real sem exceções, limpeza com zero peers próprios | Baixo; não resolve sozinho custo de três vídeos 1080p em cliente sem GPU |
| Conversão de vídeo | Limitar threads de entrada a 2 e filtros a 1, independentemente das threads do encoder | Ordem dos argumentos verificada; A/B e publisher real descritos abaixo | Médio; não alterar resolução, FPS, qualidade, GOP ou buffers; limites configuráveis |
| Diagnóstico, não aplicação | Fechar Chromium por CDP, aguardar saída e recolher descendentes com init/subreaper | Três testes; probe real final terminou sem processos Chromium/crashpad nem zombies | Baixo; somente processos pertencentes ao diagnóstico |

Arquivos principais: `services/ai-service-python/detectors/motion.py`,
`services/ai-service-python/utils/runtime_profiles.py`,
`apps/web/src/lib/live-overlay-state.ts`,
`apps/api/src/camera-stream/helpers/live-decoder-budget.helper.ts` e
`tools/browser-validation-runtime.cjs`.

O controle negativo de blur foi ajustado: o teste anterior esperava falsos eventos
sem suavização, mas dependia do defeito de contraste agora eliminado. O controle
isolado mede o quadro entregue ao modelo: blur 3 reduz energia de alta frequência
em pelo menos 80%; os controles funcionais de ruído e movimento em baixa luz foram
preservados. Não foi descartada uma regressão real para esconder falha.

## Movimento: captura não é confirmação

Retângulo sintético forte, fundo fixo, oito fases de amostragem, detector real.
Valores são confirmações; neste controle todo evento amostrado foi confirmado.

| Análises/s | Presença 50 ms | 100 ms | 200 ms | 400 ms | 800 ms |
|---:|---:|---:|---:|---:|---:|
| 3 | 2/8 | 3/8 | 5/8 | 8/8 | 8/8 |
| 5 | 2/8 | 4/8 | 8/8 | 8/8 | 8/8 |
| 7 | 3/8 | 6/8 | 8/8 | 8/8 | 8/8 |
| 10 | 4/8 | 8/8 | 8/8 | 8/8 | 8/8 |

Isso não é acurácia estatística, teste físico ou limite em km/h. A 5 FPS,
movimento entre dois quadros ainda pode não ser capturado. Componentes mais fracos
mantêm confirmação temporal; não houve alteração na política de objetos.

## Publicação e preservação de produção

Imagens ativas nas duas instalações:

- IA: `drac-pipeline-ai:20261002-motion-fixes`.
- Web: `drac-pipeline-web:20261002-overlay-fixes`.
- API: `drac-pipeline-api:20261002-live-budget`, `DRAC_VERSION=5d27611`.

Vibe: overlay `/opt/drac/infra/docker-compose.pipeline-vibe.yml`; movimento normal
alvo 5 FPS; 31 câmeras manual/3 movimento preservadas. IA usa uma thread de decode,
uma OpenCV e oito de inferência. IB: overlay adicional persistente
`/opt/drac-pipeline-20261001/infra/docker-compose.motion-fixes.yml`; 28 câmeras
manual preservadas, sem IA normal ativa; alvo de simulação anterior preservado.
API: `LIVE_CAPTURE_DECODER_THREADS=2`, `LIVE_CAPTURE_FILTER_THREADS=1`.
Encerramento gracioso de API/IA: 30 s. Sem migrações de banco.

IA/web foram atualizados aproximadamente às 14:15–14:16 UTC; API Vibe iniciou
às 14:28:38 UTC. Reinício de API pode causar intervalo de gravação/reconexão:
não alegar continuidade perfeita. Registros novos posteriores ao restart Vibe
incluem segmentos de 24–127 s, 2.508.758–16.049.046 bytes. Nenhuma gravação de
cliente foi removida; metadados conferidos em `Recording`.

MediaMTX e SRS não foram reiniciados nesta rodada. MediaMTX Vibe iniciado em
01/10 23:57:37 UTC e IB em 01/10 23:59:11 UTC, RestartCount 0; SRS locais iniciados
em 26/09 02:50:05 e 25/09 20:27:27 UTC, respectivamente, RestartCount 0.
TURN compartilhado permanece na configuração protegida do MediaMTX; API não lê
`MEDIAMTX_TURN_SECRET`, portanto sua ausência na API não é defeito.

Hashes do código IA conferidos nas duas instalações:

```text
motion.py: b91fb9474f21154302840d5bd17002337fc7dd3d3eb665829116eb33a52cbdde
runtime_profiles.py: d4f30b045ad564fd6c509eae9baf71b637b319c4950be97d3967c8de9f022766
```

Reconciliação normal dos perfis existentes: três na Vibe e 18 na IB, HTTP 200,
sem editar modo de câmera. Publisher ativo da Vibe 100048 preservava comando
antigo enquanto tinha leitor. Foi aplicado PATCH apenas de `runOnDemand` desse
path, inserindo orçamento de threads; MediaMTX encerrou automaticamente o comando
antigo. Nenhum kill genérico foi aplicado. Novo publisher: 11 threads versus 22,
~19,985 FPS; cliente WebRTC reconectado às 14:43:25 UTC. Havia 16 sessões de
produção estabelecidas ao final; não foram confundidas com sessões do teste.

## Evidências de validação

| Verificação | Resultado | Limite |
|---|---|---|
| Testes distintos da rodada | Python 366 + controles funcionais 7 + web 557 + API 121 + lifecycle 3 = **1.054 aprovados** | Repetições não somadas; TypeScript API/web e builds aprovados |
| Mobile | 117 aprovados na rodada anterior | Sem alteração mobile nesta rodada; não recompilar APK sem mudança; não equivale a aparelho físico |
| Vibe após IA/web | 301,8 s, nove janelas, zero erros/reinícios/anomalias; FPS médios 4,994/4,998/4,998 | CPU média 63,81% incluía browser/builds, não custo isolado da IA |
| Vibe medição final | 60,69 s: FPS 4,993/5,009/4,993; CPU host média 36,77%, janelas 32,99–43,92% | Inclui pequeno probe TLS de 5 s; não dimensiona 50/100 câmeras |
| Estágios movimento final | Média 16,1–18,1 ms, p95 22,9–25,6 ms; publicação overlay média 0,075–0,096 ms | Janela recente de contadores; não é latência física frame→tela |
| Grid real, 5 min | Quatro vídeos; 23.507 quadros/2.358 descartes de exibição; zero exceções JS; após perfil, zero peers | Chromium software no servidor ainda descarta apresentação; não afirmar que todos os clientes foram corrigidos |
| Navegação após publicação | Três ciclos grid/perímetro/câmera/perfil; simulação manual habilitada; falha HTTP 5 s recuperou quatro vídeos; zero peers próprios ao sair | 18 falhas HTTP e DELETEs 404 esperados na limpeza, não login/celular real |
| TURN TLS final Vibe | HTTP 201, relay TLS, 80 quadros/5 s, zero perda/descarte/freeze; DELETE 200; startup 2.611 ms | Probe curto, não garantia universal |
| Recuperação isolada | Fonte/forwarder/sink fora por 8 s: recuperação 6,505/5,257/4,754 s; gravação voltou a crescer | Laboratório sintético; não prova firmware ou persistência em disco de produção |
| Latência sintética absoluta | 597 amostras: mediana 83 ms/p95 115 ms/máximo 169 ms. Repetição após lifecycle: 599 amostras, mediana 83 ms/p95 103 ms/máximo 119 ms; ambas zero inválidas/perda/drop/freeze | Watermark geração→encode→SRS→MediaMTX→Chrome no mesmo host, não câmera física |

Ensaios prolongados: Vibe CPU/FPS e grid concluíram duas horas; IB foi interrompido
com 5.805,1 s e não foi contado como aprovado por duas horas. Detalhes/arquivos:
[validacoes-remotas-2026-10-01.md](validacoes-remotas-2026-10-01.md).

### Orçamento de decode: ganho demonstrado e ganho não demonstrado

Fonte republicada IB 100002, ensaios sequenciais de 25 s, quota de dois núcleos,
512 MiB, mesma saída H.264. Credenciais só em stdin/memória; hashes descartados.

| Variante | Threads | CPU FFmpeg acumulada | FPS efetivo | p95 intervalo | Maior intervalo |
|---|---:|---:|---:|---:|---:|
| Auto | 26 | 5,074 s | 20,032 | 112,641 ms | 355,542 ms |
| Decoder 2/filtros 1 | 11 | 5,429 s | 20,050 | 112,604 ms | 448,660 ms |

Ganho comprovado: recursos mais previsíveis, menos threads. **Não foi demonstrada
grande redução de CPU nem eliminação de jitter.** Uma tentativa com coleta de
threads inválida foi descartada, não atribuída a falha de produção. Probe de
buffers alternativos não mostrou ganho estável suficiente; não publicado.

### IB: falha ainda presente na origem

Antes de reconciliar os perfis: TLS 90 s, 1.817 quadros, zero perda/descarte RTP,
39 freezes/10,711 s, RTT 14 ms. Depois: TLS 60 s, 1.214 quadros, zero perda/descarte,
39 freezes/11,769 s, RTT 25 ms. Não há evidência de resolução dos travamentos.
Capturas anteriores da entrada HEVC já tinham intervalos de 400–494 ms; UDP e TLS
apresentam pausas. TURN não é causa exclusiva demonstrada. O SRS local da IB não
transporta esse fluxo; não substituir sua versão/configuração às cegas.

Correção dessa origem depende de identificar/acessar `160.19.47.74:45554` para
medir proxy/TCP/timestamps/buffers e aplicar mudança fundamentada. Não reutilizar
credenciais dos outros hosts por suposição. Não ampliar FPS para ocultar pausas.

## Reprodução e rollback

Ferramentas: `validate-short-motion.py`, `bench-live-decoder.py`,
`validate-web-navigation.py`, `validate-isolated-recovery.py`,
`validate-synthetic-latency.py`, `probe-video-browser.py` e
`measure-motion-pipeline.py`. Laboratórios removem somente containers com seu
identificador/label e conteúdo sintético em tmpfs. Senhas/JWT/URLs autenticadas
não são gravados em arquivos, logs, scripts, commits ou argumentos.

O helper de diagnóstico existente recebeu o init já fornecido pelo Docker,
sem instalar pacotes. Seu restart removeu apenas zombies dos ensaios; nenhum
serviço de cliente foi reiniciado para isso. Preparação reproduzível:

```sh
docker cp /usr/libexec/docker/docker-init drac-operational-browser:/usr/local/bin/drac-validation-init
```

Wrappers executam Node sob esse init/subreaper e encerram somente seu Chromium.
Probe real após ajuste confirmou zero zombies. Não recriar o helper a partir da
imagem base sem suas dependências de diagnóstico já existentes.

Rollback não executado: imagens anteriores preservadas — IA
`drac-pipeline-ai:20261002-deadline`, web `drac-pipeline-web:20261001`, API
`drac-pipeline-api:20261001`. Vibe: alterar somente esses campos no overlay,
preservando demais variáveis, e executar compose com os quatro arquivos existentes,
`up -d --timeout 30 --no-deps --no-build api ai-service web`. IB: retirar somente
`docker-compose.motion-fixes.yml` da composição de seis arquivos, manter overlays
pipeline/deadline, restaurar `DRAC_VERSION=9a44dfe` e executar o mesmo alvo.
Sem rollback de banco, alteração de planos, modo de câmera ou remoção de gravações.
