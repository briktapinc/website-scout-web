#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1 || true)
if [[ -z "${APP_CTR}" ]]; then
  echo "No website-scout-web-app container running" >&2
  exit 1
fi

FILES=(
  server/plans.js
  server/siteModules.js
  server/chatbot.js
  server/clientPortal.js
  server/clientMcp.js
  server/mcp.js
  server/routes/portal.js
  server/routes/chatbotPublic.js
  server/routes/modulesPublic.js
  server.js
  src/designAgentTrigger.js
  src/websiteEngine.js
  public/portal.html
  public/portal.vps.html
  public/js/portal.js
  public/js/portal.vps.js
  public/js/chat-embed.js
  scripts/_smoke-chatbot.js
  scripts/_test-embed-sanitize.js
)

for f in "${FILES[@]}"; do
  docker exec "$APP_CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "$f" "$APP_CTR:/app/$f"
  echo "copied $f"
done

docker restart "$APP_CTR"
echo "restarted $APP_CTR"

for i in $(seq 1 40); do
  if docker logs "$APP_CTR" --tail 50 2>&1 | grep -q 'listening on'; then
    echo "app is listening"
    break
  fi
  sleep 1
done

docker exec "$APP_CTR" node /app/scripts/_test-embed-sanitize.js
docker exec "$APP_CTR" node /app/scripts/_smoke-chatbot.js
echo "deploy chatbot OK"
