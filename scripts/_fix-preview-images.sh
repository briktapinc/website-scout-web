#!/usr/bin/env bash
set -euo pipefail
cd /root/website-scout-web
APP=website-scout-web-app-1

echo "=== export root ==="
docker compose exec -T app sh -c 'echo EXPORT_ROOT=$EXPORT_ROOT; ls -la "$EXPORT_ROOT"'

echo "=== site-1 images folders ==="
docker compose exec -T app sh -c '
for d in "$EXPORT_ROOT"/ws-1-site-1*; do
  echo "-- $d"
  ls -la "$d/images" 2>&1 | head -20 || true
done
echo "-- design-3/images"
ls -la "$EXPORT_ROOT/design-3/images" 2>&1 | head -20
'

echo "=== db preview ==="
docker compose exec -T app node <<'NODE'
const { openWorkspaceDb } = require('./server/workspaceDb');
const db = openWorkspaceDb(1);
const w = db.prepare('SELECT id, preview_url, preview_path, export_slug FROM websites WHERE id = 1').get();
console.log(JSON.stringify(w, null, 2));
const theme = JSON.parse((db.prepare('SELECT theme FROM websites WHERE id = 1').get() || {}).theme || '{}');
console.log('logoMode', theme.logoMode, 'logoUrl', theme.logoUrl || theme.logo);
const pages = JSON.parse((db.prepare('SELECT pages FROM websites WHERE id = 1').get() || {}).pages || '[]');
const html = (pages[0] && pages[0].html) || '';
const srcs = [...html.matchAll(/src=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 20);
console.log('index srcs', srcs);
NODE

echo "=== force rematerialize + preview ==="
docker compose exec -T app node <<'NODE'
const domain = require('./server/domain');
(async () => {
  const out = await domain.sitesPreview(1, 1, { force: true });
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
NODE

echo "=== curl site-previews ==="
FOLDER=$(docker compose exec -T app node -e "const {openWorkspaceDb}=require('./server/workspaceDb');const db=openWorkspaceDb(1);const w=db.prepare('SELECT export_slug,preview_path FROM websites WHERE id=1').get();console.log(w.export_slug||w.preview_path||'');")
FOLDER=$(echo "$FOLDER" | tr -d '\r')
echo "folder=$FOLDER"
curl -sS -o /dev/null -w "logo_local=%{http_code}\n" "https://bitpype.com/site-previews/${FOLDER}/images/logo.png" || true
curl -sS -o /dev/null -w "hero_local=%{http_code}\n" "https://bitpype.com/site-previews/${FOLDER}/images/openai-1791846348932-1.png" || true
curl -sS -o /dev/null -w "logo_cf=%{http_code}\n" "https://bp-w1-s1.pages.dev/images/logo.png" || true
curl -sS -o /dev/null -w "hero_cf=%{http_code}\n" "https://bp-w1-s1.pages.dev/images/openai-1791846348932-1.png" || true

echo "fix-preview-images done"
