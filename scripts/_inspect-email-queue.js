'use strict';

const Database = require('better-sqlite3');
const db = new Database('/app/data/workspaces/1/websitescout.db', { readonly: true });

const tables = db.prepare(
  `SELECT name FROM sqlite_master WHERE type='table'
   AND (name LIKE '%mail%' OR name LIKE '%message%' OR name LIKE '%outreach%' OR name LIKE '%campaign%')`
).all();
console.log('tables', tables.map((t) => t.name).join(', '));

function inspect(table) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const cnt = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    let by = [];
    if (cols.includes('status')) {
      by = db.prepare(`SELECT status, COUNT(*) AS c FROM ${table} GROUP BY status`).all();
    }
    console.log(`\n=== ${table} count=${cnt} byStatus=${JSON.stringify(by)} ===`);
    const orderCol = cols.includes('id') ? 'id' : cols[0];
    const recent = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderCol} DESC LIMIT 8`).all();
    for (const r of recent) {
      const copy = { ...r };
      for (const k of Object.keys(copy)) {
        if (typeof copy[k] === 'string' && copy[k].length > 100) {
          copy[k] = copy[k].slice(0, 100) + '…';
        }
      }
      console.log(JSON.stringify(copy));
    }
  } catch (e) {
    console.log(table, 'ERR', e.message);
  }
}

for (const t of [
  'campaign_messages',
  'email_events',
  'campaigns',
  'suppression_list',
  'activity_log',
]) {
  inspect(t);
}

const paused = db.prepare("SELECT key, value FROM settings WHERE key IN ('automation.paused','automation_paused','kill_switch')").all();
console.log('\nautomation settings', JSON.stringify(paused));

const smtpName = db.prepare("SELECT key, value FROM settings WHERE key IN ('smtp.from_name','app.name')").all();
console.log('names', JSON.stringify(smtpName));

process.exit(0);
