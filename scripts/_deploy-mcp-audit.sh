#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

FILES=(
  server/mcp.js
  server/domain.js
  src/outreach.js
  src/seed.js
  src/mcpCatalog.js
  src/mcpParityTools.js
  src/mcp.js
)

APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
if [ -z "$APP_CTR" ]; then
  echo "No website-scout-web-app container running" >&2
  exit 1
fi
echo "container=$APP_CTR"

for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "missing local file: $f" >&2
    exit 1
  fi
  docker exec "$APP_CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "$f" "$APP_CTR:/app/$f"
  echo "copied $f"
done

docker compose restart app
echo "waiting for listen..."
for i in $(seq 1 50); do
  if docker logs "$APP_CTR" --tail 80 2>&1 | grep -q 'listening on'; then
    echo "up"
    break
  fi
  sleep 1
done

docker exec "$APP_CTR" node -e "
const m = require('./server/mcp');
const names = m.toolDefs().map((t) => t.name);
for (const n of [
  'design.generateLogo','website.setLogo','website.setTheme','website.replaceImage',
  'email.draft','email.uploadAsset','sms.queue','outreach.campaigns','email.compose'
]) {
  if (!names.includes(n)) throw new Error('missing tool ' + n);
}
const camp = m.toolDefs().find((t) => t.name === 'outreach.campaigns');
if (!/cancel/.test(camp.description) || !/delete/.test(camp.description)) {
  throw new Error('campaigns description missing cancel/delete');
}
const draft = m.toolDefs().find((t) => t.name === 'email.draft');
if (!/sms_body/.test(draft.description)) throw new Error('email.draft missing sms_body docs');
console.log('MCP audit tools ok; count=' + names.length);
"

echo "DONE mcp audit deploy"
