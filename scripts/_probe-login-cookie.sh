#!/bin/bash
set -euo pipefail
cd /root/website-scout-web
MU=$(grep '^MYSQL_USER=' .env | cut -d= -f2-)
MP=$(grep '^MYSQL_PASSWORD=' .env | cut -d= -f2-)
MD=$(grep '^MYSQL_DATABASE=' .env | cut -d= -f2-)
EMAIL=$(grep '^BOOTSTRAP_EMAIL=' .env | cut -d= -f2-)
PASS=$(grep '^BOOTSTRAP_PASSWORD=' .env | cut -d= -f2-)

restore() {
  docker compose exec -T mysql mysql -u"$MU" -p"$MP" "$MD" -e "UPDATE platform_settings SET value='1' WHERE \`key\`='captcha.enabled';" >/dev/null
  echo "captcha restored"
}
trap restore EXIT

docker compose exec -T mysql mysql -u"$MU" -p"$MP" "$MD" -e "UPDATE platform_settings SET value='0' WHERE \`key\`='captcha.enabled';" >/dev/null
echo "captcha disabled for probe"

CJ=/tmp/login-test.txt
rm -f "$CJ"
curl -sS -m 20 -D /tmp/lh.txt -o /tmp/lb.json -c "$CJ" -b "$CJ" \
  -X POST https://bitpype.com/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}"
echo '--- login headers ---'
cat /tmp/lh.txt
echo '--- login body ---'
cat /tmp/lb.json; echo
echo '--- cookie jar ---'
cat "$CJ"; echo

echo '--- me1 ---'
curl -sS -m 10 -D /tmp/me1h.txt -o /tmp/me1.json -c "$CJ" -b "$CJ" https://bitpype.com/api/v1/auth/me
grep -iE 'HTTP/|set-cookie' /tmp/me1h.txt || true
cat /tmp/me1.json; echo

echo '--- me2 refresh ---'
curl -sS -m 10 -c "$CJ" -b "$CJ" https://bitpype.com/api/v1/auth/me; echo

# Portal login probe if we have a portal user
echo '--- portal login ---'
PCJ=/tmp/portal-test.txt
rm -f "$PCJ"
# find a portal email
PEMAIL=$(docker compose exec -T mysql mysql -N -u"$MU" -p"$MP" "$MD" -e "SELECT email FROM client_portal_users WHERE status='active' LIMIT 1;")
echo "portal email=$PEMAIL"
# can't know password; just check /portal/me without cookie
curl -sS -m 10 https://bitpype.com/api/v1/portal/me; echo
