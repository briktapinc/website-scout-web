'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const {
  createUserWithWorkspace,
  findUserByEmail,
  listWorkspacesForUser,
} = require('../workspace');
const { requireAuth } = require('../middleware');
const { rateLimit } = require('../rateLimit');

const router = express.Router();
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session || typeof req.session.regenerate !== 'function') return resolve();
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

async function authPayload(user, workspaceId, workspaces) {
  const billing = require('../billing');
  const subscribed = billing.isSubscribed(user);
  const requireSubscription = await billing.requireSubscriptionEnabled();
  const wsId = workspaceId || (workspaces[0] && workspaces[0].id) || null;
  const workspaceSubscribed = wsId ? await billing.workspaceHasSubscription(wsId) : false;
  const productAccess = subscribed || workspaceSubscribed;
  const isSuperAdmin = Number(user.is_super_admin) === 1;
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name || '',
      created_at: user.created_at,
      isSuperAdmin,
      subscriptionStatus: user.subscription_status || 'none',
      currentPeriodEnd: user.current_period_end || null,
      subscribed,
    },
    workspaceId: wsId,
    workspaces,
    isSuperAdmin,
    subscribed,
    workspaceSubscribed,
    productAccess,
    requireSubscription,
  };
}

router.post('/register', authLimit, async (req, res, next) => {
  try {
    const platform = require('../platform');
    const open = await platform.getPlatformSetting('registration.open', '1');
    if (open !== '1') {
      return res.status(403).json({ ok: false, error: 'REGISTRATION_CLOSED' });
    }
    const maintenance = await platform.getPlatformSetting('maintenance_mode', '0');
    if (maintenance === '1') {
      return res.status(503).json({ ok: false, error: 'MAINTENANCE_MODE' });
    }
    const { email, password, name, workspaceName, acceptTerms } = req.body || {};
    if (!acceptTerms) {
      return res.status(400).json({ ok: false, error: 'You must accept the Terms and Privacy Policy' });
    }
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'email and password are required' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ ok: false, error: 'password must be at least 8 characters' });
    }
    const existing = await findUserByEmail(email);
    if (existing) return res.status(409).json({ ok: false, error: 'EMAIL_IN_USE' });

    const created = await createUserWithWorkspace({ email, password, name, workspaceName });
    await regenerateSession(req);
    req.session.userId = created.userId;
    req.session.workspaceId = created.workspaceId;
    const workspaces = await listWorkspacesForUser(created.userId);
    const user = {
      id: created.userId,
      email: String(email).trim().toLowerCase(),
      name: name || '',
      is_super_admin: 0,
      subscription_status: 'none',
      status: 'active',
    };
    res.json({ ok: true, data: await authPayload(user, created.workspaceId, workspaces) });
  } catch (e) {
    next(e);
  }
});

router.post('/login', authLimit, async (req, res, next) => {
  try {
    const platform = require('../platform');
    const maintenance = await platform.getPlatformSetting('maintenance_mode', '0');
    const { email, password } = req.body || {};
    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
    const ok = await bcrypt.compare(String(password || ''), user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
    if (String(user.status || 'active') === 'disabled' || user.deleted_at) {
      return res.status(403).json({ ok: false, error: 'ACCOUNT_DISABLED' });
    }
    const isSuper = Number(user.is_super_admin) === 1;
    if (maintenance === '1' && !isSuper) {
      return res.status(503).json({ ok: false, error: 'MAINTENANCE_MODE' });
    }

    const workspaces = await listWorkspacesForUser(user.id);
    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.workspaceId = workspaces[0] ? workspaces[0].id : null;
    try { await require('../admin').touchLogin(user.id); } catch { /* ignore */ }
    res.json({ ok: true, data: await authPayload(user, req.session.workspaceId, workspaces) });
  } catch (e) {
    next(e);
  }
});

router.post('/forgot-password', authLimit, async (req, res, next) => {
  try {
    const email = req.body && req.body.email;
    const result = await require('../passwordReset').requestReset(email);
    res.json({ ok: true, data: result });
  } catch (e) { next(e); }
});

router.post('/reset-password', authLimit, async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: 'token required' });
    await require('../passwordReset').confirmReset(token, password);
    res.json({ ok: true, data: { reset: true } });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: e.code });
  }
});

router.post('/accept-invite', requireAuth, async (req, res, next) => {
  try {
    const token = req.body && req.body.token;
    if (!token) return res.status(400).json({ ok: false, error: 'token required' });
    const result = await require('../invites').acceptInvite(token, req.session.userId);
    req.session.workspaceId = result.workspaceId;
    const workspaces = await listWorkspacesForUser(req.session.userId);
    const billing = require('../billing');
    const productAccess = await billing.workspaceHasSubscription(result.workspaceId)
      || billing.isSubscribed(await billing.getUserBilling(req.session.userId));
    res.json({
      ok: true,
      data: {
        ...result,
        workspaces,
        productAccess,
        workspaceSubscribed: await billing.workspaceHasSubscription(result.workspaceId),
      },
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: e.code });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('scout.sid');
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const rows = await require('../db').query(
      `SELECT id, email, name, is_super_admin, status, created_at,
              subscription_status, current_period_end, deleted_at
       FROM users WHERE id = :id LIMIT 1`,
      { id: req.session.userId }
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    if (String(user.status || 'active') === 'disabled' || user.deleted_at) {
      return res.status(403).json({ ok: false, error: 'ACCOUNT_DISABLED' });
    }
    const workspaces = await listWorkspacesForUser(user.id);
    const workspaceId = req.session.workspaceId || (workspaces[0] && workspaces[0].id) || null;
    res.json({ ok: true, data: await authPayload(user, workspaceId, workspaces) });
  } catch (e) {
    next(e);
  }
});

router.post('/workspace', requireAuth, async (req, res, next) => {
  try {
    const workspaceId = Number(req.body && req.body.workspaceId);
    if (!workspaceId) return res.status(400).json({ ok: false, error: 'workspaceId required' });
    const membership = await require('../workspace').getMembership(req.session.userId, workspaceId);
    if (!membership) return res.status(403).json({ ok: false, error: 'NOT_A_MEMBER' });
    req.session.workspaceId = workspaceId;
    const billing = require('../billing');
    const user = await billing.getUserBilling(req.session.userId);
    const workspaceSubscribed = await billing.workspaceHasSubscription(workspaceId);
    const productAccess = billing.isSubscribed(user) || workspaceSubscribed;
    res.json({
      ok: true,
      data: {
        workspaceId,
        workspace: membership,
        workspaceSubscribed,
        productAccess,
        subscribed: billing.isSubscribed(user),
      },
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
