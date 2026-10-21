/** Re-export + publish preview URLs for modular sites 1–3. */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const engine = require('../src/websiteEngine');
const openPreview = require('../src/openPreview');

const DB = process.env.WS_DB || '/app/data/workspaces/1/websitescout.db';
const ids = [1, 2, 3];
const db = new Database(DB);

async function main() {
  for (const id of ids) {
    const outDir = path.join(openPreview.exportRoot(), `site-${id}`);
    fs.mkdirSync(outDir, { recursive: true });
    engine.exportStatic(db, id, outDir);
    console.log('exported', id, outDir);
  }
  db.close();

  // Prefer domain preview publish when available (Cloudflare / APP_URL).
  try {
    const domain = require('../server/domain');
    const ws = 1;
    for (const id of ids) {
      try {
        const r = await domain.sitesPreview(ws, id, { force: true });
        console.log('preview', id, JSON.stringify(r && (r.url || r.previewUrl || r)));
      } catch (e) {
        console.warn('preview', id, e.message || e);
      }
    }
  } catch (e) {
    console.warn('domain preview skipped', e.message || e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
