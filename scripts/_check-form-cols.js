'use strict';
const Database = require('better-sqlite3');
const paths = [
  '/app/data/workspaces/1/websitescout.db',
  '/app/data/workspaces/2/websitescout.db',
];
for (const p of paths) {
  try {
    const db = new Database(p);
    const cols = db.prepare('PRAGMA table_info(contact_forms)').all().map((c) => c.name);
    console.log(p, cols.join(',') || '(no table)');
    db.close();
  } catch (e) {
    console.log(p, 'ERR', e.message);
  }
}
