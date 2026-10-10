#!/usr/bin/env bash
set -euo pipefail
python3 /tmp/fix-nginx-map.py
nginx -t
systemctl reload nginx

python3 - <<'PY'
from pathlib import Path
import re
p = Path('/root/website-scout-web/.env')
t = p.read_text()
t2 = re.sub(r'(?m)^APP_URL=.*$', 'APP_URL=https://bitpype.com', t)
if 'APP_URL=' not in t2:
    t2 += '\nAPP_URL=https://bitpype.com\n'
p.write_text(t2)
print([l for l in t2.splitlines() if l.startswith('APP_URL')])
PY

cd /root/website-scout-web
docker compose up -d app
echo DONE
