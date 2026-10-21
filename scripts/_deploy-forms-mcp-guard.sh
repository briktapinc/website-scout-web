#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
echo "CTR=$CTR"

FILES=(
  server/contactForms.js
  server/domain.js
  server/mcp.js
  src/websiteEngine.js
  src/designJobs.js
  src/mcpCatalog.js
  src/mcpParityTools.js
  src/defaultDesignInstructions.js
  scripts/_test-forms-mcp-guard.js
  scripts/_vps-verify-forms-guard.js
)

for f in "${FILES[@]}"; do
  docker exec "$CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "/root/website-scout-web/$f" "$CTR:/app/$f"
  echo "copied $f"
done

docker exec -w /app "$CTR" node -e "require('./server/contactForms'); console.log('contactForms ok')"
docker exec -w /app "$CTR" node scripts/_test-forms-mcp-guard.js

docker compose restart app
echo "waiting for listen..."
for i in $(seq 1 50); do
  if docker logs "$CTR" --tail 80 2>&1 | grep -q 'listening on'; then
    echo up
    break
  fi
  sleep 1
done

docker exec -w /app "$CTR" node scripts/_vps-verify-forms-guard.js
curl -sS -o /dev/null -w "health=%{http_code}\n" https://bitpype.com/health || true
echo DONE
