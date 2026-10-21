#!/usr/bin/env bash
set -euo pipefail
ROOT=/root/website-scout-web
CTR=website-scout-web-app-1
docker cp "$ROOT/server/platform.js" "$CTR:/app/server/platform.js"
cd "$ROOT" && docker compose restart app
for i in $(seq 1 25); do
  docker logs "$CTR" --tail 15 2>&1 | grep -q 'listening on' && echo up && break
  sleep 1
done
docker exec "$CTR" node -e '
const p = require("./server/platform");
const keys = p.PLATFORM_SETTING_DEFS.filter((d) => String(d.key).startsWith("muse.")).map((d) => d.key);
console.log(keys.join(", "));
console.log(p.PLATFORM_SECRET_KEYS.includes("muse.model_api_key") ? "secret:ok" : "secret:FAIL");
'
curl -sS https://bitpype.com/api/v1/health
echo
echo DONE
