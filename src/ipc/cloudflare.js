'use strict';

// Cloudflare Pages publishing IPC (WORKSTREAM 6).
//
// Channels:
//   cloudflare:getConfig              -> {configured, accountId, project, previewDomain}
//   cloudflare:saveConfig {apiToken, accountId, project, previewDomain}
//                                       -> {ok} | {ok:false, error, hint?}
//   cloudflare:testConnection         -> {ok, projects} | {ok:false, error, ...}
//   cloudflare:publish {websiteId, dir?} -> {ok:true, url, ...} | {ok:false, error, ...}
//
// The token is never returned to the renderer. Auto-loaded by main.js
// (every src/ipc/*.js with a register(ipcMain, db) export).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cf = require('../cloudflare.js');

function validWebsiteId(v) {
  return Number.isInteger(v) && v > 0;
}

function isDir(p) {
  try {
    return typeof p === 'string' && p !== '' && fs.statSync(p).isDirectory();
  } catch (err) {
    return false;
  }
}

// Best-effort export when the caller did not pass a folder. The Website Engine
// workstream (src/websiteEngine.js) may not exist yet — require defensively.
async function exportViaEngine(db, websiteId) {
  let engine = null;
  try {
    engine = require('../websiteEngine.js');
  } catch (err) {
    engine = null;
  }
  if (!engine || typeof engine.exportStatic !== 'function') {
    return {
      ok: false,
      error: 'NEEDS_EXPORT',
      hint: 'Export the site first (sites:export), then pass its folder as dir.',
    };
  }
  const outDir = path.join(os.tmpdir(), `website-scout-export-${websiteId}-${Date.now()}`);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const exported = await engine.exportStatic(db, websiteId, outDir);
    const dir =
      (exported && typeof exported === 'object' && (exported.dir || exported.path)) ||
      (typeof exported === 'string' ? exported : null) ||
      outDir;
    if (!isDir(dir)) {
      return {
        ok: false,
        error: 'EXPORT_FAILED',
        hint: 'websiteEngine.exportStatic did not produce a folder.',
      };
    }
    return { ok: true, dir };
  } catch (err) {
    return {
      ok: false,
      error: 'EXPORT_FAILED',
      detail: err && err.message ? String(err.message) : 'Unknown error',
    };
  }
}

function register(ipcMain, db) {
  ipcMain.handle('cloudflare:getConfig', () => {
    return cf.getConfig(db);
  });

  ipcMain.handle('cloudflare:saveConfig', (_event, args) => {
    if (!args || typeof args !== 'object') {
      return { ok: false, error: 'INVALID_ARGS' };
    }
    return cf.saveConfig(db, {
      apiToken: args.apiToken,
      accountId: args.accountId,
      project: args.project,
      previewDomain: args.previewDomain,
    });
  });

  ipcMain.handle('cloudflare:testConnection', async () => {
    return cf.testConnection(db);
  });

  ipcMain.handle('cloudflare:publish', async (_event, args) => {
    if (!args || typeof args !== 'object') {
      return { ok: false, error: 'INVALID_ARGS' };
    }
    const websiteId = args.websiteId;
    if (!validWebsiteId(websiteId)) {
      return { ok: false, error: 'INVALID_WEBSITE_ID' };
    }

    let dir = args.dir;
    if (typeof dir === 'string') dir = dir.trim();
    if (!dir) {
      // No folder passed: try to export via the Website Engine workstream.
      const exported = await exportViaEngine(db, websiteId);
      if (!exported.ok) return exported;
      dir = exported.dir;
    }
    if (!isDir(dir)) {
      return { ok: false, error: 'INVALID_DIR', hint: 'Folder does not exist: ' + String(dir) };
    }

    const project =
      typeof args.project === 'string' && args.project.trim() ? args.project : undefined;
    return cf.publishDirectory(db, { websiteId, dir, project });
  });
}

module.exports = { register };
