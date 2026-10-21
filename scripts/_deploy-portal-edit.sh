#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

FILES=(
  src/websiteEngine.js
  server/clientPortal.js
  public/js/portal.js
  public/portal.html
  scripts/_test-freeform-edit.js
  scripts/_verify-portal-freeform-edit.js
)

for f in "${FILES[@]}"; do
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

docker exec website-scout-web-app-1 node /app/scripts/_test-freeform-edit.js
docker exec website-scout-web-app-1 node /app/scripts/_verify-portal-freeform-edit.js

echo "--- live checks ---"
curl -sS -o /dev/null -w "portal_html=%{http_code}\n" https://bitpype.com/portal
curl -sS -o /dev/null -w "portal_js=%{http_code}\n" https://bitpype.com/js/portal.js
curl -sS https://bitpype.com/portal | grep -oE 'btn-edit-mode|btn-edit-mode-label|preview-actions' | sort -u
curl -sS https://bitpype.com/js/portal.js | grep -c 'setEditMode' || true
curl -sS https://bitpype.com/js/portal.js | grep -c 'html:\\d+:\\d+' || true
grep -n "btn-edit-mode\|setEditMode\|html:" /root/website-scout-web/public/js/portal.js | head -15
echo DONE
