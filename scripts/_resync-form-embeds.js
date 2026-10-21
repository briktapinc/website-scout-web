'use strict';
/**
 * Re-apply published contact form embeds as in-page JS mounts.
 * Run inside the app container: node /app/scripts/_resync-form-embeds.js
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const forms = require('../server/contactForms');

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
      'SELECT DISTINCT lead_id FROM contact_forms WHERE published = 1 AND public_token IS NOT NULL'
    ).all();
  } catch (err) {
    console.log('workspace', name, 'skip', err.message);
    db.close();
    continue;
  }
  try {
    const sites = db.prepare('SELECT lead_id, pages FROM websites').all();
    const seen = new Set(leads.map((r) => Number(r.lead_id)));
    for (const site of sites) {
      const html = String(site.pages || '');
      if (/embed\/form\.html|data-bitpype-form-embed|bitpype-form-embed/i.test(html)) {
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
    const result = forms.syncSiteFormEmbeds(db, row.lead_id);
    console.log('workspace', name, 'lead', row.lead_id, JSON.stringify(result));
  }
  if (!leads.length) console.log('workspace', name, 'no published forms');
  db.close();
}
process.exit(0);
