# IBTelecom: capacidade da grade ao vivo

Em 29/09/2026, a grade com 24 câmeras exibiu vários tiles em “Conectando…” indefinidamente. O MediaMTX registrou `Live conversion resource budget reached` e `runOnDemand command stopped: timed out`. A configuração efetiva da API tinha `MEDIAMTX_MAX_CONCURRENT_TRANSCODES=10` e `MEDIAMTX_MAX_TRANSCODE_POINTS=10`, insuficiente para abrir a grade inteira quando vários streams H.265 exigem conversão para H.264.

No arquivo `infra/.env` **somente desta instalação**, foram definidos:

```dotenv
MEDIAMTX_MAX_CONCURRENT_TRANSCODES=24
MEDIAMTX_MAX_TRANSCODE_POINTS=64
```

Após recriar apenas a API, os caminhos dinâmicos do MediaMTX foram atualizados. A configuração de um caminho da grade mostrou 24 vagas e 64 pontos; testes diretos simultâneos das câmeras 17–21 retornaram H.264 com sucesso. O backup local do ambiente anterior é `infra/.env.before-grid-capacity-20260929` (não versionado por conter segredos).

Esses valores são específicos da capacidade do host e da frota IBTelecom. Não copiar como padrão para servidores menores: acompanhar CPU, memória, sessões RTSP, `runOnDemand` e FPS com a grade completa aberta. O status “Online” da API não substitui o teste de reprodução da grade.
