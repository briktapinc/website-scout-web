#!/usr/bin/env bash
set -euo pipefail
cd /root/website-scout-web

APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
if [ -z "$APP_CTR" ]; then
  echo "No website-scout-web-app container running" >&2
  exit 1
fi

FILES=(
  server.js
  server/mcpOAuth.js
  server/routes/mcpOAuth.js
  public/authorize.html
  public/portal.html
  public/portal.vps.html
)

for f in "${FILES[@]}"; do
  if [ ! -f "/root/website-scout-web/$f" ]; then
    echo "skip missing $f"
    continue
  fi
  docker exec "$APP_CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "/root/website-scout-web/$f" "${APP_CTR}:/app/$f"
done

docker compose restart app
APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
for i in $(seq 1 45); do
  if docker logs "$APP_CTR" --tail 100 2>&1 | grep -q 'listening on'; then
    echo "app listening"
    break
  fi
  sleep 1
done

docker exec "$APP_CTR" node -e '
(async () => {
  const oauth = require("/app/server/mcpOAuth");
  const meta = oauth.authorizationServerMetadata();
  if (!meta.authorization_endpoint.endsWith("/authorize")) throw new Error("bad authorize endpoint");
  if (!meta.code_challenge_methods_supported.includes("S256")) throw new Error("S256 missing");
  if (!meta.registration_endpoint) throw new Error("DCR missing");
  const pr = oauth.protectedResourceMetadata();
  if (!String(pr.resource).endsWith("/mcp")) throw new Error("resource must be /mcp");
  const v = await oauth.validateAuthorizeParams({
    response_type: "code",
    client_id: "website-scout",
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: "TFeFrm8bHVXuFr1FkhPxZnIxFwIMCtrr801hXy3uzmU",
    code_challenge_method: "S256",
    state: "test",
  });
  if (!v.ok) throw new Error("static client authorize validate failed: " + v.error_description);
  await oauth.ensureOAuthTables();
  const reg = await oauth.registerClient({
    client_name: "smoke-dcr",
    redirect_uris: ["http://127.0.0.1/callback"],
  });
  if (!reg.client_id || !String(reg.client_id).startsWith("dcr_")) throw new Error("DCR persist failed");
  const again = await oauth.getClient(reg.client_id);
  if (!again || again.client_id !== reg.client_id) throw new Error("DCR client not readable from DB");
  const fs = require("fs");
  const sj = fs.readFileSync("/app/server.js", "utf8");
  if (!sj.includes("mcpOAuthPublic") && !sj.includes("mcpOAuth")) throw new Error("server.js not wired");
  if (!fs.existsSync("/app/public/authorize.html")) throw new Error("authorize.html missing");
  console.log("mcp-oauth smoke OK (durable DCR)");
})().catch((e) => { console.error(e); process.exit(1); });
'

# Live discovery smoke against the restarted container (via published port if present).
echo "curl well-known…"
curl -fsS "https://bitpype.com/.well-known/oauth-authorization-server" | head -c 400 || true
echo
curl -fsS -o /dev/null -w "authorize_http=%{http_code}\n" \
  "https://bitpype.com/authorize?response_type=code&client_id=website-scout&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=TFeFrm8bHVXuFr1FkhPxZnIxFwIMCtrr801hXy3uzmU&code_challenge_method=S256&state=smoke" \
  || true

echo "deploy-mcp-oauth done"
