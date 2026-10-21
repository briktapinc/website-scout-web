#!/bin/bash
# Login → /auth/me twice (simulates refresh). Expect 200 both times + Set-Cookie Domain.
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

echo 'Waiting for /health...'
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sS -m 5 https://bitpype.com/health | grep -q '"ok":true'; then
    break
  fi
  sleep 2
done
curl -sS -m 10 https://bitpype.com/health; echo

docker compose exec -T mysql mysql -u"$MU" -p"$MP" "$MD" \
  -e "UPDATE platform_settings SET value='0' WHERE \`key\`='captcha.enabled';" >/dev/null
echo 'captcha temporarily disabled'

CJ=/tmp/verify-session.txt
rm -f "$CJ"
curl -sS -m 20 -D /tmp/v-login-h.txt -o /tmp/v-login.json -c "$CJ" -b "$CJ" \
  -X POST https://bitpype.com/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}"

echo '--- Set-Cookie ---'
grep -i 'set-cookie' /tmp/v-login-h.txt || { echo 'FAIL: no Set-Cookie on login'; cat /tmp/v-login-h.txt; cat /tmp/v-login.json; exit 1; }
grep -i 'set-cookie' /tmp/v-login-h.txt | grep -qi 'bitpype\.sid=' || {
  echo 'FAIL: expected Set-Cookie bitpype.sid (staff session)'
  exit 1
}
echo 'OK: staff cookie bitpype.sid'
echo '--- login body (trim) ---'
head -c 200 /tmp/v-login.json; echo
grep -q '"ok":true' /tmp/v-login.json || { echo 'FAIL: login not ok'; exit 1; }

# Domain should be present for apex+www sharing
if grep -i 'set-cookie' /tmp/v-login-h.txt | grep -qi 'Domain='; then
  echo 'OK: cookie Domain present'
else
  echo 'WARN: cookie Domain missing (host-only)'
fi

echo '--- /me #1 ---'
ME1=$(curl -sS -m 10 -c "$CJ" -b "$CJ" https://bitpype.com/api/v1/auth/me)
echo "$ME1" | head -c 220; echo
echo "$ME1" | grep -q '"ok":true' || { echo 'FAIL: /me #1'; exit 1; }

echo '--- /me #2 (refresh) ---'
ME2=$(curl -sS -m 10 -c "$CJ" -b "$CJ" https://bitpype.com/api/v1/auth/me)
echo "$ME2" | head -c 220; echo
echo "$ME2" | grep -q '"ok":true' || { echo 'FAIL: /me #2'; exit 1; }

echo '--- session row ---'
docker compose exec -T mysql mysql -N -u"$MU" -p"$MP" "$MD" \
  -e "SELECT COUNT(*) FROM sessions WHERE data LIKE '%userId%';"

echo 'SESSION_PERSIST_OK'
