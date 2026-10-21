#!/usr/bin/env bash
# Deploy claim-preview popup + backfill into existing EXPORT_ROOT HTML.
set -euo pipefail
cd /root/website-scout-web

FILES=(
  src/claimKit.js
  src/outreach.js
  public/js/claim-preview.js
  public/claim.html
  server/domain.js
  server.js
  server/routes/outreachPublic.js
  scripts/_inject-claim-previews.js
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

echo '== restart app =='
docker compose restart app
echo 'waiting for listen...'
for i in $(seq 1 40); do
  if docker logs "$APP_CTR" --tail 50 2>&1 | grep -q 'listening on'; then
    echo 'up'
    break
  fi
  sleep 1
done

echo '== module load =='
docker compose exec -T app node -e "require('./src/claimKit'); console.log('claimKit ok')"

echo '== backfill claim snippets into EXPORT_ROOT =='
docker compose exec -T app node scripts/_inject-claim-previews.js

echo '== public smoke =='
curl -fsS -o /dev/null -w 'claim-preview.js %{http_code}\n' https://bitpype.com/js/claim-preview.js || true
curl -sS -o /dev/null -w 'claim api badtoken %{http_code}\n' \
  "https://bitpype.com/api/v1/outreach/public/claim/not.a.valid.token" || true

echo 'OK claim-preview deploy'
