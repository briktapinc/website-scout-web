#!/bin/bash
# Deploy logo upload + MCP logo generation to the running website-scout-web app container.
# Run from the VPS checkout (/root/website-scout-web) or via: ssh root@HOST 'bash -s' < scripts/_deploy-logo.sh
set -euo pipefail
cd /root/website-scout-web

FILES=(
  package.json
  package-lock.json
  src/logoProcess.js
  src/websiteEngine.js
  src/designJobs.js
  src/openaiImages.js
  src/mcpCatalog.js
  src/defaultDesignInstructions.js
  server/clientPortal.js
  server/domain.js
  server/mcp.js
  server/routes/portal.js
  server/routes/domainApi.js
  public/portal.html
  public/portal.vps.html
  public/js/portal.js
  public/js/api.js
  public/js/app.js
)

APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
if [ -z "$APP_CTR" ]; then
  echo "No website-scout-web-app container running" >&2
  exit 1
fi
echo "container=$APP_CTR"

for f in "${FILES[@]}"; do
  mkdir -p "$(dirname "$f")"
  if [ ! -f "$f" ]; then
    echo "missing local file: $f" >&2
    exit 1
  fi
  docker cp "$f" "$APP_CTR:/app/$f"
  echo "copied $f"
done

echo "installing sharp in container..."
docker exec "$APP_CTR" npm install sharp --omit=dev --no-audit --no-fund

docker compose restart app
echo "waiting for listen..."
for i in $(seq 1 50); do
  if docker logs "$APP_CTR" --tail 80 2>&1 | grep -q 'listening on'; then
    echo "up"
    break
  fi
  sleep 1
done

docker exec "$APP_CTR" node -e "
  require('./src/logoProcess');
  const m = require('./server/mcp');
  const names = m.toolDefs().map((t) => t.name);
  if (!names.includes('design.generateLogo') || !names.includes('website.setLogo')) {
    throw new Error('MCP logo tools missing');
  }
  console.log('logo modules + MCP tools ok');
"

curl -sS -o /dev/null -w "portal=%{http_code}\n" https://bitpype.com/portal
curl -sS https://bitpype.com/portal | grep -oE 'logo-bar|btn-logo-upload|logo-mode-text' | sort -u
echo DONE
