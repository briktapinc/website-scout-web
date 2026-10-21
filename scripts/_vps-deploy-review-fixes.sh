#!/usr/bin/env bash
set -euo pipefail
cd /root/website-scout-web
APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
test -n "$APP_CTR"
for f in \
  server.js Dockerfile \
  server/middleware.js server/billing.js server/credits.js server/domain.js \
  server/clientPortal.js server/passwordReset.js server/platform.js server/settingsKeys.js \
  server/routes/domainApi.js server/routes/billing.js server/routes/dashboard.js \
  src/cloudflare.js src/websiteEngine.js src/openPreview.js src/designJobs.js \
  src/mcpCatalog.js src/ipc/system.js src/socialMedia.js \
  public/js/app.js public/js/portal.js public/js/portal.vps.js \
  public/portal.html public/portal.vps.html sql/schema.sql \
  scripts/_repair-multipage-nav.js scripts/_test-preview-nav.js; do
  if [ -f "/root/website-scout-web/$f" ]; then
    docker exec "$APP_CTR" mkdir -p "/app/$(dirname "$f")"
    docker cp "/root/website-scout-web/$f" "${APP_CTR}:/app/$f"
    echo "copied $f"
  fi
done
docker compose restart app
APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
for i in $(seq 1 30); do
  if docker logs "$APP_CTR" --tail 80 2>&1 | grep -q 'listening on'; then
    echo "app up"
    break
  fi
  sleep 2
done
docker compose exec -T app node -e '
const m = require("./server/middleware");
const b = require("./server/billing");
if (!m.requireTokenLeadScope || !m.denyLeadScopedToken) throw new Error("middleware missing");
if (!b.assertNotPastDue || !b.isHealthyPaid) throw new Error("billing missing");
console.log("verify-modules-ok");
'
docker compose exec -T app node scripts/_test-preview-nav.js || true
docker compose exec -T app node scripts/_repair-multipage-nav.js 1 --publish
curl -sS -o /dev/null -w "health=%{http_code}\n" https://bitpype.com/health || true
echo "deploy-review-fixes done"
