#!/usr/bin/env bash
# Use only through the vendor's authenticated installation/migration channel.
# No downloads of unpinned trust keys and no output of private key material.
set -Eeuo pipefail
umask 077
target="${1:?Usage: provision-license.sh DIRECTORY TRUSTED-KEYS.json}"
trust="${2:?Provide the Central public keys from a verified release}"
case "$target" in /*) ;; *) echo 'License directory must be absolute.' >&2; exit 1;; esac
[ "$target" != '/' ] && [ "$target" != '/opt' ] && [ "$target" != '/opt/drac' ] || exit 1
[ -f "$trust" ] && [ ! -L "$trust" ] || exit 1
[ ! -L "$target" ] || exit 1
mkdir -p "$target"
chmod 700 "$target"
if [ ! -e "$target/device.pem" ]; then
  openssl genpkey -algorithm ED25519 -out "$target/device.pem" 2>/dev/null
fi
[ ! -L "$target/device.pem" ] || exit 1
openssl pkey -in "$target/device.pem" -check -noout >/dev/null 2>&1
install -m 600 "$trust" "$target/trusted-keys.json"
chmod 600 "$target/device.pem"
# API and Central run as UID 1000; no chmod 644 workaround for private keys.
if [ "$(id -u)" -eq 0 ]; then chown -R 1000:1000 "$target"; fi
echo 'Per-installation identity ready. No private key was displayed.'
