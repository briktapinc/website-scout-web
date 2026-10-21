#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

docker cp server/clientPortal.js website-scout-web-app-1:/app/server/clientPortal.js
docker compose restart app

echo "waiting for listen..."
for i in $(seq 1 40); do
  if docker logs website-scout-web-app-1 --tail 30 2>&1 | grep -q 'listening on'; then
    echo "up"
    break
  fi
  sleep 1
done

docker exec website-scout-web-app-1 node /app/scripts/_test-portal-image-src.js
docker exec website-scout-web-app-1 node /app/scripts/_test-freeform-edit.js

docker exec website-scout-web-app-1 node <<'NODE'
const p = require('./server/clientPortal');
const e = require('./src/websiteEngine');
const base = p.resolveExportPreviewBase(1, {
  id: 1,
  preview_url: 'https://x.pages.dev/',
  preview_path: '/data/website-scout-exports/ws-1-site-1',
});
const html = e.injectPreviewBaseHref(
  '<html><head></head><body><img src="images/a.jpg"></body></html>',
  base
);
if (!/site-previews\/ws-1-site-1\//.test(base)) throw new Error('bad base ' + base);
if (!html.includes('data-ws-preview-base')) throw new Error('missing base tag');
console.log(JSON.stringify({ ok: true, base }, null, 2));
NODE

curl -sS --max-time 15 -o /dev/null -w "portal=%{http_code}\n" https://bitpype.com/portal
curl -sS --max-time 15 -o /dev/null -w "portal_js=%{http_code}\n" https://bitpype.com/js/portal.js
echo -n "handleImageReplace="
curl -sS --max-time 15 https://bitpype.com/js/portal.js | grep -c handleImageReplace || true
echo -n "site_image_route="
docker exec website-scout-web-app-1 node -e "const r=require('fs').readFileSync('/app/server/routes/portal.js','utf8'); console.log(r.includes(\"/site/image\")?1:0)"
echo DONE
