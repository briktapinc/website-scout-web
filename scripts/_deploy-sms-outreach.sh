#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

FILES=(
  src/sms.js
  src/outreach.js
  src/schema.sql
  src/seed.js
  src/email.js
  src/ipc/system.js
  server/domain.js
  server/workspaceDb.js
  server/platform.js
  server/routes/domainApi.js
  server/mcp.js
  public/js/app.js
  public/js/api.js
)

for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then
    docker exec website-scout-web-app-1 mkdir -p "/app/$(dirname "$f")"
    docker cp "$f" "website-scout-web-app-1:/app/$f"
    echo "copied $f"
  else
    echo "MISSING $f" >&2
    exit 1
  fi
done

docker compose restart app
echo "waiting for listen..."
for i in $(seq 1 40); do
  if docker logs website-scout-web-app-1 --tail 40 2>&1 | grep -q 'listening on'; then
    echo "up"
    break
  fi
  sleep 1
done

docker exec website-scout-web-app-1 node -e "
const sms = require('./src/sms');
const o = require('./src/outreach');
const draft = sms.companionSmsDraft({ businessName: 'Acme', websiteLink: 'https://example.com/site/' });
if (!draft.includes('https://example.com/site/')) throw new Error('companion missing link');
console.log('sms.companion ok', draft.slice(0, 80));
console.log('outreach.ensureTables', typeof o.ensureTables);
console.log('SMS outreach deploy check OK');
"

echo "DONE sms outreach deploy"
