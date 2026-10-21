#!/usr/bin/env bash
set -euo pipefail
APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
echo "CTR=$APP_CTR"
docker cp /root/website-scout-web/scripts/_tmp-probe-websites-cols.js \
  "$APP_CTR:/app/scripts/_tmp-probe-websites-cols.js"
docker cp /root/website-scout-web/scripts/_tmp-verify-delle-chat-export.js \
  "$APP_CTR:/app/scripts/_tmp-verify-delle-chat-export.js"
docker exec "$APP_CTR" node /app/scripts/_tmp-probe-websites-cols.js
docker exec "$APP_CTR" node /app/scripts/_tmp-verify-delle-chat-export.js
