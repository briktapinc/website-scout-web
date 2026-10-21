#!/bin/sh
set -e
cd /root/website-scout-web
BOOTSTRAP_EMAIL=$(python3 - <<'PY'
from pathlib import Path
t = Path('.env').read_bytes()
if t.startswith(b'\xef\xbb\xbf'): t = t[3:]
for line in t.decode('utf-8', 'replace').splitlines():
    if line.startswith('BOOTSTRAP_EMAIL='):
        print(line.split('=',1)[1].strip().strip('"').strip("'"))
        break
PY
)
BOOTSTRAP_PASSWORD=$(python3 - <<'PY'
from pathlib import Path
t = Path('.env').read_bytes()
if t.startswith(b'\xef\xbb\xbf'): t = t[3:]
for line in t.decode('utf-8', 'replace').splitlines():
    if line.startswith('BOOTSTRAP_PASSWORD='):
        print(line.split('=',1)[1].strip().strip('"').strip("'"))
        break
PY
)
echo "email=$BOOTSTRAP_EMAIL"
sleep 2
docker exec \
  -e APP_URL=https://bitpype.com \
  -e BOOTSTRAP_EMAIL="$BOOTSTRAP_EMAIL" \
  -e BOOTSTRAP_PASSWORD="$BOOTSTRAP_PASSWORD" \
  -w /app \
  website-scout-web-app-1 \
  node scripts/_smoke-preview-url.js
