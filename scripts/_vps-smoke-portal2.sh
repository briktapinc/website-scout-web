#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

# Read env without sourcing (avoid BOM / special chars issues)
MYSQL_USER=$(grep -E '^MYSQL_USER=' .env | head -1 | cut -d= -f2- | tr -d '\r' | tr -d '"')
MYSQL_PASSWORD=$(grep -E '^MYSQL_PASSWORD=' .env | head -1 | cut -d= -f2- | tr -d '\r' | tr -d '"')
MYSQL_DATABASE=$(grep -E '^MYSQL_DATABASE=' .env | head -1 | cut -d= -f2- | tr -d '\r' | tr -d '"')

echo "=== client_portal_users table ==="
docker compose exec -T mysql mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e \
  "SHOW TABLES LIKE 'client_portal_users'; DESCRIBE client_portal_users;"

echo "=== in-container e2e ==="
docker compose cp scripts/_vps-portal-e2e.js app:/app/scripts/_vps-portal-e2e.js
docker compose exec -T app node scripts/_vps-portal-e2e.js

echo "=== access unknown email via HTTP (captcha required) ==="
curl -sS -X POST https://bitpype.com/api/v1/portal/access \
  -H "Content-Type: application/json" \
  -d '{"email":"nobody-xyz@example.invalid","captchaToken":""}' \
  -w "\nHTTP %{http_code}\n" || true

echo "DONE"
