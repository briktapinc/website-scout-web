'use strict';

const Database = require('better-sqlite3');
const db = new Database('/app/data/workspaces/1/websitescout.db', { readonly: true });

for (const t of ['design_question_emails', 'design_delivery_emails', 'design_email_redesigns']) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    const cnt = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    console.log(`\n=== ${t} count=${cnt} cols=${cols.join(',')} ===`);
    const recent = db.prepare(`SELECT * FROM ${t} ORDER BY rowid DESC LIMIT 10`).all();
    for (const r of recent) {
      const copy = { ...r };
      for (const k of Object.keys(copy)) {
        if (typeof copy[k] === 'string' && copy[k].length > 120) {
          copy[k] = copy[k].slice(0, 120) + '…';
        }
      }
      console.log(JSON.stringify(copy));
    }
  } catch (e) {
    console.log(t, e.message);
  }
}

// Compare smtp credential fingerprints (not secrets)
const { createHash } = require('crypto');
const rows = db.prepare(
  "SELECT key, value FROM settings WHERE key LIKE 'smtp.%'"
).all();
console.log('\n=== workspace smtp fingerprints ===');
for (const r of rows) {
  if (r.key === 'smtp.pass' || r.key === 'smtp.user') {
    const h = createHash('sha256').update(String(r.value || '')).digest('hex').slice(0, 12);
    console.log(`${r.key}=SET(len=${String(r.value||'').length},sha256_12=${h})`);
  } else {
    console.log(`${r.key}=${JSON.stringify(r.value)}`);
  }
}

process.exit(0);
