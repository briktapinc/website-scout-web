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
      const leadId = ws.lead_id != null && Number(ws.lead_id) > 0 ? Number(ws.lead_id) : null;
      req.auth = {
        via: 'token',
        workspaceId: ws.workspace_id,
        workspace: ws,
        role: 'token',
        leadId,
        tokenId: ws.token_id,
      };
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

/**
 * Bearer tokens only satisfy an explicit 'token' role (or 'member' for MCP/agent routes).
 * They never satisfy owner/admin — secrets, CF publish, email send need a session role.
 * Any route listing 'member' is reachable by workspace API tokens; pair with
 * denyLeadScopedToken / requireTokenLeadScope when the action is workspace-wide.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    if (req.auth.via === 'token') {
      if (roles.includes('token') || roles.includes('member')) {
        return next();
      }
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'TOKEN_ROLE_DENIED' });
    }
    if (!roles.includes(req.auth.role)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    next();
  };
}

/** Reject lead-scoped tokens when the request targets a different lead. */
function requireTokenLeadScope(getLeadId) {
  return (req, res, next) => {
    if (!req.auth || req.auth.via !== 'token' || !req.auth.leadId) return next();
    let leadId = null;
    try {
      leadId = typeof getLeadId === 'function' ? getLeadId(req) : null;
    } catch {
      leadId = null;
    }
    if (leadId == null || !Number.isFinite(Number(leadId)) || Number(leadId) <= 0) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
    }
    if (Number(leadId) !== Number(req.auth.leadId)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
    }
    next();
  };
}

/** Block workspace-wide ops for lead-scoped bearer tokens. */
function denyLeadScopedToken(req, res, next) {
  if (req.auth && req.auth.via === 'token' && req.auth.leadId) {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
  }
  next();
}

/**
 * For lead-scoped tokens: pin req.query.leadId and reject conflicting leadId in body/query.
 * Pass-through for session users and unscoped tokens.
 */
function pinTokenLeadFilter(req, res, next) {
  if (!req.auth || req.auth.via !== 'token' || !req.auth.leadId) return next();
  const scoped = Number(req.auth.leadId);
  const qLead = req.query && req.query.leadId != null ? Number(req.query.leadId) : null;
  const bLead = req.body && req.body.leadId != null ? Number(req.body.leadId) : null;
  if (qLead != null && Number.isFinite(qLead) && qLead > 0 && qLead !== scoped) {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
  }
  if (bLead != null && Number.isFinite(bLead) && bLead > 0 && bLead !== scoped) {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
  }
  req.query = { ...(req.query || {}), leadId: String(scoped) };
  if (req.body && typeof req.body === 'object') {
    req.body.leadId = scoped;
  }
  next();
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
 * Gate product APIs when billing.require_subscription is on.
 * Free plan counts as access (no Checkout required). Super admins always pass.
 * Session users pass if they OR a workspace owner/admin has product access.
 * MCP bearer tokens pass if any workspace owner/admin has product access.
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
        const leadId = ws.lead_id != null && Number(ws.lead_id) > 0 ? Number(ws.lead_id) : null;
        req.auth = {
          via: 'token',
          workspaceId: ws.workspace_id,
          workspace: ws,
          role: 'token',
          leadId,
          tokenId: ws.token_id,
        };
      }
    }

    if (req.auth && req.auth.via === 'token') {
      const ok = await billing.workspaceHasProductAccess(req.auth.workspaceId);
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
    if (billing.hasProductAccess(user)) return next();

    const workspaceId = (req.auth && req.auth.workspaceId)
      || (req.session && req.session.workspaceId)
      || Number(req.headers['x-workspace-id'] || 0);
    if (workspaceId && await billing.workspaceHasProductAccess(workspaceId)) {
      return next();
    }

    return res.status(402).json({
      ok: false,
      error: 'SUBSCRIPTION_REQUIRED',
      code: 'SUBSCRIPTION_REQUIRED',
      subscriptionStatus: user.subscription_status || 'none',
      plan: billing.planOfUser(user),
    });
  } catch (e) {
    next(e);
  }
}

module.exports = {
  requireAuth,
  requireWorkspace,
  requireRole,
  requireTokenLeadScope,
  denyLeadScopedToken,
  pinTokenLeadFilter,
  requireSuperAdmin,
  requireSubscription,
};
