'use strict';

/**
 * Per-workspace SQLite stores — reuse Electron domain engines (leadEngine,
 * designJobs, outreach, websiteEngine, …) with almost no SQL rewrite.
 * MySQL remains the source of truth for users / workspaces / auth tokens.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const caches = new Map(); // workspaceId -> Database

function dataRoot() {
  return process.env.WORKSPACE_DATA_DIR
    || path.join(__dirname, '..', 'data', 'workspaces');
}

function dbPathFor(workspaceId) {
  return path.join(dataRoot(), String(workspaceId), 'websitescout.db');
}

function openWorkspaceDb(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid workspaceId');
  if (caches.has(id)) return caches.get(id);

  const file = dbPathFor(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const firstRun = !fs.existsSync(file);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  if (firstRun) {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8');
    db.exec(schema);
  }

  // Always ensure design tables + column patches exist (idempotent).
  try {
    const design = require('../src/designJobs');
    if (typeof design.ensureTables === 'function') design.ensureTables(db);
  } catch (e) {
    console.warn('[workspaceDb] design.ensureTables:', e.message);
  }
  try {
    const emailRedesign = require('../src/emailRedesign');
    if (typeof emailRedesign.ensureTables === 'function') emailRedesign.ensureTables(db);
  } catch (e) {
    console.warn('[workspaceDb] emailRedesign.ensureTables:', e.message);
  }
  try {
    const designLearning = require('../src/designLearning');
    if (typeof designLearning.ensureTables === 'function') designLearning.ensureTables(db);
  } catch (e) {
    console.warn('[workspaceDb] designLearning.ensureTables:', e.message);
  }
  try {
    const leadEngine = require('../src/leadEngine');
    if (typeof leadEngine.ensureLeadColumns === 'function') leadEngine.ensureLeadColumns(db);
  } catch { /* optional */ }
  try {
    const websiteEngine = require('../src/websiteEngine');
    if (typeof websiteEngine.ensureTables === 'function') websiteEngine.ensureTables(db);
  } catch { /* optional */ }

  if (firstRun) {
    const { runSeed } = require('../src/seed');
    // Seed settings/prompts only — skip demo leads for multi-tenant workspaces.
    const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    const { SETTING_SEEDS, PROMPT_SEEDS } = require('../src/seed');
    for (const [key, value] of SETTING_SEEDS) insertSetting.run(key, value);
    const insertPrompt = db.prepare('INSERT OR IGNORE INTO prompts (key, name, body) VALUES (?, ?, ?)');
    for (const p of PROMPT_SEEDS) insertPrompt.run(p.key, p.name, p.body);
  }

  // Sync automation_paused from MySQL workspace_settings if present.
  try {
    const { getSetting: mysqlGet } = require('./workspace');
    mysqlGet(id, 'automation_paused', null).then((v) => {
      if (v != null) {
        db.prepare(
          "INSERT INTO settings (key, value) VALUES ('automation_paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run(v);
      }
    }).catch(() => {});
  } catch { /* ignore */ }

  caches.set(id, db);
  return db;
}

function closeAll() {
  for (const db of caches.values()) {
    try { db.close(); } catch { /* ignore */ }
  }
  caches.clear();
}

module.exports = { openWorkspaceDb, dbPathFor, dataRoot, closeAll };
