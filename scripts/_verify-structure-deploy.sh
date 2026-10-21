#!/bin/bash
set -euo pipefail
CTR=website-scout-web-app-1
echo "container portal nest: $(docker exec "$CTR" grep -c 'data-action="nest"' /app/public/js/portal.js || true)"
echo "container app nest: $(docker exec "$CTR" grep -c 'menu-nest' /app/public/js/app.js || true)"
echo "live portal.js nest: $(curl -sS 'https://bitpype.com/js/portal.js?v=structure2' | grep -c 'data-action="nest"' || true)"
echo "live app.js nest: $(curl -sS 'https://bitpype.com/js/app.js' | grep -c 'menu-nest' || true)"
echo -n "portal_html="
curl -sS -o /dev/null -w "%{http_code}\n" https://bitpype.com/portal
echo -n "portal_script="
curl -sS https://bitpype.com/portal | grep -oE 'portal\.js[^" ]*' | head -1
docker exec "$CTR" node -e 'const n=require("/app/src/mcpCatalog").tools.map(t=>t.name); console.log("mcp",n.includes("website.structure"),n.includes("website.structure.reorder"));'
