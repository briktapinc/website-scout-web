#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

echo "Building app image (Chromium + siteScreenshots)..."
docker compose build app

echo "Recreating app container..."
docker compose up -d --force-recreate --no-deps app

CTR=website-scout-web-app-1
echo "waiting for listen..."
for i in $(seq 1 90); do
  if docker logs "$CTR" --tail 80 2>&1 | grep -q 'listening on'; then
    echo "up"
    break
  fi
  sleep 1
done

echo "--- live checks ---"
docker exec "$CTR" node -e '
  require("/app/src/siteScreenshots");
  console.log("siteScreenshots_ok");
  require("puppeteer");
  console.log("puppeteer_ok");
  require("sharp");
  console.log("sharp_ok");
  const fs = require("fs");
  const exe = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";
  if (!fs.existsSync(exe)) { console.error("chromium_missing", exe); process.exit(4); }
  console.log("chromium_ok", exe);
'
curl -sS -o /dev/null -w "portal=%{http_code}\n" https://bitpype.com/portal
curl -sS -o /dev/null -w "appjs=%{http_code}\n" https://bitpype.com/js/app.js
echo DONE
