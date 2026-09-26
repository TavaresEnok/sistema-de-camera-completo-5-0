#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# TESTE DE INSTALAÇÃO LIMPA — o gate que faltava.
#
# Sobe uma MÁQUINA VIRGEM, roda o instalador do zero SEM NINGUÉM NA FRENTE, e
# passa a bateria de verificação. É o único teste que exercita o caminho real
# do cliente: nada de /home/flashnet, nada de Central já rodando, nada de
# banco com tabelas que chegaram por `db push`, nada de portas já ligadas.
#
# Os 12 defeitos da primeira instalação de cliente (07/08/2026) eram todos
# invisíveis na máquina de quem desenvolve e todos apareceriam aqui.
#
#   bash scripts/teste-instalacao-limpa.sh                 # HEAD atual
#   bash scripts/teste-instalacao-limpa.sh --commit <sha>
#   bash scripts/teste-instalacao-limpa.sh --manter        # não destrói no fim
#
# Requisitos: Docker no host. A máquina virgem é um container Ubuntu
# privilegiado com systemd de verdade (PID 1) — o instalador precisa instalar
# o Docker dele e agendar o watchdog por systemd timer, como faz num servidor.
# ════════════════════════════════════════════════════════════════════════════
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAQUINA="drac-maquina-virgem"
IMAGEM="drac-maquina-virgem:ubuntu24"
VOLUME_DOCKER="drac-maquina-virgem-docker"
VOLUME_CONTAINERD="drac-maquina-virgem-containerd"
COMMIT=""
MANTER=false
SENHA_ADMIN="Teste-instalacao-limpa-2026"

log()   { printf '\033[1;36m[teste]\033[0m %s\n' "$*"; }
erro()  { printf '\033[1;31m[teste]\033[0m %s\n' "$*" >&2; }
titulo(){ printf '\n\033[1m══ %s\033[0m\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT="$2"; shift 2 ;;
    --manter) MANTER=true; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) erro "Opcao desconhecida: $1"; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { erro "Docker e necessario no host."; exit 2; }

# ── O commit precisa estar PUBLICADO ────────────────────────────────────────
# O instalador clona do GitHub num commit fixo; testar um commit que só existe
# na sua máquina daria "not our ref" depois de minutos de espera.
[ -n "$COMMIT" ] || COMMIT="$(git -C "$RAIZ" rev-parse HEAD)"
titulo "Commit sob teste"
log "$COMMIT"
if ! git -C "$RAIZ" branch -r --contains "$COMMIT" 2>/dev/null | grep -q .; then
  erro "O commit $COMMIT nao esta em nenhum branch remoto."
  erro "O instalador clona do GitHub: publique-o antes (git push)."
  exit 1
fi
log "commit publicado, o instalador conseguira busca-lo"

limpar() {
  if [ "$MANTER" = true ]; then
    log "Maquina virgem MANTIDA: docker exec -it $MAQUINA bash"
    return
  fi
  log "Destruindo a maquina virgem"
  docker rm -f "$MAQUINA" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME_DOCKER" "$VOLUME_CONTAINERD" >/dev/null 2>&1 || true
}
trap limpar EXIT

# ── A máquina virgem ────────────────────────────────────────────────────────
titulo "Preparando a maquina virgem"
docker rm -f "$MAQUINA" >/dev/null 2>&1 || true
docker volume rm "$VOLUME_DOCKER" "$VOLUME_CONTAINERD" >/dev/null 2>&1 || true

# Só o mínimo de um Ubuntu recém-instalado: systemd, sudo e o suficiente para
# baixar o instalador. Docker NÃO vem pronto — quem instala é o instalador.
docker build -q -t "$IMAGEM" - >/dev/null <<'DOCKERFILE'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus sudo curl ca-certificates gnupg iproute2 openssl python3 \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN printf '%%sudo ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/90-teste \
 && chmod 440 /etc/sudoers.d/90-teste
# A imagem oficial do Ubuntu traz /usr/sbin/policy-rc.d devolvendo 101 para
# impedir que pacotes iniciem serviços durante a construção de imagens. Num
# SERVIDOR de verdade isso não existe: o apt sobe o docker.service sozinho.
# Mantê-lo faria a máquina virgem mentir sobre o comportamento real.
RUN rm -f /usr/sbin/policy-rc.d
CMD ["/sbin/init"]
DOCKERFILE
log "imagem da maquina virgem pronta"

docker run -d --name "$MAQUINA" --privileged \
  --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock \
  -v "$VOLUME_DOCKER:/var/lib/docker" \
  -v "$VOLUME_CONTAINERD:/var/lib/containerd" \
  "$IMAGEM" >/dev/null

log "aguardando o systemd da maquina virgem"
for _ in $(seq 1 30); do
  estado="$(docker exec "$MAQUINA" systemctl is-system-running 2>/dev/null || true)"
  case "$estado" in running|degraded) break ;; esac
  sleep 1
done
[ -n "${estado:-}" ] || { erro "systemd nao subiu na maquina virgem"; exit 1; }
log "systemd: $estado"

docker exec "$MAQUINA" bash -c 'id operador >/dev/null 2>&1 || (useradd -m -s /bin/bash operador && usermod -aG sudo operador)'

# A instalação limpa precisa provar o contrato com a Central sem cadastrar um
# cliente fictício na Central de produção e sem depender de segredo do CI. O
# mock só aceita o heartbeat exigido pelo instalador; qualquer outro caminho
# devolve 404. Antes disto o gate começou a reprovar com 403 assim que o
# instalador passou corretamente a exigir matrícula válida — o teste estava
# usando uma licença inventada contra a Central real.
docker exec -i "$MAQUINA" bash -c 'cat > /root/mock-central.py' <<'PY'
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def _json(self, status, body):
        payload = body.encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path in ("/", "/api/health"):
            self._json(200, '{"status":"ok"}')
        else:
            self._json(404, '{"error":"not_found"}')

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        if length:
            self.rfile.read(length)
        if self.path == "/api/agent/heartbeat":
            self._json(200, '{"license":{"status":"ACTIVE"},"commands":[]}')
        else:
            self._json(404, '{"error":"not_found"}')

ThreadingHTTPServer(("127.0.0.1", 9765), Handler).serve_forever()
PY
docker exec "$MAQUINA" bash -c 'cat > /etc/systemd/system/drac-mock-central.service <<"UNIT"
[Unit]
Description=Central isolada do gate de instalação limpa
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /root/mock-central.py
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now drac-mock-central.service'
for _ in $(seq 1 20); do
  docker exec "$MAQUINA" curl -fsS http://127.0.0.1:9765/api/health >/dev/null 2>&1 && break
  sleep 0.2
done
docker exec "$MAQUINA" curl -fsS http://127.0.0.1:9765/api/health >/dev/null \
  || { erro "mock isolado da Central nao subiu"; exit 1; }

# ── Arquivo de respostas ────────────────────────────────────────────────────
titulo "Arquivo de respostas"
docker exec -i "$MAQUINA" bash -c 'cat > /root/cliente.env && chmod 600 /root/cliente.env' <<EOF
DRAC_INSTALLER_COMMIT=$COMMIT
DRAC_CUSTOMER_NAME=Cliente de Teste
DRAC_INSTALLATION_ID=teste-instalacao-limpa
DRAC_CENTRAL_URL=http://127.0.0.1:9765
DRAC_CAMERA_ALLOWED_CIDRS=192.168.99.0/24
DRAC_SERVER_IP=127.0.0.1
DRAC_OPERATING_USER=operador
DRAC_ADMIN_EMAIL=admin@teste.local
DRAC_ADMIN_USERNAME=admin_teste
DRAC_ADMIN_PASSWORD=$SENHA_ADMIN
DRAC_BUILD_AGENT_EXPECTED=false
EOF
log "gravado em /root/cliente.env (nenhuma pergunta sera feita)"

# ── A instalação ────────────────────────────────────────────────────────────
titulo "Instalando (do zero, sem intervencao)"
log "isto constroi as imagens do zero e leva varios minutos"
docker exec "$MAQUINA" bash -c "curl -fsSL 'https://raw.githubusercontent.com/TavaresEnok/sistema-de-camera-completo-5-0/${COMMIT}/scripts/install-drac.sh' -o /root/install-drac.sh" \
  || { erro "nao consegui baixar o instalador do commit $COMMIT"; exit 1; }

# stdin fechado DE PROPÓSITO: prova que a instalação nunca depende de alguém
# respondendo. Se algo tentar perguntar, tem de falhar dizendo o nome da
# variável — nunca travar.
if docker exec "$MAQUINA" bash -c 'bash /root/install-drac.sh --config /root/cliente.env < /dev/null' 2>&1 | tail -40; then
  log "instalador terminou com sucesso"
else
  erro "O INSTALADOR FALHOU. Acima esta o motivo (ele agora sempre diz)."
  exit 1
fi

# ── A bateria ───────────────────────────────────────────────────────────────
titulo "Verificando a instalacao"
docker cp "$RAIZ/scripts/verificar-instalacao.sh" "$MAQUINA:/root/verificar.sh" >/dev/null
if docker exec "$MAQUINA" bash -c "DRAC_ADMIN_USERNAME=admin_teste DRAC_ADMIN_PASSWORD='$SENHA_ADMIN' bash /root/verificar.sh --dir /opt/drac"; then
  titulo "RESULTADO"
  printf '\033[1;32mInstalacao limpa PASSOU: o instalador entrega um sistema utilizavel sozinho.\033[0m\n\n'
  exit 0
fi
titulo "RESULTADO"
erro "A instalacao subiu mas a verificacao reprovou (detalhes acima)."
exit 1
