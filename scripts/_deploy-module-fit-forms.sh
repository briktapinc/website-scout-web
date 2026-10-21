#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1 || true)
if [[ -z "${APP_CTR}" ]]; then
  echo "No website-scout-web-app container running" >&2
  exit 1
fi

FILES=(
  server/moduleFit.js
  server/contactForms.js
  server/siteModules.js
  server/domain.js
  server/mcp.js
  src/websiteEngine.js
  src/mcpCatalog.js
  src/mcpParityTools.js
  scripts/_smoke-module-fit-forms.js
)

for f in "${FILES[@]}"; do
  docker exec "$APP_CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "$f" "$APP_CTR:/app/$f"
  echo "copied $f"
done

docker restart "$APP_CTR"
echo "restarted $APP_CTR"

for i in $(seq 1 40); do
  if docker logs "$APP_CTR" --tail 40 2>&1 | grep -q 'listening on'; then
    echo "app is listening"
    break
  fi
  sleep 1
done

docker exec "$APP_CTR" node /app/scripts/_smoke-module-fit-forms.js
echo "deploy module-fit-forms OK"
