#!/bin/bash
set -eu
CTR=website-scout-web-app-1
cd /root/website-scout-web
for f in \
  public/js/module-embed.js \
  public/embed/module.html \
  server/siteModules.js \
  server.js \
  src/websiteEngine.js \
  scripts/_resync-module-nav.js
do
  docker cp "$f" "$CTR:/app/$f"
done
docker restart "$CTR"
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -fsS http://127.0.0.1:3080/portal >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done
if [ "$ok" != 1 ]; then
  echo "app did not listen"
  exit 1
fi
curl -fsS http://127.0.0.1:3080/js/module-embed.js | grep -q 'BitpypeModules'
curl -fsS "http://127.0.0.1:3080/embed/module.html" | grep -q 'module-embed.js'
docker exec "$CTR" grep -q 'data-bitpype-api' /app/server/siteModules.js
docker exec "$CTR" grep -q 'BPSCRIPT' /app/src/websiteEngine.js
docker exec "$CTR" grep -q 'Access-Control-Allow-Origin' /app/server.js
docker exec "$CTR" node /app/scripts/_resync-module-nav.js
echo DEPLOY_OK
