#!/bin/bash
set -e
CTR=$(docker ps -q -f name=website-scout-web-app | head -1)
echo CTR=$CTR
for f in src/websiteEngine.js scripts/_rebuild-modular-sites.js; do
  docker cp "/root/website-scout-web/$f" "$CTR:/app/$f"
done
docker exec -w /app "$CTR" node scripts/_smoke-layout-sections.js
docker restart "$CTR"
sleep 10
CTR=$(docker ps -q -f name=website-scout-web-app | head -1)
docker exec -w /app "$CTR" node scripts/_rebuild-modular-sites.js
docker exec -w /app "$CTR" node scripts/_tmp-compare-previews.js
curl -sS -o /dev/null -w "health=%{http_code}\n" https://bitpype.com/health || true
