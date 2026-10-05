#!/usr/bin/env bash
set -Eeuo pipefail
# Read-only. Guest-visible capabilities are NOT remotely verified attestation.
printf 'security_profile=standard\nhardware_protected=false\n'
if command -v lscpu >/dev/null 2>&1; then
  LC_ALL=C lscpu | sed -n '/^Model name:/p; /^Hypervisor vendor:/p; /^Virtualization type:/p'
fi
for device in /dev/tdx_guest /dev/tdx-guest /dev/sev-guest /dev/tpm0 /dev/tpmrm0; do
  if [ -e "$device" ]; then printf 'device_present=%s\n' "$device"; fi
done
printf 'attestation=not_verified\n'
printf 'requirement=physical_host_inventory_and_hardware_backed_attestation\n'
