'use strict';
const path = require('path');
process.chdir('/app');
const Database = require('better-sqlite3');
const forms = require('/app/server/contactForms');
const paths = [
  '/app/data/workspaces/1/websitescout.db',
  '/app/data/workspaces/2/websitescout.db',
];
for (const p of paths) {
  try {
    const db = new Database(p);
    const before = db.prepare('PRAGMA table_info(contact_forms)').all().map((c) => c.name);
    console.log('before', path.basename(path.dirname(p)), before.join(','));
    forms.ensureTables(db);
    const after = db.prepare('PRAGMA table_info(contact_forms)').all().map((c) => c.name);
    console.log('after', path.basename(path.dirname(p)), after.includes('sort_order') ? 'HAS sort_order' : 'MISSING', after.join(','));
    db.close();
  } catch (e) {
    console.log('ERR', p, e.message);
  }
}
