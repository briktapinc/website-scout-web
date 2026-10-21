'use strict';
/**
 * ipc/outreach.js — registers the Outreach IPC channels (CONTRACT.md).
 *
 * Auto-loaded by main.js (every module in src/ipc/*.js registers itself).
 * The db module is required LAZILY inside gdb() so this file loads even if
 * workstream 1's src/db.js is not present yet; handlers throw a clear error
 * only when actually invoked without a database.
 *
 * Channels (subset of CONTRACT.md "Outreach", plus templates:delete which the
 * renderer needs for template CRUD):
 *   campaigns:list | campaigns:create | campaigns:setStatus
 *   templates:list | templates:save | templates:delete
 *   outreach:processQueue | outreach:stats
 *   suppression:list | suppression:add | suppression:remove
 *   timeline:get | intent:get | intent:record | pipeline:board
 */

const outreach = require('../outreach');
const emailMod = require('../email');

function getDb(injected) {
  if (injected) return injected;
  try {
    const mod = require('../db');
    if (mod && mod.db) return mod.db;
    if (mod && typeof mod.prepare === 'function') return mod; // tolerate direct instance export
    throw new Error('src/db.js did not export a better-sqlite3 instance');
  } catch (err) {
    throw new Error('Database not available: ' + (err && err.message));
  }
}

function num(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${name}`);
  return n;
}

function str(v, name, { allowEmpty = false, max = 10000 } = {}) {
  const s = String(v === undefined || v === null ? '' : v);
  if (!allowEmpty && !s.trim()) throw new Error(`${name} is required`);
  if (s.length > max) throw new Error(`${name} is too long`);
  return s;
}

function register(ipcMain, db) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('outreach IPC: ipcMain.handle is required');
  }
  const gdb = () => getDb(db);
  // --- Campaigns ---
  ipcMain.handle('campaigns:list', (_e, args = {}) => outreach.listCampaigns(gdb(), args || {}));

  ipcMain.handle('campaigns:create', (_e, args = {}) => {
    const a = args || {};
    return outreach.createCampaign(gdb(), {
      name: str(a.name, 'name', { max: 200 }),
      templateId: num(a.templateId, 'templateId'),
      leadIds: Array.isArray(a.leadIds) ? a.leadIds.map((x) => num(x, 'leadId')) : (() => { throw new Error('leadIds must be an array'); })(),
      ratePerHour: a.ratePerHour === undefined ? 30 : Math.max(1, Math.min(1000, Number(a.ratePerHour) || 30)),
    });
  });

  ipcMain.handle('campaigns:setStatus', (_e, args = {}) => {
    const a = args || {};
    return outreach.setCampaignStatus(gdb(), num(a.id, 'campaign id'), str(a.status, 'status', { max: 20 }));
  });

  ipcMain.handle('campaigns:cancel', (_e, args = {}) => {
    const a = args || {};
    return outreach.cancelCampaign(gdb(), num(a.id, 'campaign id'));
  });

  ipcMain.handle('campaigns:delete', (_e, id) => outreach.deleteCampaign(gdb(), num(id, 'campaign id')));

  ipcMain.handle('campaigns:messages', (_e, args = {}) => {
    const a = args || {};
    return outreach.listMessages(
      gdb(),
      num(a.id, 'campaign id'),
      a.status ? str(a.status, 'status', { max: 20 }) : undefined,
      { page: a.page, pageSize: a.pageSize }
    );
  });

  // --- Templates ---
  ipcMain.handle('templates:list', () => outreach.listTemplates(gdb()));

  ipcMain.handle('templates:save', (_e, args = {}) => {
    const a = args || {};
    return outreach.saveTemplate(gdb(), {
      id: a.id === undefined || a.id === null ? undefined : num(a.id, 'template id'),
      name: str(a.name, 'name', { max: 200 }),
      subject: a.subject == null ? '' : str(a.subject, 'subject', { max: 500 }),
      body: a.body == null ? '' : str(a.body, 'body', { max: 100000 }),
      sms_body: a.sms_body == null && a.smsBody == null
        ? ''
        : str(a.sms_body != null ? a.sms_body : a.smsBody, 'sms_body', { max: 1600 }),
    });
  });

  ipcMain.handle('templates:delete', (_e, id) => outreach.deleteTemplate(gdb(), num(id, 'template id')));

  // --- Queue / stats ---
  ipcMain.handle('outreach:processQueue', async () => outreach.processQueue(gdb()));
  ipcMain.handle('outreach:stats', () => outreach.getOutreachStats(gdb()));

  // --- Suppression / compliance ---
  ipcMain.handle('suppression:list', (_e, args = {}) => outreach.listSuppressions(gdb(), args || {}));

  ipcMain.handle('suppression:add', (_e, args = {}) => {
    const a = args || {};
    const email = str(a.email, 'email', { max: 320 }).trim().toLowerCase();
    if (!emailMod.isValidEmail(email)) throw new Error('Invalid email address');
    return outreach.addSuppression(gdb(), email, str(a.reason || 'do-not-contact', 'reason', { max: 40 }));
  });

  ipcMain.handle('suppression:remove', (_e, id) => outreach.removeSuppression(gdb(), num(id, 'suppression id')));

  // --- Timeline / intent / pipeline ---
  ipcMain.handle('timeline:get', (_e, args) => {
    if (args && typeof args === 'object' && !Array.isArray(args) && args.leadId != null) {
      return outreach.getTimeline(gdb(), num(args.leadId, 'leadId'), { limit: args.limit });
    }
    return outreach.getTimeline(gdb(), num(args, 'leadId'));
  });
  ipcMain.handle('intent:get', (_e, leadId) => outreach.getIntent(gdb(), num(leadId, 'leadId')));

  ipcMain.handle('intent:record', (_e, args = {}) => {
    const a = args || {};
    return outreach.recordIntent(gdb(), num(a.leadId, 'leadId'), str(a.type, 'type', { max: 60 }), str(a.detail || '', 'detail', { allowEmpty: true, max: 2000 }));
  });

  ipcMain.handle('pipeline:board', (_e, args = {}) => outreach.pipelineBoard(gdb(), args || {}));
}


module.exports = { register };
