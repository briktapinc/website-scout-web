#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

FILES=(
  src/websiteEngine.js
  server/clientPortal.js
  server/routes/portal.js
  server.js
  public/js/portal.js
  scripts/_test-freeform-edit.js
  scripts/_test-portal-image-src.js
  scripts/_verify-portal-freeform-edit.js
)

for f in "${FILES[@]}"; do
  docker cp "$f" "website-scout-web-app-1:/app/$f"
  echo "copied $f"
done

docker compose restart app
echo "waiting for listen..."
for i in $(seq 1 50); do
  if docker logs website-scout-web-app-1 --tail 50 2>&1 | grep -q 'listening on'; then
    echo "up"
    break
  fi
  sleep 1
done

docker exec website-scout-web-app-1 node /app/scripts/_test-freeform-edit.js
docker exec website-scout-web-app-1 node /app/scripts/_test-portal-image-src.js
docker exec website-scout-web-app-1 node /app/scripts/_verify-portal-freeform-edit.js

echo "--- live checks ---"
curl -sS --max-time 15 -o /dev/null -w "portal_html=%{http_code}\n" https://bitpype.com/portal
curl -sS --max-time 15 -o /dev/null -w "portal_js=%{http_code}\n" https://bitpype.com/js/portal.js
curl -sS --max-time 15 https://bitpype.com/js/portal.js | grep -c 'handleImageReplace' || true
curl -sS --max-time 15 https://bitpype.com/js/portal.js | grep -c 'resizeImageForUpload' || true
docker exec website-scout-web-app-1 node /app/scripts/_verify-portal-image-base.js
echo DONE
