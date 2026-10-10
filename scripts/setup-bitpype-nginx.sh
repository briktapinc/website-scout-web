#!/usr/bin/env bash
set -euo pipefail

# Remove any broken connection_upgrade map lines from a prior attempt
python3 - <<'PY'
from pathlib import Path
p = Path('/etc/nginx/nginx.conf')
lines = p.read_text().splitlines(True)
out = []
skip = 0
i = 0
while i < len(lines):
    line = lines[i]
    if 'map $http_upgrade $connection_upgrade' in line or 'map  $http_upgrade' in line:
        # skip this map block
        depth = line.count('{') - line.count('}')
        i += 1
        while i < len(lines) and depth > 0:
            depth += lines[i].count('{') - lines[i].count('}')
            i += 1
        continue
    # also drop orphaned broken single-line map
    if line.strip().startswith('map ') and 'connection_upgrade' in line and '{' not in line:
        i += 1
        continue
    out.append(line)
    i += 1
text = ''.join(out)
if 'connection_upgrade' not in text:
    text = text.replace(
        'http {',
        """http {
    map $http_upgrade $connection_upgrade {
        default upgrade;
        '' close;
    }
""",
        1,
    )
p.write_text(text)
print('nginx.conf cleaned')
PY

cat > /etc/nginx/sites-available/bitpype.com <<'EOF'
# bitpype.com — Website Scout Web (Docker :3080)
server {
    listen 80;
    listen [::]:80;
    server_name bitpype.com www.bitpype.com;

    client_max_body_size 64M;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 600s;
        proxy_buffering off;
    }
}
EOF

ln -sf /etc/nginx/sites-available/bitpype.com /etc/nginx/sites-enabled/bitpype.com
nginx -t
systemctl reload nginx

cd /root/website-scout-web
if grep -q '^APP_URL=' .env; then
  sed -i 's|^APP_URL=.*|APP_URL=https://bitpype.com|' .env
else
  echo 'APP_URL=https://bitpype.com' >> .env
fi
grep -E '^(APP_URL|APP_PORT)=' .env
docker compose up -d app
echo NGINX_OK
