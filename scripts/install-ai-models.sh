#!/usr/bin/env bash
# Install only the validated CPU object model, offline, without quantization
# or downloading training images on a customer's production server.
set -Eeuo pipefail
DRAC_MODEL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRAC_MODEL_DEST="${1:-$DRAC_MODEL_ROOT/infra/ai-models}"
DRAC_MODEL_BUNDLE="$DRAC_MODEL_ROOT/infra/model-bundles/yolo26n-int8-20261004.tar.gz"
DRAC_MODEL_SHA=141483cf8952235870f465af74f419cba1b4a3e42a99ecbb5294fc7e51d2392d
printf '%s  %s\n' "$DRAC_MODEL_SHA" "$DRAC_MODEL_BUNDLE" | sha256sum --check --status
mkdir -p "$DRAC_MODEL_DEST"
DRAC_MODEL_STAGE="$(mktemp -d "$DRAC_MODEL_DEST/.validated-models.XXXXXXXX")"
trap 'rm -rf -- "$DRAC_MODEL_STAGE"' EXIT
tar --no-same-owner -xzf "$DRAC_MODEL_BUNDLE" -C "$DRAC_MODEL_STAGE"
for drac_size in 416 512 640; do
  drac_name="yolo26n_int8_${drac_size}_openvino_model"
  for drac_file in yolo26n.xml yolo26n.bin metadata.yaml; do
    test -s "$DRAC_MODEL_STAGE/$drac_name/$drac_file"
  done
  if [ -e "$DRAC_MODEL_DEST/$drac_name" ]; then
    # Never overwrite an existing model silently during an upgrade.
    for drac_file in yolo26n.xml yolo26n.bin metadata.yaml; do
      if ! cmp -s "$DRAC_MODEL_STAGE/$drac_name/$drac_file" "$DRAC_MODEL_DEST/$drac_name/$drac_file"; then
        printf 'Modelo existente diferente: %s/%s. Atualizacao requer revisao.\n' "$drac_name" "$drac_file" >&2
        exit 1
      fi
    done
  else
    mv "$DRAC_MODEL_STAGE/$drac_name" "$DRAC_MODEL_DEST/$drac_name"
    chmod -R a+rX "$DRAC_MODEL_DEST/$drac_name"
  fi
done
printf 'YOLO26n INT8 416/512/640 instalado e verificado.\n'
