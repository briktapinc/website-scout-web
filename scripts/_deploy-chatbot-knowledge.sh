#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1 || true)
if [[ -z "${APP_CTR}" ]]; then
  echo "No website-scout-web-app container running" >&2
  exit 1
fi
echo "container=$APP_CTR"

FILES=(
  package.json
  package-lock.json
  server/chatbot.js
  server/chatbotKnowledgeExtract.js
  server/clientPortal.js
  server/clientMcp.js
  server/routes/portal.js
  public/portal.html
  public/portal.vps.html
  public/js/portal.js
  public/js/portal.vps.js
  scripts/_smoke-chatbot.js
)

for f in "${FILES[@]}"; do
  docker exec "$APP_CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "$f" "$APP_CTR:/app/$f"
  echo "copied $f"
done

echo "npm install (knowledge extractors)…"
docker exec -u root -w /app "$APP_CTR" sh -c \
  'npm install --omit=dev --no-audit --no-fund && chown -R node:node /app/node_modules /app/package.json /app/package-lock.json'

docker restart "$APP_CTR"
echo "restarted $APP_CTR"

for i in $(seq 1 50); do
  if docker logs "$APP_CTR" --tail 80 2>&1 | grep -q 'listening on'; then
    echo "app is listening"
    break
  fi
  sleep 1
done

docker exec "$APP_CTR" node /app/scripts/_smoke-chatbot.js
echo "deploy chatbot knowledge OK"
