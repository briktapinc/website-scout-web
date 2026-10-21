#!/bin/bash
set -euo pipefail
CTR=$(docker ps -q -f name=website-scout-web-app)
echo "CTR=$CTR"
docker exec "$CTR" node -e "require('/app/src/themePalette'); console.log('themePalette_ok')"
echo "portal.js theme-palette: $(docker exec "$CTR" grep -c theme-palette /app/public/js/portal.js || true)"
echo "portal.html Colors: $(docker exec "$CTR" grep -c 'Colors on your site' /app/public/portal.html || true)"
echo "applyThemeLive: $(docker exec "$CTR" grep -c applyThemeLiveToPreview /app/public/js/portal.js || true)"
echo "clientPortal palette: $(docker exec "$CTR" grep -c extractPalette /app/server/clientPortal.js || true)"
