#!/usr/bin/env bash
set -euo pipefail
ROOT=/root/website-scout-web
CTR=website-scout-web-app-1
cd "$ROOT"

for f in server/clientPortal.js server/clientMcp.js; do
  docker exec "$CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "$ROOT/$f" "$CTR:/app/$f"
  echo "copied $f"
done

docker compose restart app
echo 'waiting for listen...'
for i in $(seq 1 40); do
  if docker logs "$CTR" --tail 30 2>&1 | grep -q 'listening on'; then
    echo up
    break
  fi
  sleep 1
done

docker exec "$CTR" node -e '
const m = require("./server/clientMcp");
const src = m.resolveClientEmail.toString();
if (src.includes("withDb") || src.includes("client_portal_users")) {
  console.error("FAIL: resolveClientEmail still touches workspace SQL");
  process.exit(1);
}
m.resolveClientEmail(1, 1, {}).then((e) => {
  console.log("OK resolveClientEmail =>", JSON.stringify(e));
}).catch((err) => {
  console.error("FAIL", err && err.message);
  process.exit(1);
});
'
echo DONE
