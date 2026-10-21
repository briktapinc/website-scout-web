#!/usr/bin/env bash
set -euo pipefail
ROOT=/root/website-scout-web
CTR=website-scout-web-app-1

cd "$ROOT"

files=(
  server/portalContacts.js
  server/idempotency.js
  server/openapiV1.js
  server/contactForms.js
  server/siteModules.js
  server/clientPortal.js
  server/clientMcp.js
  server/mcp.js
  server/domain.js
  server/routes/portal.js
  server/routes/domainApi.js
  server.js
  src/websiteEngine.js
  src/mcpCatalog.js
  src/mcpParityTools.js
  public/js/portal.js
  public/portal.html
  public/portal.vps.html
)

for f in "${files[@]}"; do
  echo "docker cp $f -> $CTR:/app/$f"
  docker exec "$CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "$ROOT/$f" "$CTR:/app/$f"
done

echo 'Restarting app...'
cd "$ROOT" && docker compose restart app
echo 'waiting for listen...'
for i in $(seq 1 40); do
  if docker logs "$CTR" --tail 40 2>&1 | grep -q 'listening on'; then
    echo up
    break
  fi
  sleep 1
done

echo 'Health:'
curl -sS https://bitpype.com/api/v1/health || true
echo
echo 'OpenAPI:'
curl -sS https://bitpype.com/api/v1/openapi.json | head -c 240 || true
echo
curl -sS https://bitpype.com/portal | grep -oE 'LeadScout|leadscout' | sort -u || true
curl -sS https://bitpype.com/js/portal.js | grep -c 'loadLeadScout' || true
echo DONE
