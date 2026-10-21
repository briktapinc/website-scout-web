#!/usr/bin/env bash
set -euo pipefail
cd /root/website-scout-web

APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
if [ -z "$APP_CTR" ]; then
  echo "No website-scout-web-app container running" >&2
  exit 1
fi

FILES=(
  server/clientPortal.js
  server/routes/portal.js
  public/js/portal.js
  public/js/portal.vps.js
  public/portal.html
  public/portal.vps.html
)

for f in "${FILES[@]}"; do
  docker exec "$APP_CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "/root/website-scout-web/$f" "${APP_CTR}:/app/$f"
done

docker compose restart app
APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
for i in $(seq 1 30); do
  if docker logs "$APP_CTR" --tail 80 2>&1 | grep -q 'listening on'; then
    echo "app listening"
    break
  fi
  sleep 1
done

docker exec "$APP_CTR" node -e '
const portal = require("/app/server/clientPortal");
const routes = require("fs").readFileSync("/app/server/routes/portal.js", "utf8");
const pj = require("fs").readFileSync("/app/public/js/portal.js", "utf8");
const html = require("fs").readFileSync("/app/public/portal.html", "utf8");
if (typeof portal.listClientMcpTokens !== "function") throw new Error("missing listClientMcpTokens");
if (typeof portal.revokeClientMcpToken !== "function") throw new Error("missing revokeClientMcpToken");
if (!routes.includes("/mcp/tokens")) throw new Error("route missing GET /mcp/tokens");
if (!routes.includes("/mcp/token/:id")) throw new Error("route missing revoke /mcp/token/:id");
if (!pj.includes("refreshMcpTokens")) throw new Error("portal.js missing MCP UI");
if (!html.includes("sec-mcp") || !html.includes("nav-mcp")) throw new Error("portal.html missing MCP tab");
if (html.includes("mcp-agent-box")) throw new Error("billing MCP box should be removed");
console.log("portal-mcp smoke OK");
'

echo "deploy-portal-mcp done"
