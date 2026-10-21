/** Find original freeform versions / design deliverables for sites 1–3. */
const Database = require('better-sqlite3');
const DB = process.env.WS_DB || '/app/data/workspaces/1/websitescout.db';
const db = new Database(DB, { readonly: true });

for (const id of [1, 2, 3]) {
  const site = db.prepare('SELECT id, lead_id, name, origin, length(pages) plen FROM websites WHERE id=?').get(id);
  console.log('\n=== site', id, site && site.name);
  if (!site) continue;
  const vers = db.prepare(
    `SELECT id, version_no, note, length(pages) plen, created_at
     FROM website_versions WHERE website_id=? ORDER BY version_no DESC LIMIT 15`
  ).all(id);
  console.log('versions', vers.map((v) => ({
    n: v.version_no,
    note: String(v.note || '').slice(0, 80),
    plen: v.plen,
    at: v.created_at,
  })));
  // Find a version that looks freeform (large pages blob with html)
  for (const v of vers) {
    const row = db.prepare('SELECT pages, theme FROM website_versions WHERE id=?').get(v.id);
    let pages = [];
    try { pages = JSON.parse(row.pages || '[]'); } catch { continue; }
    const free = pages.filter((p) => p && String(p.html || '').trim().length > 500).length;
    const secs = pages.filter((p) => p && Array.isArray(p.sections) && p.sections.length).length;
    if (free > 0) {
      console.log('  freeform candidate v', v.version_no, { free, secs, pages: pages.length });
    }
  }
  const jobs = db.prepare(
    `SELECT id, status, length(deliverable) dlen, updated_at FROM design_jobs WHERE lead_id=? ORDER BY id DESC LIMIT 5`
  ).all(site.lead_id);
  console.log('design_jobs', jobs);
  for (const j of jobs) {
    if (!j.dlen) continue;
    const del = db.prepare('SELECT deliverable FROM design_jobs WHERE id=?').get(j.id);
    let payload;
    try { payload = JSON.parse(del.deliverable); } catch { continue; }
    const pages = Array.isArray(payload.pages) ? payload.pages : [];
    const free = pages.filter((p) => p && String(p.html || '').trim().length > 500).length;
    console.log('  job', j.id, 'freeformPages', free, 'themeCss', !!(payload.theme && payload.theme.customCss));
  }
}
db.close();
