#!/usr/bin/env bash
set -Eeuo pipefail

# Agente de operação da frota. Executa NO HOST da instalação e só aceita uma
# ação da lista abaixo, buscada por HTTPS na Central. Não recebe shell, Docker
# socket remoto, senha de SSH nem comando arbitrário do painel.

CONFIG_FILE="${DRAC_OPS_CONFIG_FILE:-/etc/drac/ops-agent.env}"
[ -r "$CONFIG_FILE" ] || exit 0
# shellcheck disable=SC1090
. "$CONFIG_FILE"

: "${DRAC_OPS_CENTRAL_URL:?DRAC_OPS_CENTRAL_URL ausente}"
: "${DRAC_OPS_INSTALLATION_ID:?DRAC_OPS_INSTALLATION_ID ausente}"
: "${DRAC_OPS_LICENSE_KEY:?DRAC_OPS_LICENSE_KEY ausente}"
DRAC_OPS_ROOT_DIR="${DRAC_OPS_ROOT_DIR:-/opt/drac}"
DRAC_OPS_LOG_DIR="${DRAC_OPS_LOG_DIR:-/var/log/drac}"
DRAC_OPS_STATE_DIR="${DRAC_OPS_STATE_DIR:-/var/lib/drac-ops}"
mkdir -p "$DRAC_OPS_LOG_DIR"
chmod 700 "$DRAC_OPS_LOG_DIR"
# O serviço usa ProtectHome=true. Sem um DOCKER_CONFIG fora de /root, um
# `docker compose build` tenta criar /root/.docker e a atualização falha no
# rollback/build mesmo tendo acesso ao daemon. /var é explicitamente gravável
# com ProtectSystem=full; esse diretório é privado do agente.
mkdir -p "$DRAC_OPS_STATE_DIR/docker"
chmod 700 "$DRAC_OPS_STATE_DIR" "$DRAC_OPS_STATE_DIR/docker"
export DOCKER_CONFIG="${DOCKER_CONFIG:-$DRAC_OPS_STATE_DIR/docker}"

central="${DRAC_OPS_CENTRAL_URL%/}"
headers=(-H "X-DRAC-Installation-Id: $DRAC_OPS_INSTALLATION_ID" -H "X-DRAC-License-Key: $DRAC_OPS_LICENSE_KEY")

claim="$(curl --fail --silent --show-error --max-time 20 -X POST "${headers[@]}" "$central/api/agent/operations/claim")"
[ -n "$claim" ] || { echo 'Central respondeu sem corpo ao consultar operações.' >&2; exit 1; }

readarray -t fields < <(printf '%s' "$claim" | python3 -c '
import json, sys
op = (json.load(sys.stdin).get("operation") or {})
for key in ("id", "action", "leaseToken", "targetCommit"):
    print(str(op.get(key) or ""))
')
operation_id="${fields[0]:-}"
action="${fields[1]:-}"
lease_token="${fields[2]:-}"
target_commit="${fields[3]:-}"
[ -n "$operation_id" ] && [ -n "$lease_token" ] || exit 0

run_container_restart() {
  local container="$1"
  if ! docker inspect "$container" >/dev/null 2>&1; then
    printf '%s não está instalado nesta máquina; nenhuma ação necessária.\n' "$container"
    return 0
  fi
  docker restart "$container"
}

run_action() {
  case "$action" in
    update)
      # O atualizador já confere a release aprovada, preserva overlays,
      # cria backup e executa rollback caso a validação reprove.
      [ -n "$target_commit" ] || { echo 'Atualização recusada: release alvo ausente.'; return 2; }
      # O timer roda como root, mas /opt/drac pertence ao usuário operador.
      # Git 2.35+ recusa isso por segurança ("dubious ownership") e a
      # atualização morria ANTES do fetch. A exceção é deliberadamente o
      # diretório exato configurado, nunca um curinga.
      git config --global --add safe.directory "$DRAC_OPS_ROOT_DIR"
      # Alguns instaladores tornam o script do agente executável ao copiá-lo.
      # Isso é só bit de arquivo, não conteúdo. Ignorar SOMENTE filemode evita
      # que uma atualização segura pare por 100644→100755, mas qualquer edição
      # real continua deixando a árvore suja e é bloqueada pelo atualizador.
      git -C "$DRAC_OPS_ROOT_DIR" config core.filemode false
      DRAC_UPDATE_ALLOW_DIRTY=false bash "$DRAC_OPS_ROOT_DIR/scripts/atualizar-instalacao.sh"
      ;;
    restart_web) run_container_restart vms-web ;;
    restart_api) run_container_restart vms-api ;;
    restart_mediamtx) run_container_restart vms-mediamtx ;;
    restart_rtmp) run_container_restart vms-rtmp-ingest ;;
    restart_ai) run_container_restart vms-ai-service ;;
    restart_stack)
      # Banco e volumes NÃO entram. Reiniciamos somente os serviços da aplicação
      # numa ordem que preserva ingestão e permite a API voltar por último.
      run_container_restart vms-rtmp-ingest
      run_container_restart vms-mediamtx
      run_container_restart vms-ai-service
      run_container_restart vms-api
      run_container_restart vms-web
      ;;
    restart_docker)
      systemctl restart docker
      for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done
      docker info >/dev/null
      ;;
    *) echo "Ação recusada pelo agente: $action"; return 64 ;;
  esac
}

log_file="$DRAC_OPS_LOG_DIR/operation-${operation_id}.log"
set +e
run_action >"$log_file" 2>&1
exit_code=$?
set -e
result="$(tail -c 3800 "$log_file" 2>/dev/null || true)"
[ -n "$result" ] || result='Operação concluída sem saída adicional.'
status='SUCCEEDED'; error=''
if [ "$exit_code" -ne 0 ]; then
  status='FAILED'
  error="Ação terminou com código ${exit_code}."
fi

payload="$(python3 - "$lease_token" "$status" "$result" "$error" <<'PY'
import json, sys
print(json.dumps({"leaseToken": sys.argv[1], "status": sys.argv[2], "result": sys.argv[3], "error": sys.argv[4]}))
PY
)"
curl --fail --silent --show-error --max-time 20 -X POST "${headers[@]}" \
  -H 'Content-Type: application/json' --data-binary "$payload" \
  "$central/api/agent/operations/${operation_id}/result" >/dev/null || true

exit "$exit_code"
