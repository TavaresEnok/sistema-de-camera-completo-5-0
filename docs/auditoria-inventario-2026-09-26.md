# Inventário complementar da auditoria

Referência: commit `ff6114d205e9efde67018e03e38f3e21b5e575eb`, 26/09/2026. Ver [relatório e limites de cobertura](auditoria-tecnica-2026-09-26.md).

## Diretórios e pontos de entrada

| Área | Localização | Pontos de referência |
|---|---|---|
| API | `apps/api/src` | `main.ts`, `app.module.ts`, controllers e módulos por domínio |
| Persistência API | `apps/api/prisma` | `schema.prisma`, 64 migrations |
| Interface web | `apps/web/src` | `App.tsx`, `store/authStore.ts`, páginas e componentes |
| Mobile | `apps/mobile` | `App.tsx`, testes e configuração Expo |
| Central | `apps/central` | `src/server.js`, `src/datastore`, `public/index.html` |
| IA | `services/ai-service-python` | `main.py`, `stream_processor.py`, `detectors`, `trackers` |
| Worker legado | `services/camera-worker-go` | `main.go`, `recorder.go`, testes de modo e segredos |
| Infraestrutura | `infra` | `docker-compose.yml`, `management`, RTMP e configurações auxiliares |
| Operação | `scripts` | `update-drac.sh`, `restore-drac.sh`, `production-readiness.sh`, testes |
| CI | `.github/workflows` | `ci.yml` e gates de verificação |

## Models Prisma — 28

Camera, CloudStorage, Recording, ExportedClip, CameraEvent, UserEventReview, AlarmRule, AlarmInstance, User, AuthSession, LiveLayout, PushDevice, NotificationMute, AiSettings, AuditLog, Investigation, InvestigationItem, Site, SiteMapLayout, Area, CameraGroup, CameraPermission, SystemSetting, RolePermission, GroupMessage, Ronda, LiveLayoutShare e RondaShare.

## Superfícies HTTP

A API organiza endpoints em controllers de auth, users, role-permissions, camera-permissions, camera-groups, sites, areas, site-map-layouts, cameras/RTMP discovery, camera-stream, PTZ, recordings, evidence, investigations, review, alarms, notifications, live-layouts, rondas, group-chat, settings, integrity, audit, AI, GPU, cloud-storage, cloud-connector, commercial-policy, observability, metrics e health.

Para resolver método e caminho exatos no commit auditado, cruzar `@Controller` com decorators `@Get`, `@Post`, `@Put`, `@Patch` e `@Delete` de cada controller e o bootstrap. Esta lista é um índice de superfícies, não um inventário OpenAPI expandido de todos os endpoints.

A Central implementa roteamento no próprio `src/server.js`: autenticação, administração de instalações, provisionamento, instalação remota, licenciamento/configuração, heartbeat, cloud e saúde. O serviço de IA expõe handlers FastAPI para análise, detecções, confirmação de movimento, leases de live view, parada e modelos. Endpoints internos exigem avaliação separada dos públicos.

## Processadores de jobs da API

`camera-health-check`, `recording-cleanup`, `recording-export`, `evidence-export`, `thumbnail-generation`, `alarm-notification`, `push-receipts` e `cloud-offload`, em `apps/api/src/jobs/processors`.

## Estado, integrações e armazenamento

- PostgreSQL local: dados operacionais e sessões; PostgreSQL/JSON/dual na Central: estado da frota.
- Redis/BullMQ: filas e agendamento; memória do processo: locks e estados de coordenação que exigem revisão antes de múltiplas réplicas.
- Filesystem: gravações, exports, backups, journal e modelos. S3: offload e playback conforme vínculo de origem.
- MediaMTX, FFmpeg, SRS e coturn: transporte, ingestão, relay e gravação.
- ONVIF/eventos de dispositivos: controle e eventos de câmera. Expo/FCM: notificações móveis. SSH: provisionamento remoto pela Central.
- Web: token de acesso em memória, refresh HttpOnly e polling operacional. Mobile: armazenamento seguro de credenciais, incluindo migração do legado.

## Reprodução segura da revisão

As suites foram executadas em containers descartáveis, com fonte somente leitura. Integrações de banco usaram PostgreSQL temporário exclusivo. Nenhum comando de restore, purge, atualização ou reprodução de falha de concorrência foi apontado para produção. O relatório principal discrimina resultados, falhas de harness e cenários ainda não executados.

Inventário não significa certificação: caminhos legados, todos os endpoints, hardware, outras máquinas e dependências transitivas não foram integralmente validados.
