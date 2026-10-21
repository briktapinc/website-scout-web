'use strict';

/**
 * Probe platform + workspace SMTP settings (secrets redacted).
 * Run inside app container: node scripts/_probe-smtp-settings.js
 */

const fs = require('fs');
const path = require('path');

async function main() {
  const platform = require('../server/platform');
  const keys = [
    'smtp.host', 'smtp.port', 'smtp.secure', 'smtp.user', 'smtp.pass',
    'smtp.from_name', 'smtp.from_email',
  ];

  console.log('=== platform_settings smtp.* ===');
  for (const k of keys) {
    const v = await platform.getPlatformSetting(k, '');
    if (k === 'smtp.pass' || k === 'smtp.user') {
      console.log(`${k}=${v ? `SET(len=${String(v).length})` : 'EMPTY'}`);
    } else {
      console.log(`${k}=${JSON.stringify(v || '')}`);
    }
  }

  console.log('');
  console.log('=== workspace 1 SQLite smtp.* ===');
  const candidates = [
    path.join(__dirname, '..', 'data', 'workspaces', '1', 'websitescout.db'),
    '/app/data/workspaces/1/websitescout.db',
  ];
  const dbPath = candidates.find((p) => fs.existsSync(p));
  if (!dbPath) {
    console.log('NO_WORKSPACE_DB');
    return;
  }
  console.log('db=', dbPath);
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`
  ).all(...keys);
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  for (const k of keys) {
    const v = map[k] ?? '';
    if (k === 'smtp.pass' || k === 'smtp.user') {
      console.log(`${k}=${v ? `SET(len=${String(v).length})` : 'EMPTY'}`);
    } else {
      console.log(`${k}=${JSON.stringify(v)}`);
    }
  }
  db.close();

  // Quick validation via email module
  const { getProvider, validateSmtpConfig, readSmtpConfig } = require('../src/email');
  const settings = {};
  for (const k of keys) settings[k] = await platform.getPlatformSetting(k, '');
  const cfg = readSmtpConfig(settings);
  console.log('');
  console.log('=== platform provider validation ===');
  console.log('errors=', JSON.stringify(validateSmtpConfig(cfg)));
  console.log('provider=', getProvider(settings, null).name);
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL', e && e.stack ? e.stack : e);
  process.exit(1);
});
