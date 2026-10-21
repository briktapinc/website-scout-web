#!/bin/bash
set -euo pipefail
sleep 5
curl -sS -o /dev/null -w 'health=%{http_code}\n' https://bitpype.com/health
curl -sS -o /dev/null -w 'portal=%{http_code}\n' https://bitpype.com/portal
echo portal_js_matches:
curl -sS https://bitpype.com/js/portal.js | grep -c insertModule || true
curl -sS https://bitpype.com/js/portal.js | grep -c addPage || true
curl -sS https://bitpype.com/js/portal.js | grep -c toggleNav || true
docker exec website-scout-web-app-1 node -e 'const s=require("/app/src/siteStructure"); console.log("siteStructure", typeof s.insertModuleSection, typeof s.toggleNavVisibility);'
docker logs website-scout-web-app-1 --tail 15 2>&1
