'use strict';

const { createHash } = require('crypto');
const platform = require('../server/platform');

function fp(v) {
  const s = String(v || '');
  if (!s) return 'EMPTY';
  return `SET(len=${s.length},sha256_12=${createHash('sha256').update(s).digest('hex').slice(0, 12)})`;
}

(async () => {
  const keys = ['smtp.host', 'smtp.port', 'smtp.secure', 'smtp.user', 'smtp.pass', 'smtp.from_name', 'smtp.from_email'];
  console.log('=== platform ===');
  for (const k of keys) {
    const v = await platform.getPlatformSetting(k, '');
    if (k === 'smtp.user' || k === 'smtp.pass') console.log(k + '=' + fp(v));
    else console.log(k + '=' + JSON.stringify(v));
  }

  const Database = require('better-sqlite3');
  const db = new Database('/app/data/workspaces/1/websitescout.db', { readonly: true });
  console.log('=== workspace sqlite ===');
  for (const k of keys) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    const v = row ? row.value : '';
    if (k === 'smtp.user' || k === 'smtp.pass') console.log(k + '=' + fp(v));
    else console.log(k + '=' + JSON.stringify(v));
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
