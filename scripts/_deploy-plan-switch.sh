#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

FILES=(
  server/billing.js
  server/clientPortal.js
  server/routes/billing.js
  server/routes/portal.js
  public/js/portal.js
  public/js/api.js
  public/portal.html
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
const portal = require("./server/clientPortal");
const need = [
  ["billing.changeSubscriptionPlan", billing.changeSubscriptionPlan],
  ["billing.startOrChangePlan", billing.startOrChangePlan],
  ["billing.scheduleCancelAtPeriodEnd", billing.scheduleCancelAtPeriodEnd],
  ["billing.resumeSubscription", billing.resumeSubscription],
  ["portal.changePlan", portal.changePlan],
  ["portal.cancelToFree", portal.cancelToFree],
  ["portal.resumeBilling", portal.resumeBilling],
];
for (const [name, fn] of need) {
  if (typeof fn !== "function") { console.error("missing", name); process.exit(2); }
  console.log(name + "=ok");
}
' 

echo "--- route smoke (expect AUTH) ---"
curl -sS -o /tmp/ch.json -w "change-plan=%{http_code}\n" -X POST https://bitpype.com/api/v1/portal/billing/change-plan \
  -H 'Content-Type: application/json' -d '{"plan":"premium"}' || true
curl -sS -o /tmp/ca.json -w "cancel=%{http_code}\n" -X POST https://bitpype.com/api/v1/portal/billing/cancel \
  -H 'Content-Type: application/json' -d '{}' || true
curl -sS -o /tmp/re.json -w "resume=%{http_code}\n" -X POST https://bitpype.com/api/v1/portal/billing/resume \
  -H 'Content-Type: application/json' -d '{}' || true
head -c 200 /tmp/ch.json; echo
curl -sS https://bitpype.com/js/portal.js | grep -c 'data-change-plan\|startPortalChangePlan\|Upgrade to Premium' || true
curl -sS https://bitpype.com/portal | grep -oE 'bill-plan-grid|Switch plans here|Manage subscription' | sort -u || true
echo "deploy-plan-switch done"
