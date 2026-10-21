'use strict';

const express = require('express');
const { query } = require('../db');
const { getSetting, setSetting, logActivity } = require('../workspace');
const { SECRET_KEYS, SETTABLE_KEYS } = require('../settingsKeys');
const { requireWorkspace, requireRole } = require('../middleware');

const router = express.Router();
router.use(requireWorkspace);

router.get('/', async (req, res, next) => {
  try {
    const rows = await query(
      'SELECT `key`, value FROM workspace_settings WHERE workspace_id = :workspaceId',
      { workspaceId: req.auth.workspaceId }
    );
    const settings = {};
    for (const r of rows) {
      settings[r.key] = SECRET_KEYS.includes(r.key) && r.value ? '***' : r.value;
    }
    res.json({ ok: true, data: { settings } });
  } catch (e) {
    next(e);
  }
});

router.put('/', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const { key, value } = req.body || {};
    const k = String(key || '').trim();
    if (!SETTABLE_KEYS.includes(k)) {
      return res.status(400).json({ ok: false, error: `Setting "${k}" is not writable (or is a secret).` });
    }
    const v = value == null ? '' : String(value);
    if (v.length > 5000) return res.status(400).json({ ok: false, error: 'value too long' });
    await setSetting(req.auth.workspaceId, k, v);
    await logActivity(req.auth.workspaceId, 'settings', `Setting updated: ${k}`);
    res.json({ ok: true, data: { key: k, value: v } });
  } catch (e) {
    next(e);
  }
});

router.put('/secret', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const { key, value } = req.body || {};
    const k = String(key || '').trim();
    if (!SECRET_KEYS.includes(k)) {
      return res.status(400).json({ ok: false, error: `"${k}" is not a secret key` });
    }
    const v = value == null ? '' : String(value);
    if (v.length > 2000) return res.status(400).json({ ok: false, error: 'secret too long' });
    await setSetting(req.auth.workspaceId, k, v);
    await logActivity(req.auth.workspaceId, 'settings', `Secret updated: ${k}`);
    res.json({ ok: true, data: { key: k, set: v !== '' } });
  } catch (e) {
    next(e);
  }
});

router.post('/automation', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const paused = !!(req.body && req.body.paused);
    await setSetting(req.auth.workspaceId, 'automation_paused', paused ? '1' : '0');
    await logActivity(
      req.auth.workspaceId,
      'automation',
      paused ? 'Automation PAUSED' : 'Automation RESUMED'
    );
    res.json({ ok: true, data: { paused } });
  } catch (e) {
    next(e);
  }
});

router.get('/prompts', async (req, res, next) => {
  try {
    const prompts = await query(
      'SELECT `key`, name, body, updated_at FROM prompts WHERE workspace_id = :workspaceId ORDER BY `key`',
      { workspaceId: req.auth.workspaceId }
    );
    res.json({ ok: true, data: { prompts } });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
