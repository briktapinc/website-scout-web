#!/usr/bin/env bash
# Remote half of claim/postcard deploy (run on VPS).
set -euo pipefail
cd /root/website-scout-web

FILES=(
  package.json
  package-lock.json
  src/outreach.js
  src/claimKit.js
  src/mcpParityTools.js
  server/domain.js
  server/mcp.js
  server/routes/outreachPublic.js
  server/routes/domainApi.js
  public/claim.html
  public/js/api.js
  public/js/app.js
  src/ipc/websites.js
  renderer/websites.html
  renderer/websites.js
  scripts/_test-claim-postcard.js
)

APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
if [ -z "$APP_CTR" ]; then
  echo "No website-scout-web app container running" >&2
  exit 1
fi

echo '== docker cp into app container =='
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "MISSING $f" >&2
    exit 1
  fi
  docker exec "$APP_CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "$f" "$APP_CTR:/app/$f"
  echo "copied $f"
done

echo '== npm install (qrcode, pdfkit) =='
docker compose exec -T app npm install --omit=dev qrcode pdfkit

echo '== restart app =='
docker compose restart app
echo 'waiting for listen...'
for i in $(seq 1 40); do
  if docker logs "$APP_CTR" --tail 40 2>&1 | grep -q 'listening on'; then
    echo 'up'
    break
  fi
  sleep 1
done

echo '== module load =='
docker compose exec -T app node -e "require('./src/claimKit'); require('qrcode'); require('pdfkit'); console.log('claimKit+deps ok')"

echo '== smoke test =='
docker compose exec -T app node scripts/_test-claim-postcard.js 1

echo '== public claim page static =='
curl -fsS -o /dev/null -w 'claim.html %{http_code}\n' https://bitpype.com/claim.html || true
curl -sS -o /dev/null -w 'forged claim api %{http_code}\n' \
  "https://bitpype.com/api/v1/outreach/public/claim/not.a.valid.token" || true
curl -sS -o /dev/null -w 'health %{http_code}\n' https://bitpype.com/health || true

echo 'OK claim-postcard deploy'
