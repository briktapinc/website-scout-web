#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

FILES=(
  src/websiteEngine.js
  server/clientPortal.js
  server/routes/portal.js
  public/js/portal.js
  public/portal.html
  scripts/_verify-portal-theme.js
)

for f in "${FILES[@]}"; do
  docker exec website-scout-web-app-1 mkdir -p "/app/$(dirname "$f")"
  docker cp "$f" "website-scout-web-app-1:/app/$f"
  echo "copied $f"
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

docker exec website-scout-web-app-1 node /app/scripts/_verify-portal-theme.js

echo "--- live checks ---"
curl -sS -o /dev/null -w "portal_html=%{http_code}\n" https://bitpype.com/portal
curl -sS -o /dev/null -w "portal_js=%{http_code}\n" https://bitpype.com/js/portal.js
curl -sS https://bitpype.com/portal | grep -oE 'btn-theme-colors|theme-bar|theme-hex-primary' | sort -u
curl -sS https://bitpype.com/js/portal.js | grep -c 'applyThemeLiveToPreview' || true
curl -sS https://bitpype.com/js/portal.js | grep -c '/site/theme' || true
echo DONE
