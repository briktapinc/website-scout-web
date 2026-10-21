#!/bin/bash
set -eu
CTR=website-scout-web-app-1
cd /root/website-scout-web
for f in public/portal.html public/js/portal.js; do
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
curl -fsS http://127.0.0.1:3080/portal | grep -F "looked after."
curl -fsS http://127.0.0.1:3080/portal | grep -F "portal.js?v=homeui1"
echo DEPLOY_OK
