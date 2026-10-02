#!/bin/sh
set -eu
umask 077
lineage=/opt/ajustcam-gateway/certbot/conf/live/turn.s2cam.com.br
destination=/opt/ajustcam-gateway/coturn/tls

# Do not install an expired, mismatched or unrelated certificate.
openssl x509 -in "$lineage/fullchain.pem" -noout -checkend 86400 >/dev/null
openssl x509 -in "$lineage/fullchain.pem" -noout -checkhost turn.s2cam.com.br >/dev/null
cert_public=$(openssl x509 -in "$lineage/fullchain.pem" -pubkey -noout | openssl sha256)
key_public=$(openssl pkey -in "$lineage/privkey.pem" -pubout | openssl sha256)
[ "$cert_public" = "$key_public" ]

# The API/web private keys are not shared with Coturn. Only this dedicated key.
install -d -o root -g 165534 -m 0750 "$destination"
install -o root -g 165534 -m 0640 "$lineage/fullchain.pem" "$destination/fullchain.pem.new"
install -o root -g 165534 -m 0640 "$lineage/privkey.pem" "$destination/privkey.pem.new"
mv -f "$destination/fullchain.pem.new" "$destination/fullchain.pem"
mv -f "$destination/privkey.pem.new" "$destination/privkey.pem"

if [ "${1:-}" != "--no-reload" ]; then
  # Coturn reloads TLS certificates with SIGUSR2; existing relays stay alive.
  docker kill --signal=USR2 ajustcam-gateway-coturn >/dev/null
fi
