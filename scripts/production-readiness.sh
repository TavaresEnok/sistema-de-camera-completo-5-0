#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="${DRAC_ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="${DRAC_ENV_FILE:-$ROOT_DIR/infra/.env}"
OUTPUT_MODE="${1:-text}"

WARNINGS=0
FAILURES=0
CHECKS=0

RED='\033[1;31m'
YELLOW='\033[1;33m'
GREEN='\033[1;32m'
CYAN='\033[1;36m'
NC='\033[0m'

log() {
  printf "${CYAN}[DRAC readiness]${NC} %s\n" "$*"
}

ok() {
  CHECKS=$((CHECKS + 1))
  printf "${GREEN}[OK]${NC} %s\n" "$*"
}

warn() {
  CHECKS=$((CHECKS + 1))
  WARNINGS=$((WARNINGS + 1))
  printf "${YELLOW}[ATENCAO]${NC} %s\n" "$*"
}

fail() {
  CHECKS=$((CHECKS + 1))
  FAILURES=$((FAILURES + 1))
  printf "${RED}[BLOQUEADO]${NC} %s\n" "$*"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

load_env() {
  if [ ! -f "$ENV_FILE" ]; then
    fail "Arquivo infra/.env nao encontrado em $ENV_FILE"
    return
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ''|\#*) continue ;;
    esac
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local value="${BASH_REMATCH[2]}"
      if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
        value="${BASH_REMATCH[1]}"
      fi
      export "$key=$value"
    fi
  done < "$ENV_FILE"
  ok "infra/.env encontrado"

  local perms
  perms="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || true)"
  if [ "$perms" = "600" ] || [ "$perms" = "640" ]; then
    ok "infra/.env com permissao restrita ($perms)"
  else
    warn "infra/.env deveria usar chmod 600 ou 640; permissao atual: ${perms:-desconhecida}"
  fi
}

check_required_commands() {
  for cmd in docker curl awk sed grep date; do
    if have "$cmd"; then
      ok "Comando disponivel: $cmd"
    else
      fail "Comando ausente: $cmd"
    fi
  done

  if docker compose version >/dev/null 2>&1; then
    ok "Docker Compose plugin disponivel"
  else
    fail "Docker Compose plugin indisponivel"
  fi
}

is_placeholder_secret() {
  local value="$1"
  [ -z "$value" ] && return 0
  printf '%s' "$value" | grep -Eiq 'change_me|replace_with|changeme|password|secret|min_'
}

check_env_security() {
  ok "Perfil de lancamento: $(launch_profile)"

  local required=(
    POSTGRES_PASSWORD
    JWT_SECRET
    CAMERA_SECRET_KEY
    INTERNAL_SERVICE_TOKEN
    EVIDENCE_HMAC_SECRET
    MEDIAMTX_API_USER
    MEDIAMTX_API_PASS
  )

  for key in "${required[@]}"; do
    local value="${!key:-}"
    if is_placeholder_secret "$value"; then
      fail "$key ausente ou ainda com valor placeholder"
    else
      ok "$key configurado"
    fi
  done

  if [ "${CLOUD_CONNECTOR_ENABLED:-false}" = "true" ]; then
    for key in CLOUD_API_URL CLOUD_INSTALLATION_ID CLOUD_LICENSE_KEY CLOUD_CUSTOMER_NAME; do
      if [ -n "${!key:-}" ]; then
        ok "$key configurado para conector central"
      else
        fail "$key obrigatorio quando CLOUD_CONNECTOR_ENABLED=true"
      fi
    done
  else
    warn "CLOUD_CONNECTOR_ENABLED=false; instalacao nao envia heartbeat para a Central"
  fi
}

container_status() {
  docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null || true
}

container_health() {
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null || true
}

check_container() {
  local name="$1"
  local required="${2:-true}"
  local status health
  status="$(container_status "$name")"
  health="$(container_health "$name")"

  if [ -z "$status" ]; then
    if [ "$required" = "true" ]; then
      fail "Container $name nao existe"
    else
      warn "Container opcional $name nao existe"
    fi
    return
  fi

  if [ "$status" != "running" ]; then
    fail "Container $name esta em estado $status"
    return
  fi

  case "$health" in
    healthy)
      ok "Container $name rodando e healthy"
      ;;
    starting)
      warn "Container $name rodando, healthcheck ainda starting"
      ;;
    unhealthy)
      fail "Container $name unhealthy"
      ;;
    none)
      ok "Container $name rodando"
      ;;
    *)
      warn "Container $name rodando com health desconhecido: $health"
      ;;
  esac
}

is_ai_expected() {
  local ai_enabled_count
  ai_enabled_count="$(psql_value 'select count(*) from "Camera" where "aiEnabled" = true;' 2>/dev/null || echo 0)"
  if [ "${AI_AUTO_START_ENABLED:-true}" = "false" ] && [ "${ai_enabled_count:-0}" -eq 0 ]; then
    return 1
  fi
  return 0
}

check_containers() {
  check_container vms-postgres
  check_container vms-redis
  check_container vms-mediamtx
  check_container vms-api
  check_container vms-web
  if is_ai_expected; then
    check_container vms-ai-service
  else
    local ai_status
    ai_status="$(container_status vms-ai-service)"
    if [ "$ai_status" = "running" ]; then
      warn "Container vms-ai-service esta rodando, mas IA foi marcada como desativada"
    else
      ok "IA desativada por configuracao; vms-ai-service nao e obrigatorio neste perfil"
    fi
  fi
  check_container vms-postgres-backup
}

curl_ok() {
  curl -fsS --max-time "${2:-8}" "$1" >/dev/null 2>&1
}

check_http() {
  local name="$1"
  local url="$2"
  if curl_ok "$url" 8; then
    ok "$name respondeu: $url"
  else
    fail "$name nao respondeu: $url"
  fi
}

check_endpoints() {
  check_http "API readiness" "http://127.0.0.1:3000/health/ready"
  local web_bind="${DRAC_WEB_BIND:-127.0.0.1}"
  case "$web_bind" in
    0.0.0.0) web_bind="127.0.0.1" ;;
    ::) web_bind="[::1]" ;;
  esac
  local web_url="http://${web_bind}:5173/"
  check_http "Web local" "$web_url"

  # A porta local 5173 é HTTP puro. Se o próprio frontend mandar o navegador
  # elevar recursos para HTTPS, o HTML responde 200 mas todos os CSS/JS falham
  # com ERR_SSL_PROTOCOL_ERROR. Foi exatamente o falso-verde da instalação da
  # Vibe em 19/08/2026.
  local web_headers
  web_headers="$(curl -fsSI --max-time 8 "$web_url" 2>/dev/null | tr -d '\r' || true)"
  if printf '%s\n' "$web_headers" | grep -qiE '^Content-Security-Policy:.*upgrade-insecure-requests'; then
    fail "Web HTTP força assets para HTTPS; a tela abrirá sem CSS/JavaScript"
  elif printf '%s\n' "$web_headers" | grep -qi '^Strict-Transport-Security:'; then
    fail "Web HTTP emite HSTS; essa política pertence somente ao proxy TLS externo"
  elif [ -n "$web_headers" ]; then
    ok "Web HTTP não anuncia uma política TLS incompatível com a porta 5173"
  fi

  if [ "${CLOUD_CONNECTOR_ENABLED:-false}" = "true" ] && [ -n "${CLOUD_API_URL:-}" ]; then
    if docker exec vms-api node -e 'const base=process.env.CLOUD_API_URL.replace(/\/$/,""); fetch(base+"/api/agent/status",{headers:{"X-DRAC-Installation-Id":process.env.CLOUD_INSTALLATION_ID,"X-DRAC-License-Key":process.env.CLOUD_LICENSE_KEY},signal:AbortSignal.timeout(8000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(2))' >/dev/null 2>&1; then
      # Este é o teste mais forte: prova rede, rota, Central, identidade e
      # licença. Em uma rede segmentada, /api/health pode deliberadamente ser
      # negado ao tenant e isso não significa indisponibilidade.
      ok "DRAC Central acessivel; instalacao reconhecida e autenticada"
    elif docker exec vms-api node -e 'fetch(process.env.CLOUD_API_URL.replace(/\/$/,"")+"/api/health",{signal:AbortSignal.timeout(8000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(2))' >/dev/null 2>&1; then
      warn "Central responde, mas nao confirmou esta instalacao/licenca em /api/agent/status"
    else
      warn "DRAC Central ou rota do agente nao respondeu agora: ${CLOUD_API_URL%/}"
    fi
  fi
}

check_database() {
  local user="${POSTGRES_USER:-vms}"
  local db="${POSTGRES_DB:-vms_db}"
  local pass="${POSTGRES_PASSWORD:-}"

  if docker exec -e PGPASSWORD="$pass" vms-postgres pg_isready -U "$user" -d "$db" >/dev/null 2>&1; then
    ok "Postgres aceitando conexoes"
  else
    fail "Postgres nao respondeu ao pg_isready"
    return
  fi

  if docker exec -e PGPASSWORD="$pass" vms-postgres psql -U "$user" -d "$db" -Atc 'select count(*) from "Camera";' >/dev/null 2>&1; then
    ok "Banco DRAC acessivel e schema principal disponivel"
  else
    fail "Banco DRAC nao permitiu consulta em Camera"
  fi
}

psql_value() {
  local query="$1"
  local user="${POSTGRES_USER:-vms}"
  local db="${POSTGRES_DB:-vms_db}"
  local pass="${POSTGRES_PASSWORD:-}"
  docker exec -e PGPASSWORD="$pass" vms-postgres psql -U "$user" -d "$db" -Atc "$query" 2>/dev/null | head -n 1
}

launch_profile() {
  printf '%s' "${DRAC_LAUNCH_PROFILE:-standard}" | tr '[:upper:]' '[:lower:]'
}

is_standard_launch() {
  [ "$(launch_profile)" = "standard" ]
}

check_recording_capacity() {
  local storage_path="$1"
  local enforce_capacity="${2:-false}"
  local df_line total_kb retention_days safe_capacity_gb hist_line hist_bytes hist_seconds required_gb source

  df_line="$(df -Pk "$storage_path" 2>/dev/null | awk 'NR==2 {print $2}')"
  if [ -z "$df_line" ]; then
    warn "Nao foi possivel calcular capacidade total de storage para gravacao"
    return
  fi

  total_kb="$df_line"
  retention_days="${RECORDING_RETENTION_DAYS:-${RETENTION_DAYS:-7}}"
  safe_capacity_gb="$(awk -v kb="$total_kb" 'BEGIN { printf "%.1f", (kb * 1024 * 0.80) / 1024 / 1024 / 1024 }')"

  if [ "$enforce_capacity" = "true" ]; then
    # Dimensiona somente o que está de fato configurado como contínuo. A flag
    # de auto-start não transforma câmeras manuais/movimento em contínuas.
    hist_line="$(psql_value 'select coalesce(sum(r."sizeBytes"),0)::text || '\''|'\'' || coalesce(extract(epoch from (max(r."startedAt") - min(r."startedAt"))),0)::text from "Recording" r join "Camera" c on c.id = r."cameraId" where c.enabled = true and c."recordingMode" = '\''continuous'\'';')"
  else
    hist_line="$(psql_value 'select coalesce(sum("sizeBytes"),0)::text || '\''|'\'' || coalesce(extract(epoch from (max("startedAt") - min("startedAt"))),0)::text from "Recording";')"
  fi
  IFS='|' read -r hist_bytes hist_seconds <<< "$hist_line"

  if awk -v bytes="${hist_bytes:-0}" -v seconds="${hist_seconds:-0}" 'BEGIN { exit !(bytes > 0 && seconds >= 900) }'; then
    required_gb="$(awk -v bytes="$hist_bytes" -v seconds="$hist_seconds" -v days="$retention_days" 'BEGIN { printf "%.1f", ((bytes / seconds) * 86400 * days) / 1024 / 1024 / 1024 }')"
    source="historico real de gravacao"
  else
    local bitrate_line known_kbps known_count total_cameras fallback_kbps estimated_kbps
    if [ "$enforce_capacity" = "true" ]; then
      bitrate_line="$(psql_value 'select coalesce(sum(coalesce("recordingBitrateKbps",0)),0)::text || '\''|'\'' || count(*) filter (where coalesce("recordingBitrateKbps",0) > 0)::text || '\''|'\'' || count(*)::text from "Camera" where enabled = true and "recordingMode" = '\''continuous'\'';')"
    else
      bitrate_line="$(psql_value 'select coalesce(sum(coalesce("recordingBitrateKbps",0)),0)::text || '\''|'\'' || count(*) filter (where coalesce("recordingBitrateKbps",0) > 0)::text || '\''|'\'' || count(*)::text from "Camera";')"
    fi
    IFS='|' read -r known_kbps known_count total_cameras <<< "$bitrate_line"
    fallback_kbps="${RECORDING_CAPACITY_FALLBACK_CAMERA_KBPS:-4096}"
    estimated_kbps="$(awk -v known="${known_kbps:-0}" -v known_count="${known_count:-0}" -v total="${total_cameras:-0}" -v fallback="$fallback_kbps" 'BEGIN { missing = total - known_count; if (missing < 0) missing = 0; printf "%.0f", known + (missing * fallback) }')"
    required_gb="$(awk -v kbps="$estimated_kbps" -v days="$retention_days" 'BEGIN { printf "%.1f", ((kbps * 1000 / 8) * 86400 * days) / 1024 / 1024 / 1024 }')"
    source="bitrate configurado/fallback ${fallback_kbps}kbps"
  fi

  if [ "$enforce_capacity" != "true" ]; then
    if awk -v required="$required_gb" -v safe="$safe_capacity_gb" 'BEGIN { exit !(required > safe) }'; then
      if is_standard_launch; then
        ok "Storage atual nao comportaria retencao continua de ${retention_days}d, mas gravacao continua e opcional no perfil standard: estimado ${required_gb}GB (${source}), capacidade segura ${safe_capacity_gb}GB"
      else
        warn "Storage atual nao comportaria retencao continua de ${retention_days}d: estimado ${required_gb}GB (${source}), capacidade segura ${safe_capacity_gb}GB"
      fi
    elif awk -v required="$required_gb" -v safe="$safe_capacity_gb" 'BEGIN { exit !(required > safe * 0.70) }'; then
      if is_standard_launch; then
        ok "Storage apertado para gravacao continua futura, mas perfil standard nao exige continua: estimado ${required_gb}GB (${source}), capacidade segura ${safe_capacity_gb}GB"
      else
        warn "Storage apertado caso gravacao continua seja habilitada: estimado ${required_gb}GB (${source}), capacidade segura ${safe_capacity_gb}GB"
      fi
    else
      ok "Storage comporta retencao de ${retention_days}d caso gravacao continua seja habilitada: estimado ${required_gb}GB (${source}), capacidade segura ${safe_capacity_gb}GB"
    fi
    return
  fi

  if awk -v required="$required_gb" -v safe="$safe_capacity_gb" 'BEGIN { exit !(required > safe) }'; then
    fail "Storage insuficiente para retencao de ${retention_days}d: estimado ${required_gb}GB (${source}), capacidade segura ${safe_capacity_gb}GB"
  elif awk -v required="$required_gb" -v safe="$safe_capacity_gb" 'BEGIN { exit !(required > safe * 0.70) }'; then
    warn "Storage apertado para retencao de ${retention_days}d: estimado ${required_gb}GB (${source}), capacidade segura ${safe_capacity_gb}GB"
  else
    ok "Storage dimensionado para retencao de ${retention_days}d: estimado ${required_gb}GB (${source}), capacidade segura ${safe_capacity_gb}GB"
  fi
}

check_camera_profiles() {
  local total active_total online live_webrtc live_subtype0 live_720p recording_enabled recording_continuous recording_subtype0 recording_original ai_enabled analytics_subtype_set
  total="$(psql_value 'select count(*) from "Camera";')"
  total="${total:-0}"

  if [ "$total" -eq 0 ]; then
    warn "Nenhuma camera cadastrada; provisionamento ainda nao foi validado"
    return
  fi

  # Câmera desativada permanece no cadastro/histórico, mas deliberadamente não
  # recebe sonda, stream ou IA. Incluí-la no denominador transformava o estado
  # correto "desativada" em falso alerta de câmera offline.
  active_total="$(psql_value 'select count(*) from "Camera" where enabled = true;')"
  active_total="${active_total:-0}"
  online="$(psql_value 'select count(*) from "Camera" where enabled = true and status = '\''ONLINE'\'';')"
  live_webrtc="$(psql_value 'select count(*) from "Camera" where enabled = true and "preferredLiveProtocol" = '\''webrtc'\'';')"
  live_subtype0="$(psql_value 'select count(*) from "Camera" where enabled = true and coalesce("liveSubtype", subtype) = 0;')"
  live_720p="$(psql_value 'select count(*) from "Camera" where enabled = true and "streamWidth" = 1280 and "streamHeight" = 720;')"
  recording_enabled="$(psql_value 'select count(*) from "Camera" where enabled = true and "recordingMode" in ('\''continuous'\'','\''motion'\'','\''object'\'');')"
  recording_continuous="$(psql_value 'select count(*) from "Camera" where enabled = true and "recordingMode" = '\''continuous'\'';')"
  recording_subtype0="$(psql_value 'select count(*) from "Camera" where enabled = true and coalesce("recordingSubtype", subtype) = 0;')"
  recording_original="$(psql_value 'select count(*) from "Camera" where enabled = true and lower(coalesce("recordingVideoCodec", '\''original'\'')) = '\''original'\'';')"
  ai_enabled="$(psql_value 'select count(*) from "Camera" where enabled = true and "aiEnabled" = true;')"
  analytics_subtype_set="$(psql_value 'select count(*) from "Camera" where enabled = true and "analyticsSubtype" is not null;')"

  if [ "$active_total" -eq 0 ]; then
    warn "Todas as $total cameras cadastradas estao desativadas"
  elif [ "${online:-0}" -eq "$active_total" ]; then
    ok "Todas as cameras ativas estao online ($online/$active_total; $((total - active_total)) desativadas)"
  else
    warn "Cameras ativas online: ${online:-0}/$active_total ($((total - active_total)) desativadas)"
  fi

  if [ "${live_webrtc:-0}" -eq "$active_total" ]; then
    ok "Todas as cameras ativas usam WebRTC como protocolo live"
  else
    fail "Nem todas as cameras ativas usam WebRTC (${live_webrtc:-0}/$active_total)"
  fi

  if [ "${live_subtype0:-0}" -eq "$active_total" ]; then
    ok "Todas as cameras ativas usam liveSubtype/main stream para live"
  else
    warn "Algumas cameras ativas nao usam main stream na live (${live_subtype0:-0}/$active_total)"
  fi

  # Resolução é capacidade/perfil do equipamento, não requisito de saúde. Forçar
  # 720p em toda a frota pode inclusive criar transcode desnecessário na grade.
  ok "Perfil 1280x720 detectado em ${live_720p:-0}/$active_total cameras ativas; demais preservam o perfil próprio"

  if [ "${recording_enabled:-0}" -eq 0 ]; then
    if is_standard_launch; then
      ok "Gravacao continua nao e obrigatoria no perfil standard; administrador pode ativar manual, movimento ou continua por camera"
    else
      warn "Nenhuma camera esta com gravacao habilitada; o administrador pode ativar continua, movimento ou manual conforme o contrato"
    fi
  elif [ "$recording_enabled" -eq "$total" ]; then
    ok "Todas as cameras estao com gravacao habilitada (${recording_continuous:-0} em modo continuo)"
  else
    warn "Gravacao habilitada parcialmente (${recording_enabled:-0}/$total; ${recording_continuous:-0} em modo continuo)"
  fi

  if [ "${recording_subtype0:-0}" -eq "$active_total" ]; then
    ok "Todas as cameras ativas usam main stream para gravacao"
  else
    fail "Nem todas as cameras ativas usam main stream para gravacao (${recording_subtype0:-0}/$active_total)"
  fi

  if [ "${recording_original:-0}" -eq "$active_total" ]; then
    ok "Todas as cameras ativas preservam o codec original na gravacao"
  else
    warn "Algumas cameras ativas forcam transcode na gravacao ($((active_total - recording_original))/$active_total)"
  fi

  ok "Perfil analitico dedicado em ${analytics_subtype_set:-0}/$active_total cameras ativas; demais usam fallback automatico"

  if [ "${ai_enabled:-0}" -eq 0 ]; then
    if [ "${AI_AUTO_START_ENABLED:-true}" = "false" ]; then
      ok "IA desabilitada em todas as cameras por configuracao deste perfil"
    else
      warn "IA esta desabilitada em todas as cameras"
    fi
  elif [ "$ai_enabled" -eq "$active_total" ]; then
    ok "IA habilitada em todas as cameras ativas"
  else
    ok "IA habilitada seletivamente conforme politica (${ai_enabled:-0}/$active_total cameras ativas)"
  fi
}

check_redis() {
  if docker exec vms-redis redis-cli ping 2>/dev/null | grep -q PONG; then
    ok "Redis respondeu PONG"
  else
    fail "Redis nao respondeu PONG"
  fi
}

check_ai_service() {
  if ! is_ai_expected; then
    ok "Health da IA ignorado porque IA esta desativada neste perfil"
    return
  fi

  if docker exec vms-ai-service sh -lc "python - <<'PY'
import urllib.request
urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5).read()
PY" >/dev/null 2>&1; then
    ok "AI service respondeu /health internamente"
  else
    warn "AI service nao respondeu /health internamente; validar logs do vms-ai-service"
  fi
}

check_mediamtx() {
  if docker exec vms-api node -e 'const u=process.env.MEDIAMTX_API_USER,p=process.env.MEDIAMTX_API_PASS; fetch("http://mediamtx:9997/v3/config/global/get",{headers:{authorization:"Basic "+Buffer.from(u+":"+p).toString("base64")},signal:AbortSignal.timeout(8000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(2))' >/dev/null 2>&1; then
    ok "MediaMTX API respondeu pela rede interna"
  else
    warn "MediaMTX API nao respondeu pela rede interna; validar credenciais/health"
  fi
}

check_storage_and_backups() {
  local storage_path="$ROOT_DIR/infra/storage"
  [ -d "$storage_path" ] || storage_path="$ROOT_DIR/infra"

  local usage
  usage="$(df -P "$storage_path" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')"
  if [ -z "$usage" ]; then
    warn "Nao foi possivel medir uso de disco em $storage_path"
  elif [ "$usage" -ge 85 ]; then
    fail "Disco critico: ${usage}% usado"
  elif [ "$usage" -ge 75 ]; then
    warn "Disco em atencao: ${usage}% usado"
  else
    ok "Disco saudavel: ${usage}% usado"
  fi

  local continuous_count enforce_capacity
  continuous_count="$(psql_value 'select count(*) from "Camera" where enabled = true and "recordingMode" = '\''continuous'\'';')"

  if [ "${RECORDING_AUTO_START_ENABLED:-false}" = "true" ] && [ "${continuous_count:-0}" -gt 0 ] && [ "${usage:-100}" -ge 75 ]; then
    fail "RECORDING_AUTO_START_ENABLED=true com disco acima de 75%; risco de esgotar storage no boot"
  elif [ "${RECORDING_AUTO_START_ENABLED:-false}" = "true" ] && [ "${continuous_count:-0}" -gt 0 ]; then
    warn "Gravacao continua inicia automaticamente no boot; use apenas com storage dimensionado"
  elif [ "${RECORDING_AUTO_START_ENABLED:-false}" = "true" ]; then
    ok "Auto-start habilitado, mas nenhuma camera esta configurada em modo continuo"
  else
    ok "Auto-start de gravacao continua desativado por padrao seguro"
  fi

  if [ "${RECORDING_DISK_GUARD_ENABLED:-true}" = "true" ]; then
    ok "Guarda de disco das gravacoes habilitada"
  else
    fail "RECORDING_DISK_GUARD_ENABLED=false; producao fica sem protecao contra disco cheio"
  fi

  enforce_capacity="false"
  if [ "${continuous_count:-0}" -gt 0 ]; then
    enforce_capacity="true"
  fi
  check_recording_capacity "$storage_path" "$enforce_capacity"

  local backup_dir="$ROOT_DIR/infra/backups/postgres"
  local latest=""
  if [ -d "$backup_dir" ]; then
    latest="$(find "$backup_dir" -type f -name 'drac-postgres-*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -nr | awk 'NR==1 {print $2}')"
  fi

  if [ -z "$latest" ]; then
    warn "Nenhum backup Postgres encontrado em $backup_dir"
    return
  fi

  local now mtime age_hours
  now="$(date +%s)"
  mtime="$(stat -c '%Y' "$latest" 2>/dev/null || echo 0)"
  age_hours=$(( (now - mtime) / 3600 ))

  if [ "$age_hours" -le 36 ]; then
    ok "Backup Postgres recente encontrado (${age_hours}h): $(basename "$latest")"
  else
    warn "Backup Postgres antigo (${age_hours}h): $(basename "$latest")"
  fi
}

check_exposure() {
  if docker ps --format '{{.Names}} {{.Ports}}' | grep -E 'vms-(postgres|redis).*0\.0\.0\.0:' >/dev/null; then
    fail "Postgres ou Redis exposto em 0.0.0.0"
  else
    ok "Postgres/Redis nao expostos publicamente pelo Docker"
  fi

  if docker inspect vms-api 2>/dev/null | grep -q '/var/run/docker.sock'; then
    fail "API monta /var/run/docker.sock; risco critico de escalada"
  else
    ok "API nao monta Docker socket"
  fi

  if [ "${MEDIAMTX_HLS_ALLOW_ORIGIN:-*}" = "*" ] || [ "${MEDIAMTX_WEBRTC_ALLOW_ORIGIN:-*}" = "*" ]; then
    warn "MediaMTX HLS/WebRTC com allow origin '*'; em producao use dominio HTTPS real"
  else
    ok "MediaMTX com allow origin restrito"
  fi

  if [ -n "${PUBLIC_APP_URL:-}" ] && [ -n "${API_PUBLIC_URL:-}" ]; then
    ok "URLs publicas configuradas para app/API"
    if [[ "${PUBLIC_APP_URL:-}" =~ ^https:// ]] && [[ ! "${API_PUBLIC_URL:-}" =~ ^https:// ]]; then
      fail "PUBLIC_APP_URL usa HTTPS, mas API_PUBLIC_URL nao usa HTTPS"
    fi
  else
    warn "PUBLIC_APP_URL/API_PUBLIC_URL nao configuradas; WebRTC externo depende de host inferido por proxy"
  fi

  if [[ "${PUBLIC_APP_URL:-}" =~ ^https:// ]] && [ "${MEDIAMTX_WEBRTC_ALLOW_ORIGIN:-*}" = "*" ]; then
    warn "Frontend HTTPS com MEDIAMTX_WEBRTC_ALLOW_ORIGIN='*'; restrinja para o dominio real antes de producao publica"
  fi

  if [[ "${PUBLIC_APP_URL:-}" =~ ^https:// ]] && [ -z "${MEDIAMTX_PUBLIC_WEBRTC_URL:-}" ] && [ -z "${MEDIAMTX_PUBLIC_HOST:-}" ]; then
    fail "Frontend HTTPS sem MEDIAMTX_PUBLIC_WEBRTC_URL ou MEDIAMTX_PUBLIC_HOST; WHEP/WebRTC pode retornar host incorreto"
  fi
}

check_runtime_security() {
  local strong_password raw_credentials
  strong_password="$(psql_value 'select coalesce((select value from "SystemSetting" where key = '\''requireStrongPassword'\''), '\''true'\'');')"
  if [ "$strong_password" = "true" ]; then
    ok "Politica de senha forte habilitada"
  else
    fail "Politica de senha forte desabilitada"
  fi

  raw_credentials="$(for name in vms-api vms-ai-service; do docker logs --since 1h "$name" 2>&1 || true; done | grep -Eic 'rtsp(s)?://[^/@[:space:]:]+:[^/@[:space:]]+@' || true)"
  if [ "${raw_credentials:-0}" -eq 0 ]; then
    ok "Logs recentes sem URLs RTSP contendo credenciais"
  else
    fail "Logs recentes contem ${raw_credentials} URL(s) RTSP com credenciais"
  fi

  if [ "${DRAC_BUILD_AGENT_EXPECTED:-false}" != "true" ]; then
    ok "Build do app executado na Central; agente local nao necessario"
  elif curl -fsS --max-time 5 http://172.17.0.1:8780/health >/dev/null 2>&1; then
    ok "Agente de build white-label respondeu no endpoint interno"
  else
    warn "Agente de build white-label nao respondeu no endpoint interno"
  fi
}

check_cloud_settings() {
  [ "${CLOUD_CONNECTOR_ENABLED:-false}" = "true" ] || return

  local user="${POSTGRES_USER:-vms}"
  local db="${POSTGRES_DB:-vms_db}"
  local pass="${POSTGRES_PASSWORD:-}"
  local status last_sync last_error

  status="$(docker exec -e PGPASSWORD="$pass" vms-postgres psql -U "$user" -d "$db" -Atc "select value from \"SystemSetting\" where key='cloud.licenseStatus' limit 1;" 2>/dev/null || true)"
  last_sync="$(docker exec -e PGPASSWORD="$pass" vms-postgres psql -U "$user" -d "$db" -Atc "select value from \"SystemSetting\" where key='cloud.lastSyncAt' limit 1;" 2>/dev/null || true)"
  last_error="$(docker exec -e PGPASSWORD="$pass" vms-postgres psql -U "$user" -d "$db" -Atc "select value from \"SystemSetting\" where key='cloud.lastError' limit 1;" 2>/dev/null || true)"

  if [ -n "$last_sync" ]; then
    ok "Central heartbeat registrado em $last_sync"
  else
    warn "Central heartbeat ainda nao registrado no banco"
  fi

  case "$status" in
    ACTIVE|GRACE)
      ok "Licenca central em estado $status"
      ;;
    RESTRICTED|SUSPENDED)
      fail "Licenca central em estado $status"
      ;;
    *)
      warn "Licenca central em estado ${status:-UNKNOWN}"
      ;;
  esac

  if [ -n "$last_error" ]; then
    warn "Ultimo erro da Central: $last_error"
  else
    ok "Sem erro recente registrado da Central"
  fi
}

print_summary() {
  local status="Pronto"
  local exit_code=0

  if [ "$FAILURES" -gt 0 ]; then
    status="Bloqueado"
    exit_code=2
  elif [ "$WARNINGS" -gt 0 ]; then
    status="Atencao"
    exit_code=1
  fi

  printf '\n'
  log "Resultado: $status"
  printf 'Checks: %s | Atencoes: %s | Bloqueios: %s\n' "$CHECKS" "$WARNINGS" "$FAILURES"

  if [ "$OUTPUT_MODE" = "--json" ] || [ "$OUTPUT_MODE" = "json" ]; then
    printf '{"status":"%s","checks":%s,"warnings":%s,"failures":%s}\n' "$status" "$CHECKS" "$WARNINGS" "$FAILURES"
  fi

  return "$exit_code"
}

main() {
  log "Executando checklist automatico de producao"
  load_env
  check_required_commands
  check_env_security
  check_containers
  check_endpoints
  check_database
  check_camera_profiles
  check_redis
  check_ai_service
  check_mediamtx
  check_storage_and_backups
  check_exposure
  check_runtime_security
  check_cloud_settings
  print_summary
}

main "$@"
