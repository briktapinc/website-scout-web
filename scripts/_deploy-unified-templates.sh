#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

FILES=(
  src/outreach.js
  src/schema.sql
  src/ipc/outreach.js
  src/mcpParityTools.js
  src/mcpCatalog.js
  server/domain.js
  server/routes/domainApi.js
  server/mcp.js
  public/js/app.js
  public/js/api.js
  scripts/_test-sms-outreach.js
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

docker exec website-scout-web-app-1 node /app/scripts/_test-sms-outreach.js

docker exec website-scout-web-app-1 node -e "
const o = require('./src/outreach');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = '/app/data/workspaces/1/websitescout.db';
if (!fs.existsSync(path)) { console.log('no ws1 db — skip migrate smoke'); process.exit(0); }
const db = new Database(path);
o.ensureTables(db);
const cols = db.prepare('PRAGMA table_info(email_templates)').all().map(c => c.name);
if (!cols.includes('sms_body')) throw new Error('prod sms_body missing');
const smsLeft = db.prepare(\"SELECT COUNT(*) AS c FROM email_templates WHERE lower(IFNULL(channel,'email'))='sms'\").get().c;
const n = db.prepare('SELECT COUNT(*) AS c FROM email_templates').get().c;
console.log(JSON.stringify({ sms_body: true, templates: n, legacy_sms_rows: smsLeft }));
db.close();
"

echo "DONE unified templates deploy"
