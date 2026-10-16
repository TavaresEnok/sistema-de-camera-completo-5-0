#!/usr/bin/env bash
set -euo pipefail
task_root="$(realpath "$1")"
task_output="$(realpath "$2")"
task_image="$3"
docker run --rm --cpus=2 --memory=2g \
  --mount "type=bind,src=$task_root/apps/web/src,dst=/app/apps/web/src,readonly" \
  --mount "type=bind,src=$task_root/apps/web/public,dst=/app/apps/web/public,readonly" \
  --mount "type=bind,src=$task_root/apps/web/build,dst=/app/apps/web/build,readonly" \
  --mount "type=bind,src=$task_root/apps/central/public,dst=/app/apps/central/public,readonly" \
  --mount "type=bind,src=$task_root/apps/web/index.html,dst=/app/apps/web/index.html,readonly" \
  --mount "type=bind,src=$task_root/apps/web/vite.config.ts,dst=/app/apps/web/vite.config.ts,readonly" \
  --mount "type=bind,src=$task_root/apps/web/tailwind.config.js,dst=/app/apps/web/tailwind.config.js,readonly" \
  --mount "type=bind,src=$task_root/apps/web/tsconfig.json,dst=/app/apps/web/tsconfig.json,readonly" \
  --mount "type=bind,src=$task_output,dst=/output" \
  --workdir /app/apps/web --entrypoint sh "$task_image" \
  -c 'node node_modules/typescript/bin/tsc --noEmit && node node_modules/vite/bin/vite.js build --outDir /output'
