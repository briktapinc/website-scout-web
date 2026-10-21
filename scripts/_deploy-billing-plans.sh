#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

FILES=(
  server/plans.js
  server/billing.js
  server/stripeClient.js
  server/platform.js
  server/db.js
  server/middleware.js
  server/workspace.js
  server/clientPortal.js
  server/routes/billing.js
  server/routes/auth.js
  server/routes/portal.js
  server.js
  src/socialMedia.js
  public/js/api.js
  public/js/app.js
  public/js/portal.js
  public/portal.html
  public/styles.css
)

for f in "${FILES[@]}"; do
  docker cp "$f" "website-scout-web-app-1:/app/$f"
  echo "copied $f"
done

docker compose restart app
echo "waiting for listen..."
for i in $(seq 1 40); do
  if docker logs website-scout-web-app-1 --tail 40 2>&1 | grep -q 'listening on'; then
    echo "up"
    break
  fi
  sleep 1
done

docker compose exec -T app node -e '
const billing = require("./server/billing");
const plans = require("./server/plans");
const platform = require("./server/platform");
(async () => {
  console.log("plans", plans.listPlans().map((p) => p.id).join(","));
  const catalog = await billing.catalogForApi();
  console.log("catalog", JSON.stringify(catalog.map((p) => ({ id: p.id, checkout: p.checkout, priceConfigured: p.priceConfigured }))));
  const keys = ["stripe.price_id_standard", "stripe.price_id_premium", "stripe.publishable_key", "billing.require_subscription"];
  for (const k of keys) {
    const v = await platform.getPlatformSetting(k, "");
    console.log(k + "=" + (k.includes("key") && v ? "(set)" : (v || "(empty)")));
  }
})().catch((e) => { console.error(e); process.exit(1); });
'

curl -sS -o /dev/null -w "app=%{http_code}\n" https://bitpype.com/ || true
curl -sS -o /dev/null -w "portal=%{http_code}\n" https://bitpype.com/portal
curl -sS https://bitpype.com/portal | grep -oE 'bill-plan-grid|plan-grid|Manage subscription|Social images included' | sort -u || true
curl -sS https://bitpype.com/js/portal.js | grep -c 'data-checkout-plan\|ensureBilling\|startPortalCheckout\|canSelfServe' || true
docker compose exec -T app node -e '
const portal = require("./server/clientPortal");
console.log("exports", ["ensureBillingUserForPortalClient","billingForClient","openCheckout","openBillingPortal"].map((k) => k + "=" + typeof portal[k]).join(" "));
' || true
echo "deploy-billing-plans done"
