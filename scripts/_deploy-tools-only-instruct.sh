#!/usr/bin/env bash
set -euo pipefail
ROOT=/root/website-scout-web
CTR=website-scout-web-app-1
cd "$ROOT"
for f in src/defaultDesignInstructions.js server/mcp.js server/clientMcp.js server/openapiV1.js; do
  docker exec "$CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "$ROOT/$f" "$CTR:/app/$f"
  echo "copied $f"
done
docker compose restart app
for i in $(seq 1 30); do
  docker logs "$CTR" --tail 20 2>&1 | grep -q 'listening on' && echo up && break
  sleep 1
done
curl -sS https://bitpype.com/api/v1/health
echo
docker exec "$CTR" node -e 'const d=require("./src/defaultDesignInstructions"); console.log(/TOOLS ONLY/.test(d.defaultWebsiteInstructions())?"instructions:ok":"instructions:FAIL"); const m=require("./server/mcp"); console.log(/TOOLS ONLY/.test(m.SERVER_INFO.description)?"serverInfo:ok":"serverInfo:FAIL");'
echo DONE
