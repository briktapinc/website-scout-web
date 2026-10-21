#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
if [ -z "$APP_CTR" ]; then
  echo "No website-scout-web-app container running" >&2
  exit 1
fi

FILES=(
  src/zipFolder.js
  server/domain.js
  server/routes/domainApi.js
  public/js/api.js
  public/js/app.js
  public/index.html
  scripts/_verify-export-zip.js
)

for f in "${FILES[@]}"; do
  docker exec "$APP_CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "$f" "$APP_CTR:/app/$f"
  echo "copied $f"
done

docker compose restart app
echo "waiting for listen..."
for i in $(seq 1 40); do
  if docker logs "$APP_CTR" --tail 40 2>&1 | grep -q 'listening on'; then
    echo "up"
    break
  fi
  sleep 1
done

docker exec "$APP_CTR" node /app/scripts/_verify-export-zip.js

echo "--- live UI cache-bust ---"
curl -sS https://bitpype.com/ | grep -oE 'api\.js\?v=[^"]+|app\.js\?v=[^"]+' | sort -u || true
echo DONE
