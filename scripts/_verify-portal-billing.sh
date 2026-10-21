#!/bin/bash
set -euo pipefail
cd /root/website-scout-web
docker compose exec -T app node <<'NODE'
const p = require('./server/clientPortal');
const b = require('./server/billing');
console.log('ensure', typeof p.ensureBillingUserForPortalClient);
console.log('checkout', typeof p.openCheckout);
console.log('billingForClient', typeof p.billingForClient);
console.log('createCheckoutSession', typeof b.createCheckoutSession);
NODE
echo "portal.js Social images: $(grep -c 'Social images included' public/js/portal.js || true)"
echo "clientPortal ensure: $(grep -c ensureBillingUserForPortalClient server/clientPortal.js || true)"
echo "billing successUrl: $(grep -c successUrl server/billing.js || true)"
curl -sS --max-time 15 -o /dev/null -w "portal=%{http_code}\n" https://bitpype.com/portal
echo OK
