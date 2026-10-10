'use strict';

/**
 * Background IMAP poll across workspaces that have mail.imap.enabled=1.
 */

const fs = require('fs');
const path = require('path');
const { dataRoot } = require('./workspaceDb');

async function listWorkspaceIds() {
  try {
    const { query } = require('./db');
    const rows = await query('SELECT id FROM workspaces ORDER BY id ASC');
    return (rows || []).map((r) => Number(r.id)).filter((n) => n > 0);
  } catch {
    // Fallback: folders under WORKSPACE_DATA_DIR
    try {
      const root = dataRoot();
      if (!fs.existsSync(root)) return [];
      return fs.readdirSync(root)
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      return [];
    }
  }
}

async function tickAll() {
  const domain = require('./domain');
  const ids = await listWorkspaceIds();
  const outcomes = [];
  for (const workspaceId of ids) {
    try {
      const enabled = domain.withDb(workspaceId, (db) =>
        domain.getSetting(db, 'mail.imap.enabled', '0') === '1'
      );
      if (!enabled) continue;
      const paused = domain.withDb(workspaceId, (db) =>
        domain.getSetting(db, 'automation_paused', '0') === '1'
      );
      if (paused) {
        outcomes.push({ workspaceId, skipped: true, reason: 'automation_paused' });
        continue;
      }
      const result = await domain.imapPoll(workspaceId, {});
      outcomes.push({ workspaceId, ...result });
    } catch (e) {
      console.warn('[imapPoller] workspace', workspaceId, e.message);
      outcomes.push({ workspaceId, ok: false, error: e.message });
    }
  }
  return outcomes;
}

function startImapPoller({ intervalMs } = {}) {
  const ms = Number(intervalMs) || Number(process.env.IMAP_POLL_MS) || 120000;
  let timer = null;
  const tick = async () => {
    try {
      await tickAll();
    } catch (e) {
      console.error('[imapPoller]', e.message);
    }
  };
  timer = setInterval(tick, ms);
  if (timer.unref) timer.unref();
  setTimeout(tick, 8000);
  return () => clearInterval(timer);
}

module.exports = { startImapPoller, tickAll, listWorkspaceIds };
