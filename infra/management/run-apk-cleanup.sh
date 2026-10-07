#!/bin/bash
set -euo pipefail
repo=/opt/ajustcam-management/repo
worktrees=/opt/ajustcam-management/build-worktrees
source_root=/opt/ajustcam-management/vendor-source/runtime-20261005
# Resolve the approved version from the live Central. Never print/store tokens;
# if the Central is unavailable, do not delete anything.
approved_commit="$(docker exec -i ajustcam-central node <<'JS'
(async()=>{
  const r=await fetch('http://127.0.0.1:9765/api/admin/releases',{
    headers:{Authorization:'Bearer '+process.env.DRAC_CENTRAL_ADMIN_TOKEN},
    signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error('A Central não respondeu; limpeza cancelada.');
  const data=await r.json();const commit=data.atual?.commit;
  if(!/^[0-9a-f]{40}$/i.test(commit||''))throw Error('Versão aprovada não encontrada; limpeza cancelada.');
  console.log(commit);
})().catch(error=>{console.error(error.message);process.exitCode=1});
JS
)"
[[ "$approved_commit" =~ ^[0-9a-f]{40}$ ]] || exit 1
# Same lock as the live build-agent; skip, rather than interrupt, active builds.
runuser -u management -- /usr/bin/node \
  "$source_root/apps/mobile/scripts/build-maintenance.mjs" \
  --repo "$repo" --worktrees "$worktrees" \
  --state "$repo/apps/mobile/builds/agent-state.json" \
  --approved "$approved_commit" --apply
