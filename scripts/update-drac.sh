#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="${DRAC_ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="${DRAC_ENV_FILE:-$ROOT_DIR/infra/.env}"
BRANCH="${DRAC_UPDATE_BRANCH:-main}"
COMPOSE_MODE="${DRAC_COMPOSE_MODE:-prod}"
POSTGRES_CONTAINER="${DRAC_POSTGRES_CONTAINER:-vms-postgres}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$ROOT_DIR/infra/backups/update-$STAMP"
case "$COMPOSE_MODE" in
  prod) COMPOSE_OVERRIDE="$ROOT_DIR/infra/docker-compose.prod.yml" ;;
  dev) COMPOSE_OVERRIDE="$ROOT_DIR/infra/docker-compose.dev.yml" ;;
  *) printf '[DRAC update][ERRO] DRAC_COMPOSE_MODE deve ser prod ou dev.\n' >&2; exit 1 ;;
esac
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/infra/docker-compose.yml" -f "$COMPOSE_OVERRIDE")

env_value() {
  local name="$1"
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^${name}=//p" "$ENV_FILE" | tail -n1 | sed 's/^"//; s/"$//'
}

env_set() {
  local name="$1"
  local value="$2"
  if grep -qE "^${name}=" "$ENV_FILE"; then
    sed -i -E "s|^${name}=.*|${name}=${value}|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$name" "$value" >> "$ENV_FILE"
  fi
}

# Em instalações com IP próprio, o nginx do host publica o Web em um endereço
# privado específico. A checagem de atualização precisa consultar o mesmo
# endereço configurado no compose, em vez de supor que a porta está no loopback.
web_health_url() {
  local bind
  bind="$(env_value DRAC_WEB_BIND)"
  case "$bind" in
    ''|0.0.0.0|127.0.0.1) printf '%s\n' 'http://127.0.0.1:5173/' ;;
    *) printf 'http://%s:5173/\n' "$bind" ;;
  esac
}

# A Central é um produto da VM Management, não um serviço de cada tenant.
# `docker compose up drac-central` ativa o serviço mesmo quando ele possui
# `profiles: [central]`; por isso a lista precisa ser decidida antes e nunca
# mencionar a Central numa instalação comum.
APP_SERVICES=(api web)
COMPOSE_PROFILES_VALUE="$(env_value COMPOSE_PROFILES)"
if [ "$(env_value DRAC_UPDATE_INCLUDE_CENTRAL)" = "true" ] \
  || [[ ",$COMPOSE_PROFILES_VALUE," = *,central,* ]]; then
  COMPOSE+=(--profile central)
  APP_SERVICES+=(drac-central)
fi

# Não permita que uma atualização remova o TURN de uma instalação atrás da
# Gateway. Sem este overlay a sinalização WHEP continua em 201, porém o ICE
# oferece apenas o IP privado e todo viewer termina em fallback HLS.
if [ "$(env_value DRAC_GATEWAY_MODE)" = "true" ] || [ -n "$(env_value MEDIAMTX_TURN_URL)" ]; then
  [ -f "$ROOT_DIR/infra/docker-compose.gateway.yml" ] || {
    printf '[DRAC update][ERRO] Instalação Gateway sem docker-compose.gateway.yml; atualização recusada.\n' >&2
    exit 1
  }
  COMPOSE+=(-f "$ROOT_DIR/infra/docker-compose.gateway.yml")
fi

# A GPU PRECISA SOBREVIVER A UMA ATUALIZAÇÃO.
#
# Até 27/08/2026 este script montava o compose SEM os overlays de GPU. Efeito:
# quem subisse a instalação com aceleração pelo `drac-up.sh` e depois rodasse
# uma atualização perdia a GPU em silêncio — os containers voltavam sem o
# runtime nvidia, o vídeo voltava a converter em processador, e nada no log
# dizia que a placa havia sido descartada.
#
# A regra é a mesma do `drac-up.sh`: a presença da GPU é condição de AMBIENTE.
# Aqui só reaproveitamos a decisão dele, sem duplicar a detecção — se o overlay
# está em uso AGORA, ele continua em uso depois.
if docker inspect vms-mediamtx --format '{{.HostConfig.Runtime}}' 2>/dev/null | grep -q nvidia; then
  if [ -f "$ROOT_DIR/infra/docker-compose.gpu.yml" ]; then
    COMPOSE+=(-f "$ROOT_DIR/infra/docker-compose.gpu.yml")
    printf '[DRAC update] GPU detectada em uso: mantendo o overlay de transcode acelerado.\n'
  fi
fi
if docker inspect vms-ai-service --format '{{.HostConfig.Runtime}}' 2>/dev/null | grep -q nvidia; then
  if [ -f "$ROOT_DIR/infra/docker-compose.gpu-ai.yml" ]; then
    COMPOSE+=(-f "$ROOT_DIR/infra/docker-compose.gpu-ai.yml")
    printf '[DRAC update] IA em GPU detectada: mantendo o overlay CUDA.\n'
  fi
fi
BEFORE_COMMIT=""
ROLLBACK_NEEDED=false
ROLLBACK_IN_PROGRESS=false
WRITERS_STOPPED=false
DATABASE_MAY_HAVE_CHANGED=false

log() {
  printf '[DRAC update] %s\n' "$*"
}

wait_for_http() {
  local method="$1"
  local url="$2"
  local label="$3"
  local attempts="${4:-30}"
  local attempt
  for attempt in $(seq 1 "$attempts"); do
    if [ "$method" = "HEAD" ]; then
      if curl -fsSI --max-time 3 "$url" >/dev/null 2>&1; then
        log "$label respondeu (tentativa $attempt/$attempts)."
        return 0
      fi
    elif curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      log "$label respondeu (tentativa $attempt/$attempts)."
      return 0
    fi
    sleep 2
  done
  printf '[DRAC update][ERRO] %s não respondeu após %s tentativas: %s\n' "$label" "$attempts" "$url" >&2
  return 1
}

fail() {
  printf '[DRAC update][ERRO] %s\n' "$*" >&2
  if ! rollback "falha: $*"; then
    printf '[DRAC update][ERRO] Rollback incompleto; mantenha os serviços parados e use o ponto de segurança: %s\n' "$BACKUP_DIR" >&2
  fi
  exit 1
}

require_file() {
  [ -f "$1" ] || fail "Arquivo obrigatorio nao encontrado: $1"
}

ensure_mediamtx_callback_token() {
  local current=""
  current="$(sed -n 's/^MEDIAMTX_AUTH_CALLBACK_TOKEN=//p' "$ENV_FILE" | tail -n 1)"
  if [[ "$current" =~ ^[a-fA-F0-9]{48,128}$ ]]; then
    return 0
  fi
  if [ -n "$current" ]; then
    fail "MEDIAMTX_AUTH_CALLBACK_TOKEN existe, mas não é hexadecimal ou tem menos de 24 bytes; corrija a configuração sem reutilizar outra credencial."
  fi
  command -v openssl >/dev/null 2>&1 \
    || fail "openssl é obrigatório para gerar MEDIAMTX_AUTH_CALLBACK_TOKEN."
  local generated
  generated="$(openssl rand -hex 24)"
  printf '\nMEDIAMTX_AUTH_CALLBACK_TOKEN=%s\n' "$generated" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  generated=''
  log "Token dedicado do callback MediaMTX criado para esta atualização."
}

rollback() {
  local reason="${1:-erro desconhecido}"
  if [ "$ROLLBACK_NEEDED" != "true" ] || [ "$ROLLBACK_IN_PROGRESS" = "true" ]; then
    return 0
  fi
  ROLLBACK_IN_PROGRESS=true
  trap - ERR
  printf '[DRAC update] Rollback automatico iniciado (%s)\n' "$reason" >&2
  local rollback_status=0
  local quiesced=true

  # Quiesce é obrigatório antes de tocar no banco. Não existe restore seguro
  # enquanto a API pode gravar usando o schema novo.
  if [ "$WRITERS_STOPPED" = "true" ] && ! "${COMPOSE[@]}" stop "${APP_SERVICES[@]}" >/dev/null; then
    printf '[DRAC update][ERRO] Não foi possível parar os serviços da aplicação para rollback.\n' >&2
    rollback_status=1
    quiesced=false
  fi

  if [ -n "$BEFORE_COMMIT" ]; then
    if ! git -C "$ROOT_DIR" reset --hard "$BEFORE_COMMIT" >/dev/null; then
      printf '[DRAC update][ERRO] Não foi possível restaurar o commit anterior.\n' >&2
      rollback_status=1
    fi
  fi

  if [ -f "$BACKUP_DIR/env.snapshot" ]; then
    if ! cp "$BACKUP_DIR/env.snapshot" "$ENV_FILE" || ! chmod 600 "$ENV_FILE"; then
      printf '[DRAC update][ERRO] Não foi possível restaurar o ambiente anterior.\n' >&2
      rollback_status=1
    fi
  fi

  if [ "$DATABASE_MAY_HAVE_CHANGED" = "true" ] && { [ "$quiesced" != "true" ] || [ ! -s "$BACKUP_DIR/postgres-before.dump" ]; }; then
    printf '[DRAC update][ERRO] Banco alterado sem checkpoint utilizável; recuperação manual obrigatória.\n' >&2
    rollback_status=1
  fi
  if [ "$DATABASE_MAY_HAVE_CHANGED" = "true" ] && [ "$quiesced" = "true" ] && [ -s "$BACKUP_DIR/postgres-before.dump" ]; then
    printf '[DRAC update] Restaurando banco do ponto de seguranca\n' >&2
    if ! docker cp "$BACKUP_DIR/postgres-before.dump" "$POSTGRES_CONTAINER:/tmp/drac-update-rollback.dump" >/dev/null; then
      printf '[DRAC update][ERRO] Não foi possível copiar o dump de rollback.\n' >&2
      rollback_status=1
    elif ! docker exec "$POSTGRES_CONTAINER" sh -lc '
      set -eu
      export PGPASSWORD="$POSTGRES_PASSWORD"
      pg_restore --list /tmp/drac-update-rollback.dump >/dev/null
      pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        --clean --if-exists --no-owner --exit-on-error --single-transaction \
        /tmp/drac-update-rollback.dump
      rm -f /tmp/drac-update-rollback.dump
    ' >/dev/null; then
      printf '[DRAC update][ERRO] A restauração transacional do banco falhou.\n' >&2
      rollback_status=1
    fi
  fi

  if [ "$rollback_status" -eq 0 ] && [ "$WRITERS_STOPPED" = "true" ]; then
    if ! "${COMPOSE[@]}" build "${APP_SERVICES[@]}" >/dev/null \
      || ! "${COMPOSE[@]}" up -d "${APP_SERVICES[@]}" >/dev/null \
      || ! wait_for_http GET http://127.0.0.1:3000/health/ready API \
      || ! wait_for_http HEAD "$(web_health_url)" Web; then
      printf '[DRAC update][ERRO] Código anterior restaurado, mas os serviços não validaram.\n' >&2
      rollback_status=1
    fi
  fi
  if [ "$rollback_status" -ne 0 ]; then
    printf '[DRAC update][ERRO] ROLLBACK INCOMPLETO. Ponto de segurança: %s\n' "$BACKUP_DIR" >&2
    return 1
  fi
  printf '[DRAC update] Rollback validado. Ponto de seguranca: %s\n' "$BACKUP_DIR" >&2
  return 0
}

on_error() {
  local status=$?
  local line="${1:-?}"
  if ! rollback "erro na linha $line"; then
    printf '[DRAC update][ERRO] Intervenção manual obrigatória; serviços permanecem parados.\n' >&2
  fi
  exit "$status"
}

trap 'on_error $LINENO' ERR

preflight_recording_duplicates() {
  local result
  result="$(docker exec "$POSTGRES_CONTAINER" sh -lc '
    set -eu
    export PGPASSWORD="$POSTGRES_PASSWORD"
    psql_value() {
      psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -v ON_ERROR_STOP=1 -Atqc "$1"
    }

    if [ "$(psql_value "SELECT to_regclass('\''public._prisma_migrations'\'') IS NOT NULL")" = t ]; then
      applied="$(psql_value "
        SELECT EXISTS (
          SELECT 1 FROM \"_prisma_migrations\"
          WHERE migration_name = '\''20260501042000_recordings_indexes'\''
            AND finished_at IS NOT NULL
            AND rolled_back_at IS NULL
        )
      ")"
      if [ "$applied" = t ]; then
        printf "already_applied\n"
        exit 0
      fi
    fi

    if [ "$(psql_value "SELECT to_regclass('\''public.Recording'\'') IS NOT NULL")" != t ]; then
      printf "clean\n"
      exit 0
    fi

    duplicate_count="$(psql_value "
      SELECT COALESCE(SUM(extra), 0)
      FROM (
        SELECT COUNT(*) - 1 AS extra
        FROM \"Recording\"
        GROUP BY \"filePath\"
        HAVING COUNT(*) > 1
      ) duplicates
    ")"
    if [ "$duplicate_count" = 0 ]; then
      printf "clean\n"
    else
      printf "duplicates:%s\n" "$duplicate_count"
    fi
  ')"
  case "$result" in
    already_applied|clean)
      return 0
      ;;
    duplicates:*)
      fail "Migration recordings_indexes ainda não aplicada e há ${result#duplicates:} metadado(s) duplicado(s). Reconcilie em laboratório a linha canônica e seus relacionamentos; a atualização recusou a deleção arbitrária por ctid."
      ;;
    *)
      fail "Preflight de duplicatas retornou estado inesperado; migrações não serão executadas."
      ;;
  esac
}

require_file "$ENV_FILE"
mkdir -p "$BACKUP_DIR"

if [ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=no)" ]; then
  fail "Repositorio possui alteracoes versionadas locais. Faça commit/stash; rollback não pode descartá-las."
fi
if [ "${DRAC_UPDATE_ALLOW_DIRTY:-false}" != "true" ] && [ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]; then
  fail "Repositorio possui arquivos não versionados. Faça commit/stash ou use DRAC_UPDATE_ALLOW_DIRTY=true."
fi

log "Gerando ponto de seguranca em $BACKUP_DIR"
cp "$ENV_FILE" "$BACKUP_DIR/env.snapshot"
BEFORE_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
printf '%s\n' "$BEFORE_COMMIT" > "$BACKUP_DIR/git-before.txt"
git -C "$ROOT_DIR" status --short > "$BACKUP_DIR/git-status-before.txt"
ensure_mediamtx_callback_token

log "Atualizando codigo pela branch $BRANCH"
ROLLBACK_NEEDED=true
git -C "$ROOT_DIR" fetch origin "$BRANCH"
git -C "$ROOT_DIR" merge --ff-only "origin/$BRANCH"

# O heartbeat envia DRAC_VERSION, não consulta o .git. Vincular a variável ao
# commit efetivamente promovido evita que a Central anuncie uma versão antiga
# depois de um deploy novo. O snapshot do .env acima também torna isto
# reversível pelo rollback.
DEPLOY_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
env_set DRAC_VERSION "$DEPLOY_COMMIT"
chmod 600 "$ENV_FILE"
log "Versão reportada vinculada ao commit ${DEPLOY_COMMIT:0:12}"

log "Construindo aplicação sem alterar os serviços ativos"
"${COMPOSE[@]}" build "${APP_SERVICES[@]}"

log "Verificando duplicatas históricas antes das migrações"
preflight_recording_duplicates

log "Parando aplicação antes das migrações"
WRITERS_STOPPED=true
"${COMPOSE[@]}" stop "${APP_SERVICES[@]}"

log "Gerando checkpoint do banco com writers parados"
docker exec "$POSTGRES_CONTAINER" sh -lc 'set -eu; export PGPASSWORD="$POSTGRES_PASSWORD"; pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BACKUP_DIR/postgres-before.dump"
[ -s "$BACKUP_DIR/postgres-before.dump" ] || fail "Checkpoint do banco ficou vazio"
docker cp "$BACKUP_DIR/postgres-before.dump" "$POSTGRES_CONTAINER:/tmp/drac-update-validate.dump" >/dev/null
docker exec "$POSTGRES_CONTAINER" pg_restore --list /tmp/drac-update-validate.dump >/dev/null
docker exec "$POSTGRES_CONTAINER" rm -f /tmp/drac-update-validate.dump

log "Aplicando migracoes com a aplicação quiescente"
DATABASE_MAY_HAVE_CHANGED=true
"${COMPOSE[@]}" run --rm --no-deps -w /app/apps/api api npx prisma migrate deploy

log "Subindo aplicação atualizada"
"${COMPOSE[@]}" up -d "${APP_SERVICES[@]}"

log "Validando healthchecks"
wait_for_http GET http://127.0.0.1:3000/health/ready API
wait_for_http HEAD "$(web_health_url)" Web

if [ -x "$ROOT_DIR/scripts/production-readiness.sh" ]; then
  log "Executando readiness"
  # O comando precisa estar no lado esquerdo de `||`: com `trap ERR` herdado,
  # apenas usar `set +e` ainda dispara o rollback antes de conseguirmos ler o
  # código 1 ("Atenção"). Só código 2+ representa bloqueio de promoção.
  readiness_status=0
  "$ROOT_DIR/scripts/production-readiness.sh" || readiness_status=$?
  if [ "$readiness_status" -ge 2 ]; then
    fail "Readiness bloqueado apos atualizacao. Backup em $BACKUP_DIR"
  fi
fi

git -C "$ROOT_DIR" rev-parse HEAD > "$BACKUP_DIR/git-after.txt"
ROLLBACK_NEEDED=false
log "Atualizacao concluida. Ponto de seguranca: $BACKUP_DIR"
