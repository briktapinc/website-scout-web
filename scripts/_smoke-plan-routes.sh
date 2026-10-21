#!/bin/bash
set -euo pipefail
echo '{"plan":"premium"}' > /tmp/plan.json
echo '--- portal change-plan (expect AUTH) ---'
curl -sS -m 8 -w '\nhttp=%{http_code}\n' -X POST http://127.0.0.1:3080/api/v1/portal/billing/change-plan \
  -H 'Content-Type: application/json' --data-binary @/tmp/plan.json
echo '--- staff change-plan (expect AUTH) ---'
curl -sS -m 8 -w '\nhttp=%{http_code}\n' -X POST http://127.0.0.1:3080/api/v1/billing/change-plan \
  -H 'Content-Type: application/json' --data-binary @/tmp/plan.json
echo '--- portal cancel (expect AUTH) ---'
curl -sS -m 8 -w '\nhttp=%{http_code}\n' -X POST http://127.0.0.1:3080/api/v1/portal/billing/cancel \
  -H 'Content-Type: application/json' -d '{}'
echo '--- portal resume (expect AUTH) ---'
curl -sS -m 8 -w '\nhttp=%{http_code}\n' -X POST http://127.0.0.1:3080/api/v1/portal/billing/resume \
  -H 'Content-Type: application/json' -d '{}'
echo '--- UI ---'
curl -sS -m 8 http://127.0.0.1:3080/js/portal.js | grep -c 'Upgrade to Premium\|Downgrade to Free\|startPortalChangePlan\|data-change-plan'
curl -sS -m 8 -o /dev/null -w 'portal_html=%{http_code}\n' http://127.0.0.1:3080/portal
echo done
