#!/usr/bin/env bash
set -euo pipefail
cd /root/website-scout-web
for i in $(seq 1 20); do
  if docker logs website-scout-web-app-1 --tail 40 2>&1 | grep -q 'listening on'; then
    echo "app up"
    break
  fi
  sleep 2
done

docker compose exec -T app node <<'NODE'
const d = require('./server/domain');
const r = d.sitesRenderHtml(1, 1, {});
const hasBase = /data-ws-preview-base/.test(r.html);
const m = r.html.match(/base href="([^"]+)/);
console.log(JSON.stringify({ hasBase, href: m && m[1], htmlLen: r.html.length }));
const r2 = d.designRenderHtml(1, { id: 3 });
const m2 = r2.html.match(/base href="([^"]+)/);
console.log(JSON.stringify({ designHasBase: /data-ws-preview-base/.test(r2.html), designHref: m2 && m2[1] }));
NODE

curl -sS -o /dev/null -w "logo=%{http_code}\n" \
  "https://bitpype.com/site-previews/ws-1-site-1-c59b86331ad92def21/images/logo.png"
curl -sS -o /dev/null -w "hero=%{http_code}\n" \
  "https://bitpype.com/site-previews/ws-1-site-1-c59b86331ad92def21/images/openai-1791846348932-1.png"
echo done
