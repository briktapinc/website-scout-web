'use strict';
/**
 * Re-apply published module embeds and managed nav links on existing sites.
 * Run inside the app container: node /app/scripts/_resync-module-nav.js
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const modules = require('../server/siteModules');

const root = path.join(__dirname, '..', 'data', 'workspaces');
if (!fs.existsSync(root)) {
  console.log('no workspaces dir');
  process.exit(0);
}

for (const name of fs.readdirSync(root)) {
  const dbPath = path.join(root, name, 'websitescout.db');
  if (!fs.existsSync(dbPath)) continue;
  const db = new Database(dbPath);
  let leads = [];
  try {
    leads = db.prepare(
      'SELECT DISTINCT lead_id FROM site_module_embeds'
    ).all();
  } catch (err) {
    console.log('workspace', name, 'skip', err.message);
    db.close();
    continue;
  }
  // Also catch sites that still have a legacy iframe / bare module page in HTML.
  try {
    const sites = db.prepare('SELECT lead_id, pages FROM websites').all();
    const seen = new Set(leads.map((r) => Number(r.lead_id)));
    for (const site of sites) {
      const html = String(site.pages || '');
      if (/embed\/module\.html|bitpype-module-embed|module-page/i.test(html)) {
        const id = Number(site.lead_id);
        if (!seen.has(id)) {
          seen.add(id);
          leads.push({ lead_id: id });
        }
      }
    }
  } catch (err) {
    console.log('workspace', name, 'pages scan', err.message);
  }
  for (const row of leads) {
    // Ensure rows that already have a token are treated as published so sync
    // rewrites iframe → JS mount and upgrades bare module pages.
    try {
      db.prepare(`
        UPDATE site_module_embeds
        SET published = 1,
            embed_enabled = CASE WHEN embed_enabled IS NULL THEN 1 ELSE embed_enabled END,
            updated_at = datetime('now')
        WHERE lead_id = ?
          AND public_token IS NOT NULL
          AND TRIM(public_token) != ''
          AND (published IS NULL OR published = 0)
      `).run(row.lead_id);
    } catch { /* ignore */ }
    const result = modules.syncSiteModuleEmbeds(db, row.lead_id);
    console.log('workspace', name, 'lead', row.lead_id, JSON.stringify(result));
  }
  if (!leads.length) console.log('workspace', name, 'no module rows');
  db.close();
}
process.exit(0);
