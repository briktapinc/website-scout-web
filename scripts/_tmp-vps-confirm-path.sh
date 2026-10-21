#!/usr/bin/env bash
set -euo pipefail
APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
docker cp /root/website-scout-web/scripts/_tmp-confirm-delle-export-path.js \
  "$APP_CTR:/app/scripts/_tmp-confirm-delle-export-path.js"
docker exec "$APP_CTR" node /app/scripts/_tmp-confirm-delle-export-path.js
