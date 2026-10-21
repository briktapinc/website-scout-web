#!/usr/bin/env bash
set -euo pipefail
C=website-scout-web-app-1
R=/root/website-scout-web
for f in \
  server/upsellTips.js \
  server/db.js \
  server/routes/admin.js \
  server/routes/portal.js \
  public/js/api.js \
  public/js/app.js \
  public/js/portal.js \
  public/js/portal.vps.js \
  public/portal.html \
  public/portal.vps.html \
  scripts/_smoke-upsell-tips.js
do
  docker cp "$R/$f" "$C:/app/$f"
done
docker restart "$C"
sleep 5
docker exec "$C" node -e "require('./server/upsellTips').ensureTables().then(()=>require('./server/upsellTips').listTips({includeStats:true})).then(t=>console.log('tips',t.length)).catch(e=>{console.error(e);process.exit(1)})"
echo deploy-upsell-ok
