'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const NEW_IMAGE = 'gpt-image-2.5-sunburst';
const OLD_IMAGE = 'gpt-image-1';
const wsRoot = process.env.WORKSPACE_DATA_DIR || '/app/data/workspaces';

let migrated = 0;
const report = [];

if (!fs.existsSync(wsRoot)) {
  console.log('no workspace root', wsRoot);
  process.exit(0);
}

for (const ent of fs.readdirSync(wsRoot, { withFileTypes: true })) {
  if (!ent.isDirectory()) continue;
  const dbPath = path.join(wsRoot, ent.name, 'websitescout.db');
  if (!fs.existsSync(dbPath)) continue;
  try {
    const db = new Database(dbPath);
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('ai.model.image');
    const before = row ? String(row.value) : '(missing)';
    if (!row) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('ai.model.image', NEW_IMAGE);
      migrated += 1;
    } else if (String(row.value || '').trim() === OLD_IMAGE) {
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(NEW_IMAGE, 'ai.model.image');
      migrated += 1;
    }
    const after = db.prepare('SELECT value FROM settings WHERE key = ?').get('ai.model.image');
    report.push(`${ent.name}: ${before} -> ${after && after.value}`);
    db.close();
  } catch (e) {
    console.warn('skip', dbPath, e.message);
  }
}

console.log(report.join('\n'));
console.log('migrated', migrated, '->', NEW_IMAGE);
