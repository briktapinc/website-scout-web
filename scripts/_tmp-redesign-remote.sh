#!/bin/bash
set -e
CTR=$(docker ps -q -f name=website-scout-web-app | head -1)
echo CTR=$CTR
ROOT=/root/website-scout-web
for f in \
  src/websiteEngine.js \
  src/siteStructure.js \
  src/designJobs.js \
  src/defaultDesignInstructions.js \
  scripts/_redesign-originals-modular.js \
  scripts/_tmp-find-originals.js \
  scripts/_smoke-section-hooks.js \
  scripts/_smoke-layout-sections.js
do
  docker cp "$ROOT/$f" "$CTR:/app/$f"
done
docker exec -w /app "$CTR" node scripts/_smoke-layout-sections.js
docker exec -w /app "$CTR" node scripts/_tmp-find-originals.js
docker restart "$CTR"
sleep 10
CTR=$(docker ps -q -f name=website-scout-web-app | head -1)
docker exec -w /app "$CTR" node scripts/_redesign-originals-modular.js
curl -sS -o /dev/null -w "health=%{http_code}\n" https://bitpype.com/health || true
