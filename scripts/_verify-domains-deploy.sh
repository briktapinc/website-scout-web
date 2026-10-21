#!/bin/bash
set -euo pipefail
sleep 3
echo -n "index="
curl -sS -o /dev/null -w "%{http_code}\n" https://bitpype.com/
echo -n "pageDomains="
curl -sS https://bitpype.com/js/app.js | grep -c pageDomains || true
echo -n "nav_domains="
curl -sS https://bitpype.com/ | grep -c 'data-route="domains"' || true
docker exec website-scout-web-app-1 node -e 'const n=require("/app/src/mcpCatalog").tools.map(t=>t.name).filter(x=>x.startsWith("domains.")); console.log("mcp",n.length,n.join(","));'
