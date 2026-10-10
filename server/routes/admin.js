'use strict';

const express = require('express');
const admin = require('../admin');
const platform = require('../platform');
const { requireAuth, requireSuperAdmin } = require('../middleware');

const router = express.Router();
router.use(requireAuth, requireSuperAdmin);

function ok(res, data) { res.json({ ok: true, data }); }
function fail(res, e, status = 400) {
  const code = e.code || status;
  const http = typeof code === 'number' ? code : (e.code === 'NOT_FOUND' ? 404 : status);
  res.status(http >= 400 && http < 600 ? http : 400).json({
    ok: false,
    error: e.message || String(e),
    code: e.code,
  });
}

router.get('/overview', async (req, res) => {
  try { ok(res, await admin.overview()); } catch (e) { fail(res, e, 500); }
});

router.get('/audit', async (req, res) => {
  try { ok(res, { rows: await platform.listAudit({ limit: req.query.limit }) }); } catch (e) { fail(res, e, 500); }
});

// ---------- Users ----------
router.get('/users', async (req, res) => {
  try { ok(res, { users: await admin.listUsers(req.query) }); } catch (e) { fail(res, e, 500); }
});
router.get('/users/:id', async (req, res) => {
  try {
    const data = await admin.getUser(Number(req.params.id));
    if (!data) return fail(res, Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }), 404);
    ok(res, data);
  } catch (e) { fail(res, e, 500); }
});
router.post('/users', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.email || !b.password) return fail(res, new Error('email and password required'));
    const created = await admin.createUser(b);
    await platform.audit(req.session.userId, 'user.create', `userId=${created.userId} email=${b.email}`);
    ok(res, created);
  } catch (e) { fail(res, e, e.code === 'EMAIL_IN_USE' ? 409 : 400); }
});
router.patch('/users/:id', async (req, res) => {
  try {
    const data = await admin.updateUser(Number(req.params.id), req.body || {});
    await platform.audit(req.session.userId, 'user.update', `userId=${req.params.id} ${JSON.stringify(Object.keys(req.body || {}))}`);
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ---------- Workspaces ----------
router.get('/workspaces', async (req, res) => {
  try { ok(res, { workspaces: await admin.listWorkspaces(req.query) }); } catch (e) { fail(res, e, 500); }
});
router.get('/workspaces/:id', async (req, res) => {
  try {
    const data = await admin.getWorkspace(Number(req.params.id));
    if (!data) return fail(res, Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }), 404);
    ok(res, data);
  } catch (e) { fail(res, e, 500); }
});
router.post('/workspaces', async (req, res) => {
  try {
    const created = await admin.createWorkspace(req.body || {});
    await platform.audit(req.session.userId, 'workspace.create', `workspaceId=${created.workspaceId}`);
    ok(res, created);
  } catch (e) { fail(res, e); }
});
router.patch('/workspaces/:id', async (req, res) => {
  try {
    const data = await admin.updateWorkspace(Number(req.params.id), req.body || {});
    await platform.audit(req.session.userId, 'workspace.update', `workspaceId=${req.params.id}`);
    ok(res, data);
  } catch (e) { fail(res, e); }
});
router.delete('/workspaces/:id', async (req, res) => {
  try {
    const data = await admin.deleteWorkspace(Number(req.params.id));
    await platform.audit(req.session.userId, 'workspace.delete', `workspaceId=${req.params.id}`);
    ok(res, data);
  } catch (e) { fail(res, e); }
});
router.post('/workspaces/:id/members', async (req, res) => {
  try {
    const b = req.body || {};
    const data = await admin.addMember(Number(req.params.id), Number(b.userId), b.role || 'member');
    await platform.audit(req.session.userId, 'workspace.member.add', `ws=${req.params.id} user=${b.userId}`);
    ok(res, data);
  } catch (e) { fail(res, e); }
});
router.delete('/workspaces/:id/members/:userId', async (req, res) => {
  try {
    const data = await admin.removeMember(Number(req.params.id), Number(req.params.userId));
    await platform.audit(req.session.userId, 'workspace.member.remove', `ws=${req.params.id} user=${req.params.userId}`);
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ---------- Platform settings ----------
router.get('/settings', async (req, res) => {
  try {
    const settings = await platform.getAllPlatformSettings({ redact: true });
    ok(res, { settings, defs: platform.PLATFORM_SETTING_DEFS.map((d) => ({
      key: d.key, group: d.group, label: d.label, secret: !!(d.secret || platform.PLATFORM_SECRET_KEYS.includes(d.key)),
    })) });
  } catch (e) { fail(res, e, 500); }
});
router.put('/settings', async (req, res) => {
  try {
    const result = await platform.setPlatformSettingsBatch(req.body && req.body.settings ? req.body.settings : req.body);
    await platform.audit(req.session.userId, 'platform.settings', `updated=${(result.updated || []).join(',')}`);
    ok(res, result);
  } catch (e) { fail(res, e); }
});
router.put('/settings/secret', async (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key) return fail(res, new Error('key required'));
    if (!platform.PLATFORM_SECRET_KEYS.includes(key) && !(platform.PLATFORM_SETTING_DEFS.find((d) => d.key === key) || {}).secret) {
      return fail(res, new Error('Not a secret key'));
    }
    if (!value || value === '***') return fail(res, new Error('value required'));
    await platform.setPlatformSetting(key, value);
    await platform.audit(req.session.userId, 'platform.secret', `key=${key}`);
    ok(res, { key, set: true });
  } catch (e) { fail(res, e); }
});
router.post('/settings/push', async (req, res) => {
  try {
    const result = await admin.pushDefaultsToWorkspaces({
      force: !!(req.body && req.body.force),
      keys: req.body && req.body.keys,
    });
    await platform.audit(req.session.userId, 'platform.push', JSON.stringify(result));
    ok(res, result);
  } catch (e) { fail(res, e, 500); }
});

module.exports = router;
