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
const { requireCaptcha } = require('../captcha');

const router = express.Router();
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
const captcha = requireCaptcha();

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session || typeof req.session.regenerate !== 'function') return resolve();
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session || typeof req.session.save !== 'function') return resolve();
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

function clearSessionCookie(req, res) {
  const locals = (req.app && req.app.locals) || {};
  const base = locals.sessionCookie || {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
  };
  const opts = {
    path: base.path || '/',
    httpOnly: true,
    sameSite: base.sameSite || 'lax',
    secure: !!base.secure,
  };
  if (base.domain) opts.domain = base.domain;
  const names = [
    locals.staffSessionName || 'bitpype.sid',
    ...((locals.legacySessionNames) || ['scout.sid', 'connect.sid']),
  ];
  for (const name of names) res.clearCookie(name, opts);
}

async function authPayload(user, workspaceId, workspaces) {
  const billing = require('../billing');
  const subscribed = billing.isSubscribed(user);
  const requireSubscription = await billing.requireSubscriptionEnabled();
  const wsId = workspaceId || (workspaces[0] && workspaces[0].id) || null;
  const workspaceSubscribed = wsId ? await billing.workspaceHasSubscription(wsId) : false;
  const workspaceProductAccess = wsId ? await billing.workspaceHasProductAccess(wsId) : false;
  const productAccess = billing.hasProductAccess(user) || workspaceProductAccess;
  const plan = billing.planOfUser(user);
  const workspacePlan = wsId ? await billing.workspacePlan(wsId) : plan;
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
      plan,
    },
    workspaceId: wsId,
    workspaces,
    isSuperAdmin,
    subscribed,
    workspaceSubscribed,
    plan,
    workspacePlan,
    productAccess,
    requireSubscription,
  };
}

router.post('/register', authLimit, captcha, async (req, res, next) => {
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
    // Do not reveal whether the email is already registered (enumeration).
    if (existing) {
      return res.status(400).json({ ok: false, error: 'Unable to create account', code: 'REGISTRATION_FAILED' });
    }

    let created;
    try {
      created = await createUserWithWorkspace({ email, password, name, workspaceName });
    } catch (e) {
      // Unique-email race: same generic response as the pre-check (no enumeration).
      const msg = String(e && e.message || e);
      if (/UNIQUE|Duplicate|ER_DUP_ENTRY|email/i.test(msg)) {
        return res.status(400).json({ ok: false, error: 'Unable to create account', code: 'REGISTRATION_FAILED' });
      }
      throw e;
    }
    await regenerateSession(req);
    delete req.session.clientPortalId;
    delete req.session.clientWorkspaceId;
    delete req.session.clientLeadId;
    req.session.userId = created.userId;
    req.session.workspaceId = created.workspaceId;
    await saveSession(req);
    const workspaces = await listWorkspacesForUser(created.userId);
    const user = {
      id: created.userId,
      email: String(email).trim().toLowerCase(),
      name: name || '',
      is_super_admin: 0,
      subscription_status: 'none',
      billing_plan: 'free',
      status: 'active',
    };
    res.json({ ok: true, data: await authPayload(user, created.workspaceId, workspaces) });
  } catch (e) {
    next(e);
  }
});

// Fixed hash for missing-user path so login timing matches a real bcrypt.compare.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-pad-not-a-real-password', 12);

router.post('/login', authLimit, captcha, async (req, res, next) => {
  try {
    const platform = require('../platform');
    const maintenance = await platform.getPlatformSetting('maintenance_mode', '0');
    const { email, password } = req.body || {};
    const user = await findUserByEmail(email);
    const hash = user ? user.password_hash : DUMMY_PASSWORD_HASH;
    const ok = await bcrypt.compare(String(password || ''), hash);
    if (!user || !ok) return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
    if (String(user.status || 'active') === 'disabled' || user.deleted_at) {
      return res.status(403).json({ ok: false, error: 'ACCOUNT_DISABLED' });
    }
    const isSuper = Number(user.is_super_admin) === 1;
    if (maintenance === '1' && !isSuper) {
      return res.status(503).json({ ok: false, error: 'MAINTENANCE_MODE' });
    }

    const workspaces = await listWorkspacesForUser(user.id);
    await regenerateSession(req);
    // Staff cookie only — never carry client portal keys on this session.
    delete req.session.clientPortalId;
    delete req.session.clientWorkspaceId;
    delete req.session.clientLeadId;
    req.session.userId = user.id;
    req.session.workspaceId = workspaces[0] ? workspaces[0].id : null;
    await saveSession(req);
    try { await require('../admin').touchLogin(user.id); } catch { /* ignore */ }
    res.json({ ok: true, data: await authPayload(user, req.session.workspaceId, workspaces) });
  } catch (e) {
    next(e);
  }
});

router.post('/forgot-password', authLimit, captcha, async (req, res, next) => {
  try {
    const email = req.body && req.body.email;
    const result = await require('../passwordReset').requestReset(email);
    res.json({ ok: true, data: result });
  } catch (e) { next(e); }
});

router.post('/reset-password', authLimit, captcha, async (req, res, next) => {
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
    await saveSession(req);
    const workspaces = await listWorkspacesForUser(req.session.userId);
    const billing = require('../billing');
    const userBilling = await billing.getUserBilling(req.session.userId);
    const productAccess = await billing.workspaceHasProductAccess(result.workspaceId)
      || billing.hasProductAccess(userBilling);
    res.json({
      ok: true,
      data: {
        ...result,
        workspaces,
        productAccess,
        workspaceSubscribed: await billing.workspaceHasSubscription(result.workspaceId),
        workspacePlan: await billing.workspacePlan(result.workspaceId),
        plan: billing.planOfUser(userBilling),
      },
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: e.code });
  }
});

router.post('/logout', (req, res) => {
  const finish = () => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  };
  if (!req.session) return finish();
  req.session.destroy((err) => {
    if (err) console.warn('[auth] session destroy:', err.message);
    finish();
  });
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const rows = await require('../db').query(
      `SELECT id, email, name, is_super_admin, status, created_at,
              subscription_status, billing_plan, current_period_end, deleted_at
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
    await saveSession(req);
    const billing = require('../billing');
    const user = await billing.getUserBilling(req.session.userId);
    const workspaceSubscribed = await billing.workspaceHasSubscription(workspaceId);
    const workspacePlan = await billing.workspacePlan(workspaceId);
    const productAccess = billing.hasProductAccess(user)
      || await billing.workspaceHasProductAccess(workspaceId);
    res.json({
      ok: true,
      data: {
        workspaceId,
        workspace: membership,
        workspaceSubscribed,
        workspacePlan,
        plan: billing.planOfUser(user),
        productAccess,
        subscribed: billing.isSubscribed(user),
      },
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
