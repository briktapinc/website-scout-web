#!/bin/bash
set -e
CTR=$(docker ps -q -f name=website-scout-web-app | head -1)
echo CTR=$CTR
ROOT=/root/website-scout-web
docker cp "$ROOT/src/websiteEngine.js" "$CTR:/app/src/websiteEngine.js"
docker cp "$ROOT/scripts/_redesign-originals-modular.js" "$CTR:/app/scripts/_redesign-originals-modular.js"
docker restart "$CTR"
sleep 10
CTR=$(docker ps -q -f name=website-scout-web-app | head -1)
docker exec -w /app "$CTR" node scripts/_redesign-originals-modular.js
