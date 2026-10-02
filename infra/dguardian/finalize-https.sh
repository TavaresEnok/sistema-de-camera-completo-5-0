#!/usr/bin/env bash
# Customer-scoped completion; invoke only after the public DNS record changes.
# No DNS/provider credentials, SSH credentials or bootstrap passwords here.
set -Eeuo pipefail
[[ $(id -u) -eq 0 ]] || { echo 'Execute como root.' >&2; exit 1; }
domain=dguardian.s2cam.com.br
expected_ip=45.176.143.184
resolved="$(getent ahostsv4 "$domain" | awk '{print $1}' | sort -u)"
if [[ "$resolved" != "$expected_ip" ]]; then
    printf 'DNS ainda aponta para %s; esperado %s. Nenhuma alteracao aplicada.\n' "${resolved:-nenhum IP}" "$expected_ip" >&2
    exit 3
fi
[[ -f /etc/nginx/dguardian-https.prepared ]] || { echo 'Configuracao HTTPS preparada ausente.' >&2; exit 1; }
[[ -f /etc/nginx/dguardian-renew-nginx.prepared ]] || { echo 'Hook de renovacao ausente.' >&2; exit 1; }
[[ -f /opt/drac/infra/.env ]] || { echo 'Instalacao ausente.' >&2; exit 1; }
certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
    --webroot -w /var/www/ajustcam-acme --cert-name "$domain" -d "$domain" --keep-until-expiring

backup_dir="$(mktemp -d /etc/nginx/dguardian-before-https.XXXXXX)"
cp -p /etc/nginx/sites-available/"$domain" "$backup_dir/nginx.conf"
cp -p /opt/drac/infra/.env "$backup_dir/runtime.env"
chmod 600 "$backup_dir/runtime.env"
install -m 644 /etc/nginx/dguardian-https.prepared /etc/nginx/sites-available/"$domain"
if ! nginx -t; then
    cp -p "$backup_dir/nginx.conf" /etc/nginx/sites-available/"$domain"
    echo 'Configuracao anterior restaurada; HTTPS nao ativado.' >&2
    exit 1
fi

# Installer helpers modify only these public endpoint keys; keep media's
# announced IP and protected secrets unchanged.
source /opt/drac/scripts/install-drac.sh
origin="https://$domain"
env_file=/opt/drac/infra/.env
env_set "$env_file" DRAC_PUBLIC_ORIGIN "$origin"
env_set "$env_file" PUBLIC_APP_URL "$origin"
env_set "$env_file" API_PUBLIC_URL "$origin/api"
env_set "$env_file" CORS_ALLOWED_ORIGINS "$origin"
env_set "$env_file" MEDIAMTX_PUBLIC_HOST "$domain"
env_set "$env_file" MEDIAMTX_PUBLIC_SCHEME https
env_set "$env_file" MEDIAMTX_PUBLIC_WEBRTC_URL "$origin/webrtc"
env_set "$env_file" MEDIAMTX_PUBLIC_HLS_URL "$origin/hls"
env_set "$env_file" MEDIAMTX_WEBRTC_ALLOW_ORIGIN "$origin"
env_set "$env_file" MEDIAMTX_HLS_ALLOW_ORIGIN "$origin"

systemctl reload nginx
cd /opt/drac
files=(-f infra/docker-compose.yml -f infra/docker-compose.prod.yml)
if [[ -n "$(env_get "$env_file" MEDIAMTX_TURN_URL)" ]]; then
    files+=(-f infra/docker-compose.gateway.yml)
fi
docker compose --env-file "$env_file" "${files[@]}" up -d --no-deps api mediamtx
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
install -m 755 /etc/nginx/dguardian-renew-nginx.prepared /etc/letsencrypt/renewal-hooks/deploy/dguardian-nginx
systemctl enable --now certbot.timer
curl --fail --silent --show-error --retry 12 --retry-connrefused --retry-delay 5 \
    --resolve "$domain:443:127.0.0.1" "$origin/api/health/ready"
printf '\nHTTPS ativado em %s. Backup protegido em %s.\n' "$origin" "$backup_dir"
