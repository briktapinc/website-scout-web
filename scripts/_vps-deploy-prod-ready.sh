#!/usr/bin/env bash
set -euo pipefail
cd /root/website-scout-web

# Align compose volume + EXPORT_ROOT (idempotent sed if already applied)
if grep -q 'scout_exports:/root/website-scout-exports' docker-compose.yml 2>/dev/null; then
  sed -i 's|scout_exports:/root/website-scout-exports|scout_exports:/var/lib/website-scout-exports|' docker-compose.yml
fi
if ! grep -q 'EXPORT_ROOT:' docker-compose.yml; then
  echo "WARN: EXPORT_ROOT missing from compose — ensure local file was scp'd"
fi

APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1 || true)

# Copy updated source into host tree is done by scp; rebuild image so USER node + EXPORT_ROOT apply
echo "Building app image..."
docker compose build app

echo "Recreating app container..."
docker compose up -d app

# Wait for healthy listen
APP_CTR=$(docker ps --format '{{.Names}}' | grep -E 'website-scout-web-app' | head -n1)
for i in $(seq 1 40); do
  if docker logs "$APP_CTR" --tail 80 2>&1 | grep -q 'listening on'; then
    echo "app up"
    break
  fi
  sleep 2
done

# Volume may be root-owned from prior runs — ensure node can write exports + workspaces
docker compose exec -T -u root app chown -R node:node /var/lib/website-scout-exports /app/data/workspaces || true

docker compose exec -T app sh -c 'echo EXPORT_ROOT=$EXPORT_ROOT; id; ls -la "$EXPORT_ROOT" | head -8'
docker compose exec -T app node -e '
const b = require("./server/billing");
if (!b.effectivePlan || !b.claimStripeEvent) throw new Error("billing helpers missing");
console.log("verify-billing-ok");
'
docker compose exec -T app node -e '
const { query, migrate } = require("./server/db");
(async () => {
  await migrate();
  const rows = await query("SELECT COUNT(*) AS c FROM stripe_events");
  console.log("stripe_events_ok", rows[0] && (rows[0].c != null ? rows[0].c : rows[0]["COUNT(*)"]));
})().catch((e) => { console.error(e); process.exit(1); });
'

curl -sS https://bitpype.com/health
echo
echo "deploy-prod-ready done"
