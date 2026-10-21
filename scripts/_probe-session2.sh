#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

MU=$(grep '^MYSQL_USER=' .env | cut -d= -f2-)
MP=$(grep '^MYSQL_PASSWORD=' .env | cut -d= -f2-)
MD=$(grep '^MYSQL_DATABASE=' .env | cut -d= -f2-)

echo "=== sample session rows ==="
docker compose exec -T mysql mysql -u"$MU" -p"$MP" "$MD" -e "SELECT session_id, LEFT(data,300) AS data FROM sessions ORDER BY expires DESC LIMIT 3;"

echo "=== captcha platform settings ==="
docker compose exec -T mysql mysql -N -u"$MU" -p"$MP" "$MD" -e "SELECT \`key\`, LEFT(value,40) FROM platform_settings WHERE \`key\` LIKE 'captcha%';"

echo "=== forge session + hit /auth/me ==="
docker compose exec -T app node <<'NODE'
const signature = require('cookie-signature');
const { MySQLSessionStore } = require('./server/sessionStore');
const { query } = require('./server/db');

(async () => {
  const users = await query('SELECT id, email FROM users ORDER BY id ASC LIMIT 1');
  const user = users[0];
  if (!user) throw new Error('no users');
  console.log('user', user.id, user.email);

  const sid = 'test' + require('crypto').randomBytes(16).toString('hex');
  const sess = {
    cookie: {
      originalMaxAge: 14 * 24 * 60 * 60 * 1000,
      maxAge: 14 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    },
    userId: user.id,
    workspaceId: 1,
  };
  const store = new MySQLSessionStore();
  await new Promise((resolve, reject) => store.set(sid, sess, (e) => (e ? reject(e) : resolve())));

  const secret = process.env.SESSION_SECRET;
  const signed = 's:' + signature.sign(sid, secret);
  console.log('sid', sid);
  console.log('cookie_value_prefix', signed.slice(0, 20));

  const http = require('http');
  const cookie = 'scout.sid=' + encodeURIComponent(signed);
  await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: 3000,
      path: '/api/v1/auth/me',
      headers: { Cookie: cookie, Accept: 'application/json' },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        console.log('me_status', res.statusCode);
        console.log('me_body', b.slice(0, 400));
        console.log('set_cookie', res.headers['set-cookie']);
        resolve();
      });
    });
    req.on('error', reject);
    req.end();
  });

  // Also test via https public with forged cookie
  const https = require('https');
  await new Promise((resolve, reject) => {
    const req = https.request({
      host: 'bitpype.com',
      path: '/api/v1/auth/me',
      headers: { Cookie: cookie, Accept: 'application/json' },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        console.log('pub_me_status', res.statusCode);
        console.log('pub_me_body', b.slice(0, 400));
        resolve();
      });
    });
    req.on('error', reject);
    req.end();
  });

  await new Promise((resolve, reject) => store.destroy(sid, (e) => (e ? reject(e) : resolve())));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
NODE

echo "=== nginx server block ==="
sed -n '1,55p' /etc/nginx/sites-enabled/bitpype.com
