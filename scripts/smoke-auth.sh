#!/usr/bin/env bash
set -euo pipefail
sleep 4
curl -sS -m 15 https://bitpype.com/health; echo
CJ=/tmp/ws-auth.txt
rm -f "$CJ"
LOGIN=$(curl -sS -m 15 -c "$CJ" -b "$CJ" -X POST https://bitpype.com/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@example.com","password":"ChangeMe_Scout1"}')
echo "LOGIN=$LOGIN"
echo "$LOGIN" | grep -q '"productAccess":true' || { echo 'FAIL productAccess'; exit 1; }
echo "$LOGIN" | grep -q '"subscribed":true' || { echo 'FAIL subscribed'; exit 1; }
ME=$(curl -sS -m 10 -c "$CJ" -b "$CJ" https://bitpype.com/api/v1/auth/me)
echo "ME=$ME"
LEADS=$(curl -sS -m 10 -c "$CJ" -b "$CJ" -H 'X-Workspace-Id: 1' -o /tmp/leads.json -w '%{http_code}' https://bitpype.com/api/v1/leads)
echo "LEADS_HTTP=$LEADS"
test "$LEADS" = "200"
echo SMOKE_OK
