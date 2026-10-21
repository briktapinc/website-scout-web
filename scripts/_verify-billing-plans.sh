#!/bin/bash
set -euo pipefail
cd /root/website-scout-web
curl -sS -m 10 -o /dev/null -w "app=%{http_code}\n" https://bitpype.com/
curl -sS -m 10 -o /dev/null -w "portal=%{http_code}\n" https://bitpype.com/portal
docker compose exec -T app node <<'NODE'
const db = require('./server/db');
(async () => {
  try {
    const r = await db.query('SELECT id, billing_plan FROM users LIMIT 1');
    console.log('billing_plan_col_ok', r[0] || null);
  } catch (e) {
    console.error('billing_plan_col_err', e.message);
    process.exit(1);
  }
})();
NODE
echo verify-ok
