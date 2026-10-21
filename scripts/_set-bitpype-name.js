'use strict';

const { query } = require('../server/db');
const { savePlatformDefaultsSnapshot } = require('../server/platform');

(async () => {
  const plat = await query(
    "SELECT `key`, value FROM platform_settings WHERE `key` IN ('app.name','smtp.from_name')"
  );
  console.log('platform_before', JSON.stringify(plat));

  await query(
    "INSERT INTO platform_settings (`key`, value) VALUES ('app.name','Bitpype') ON DUPLICATE KEY UPDATE value='Bitpype'"
  );
  await query(
    "INSERT INTO platform_settings (`key`, value) VALUES ('smtp.from_name','Bitpype') ON DUPLICATE KEY UPDATE value=IF(value='Website Scout','Bitpype',value)"
  );

  const ws = await query(
    "SELECT workspace_id, `key`, value FROM workspace_settings WHERE `key` IN ('app.name','smtp.from_name')"
  );
  console.log('workspace_before', JSON.stringify(ws));

  await query(
    "UPDATE workspace_settings SET value='Bitpype' WHERE `key`='app.name' AND (value='Website Scout' OR value='' OR value IS NULL)"
  );
  await query(
    "UPDATE workspace_settings SET value='Bitpype' WHERE `key`='smtp.from_name' AND value='Website Scout'"
  );
  await query(
    "INSERT INTO workspace_settings (workspace_id, `key`, value) SELECT 1, 'app.name', 'Bitpype' FROM DUAL WHERE EXISTS (SELECT 1 FROM workspaces WHERE id=1) ON DUPLICATE KEY UPDATE value='Bitpype'"
  );

  const plat2 = await query(
    "SELECT `key`, value FROM platform_settings WHERE `key` IN ('app.name','smtp.from_name')"
  );
  const ws2 = await query(
    "SELECT workspace_id, `key`, value FROM workspace_settings WHERE `key` IN ('app.name','smtp.from_name')"
  );
  console.log('platform_after', JSON.stringify(plat2));
  console.log('workspace_after', JSON.stringify(ws2));

  const snap = await savePlatformDefaultsSnapshot();
  const fs = require('fs');
  const snapPath = '/app/data/workspaces/platform-defaults.json';
  const raw = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  console.log('snapshot', JSON.stringify(snap));
  console.log('snapshot_app_name', raw['app.name']);
  console.log('snapshot_from_name', raw['smtp.from_name']);

  // Runtime SMTP/app branding lives in per-workspace SQLite — keep it in sync.
  try {
    const { openWorkspaceDb } = require('../server/workspaceDb');
    const db = openWorkspaceDb(1);
    for (const [key, value] of [['app.name', 'Bitpype'], ['smtp.from_name', 'Bitpype']]) {
      const cur = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (!cur || cur.value === 'Website Scout' || !String(cur.value || '').trim()) {
        db.prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        ).run(key, value);
      }
    }
    const after = db.prepare(
      "SELECT key, value FROM settings WHERE key IN ('app.name','smtp.from_name')"
    ).all();
    console.log('sqlite_ws1_after', JSON.stringify(after));
  } catch (e) {
    console.warn('sqlite_sync_skip', e.message);
  }

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
