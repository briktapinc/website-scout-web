#!/bin/bash
# Deploy nav CTA/route dedupe + module styling guidance (MCP + portal).
set -euo pipefail
cd /root/website-scout-web
CTR=website-scout-web-app-1

FILES=(
  src/websiteEngine.js
  src/siteStructure.js
  src/mcpCatalog.js
  src/defaultDesignInstructions.js
  src/designJobs.js
  server/siteModules.js
  server/mcp.js
  server/clientMcp.js
  server/domain.js
  public/portal.html
  public/portal.vps.html
  public/js/portal.js
  public/js/portal.vps.js
  scripts/_test-nav-route-dedupe.js
)

for f in "${FILES[@]}"; do
  docker exec "$CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "$f" "$CTR:/app/$f"
  echo "copied $f"
done

docker compose restart app
echo "waiting for listen..."
for i in $(seq 1 40); do
  if docker logs "$CTR" --tail 80 2>&1 | grep -q 'listening on'; then
    echo "up"
    break
  fi
  sleep 1
done

echo "--- smoke ---"
docker exec "$CTR" node /app/scripts/_test-nav-route-dedupe.js

echo "--- Book Now / Home scan (recent + North Harbor) ---"
docker exec "$CTR" node -e "
const Database = require('better-sqlite3');
const fs = require('fs');
const eng = require('/app/src/websiteEngine');
const structure = require('/app/src/siteStructure');
const candidates = [
  process.env.DB_PATH,
  '/data/website-scout-web.sqlite',
  '/data/workspaces/1/websitescout.db',
  '/app/data/website-scout-web.sqlite',
  '/app/data/workspaces/1/websitescout.db',
].filter(Boolean);
let db = null;
for (const p of candidates) {
  try {
    if (fs.existsSync(p)) { db = new Database(p, { readonly: true }); console.log('db', p); break; }
  } catch {}
}
if (!db) { console.log('no_db'); process.exit(0); }

function countLabel(html, re) {
  const navs = String(html || '').match(/<nav\\b[\\s\\S]*?<\\/nav>/gi) || [];
  let n = 0;
  for (const nav of navs) {
    n += [...nav.matchAll(/<a\\b[^>]*>[\\s\\S]*?<\\/a>/gi)].filter((m) =>
      re.test(m[0].replace(/<[^>]+>/g, ''))
    ).length;
  }
  return n;
}
function navSource(page) {
  const sec = (page.sections || []).find((s) => s && s.type === 'nav');
  if (sec && sec.content && typeof sec.content.html === 'string') return sec.content.html;
  return page.html || '';
}

const rows = db.prepare(
  \"SELECT id, name, pages FROM websites WHERE name LIKE '%North Harbor%' OR name LIKE '%QA%' ORDER BY id DESC LIMIT 12\"
).all();
if (!rows.length) {
  const latest = db.prepare('SELECT id, name, pages FROM websites ORDER BY id DESC LIMIT 8').all();
  rows.push(...latest);
}
let bad = 0;
for (const row of rows) {
  let pages = [];
  try { pages = JSON.parse(row.pages || '[]'); } catch { continue; }
  if (!pages.length) continue;
  pages = structure.syncFreeformNavOrder(JSON.parse(JSON.stringify(pages)));
  const rendered = eng.renderPage(pages[0], pages, { name: row.name || 'Site' }, { preview: false });
  const book = countLabel(rendered, /\\bbook now\\b/i);
  const home = countLabel(rendered, /\\bhome\\b/i);
  const issues = eng.findNavDuplicateIssues(rendered);
  console.log('site', row.id, JSON.stringify(row.name), 'bookNow', book, 'home', home, 'dupIssues', issues.length);
  if (book > 1 || home > 1 || issues.length) bad += 1;
}
if (bad) { console.error('nav_dupes_found', bad); process.exit(2); }
console.log('nav_scan_ok');
"

echo DONE
