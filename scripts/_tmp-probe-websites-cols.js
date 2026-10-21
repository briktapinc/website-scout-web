'use strict';
const { openWorkspaceDb } = require('../server/workspaceDb');
const db = openWorkspaceDb(1);
const cols = db.prepare('PRAGMA table_info(websites)').all().map((c) => c.name);
console.log('cols:', cols.join(','));
const rows = db.prepare('SELECT id, lead_id FROM websites ORDER BY id LIMIT 30').all();
console.log('sites:', JSON.stringify(rows));
try {
  const named = db.prepare(
    "SELECT id, lead_id, name FROM websites WHERE id = 10 OR name LIKE '%Delle%' LIMIT 10"
  ).all();
  console.log('named:', JSON.stringify(named));
} catch (e) {
  console.log('name query failed:', e.message);
}
db.close();
