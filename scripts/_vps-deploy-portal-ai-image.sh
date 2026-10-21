#!/usr/bin/env bash
set -euo pipefail
cd /root/website-scout-web

APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
if [ -z "$APP_CTR" ]; then
  echo "No website-scout-web-app container running" >&2
  exit 1
fi

FILES=(
  src/websiteEngine.js
  server/clientPortal.js
  server/routes/portal.js
  public/js/portal.js
  public/js/portal.vps.js
  public/portal.html
  public/portal.vps.html
)

for f in "${FILES[@]}"; do
  docker exec "$APP_CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "/root/website-scout-web/$f" "${APP_CTR}:/app/$f"
done

docker compose restart app
APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
for i in $(seq 1 30); do
  if docker logs "$APP_CTR" --tail 80 2>&1 | grep -q 'listening on'; then
    echo "app listening"
    break
  fi
  sleep 1
done

docker exec "$APP_CTR" node -e '
const portal = require("/app/server/clientPortal");
const fs = require("fs");
const eng = fs.readFileSync("/app/src/websiteEngine.js", "utf8");
const routes = fs.readFileSync("/app/server/routes/portal.js", "utf8");
const pj = fs.readFileSync("/app/public/js/portal.js", "utf8");
const html = fs.readFileSync("/app/public/portal.html", "utf8");
if (typeof portal.generateClientSiteImage !== "function") throw new Error("missing generateClientSiteImage");
if (!eng.includes("image-ai-generate") || !eng.includes("mountAiImageControls")) throw new Error("engine missing AI chrome");
if (!routes.includes("/site/image-generate")) throw new Error("route missing");
if (!pj.includes("openAiImageModal") || !pj.includes("/site/image-generate")) throw new Error("portal.js missing AI UI");
if (!html.includes("ai-image-modal")) throw new Error("portal.html missing modal");
console.log("portal-ai-image smoke OK");
'

echo "deploy-portal-ai-image done"
