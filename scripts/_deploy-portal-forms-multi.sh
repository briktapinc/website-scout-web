#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

FILES=(
  server/contactForms.js
  server/clientPortal.js
  server/domain.js
  server/routes/portal.js
  src/websiteEngine.js
  public/portal.html
  public/js/portal.js
  public/embed/form.html
  scripts/_test-multi-forms.js
)

docker exec website-scout-web-app-1 mkdir -p /app/public/embed /app/server/routes /app/scripts
for f in "${FILES[@]}"; do
  mkdir -p "$(dirname "$f")"
  docker cp "$f" "website-scout-web-app-1:/app/$f"
  echo "copied $f"
done

# Also keep host checkout in sync for future deploys
for f in "${FILES[@]}"; do
  docker cp "website-scout-web-app-1:/app/$f" "$f" 2>/dev/null || true
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

echo "--- unit smoke ---"
docker exec website-scout-web-app-1 node /app/scripts/_test-multi-forms.js

echo "--- live checks ---"
curl -sS -o /dev/null -w "portal=%{http_code}\n" https://bitpype.com/portal
curl -sS https://bitpype.com/portal | grep -oE 'btn-form-new|form-embed-on-page|form-target-page|forms-list|sec-forms' | sort -u
curl -sS -o /dev/null -w "portal_js=%{http_code}\n" https://bitpype.com/js/portal.js
curl -sS https://bitpype.com/js/portal.js | grep -c 'btn-form-new\|embed_on_page\|openFormEditor' || true
curl -sS -o /dev/null -w "embed=%{http_code}\n" https://bitpype.com/embed/form.html
echo DONE
