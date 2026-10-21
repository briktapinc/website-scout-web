#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

echo "=== env (masked) ==="
python3 scripts/check-env.py
grep -E '^(COOKIE_SECURE|APP_URL|NODE_ENV|MYSQL_USER|MYSQL_DATABASE)=' .env || true

MU=$(grep '^MYSQL_USER=' .env | cut -d= -f2-)
MP=$(grep '^MYSQL_PASSWORD=' .env | cut -d= -f2-)
MD=$(grep '^MYSQL_DATABASE=' .env | cut -d= -f2-)
echo "mysql user=$MU db=$MD"

echo "=== sessions table ==="
docker compose exec -T mysql mysql -u"$MU" -p"$MP" "$MD" <<'SQL'
SHOW TABLES LIKE 'sessions';
DESCRIBE sessions;
SELECT COUNT(*) AS session_count FROM sessions;
SELECT session_id, expires, LENGTH(data) AS data_len, FROM_UNIXTIME(expires/1000) AS expires_at
FROM sessions ORDER BY expires DESC LIMIT 5;
SQL

echo "=== app session store write test ==="
docker compose exec -T app node <<'NODE'
const { MySQLSessionStore } = require('./server/sessionStore');
const { query, driver } = require('./server/db');
(async () => {
  console.log('driver', driver());
  try {
    const rows = await query('SELECT COUNT(*) AS n FROM sessions');
    console.log('count_before', rows);
  } catch (e) {
    console.error('count_err', e.message);
  }
  const store = new MySQLSessionStore();
  await new Promise((resolve, reject) => {
    store.set('probe-sid-test', { cookie: { maxAge: 60000 }, userId: 999 }, (err) => err ? reject(err) : resolve());
  });
  const got = await new Promise((resolve, reject) => {
    store.get('probe-sid-test', (err, sess) => err ? reject(err) : resolve(sess));
  });
  console.log('roundtrip', got);
  await new Promise((resolve, reject) => {
    store.destroy('probe-sid-test', (err) => err ? reject(err) : resolve());
  });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
NODE

echo "=== login Set-Cookie via localhost:3080 ==="
CJ=/tmp/ws-auth-probe.txt
rm -f "$CJ"
EMAIL=$(grep '^BOOTSTRAP_EMAIL=' .env | cut -d= -f2-)
PASS=$(grep '^BOOTSTRAP_PASSWORD=' .env | cut -d= -f2-)
if [ -z "$EMAIL" ] || [ -z "$PASS" ]; then
  EMAIL=owner@example.com
  PASS=ChangeMe_Scout1
fi
echo "login as $EMAIL"
curl -sS -m 20 -D /tmp/login-hdrs.txt -o /tmp/login-body.json -c "$CJ" -b "$CJ" \
  -X POST http://127.0.0.1:3080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" || true
grep -iE 'HTTP/|set-cookie' /tmp/login-hdrs.txt || true
echo "login body:"; head -c 500 /tmp/login-body.json; echo
echo "cookie jar:"; cat "$CJ" || true; echo

echo "=== /auth/me with cookie (localhost) ==="
curl -sS -m 10 -D /tmp/me-hdrs.txt -o /tmp/me-body.json -c "$CJ" -b "$CJ" http://127.0.0.1:3080/api/v1/auth/me || true
grep -iE 'HTTP/|set-cookie' /tmp/me-hdrs.txt || true
cat /tmp/me-body.json; echo

echo "=== sessions after login ==="
docker compose exec -T mysql mysql -N -u"$MU" -p"$MP" "$MD" -e "SELECT COUNT(*) FROM sessions;"

echo "=== public https login ==="
rm -f /tmp/ws-auth-pub.txt
curl -sS -m 20 -D /tmp/login-pub-hdrs.txt -o /tmp/login-pub.json -c /tmp/ws-auth-pub.txt -b /tmp/ws-auth-pub.txt \
  -X POST https://bitpype.com/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" || true
grep -iE 'HTTP/|set-cookie' /tmp/login-pub-hdrs.txt || true
echo "pub body:"; head -c 500 /tmp/login-pub.json; echo
curl -sS -m 10 -c /tmp/ws-auth-pub.txt -b /tmp/ws-auth-pub.txt https://bitpype.com/api/v1/auth/me; echo

echo "=== nginx cookie / proxy bits ==="
grep -RInE 'proxy_cookie|proxy_set_header|Secure|SameSite|3080|bitpype' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | head -80 || true
