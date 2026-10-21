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
const CACHE_MAX = Math.min(500, Math.max(32, Number(process.env.WORKSPACE_DB_CACHE_MAX) || 128));

function dataRoot() {
  return process.env.WORKSPACE_DATA_DIR
    || path.join(__dirname, '..', 'data', 'workspaces');
}

function dbPathFor(workspaceId) {
  return path.join(dataRoot(), String(workspaceId), 'websitescout.db');
}

function evictOldestHandle() {
  if (caches.size < CACHE_MAX) return;
  const first = caches.keys().next().value;
  if (first == null) return;
  const db = caches.get(first);
  caches.delete(first);
  try { if (db) db.close(); } catch { /* ignore */ }
}

function openWorkspaceDb(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid workspaceId');
  if (caches.has(id)) {
    // Refresh insertion order for simple LRU-ish eviction.
    const hit = caches.get(id);
    caches.delete(id);
    caches.set(id, hit);
    return hit;
  }

  evictOldestHandle();

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
  try {
    const socialMedia = require('../src/socialMedia');
    if (typeof socialMedia.ensureTables === 'function') socialMedia.ensureTables(db);
  } catch (e) {
    console.warn('[workspaceDb] socialMedia.ensureTables:', e.message);
  }
  try {
    const outreach = require('../src/outreach');
    if (typeof outreach.ensureTables === 'function') outreach.ensureTables(db);
  } catch (e) {
    console.warn('[workspaceDb] outreach.ensureTables:', e.message);
  }
  try {
    const siteModules = require('./siteModules');
    if (typeof siteModules.ensureTables === 'function') siteModules.ensureTables(db);
  } catch (e) {
    console.warn('[workspaceDb] siteModules.ensureTables:', e.message);
  }
  try {
    const cfDomains = require('../src/cfDomains');
    if (typeof cfDomains.ensureTables === 'function') cfDomains.ensureTables(db);
  } catch (e) {
    console.warn('[workspaceDb] cfDomains.ensureTables:', e.message);
  }

  if (firstRun) {
    // Seed settings/prompts only — skip demo leads for multi-tenant workspaces.
    const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    const { SETTING_SEEDS, PROMPT_SEEDS } = require('../src/seed');
    for (const [key, value] of SETTING_SEEDS) insertSetting.run(key, value);
    try {
      const platform = require('./platform');
      // Fill missing keys only — never overwrite settings the workspace already changed.
      platform.workspaceSeedFromPlatform().then((seed) => {
        const insertIgnore = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
        for (const [key, value] of Object.entries(seed)) {
          if (value != null && String(value).trim() !== '') insertIgnore.run(key, value);
        }
      }).catch(() => {});
    } catch { /* optional */ }
    const insertPrompt = db.prepare('INSERT OR IGNORE INTO prompts (key, name, body) VALUES (?, ?, ?)');
    for (const p of PROMPT_SEEDS) insertPrompt.run(p.key, p.name, p.body);
  }

  // SQLite is the runtime source of truth for automation_paused.
  // Only fill the key when this workspace has never set it — never overwrite.
  try {
    const { getSetting: mysqlGet } = require('./workspace');
    mysqlGet(id, 'automation_paused', null).then((v) => {
      if (v == null || String(v).trim() === '') return;
      db.prepare(
        'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
      ).run('automation_paused', String(v));
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
