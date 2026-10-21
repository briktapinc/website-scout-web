#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

echo "=== portal page ==="
code=$(curl -sS -o /tmp/portal.html -w "%{http_code}" https://bitpype.com/portal)
echo "HTTP $code"
grep -q "Bitpype" /tmp/portal.html && echo "brand ok"
grep -q "portal.js" /tmp/portal.html && echo "js ok"

echo "=== portal me (expect 401) ==="
curl -sS -w "\nHTTP %{http_code}\n" https://bitpype.com/api/v1/portal/me || true

echo "=== captcha config ==="
curl -sS https://bitpype.com/api/v1/captcha/config
echo

echo "=== client_portal_users table ==="
docker compose exec -T mysql mysql -uscout -pscout website_scout -e \
  "SHOW TABLES LIKE 'client_portal_users'; DESCRIBE client_portal_users;"

echo "=== sample lead emails ==="
docker compose exec -T app sh -c '
for d in /app/data/workspaces/*/websitescout.db; do
  [ -f "$d" ] || continue
  echo "DB $d"
  node -e "
    const Database=require(\"better-sqlite3\");
    const db=new Database(process.argv[1],{readonly:true});
    try {
      const rows=db.prepare(\"SELECT id,email,business_name FROM leads WHERE email IS NOT NULL AND trim(email)!=\\\"\\\" LIMIT 5\").all();
      console.log(JSON.stringify(rows,null,2));
    } catch(e){ console.log(\"err\",e.message); }
  " "$d"
done
'

echo "=== access without captcha (expect captcha or ok) ==="
curl -sS -X POST https://bitpype.com/api/v1/portal/access \
  -H "Content-Type: application/json" \
  -d '{"email":"nobody-xyz@example.invalid"}' \
  -w "\nHTTP %{http_code}\n" || true

echo "DONE"
