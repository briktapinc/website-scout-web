#!/bin/bash
set -e
CTR=$(docker ps -q -f name=website-scout-web-app | head -1)
echo CTR=$CTR
docker cp /root/website-scout-web/scripts/_tmp-compare-previews.js "$CTR:/app/scripts/_tmp-compare-previews.js"
docker exec -w /app "$CTR" node scripts/_tmp-compare-previews.js
echo '--- export folder ---'
ls -la /var/lib/website-scout-exports/ | head -30
echo '--- site-1 index snippet ---'
head -c 500 /var/lib/website-scout-exports/site-1/index.html 2>/dev/null || echo missing
echo
echo '--- CF snippet ---'
curl -sS https://9196873e.bp-w1-s1.pages.dev/ | head -c 500
echo
echo '--- bitpype site-previews ---'
curl -sS -o /dev/null -w "site-1=%{http_code}\n" https://bitpype.com/site-previews/site-1/ || true
# find ws-* folders for these sites
ls /var/lib/website-scout-exports/ | grep -E 'site-1|ws-1-site-1' || true
for d in /var/lib/website-scout-exports/ws-*-site-1*; do
  [ -d "$d" ] || continue
  echo "folder $d"
  head -c 300 "$d/index.html" 2>/dev/null; echo
done
