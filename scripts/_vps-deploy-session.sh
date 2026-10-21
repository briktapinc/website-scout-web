#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

if ! grep -q '^COOKIE_DOMAIN=' .env 2>/dev/null; then
  echo 'COOKIE_DOMAIN=.bitpype.com' >> .env
  echo 'appended COOKIE_DOMAIN=.bitpype.com'
else
  echo -n 'COOKIE_DOMAIN='; grep '^COOKIE_DOMAIN=' .env | cut -d= -f2-
fi

chmod +x scripts/_vps-fix-nginx-www.sh scripts/_verify-session.sh scripts/_probe-login-cookie.sh || true
bash scripts/_vps-fix-nginx-www.sh

echo 'Building app image...'
docker compose build app
docker compose up -d app

echo 'Waiting for container...'
for i in $(seq 1 20); do
  status=$(docker compose ps --status running --services 2>/dev/null | grep -c '^app$' || true)
  if [ "$status" = "1" ]; then
    if curl -sS -m 3 http://127.0.0.1:3080/health | grep -q '"ok":true'; then
      echo 'app healthy'
      break
    fi
  fi
  sleep 2
done

docker compose ps
docker compose logs --tail=40 app

bash scripts/_verify-session.sh
chmod +x scripts/_verify-dual-session.sh || true
bash scripts/_verify-dual-session.sh
