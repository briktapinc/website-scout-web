'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const {
  createUserWithWorkspace,
  findUserByEmail,
  listWorkspacesForUser,
} = require('../workspace');
const { requireAuth } = require('../middleware');

const router = express.Router();

router.post('/register', async (req, res, next) => {
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
    const { email, password, name, workspaceName } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'email and password are required' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ ok: false, error: 'password must be at least 8 characters' });
    }
    const existing = await findUserByEmail(email);
    if (existing) return res.status(409).json({ ok: false, error: 'EMAIL_IN_USE' });

    const created = await createUserWithWorkspace({ email, password, name, workspaceName });
    req.session.userId = created.userId;
    req.session.workspaceId = created.workspaceId;
    const workspaces = await listWorkspacesForUser(created.userId);
    res.json({
      ok: true,
      data: {
        user: {
          id: created.userId,
          email: String(email).trim().toLowerCase(),
          name: name || '',
          isSuperAdmin: false,
        },
        workspaceId: created.workspaceId,
        workspaces,
        isSuperAdmin: false,
      },
    });
  } catch (e) {
    next(e);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const platform = require('../platform');
    const maintenance = await platform.getPlatformSetting('maintenance_mode', '0');
    const { email, password } = req.body || {};
    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
    const ok = await bcrypt.compare(String(password || ''), user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
    if (String(user.status || 'active') === 'disabled') {
      return res.status(403).json({ ok: false, error: 'ACCOUNT_DISABLED' });
    }
    const isSuper = Number(user.is_super_admin) === 1;
    if (maintenance === '1' && !isSuper) {
      return res.status(503).json({ ok: false, error: 'MAINTENANCE_MODE' });
    }

    const workspaces = await listWorkspacesForUser(user.id);
    req.session.userId = user.id;
    req.session.workspaceId = workspaces[0] ? workspaces[0].id : null;
    try { await require('../admin').touchLogin(user.id); } catch { /* ignore */ }
    res.json({
      ok: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          isSuperAdmin: isSuper,
        },
        workspaceId: req.session.workspaceId,
        workspaces,
        isSuperAdmin: isSuper,
      },
    });
  } catch (e) {
    next(e);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
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
    const isSuperAdmin = Number(user.is_super_admin) === 1;
    const billing = require('../billing');
    const subscribed = billing.isSubscribed(user);
    const workspaces = await listWorkspacesForUser(user.id);
    res.json({
      ok: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          created_at: user.created_at,
          isSuperAdmin,
          subscriptionStatus: user.subscription_status || 'none',
          currentPeriodEnd: user.current_period_end,
          subscribed,
        },
        workspaceId: req.session.workspaceId || (workspaces[0] && workspaces[0].id) || null,
        workspaces,
        isSuperAdmin,
        subscribed,
      },
    });
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
    res.json({ ok: true, data: { workspaceId, workspace: membership } });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
