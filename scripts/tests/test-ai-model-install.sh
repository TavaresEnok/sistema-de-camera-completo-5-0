#!/usr/bin/env bash
set -Eeuo pipefail
drac_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
drac_test_dir="$(mktemp -d)"
trap 'rm -rf -- "$drac_test_dir"' EXIT
bash "$drac_root/scripts/install-ai-models.sh" "$drac_test_dir/models"
bash "$drac_root/scripts/install-ai-models.sh" "$drac_test_dir/models"
test "$(find "$drac_test_dir/models" -type f | wc -l)" -eq 9
test "$(find "$drac_test_dir/models" -type d -name '.validated-models.*' | wc -l)" -eq 0
truncate -s 1 "$drac_test_dir/models/yolo26n_int8_416_openvino_model/yolo26n.bin"
if bash "$drac_root/scripts/install-ai-models.sh" "$drac_test_dir/models"; then
  printf 'FAIL: existing mismatched model was silently accepted\n' >&2
  exit 1
fi
test "$(stat -c %s "$drac_test_dir/models/yolo26n_int8_416_openvino_model/yolo26n.bin")" -eq 1
grep -qF 'run_sudo bash "$DRAC_INSTALL_DIR/scripts/install-ai-models.sh"' "$drac_root/scripts/install-drac.sh"
printf 'PASS: fresh offline models, idempotency, mismatch protection, installer integration\n'
