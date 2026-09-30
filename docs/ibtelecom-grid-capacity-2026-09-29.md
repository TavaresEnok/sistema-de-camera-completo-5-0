# IBTelecom: capacidade da grade ao vivo

Em 29/09/2026, a grade com 24 câmeras exibiu vários tiles em “Conectando…” indefinidamente. O MediaMTX registrou `Live conversion resource budget reached` e `runOnDemand command stopped: timed out`. A configuração efetiva da API tinha `MEDIAMTX_MAX_CONCURRENT_TRANSCODES=10` e `MEDIAMTX_MAX_TRANSCODE_POINTS=10`, insuficiente para abrir a grade inteira quando vários streams H.265 exigem conversão para H.264.

No arquivo `infra/.env` **somente desta instalação**, foram definidos:

```dotenv
MEDIAMTX_MAX_CONCURRENT_TRANSCODES=24
MEDIAMTX_MAX_TRANSCODE_POINTS=64
```

Após recriar apenas a API, os caminhos dinâmicos do MediaMTX foram atualizados. A configuração de um caminho da grade mostrou 24 vagas e 64 pontos. Um teste de abertura simultânea das 24 câmeras Grupo Flash retornou **24/24 streams H.264**, sem nova rejeição por orçamento. Durante o teste, o container MediaMTX chegou a aproximadamente 561% de CPU e 629 MiB de memória. O backup local do ambiente anterior é `infra/.env.before-grid-capacity-20260929` (não versionado por conter segredos).

Esses valores são específicos da capacidade do host e da frota IBTelecom. Não copiar como padrão para servidores menores: acompanhar CPU, memória, sessões RTSP, `runOnDemand` e FPS com a grade completa aberta. O status “Online” da API não substitui o teste de reprodução da grade.

## Evolução em 30/09/2026: grade 6×6 e várias telas

O teto fixo acima foi substituído por admissão adaptativa. Na IBTelecom, que expõe 30 CPUs e cerca de 20 GB de memória aos containers, os tetos operacionais foram elevados para 90 processos e 90 pontos. Eles não representam uma autorização para consumir o host sem controle: antes de iniciar uma conversão nova, a API agora considera processos já ativos, custo do codec, reservas simultâneas, carga de CPU e memória disponível. O próprio comando `runOnDemand` repete a proteção imediatamente antes de iniciar o FFmpeg, fechando a janela entre pedidos concorrentes.

Leitores da mesma câmera — inclusive três monitores ou várias abas — reutilizam o mesmo caminho e a mesma conversão. Câmeras diferentes são admitidas até o orçamento seguro. Quando o host se aproxima de 75% de carga útil ou da reserva mínima de memória, novas câmeras recebem uma resposta explícita de capacidade e a interface mostra **“Visualização em espera”**, com nova tentativa espaçada; elas não permanecem em “Conectando…” nem iniciam uma tempestade de tentativas.

A configuração anterior foi preservada em `infra/.env.before-adaptive-grid-20260930`, e as imagens anteriores de API e web receberam tags locais de rollback. A implantação do commit `7da07cd` terminou com API e web saudáveis, zero reinicializações e limites efetivos `90/90`.
