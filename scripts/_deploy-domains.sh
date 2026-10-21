#!/bin/bash
set -euo pipefail
cd /root/website-scout-web
CTR=website-scout-web-app-1

FILES=(
  src/cfDomains.js
  src/outreach.js
  src/mcpCatalog.js
  src/mcpParityTools.js
  server/domain.js
  server/routes/domainApi.js
  server/mcp.js
  server/workspaceDb.js
  public/js/api.js
  public/js/app.js
  public/index.html
  sql/schema.sqlite.sql
  sql/schema.sql
)

for f in "${FILES[@]}"; do
  docker exec "$CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "$f" "$CTR:/app/$f"
  echo "copied $f"
done

docker compose restart app
echo "waiting for listen..."
for i in $(seq 1 50); do
  if docker logs "$CTR" --tail 60 2>&1 | grep -q 'listening on'; then
    echo "up"
    break
  fi
  sleep 1
done

echo "--- live checks ---"
docker exec "$CTR" node -e '
  require("/app/src/cfDomains");
  const n=require("/app/src/mcpCatalog").tools.map(t=>t.name);
  if(!n.includes("domains.search")||!n.includes("domains.link")) process.exit(2);
  console.log("domains_module_ok");
'
curl -sS -o /dev/null -w "index=%{http_code}\n" https://bitpype.com/
curl -sS https://bitpype.com/js/app.js | grep -c 'pageDomains' || true
curl -sS https://bitpype.com/ | grep -c 'data-route="domains"' || true
echo DONE
