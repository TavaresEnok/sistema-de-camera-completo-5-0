#!/usr/bin/env bash
# Testes do instalador que NÃO precisam de uma máquina.
#
# Cobrem o que a primeira instalação de cliente ensinou: arquivo de respostas
# com erro tem de falhar dizendo o quê, e perguntar sem terminal era um laço
# infinito. Rodam em segundos, no CI, a cada mudança.
#
#   bash scripts/tests/test-instalador.sh
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALADOR="$RAIZ/scripts/install-drac.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

falhas=0
ok()   { printf '  \033[1;32mok\033[0m   %s\n' "$1"; }
nok()  { printf '  \033[1;31mFALHOU\033[0m %s\n     %s\n' "$1" "$2"; falhas=$((falhas + 1)); }

# Roda o instalador e devolve a saída (stdout+stderr). Nunca chega a instalar:
# todos os casos abaixo morrem antes de qualquer efeito no sistema.
executar() { bash "$INSTALADOR" "$@" 2>&1 || true; }

espera_conter() {
  local titulo="$1" esperado="$2" saida="$3"
  if printf '%s' "$saida" | grep -qF -- "$esperado"; then ok "$titulo"; else nok "$titulo" "esperava conter: $esperado | veio: $(printf '%s' "$saida" | tail -2 | tr '\n' ' ')"; fi
}

printf '\n\033[1mArquivo de respostas\033[0m\n'

espera_conter 'arquivo inexistente é dito pelo nome' \
  'Arquivo de respostas nao encontrado' "$(executar --config "$TMP/nao-existe.env")"

printf 'DRAC_CUSTUMER_NAME=Cliente\n' > "$TMP/typo.env"
espera_conter 'chave mal digitada é ERRO, não um padrão silencioso' \
  "chave desconhecida 'DRAC_CUSTUMER_NAME'" "$(executar --config "$TMP/typo.env")"

printf 'isto nao e uma atribuicao\n' > "$TMP/formato.env"
espera_conter 'linha fora do formato diz o número da linha' \
  'linha 1: esperado CHAVE=valor' "$(executar --config "$TMP/formato.env")"

espera_conter 'opção desconhecida não é ignorada' \
  'Opcao desconhecida: --naoexiste' "$(executar --naoexiste)"

espera_conter '--config sem argumento reclama' \
  '--config exige o caminho' "$(executar --config)"

# ── Leitura correta: comentários, aspas, espaços, CRLF ──────────────────────
printf '# comentario\n\nDRAC_CUSTOMER_NAME="Cliente Teste"\n  DRAC_INSTALL_DIR = /opt/x \nDRAC_ADMIN_NAME=Chefe\r\n' > "$TMP/bom.env"
saida="$(
  set +e
  # shellcheck disable=SC1090
  source "$INSTALADOR" >/dev/null 2>&1
  trap - ERR
  DRAC_CONFIG_FILE="$TMP/bom.env"
  DRAC_CUSTOMER_NAME='' DRAC_INSTALL_DIR='' DRAC_ADMIN_NAME=''
  load_config_file >/dev/null 2>&1
  printf '%s|%s|%s|%s' "$DRAC_CUSTOMER_NAME" "$DRAC_INSTALL_DIR" "$DRAC_ADMIN_NAME" "$DRAC_AUTO_YES"
)"
if [ "$saida" = 'Cliente Teste|/opt/x|Chefe|true' ]; then
  ok 'lê aspas, espaços, comentários e CRLF; e liga o modo sem perguntas'
else
  nok 'lê aspas, espaços, comentários e CRLF' "veio: $saida"
fi

# Valores que possuem padrão no topo do instalador também precisam aceitar o
# arquivo. Este era o motivo de DRAC_CENTRAL_URL continuar apontando para a
# produção durante o gate, apesar de o cliente.env dizer loopback.
printf 'DRAC_CENTRAL_URL=http://127.0.0.1:9765\n' > "$TMP/bom-default.env"
saida="$(
  env -u DRAC_CENTRAL_URL bash -c '
    source "$1" >/dev/null 2>&1
    trap - ERR
    DRAC_CONFIG_FILE="$2"
    load_config_file >/dev/null 2>&1
    printf "%s" "$DRAC_CENTRAL_URL"
  ' _ "$INSTALADOR" "$TMP/bom-default.env"
)" 2>/dev/null || true
if [ "$saida" = 'http://127.0.0.1:9765' ]; then
  ok 'arquivo substitui o padrão interno da URL da Central'
else
  nok 'arquivo substitui o padrão interno da URL da Central' "veio: $saida"
fi

saida="$(
  DRAC_CENTRAL_URL='https://central.explicitamente.local' bash -c '
    source "$1" >/dev/null 2>&1
    trap - ERR
    DRAC_CONFIG_FILE="$2"
    load_config_file >/dev/null 2>&1
    printf "%s" "$DRAC_CENTRAL_URL"
  ' _ "$INSTALADOR" "$TMP/bom-default.env"
)" 2>/dev/null || true
if [ "$saida" = 'https://central.explicitamente.local' ]; then
  ok 'ambiente explicitamente exportado continua vencendo o arquivo'
else
  nok 'ambiente explicitamente exportado vence o arquivo' "veio: $saida"
fi


printf '\n\033[1mNunca perguntar no vazio\033[0m\n'

# O defeito: sem terminal, `read` retorna EOF, a resposta fica vazia, o laço
# avisa "Campo obrigatorio" e pergunta de novo — para sempre. Um instalador
# vindo de pipe/cron/CI travava sem dizer o porquê.
saida="$(
  set +e
  # shellcheck disable=SC1090
  source "$INSTALADOR" >/dev/null 2>&1
  trap - ERR
  DRAC_AUTO_YES=false
  ALGUMA_COISA=''
  timeout 5 bash -c '
    # shellcheck disable=SC1090
    source "'"$INSTALADOR"'" >/dev/null 2>&1
    trap - ERR
    DRAC_AUTO_YES=false
    ALGUMA_COISA=""
    prompt ALGUMA_COISA "Pergunta obrigatoria"
  ' < /dev/null 2>&1
  printf '|saida=%s' "$?"
)"
if printf '%s' "$saida" | grep -q 'Sem terminal para perguntar'; then
  ok 'sem terminal, diz qual variável faltou em vez de travar'
elif printf '%s' "$saida" | grep -q 'saida=124'; then
  nok 'sem terminal, diz qual variável faltou' 'TRAVOU (timeout) — o laço infinito voltou'
else
  nok 'sem terminal, diz qual variável faltou' "veio: $(printf '%s' "$saida" | tail -2 | tr '\n' ' ')"
fi

printf '\n\033[1mAjuda\033[0m\n'
espera_conter '--help explica o modo recomendado' \
  '--config cliente.env' "$(executar --help)"

printf '\n\033[1mO .env do cliente não carrega config de Central\033[0m\n'

# A instalação do D-GUARDIAN (12/08/2026) revelou o vazamento: o `cp` do
# .env.example trazia o bloco DRAC_CENTRAL_*/CENTRAL_* para a VM do cliente.
# Inerte (o cliente não roda --profile central), mas expõe a arquitetura e
# seria segredo de verdade no dia em que um TOKEN/HASH fosse preenchido.
saida="$(
  set +e
  # shellcheck disable=SC1090
  source "$INSTALADOR" >/dev/null 2>&1
  trap - ERR
  run_sudo() { "$@"; }                       # sem sudo dentro do teste
  cp "$RAIZ/infra/.env.example" "$TMP/cliente.env"
  strip_central_only_keys "$TMP/cliente.env"
  grep -cE '^(CENTRAL_|DRAC_CENTRAL_)' "$TMP/cliente.env" 2>/dev/null || echo 0
)"
if [ "${saida##*$'\n'}" = "0" ]; then
  ok 'nenhuma chave de Central sobra no .env do cliente'
else
  nok 'nenhuma chave de Central sobra no .env do cliente' "ainda restam ${saida##*$'\n'} linha(s) de central"
fi

# E o oposto: não pode levar junto o que o cliente PRECISA (o canal CLOUD_*).
saida="$(
  set +e
  # shellcheck disable=SC1090
  source "$INSTALADOR" >/dev/null 2>&1
  trap - ERR
  run_sudo() { "$@"; }
  printf 'CLOUD_LICENSE_KEY=drac-abc\nCLOUD_API_URL=https://x\nDRAC_CENTRAL_ADMIN_TOKEN=segredo\n' > "$TMP/mix.env"
  strip_central_only_keys "$TMP/mix.env"
  grep -c '^CLOUD_' "$TMP/mix.env"
)"
if [ "${saida##*$'\n'}" = "2" ]; then
  ok 'preserva o CLOUD_* (canal do cliente reportando à Central)'
else
  nok 'preserva o CLOUD_*' "esperava 2 linhas CLOUD_, veio: ${saida##*$'\n'}"
fi

printf '\n\033[1mModo Gateway compartilhada\033[0m\n'

saida="$(
  set +e
  # shellcheck disable=SC1090
  source "$INSTALADOR" >/dev/null 2>&1
  trap - ERR
  DRAC_ENVIRONMENT=prod
  DRAC_GATEWAY_MODE=true
  compose_files
)"
if printf '%s' "$saida" | grep -qF -- '-f infra/docker-compose.gateway.yml'; then
  ok 'modo Gateway inclui o overlay de TURN'
else
  nok 'modo Gateway inclui o overlay de TURN' "veio: $saida"
fi

if grep -qF 'env_set "$env_file" DRAC_WEB_BIND "$private_bind"' "$INSTALADOR" \
  && grep -qF 'env_set "$env_file" API_PUBLIC_URL "${public_origin}/api"' "$INSTALADOR"; then
  ok 'painel liga no IP privado e anuncia a origem HTTPS pública'
else
  nok 'separa bind privado de origem pública' 'o instalador voltou a confundir IP interno e URL externa'
fi

READINESS="$RAIZ/scripts/production-readiness.sh"
if grep -qF 'local web_bind="${DRAC_WEB_BIND:-127.0.0.1}"' "$READINESS" \
  && grep -qF 'check_http "Web local" "$web_url"' "$READINESS" \
  && ! grep -qF 'check_http "Web local" "http://127.0.0.1:5173/"' "$READINESS"; then
  ok 'readiness testa o bind real do painel em vez de acusar falso bloqueio no loopback'
else
  nok 'readiness respeita o bind privado do painel' 'instalações atrás da Gateway seriam marcadas como bloqueadas mesmo saudáveis'
fi
if grep -qF 'where enabled = true and status =' "$READINESS" \
  && grep -qF 'lower(coalesce("recordingVideoCodec"' "$READINESS" \
  && grep -qF 'Todas as cameras ativas preservam o codec original' "$READINESS" \
  && ! grep -qF 'Todas as cameras preferem H.265/HEVC' "$READINESS"; then
  ok 'readiness ignora cameras desativadas e valida gravacao no codec original'
else
  nok 'readiness aplica a politica atual das cameras' 'cadastro desativado ou codec original voltaria a produzir alerta falso'
fi

if grep -qF 'MTX_WEBRTCICESERVERS2_0_USERNAME=AUTH_SECRET' "$RAIZ/infra/docker-compose.gateway.yml" \
  && grep -qF 'MTX_WEBRTCICESERVERS2_0_CLIENTONLY=true' "$RAIZ/infra/docker-compose.gateway.yml"; then
  ok 'MediaMTX recebe credenciais TURN temporárias no navegador'
else
  nok 'MediaMTX recebe credenciais TURN temporárias' 'overlay WebRTC incompleto'
fi

printf '\n\033[1mStorage de instalação limpa\033[0m\n'

printf '\n\033[1mHTTPS e TURN local preservados na reexecução\033[0m\n'
saida="$(
  source "$INSTALADOR" >/dev/null 2>&1
  trap - ERR
  DRAC_GATEWAY_MODE=false DRAC_PUBLIC_ORIGIN='' DRAC_TURN_URL='' DRAC_TURN_SECRET=''
  run_sudo() { "$@"; }
  printf 'DRAC_PUBLIC_ORIGIN=https://cliente.exemplo.test\nMEDIAMTX_TURN_URL=turn:turn.exemplo.test:3478?transport=udp\nMEDIAMTX_TURN_SECRET=0123456789abcdef0123456789abcdef\n' > "$TMP/https-local.env"
  restore_public_endpoint_config "$TMP/https-local.env"
  printf '%s|%s\n' "$DRAC_PUBLIC_ORIGIN" "$DRAC_TURN_URL"
  compose_files
)"
if printf '%s' "$saida" | grep -qF 'https://cliente.exemplo.test|turn:turn.exemplo.test:3478?transport=udp' \
  && printf '%s' "$saida" | grep -qF 'docker-compose.gateway.yml'; then
  ok 'instalação local preserva HTTPS/TURN e inclui relay sem virar Gateway'
else
  nok 'instalação local preserva HTTPS/TURN' 'reexecução perderia o domínio ou a configuração de relay'
fi
saida="$(
  source "$INSTALADOR" >/dev/null 2>&1
  trap - ERR
  DRAC_PUBLIC_ORIGIN='https://novo.exemplo.test'
  run_sudo() { "$@"; }
  DRAC_TURN_URL='turn:novo.exemplo.test:3478' DRAC_TURN_SECRET='abcdef0123456789abcdef0123456789'
  restore_public_endpoint_config "$TMP/https-local.env"
  printf '%s|%s' "$DRAC_PUBLIC_ORIGIN" "$DRAC_TURN_URL"
)"
if [ "$saida" = 'https://novo.exemplo.test|turn:novo.exemplo.test:3478' ]; then
  ok 'HTTPS/TURN explícitos prevalecem sobre configuração anterior'
else
  nok 'HTTPS/TURN explícitos prevalecem' "veio: $saida"
fi
saida="$(
  source "$INSTALADOR" >/dev/null 2>&1
  trap - ERR
  DRAC_PUBLIC_ORIGIN='' DRAC_TURN_URL='turn:novo.exemplo.test:3478' DRAC_TURN_SECRET=''
  run_sudo() { "$@"; }
  restore_public_endpoint_config "$TMP/https-local.env" 2>&1
)" || true
espera_conter 'TURN parcial não mistura chave antiga com endereço novo' 'Configuracao TURN incompleta' "$saida"

if grep -qF 'prepare_runtime_directories' "$INSTALADOR" \
  && grep -qF 'run_sudo chown 1000:1000 "$storage_dir"' "$INSTALADOR"; then
  ok 'storage nasce gravável pela API não-root antes do compose up'
else
  nok 'storage nasce gravável pela API não-root' 'máquina virgem voltará a falhar o /health/ready com EACCES'
fi

saida="$(
  set +e
  # shellcheck disable=SC1090
  source "$INSTALADOR" >/dev/null 2>&1
  trap - ERR
  run_sudo() { "$@"; }
  printf 'CAMERA_SECRET_KEY=segredo-antigo\n' > "$TMP/segredos.env"
  DRAC_ENV_WAS_PRESENT=true
  env_set_secret "$TMP/segredos.env" CAMERA_SECRET_KEY segredo-novo
  env_get "$TMP/segredos.env" CAMERA_SECRET_KEY
)"
if [ "${saida##*$'\n'}" = 'segredo-antigo' ]; then
  ok 'reexecução preserva a chave que cifra as credenciais das câmeras'
else
  nok 'reexecução preserva segredos' "CAMERA_SECRET_KEY mudou para ${saida##*$'\n'}"
fi

printf '\n\033[1mResumo final executável\033[0m\n'
saida="$(
  set +e
  # shellcheck disable=SC1090
  source "$INSTALADOR" >/dev/null 2>&1
  trap - ERR
  run_sudo() { "$@"; }
  DRAC_ADMIN_PASSWORD_GERADA=''
  DRAC_ADMIN_EMAIL='admin@teste.local'
  DRAC_INSTALL_DIR="$TMP/instalacao"
  mkdir -p "$DRAC_INSTALL_DIR/infra"
  : > "$DRAC_INSTALL_DIR/infra/.env"
  DRAC_GATEWAY_MODE=true
  DRAC_PRIVATE_BIND_IP='10.10.0.20'
  DRAC_PUBLIC_ORIGIN='https://cliente.exemplo.test'
  DRAC_SERVER_IP='10.10.0.20'
  DRAC_CENTRAL_URL='https://central.exemplo.test'
  DRAC_INSTALLATION_ID='cliente-teste'
  DRAC_CUSTOMER_NAME='Cliente Teste'
  DRAC_INSTALLER_COMMIT='abc123'
  print_summary
)"
if printf '%s' "$saida" | grep -qF 'Painel local:' \
  && printf '%s' "$saida" | grep -qF 'publicado somente no IP privado 10.10.0.20' \
  && ! printf '%s' "$saida" | grep -qF 'DRAC_AVISO_BIND='; then
  ok 'resumo executa a lógica e não imprime o próprio código-fonte'
else
  nok 'resumo executa a lógica' "saída inválida: $(printf '%s' "$saida" | tail -8 | tr '\n' ' ')"
fi

if grep -qF 'web_health_url="http://${web_bind}:5173/"' "$INSTALADOR" \
  && grep -qF 'WEB_HEALTH_URL="http://${WEB_BIND}:5173/"' "$RAIZ/scripts/runtime-watchdog.sh" \
  && grep -qF 'WEB="http://${web_bind}:5173"' "$RAIZ/scripts/verificar-instalacao.sh"; then
  ok 'instalador, watchdog e verificador respeitam o bind privado da Gateway'
else
  nok 'saúde web respeita o bind privado' 'algum dos três voltou a testar somente 127.0.0.1'
fi

if grep -qF 'docker-compose.gateway.yml' "$RAIZ/scripts/atualizar-instalacao.sh" \
  && grep -qF 'docker-compose.gateway.yml' "$RAIZ/scripts/update-drac.sh" \
  && grep -qF 'docker-compose.gateway.yml' "$RAIZ/scripts/restore-drac.sh" \
  && grep -qF 'docker-compose.gateway.yml' "$RAIZ/infra/drac-up.sh" \
  && grep -qF 'docker-compose.gateway.yml' "$RAIZ/infra/gpu-setup.sh" \
  && grep -qF 'COMPOSE_MEDIAMTX+=(-f "$INFRA_DIR/docker-compose.gateway.yml")' "$RAIZ/scripts/runtime-watchdog.sh" \
  && grep -qF 'MTX_WEBRTCICESERVERS2_0_URL=' "$RAIZ/scripts/runtime-watchdog.sh"; then
  ok 'subida, atualização, restauração, GPU e auto-cura preservam o TURN da Gateway'
else
  nok 'ciclo de vida preserva TURN' 'algum caminho voltou a subir somente o compose base'
fi

if grep -qF 'LOCK_FILE="$STATE_DIR/runtime-watchdog.lock"' "$RAIZ/scripts/runtime-watchdog.sh" \
  && ! grep -qF 'LOCK_FILE="${XDG_RUNTIME_DIR:-/tmp}' "$RAIZ/scripts/runtime-watchdog.sh"; then
  ok 'watchdog usa lock privado por instalação'
else
  nok 'watchdog usa lock privado por instalação' 'lock em /tmp falha com fs.protected_regular=2 e colide entre instalações'
fi

if grep -qF 'vms-rtmp-callback vms-rtmp-ingest' "$RAIZ/scripts/runtime-watchdog.sh" \
  && grep -qF 'heal_rtmp_service vms-rtmp-callback rtmp-callback' "$RAIZ/scripts/runtime-watchdog.sh" \
  && grep -qF 'heal_rtmp_service vms-rtmp-ingest rtmp-ingest' "$RAIZ/scripts/runtime-watchdog.sh" \
  && grep -qF 'restaurou-forward-total-rtmp' "$RAIZ/scripts/runtime-watchdog.sh"; then
  ok 'watchdog observa, cura e confirma o encaminhamento da cadeia RTMP'
else
  nok 'watchdog cobre cadeia RTMP' 'SRS/callback/forward não podem falhar fora do monitoramento'
fi

if grep -qF 'live:webrtc-host-nao-e-desta-maquina' "$RAIZ/scripts/runtime-watchdog.sh" \
  && grep -qF 'live:webrtc-host-nao-aplicado' "$RAIZ/scripts/runtime-watchdog.sh" \
  && grep -qF 'MEDIAMTX_WEBRTC_ADDITIONAL_HOST' "$RAIZ/scripts/trocar-ip.sh" \
  && grep -qF -- '--force-recreate mediamtx' "$RAIZ/scripts/trocar-ip.sh"; then
  ok 'troca de IP: watchdog acusa host WebRTC alheio e o script recria o MediaMTX'
else
  nok 'troca de IP coberta' 'o IP anunciado ao navegador pode envelhecer em silêncio (incidente Vibe 12/09)'
fi

if grep -qF 'RTMP_EDGE=mediamtx' "$RAIZ/scripts/runtime-watchdog.sh" \
  && grep -qF 'if [ "$RTMP_EDGE" = "srs" ]; then' "$RAIZ/scripts/runtime-watchdog.sh"; then
  ok 'watchdog não cobra o elo SRS→MediaMTX quando a borda RTMP é a Gateway'
else
  nok 'watchdog respeita a borda RTMP' 'com MediaMTX na 1935 o SRS local fica ocioso e não deve ser cobrado nem reiniciado'
fi

if grep -qF 'backup_interval="$(load_env_var POSTGRES_BACKUP_INTERVAL_SECONDS)"' "$RAIZ/scripts/runtime-watchdog.sh" \
  && grep -qF 'backup_max_age=$((backup_interval + 86400))' "$RAIZ/scripts/runtime-watchdog.sh" \
  && ! grep -qF 'backup:mais-velho-que-36h' "$RAIZ/scripts/runtime-watchdog.sh"; then
  ok 'watchdog respeita a periodicidade configurada do backup semanal'
else
  nok 'watchdog respeita backup semanal' 'limite fixo diário gera alarme permanente e esconde falhas reais'
fi

if grep -qF 'com.docker.compose.project' "$RAIZ/scripts/verificar-instalacao.sh" \
  && grep -qF 'docker_ps_da_instalacao' "$RAIZ/scripts/verificar-instalacao.sh"; then
  ok 'verificador de portas não culpa o AjustCam por outro produto da mesma VM'
else
  nok 'verificador de portas isola a stack' 'voltou a auditar indiscriminadamente todos os containers do host'
fi

if grep -qF 'LOGIN_EXPLICITO=false' "$RAIZ/scripts/verificar-instalacao.sh" \
  && grep -qF 'credencial inicial não é mais válida' "$RAIZ/scripts/verificar-instalacao.sh" \
  && grep -qF 'nenhum administrador ativo foi confirmado' "$RAIZ/scripts/verificar-instalacao.sh"; then
  ok "verificador tolera senha inicial trocada somente quando há administrador ativo"
else
  falha "verificador não distingue credencial explícita de senha inicial já trocada"
fi

if grep -qF 'git config --global --add safe.directory "$DRAC_OPS_ROOT_DIR"' "$RAIZ/scripts/drac-ops-agent.sh" \
  && grep -qF 'git -C "$DRAC_OPS_ROOT_DIR" config core.filemode false' "$RAIZ/scripts/drac-ops-agent.sh" \
  && grep -qF 'export DOCKER_CONFIG="${DOCKER_CONFIG:-$DRAC_OPS_STATE_DIR/docker}"' "$RAIZ/scripts/drac-ops-agent.sh" \
  && grep -qF 'DRAC_UPDATE_ALLOW_DIRTY=false' "$RAIZ/scripts/drac-ops-agent.sh"; then
  ok 'agente remoto atualiza sem confiar em curinga nem escrever no home do root'
else
  falha 'agente remoto não prepara Git/Docker para atualização isolada' 'a atualização remota pode falhar por ownership, filemode ou ProtectHome'
fi

printf '\n\033[1mRegras de instalacao local\033[0m\n'
if grep -qF 'media_bind="0.0.0.0"; media_host="$DRAC_SERVER_IP"' "$INSTALADOR" \
  && grep -qF 'media_bind="$private_bind"; media_host="$private_bind"' "$INSTALADOR"; then
  ok 'WebRTC local nao fica preso no loopback; Gateway preserva bind privado'
else
  nok 'WebRTC local/Gateway' 'midia inacessivel ou bind de Gateway alterado'
fi
if ! grep -qF 'chown -R "$DRAC_OPERATING_USER:$DRAC_OPERATING_USER" "$parent_dir"' "$INSTALADOR"; then
  ok 'instalador nao altera ownership de /opt e instalacoes vizinhas'
else
  nok 'ownership isolado' 'chown recursivo do diretorio pai'
fi
if grep -qF 'DRAC_BUILD_AGENT_EXPECTED:-false' "$READINESS"; then
  ok 'readiness nao exige agente de build em cliente local'
else
  nok 'agente de build opcional' 'falso aviso em cliente local'
fi
if grep -qF 'health/ready" 30 3 || fail' "$INSTALADOR" \
  && grep -qF '"$web_health_url" 20 3 || fail' "$INSTALADOR"; then
  ok 'falha de prontidao ou painel impede conclusao falsa da instalacao'
else
  nok 'prontidao obrigatoria' 'instalador declara sucesso sem painel/API'
fi

printf '\n'
if [ "$falhas" -eq 0 ]; then
  printf '\033[1;32mTodos os testes do instalador passaram.\033[0m\n\n'
  exit 0
fi
printf '\033[1;31m%s teste(s) do instalador falharam.\033[0m\n\n' "$falhas"
exit 1
