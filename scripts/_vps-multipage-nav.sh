#!/usr/bin/env bash
set -euo pipefail
cd /root/website-scout-web
APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
test -n "$APP_CTR"
for f in src/websiteEngine.js src/defaultDesignInstructions.js scripts/_test-preview-nav.js scripts/_repair-multipage-nav.js; do
  docker exec "$APP_CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "/root/website-scout-web/$f" "$APP_CTR:/app/$f"
done
docker compose restart app
APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
for i in $(seq 1 20); do
  if docker logs "$APP_CTR" --tail 60 2>&1 | grep -q 'listening on'; then
    echo "app up"
    break
  fi
  sleep 2
done
docker compose exec -T app node scripts/_test-preview-nav.js
docker compose exec -T app node scripts/_repair-multipage-nav.js 1 --publish
echo "vps-multipage-nav done"
