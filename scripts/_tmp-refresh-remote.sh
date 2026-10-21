#!/bin/bash
set -e
CTR=$(docker ps -q -f name=website-scout-web-app | head -1)
echo CTR=$CTR
docker cp /root/website-scout-web/scripts/_rebuild-modular-sites.js "$CTR:/app/scripts/_rebuild-modular-sites.js"
docker cp /root/website-scout-web/scripts/_tmp-refresh-previews.js "$CTR:/app/scripts/_tmp-refresh-previews.js"
docker exec -w /app "$CTR" node scripts/_tmp-refresh-previews.js
