'use strict';
const fs = require('fs');
const Database = require('better-sqlite3');
const db = new Database('/app/data/workspaces/1/websitescout.db', { readonly: true });
console.log('=== websites ===');
const sites = db.prepare(
  'SELECT id, name, preview_url, preview_path, status FROM websites LIMIT 20'
).all();
for (const s of sites) {
  console.log(JSON.stringify(s));
}
console.log('=== cf settings ===');
const settings = db.prepare(
  "SELECT key, value FROM settings WHERE key LIKE 'cf.%'"
).all();
for (const row of settings) {
  if (row.key === 'cf.api_token') {
    console.log(row.key, row.value ? `(set len=${row.value.length})` : '(empty)');
  } else {
    console.log(row.key, '=', row.value);
  }
}
console.log('=== platform defaults cf ===');
try {
  const raw = JSON.parse(fs.readFileSync('/app/data/workspaces/platform-defaults.json', 'utf8'));
  const items = Array.isArray(raw)
    ? raw
    : (raw.settings || raw.defaults || Object.entries(raw).map(([key, value]) => ({ key, value })));
  const list = Array.isArray(items)
    ? items
    : Object.entries(items).map(([key, value]) => ({ key, value }));
  for (const x of list) {
    const k = x.key;
    if (!k || !String(k).startsWith('cf.')) continue;
    if (k === 'cf.api_token') console.log(k, x.value ? '(set)' : '(empty)');
    else console.log(k, '=', x.value);
  }
} catch (e) {
  console.log('defaults error', e.message);
}
db.close();
