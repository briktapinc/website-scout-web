'use strict';

const { getMembership, findWorkspaceByToken } = require('./workspace');

async function loadSessionUser(userId) {
  const billing = require('./billing');
  return billing.getUserBilling(userId);
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
  }
  loadSessionUser(req.session.userId).then((user) => {
    if (!user || String(user.status || 'active') === 'disabled' || user.deleted_at) {
      return res.status(403).json({ ok: false, error: 'ACCOUNT_DISABLED' });
    }
    req.sessionUser = user;
    next();
  }).catch(next);
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

    const user = req.sessionUser || await loadSessionUser(req.session.userId);
    if (!user || String(user.status || 'active') === 'disabled' || user.deleted_at) {
      return res.status(403).json({ ok: false, error: 'ACCOUNT_DISABLED' });
    }
    req.sessionUser = user;

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
    // MCP bearer tokens are workspace-scoped credentials — treat as admin for product APIs.
    if (req.auth.via === 'token') {
      if (roles.includes('token') || roles.includes('admin') || roles.includes('owner') || roles.includes('member')) {
        return next();
      }
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
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
 * Super admins always pass. Session users pass if they OR a workspace owner/admin is subscribed.
 * MCP bearer tokens pass if any workspace owner/admin is subscribed.
 */
async function requireSubscription(req, res, next) {
  try {
    const billing = require('./billing');
    const required = await billing.requireSubscriptionEnabled();
    if (!required) return next();

    // Resolve Bearer auth if this middleware runs before requireWorkspace.
    if ((!req.auth || !req.auth.workspaceId) && req.headers.authorization) {
      const auth = req.headers.authorization || '';
      if (auth.startsWith('Bearer ')) {
        const ws = await findWorkspaceByToken(auth.slice(7).trim());
        if (!ws) return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
        req.auth = { via: 'token', workspaceId: ws.workspace_id, workspace: ws, role: 'token' };
      }
    }

    if (req.auth && req.auth.via === 'token') {
      const ok = await billing.workspaceHasSubscription(req.auth.workspaceId);
      if (!ok) {
        return res.status(402).json({ ok: false, error: 'SUBSCRIPTION_REQUIRED', code: 'SUBSCRIPTION_REQUIRED' });
      }
      return next();
    }

    const userId = (req.auth && req.auth.userId) || (req.session && req.session.userId);
    if (!userId) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    const user = req.sessionUser || await billing.getUserBilling(userId);
    if (!user) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    if (String(user.status || 'active') === 'disabled' || user.deleted_at) {
      return res.status(403).json({ ok: false, error: 'ACCOUNT_DISABLED' });
    }
    if (billing.isSubscribed(user)) return next();

    const workspaceId = (req.auth && req.auth.workspaceId)
      || (req.session && req.session.workspaceId)
      || Number(req.headers['x-workspace-id'] || 0);
    if (workspaceId && await billing.workspaceHasSubscription(workspaceId)) {
      return next();
    }

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
