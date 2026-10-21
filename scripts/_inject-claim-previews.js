'use strict';

/**
 * Backfill claim Yes/No popup into existing EXPORT_ROOT site folders.
 * Usage: node scripts/_inject-claim-previews.js
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const claimKit = require('../src/claimKit');
const openPreview = require('../src/openPreview');
const { dataRoot } = require('../server/workspaceDb');

const root = openPreview.exportRoot();
console.log('EXPORT_ROOT', root);
console.log('APP_URL', process.env.APP_URL || '(unset)');

const cache = new Map(); // websiteId → { workspaceId, leadId }

function resolveLead(workspaceHint, websiteId) {
  const wid = Number(websiteId);
  if (!Number.isInteger(wid) || wid <= 0) return null;
  if (cache.has(wid)) return cache.get(wid);

  const wsRoot = dataRoot();
  const candidates = [];
  if (workspaceHint != null && Number.isInteger(Number(workspaceHint))) {
    candidates.push(String(Number(workspaceHint)));
  }
  try {
    for (const n of fs.readdirSync(wsRoot)) {
      if (/^\d+$/.test(n) && !candidates.includes(n)) candidates.push(n);
    }
  } catch { /* */ }

  for (const ws of candidates) {
    const dbPath = path.join(wsRoot, ws, 'websitescout.db');
    if (!fs.existsSync(dbPath)) continue;
    let db;
    try {
      db = new Database(dbPath, { readonly: true });
      const row = db.prepare(
        'SELECT id, lead_id FROM websites WHERE id = ?'
      ).get(wid);
      if (row && row.lead_id != null) {
        const hit = { workspaceId: Number(ws), leadId: Number(row.lead_id) };
        cache.set(wid, hit);
        return hit;
      }
    } catch (e) {
      console.warn('db', ws, e.message || e);
    } finally {
      if (db) try { db.close(); } catch { /* */ }
    }
  }
  cache.set(wid, null);
  return null;
}

const result = claimKit.injectClaimPreviewIntoAllExports(root, { resolveLead });
console.log(JSON.stringify(result, null, 2));
