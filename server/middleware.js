'use strict';

const { getMembership, findWorkspaceByToken } = require('./workspace');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
  }
  next();
}

async function requireWorkspace(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      const token = auth.slice(7).trim();
      const ws = await findWorkspaceByToken(token);
      if (!ws) return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
      req.auth = { via: 'token', workspaceId: ws.workspace_id, workspace: ws, role: 'token' };
      return next();
    }

    if (!req.session || !req.session.userId) {
      return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    }

    const workspaceId = Number(
      req.headers['x-workspace-id'] ||
      req.query.workspaceId ||
      req.session.workspaceId ||
      0
    );
    if (!workspaceId) {
      return res.status(400).json({ ok: false, error: 'WORKSPACE_REQUIRED' });
    }

    const membership = await getMembership(req.session.userId, workspaceId);
    if (!membership) {
      return res.status(403).json({ ok: false, error: 'NOT_A_MEMBER' });
    }

    req.session.workspaceId = workspaceId;
    req.auth = {
      via: 'session',
      userId: req.session.userId,
      workspaceId,
      workspace: membership,
      role: membership.role,
    };
    next();
  } catch (e) {
    next(e);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    if (req.auth.via === 'token') return next();
    if (!roles.includes(req.auth.role)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    next();
  };
}

async function requireSuperAdmin(req, res, next) {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    }
    const { isSuperAdmin } = require('./admin');
    const ok = await isSuperAdmin(req.session.userId);
    if (!ok) return res.status(403).json({ ok: false, error: 'SUPER_ADMIN_REQUIRED' });
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * Gate product APIs behind an active subscription when platform flag is on.
 * Super admins always pass. MCP bearer tokens pass if any workspace owner/admin is subscribed.
 */
async function requireSubscription(req, res, next) {
  try {
    const billing = require('./billing');
    const required = await billing.requireSubscriptionEnabled();
    if (!required) return next();

    if (req.auth && req.auth.via === 'token') {
      const { query } = require('./db');
      const members = await query(
        `SELECT u.id, u.is_super_admin, u.subscription_status, u.status, u.deleted_at
         FROM workspace_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = :workspaceId AND m.role IN ('owner','admin')`,
        { workspaceId: req.auth.workspaceId }
      );
      const ok = (members || []).some((u) => billing.isSubscribed(u));
      if (!ok) {
        return res.status(402).json({ ok: false, error: 'SUBSCRIPTION_REQUIRED', code: 'SUBSCRIPTION_REQUIRED' });
      }
      return next();
    }

    const userId = (req.auth && req.auth.userId) || (req.session && req.session.userId);
    if (!userId) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    const user = await billing.getUserBilling(userId);
    if (!user) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    if (billing.isSubscribed(user)) return next();
    return res.status(402).json({
      ok: false,
      error: 'SUBSCRIPTION_REQUIRED',
      code: 'SUBSCRIPTION_REQUIRED',
      subscriptionStatus: user.subscription_status || 'none',
    });
  } catch (e) {
    next(e);
  }
}

module.exports = {
  requireAuth, requireWorkspace, requireRole, requireSuperAdmin, requireSubscription,
};
