#!/bin/bash
# Redirect www.bitpype.com → https://bitpype.com so session cookies stay consistent.
set -euo pipefail
CONF=/etc/nginx/sites-enabled/bitpype.com
if [ ! -f "$CONF" ]; then
  echo "nginx conf missing: $CONF"
  exit 1
fi

if grep -q 'www.bitpype.com → apex' "$CONF" 2>/dev/null; then
  echo 'nginx www→apex redirect already present'
else
  # Insert a dedicated www server block before the main HTTPS server if missing.
  # Safer: rewrite the shared server_name so only apex serves the app, and add www redirect.
  # Backup the real file (sites-enabled entry may be a symlink — never copy into sites-enabled).
  REAL=$(readlink -f "$CONF")
  cp -a "$REAL" "${REAL}.bak.$(date +%Y%m%d%H%M%S)"
  # Drop any accidental backup symlinks that would double-load this vhost.
  rm -f /etc/nginx/sites-enabled/bitpype.com.bak.* 2>/dev/null || true
  python3 - <<'PY'
from pathlib import Path
path = Path('/etc/nginx/sites-enabled/bitpype.com')
text = path.read_text()
marker = '# www.bitpype.com → apex (session cookie host consistency)\n'
if marker in text:
    print('already patched')
    raise SystemExit(0)

redirect_block = '''# www.bitpype.com → apex (session cookie host consistency)
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name www.bitpype.com;

    ssl_certificate /etc/letsencrypt/live/bitpype.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bitpype.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    return 301 https://bitpype.com$request_uri;
}

'''

# Keep certbot-managed listen lines on the apex server; strip www from its server_name.
import re
text2 = re.sub(
    r'(server_name\s+)bitpype\.com\s+www\.bitpype\.com\s*;',
    r'\1bitpype.com;',
    text,
    count=1,
)
if text2 == text:
    # Fallback: only change first occurrence of both names
    text2 = text.replace('server_name bitpype.com www.bitpype.com;', 'server_name bitpype.com;', 1)

path.write_text(redirect_block + text2)
print('patched nginx: www → apex')
PY
fi

nginx -t
systemctl reload nginx
echo 'nginx reloaded'

# Quick check
code=$(curl -sS -o /dev/null -w '%{http_code}' -m 10 https://www.bitpype.com/health || true)
loc=$(curl -sS -o /dev/null -w '%{redirect_url}' -m 10 https://www.bitpype.com/health || true)
echo "www /health -> HTTP $code redirect=$loc"
