'use strict';
process.chdir('/app');
const Database = require('better-sqlite3');
const forms = require('/app/server/contactForms');

const db = new Database('/app/data/workspaces/1/websitescout.db');
forms.ensureTables(db);
const lead = db.prepare('SELECT id FROM leads ORDER BY id ASC LIMIT 1').get();
const site = lead
  ? db.prepare('SELECT id, lead_id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(lead.id)
  : null;
console.log('lead', lead && lead.id, 'site', site && site.id);
if (!lead) {
  console.log('NO_LEAD');
  process.exit(0);
}
const out = forms.ensureSiteForms(db, lead.id, { workspaceId: 1, missingOnly: true });
console.log(JSON.stringify({
  created: out.created,
  published: out.published,
  kinds: out.kindsNeeded,
  forms: (out.forms || []).map((f) => ({ id: f.id, kind: f.form_kind, name: f.name, published: f.published, page: f.target_page_slug })),
  sync: out.sync,
}, null, 2));
db.close();
