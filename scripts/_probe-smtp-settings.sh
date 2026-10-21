#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

echo "=== platform_settings smtp.* ==="
docker compose exec -T mysql mysql -N -e "
SELECT \`key\`,
  CASE
    WHEN \`key\` IN ('smtp.pass','smtp.user') THEN
      IF(LENGTH(IFNULL(value,''))>0, CONCAT('SET(len=', LENGTH(value), ')'), 'EMPTY')
    ELSE IFNULL(value,'')
  END
FROM platform_settings
WHERE \`key\` LIKE 'smtp.%'
ORDER BY \`key\`;
" website_scout

echo ""
echo "=== workspace 1 SQLite smtp.* ==="
WS_DB="/root/website-scout-web/data/workspaces/1/websitescout.db"
if [ ! -f "$WS_DB" ]; then
  # try container path mount
  WS_DB=$(docker compose exec -T app sh -c 'ls /app/data/workspaces/1/websitescout.db 2>/dev/null && echo /app/data/workspaces/1/websitescout.db' | head -1 || true)
fi

docker compose exec -T app node - <<'NODE'
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const candidates = [
  '/app/data/workspaces/1/websitescout.db',
  '/data/workspaces/1/websitescout.db',
];
let dbPath = candidates.find((p) => fs.existsSync(p));
if (!dbPath) {
  console.log('NO_WORKSPACE_DB');
  process.exit(0);
}
console.log('db=', dbPath);
const db = new Database(dbPath, { readonly: true });
const keys = ['smtp.host','smtp.port','smtp.secure','smtp.user','smtp.pass','smtp.from_name','smtp.from_email'];
const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(()=>'?').join(',')})`).all(...keys);
const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
for (const k of keys) {
  const v = map[k] ?? '';
  if (k === 'smtp.pass' || k === 'smtp.user') {
    console.log(`${k}=${v ? `SET(len=${String(v).length})` : 'EMPTY'}`);
  } else {
    console.log(`${k}=${JSON.stringify(v)}`);
  }
}
NODE

echo ""
echo "=== recent email-related activity (app logs) ==="
docker logs website-scout-web-app-1 --tail 2000 2>&1 | grep -iE 'smtp|mail|email|nodemailer|EAUTH|stub|password.reset|portal password|invite|forgot' | tail -60 || true
