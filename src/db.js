'use strict';

const fs = require('fs');
const path = require('path');

let db = null;

function getDbPath() {
  // Test override (WS_DB_PATH) takes precedence and does not require Electron.
  if (process.env.WS_DB_PATH) return process.env.WS_DB_PATH;
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'websitescout.db');
}

function initDb() {
  if (db) return db;
  const Database = require('better-sqlite3');
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const firstRun = !fs.existsSync(dbPath);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  if (firstRun) {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    db.exec(schema);
    const { runSeed } = require('./seed.js');
    runSeed(db);
  }
  return db;
}

/** Close the database cleanly (call on app quit — avoids native teardown crashes). */
function closeDb() {
  if (db) {
    try { db.close(); } catch { /* already closed */ }
    db = null;
  }
}

module.exports = { db: initDb(), closeDb };
