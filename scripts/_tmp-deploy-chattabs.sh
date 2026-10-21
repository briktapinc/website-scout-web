#!/bin/bash
set -euo pipefail
cd /root/website-scout-web
CTR=website-scout-web-app-1
for f in public/js/portal.js public/js/portal.vps.js public/portal.html public/portal.vps.html; do
  docker cp "$f" "$CTR:/app/$f"
  echo "copied $f"
done
docker exec "$CTR" node -e '
const fs=require("fs");
const js=fs.readFileSync("/app/public/js/portal.js","utf8");
const html=fs.readFileSync("/app/public/portal.html","utf8");
const idx=js.indexOf("modulesPaneTabs.addEventListener");
const slice=js.slice(idx, idx+700);
const hasChat=slice.includes("isChatbot") && slice.includes("settings") && slice.includes("inbox");
const bookingsOnly=/moduleState\.current !== .bookings./.test(slice);
console.log("cache_bust:", (html.match(/portal\.js\?v=[^"]+/)||[])[0]);
console.log("handler_ok:", hasChat && !bookingsOnly);
console.log("still_bookings_only:", bookingsOnly);
if (!hasChat || bookingsOnly) process.exit(1);
'
echo "deploy ok"
