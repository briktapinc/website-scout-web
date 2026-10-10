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
        user: { id: created.userId, email: String(email).trim().toLowerCase(), name: name || '' },
        workspaceId: created.workspaceId,
        workspaces,
      },
    });
  } catch (e) {
    next(e);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
    const ok = await bcrypt.compare(String(password || ''), user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });

    const workspaces = await listWorkspacesForUser(user.id);
    req.session.userId = user.id;
    req.session.workspaceId = workspaces[0] ? workspaces[0].id : null;
    res.json({
      ok: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name },
        workspaceId: req.session.workspaceId,
        workspaces,
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
      'SELECT id, email, name, created_at FROM users WHERE id = :id LIMIT 1',
      { id: req.session.userId }
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    const workspaces = await listWorkspacesForUser(user.id);
    res.json({
      ok: true,
      data: {
        user,
        workspaceId: req.session.workspaceId || (workspaces[0] && workspaces[0].id) || null,
        workspaces,
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
