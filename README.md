# DRAC VMS

> **Repositório principal desde 26/09/2026:**
> [`TavaresEnok/sistema-de-camera-completo-5-0`](https://github.com/TavaresEnok/sistema-de-camera-completo-5-0)
>
> Os repositórios anteriores são arquivos históricos e **não recebem mais
> desenvolvimento**. Todo desenvolvimento, instalação e atualização deve usar
> este repositório, preservando o histórico Git do projeto.
>
> Toda instalação nova, o instalador e a Central usam este endereço. Instalações
> antigas que ainda tenham o remoto anterior devem ser apontadas para este antes
> de receber novas atualizações.

DRAC VMS e um VMS/NVR on-premise para monitoramento, gravacao, playback, IA e operacao de cameras IP. O projeto e mantido como monorepo e combina frontend web, API, app mobile, PostgreSQL, Redis, MediaMTX, worker Go opcional e servico Python de IA/OpenVINO.

## Estado Atual

O produto ja inclui:

- Frontend React/Vite com live view, grid/mural, playback, eventos, alarmes, mapa/planta baixa, PTZ, usuarios, permissoes, auditoria, evidencias e IA.
- API NestJS com dominios separados para cameras, streaming, gravacoes, auth, usuarios, auditoria, alarmes, investigacoes, mapa, PTZ e IA.
- PostgreSQL via Prisma, Redis/BullMQ e migrations versionadas.
- MediaMTX para RTSP/HLS/WebRTC e transcode quando necessario.
- IA Python/FastAPI com OpenVINO, detecoes, tracking, snapshots de overlay e perfis de runtime.
- App mobile Expo/React Native em `apps/mobile`.
- Worker Go opcional em `services/camera-worker-go`.

O projeto ainda exige hardening antes de producao ampla: HTTPS/reverse proxy, firewall, segredos fortes, backups testados, observabilidade, retencao validada e revisao de exposicao de portas.

## Stack

- API: NestJS + TypeScript
- Web: React + Vite + TypeScript
- Mobile: Expo/React Native
- Banco: PostgreSQL
- ORM: Prisma
- Cache/fila: Redis + BullMQ
- Streaming: MediaMTX + FFmpeg
- IA: Python + FastAPI + OpenVINO
- Worker opcional: Go
- Monorepo: pnpm workspaces

## Estrutura

```text
apps/
  api/       API NestJS
  web/       frontend web
  mobile/    aplicativo Expo/React Native
services/
  ai-service-python/
  camera-worker-go/
infra/
  docker-compose.yml
  mediamtx.yml
docs/
legacy/
```

## Instalacao Local

```bash
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install
cp infra/.env.dev.example infra/.env
```

Edite `infra/.env` antes de subir o ambiente. Use segredos fortes para `JWT_SECRET`, `CAMERA_SECRET_KEY`, `INTERNAL_SERVICE_TOKEN`, `EVIDENCE_HMAC_SECRET`, senhas do banco e credenciais do MediaMTX.

```bash
docker compose --env-file infra/.env -f infra/docker-compose.yml -f infra/docker-compose.dev.yml up -d --build
docker compose --env-file infra/.env -f infra/docker-compose.yml -f infra/docker-compose.dev.yml exec -w /app/apps/api api npx prisma migrate deploy
```

Health checks basicos:

```bash
curl http://localhost:3000/health
curl -I http://localhost:5173/live
```

## Cameras e Perfis

O DRAC separa os perfis de camera para reduzir acoplamento entre gravacao, live e IA:

- Gravacao: `recordingChannel`/`recordingSubtype`, normalmente main stream em H.265 direto para economizar disco e CPU.
- Live: `liveChannel`/`liveSubtype`, normalmente main stream para alta qualidade; se vier H.265, MediaMTX/FFmpeg entrega H.264/WebRTC quando necessario para navegador.
- Analytics/IA: `analyticsChannel`/`analyticsSubtype`, preferencialmente substream leve direto da camera, sem audio e independente da live.

O assistente de camera tenta detectar portas, rotas, codecs, resolucoes e perfis automaticamente. Campos tecnicos como caminho RTSP, caminho ONVIF e token ONVIF devem ficar internos sempre que possivel.

## WebRTC

A live WebRTC e entregue pelo MediaMTX. Em termos praticos:

- O navegador recebe H.264 via WebRTC.
- Quando a origem ja e H.264 compativel, o sistema evita reencode.
- Quando a origem e H.265/HEVC, o sistema pode transcodificar para H.264 para compatibilidade com navegador.
- Audio de live pode ser entregue como Opus quando habilitado e suportado no pipeline.

## IA e Overlay

O servico de IA roda separado da API. A API deve manter o `ai-service` online porque a interface consulta endpoints de status, live-view lease e snapshots, mesmo quando a analise global esta desativada.

Principios atuais:

- IA usa preferencialmente RTSP direto da camera pelo `analyticsSubtype`.
- `latest-frame-only` evita fila longa e reduz atraso.
- Overlay visual e evento de banco sao conceitos separados.
- O frontend busca snapshots recentes e descarta deteccoes antigas por `maxAge`.
- Perfis de grid e camera selecionada podem ter FPS/resolucao diferentes.

## Seguranca

Recomendacoes minimas para producao:

- Colocar API, Web e MediaMTX atras de reverse proxy com HTTPS.
- Expor publicamente somente as portas indispensaveis.
- Restringir API do MediaMTX a rede interna.
- Manter `CAMERA_TEST_ALLOW_PUBLIC_IP=false`, salvo em ambiente controlado.
- Configurar `CORS_ALLOWED_ORIGINS` apenas com dominios reais do frontend.
- Usar segredos fortes e nao versionar `.env` reais.
- Proteger storage de gravacoes e backups.
- Monitorar logs, disco, CPU, processos FFmpeg e conexoes WebRTC.
- Evitar montar `/var/run/docker.sock` em containers de aplicacao.

## Variaveis Importantes

- `CORS_ALLOWED_ORIGINS`: origens autorizadas do frontend.
- `MEDIAMTX_API_USER` / `MEDIAMTX_API_PASS`: credenciais da API interna do MediaMTX.
- `MEDIAMTX_HLS_ALLOW_ORIGIN` / `MEDIAMTX_WEBRTC_ALLOW_ORIGIN`: origem permitida para HLS/WebRTC.
- `INTERNAL_SERVICE_TOKEN`: autenticacao entre API, IA e servicos internos.
- `AI_AUTO_START_ENABLED`: sincronizacao automatica da IA ao iniciar API.
- `AI_USE_MEDIAMTX`: preferencia por MediaMTX como fonte da IA; padrao atual e `false`.
- `AI_RTSP_SUBTYPE`: override opcional do subtipo analytics.
- `RECORDING_RETENTION_DAYS`: retencao de gravacoes.
- `STREAM_TOKEN_EXPIRES_IN`: validade de tokens temporarios de live/playback.

## Scripts

```bash
pnpm dev:api
pnpm dev:web
pnpm docker:dev
pnpm docker:prod
pnpm docker:down
pnpm --filter mobile start:lan
pnpm verify
DRAC_E2E=1 DRAC_E2E_BASE_URL=http://127.0.0.1:3000 DRAC_E2E_EMAIL=admin@local.dev DRAC_E2E_PASSWORD=... pnpm test:e2e
pnpm db:migrate
```

`pnpm verify` roda testes criticos, testes mobile e builds/typechecks definidos no monorepo.
O `test:e2e` e opt-in e pode testar stream token, gravacao e playback quando `DRAC_E2E_CAMERA_ID`, `DRAC_E2E_RECORDING_MUTATION=1` e `DRAC_E2E_RECORDING_ID` forem definidos.

## Endpoints Principais

- `POST /auth/login`
- `GET /auth/me`
- `GET /health`
- `GET /health/operational-readiness`
- `GET /cameras`
- `POST /cameras`
- `POST /cameras/:id/test-connection`
- `POST /camera-stream/:cameraId/token`
- `GET /camera-stream/:cameraId/urls`
- `POST /cameras/:cameraId/recording/start`
- `POST /cameras/:cameraId/recording/stop`
- `GET /recordings`
- `POST /recordings/:id/play-token`
- `POST /ptz/:cameraId/move`
- `GET /ai/settings`
- `PATCH /ai/settings`
- `GET /ai/detections/latest/:cameraId`
- `GET /sites/:siteId/map-layouts`

## Producao

O lancamento inicial recomendado usa `DRAC_LAUNCH_PROFILE=standard`: live WebRTC, cameras,
usuarios, alertas, playback, Central, backup e operacao local. Nesse perfil, IA e gravacao
continua sao opcionais e podem ser habilitadas depois por administrador.

Antes de colocar em operacao real, siga um checklist de producao:

1. HTTPS e reverse proxy.
2. Firewall com portas minimas.
3. CORS restrito.
4. Segredos fortes e rotacao definida.
5. Backup e restore testados.
6. Retencao de gravacoes validada quando gravacao continua for habilitada.
7. Storage dedicado e monitorado.
8. MediaMTX protegido.
9. Health checks e alertas.
10. Teste e2e: login, cadastro de camera, RTSP, live, gravacao opcional, playback e Central.

Arquivos recomendados:

- `infra/.env.prod.example`: template de variaveis para producao.
- `infra/docker-compose.prod.yml`: binds mais restritos e configuraveis.
- `infra/reverse-proxy.nginx.example`: exemplo de Nginx com HTTPS, `/api` e sinalizacao WebRTC.
- `docs/security-hardening.md`: guia de hardening, portas, MediaMTX, HTTPS/WebRTC e retencao.
- `docs/clean-install.md`: roteiro de instalacao limpa do zero.
- `docs/standard-launch-operations.md`: perfil standard, update, restore e diagnostico.

Exemplo de deploy controlado:

```bash
cp infra/.env.prod.example infra/.env
# edite dominios, IPs, segredos e MEDIAMTX_WEBRTC_ADDITIONAL_HOST
# para proxy HTTPS no mesmo dominio, construa o web com VITE_API_URL=/api
docker compose --env-file infra/.env -f infra/docker-compose.yml -f infra/docker-compose.prod.yml up -d --build
docker compose --env-file infra/.env -f infra/docker-compose.yml exec -w /app/apps/api api npx prisma migrate deploy
```

## Referencias Internas

- Guia de migracao: `docs/migracao-nova-vm.md`
- Checklist de producao: `docs/production-readiness-checklist.md`
- Operacao standard: `docs/standard-launch-operations.md`
- App mobile: `apps/mobile/README.md`
- Worker Go: `services/camera-worker-go/README.md`
