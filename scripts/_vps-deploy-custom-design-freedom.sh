#!/usr/bin/env bash
set -euo pipefail
cd /root/website-scout-web

APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
if [ -z "$APP_CTR" ]; then
  echo "No website-scout-web-app container running" >&2
  exit 1
fi

FILES=(
  src/imageCrop.js
  src/pageContentScan.js
  src/websiteEngine.js
  src/siteStructure.js
  src/siteScreenshots.js
  src/mcpCatalog.js
  src/mcpParityTools.js
  src/defaultDesignInstructions.js
  server/siteModules.js
  server/contactForms.js
  server/domain.js
  server/mcp.js
  scripts/_smoke-custom-design-freedom.js
)

for f in "${FILES[@]}"; do
  docker exec "$APP_CTR" mkdir -p "/app/$(dirname "$f")"
  echo "docker cp $f -> ${APP_CTR}:/app/$f"
  docker cp "/root/website-scout-web/$f" "${APP_CTR}:/app/$f"
done

docker compose restart app
APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
for i in $(seq 1 40); do
  if docker logs "$APP_CTR" --tail 100 2>&1 | grep -q 'listening on'; then
    echo "app listening"
    break
  fi
  sleep 1
done

docker exec "$APP_CTR" node /app/scripts/_smoke-custom-design-freedom.js
echo "deploy-custom-design-freedom done"
