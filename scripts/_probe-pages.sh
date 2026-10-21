#!/bin/sh
set -e
URL1="https://d64cf698.site-1-1ol.pages.dev/"
URL2="https://site-1-1ol.pages.dev/"
URL3="https://1c17a27f.site-1-1ol.pages.dev/"
for u in "$URL1" "$URL2" "$URL3"; do
  echo "=== $u ==="
  curl -sS -D - -o /tmp/pages-body.html "$u" | head -n 30
  echo "body_len=$(wc -c </tmp/pages-body.html)"
  head -c 800 /tmp/pages-body.html; echo
done
# Also APP_URL static if exported
echo "=== bitpype site-previews ==="
curl -sS -D - -o /tmp/app-body.html "https://bitpype.com/site-previews/ws-1-site-1-csscheck/" | head -n 20
echo "body_len=$(wc -c </tmp/app-body.html)"
head -c 800 /tmp/app-body.html; echo
grep -c 'data-ws-theme' /tmp/app-body.html || true
