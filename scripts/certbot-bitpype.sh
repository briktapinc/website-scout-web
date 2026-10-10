#!/usr/bin/env bash
set -euo pipefail

# Confirm public DNS before requesting a cert
A=$(dig @8.8.8.8 +short bitpype.com A | tail -n1)
WA=$(dig @8.8.8.8 +short www.bitpype.com A | tail -n1)
echo "bitpype.com -> $A"
echo "www.bitpype.com -> $WA"
if [ "$A" != "187.77.16.73" ] || [ "$WA" != "187.77.16.73" ]; then
  echo "DNS not pointing at this VPS yet; aborting certbot."
  exit 1
fi

certbot --nginx -d bitpype.com -d www.bitpype.com --non-interactive --agree-tos --redirect \
  --register-unsafely-without-email || \
certbot --nginx -d bitpype.com -d www.bitpype.com --non-interactive --agree-tos --redirect \
  -m admin@bitpype.com

nginx -t
systemctl reload nginx

echo '--- health via https ---'
curl -sS -m 20 -o /tmp/bp-health.json -w 'https:%{http_code}\n' https://bitpype.com/health || true
cat /tmp/bp-health.json 2>/dev/null || true
echo
curl -sS -m 15 -o /dev/null -w 'www:%{http_code} url:%{url_effective}\n' -L https://www.bitpype.com/ || true
echo CERT_OK
