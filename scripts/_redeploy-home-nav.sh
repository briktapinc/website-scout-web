#!/bin/bash
set -eu
CTR=website-scout-web-app-1
cd /root/website-scout-web
for f in public/home.html public/how.html server.js server/siteModules.js scripts/_resync-module-nav.js; do
  docker cp "$f" "$CTR:/app/$f"
done
docker restart "$CTR"
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -fsS http://127.0.0.1:3080/ >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done
if [ "$ok" != 1 ]; then
  echo "app did not listen"
  exit 1
fi
curl -fsS http://127.0.0.1:3080/ | grep -F "We'll handle the website."
curl -fsS http://127.0.0.1:3080/how | grep -F "Pick up a card."
docker exec "$CTR" grep -q 'data-bitpype-module-nav' /app/server/siteModules.js
docker exec "$CTR" node /app/scripts/_resync-module-nav.js
echo DEPLOY_OK
