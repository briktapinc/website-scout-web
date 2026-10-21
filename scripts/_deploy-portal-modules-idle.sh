#!/usr/bin/env bash
set -euo pipefail
cd /root/website-scout-web

APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1 || true)
if [[ -z "${APP_CTR}" ]]; then
  echo "No website-scout-web-app container running" >&2
  exit 1
fi
echo "container=${APP_CTR}"

FILES=(
  server.js
  server/routes/portal.js
  server/clientPortal.js
  public/portal.html
  public/portal.vps.html
  public/js/portal.js
  public/js/portal.vps.js
)

for f in "${FILES[@]}"; do
  docker exec "$APP_CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "$f" "$APP_CTR:/app/$f"
  echo "copied $f"
done

docker restart "$APP_CTR"
echo "restarted ${APP_CTR}"

for i in $(seq 1 40); do
  if docker logs "$APP_CTR" --tail 50 2>&1 | grep -q 'listening on'; then
    echo "app is listening"
    break
  fi
  sleep 1
done

echo "--- smoke ---"
curl -sS -m 5 http://127.0.0.1:3080/health || true
echo
docker logs "$APP_CTR" --tail 40 2>&1 | grep -E 'portalIdleHours|listening on' || true
curl -sS -o /dev/null -w "portal_html=%{http_code}\n" https://bitpype.com/portal
curl -sS -o /dev/null -w "portal_js=%{http_code}\n" https://bitpype.com/js/portal.js
echo -n "upload_route_hits="
curl -sS https://bitpype.com/js/portal.js | grep -c '/modules/upload-image' || true
echo DONE
