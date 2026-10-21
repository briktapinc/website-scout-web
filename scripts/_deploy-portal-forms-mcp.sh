#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

FILES=(
  server/plans.js
  server/platform.js
  server/museRouter.js
  server/contactForms.js
  server/clientPortal.js
  server/domain.js
  server/workspace.js
  server/db.js
  server/mcp.js
  server/routes/portal.js
  server/routes/socialPublic.js
  server/routes/formsPublic.js
  server.js
  src/socialMedia.js
  src/websiteEngine.js
  sql/schema.sql
  sql/schema.sqlite.sql
  public/portal.html
  public/js/portal.js
  public/embed/form.html
)

APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
if [ -z "$APP_CTR" ]; then
  echo "No website-scout-web-app container running" >&2
  exit 1
fi
echo "container=$APP_CTR"

docker exec "$APP_CTR" mkdir -p /app/public/embed /app/server/routes /app/scripts /app/public/js
for f in "${FILES[@]}"; do
  mkdir -p "$(dirname "$f")"
  docker cp "$f" "$APP_CTR:/app/$f"
  echo "copied $f"
done

docker compose exec -T app node -e "require('./server/contactForms'); console.log('contactForms ok')"

docker compose restart app
echo "waiting for listen..."
for i in $(seq 1 50); do
  if docker logs "$APP_CTR" --tail 80 2>&1 | grep -q 'listening on'; then
    echo "up"
    break
  fi
  sleep 1
done

curl -sS -o /dev/null -w "portal=%{http_code}\n" https://bitpype.com/portal
curl -sS https://bitpype.com/portal | grep -oE 'nav-forms|btn-form-new|form-embed-on-page|form-target-page|forms-list|sec-forms' | sort -u
curl -sS -o /dev/null -w "embed=%{http_code}\n" https://bitpype.com/embed/form.html
echo DONE
