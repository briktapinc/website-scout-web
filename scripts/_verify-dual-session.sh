#!/bin/bash
# Verify staff + portal sessions use different cookies and do not wipe each other.
set -euo pipefail
cd /root/website-scout-web

MU=$(grep '^MYSQL_USER=' .env | cut -d= -f2-)
MP=$(grep '^MYSQL_PASSWORD=' .env | cut -d= -f2-)
MD=$(grep '^MYSQL_DATABASE=' .env | cut -d= -f2-)
EMAIL=$(grep '^BOOTSTRAP_EMAIL=' .env | cut -d= -f2-)
PASS=$(grep '^BOOTSTRAP_PASSWORD=' .env | cut -d= -f2-)

restore() {
  docker compose exec -T mysql mysql -u"$MU" -p"$MP" "$MD" \
    -e "UPDATE platform_settings SET value='1' WHERE \`key\`='captcha.enabled';" >/dev/null 2>&1 || true
}
trap restore EXIT

docker compose exec -T mysql mysql -u"$MU" -p"$MP" "$MD" \
  -e "UPDATE platform_settings SET value='0' WHERE \`key\`='captcha.enabled';" >/dev/null
echo 'captcha temporarily disabled'

STAFF_CJ=/tmp/dual-staff.txt
rm -f "$STAFF_CJ" /tmp/dual-*.hdr /tmp/dual-*.json /tmp/dual-portal-cred.json

echo '=== 1) Staff login ==='
curl -sS -m 20 -D /tmp/dual-staff.hdr -o /tmp/dual-staff.json -c "$STAFF_CJ" -b "$STAFF_CJ" \
  -X POST https://bitpype.com/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}"
grep -q '"ok":true' /tmp/dual-staff.json || { echo 'FAIL staff login'; cat /tmp/dual-staff.json; exit 1; }
grep -i 'set-cookie' /tmp/dual-staff.hdr | grep -qi 'bitpype\.sid=' || {
  echo 'FAIL: staff login did not Set-Cookie bitpype.sid'
  grep -i 'set-cookie' /tmp/dual-staff.hdr || true
  exit 1
}
if grep -i 'set-cookie' /tmp/dual-staff.hdr | grep -qi 'bitpype\.portal\.sid'; then
  echo 'FAIL: staff login set portal cookie'
  exit 1
fi
echo 'OK staff cookie bitpype.sid'

ME=$(curl -sS -m 10 -c "$STAFF_CJ" -b "$STAFF_CJ" https://bitpype.com/api/v1/auth/me)
echo "$ME" | grep -q '"ok":true' || { echo 'FAIL staff /me'; echo "$ME"; exit 1; }
echo 'OK staff /me'

echo '=== 2) Seed portal credentials (in-container) ==='
docker compose exec -T app node scripts/_seed-dual-portal-cred.js > /tmp/dual-portal-cred.json
cat /tmp/dual-portal-cred.json; echo

if grep -q '"skip":true' /tmp/dual-portal-cred.json; then
  echo 'WARN: no portal lead — staff-only verify'
  echo 'DUAL_SESSION_STAFF_OK'
  exit 0
fi
grep -q '"ok":true' /tmp/dual-portal-cred.json || { echo 'FAIL portal seed'; exit 1; }

PORTAL_EMAIL=$(python3 -c "import json;print(json.load(open('/tmp/dual-portal-cred.json'))['email'])")
PORTAL_PASS=$(python3 -c "import json;print(json.load(open('/tmp/dual-portal-cred.json'))['password'])")
echo "portal user: $PORTAL_EMAIL"

echo '=== 3) Portal login into same jar as staff (must not wipe bitpype.sid) ==='
curl -sS -m 20 -D /tmp/dual-portal.hdr -o /tmp/dual-portal.json -c "$STAFF_CJ" -b "$STAFF_CJ" \
  -X POST https://bitpype.com/api/v1/portal/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$PORTAL_EMAIL\",\"password\":\"$PORTAL_PASS\"}"
grep -q '"ok":true' /tmp/dual-portal.json || { echo 'FAIL portal login'; cat /tmp/dual-portal.json; exit 1; }
grep -i 'set-cookie' /tmp/dual-portal.hdr | grep -qi 'bitpype\.portal\.sid=' || {
  echo 'FAIL: portal login did not Set-Cookie bitpype.portal.sid'
  grep -i 'set-cookie' /tmp/dual-portal.hdr || true
  exit 1
}
if grep -i 'set-cookie' /tmp/dual-portal.hdr | grep -Eiq '(^|[ ;])bitpype\.sid=|set-cookie: bitpype\.sid='; then
  echo 'FAIL: portal login set staff cookie bitpype.sid'
  grep -i 'set-cookie' /tmp/dual-portal.hdr || true
  exit 1
fi
echo 'OK portal cookie bitpype.portal.sid'

PME=$(curl -sS -m 10 -c "$STAFF_CJ" -b "$STAFF_CJ" https://bitpype.com/api/v1/portal/me)
echo "$PME" | grep -q '"ok":true' || { echo 'FAIL portal /me'; echo "$PME"; exit 1; }
echo 'OK portal /me'

ME2=$(curl -sS -m 10 -c "$STAFF_CJ" -b "$STAFF_CJ" https://bitpype.com/api/v1/auth/me)
echo "$ME2" | grep -q '"ok":true' || {
  echo 'FAIL: staff /me broken after portal login'
  echo "$ME2"
  exit 1
}
echo 'OK staff /me survives portal login'

echo 'DUAL_SESSION_OK'
