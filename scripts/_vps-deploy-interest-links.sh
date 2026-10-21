#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

FILES=(
  server.js
  server/domain.js
  server/routes/outreachPublic.js
  src/outreach.js
  src/email.js
  src/seed.js
  src/mcpCatalog.js
  server/mcp.js
  public/js/app.js
  renderer/outreach.js
  scripts/_test-interest-links.js
)

APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
if [ -z "$APP_CTR" ]; then
  echo "No website-scout-web app container running" >&2
  exit 1
fi

for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "MISSING $f" >&2
    exit 1
  fi
  docker exec "$APP_CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "$f" "$APP_CTR:/app/$f"
  echo "copied $f"
done

docker compose restart app
echo "waiting for listen..."
for i in $(seq 1 40); do
  if docker logs "$APP_CTR" --tail 40 2>&1 | grep -q 'listening on'; then
    echo "up"
    break
  fi
  sleep 1
done

echo "--- module load ---"
docker compose exec -T app node -e "require('./server/routes/outreachPublic'); require('./src/outreach'); console.log('modules ok')"

echo "--- signed link smoke ---"
docker compose exec -T app node scripts/_test-interest-links.js 1

echo "--- public forged probe ---"
curl -sS -o /tmp/interest-forged.html -w "forged_http=%{http_code}\n" \
  "http://127.0.0.1:3000/api/v1/outreach/public/response/not.a.valid.token" \
  || curl -sS -o /tmp/interest-forged.html -w "forged_http=%{http_code}\n" \
  "https://bitpype.com/api/v1/outreach/public/response/not.a.valid.token"
echo "DONE"
