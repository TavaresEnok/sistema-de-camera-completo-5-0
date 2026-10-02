#!/usr/bin/env bash
set -Eeuo pipefail

# Guarde quais valores vieram REALMENTE do ambiente antes de aplicar padrões.
# Sem isto, `load_config_file` não distinguia "o operador exportou" de "o
# próprio script preencheu": como DRAC_CENTRAL_URL já nascia com um default, a
# linha correspondente no arquivo era ignorada para sempre. A precedência real
# é: ambiente explícito > arquivo de respostas > padrão do produto.
DRAC_EXPLICIT_ENV_KEYS=' '
for drac_key in \
  DRAC_REPO_URL DRAC_INSTALLER_COMMIT DRAC_INSTALL_DIR DRAC_OPERATING_USER \
  DRAC_CENTRAL_URL DRAC_ENVIRONMENT DRAC_AUTO_YES \
  DRAC_WATCHDOG_ENABLED DRAC_WATCHDOG_INTERVAL_MINUTES DRAC_BUILD_AGENT_EXPECTED DRAC_ENROLLMENT_TOKEN \
  DRAC_CAMERA_ALLOWED_CIDRS DRAC_CUSTOMER_NAME DRAC_INSTALLATION_ID \
  DRAC_LICENSE_KEY DRAC_SERVER_IP DRAC_RTMP_SHORT_HOST \
  DRAC_GATEWAY_MODE DRAC_PUBLIC_ORIGIN DRAC_PRIVATE_BIND_IP DRAC_TURN_URL DRAC_TURN_SECRET \
  DRAC_ADMIN_USERNAME DRAC_ADMIN_EMAIL DRAC_ADMIN_PASSWORD DRAC_ADMIN_NAME DRAC_PERSIST_INITIAL_CREDENTIALS; do
  if [[ -v $drac_key ]] && [ -n "${!drac_key}" ]; then
    DRAC_EXPLICIT_ENV_KEYS+="$drac_key "
  fi
done
unset drac_key

# O repositório PRINCIPAL do produto, desde 26/09/2026:
# `TavaresEnok/sistema-de-camera-completo-5-0`.
#
# Repositórios anteriores ficam apenas como arquivo histórico. O instalador,
# a Central e os agentes devem usar este destino com o mesmo histórico Git,
# para que os commits aprovados continuem disponíveis para instalação.
DRAC_REPO_URL="${DRAC_REPO_URL:-https://github.com/TavaresEnok/sistema-de-camera-completo-5-0.git}"
DRAC_INSTALLER_COMMIT="${DRAC_INSTALLER_COMMIT:-}"
# Padrões de PRODUTO, não da máquina de desenvolvimento.
#
# Até 07/08/2026 estes eram `/home/flashnet/Drac` e `flashnet` — o diretório e
# o usuário do desenvolvedor. Numa instalação de cliente isso criava uma pasta
# com o nome de alguém que não existe naquele servidor, e um usuário idem.
# `/opt/drac` é onde software de terceiro mora em Linux, e o usuário operador
# passa a ser quem de fato invocou o instalador (via sudo), com queda para
# `drac` quando não dá para saber.
DRAC_INSTALL_DIR="${DRAC_INSTALL_DIR:-/opt/drac}"
DRAC_OPERATING_USER="${DRAC_OPERATING_USER:-${SUDO_USER:-drac}}"
DRAC_CENTRAL_URL="${DRAC_CENTRAL_URL:-https://central.s2cam.com.br}"
DRAC_ENVIRONMENT="${DRAC_ENVIRONMENT:-prod}"
DRAC_AUTO_YES="${DRAC_AUTO_YES:-false}"
DRAC_WATCHDOG_ENABLED="${DRAC_WATCHDOG_ENABLED:-true}"
DRAC_WATCHDOG_INTERVAL_MINUTES="${DRAC_WATCHDOG_INTERVAL_MINUTES:-5}"
DRAC_CAMERA_ALLOWED_CIDRS="${DRAC_CAMERA_ALLOWED_CIDRS:-}"
DRAC_GATEWAY_MODE="${DRAC_GATEWAY_MODE:-false}"
DRAC_PUBLIC_ORIGIN="${DRAC_PUBLIC_ORIGIN:-}"
DRAC_PRIVATE_BIND_IP="${DRAC_PRIVATE_BIND_IP:-}"
DRAC_TURN_URL="${DRAC_TURN_URL:-}"
DRAC_TURN_SECRET="${DRAC_TURN_SECRET:-}"
# Senha de matricula na Central. Sem ela, o cliente precisa ter sido
# provisionado pelo painel antes da instalacao.
DRAC_ENROLLMENT_TOKEN="${DRAC_ENROLLMENT_TOKEN:-}"
# Arquivo de respostas: o caminho PADRÃO de instalação. Ver
# scripts/instalacao-cliente.exemplo.env.
DRAC_CONFIG_FILE="${DRAC_CONFIG_FILE:-}"
# Primeiro administrador. Sem isto a instalação terminava sem NENHUM usuário e
# ninguém conseguia entrar — o `docs/clean-install.md` mandava criar à mão.
DRAC_ADMIN_EMAIL="${DRAC_ADMIN_EMAIL:-}"
DRAC_ADMIN_USERNAME="${DRAC_ADMIN_USERNAME:-}"
DRAC_ADMIN_PASSWORD="${DRAC_ADMIN_PASSWORD:-}"
DRAC_ADMIN_NAME="${DRAC_ADMIN_NAME:-Administrador}"
DRAC_PERSIST_INITIAL_CREDENTIALS="${DRAC_PERSIST_INITIAL_CREDENTIALS:-true}"
# Preenchido em tempo de execução quando a senha é gerada por nós (só então o
# resumo final a imprime — senha escolhida pelo operador não é ecoada).
DRAC_ADMIN_PASSWORD_GERADA=""

log() {
  printf '\033[1;36m[DRAC]\033[0m %s\n' "$*"
}

warn() {
  printf '\033[1;33m[DRAC]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[DRAC]\033[0m %s\n' "$*" >&2
  exit 1
}

# ── FALHAR ALTO, NUNCA EM SILÊNCIO ──────────────────────────────────────────
#
# Os dois piores momentos da primeira instalação de cliente foram falhas MUDAS:
# o instalador saindo sem dizer nada, e um `mkdir` sem permissão que morreu
# calado. Quem instala não tem como diagnosticar o que não fala.
#
# Daqui em diante, qualquer comando que quebre diz a linha, o comando e o
# código — e deixa claro que a instalação NÃO terminou.
trap 'drac_erro_fatal $? "$LINENO" "$BASH_COMMAND"' ERR

drac_erro_fatal() {
  local rc="$1" linha="$2" comando="$3"
  printf '\033[1;31m[DRAC]\033[0m FALHOU na linha %s (codigo %s): %s\n' "$linha" "$rc" "$comando" >&2
  printf '\033[1;31m[DRAC]\033[0m A INSTALACAO NAO FOI CONCLUIDA. Nada foi declarado pronto.\n' >&2
  exit "$rc"
}

run_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

run_as_user() {
  local user="$1"
  shift
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u "$user" -- "$@"
  elif [ "$(id -un)" = "$user" ]; then
    "$@"
  else
    sudo -u "$user" "$@"
  fi
}

run_git_as_user() {
  local user="$1"
  shift
  run_as_user "$user" env \
    -u BASH_ENV \
    -u ENV \
    -u GIT_CONFIG_COUNT \
    -u GIT_CONFIG_KEY_0 \
    -u GIT_CONFIG_VALUE_0 \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    git \
    -c core.hooksPath=/dev/null \
    -c core.fsmonitor=false \
    "$@"
}

prompt() {
  local var_name="$1"
  local label="$2"
  local default_value="${3:-}"
  local current_value="${!var_name:-}"

  if [ -n "$current_value" ]; then
    return
  fi

  if [ "$DRAC_AUTO_YES" = "true" ]; then
    if [ -n "$default_value" ]; then
      printf -v "$var_name" '%s' "$default_value"
      return
    fi
    fail "Variavel obrigatoria nao informada: $var_name (defina-a no arquivo de respostas ou no ambiente)"
  fi

  # Entrada NAO e um terminal (instalador vindo de pipe, cron, CI, one-liner da
  # Central). Perguntar aqui era um laco infinito: `read` retorna EOF, a resposta
  # fica vazia, o laco avisa "Campo obrigatorio" e volta a perguntar — para
  # sempre, sem ninguem para responder. Agora diz exatamente o que faltou.
  if [ ! -t 0 ]; then
    fail "Sem terminal para perguntar '$label'. Informe $var_name no arquivo de respostas (--config) ou no ambiente."
  fi

  local answer
  if [ -n "$default_value" ]; then
    read -r -p "$label [$default_value]: " answer
    printf -v "$var_name" '%s' "${answer:-$default_value}"
  else
    while true; do
      read -r -p "$label: " answer
      if [ -n "$answer" ]; then
        printf -v "$var_name" '%s' "$answer"
        return
      fi
      warn "Campo obrigatorio."
    done
  fi
}

# Chaves que o arquivo de respostas aceita. Qualquer outra é ERRO, não um
# palpite: um `DRAC_CUSTUMER_NAME` mal digitado passaria despercebido e a
# instalação seguiria com o padrão errado — exatamente o tipo de falha muda que
# este trabalho está eliminando.
DRAC_CHAVES_VALIDAS="
DRAC_REPO_URL DRAC_INSTALLER_COMMIT DRAC_INSTALL_DIR DRAC_OPERATING_USER
DRAC_CENTRAL_URL DRAC_ENVIRONMENT DRAC_AUTO_YES
DRAC_WATCHDOG_ENABLED DRAC_WATCHDOG_INTERVAL_MINUTES DRAC_BUILD_AGENT_EXPECTED DRAC_ENROLLMENT_TOKEN
DRAC_CAMERA_ALLOWED_CIDRS DRAC_CUSTOMER_NAME DRAC_INSTALLATION_ID
DRAC_LICENSE_KEY DRAC_SERVER_IP DRAC_RTMP_SHORT_HOST
DRAC_GATEWAY_MODE DRAC_PUBLIC_ORIGIN DRAC_PRIVATE_BIND_IP DRAC_TURN_URL DRAC_TURN_SECRET
DRAC_ADMIN_USERNAME DRAC_ADMIN_EMAIL DRAC_ADMIN_PASSWORD DRAC_ADMIN_NAME DRAC_PERSIST_INITIAL_CREDENTIALS
"

usage() {
  cat <<'EOF'
Instalador DRAC VMS

  install-drac.sh --config cliente.env      instalação sem intervenção (recomendado)
  install-drac.sh                           instalação interativa (pergunta tudo)

Opções:
  -c, --config ARQUIVO   arquivo de respostas (ver scripts/instalacao-cliente.exemplo.env)
  -h, --help             esta ajuda

O arquivo de respostas aceita uma chave por linha, no formato CHAVE=valor.
Linhas em branco e começadas por # são ignoradas. Chave desconhecida é erro.
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -c|--config)
        [ $# -ge 2 ] || fail "--config exige o caminho de um arquivo."
        DRAC_CONFIG_FILE="$2"
        shift 2
        ;;
      --config=*) DRAC_CONFIG_FILE="${1#*=}"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; fail "Opcao desconhecida: $1" ;;
    esac
  done
}

# Lê o arquivo de respostas SEM interpretá-lo como shell: `source` executaria
# o que estivesse lá dentro. Aqui só entram pares CHAVE=valor conhecidos.
load_config_file() {
  [ -n "$DRAC_CONFIG_FILE" ] || return 0
  [ -f "$DRAC_CONFIG_FILE" ] || fail "Arquivo de respostas nao encontrado: $DRAC_CONFIG_FILE"

  local perms
  perms="$(stat -c '%a' "$DRAC_CONFIG_FILE" 2>/dev/null || echo '')"
  case "$perms" in
    *[24567]) warn "$DRAC_CONFIG_FILE e legivel por outros usuarios (modo $perms) e pode conter a senha do administrador. Use chmod 600." ;;
  esac

  log "Lendo respostas de $DRAC_CONFIG_FILE"
  local linha numero=0 chave valor
  while IFS= read -r linha || [ -n "$linha" ]; do
    numero=$((numero + 1))
    linha="${linha%$'\r'}"
    case "$linha" in
      ''|'#'*) continue ;;
    esac
    if [[ ! "$linha" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      fail "$DRAC_CONFIG_FILE linha $numero: esperado CHAVE=valor, veio: $linha"
    fi
    chave="${BASH_REMATCH[1]}"
    valor="${BASH_REMATCH[2]}"
    # Tira aspas envolventes, se houver, e espaços nas pontas.
    valor="${valor#"${valor%%[![:space:]]*}"}"
    valor="${valor%"${valor##*[![:space:]]}"}"
    case "$valor" in
      \"*\") valor="${valor:1:${#valor}-2}" ;;
      \'*\') valor="${valor:1:${#valor}-2}" ;;
    esac
    if [[ " $(printf '%s' "$DRAC_CHAVES_VALIDAS" | tr '\n' ' ') " != *" $chave "* ]]; then
      fail "$DRAC_CONFIG_FILE linha $numero: chave desconhecida '$chave'. Veja scripts/instalacao-cliente.exemplo.env."
    fi
    # O ambiente EXPLICITAMENTE recebido tem precedência. Um padrão aplicado
    # pelo próprio script não conta como decisão do operador.
    if [[ "$DRAC_EXPLICIT_ENV_KEYS" != *" $chave "* ]]; then
      printf -v "$chave" '%s' "$valor"
    fi
  done < "$DRAC_CONFIG_FILE"

  # Com arquivo de respostas, perguntar não faz sentido: o objetivo é instalar
  # sem ninguém na frente do terminal.
  DRAC_AUTO_YES=true
}

# Lê uma chave já gravada no infra/.env (para não reinventar valores).
env_get() {
  local file="$1" key="$2"
  run_sudo sed -nE "s/^${key}=(.*)$/\\1/p" "$file" | tail -n 1
}

slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
}

random_hex() {
  local bytes="${1:-32}"
  openssl rand -hex "$bytes"
}

detect_ip() {
  hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true
}

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnu "( sport = :$port )" 2>/dev/null | tail -n +2 | grep -q .
    return $?
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltnu 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$"
    return $?
  fi
  return 1
}

host_from_url() {
  printf '%s' "$1" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##; s#/.*$##; s#:.*$##'
}

check_dns_host() {
  local label="$1"
  local host="$2"
  [ -n "$host" ] || return 0
  if command -v getent >/dev/null 2>&1 && getent hosts "$host" >/dev/null 2>&1; then
    log "DNS OK: $label ($host)"
    return 0
  fi
  if command -v host >/dev/null 2>&1 && host "$host" >/dev/null 2>&1; then
    log "DNS OK: $label ($host)"
    return 0
  fi
  warn "Nao foi possivel resolver DNS de $label ($host). Se for IP local, ignore; se for dominio publico, corrija antes da producao."
}

check_http_url() {
  local label="$1"
  local url="$2"
  [ -n "$url" ] || return 0
  if curl -fsS --max-time 10 "$url" >/dev/null 2>&1; then
    log "Conectividade OK: $label"
  else
    warn "Nao foi possivel acessar $label em $url agora."
  fi
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; :a;N;$!ba;s/\n/\\n/g'
}

wait_for_http() {
  local label="$1"
  local url="$2"
  local attempts="${3:-30}"
  local delay="${4:-3}"
  local attempt
  for attempt in $(seq 1 "$attempts"); do
    if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
      log "$label respondeu."
      return 0
    fi
    sleep "$delay"
  done
  warn "$label nao respondeu apos $((attempts * delay)) segundos: $url"
  return 1
}

preflight() {
  log "Executando pre-checagens"
  case "$DRAC_INSTALL_DIR" in /|/opt|/home|/etc|/usr|/var|/root)
    fail "DRAC_INSTALL_DIR deve ser um diretorio dedicado, como /opt/drac.";; esac
  [ ! -L "$DRAC_INSTALL_DIR" ] || fail "DRAC_INSTALL_DIR nao pode ser um link simbolico."
  case "$DRAC_PERSIST_INITIAL_CREDENTIALS" in true|false) ;; *) fail "DRAC_PERSIST_INITIAL_CREDENTIALS deve ser true ou false.";; esac

  if [[ ! "$DRAC_INSTALLER_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]]; then
    fail "DRAC_INSTALLER_COMMIT deve ser um commit Git completo e imutavel de 40 caracteres hexadecimais."
  fi
  DRAC_INSTALLER_COMMIT="$(printf '%s' "$DRAC_INSTALLER_COMMIT" | tr '[:upper:]' '[:lower:]')"
  if [[ ! "$DRAC_REPO_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/-]+$ ]]; then
    fail "DRAC_REPO_URL deve ser uma URL HTTPS sem credenciais, query ou fragmento."
  fi

  if [ "$DRAC_OPERATING_USER" = "root" ]; then
    fail "DRAC_OPERATING_USER nao pode ser root. Use um usuario operacional, por exemplo flashnet."
  fi

  case "$DRAC_INSTALL_DIR" in
    /root|/root/*)
      fail "DRAC_INSTALL_DIR nao pode ficar dentro de /root. Use /home/$DRAC_OPERATING_USER/Drac ou outro diretorio operacional."
      ;;
  esac

  if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    fail "Execute como root ou instale sudo para permitir configuracao de dependencias do host."
  fi

  if ! command -v curl >/dev/null 2>&1; then
    fail "curl e obrigatorio para a instalacao automatica."
  fi

  if [ "$DRAC_GATEWAY_MODE" = "true" ]; then
    if [[ ! "$DRAC_PUBLIC_ORIGIN" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
      fail "DRAC_PUBLIC_ORIGIN deve ser uma origem HTTPS sem caminho no modo Gateway."
    fi
    if [[ ! "$DRAC_PRIVATE_BIND_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      fail "DRAC_PRIVATE_BIND_IP deve ser o IPv4 privado desta VM no modo Gateway."
    fi
    if [[ ! "$DRAC_TURN_URL" =~ ^turns?:[^[:space:]]+:[0-9]+(\?transport=(udp|tcp))?$ ]]; then
      fail "DRAC_TURN_URL deve informar turn:host:porta ou turns:host:porta no modo Gateway."
    fi
    if [ ${#DRAC_TURN_SECRET} -lt 32 ]; then
      fail "DRAC_TURN_SECRET deve ter pelo menos 32 caracteres no modo Gateway."
    fi
  fi

  if ! command -v openssl >/dev/null 2>&1; then
    warn "openssl ainda nao esta instalado; sera instalado nas dependencias do host."
  fi

  if command -v awk >/dev/null 2>&1; then
    local mem_mb disk_kb disk_gb
    mem_mb="$(awk '/MemTotal/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null || echo 0)"
    disk_kb="$(df -Pk "$(dirname "$DRAC_INSTALL_DIR")" 2>/dev/null | awk 'NR==2 {print $4}' || echo 0)"
    disk_gb="$(awk -v kb="${disk_kb:-0}" 'BEGIN { printf "%d", kb / 1024 / 1024 }')"
    if [ "${mem_mb:-0}" -lt 3900 ]; then
      warn "Memoria baixa detectada (${mem_mb:-0}MB). Para producao, use pelo menos 4GB; para varias cameras, 8GB+."
    else
      log "Memoria OK: ${mem_mb}MB"
    fi
    if [ "${disk_gb:-0}" -lt 20 ]; then
      warn "Disco livre baixo em $(dirname "$DRAC_INSTALL_DIR") (${disk_gb:-0}GB). Grave videos somente com storage dimensionado."
    else
      log "Disco livre OK: ${disk_gb}GB"
    fi
  fi

  check_dns_host "GitHub" "github.com"
  check_dns_host "Central" "$(host_from_url "$DRAC_CENTRAL_URL")"
  check_http_url "GitHub raw" "https://raw.githubusercontent.com/TavaresEnok/sistema-de-camera-completo-5-0/${DRAC_INSTALLER_COMMIT}/README.md"
  check_http_url "DRAC Central" "${DRAC_CENTRAL_URL%/}/api/health"

  for port in 3000 5173 8554 8888 8889; do
    if port_in_use "$port"; then
      warn "Porta $port ja esta em uso. Se for uma instalacao DRAC existente, o Compose fara a atualizacao; se for outro servico, ajuste antes de continuar."
    fi
  done
}

ensure_operating_user() {
  if id "$DRAC_OPERATING_USER" >/dev/null 2>&1; then
    return
  fi
  log "Criando usuario operacional $DRAC_OPERATING_USER"
  run_sudo useradd -m -s /bin/bash "$DRAC_OPERATING_USER"
}

install_host_dependencies() {
  if ! command -v apt-get >/dev/null 2>&1; then
    fail "Instalador automatico suporta Ubuntu/Debian com apt-get. Instale Docker, Compose e Git manualmente neste sistema."
  fi

  log "Instalando dependencias do host"
  run_sudo apt-get update
  run_sudo apt-get install -y ca-certificates curl git gnupg openssl lsb-release

  if ! command -v docker >/dev/null 2>&1; then
    log "Instalando Docker"
    run_sudo install -m 0755 -d /etc/apt/keyrings
    . /etc/os-release
    local docker_os="$ID"
    if [ "$docker_os" != "ubuntu" ] && [ "$docker_os" != "debian" ]; then
      docker_os="ubuntu"
    fi
    run_sudo rm -f /etc/apt/keyrings/docker.gpg
    curl -fsSL "https://download.docker.com/linux/${docker_os}/gpg" | run_sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    run_sudo chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${docker_os} ${VERSION_CODENAME} stable" \
      | run_sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
    run_sudo apt-get update
    run_sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi

  if ! docker compose version >/dev/null 2>&1; then
    fail "Docker Compose plugin nao ficou disponivel apos a instalacao."
  fi

  # `docker compose version` funciona com o DAEMON PARADO — ele só lê o
  # binário. Era a única verificação de Docker que existia aqui, e por isso a
  # instalação seguia feliz para morrer minutos depois, ao subir os
  # containers, com "failed to connect to the docker API". Achado pelo teste
  # de instalação limpa (scripts/teste-instalacao-limpa.sh).
  ensure_docker_running

  run_sudo usermod -aG docker "$DRAC_OPERATING_USER" || true
}

ensure_docker_running() {
  if run_sudo docker info >/dev/null 2>&1; then
    log "Daemon do Docker respondendo."
    return 0
  fi

  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    log "Daemon do Docker parado; iniciando"
    run_sudo systemctl enable --now docker >/dev/null 2>&1 || true
  elif command -v service >/dev/null 2>&1; then
    run_sudo service docker start >/dev/null 2>&1 || true
  fi

  local tentativa
  for tentativa in $(seq 1 15); do
    if run_sudo docker info >/dev/null 2>&1; then
      log "Daemon do Docker respondendo."
      return 0
    fi
    sleep 2
  done

  fail "Docker instalado, mas o daemon NAO responde ('docker info' falha apos 30s).
  Sem ele nada sobe. Verifique:
    systemctl status docker
    journalctl -u docker -n 50"
}

sync_repository() {
  local parent_dir fetched_commit current_origin untracked
  parent_dir="$(dirname "$DRAC_INSTALL_DIR")"
  run_sudo mkdir -p "$parent_dir"
  # Never change ownership of /opt or other installations below the parent.
  if [ ! -e "$DRAC_INSTALL_DIR" ]; then
    run_sudo install -d -m 0755 -o "$DRAC_OPERATING_USER" -g "$DRAC_OPERATING_USER" "$DRAC_INSTALL_DIR"
  fi

  if [ -d "$DRAC_INSTALL_DIR/.git" ]; then
    if ! run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" diff --quiet --ignore-submodules --; then
      fail "O repositorio existente possui alteracoes rastreadas. A instalacao foi recusada para preservar a integridade do commit aprovado."
    fi
    if ! run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" diff --cached --quiet --ignore-submodules --; then
      fail "O repositorio existente possui alteracoes staged. A instalacao foi recusada."
    fi
    untracked="$(run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" ls-files --others --exclude-standard)"
    if [ -n "$untracked" ]; then
      fail "O repositorio existente possui arquivos nao rastreados. Mova-os para fora do checkout antes de instalar."
    fi
    current_origin="$(run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" remote get-url origin)"
    if [ "$current_origin" != "$DRAC_REPO_URL" ]; then
      fail "A origem Git existente diverge da origem aprovada; ajuste-a por procedimento administrativo antes de instalar."
    fi
    log "Atualizando repositorio para o commit aprovado em $DRAC_INSTALL_DIR"
    run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" fetch --depth 1 origin "$DRAC_INSTALLER_COMMIT"
  else
    if [ -e "$DRAC_INSTALL_DIR" ] && [ -n "$(find "$DRAC_INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
      fail "DRAC_INSTALL_DIR existe, nao e repositorio Git e nao esta vazio."
    fi
    log "Inicializando repositorio DRAC em $DRAC_INSTALL_DIR"
    run_as_user "$DRAC_OPERATING_USER" mkdir -p "$DRAC_INSTALL_DIR"
    run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" init
    run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" remote add origin "$DRAC_REPO_URL"
    run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" fetch --depth 1 origin "$DRAC_INSTALLER_COMMIT"
  fi

  fetched_commit="$(run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" rev-parse --verify 'FETCH_HEAD^{commit}')"
  if [ "$fetched_commit" != "$DRAC_INSTALLER_COMMIT" ]; then
    fail "O repositorio remoto nao entregou o commit imutavel aprovado."
  fi
  run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" checkout --detach "$DRAC_INSTALLER_COMMIT"
  if [ "$(run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" rev-parse HEAD)" != "$DRAC_INSTALLER_COMMIT" ]; then
    fail "O checkout final nao corresponde ao commit aprovado."
  fi
  if ! run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" diff --quiet --ignore-submodules -- ||
    ! run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" diff --cached --quiet --ignore-submodules --; then
    fail "O checkout final divergiu do commit aprovado."
  fi
  untracked="$(run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" ls-files --others --exclude-standard)"
  if [ -n "$untracked" ]; then
    fail "O checkout final contem arquivos nao rastreados e nao sera executado."
  fi
}

env_set() {
  local file="$1"
  local key="$2"
  local value="$3"
  local escaped
  escaped="$(printf '%s' "$value" | sed -e 's/[\/&]/\\&/g')"

  if grep -qE "^${key}=" "$file"; then
    run_sudo sed -i -E "s/^${key}=.*/${key}=${escaped}/" "$file"
  else
    printf '%s=%s\n' "$key" "$value" | run_sudo tee -a "$file" >/dev/null
  fi
}

# Reexecutar o instalador é uma operação de reparo/atualização, não uma rotação
# de chaves. Trocar CAMERA_SECRET_KEY torna todas as senhas de câmera
# indecifráveis; trocar POSTGRES_PASSWORD sem ALTER ROLE derruba a API. Em uma
# instalação já existente preservamos o segredo atual. Na primeira instalação,
# ou se a chave estiver vazia, geramos um valor forte.
env_set_secret() {
  local file="$1" key="$2" generated="$3" current
  current="$(env_get "$file" "$key")"
  if [ "${DRAC_ENV_WAS_PRESENT:-false}" = "true" ] && [ -n "$current" ]; then
    return 0
  fi
  env_set "$file" "$key" "$generated"
}

# As chaves que configuram uma máquina a SER um painel Central. Um cliente
# nunca é central; estas linhas não têm o que fazer no .env dele. `CLOUD_*`
# NÃO entra aqui — é o canal do cliente REPORTANDO à central, e é legítimo.
CENTRAL_ONLY_ENV_KEYS="CENTRAL_DATA_DIR CENTRAL_BACKUP_INTERVAL_SECONDS CENTRAL_BACKUP_RETENTION_DAYS DRAC_CENTRAL_ADMIN_EMAIL DRAC_CENTRAL_ADMIN_PASSWORD_HASH DRAC_CENTRAL_ADMIN_TOKEN DRAC_CENTRAL_ALLOWED_ORIGINS DRAC_CENTRAL_ARCHIVE_DIR DRAC_CENTRAL_ARCHIVE_KEY DRAC_CENTRAL_ARCHIVE_RETENTION_MONTHS DRAC_CENTRAL_COOKIE_SECURE DRAC_CENTRAL_INSTALLER_COMMIT DRAC_CENTRAL_INSTALLER_SHA256 DRAC_CENTRAL_INSTALLER_TOKEN_MAX_DOWNLOADS DRAC_CENTRAL_INSTALLER_TOKEN_TTL_SECONDS DRAC_CENTRAL_INSTALLER_URL_TEMPLATE DRAC_CENTRAL_PUBLIC_URL DRAC_CENTRAL_REPOSITORY_URL DRAC_CENTRAL_STORE_MODE DRAC_CENTRAL_TRUSTED_PROXIES"

# Remove do arquivo dado as linhas `CHAVE=...` das chaves de central. Idempotente:
# rodar de novo num arquivo já limpo não muda nada.
strip_central_only_keys() {
  local file="$1" key
  for key in $CENTRAL_ONLY_ENV_KEYS; do
    run_sudo sed -i "/^${key}=/d" "$file"
  done
}

prepare_env() {
  local env_file="$DRAC_INSTALL_DIR/infra/.env"
  local example_file="$DRAC_INSTALL_DIR/infra/.env.example"
  local server_ip="${DRAC_SERVER_IP:-$(detect_ip)}"
  local rtmp_short_host="${DRAC_RTMP_SHORT_HOST:-}"
  local install_slug
  local public_origin private_bind public_host public_scheme

  prompt DRAC_CUSTOMER_NAME "Nome do cliente"
  install_slug="$(slugify "${DRAC_CUSTOMER_NAME:-$(hostname)}")"
  prompt DRAC_INSTALLATION_ID "Codigo da instalacao" "${install_slug:-drac-cliente}"
  prompt DRAC_LICENSE_KEY "Chave/licenca do cliente" "drac-$(random_hex 16)"
  prompt DRAC_SERVER_IP "IP ou dominio deste servidor" "${server_ip:-127.0.0.1}"
  # Se o endereço principal já é IPv4, ele também é a representação compacta.
  # Com domínio não adivinhamos NAT/DNS: o operador pode fornecer explicitamente
  # DRAC_RTMP_SHORT_HOST, evitando publicar um IP privado por engano.
  if [ -z "$rtmp_short_host" ] && printf '%s' "$DRAC_SERVER_IP" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
    rtmp_short_host="$DRAC_SERVER_IP"
  fi
  prompt DRAC_CENTRAL_URL "URL da DRAC Central" "$DRAC_CENTRAL_URL"
  prompt DRAC_CAMERA_ALLOWED_CIDRS \
    "CIDRs exclusivos das redes de cameras (separados por virgula; ex.: 192.168.10.0/24)"

  if [ "$DRAC_GATEWAY_MODE" = "true" ]; then
    public_origin="${DRAC_PUBLIC_ORIGIN%/}"
    private_bind="$DRAC_PRIVATE_BIND_IP"
  else
    public_origin="http://${DRAC_SERVER_IP}:5173"
    private_bind="127.0.0.1"
  fi
  public_host="$(host_from_url "$public_origin")"
  public_scheme="${public_origin%%://*}"

  DRAC_ENV_WAS_PRESENT=false
  if [ ! -f "$env_file" ]; then
    log "Criando infra/.env"
    run_sudo cp "$example_file" "$env_file"
    run_sudo chmod 600 "$env_file"
  else
    DRAC_ENV_WAS_PRESENT=true
    warn "infra/.env ja existe; atualizando somente chaves controladas pelo instalador."
    run_sudo cp "$env_file" "$env_file.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  fi

  # ── O .env DO CLIENTE NÃO CARREGA A CONFIG DA CENTRAL ─────────────────────
  #
  # `.env.example` é a referência COMPLETA — serve também ao host mestre, que
  # roda o painel Central (`--profile central`). O cliente nunca roda esse
  # perfil, então essas chaves ficam inertes na máquina dele. "Inerte" não é
  # "inofensivo": expõe a arquitetura do fornecedor a quem abrir o arquivo e
  # seria um vazamento de verdade no dia em que um TOKEN/HASH fosse preenchido
  # por engano numa cópia do mestre. Um .env de cliente descreve só o cliente.
  #
  # Auditado na instalação do D-GUARDIAN (12/08/2026): o `cp` do exemplo trazia
  # o bloco inteiro para a VM do cliente. Nenhuma dessas chaves é obrigatória no
  # compose (verificado: sem `:?`), então removê-las não quebra nada.
  strip_central_only_keys "$env_file"

  env_set_secret "$env_file" POSTGRES_PASSWORD "$(random_hex 24)"
  env_set_secret "$env_file" JWT_SECRET "$(random_hex 32)"
  env_set_secret "$env_file" CAMERA_SECRET_KEY "$(random_hex 32)"
  env_set "$env_file" CAMERA_ALLOWED_CIDRS "$DRAC_CAMERA_ALLOWED_CIDRS"
  env_set_secret "$env_file" INTERNAL_SERVICE_TOKEN "$(random_hex 24)"
  env_set_secret "$env_file" EVIDENCE_HMAC_SECRET "$(random_hex 32)"
  env_set "$env_file" MEDIAMTX_API_USER "drac_media"
  env_set_secret "$env_file" MEDIAMTX_API_PASS "$(random_hex 18)"
  env_set_secret "$env_file" MEDIAMTX_AUTH_CALLBACK_TOKEN "$(random_hex 24)"
  env_set "$env_file" CORS_ALLOWED_ORIGINS "$public_origin"
  env_set "$env_file" PUBLIC_APP_URL "$public_origin"
  # A API crua fica deliberadamente em loopback. O único endereço público é o
  # gateway do web, que encaminha /api pela mesma origem do painel. Anunciar
  # :3000 aqui criava URLs inalcançáveis e levava o operador a expor a API sem
  # TLS para fazer o aplicativo funcionar.
  env_set "$env_file" API_PUBLIC_URL "${public_origin}/api"
  env_set "$env_file" VITE_API_URL ""
  env_set "$env_file" CLOUD_CONNECTOR_ENABLED "true"
  env_set "$env_file" CLOUD_API_URL "$DRAC_CENTRAL_URL"
  env_set "$env_file" CLOUD_INSTALLATION_ID "$DRAC_INSTALLATION_ID"
  env_set "$env_file" CLOUD_LICENSE_KEY "$DRAC_LICENSE_KEY"
  env_set "$env_file" CLOUD_CUSTOMER_NAME "$DRAC_CUSTOMER_NAME"
  env_set "$env_file" CLOUD_HEARTBEAT_INTERVAL_SECONDS "60"
  env_set "$env_file" CLOUD_CONNECTOR_TIMEOUT_MS "8000"
  env_set "$env_file" DRAC_VERSION "$DRAC_INSTALLER_COMMIT"
  env_set "$env_file" DRAC_LAUNCH_PROFILE "standard"
  env_set "$env_file" DRAC_GATEWAY_MODE "$DRAC_GATEWAY_MODE"
  env_set "$env_file" DRAC_PUBLIC_ORIGIN "$public_origin"
  env_set "$env_file" DRAC_PRIVATE_BIND_IP "$private_bind"
  # ── O QUE FICA EXPOSTO À INTERNET ─────────────────────────────────────────
  #
  # ATENÇÃO: publicar em 0.0.0.0 aqui EXPÕE DE VERDADE, mesmo com ufw ativo —
  # o Docker escreve regras de DNAT que são avaliadas ANTES das do firewall.
  # Medido na instalação do D-GUARDIAN: ufw liberava só 22/80/443/1935/8189 e,
  # ainda assim, a API (3000), o HLS (8888) e a sinalização WebRTC (8889)
  # respondiam da internet — a API inteira alcançável sem HTTPS e sem passar
  # pelo nginx.
  #
  # A regra: só é público o que NÃO PODE passar pelo nginx.
  #   · 8189/udp — mídia WebRTC: o navegador conecta direto no IP anunciado.
  #   · 1935/tcp — RTMP: a câmera disca para cá (tratado à parte).
  # Todo o resto (API, web, HLS, sinalização, RTSP) fica em loopback e é
  # servido pelo nginx do host, com HTTPS.
  env_set "$env_file" DRAC_API_BIND "127.0.0.1"
  env_set "$env_file" DRAC_WEB_BIND "$private_bind"
  env_set "$env_file" DRAC_POSTGRES_BIND "127.0.0.1"
  env_set "$env_file" DRAC_REDIS_BIND "127.0.0.1"
  env_set "$env_file" DRAC_MEDIAMTX_RTSP_BIND "127.0.0.1"
  env_set "$env_file" DRAC_MEDIAMTX_HLS_BIND "127.0.0.1"
  env_set "$env_file" DRAC_MEDIAMTX_WEBRTC_HTTP_BIND "127.0.0.1"
  # Loopback is correct for HTTP proxy, never for standalone WebRTC media.
  local media_bind media_host
  if [ "$DRAC_GATEWAY_MODE" = "true" ]; then
    media_bind="$private_bind"; media_host="$private_bind"
  else
    media_bind="0.0.0.0"; media_host="$DRAC_SERVER_IP"
  fi
  env_set "$env_file" DRAC_MEDIAMTX_WEBRTC_UDP_BIND "$media_bind"
  env_set "$env_file" MEDIAMTX_WEBRTC_ADDITIONAL_HOST "$media_host"
  env_set "$env_file" MEDIAMTX_PUBLIC_HOST "$public_host"
  env_set "$env_file" MEDIAMTX_RTMP_SHORT_HOST "$rtmp_short_host"
  env_set "$env_file" MEDIAMTX_PUBLIC_SCHEME "$public_scheme"
  env_set "$env_file" MEDIAMTX_PUBLIC_WEBRTC_URL "${public_origin}/webrtc"
  env_set "$env_file" MEDIAMTX_PUBLIC_HLS_URL "${public_origin}/hls"
  env_set "$env_file" MEDIAMTX_HLS_ALLOW_ORIGIN "$public_origin"
  env_set "$env_file" MEDIAMTX_WEBRTC_ALLOW_ORIGIN "$public_origin"
  env_set "$env_file" MEDIAMTX_TURN_URL "$DRAC_TURN_URL"
  env_set "$env_file" MEDIAMTX_TURN_SECRET "$DRAC_TURN_SECRET"

  run_sudo chown "$DRAC_OPERATING_USER:$DRAC_OPERATING_USER" "$env_file"
}

# O bind mount `infra/storage` precisa existir ANTES do primeiro `compose up`.
# Se o Docker o cria, ele nasce root:root; a API roda deliberadamente como
# `node` (UID/GID 1000) e o readiness falha com EACCES ao provar escrita em
# /storage. Isso só aparecia em máquina virgem porque na matriz a pasta antiga
# já pertencia ao UID 1000.
prepare_runtime_directories() {
  local storage_dir="$DRAC_INSTALL_DIR/infra/storage"
  run_sudo mkdir -p "$storage_dir"
  # O UID 1000 não é uma suposição sobre o usuário do host: ele é fixado pela
  # imagem node:22-alpine usada em apps/api/Dockerfile (USER node). Não fazemos
  # chown recursivo para não tocar milhões de gravações numa atualização.
  run_sudo chown 1000:1000 "$storage_dir"
  run_sudo chmod 0755 "$storage_dir"
}

compose_files() {
  local files
  if [ "$DRAC_ENVIRONMENT" = "dev" ]; then
    files='-f infra/docker-compose.yml -f infra/docker-compose.dev.yml'
  else
    files='-f infra/docker-compose.yml -f infra/docker-compose.prod.yml'
  fi
  if [ "$DRAC_GATEWAY_MODE" = "true" ]; then
    files="$files -f infra/docker-compose.gateway.yml"
  fi
  printf '%s' "$files"
}

start_stack() {
  local files
  files="$(compose_files)"
  log "Subindo containers DRAC"
  # shellcheck disable=SC2086
  run_as_user "$DRAC_OPERATING_USER" bash -lc "cd '$DRAC_INSTALL_DIR' && docker compose --env-file infra/.env $files up -d --build"
}

run_migrations() {
  local files
  files="$(compose_files)"
  log "Aplicando migrations do banco"
  # shellcheck disable=SC2086
  run_as_user "$DRAC_OPERATING_USER" bash -lc "cd '$DRAC_INSTALL_DIR' && docker compose --env-file infra/.env $files exec -T -w /app/apps/api api npx prisma migrate deploy"
}

# ── O INSTALADOR TERMINA COM UM SISTEMA UTILIZÁVEL ──────────────────────────
#
# Até 07/08/2026 a instalação terminava sem NENHUM usuário: `migrate deploy`
# criava as tabelas e pronto. Ninguém conseguia entrar, e o procedimento
# documentado mandava criar o administrador à mão (docs/clean-install.md,
# passo 5). Se o instalador termina sem erro, tem de dar para entrar.
#
# Idempotente pelo lado seguro: se JÁ existe qualquer usuário, não toca em
# nada. Reinstalar/atualizar não pode resetar a senha de quem está usando.
seed_admin() {
  local files env_file pg_user pg_db total seed_payload
  files="$(compose_files)"
  env_file="$DRAC_INSTALL_DIR/infra/.env"
  pg_user="$(env_get "$env_file" POSTGRES_USER)"
  pg_db="$(env_get "$env_file" POSTGRES_DB)"
  [ -n "$pg_user" ] && [ -n "$pg_db" ] || fail "Nao consegui ler POSTGRES_USER/POSTGRES_DB de $env_file."

  # shellcheck disable=SC2086
  total="$(run_as_user "$DRAC_OPERATING_USER" bash -lc "cd '$DRAC_INSTALL_DIR' && docker compose --env-file infra/.env $files exec -T postgres psql -U '$pg_user' -d '$pg_db' -tAc 'SELECT count(*) FROM \"User\"'" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ ! "$total" =~ ^[0-9]+$ ]]; then
    fail "Nao consegui contar os usuarios do banco (resposta: '${total:-vazio}'). O banco subiu? 'docker logs vms-postgres'."
  fi

  if [ "$total" -gt 0 ]; then
    log "Banco ja tem $total usuario(s); o administrador nao sera recriado (senha preservada)."
    return 0
  fi

  # Usuário é a identidade. E-mail continua opcional, exclusivamente para
  # recuperação de senha. Arquivos antigos que trazem só e-mail preservam
  # exatamente o comportamento anterior ao usá-lo como usuário.
  if [ -z "$DRAC_ADMIN_USERNAME" ]; then
    DRAC_ADMIN_USERNAME="${DRAC_ADMIN_EMAIL:-admin}"
  fi
  if [ -z "$DRAC_ADMIN_PASSWORD" ]; then
    # 17 caracteres, com maiúscula, minúscula, dígito e separador — passa
    # folgado no mínimo de 10 exigido pelo seed e é digitável.
    DRAC_ADMIN_PASSWORD="Drac-$(random_hex 6)"
    DRAC_ADMIN_PASSWORD_GERADA="$DRAC_ADMIN_PASSWORD"
  fi

  log "Criando o primeiro administrador ($DRAC_ADMIN_USERNAME)"
  seed_payload="$(printf '{"username":"%s","email":"%s","password":"%s","name":"%s"}' \
    "$(json_escape "$DRAC_ADMIN_USERNAME")" "$(json_escape "$DRAC_ADMIN_EMAIL")" \
    "$(json_escape "$DRAC_ADMIN_PASSWORD")" "$(json_escape "$DRAC_ADMIN_NAME")")"
  # shellcheck disable=SC2086
  if ! printf '%s' "$seed_payload" | run_as_user "$DRAC_OPERATING_USER" bash -lc "cd '$DRAC_INSTALL_DIR' && docker compose --env-file infra/.env $files exec -T -e ADMIN_STDIN_JSON=true -w /app/apps/api api npx tsx prisma/seed.ts"; then
    fail "O seed do administrador falhou. A instalacao NAO esta utilizavel: ninguem consegue entrar. Veja 'docker logs vms-api'."
  fi
  seed_payload=''
  if [ "$DRAC_PERSIST_INITIAL_CREDENTIALS" = "false" ]; then
    log "Administrador criado; senha mantida somente em memoria durante a instalacao."
    return
  fi

  # Guarda as credenciais num arquivo só do dono — o terminal rola, e perder a
  # senha inicial significa reinstalar.
  local cred_file="$DRAC_INSTALL_DIR/infra/.credenciais-iniciais"
  {
    printf 'painel=%s\n' "${DRAC_PUBLIC_ORIGIN:-http://${DRAC_SERVER_IP}:5173}"
    printf 'usuario=%s\n' "$DRAC_ADMIN_USERNAME"
    printf 'senha=%s\n' "$DRAC_ADMIN_PASSWORD"
    printf '# Troque esta senha no primeiro acesso e apague este arquivo.\n'
  } | run_sudo tee "$cred_file" >/dev/null
  run_sudo chmod 600 "$cred_file"
  run_sudo chown "$DRAC_OPERATING_USER:$DRAC_OPERATING_USER" "$cred_file"
  log "Administrador criado. Credenciais tambem em $cred_file (modo 600)."
}

remove_watchdog_cron() {
  # Remove QUALQUER agendamento antigo do watchdog no crontab do usuario operacional
  # (marcado por "drac-runtime-watchdog"), preservando as demais linhas. Idempotente:
  # se nao houver nada nosso, nao mexe no crontab.
  command -v crontab >/dev/null 2>&1 || return 0
  local current
  current="$(run_as_user "$DRAC_OPERATING_USER" crontab -l 2>/dev/null || true)"
  printf '%s' "$current" | grep -q 'drac-runtime-watchdog' || return 0
  printf '%s\n' "$current" | grep -v 'drac-runtime-watchdog' | sed '/^[[:space:]]*$/d' \
    | run_as_user "$DRAC_OPERATING_USER" crontab - 2>/dev/null || true
}

provision_watchdog_systemd() {
  local script_path="$1"
  local interval="$2"
  command -v systemctl >/dev/null 2>&1 || return 1
  [ -d /run/systemd/system ] || return 1

  local service_file="/etc/systemd/system/drac-watchdog.service"
  local timer_file="/etc/systemd/system/drac-watchdog.timer"

  log "Agendando runtime-watchdog via systemd timer (a cada ${interval}min)"

  # Reescrever os units com o mesmo conteudo e' idempotente por natureza.
  run_sudo tee "$service_file" >/dev/null <<EOF || return 1
[Unit]
Description=DRAC runtime watchdog (deteccao + auto-cura de infra)
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
User=$DRAC_OPERATING_USER
Nice=10
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$script_path
EOF

  run_sudo tee "$timer_file" >/dev/null <<EOF || return 1
[Unit]
Description=Executa o DRAC runtime watchdog a cada ${interval} minutos

[Timer]
OnCalendar=*:0/${interval}
Persistent=true
AccuracySec=30s
RandomizedDelaySec=20s
Unit=drac-watchdog.service

[Install]
WantedBy=timers.target
EOF

  run_sudo systemctl daemon-reload || { warn "systemctl daemon-reload falhou; tentando cron."; return 1; }
  # Evita execucao dupla se uma instalacao anterior usou cron.
  remove_watchdog_cron
  if run_sudo systemctl enable --now drac-watchdog.timer >/dev/null 2>&1; then
    log "Timer drac-watchdog ativo (systemctl list-timers | grep drac-watchdog)."
    return 0
  fi
  warn "Nao foi possivel habilitar o timer systemd; tentando cron."
  return 1
}

provision_watchdog_cron() {
  local script_path="$1"
  local interval="$2"
  if ! command -v crontab >/dev/null 2>&1; then
    warn "Nem systemd nem crontab disponiveis. Agende manualmente: */$interval * * * * $script_path"
    return 0
  fi

  log "Agendando runtime-watchdog via cron do usuario $DRAC_OPERATING_USER (a cada ${interval}min)"
  local cron_line existing merged
  cron_line="*/$interval * * * * PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin $script_path >/dev/null 2>&1 # drac-runtime-watchdog"

  existing="$(run_as_user "$DRAC_OPERATING_USER" crontab -l 2>/dev/null || true)"
  # Remove a nossa linha antiga (idempotencia) e re-adiciona a atual; preserva o resto.
  merged="$(printf '%s\n' "$existing" | grep -v 'drac-runtime-watchdog' | sed '/^[[:space:]]*$/d' || true)"
  merged="$(printf '%s\n%s\n' "$merged" "$cron_line" | sed '/^[[:space:]]*$/d')"
  if printf '%s\n' "$merged" | run_as_user "$DRAC_OPERATING_USER" crontab - 2>/dev/null; then
    log "Cron do watchdog instalado (crontab -l -u $DRAC_OPERATING_USER)."
  else
    warn "Falha ao instalar o cron do watchdog. Agende manualmente: $cron_line"
  fi
  return 0
}

provision_watchdog() {
  if [ "$DRAC_WATCHDOG_ENABLED" != "true" ]; then
    log "Watchdog de runtime desabilitado (DRAC_WATCHDOG_ENABLED=$DRAC_WATCHDOG_ENABLED); pulando agendamento."
    return 0
  fi

  local script_path="$DRAC_INSTALL_DIR/scripts/runtime-watchdog.sh"
  if [ ! -f "$script_path" ]; then
    warn "runtime-watchdog.sh nao encontrado em $script_path; auto-cura nao sera agendada."
    return 0
  fi
  run_sudo chmod +x "$script_path" 2>/dev/null || true

  # O diretorio de estado do watchdog TEM de ser gravavel pelo usuario que o
  # executa. `storage` nasce do root (quem o cria sao os containers) e o
  # watchdog roda como operador — ele morria no primeiro disparo, calado.
  #
  # O watchdog tenta se virar com `sudo -n`, mas o operador normalmente NAO tem
  # sudo sem senha: no D-GUARDIAN isso foi contornado a mao e o defeito
  # continuou no produto. Quem tem privilegio para resolver e o instalador, e e
  # aqui que se resolve. Reencontrado pelo teste de instalacao limpa.
  # Vale para todo diretório sob `storage` que o OPERADOR precisa escrever, não
  # só o do watchdog: o de backups é usado pelo script de atualização, e ele
  # abortava pelo mesmo motivo (visto ao atualizar o D-GUARDIAN, 10/08/2026).
  local dir
  for dir in "$DRAC_INSTALL_DIR/infra/storage/.monitor" "$DRAC_INSTALL_DIR/infra/storage/backups"; do
    run_sudo mkdir -p "$dir"
    run_sudo chown -R "$DRAC_OPERATING_USER:$DRAC_OPERATING_USER" "$dir"
  done

  # Intervalo em minutos (1..59); cai para 5 se invalido.
  local interval="$DRAC_WATCHDOG_INTERVAL_MINUTES"
  case "$interval" in
    ''|*[!0-9]*) interval=5 ;;
  esac
  { [ "$interval" -ge 1 ] && [ "$interval" -le 59 ]; } 2>/dev/null || interval=5

  if provision_watchdog_systemd "$script_path" "$interval"; then
    return 0
  fi
  provision_watchdog_cron "$script_path" "$interval"
  return 0
}

# ── AGENTE OPERACIONAL DA CENTRAL ─────────────────────────────────────────
#
# A Central nunca abre SSH, Docker API ou uma porta de volta para o cliente.
# Este timer roda localmente como root, consulta a Central por HTTPS e só
# executa a pequena lista de ações permitidas em drac-ops-agent.sh. Sem ele a
# instalação aparece no inventário, mas não pode receber atualização ou um
# reinício seguro pelo painel da Central.
provision_operations_agent() {
  local script_path="$DRAC_INSTALL_DIR/scripts/drac-ops-agent.sh"
  local service_source="$DRAC_INSTALL_DIR/infra/systemd/drac-ops-agent.service"
  local timer_source="$DRAC_INSTALL_DIR/infra/systemd/drac-ops-agent.timer"
  local config_file="/etc/drac/ops-agent.env"

  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
    warn "systemd indisponivel; agente operacional da Central nao pode ser agendado automaticamente."
    return 0
  fi
  if [ ! -f "$script_path" ] || [ ! -f "$service_source" ] || [ ! -f "$timer_source" ]; then
    warn "Arquivos do agente operacional ausentes; a Central nao podera operar esta instalacao remotamente."
    return 0
  fi
  if [ -z "$DRAC_CENTRAL_URL" ] || [ -z "$DRAC_INSTALLATION_ID" ] || [ -z "$DRAC_LICENSE_KEY" ]; then
    warn "Dados da Central incompletos; agente operacional nao foi instalado."
    return 0
  fi

  log "Configurando agente operacional da Central"
  run_sudo install -d -m 700 /etc/drac
  # Não copiar o .env inteiro: ele contém segredos de banco/mídia que o agente
  # não precisa conhecer. O arquivo abaixo contém somente a identidade mínima
  # para consultar ações destinadas a ESTA instalação.
  run_sudo tee "$config_file" >/dev/null <<EOF
DRAC_OPS_CENTRAL_URL=$DRAC_CENTRAL_URL
DRAC_OPS_INSTALLATION_ID=$DRAC_INSTALLATION_ID
DRAC_OPS_LICENSE_KEY=$DRAC_LICENSE_KEY
DRAC_OPS_ROOT_DIR=$DRAC_INSTALL_DIR
EOF
  run_sudo chmod 600 "$config_file"
  run_sudo chown root:root "$config_file"
  run_sudo chmod 0755 "$script_path"
  # O unit aponta para /opt/drac para que a atualização troque o agente junto
  # com o produto; não mantemos uma segunda cópia que poderia ficar defasada.
  run_sudo install -m 0644 -o root -g root "$service_source" /etc/systemd/system/drac-ops-agent.service
  run_sudo install -m 0644 -o root -g root "$timer_source" /etc/systemd/system/drac-ops-agent.timer
  run_sudo systemctl daemon-reload
  if run_sudo systemctl enable --now drac-ops-agent.timer >/dev/null 2>&1; then
    # Uma execução imediata confirma a identidade na Central; o timer segue a
    # cada 20 segundos depois disso. A ausência de operação pendente é sucesso.
    run_sudo systemctl start drac-ops-agent.service >/dev/null 2>&1 || true
    log "Agente operacional ativo (Central pode atualizar e reiniciar esta instalacao)."
  else
    warn "Nao foi possivel ativar drac-ops-agent.timer; confira systemctl status drac-ops-agent.timer."
  fi
}

# ── O WATCHDOG PRECISA TER RESPONDIDO UMA VEZ ───────────────────────────────
#
# Agendar não é o mesmo que funcionar. Na instalação do D-GUARDIAN o watchdog
# foi agendado e morreu no primeiro disparo (mkdir sem permissão, em silêncio):
# a instalação parecia monitorada e não estava. Aqui ele roda de verdade, uma
# vez, e a instalação só segue se tiver produzido o arquivo de estado.
verify_watchdog() {
  if [ "$DRAC_WATCHDOG_ENABLED" != "true" ]; then
    return 0
  fi
  local script_path="$DRAC_INSTALL_DIR/scripts/runtime-watchdog.sh"
  local status_file="$DRAC_INSTALL_DIR/infra/storage/.monitor/runtime-status.json"
  [ -f "$script_path" ] || { warn "runtime-watchdog.sh ausente; sem verificacao de monitoramento."; return 0; }

  log "Disparando o watchdog uma vez para confirmar que ele funciona"

  # ATENCAO a semantica: o watchdog termina em `[ ${#issues[@]} -eq 0 ]`, ou
  # seja, ele sai NAO-ZERO quando o SISTEMA esta degradado — disco cheio, uma
  # camera fora do ar. Isso e um DIAGNOSTICO, nao um defeito dele.
  #
  # Reprovar a instalacao por causa disso seria absurdo (uma instalacao nova,
  # sem camera nenhuma, tende a reportar algo). O que precisa ser provado aqui
  # e outra coisa: que o watchdog EXECUTA e GRAVA. Foi isso que faltou no
  # D-GUARDIAN, onde ele foi agendado e morreu calado no primeiro disparo.
  local antes=0
  [ -f "$status_file" ] && antes="$(stat -c %Y "$status_file" 2>/dev/null || echo 0)"

  local saida
  saida="$(run_as_user "$DRAC_OPERATING_USER" bash -lc "'$script_path'" 2>&1)" || true

  if [ ! -f "$status_file" ]; then
    fail "O watchdog nao gravou $status_file. A instalacao ficaria SEM monitoramento sem ninguem perceber.
  Ele disse: ${saida:-<nada>}
  Rode '$script_path' e leia o erro."
  fi
  local depois
  depois="$(stat -c %Y "$status_file" 2>/dev/null || echo 0)"
  if [ "$depois" -le "$antes" ]; then
    fail "O watchdog rodou mas NAO atualizou $status_file (arquivo velho).
  Ele disse: ${saida:-<nada>}"
  fi

  log "Watchdog confirmado: executou e gravou $status_file"
  # Problema encontrado agora e informacao para o operador, nao motivo para
  # abortar: a instalacao esta de pe e monitorada.
  local problemas
  problemas="$(sed -nE 's/.*"issues"[[:space:]]*:[[:space:]]*\[([^]]*)\].*/\1/p' "$status_file" | tr -d '"')"
  if [ -n "$problemas" ]; then
    warn "O watchdog ja reportou:$problemas"
    warn "Nao impede a instalacao; acompanhe com 'journalctl -t drac-watchdog'."
  fi
}

register_central_now() {
  local base="${DRAC_CENTRAL_URL%/}"
  local payload response_file http

  # ── MATRÍCULA ANTES DO HEARTBEAT ────────────────────────────────────────
  #
  # Até 24/08/2026 esta função "registrava" mandando um heartbeat. Só que o
  # heartbeat EXIGE que a instalação já exista na Central (ela é criada pelo
  # provisionamento). Resultado: instalação feita direto por este script tomava
  # 403, a função imprimia um aviso e seguia como se tivesse dado certo — e a
  # instalação nascia órfã. A Córtex passou um dia inteiro assim.
  #
  # Com a licença que vence sozinha, órfã vira SUSPENSA em 15 dias. Então aqui
  # não há mais "avisa e segue": ou a instalação fica registrada, ou a
  # instalação falha.
  if [ -n "${DRAC_ENROLLMENT_TOKEN:-}" ]; then
    log "Matriculando a instalacao na DRAC Central"
    response_file="$(mktemp)"
    payload="$(printf '{"installationId":"%s","customerName":"%s","licenseKey":"%s","serverAddress":"%s","cameraAllowedCidrs":"%s"}' \
      "$(json_escape "$DRAC_INSTALLATION_ID")" \
      "$(json_escape "$DRAC_CUSTOMER_NAME")" \
      "$(json_escape "$DRAC_LICENSE_KEY")" \
      "$(json_escape "${DRAC_SERVER_IP:-}")" \
      "$(json_escape "${DRAC_CAMERA_ALLOWED_CIDRS:-}")")"
    http="$(curl -s -o "$response_file" -w '%{http_code}' --max-time 15 \
      -H 'Content-Type: application/json' \
      -H "X-DRAC-Enrollment-Token: $DRAC_ENROLLMENT_TOKEN" \
      -d "$payload" "$base/api/agent/enroll" || echo 000)"
    if [ "$http" != "200" ] && [ "$http" != "201" ]; then
      local motivo
      motivo="$(sed -n 's/.*"error":"\([^"]*\)".*/\1/p' "$response_file" | head -1)"
      rm -f "$response_file"
      fail "A Central RECUSOU a matricula desta instalacao (HTTP $http${motivo:+, $motivo}).
  Sem registro na Central a instalacao fica suspensa em 15 dias.
  Confira DRAC_ENROLLMENT_TOKEN, ou provisione o cliente pelo painel da Central antes de instalar."
    fi
    rm -f "$response_file"
    log "Instalacao matriculada na Central."
  fi

  # Confirma com um heartbeat de verdade. Se ele nao passar, a instalacao NAO
  # esta registrada — e dizer o contrario seria mentir para quem instalou.
  log "Confirmando o registro com um heartbeat"
  payload="$(printf '{"installation":{"id":"%s","name":"%s","customerName":"%s","version":"%s","launchProfile":"standard"},"summary":{"status":"installing"}}' \
    "$(json_escape "$DRAC_INSTALLATION_ID")" \
    "$(json_escape "$DRAC_INSTALLATION_ID")" \
    "$(json_escape "$DRAC_CUSTOMER_NAME")" \
    "$(json_escape "$DRAC_INSTALLER_COMMIT")")"
  response_file="$(mktemp)"
  http="$(curl -s -o "$response_file" -w '%{http_code}' --max-time 15 \
    -H 'Content-Type: application/json' \
    -H "X-DRAC-Installation-Id: $DRAC_INSTALLATION_ID" \
    -H "X-DRAC-License-Key: $DRAC_LICENSE_KEY" \
    -d "$payload" "$base/api/agent/heartbeat" || echo 000)"
  rm -f "$response_file"
  if [ "$http" != "200" ] && [ "$http" != "201" ]; then
    fail "A Central NAO aceitou esta instalacao (HTTP $http).
  A instalacao ficaria sem licenca e seria suspensa em 15 dias.
  Caminhos: preencha DRAC_ENROLLMENT_TOKEN no arquivo de respostas, ou
  provisione o cliente pelo painel da Central e use o ID e a chave de la."
  fi
  log "Instalacao confirmada na Central."
}

validate_installation() {
  local web_bind web_health_url
  log "Validando instalacao"
  docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | sed -n '1,20p'

  wait_for_http "API local" "http://127.0.0.1:3000/health/ready" 30 3 || fail "API local nao ficou pronta."
  web_bind="$(env_get "$DRAC_INSTALL_DIR/infra/.env" DRAC_WEB_BIND)"
  case "$web_bind" in
    ''|0.0.0.0|127.0.0.1) web_health_url="http://127.0.0.1:5173/" ;;
    *) web_health_url="http://${web_bind}:5173/" ;;
  esac
  wait_for_http "Painel local" "$web_health_url" 20 3 || fail "Painel local nao respondeu."

  if curl -fsS "${DRAC_CENTRAL_URL%/}/api/health" >/dev/null; then
    log "Central respondeu em ${DRAC_CENTRAL_URL%/}/api/health"
  else
    warn "Nao foi possivel validar a central agora. Confira rede/firewall e CLOUD_API_URL."
  fi

  if [ -x "$DRAC_INSTALL_DIR/scripts/production-readiness.sh" ]; then
    log "Executando checklist automatico de producao"
    if run_as_user "$DRAC_OPERATING_USER" bash -lc "cd '$DRAC_INSTALL_DIR' && ./scripts/production-readiness.sh"; then
      log "Checklist automatico retornou Pronto."
    else
      warn "Checklist automatico encontrou pendencias. Revise os itens ATENCAO/BLOQUEADO acima."
    fi
  fi
}

print_summary() {
  # Se a senha foi gerada por nós, ela aparece aqui — é a única vez. Senha
  # escolhida pelo operador nao e ecoada (ele ja a conhece).
  local bloco_acesso
  if [ -n "$DRAC_ADMIN_PASSWORD_GERADA" ]; then
    bloco_acesso="$(printf 'Acesso (TROQUE a senha no primeiro login):\n  usuario: %s\n  senha:   %s\n  copia em: %s/infra/.credenciais-iniciais\n' \
      "$DRAC_ADMIN_USERNAME" "$DRAC_ADMIN_PASSWORD_GERADA" "$DRAC_INSTALL_DIR")"
  elif [ -n "$DRAC_ADMIN_USERNAME" ]; then
    bloco_acesso="$(printf 'Acesso:\n  usuario: %s (senha definida por voce)\n' "$DRAC_ADMIN_USERNAME")"
  else
    bloco_acesso='Acesso: administrador ja existia; credenciais preservadas.'
  fi

  cat <<EOF

Instalacao DRAC concluida.

${bloco_acesso}
EOF

# O compose de produção publica em 127.0.0.1 por padrão (bom: não expõe o
# painel do cliente à internet sem TLS). Mas o resumo abaixo anunciava o IP do
# servidor mesmo assim — um endereço que NUNCA responderia, e o operador
# concluía que a instalação falhou. Aconteceu na instalação da Vibe
# (19/08/2026). Dizer a verdade sobre o que foi publicado é o mínimo.
DRAC_AVISO_BIND=""
if [ "$(env_get "$DRAC_INSTALL_DIR/infra/.env" DRAC_WEB_BIND)" = "127.0.0.1" ]; then
  DRAC_AVISO_BIND="
    ^ acessível SOMENTE deste servidor (publicado em 127.0.0.1).
      Para um teste por IP, altere somente DRAC_WEB_BIND=0.0.0.0 em infra/.env
      e suba o web de novo. Nunca exponha DRAC_API_BIND: use /api pelo painel.
      Em produção, mantenha loopback e coloque um proxy HTTPS na frente."
elif [ "$DRAC_GATEWAY_MODE" = "true" ]; then
  DRAC_AVISO_BIND="
    ^ publicado somente no IP privado ${DRAC_PRIVATE_BIND_IP}; acesso externo pela Gateway TLS."
fi

  cat <<EOF
Painel local:
  ${DRAC_PUBLIC_ORIGIN:-http://${DRAC_SERVER_IP}:5173}${DRAC_AVISO_BIND}

API pelo mesmo gateway do painel:
  ${DRAC_PUBLIC_ORIGIN:-http://${DRAC_SERVER_IP}:5173}/api/health${DRAC_AVISO_BIND}

Central configurada:
  ${DRAC_CENTRAL_URL}

Instalacao enviada para a central:
  ${DRAC_INSTALLATION_ID} - ${DRAC_CUSTOMER_NAME}

Versao imutavel instalada:
  ${DRAC_INSTALLER_COMMIT}

Auto-cura / monitoramento (watchdog de infra):
  journalctl -t drac-watchdog             (eventos e auto-curas)
  systemctl list-timers | grep drac-watchdog   (se agendado via systemd)

Se a instalacao ainda nao apareceu na central, aguarde ate 60 segundos
ou verifique os logs:
  docker logs --tail=120 vms-api

EOF
}

main() {
  parse_args "$@"
  load_config_file
  log "Instalador DRAC VMS"
  preflight
  ensure_operating_user
  install_host_dependencies
  sync_repository
  prepare_env
  prepare_runtime_directories
  start_stack
  run_migrations
  # A instalação só é "concluída" depois que dá para ENTRAR nela e depois que o
  # monitoramento provou que funciona. Ambos falham alto.
  seed_admin
  # The backup daemon starts with Compose, before migrate deploy. Refresh its
  # first dump only after the schema and initial administrator exist.
  log "Gerando backup apos migrations e criacao do administrador"
  run_as_user "$DRAC_OPERATING_USER" bash -lc "cd '$DRAC_INSTALL_DIR' && docker compose --env-file infra/.env $(compose_files) restart postgres-backup"
  provision_watchdog || warn "Watchdog nao pode ser agendado automaticamente; agende scripts/runtime-watchdog.sh manualmente."
  provision_operations_agent
  verify_watchdog
  register_central_now
  validate_installation
  print_summary
}

# Executa só quando chamado direto. Sob `source`, expõe as funções para teste
# sem instalar nada — é o que permite testar prompt/config sem uma máquina.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
