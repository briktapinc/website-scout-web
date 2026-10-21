/** Compare DB modular status vs preview_url / preview_path for sites 1–3. */
const Database = require('better-sqlite3');
const DB = process.env.WS_DB || '/app/data/workspaces/1/websitescout.db';
const db = new Database(DB, { readonly: true });

for (const id of [1, 2, 3]) {
  const row = db.prepare(
    'SELECT id, name, origin, status, preview_url, preview_path, length(pages) plen FROM websites WHERE id = ?'
  ).get(id);
  let pages = [];
  try { pages = JSON.parse(db.prepare('SELECT pages FROM websites WHERE id=?').get(id).pages || '[]'); } catch {}
  const free = pages.filter((p) => p && String(p.html || '').trim()).length;
  const secs = pages.filter((p) => p && Array.isArray(p.sections) && p.sections.length).length;
  const home = pages[0] || {};
  const types = Array.isArray(home.sections) ? home.sections.map((s) => s.type) : [];
  console.log(JSON.stringify({
    id: row.id,
    name: row.name,
    origin: row.origin,
    preview_url: row.preview_url,
    preview_path: row.preview_path,
    freeformPages: free,
    structuredPages: secs,
    homeSectionTypes: types,
    homeHasHtml: !!(home.html && String(home.html).trim()),
  }, null, 2));
}
db.close();
