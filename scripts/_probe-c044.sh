#!/bin/sh
set -e
URL='https://c044edda.site-1-1ol.pages.dev/'
APEX='https://site-1-1ol.pages.dev/'
echo "=== $URL ==="
curl -sS -D /tmp/cf-hdrs.txt -o /tmp/cfbody.bin "$URL" || echo "curl_exit=$?"
echo "--- headers ---"
cat /tmp/cf-hdrs.txt
echo "BODY_LEN=$(wc -c < /tmp/cfbody.bin)"
echo "--- body hex ---"
xxd /tmp/cfbody.bin | head -n 8 || true
echo "=== $APEX ==="
curl -sS -D /tmp/apex-hdrs.txt -o /tmp/apex.bin "$APEX" || echo "curl_exit=$?"
cat /tmp/apex-hdrs.txt
echo "APEX_LEN=$(wc -c < /tmp/apex.bin)"
echo "=== dig ==="
dig +short c044edda.site-1-1ol.pages.dev A || nslookup c044edda.site-1-1ol.pages.dev || true
dig +short site-1-1ol.pages.dev A || true
