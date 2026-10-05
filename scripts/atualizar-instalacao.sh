#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# ATUALIZAR ESTA INSTALAÇÃO PARA A VERSÃO APROVADA — roda no servidor do cliente.
#
# Pergunta à Central qual é a versão aprovada, atualiza, e VERIFICA. Se a
# verificação reprovar, volta sozinho para a versão anterior.
#
#   bash scripts/atualizar-instalacao.sh              # atualiza se houver o quê
#   bash scripts/atualizar-instalacao.sh --conferir   # só diz em que versão está
#   bash scripts/atualizar-instalacao.sh --sem-volta  # não desfaz se reprovar
#
# ATENÇÃO ao voltar atrás: o CÓDIGO volta, as MIGRAÇÕES de banco não. O Prisma
# não desfaz migração. Na prática as migrações são aditivas e o código antigo
# convive com elas, mas isto precisa estar dito: voltar não é uma máquina do
# tempo. Por isso o backup do banco é feito ANTES de qualquer coisa.
#
# A conexão é sempre DAQUI para a Central — nada de porta aberta na instalação,
# que estaria atrás de NAT na maioria dos clientes.
# ════════════════════════════════════════════════════════════════════════════
set -uo pipefail

RAIZ="${DRAC_INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
if [ -f "$RAIZ/.runtime-release.json" ]; then
  exec python3 "$RAIZ/scripts/security/update-runtime.py" "$RAIZ" "$@"
fi
if [ -f "$RAIZ/infra/docker-compose.license-security.yml" ]; then
  printf 'Esta instalação exige uma atualização por pacote assinado; Git não será usado.\n' >&2
  if [ "${1:-}" = '--conferir' ]; then exit 0; fi
  exit 1
fi
CONFERIR=false
SEM_VOLTA=false

log()    { printf '\033[1;36m[atualizar]\033[0m %s\n' "$*"; }
erro()   { printf '\033[1;31m[atualizar]\033[0m %s\n' "$*" >&2; }
aviso()  { printf '\033[1;33m[atualizar]\033[0m %s\n' "$*"; }
titulo() { printf '\n\033[1m══ %s\033[0m\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --conferir) CONFERIR=true; shift ;;
    --sem-volta) SEM_VOLTA=true; shift ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) erro "Opcao desconhecida: $1"; exit 2 ;;
  esac
done

env_get() { sed -nE "s/^$1=(.*)$/\1/p" "$RAIZ/infra/.env" 2>/dev/null | tail -n 1; }
CENTRAL_URL="$(env_get CLOUD_API_URL)"
INSTALACAO="$(env_get CLOUD_INSTALLATION_ID)"
LICENCA="$(env_get CLOUD_LICENSE_KEY)"

[ -n "$CENTRAL_URL" ] && [ -n "$INSTALACAO" ] && [ -n "$LICENCA" ] \
  || { erro "Faltam CLOUD_API_URL / CLOUD_INSTALLATION_ID / CLOUD_LICENSE_KEY em $RAIZ/infra/.env"; exit 1; }

# ── O que a Central diz ─────────────────────────────────────────────────────
titulo "Consultando a Central"
RESPOSTA="$(curl -fsS --max-time 20 \
  -H "X-DRAC-Installation-Id: $INSTALACAO" \
  -H "X-DRAC-License-Key: $LICENCA" \
  "${CENTRAL_URL%/}/api/agent/status" 2>&1)" \
  || { erro "Não consegui falar com a Central em ${CENTRAL_URL%/}: $RESPOSTA"; exit 1; }

ler_release() { printf '%s' "$RESPOSTA" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('release') or {}
print(d.get('$1') or '')
" 2>/dev/null; }

APROVADO="$(ler_release commit)"
SITUACAO="$(ler_release situacao)"
ATUAL="$(git -C "$RAIZ" rev-parse HEAD 2>/dev/null || echo '')"

log "instalação: $INSTALACAO"
log "aqui:       ${ATUAL:-desconhecida}"
log "aprovada:   ${APROVADO:-<nenhuma promovida ainda>}"
log "situação:   ${SITUACAO:-?}"

if [ -z "$APROVADO" ]; then
  aviso "A Central ainda não tem versão aprovada. Nada a fazer."
  aviso "Na matriz, rode: bash scripts/promover-release.sh"
  exit 0
fi
if [ "$ATUAL" = "$APROVADO" ]; then
  log "Já está na versão aprovada."
  exit 0
fi
if [ "$CONFERIR" = true ]; then
  aviso "Há atualização disponível. Rode sem --conferir para aplicar."
  exit 0
fi

# ── Rede de segurança ANTES de mexer ────────────────────────────────────────
titulo "Backup do banco antes de qualquer mudança"
CARIMBO="$(date -u +%Y%m%dT%H%M%SZ)"

# `infra/storage` nasce do ROOT — quem o cria são os containers — e este script
# roda como o usuário operador. Sem tratar isso, o backup falhava e a
# atualização abortava (corretamente, mas por um motivo bobo). Mesmo defeito de
# classe que derrubou o watchdog no primeiro disparo.
#
# Ordem: o lugar certo; senão o lugar certo via sudo; senão a casa do operador,
# DIZENDO onde foi parar. Backup em lugar inesperado é muito melhor que
# atualização sem backup.
DIR_BACKUP="$RAIZ/infra/storage/backups"
if ! mkdir -p "$DIR_BACKUP" 2>/dev/null; then
  if sudo -n mkdir -p "$DIR_BACKUP" 2>/dev/null \
     && sudo -n chown "$(id -u):$(id -g)" "$DIR_BACKUP" 2>/dev/null; then
    log "diretório de backup criado com sudo"
  else
    DIR_BACKUP="${HOME:-/tmp}/drac-backups"
    mkdir -p "$DIR_BACKUP" 2>/dev/null || { erro "Sem onde gravar o backup."; exit 1; }
    aviso "Sem permissão em $RAIZ/infra/storage; o backup vai para $DIR_BACKUP"
  fi
fi
BACKUP="$DIR_BACKUP/pre-atualizacao-$CARIMBO.sql"
PG_USER="$(env_get POSTGRES_USER)"; PG_DB="$(env_get POSTGRES_DB)"
COMPOSE=(docker compose --env-file "$RAIZ/infra/.env" -f "$RAIZ/infra/docker-compose.yml" -f "$RAIZ/infra/docker-compose.prod.yml")
# Tenant atrás da Gateway depende deste overlay para anunciar o TURN com
# credenciais temporárias. O atualizador antigo esquecia o arquivo e removia a
# política ICE no primeiro upgrade, embora o painel continuasse saudável.
if { [ "$(env_get DRAC_GATEWAY_MODE)" = "true" ] || [ -n "$(env_get MEDIAMTX_TURN_URL)" ]; } \
   && [ -f "$RAIZ/infra/docker-compose.gateway.yml" ]; then
  COMPOSE+=(-f "$RAIZ/infra/docker-compose.gateway.yml")
  log "Gateway/TURN habilitada: overlay preservado na atualização."
fi
# Host com GPU: soma o overlay de transcode SEMPRE, senão um rebuild/up desta
# atualização reverteria o MediaMTX para a imagem sem NVENC. `-f` explícito
# ignora o COMPOSE_FILE do .env, então a decisão precisa ser tomada aqui também.
if [ "$(env_get DRAC_GPU_ENABLED)" = "true" ] && [ -f "$RAIZ/infra/docker-compose.gpu.yml" ]; then
  COMPOSE+=(-f "$RAIZ/infra/docker-compose.gpu.yml")
  log "GPU habilitada neste host: overlay de transcode incluído."
fi
if "${COMPOSE[@]}" exec -T postgres pg_dump -U "$PG_USER" "$PG_DB" > "$BACKUP" 2>/dev/null && [ -s "$BACKUP" ]; then
  log "backup: $BACKUP ($(du -h "$BACKUP" | cut -f1))"
else
  erro "Não consegui fazer backup do banco. Atualizar sem rede de segurança não vale o risco."
  rm -f "$BACKUP"
  exit 1
fi

aplicar_versao() {
  local commit="$1"
  git -C "$RAIZ" fetch --quiet --depth 1 origin "$commit" || return 1
  git -C "$RAIZ" checkout --quiet --detach "$commit" || return 1

  # A versão que a instalação REPORTA à Central vem de DRAC_VERSION no .env,
  # escrita pelo instalador — não do git. Sem atualizar isto, o código muda e a
  # instalação continua se dizendo na versão antiga: a Central a mostraria como
  # atrasada para sempre e alguém rodaria esta atualização em laço.
  #
  # Tem de vir ANTES do `up`, senão os containers sobem com o valor velho.
  if grep -qE '^DRAC_VERSION=' "$RAIZ/infra/.env" 2>/dev/null; then
    sed -i -E "s|^DRAC_VERSION=.*|DRAC_VERSION=$commit|" "$RAIZ/infra/.env" || return 1
  else
    printf 'DRAC_VERSION=%s\n' "$commit" >> "$RAIZ/infra/.env" || return 1
  fi

  "${COMPOSE[@]}" up -d --build || return 1
  "${COMPOSE[@]}" exec -T -w /app/apps/api api npx prisma migrate deploy || return 1
  return 0
}

titulo "Atualizando para $APROVADO"
if ! aplicar_versao "$APROVADO"; then
  erro "A atualização falhou no meio do caminho."
  if [ "$SEM_VOLTA" = false ] && [ -n "$ATUAL" ]; then
    aviso "Voltando para $ATUAL"
    aplicar_versao "$ATUAL" || erro "A VOLTA TAMBÉM FALHOU. Intervenção manual necessária. Backup em $BACKUP"
  fi
  exit 1
fi

# ── Só é atualização se continuar funcionando ───────────────────────────────
titulo "Verificando"
if bash "$RAIZ/scripts/verificar-instalacao.sh" --dir "$RAIZ"; then
  titulo "RESULTADO"
  printf '\033[1;32mAtualizada e verificada: %s\033[0m\n' "$APROVADO"
  log "backup do banco preservado em $BACKUP"
  exit 0
fi

erro "A instalação subiu mas a VERIFICAÇÃO REPROVOU."
if [ "$SEM_VOLTA" = true ]; then
  aviso "--sem-volta: a versão nova fica no ar, reprovada. Decida o que fazer."
  exit 1
fi

titulo "Voltando para a versão anterior"
aviso "O CÓDIGO volta; as migrações de banco JÁ APLICADAS não são desfeitas."
aviso "Se algo depender disso, restaure: $BACKUP"
if aplicar_versao "$ATUAL"; then
  log "voltou para $ATUAL"
  bash "$RAIZ/scripts/verificar-instalacao.sh" --dir "$RAIZ" >/dev/null 2>&1 \
    && log "a versão anterior está sadia" \
    || erro "a versão anterior TAMBÉM não passa na bateria — havia problema antes desta atualização"
else
  erro "A VOLTA FALHOU. Intervenção manual necessária. Backup em $BACKUP"
fi
exit 1
