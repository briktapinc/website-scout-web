'use strict';

/**
 * Client portal API — isolated from staff via cookie bitpype.portal.sid
 * (staff uses bitpype.sid). Session keys: clientPortalId, clientWorkspaceId, clientLeadId
 */

const express = require('express');
const portal = require('../clientPortal');
const { requireCaptcha } = require('../captcha');
const { rateLimit } = require('../rateLimit');

const router = express.Router();
const accessLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 12 });
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const actionLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });
const editLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
const agentChatLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const captcha = requireCaptcha();

function ok(res, data) { res.json({ ok: true, data }); }
function fail(res, e, status = 400) {
  const http = e.code === 'NOT_FOUND' ? 404
    : e.code === 'INVALID_CREDENTIALS' ? 401
    : e.code === 'RATE_LIMITED' ? 429
    : e.code === 'EMAIL_FAILED' ? 502
    : e.code === 'PAYMENT_REQUIRED' || e.code === 'INSUFFICIENT_CREDITS' ? 402
    : e.code === 'PRICE_NOT_CONFIGURED' || e.code === 'STRIPE_NOT_CONFIGURED' ? 503
    : e.code === 'BUDGET_EXCEEDED' || e.code === 'AUTOMATION_PAUSED' || e.code === 'AI_NOT_CONFIGURED' ? 403
    : e.code === 'FORBIDDEN' || e.code === 'PLAN_REQUIRED' ? 403
    : e.code === 'NO_SELF_BILLING' || e.code === 'NO_CUSTOMER' ? 403
    : e.code === 'AI_IMPROVEMENT_FAILED' || e.code === 'AI_REQUEST_FAILED' || e.code === 'AI_NETWORK_ERROR' || e.code === 'AI_BAD_RESPONSE'
      || e.code === 'AI_DOWNLOAD_FAILED' || e.code === 'AI_EMPTY'
      || e.code === 'MUSE_NETWORK' || e.code === 'MUSE_BAD_RESPONSE' || e.code === 'MUSE_REQUEST_FAILED' ? 502
    : e.code === 'TOO_LONG' ? 400
    : e.code === 'NO_SITE' || e.code === 'NOT_EDITABLE' || e.code === 'NO_VALID_EDITS'
      || e.code === 'TOO_MANY' || e.code === 'EMPTY' || e.code === 'INVALID' || e.code === 'INVALID_IMAGE' || e.code === 'TOO_LARGE'
      || e.code === 'NO_SUBSCRIPTION' || e.code === 'ALREADY_SUBSCRIBED'
      || e.code === 'INVALID_PLAN' || e.code === 'NO_SUBSCRIPTION_ITEM' || e.code === 'INVALID_ARGS'
      || e.code === 'SELF_REFERRAL' || e.code === 'DUPLICATE' ? 400
      : (typeof e.status === 'number' ? e.status : status);
  res.status(http).json({ ok: false, error: e.message || String(e), code: e.code });
}

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
  const base = locals.portalSessionCookie || locals.sessionCookie || {
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
  res.clearCookie(locals.portalSessionName || 'bitpype.portal.sid', opts);
}

function portalIdleMs(req) {
  const fromApp = req.app && req.app.locals && Number(req.app.locals.portalIdleMs);
  if (Number.isFinite(fromApp) && fromApp > 0) return fromApp;
  return 30 * 60 * 60 * 1000;
}

function destroyPortalSession(req, res) {
  return new Promise((resolve) => {
    const finish = () => {
      clearSessionCookie(req, res);
      resolve();
    };
    if (!req.session || typeof req.session.destroy !== 'function') return finish();
    req.session.destroy((err) => {
      if (err) console.warn('[portal] idle destroy:', err.message);
      finish();
    });
  });
}

async function requireClient(req, res, next) {
  try {
    const id = req.session && req.session.clientPortalId;
    if (!id) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED', code: 'AUTH_REQUIRED' });

    const idleMs = portalIdleMs(req);
    const last = Number(req.session.clientLastActiveAt) || 0;
    if (last > 0 && (Date.now() - last) > idleMs) {
      await destroyPortalSession(req, res);
      return res.status(401).json({
        ok: false,
        error: 'Signed out after 30 hours of inactivity. Please sign in again.',
        code: 'SESSION_IDLE',
      });
    }

    const user = await portal.findById(id);
    if (!user || String(user.status) !== 'active') {
      await destroyPortalSession(req, res);
      return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED', code: 'AUTH_REQUIRED' });
    }

    // Rolling idle clock: any authenticated portal API call counts as activity.
    req.session.clientLastActiveAt = Date.now();
    req.client = user;
    next();
  } catch (e) {
    next(e);
  }
}

router.post('/access', accessLimit, captcha, async (req, res) => {
  try {
    const email = req.body && req.body.email;
    ok(res, await portal.requestAccess(email));
  } catch (e) { fail(res, e); }
});

async function establishPortalSession(req, client) {
  await regenerateSession(req);
  // Portal cookie only (bitpype.portal.sid) — never touches staff bitpype.sid.
  req.session.clientPortalId = client.id;
  req.session.clientWorkspaceId = client.workspaceId;
  req.session.clientLeadId = client.leadId;
  req.session.clientLastActiveAt = Date.now();
  delete req.session.userId;
  delete req.session.workspaceId;
  await saveSession(req);
}

router.post('/login', loginLimit, captcha, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const client = await portal.login(email, password);
    await establishPortalSession(req, client);
    ok(res, {
      client: portal.publicClient(client),
      idleMs: portalIdleMs(req),
    });
  } catch (e) { fail(res, e); }
});

router.post('/magic-login', loginLimit, async (req, res) => {
  try {
    const token = (req.body && req.body.token) || '';
    const client = await portal.loginWithMagicToken(token);
    await establishPortalSession(req, client);
    ok(res, {
      client: portal.publicClient(client),
      idleMs: portalIdleMs(req),
    });
  } catch (e) { fail(res, e); }
});

router.post('/logout', (req, res) => {
  const clear = () => {
    clearSessionCookie(req, res);
    ok(res, { loggedOut: true });
  };
  if (!req.session) return clear();
  req.session.destroy((err) => {
    if (err) console.warn('[portal] session destroy:', err.message);
    clear();
  });
});

router.get('/me', requireClient, async (req, res) => {
  try {
    const ctx = portal.loadLeadContext(req.client.workspace_id, req.client.lead_id);
    ok(res, {
      client: portal.publicClient(req.client),
      lead: ctx.lead,
      site: ctx.site ? {
        id: ctx.site.id,
        name: ctx.site.name,
        status: ctx.site.status,
        updated_at: ctx.site.updated_at,
      } : null,
      previewUrl: ctx.previewUrl,
      hasDesignJob: !!(ctx.designJob && ctx.designJob.id),
      idleMs: portalIdleMs(req),
      lastActiveAt: req.session.clientLastActiveAt || null,
    });
  } catch (e) { fail(res, e, 500); }
});

router.get('/calendar', requireClient, async (req, res) => {
  try {
    const data = await portal.calendarPosts(
      req.client.workspace_id,
      req.client.lead_id,
      { year: req.query.year, month: req.query.month, clientEmail: req.client.email }
    );
    ok(res, data);
  } catch (e) { fail(res, e, 500); }
});

router.post('/social/posts/:id/image', requireClient, actionLimit, async (req, res) => {
  try {
    const data = await portal.generatePostBrandedImage(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.id,
      req.client.email
    );
    ok(res, data);
  } catch (e) { fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500); }
});

router.post('/social/generate', requireClient, actionLimit, async (req, res) => {
  try {
    const period = String((req.body && req.body.period) || 'month').toLowerCase() === 'week'
      ? 'week'
      : 'month';
    const data = await portal.generateSocial(
      req.client.workspace_id,
      req.client.lead_id,
      req.client.email,
      period
    );
    ok(res, data);
  } catch (e) { fail(res, e, 500); }
});

router.get('/analytics', requireClient, async (req, res) => {
  try {
    ok(res, require('../domain').withDb(req.client.workspace_id, db =>
      require('../siteAnalytics').report(db, req.client.lead_id, req.query.days)));
  } catch (e) { fail(res, e); }
});
router.post('/analytics', requireClient, actionLimit, async (req, res) => {
  try {
    const data = require('../domain').withDb(req.client.workspace_id, db =>
      require('../siteAnalytics').save(db, req.client.workspace_id, req.client.lead_id, req.body || {}));
    ok(res, { ...data, publishRequired: true });
  } catch (e) { fail(res, e); }
});

router.post('/changes', requireClient, actionLimit, async (req, res) => {
  try {
    const data = await portal.submitChangeRequest(
      req.client.workspace_id,
      req.client.lead_id,
      req.client.email,
      req.body || {}
    );
    ok(res, data);
  } catch (e) { fail(res, e, e.code === 'EMPTY' ? 400 : 500); }
});

/** Editable HTML for the client's own site (session workspace_id + lead_id). */
router.get('/site/render', requireClient, async (req, res) => {
  try {
    const data = portal.renderClientSite(
      req.client.workspace_id,
      req.client.lead_id,
      {
        editable: req.query.editable !== '0' && req.query.editable !== 'false',
        pageSlug: req.query.pageSlug || undefined,
      }
    );
    ok(res, data);
  } catch (e) { fail(res, e, e.code === 'NOT_FOUND' || e.code === 'NO_SITE' ? 404 : 500); }
});

/**
 * Apply inline text edits from the portal preview iframe.
 * Body: { edits: [{ id: "page:section:path", text: "…" }] }
 * Scoped to the session client’s lead site only; rematerializes public previews.
 */
router.post('/site/edits', requireClient, editLimit, async (req, res) => {
  try {
    // Defense in depth: session lead must match stored client row.
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id)
      || Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const edits = (req.body && req.body.edits) || [];
    const data = portal.applyClientTextEdits(
      req.client.workspace_id,
      req.client.lead_id,
      edits
    );
    ok(res, data);
  } catch (e) { fail(res, e, 500); }
});

/** Add or delete a list/card/FAQ item (section model), or save freeform HTML after clone/delete. */
router.post('/site/list-item', requireClient, editLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id)
      || Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const body = req.body || {};
    const action = String(body.action || '').toLowerCase();
    let data;
    if (action === 'freeform-save') {
      data = portal.saveClientPageHtml(req.client.workspace_id, req.client.lead_id, body);
    } else {
      data = portal.mutateClientListItem(req.client.workspace_id, req.client.lead_id, body);
    }
    ok(res, data);
  } catch (e) {
    fail(res, e, e.code === 'LAST_ITEM' || e.code === 'TOO_MANY' || e.code === 'INVALID' ? 400 : 500);
  }
});

/**
 * Replace a site image from portal edit mode.
 * Body: { replaceSrc: "images/hero.jpg", data: "<base64>", mimeType: "image/jpeg" }
 * Client should resize/compress first (max width ~1600). Rematerializes /site-previews.
 */
router.post('/site/image', requireClient, editLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id)
      || Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = await portal.applyClientImageUpload(
      req.client.workspace_id,
      req.client.lead_id,
      req.body || {}
    );
    ok(res, data);
  } catch (e) { fail(res, e, 500); }
});

/**
 * AI-generate an image and replace a site asset (edit mode).
 * Body: { replaceSrc: "images/hero.jpg", prompt: "…" }
 * Charges credits on Free/Standard; Premium (socialImagesIncluded) is free.
 */
router.post('/site/image-generate', requireClient, actionLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id)
      || Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = await portal.generateClientSiteImage(
      req.client.workspace_id,
      req.client.lead_id,
      req.body || {},
      req.client.email
    );
    ok(res, data);
  } catch (e) {
    fail(res, e, e.code === 'INSUFFICIENT_CREDITS' || e.code === 'PAYMENT_REQUIRED' ? 402 : 500);
  }
});

/**
 * Upload or clear the site header logo.
 * Body: { data, mimeType } for image logo, or { mode: "text" } to revert to text brand.
 * Optional brandName. Rematerializes /site-previews.
 */
router.post('/site/logo', requireClient, editLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id)
      || Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = await portal.applyClientLogoUpload(
      req.client.workspace_id,
      req.client.lead_id,
      req.body || {}
    );
    ok(res, data);
  } catch (e) { fail(res, e, 500); }
});

/**
 * Update site theme colors from the portal.
 * Body: { primary?, secondary?, bg?, text? } — hex colors. Saves a new website version.
 */
router.get('/site/structure', requireClient, async (req, res) => {
  try {
    const data = portal.getClientSiteStructure(req.client.workspace_id, req.client.lead_id);
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.post('/site/structure', requireClient, editLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id)
      || Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = portal.applyClientStructureReorder(
      req.client.workspace_id,
      req.client.lead_id,
      req.body || {}
    );
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

/**
 * Canvas pick: return HTML for a design module or widget to insert in edit mode.
 * Does not rewrite page placement (widgets stay inside design modules).
 * Body: { kind: 'layout'|'module'|'form', type?, cols?, formId? }
 */
router.post('/site/canvas-block', requireClient, editLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id)
      || Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = portal.prepareCanvasBlock(
      req.client.workspace_id,
      req.client.lead_id,
      req.body || {}
    );
    ok(res, data);
  } catch (e) {
    fail(res, e, e.code === 'INVALID' || e.code === 'NOT_FOUND' ? 400 : 500);
  }
});

router.post('/site/theme', requireClient, editLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id)
      || Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = await portal.applyClientThemeColors(
      req.client.workspace_id,
      req.client.lead_id,
      req.body || {}
    );
    ok(res, data);
  } catch (e) {
    const code = e && e.code;
    fail(
      res,
      e,
      code === 'INVALID_COLOR' || code === 'EMPTY' || code === 'NO_SITE' || code === 'NOT_FOUND' ? 400 : 500
    );
  }
});

/**
 * Muse agent chat — describe a site improvement; agent edits via client tools and returns fresh preview HTML.
 * Body: { message: string, history?: [{ role, content }], pageSlug?: string }
 */
router.post('/site/agent-chat', requireClient, agentChatLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id)
      || Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = await portal.runSiteAgentChat(
      req.client.workspace_id,
      req.client.lead_id,
      req.body || {}
    );
    ok(res, data);
  } catch (e) {
    fail(res, e, 500);
  }
});

/** Force rematerialize export + refresh public preview (Cloudflare Pages when configured). */
router.post('/site/publish', requireClient, actionLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id)
      || Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = await portal.publishClientSitePreview(
      req.client.workspace_id,
      req.client.lead_id
    );
    ok(res, data);
  } catch (e) {
    const code = e && e.code;
    fail(
      res,
      e,
      code === 'NO_SITE' || code === 'NOT_FOUND' ? 404
        : code === 'NAV_EXPORT_FAILED' || code === 'PREVIEW_NOT_CONFIGURED' ? 422
          : 500
    );
  }
});

router.get('/billing', requireClient, async (req, res) => {
  try {
    ok(res, await portal.billingForClient(req.client.workspace_id, req.client.email));
  } catch (e) { fail(res, e, 500); }
});

/** Next "Did you know?" upsell tip for Free/basic portal users. */
router.get('/upsell-tips/next', requireClient, async (req, res) => {
  try {
    const billing = require('../billing');
    const tips = require('../upsellTips');
    const planId = await billing.effectivePlan(req.client.workspace_id, { email: req.client.email });
    const result = await tips.nextTipForClient({
      portalUserId: req.client.id,
      planId,
    });
    ok(res, { ...result, plan: planId });
  } catch (e) { fail(res, e, 500); }
});

router.post('/billing/portal', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.openBillingPortal(req.client.workspace_id, req.client.email));
  } catch (e) { fail(res, e); }
});

router.post('/billing/checkout', requireClient, actionLimit, async (req, res) => {
  try {
    const plan = (req.body && (req.body.plan || req.body.planId)) || 'standard';
    ok(res, await portal.openCheckout(req.client.workspace_id, req.client.email, plan));
  } catch (e) { fail(res, e); }
});

/** Switch Free/Standard/Premium — proration update when subscribed; Checkout for first paid plan. */
router.post('/billing/change-plan', requireClient, actionLimit, async (req, res) => {
  try {
    const plan = (req.body && (req.body.plan || req.body.planId)) || '';
    ok(res, await portal.changePlan(req.client.workspace_id, req.client.email, plan));
  } catch (e) { fail(res, e); }
});

/** Downgrade to Free (cancel at period end). */
router.post('/billing/cancel', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.cancelToFree(req.client.workspace_id, req.client.email));
  } catch (e) { fail(res, e); }
});

/** Withdraw a scheduled cancel. */
router.post('/billing/resume', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.resumeBilling(req.client.workspace_id, req.client.email));
  } catch (e) { fail(res, e); }
});

router.post('/billing/credits/checkout', requireClient, actionLimit, async (req, res) => {
  try {
    const quantity = req.body && req.body.quantity;
    ok(res, await portal.openCreditsCheckout(req.client.workspace_id, req.client.email, quantity));
  } catch (e) { fail(res, e); }
});

/* ── Referrals ── */

router.get('/referrals', requireClient, async (req, res) => {
  try {
    const referrals = require('../referrals');
    ok(res, await referrals.summaryForPortalUser(req.client));
  } catch (e) { fail(res, e, 500); }
});

router.post('/referrals', requireClient, actionLimit, async (req, res) => {
  try {
    const referrals = require('../referrals');
    ok(res, {
      referral: referrals.publicReferral(
        await referrals.createReferral(req.client, req.body || {})
      ),
      ...(await referrals.summaryForPortalUser(req.client)),
    });
  } catch (e) { fail(res, e); }
});

/* ── Social (Meta connect + schedule) ── */

router.get('/social/accounts', requireClient, async (req, res) => {
  try {
    ok(res, portal.socialAccountsForClient(req.client.workspace_id, req.client.lead_id));
  } catch (e) { fail(res, e, 500); }
});

router.get('/social/oauth/start', requireClient, async (req, res) => {
  try {
    const returnTo = (req.query && req.query.returnTo)
      || '/portal?connected=1#/social';
    ok(res, portal.socialOauthStartForClient(
      req.client.workspace_id,
      req.client.lead_id,
      returnTo
    ));
  } catch (e) { fail(res, e); }
});

router.delete('/social/accounts/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, portal.socialDisconnectForClient(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.id
    ));
  } catch (e) { fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500); }
});

router.patch('/social/posts/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, {
      post: portal.socialUpdatePostForClient(
        req.client.workspace_id,
        req.client.lead_id,
        req.params.id,
        req.body || {}
      ),
    });
  } catch (e) { fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400); }
});

router.post('/social/posts/approve', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, portal.socialApprovePostsForClient(
      req.client.workspace_id,
      req.client.lead_id,
      (req.body && req.body.postIds) || []
    ));
  } catch (e) { fail(res, e); }
});

/* ── Contact forms (multiple per lead) ── */

router.get('/forms', requireClient, async (req, res) => {
  try {
    ok(res, await portal.listContactForms(
      req.client.workspace_id,
      req.client.lead_id,
      req.client.email
    ));
  } catch (e) { fail(res, e, 500); }
});

router.post('/forms', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.createContactForm(
      req.client.workspace_id,
      req.client.lead_id,
      req.body || {},
      req.client.email
    ));
  } catch (e) { fail(res, e); }
});

/** Static paths before /forms/:id */
router.get('/forms/submissions', requireClient, async (req, res) => {
  try {
    ok(res, await portal.listFormSubmissions(
      req.client.workspace_id,
      req.client.lead_id,
      {
        limit: req.query.limit,
        offset: req.query.offset,
        formId: req.query.formId,
        clientEmail: req.client.email,
      }
    ));
  } catch (e) { fail(res, e, 500); }
});

router.get('/forms/submissions/:id', requireClient, async (req, res) => {
  try {
    ok(res, await portal.getFormSubmission(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.id,
      req.client.email
    ));
  } catch (e) { fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500); }
});

router.post('/forms/publish', requireClient, actionLimit, async (req, res) => {
  try {
    const body = req.body || {};
    ok(res, await portal.publishContactForm(
      req.client.workspace_id,
      req.client.lead_id,
      {
        toSite: body.toSite,
        embed_on_page: body.embed_on_page,
        target_page_slug: body.target_page_slug,
        formId: body.formId || body.id,
      },
      body.formId || body.id
    ));
  } catch (e) { fail(res, e); }
});

/** Back-compat: PUT /forms with body.id or first form. */
router.put('/forms', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.saveContactForm(
      req.client.workspace_id,
      req.client.lead_id,
      req.body || {},
      req.client.email,
      req.body && req.body.id
    ));
  } catch (e) { fail(res, e); }
});

router.get('/forms/:id', requireClient, async (req, res) => {
  try {
    ok(res, await portal.getContactForm(
      req.client.workspace_id,
      req.client.lead_id,
      req.client.email,
      req.params.id
    ));
  } catch (e) { fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500); }
});

router.put('/forms/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.saveContactForm(
      req.client.workspace_id,
      req.client.lead_id,
      req.body || {},
      req.client.email,
      req.params.id
    ));
  } catch (e) { fail(res, e); }
});

router.delete('/forms/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.deleteContactForm(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.id
    ));
  } catch (e) { fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500); }
});

router.post('/forms/:id/publish', requireClient, actionLimit, async (req, res) => {
  try {
    const body = req.body || {};
    ok(res, await portal.publishContactForm(
      req.client.workspace_id,
      req.client.lead_id,
      {
        toSite: body.toSite,
        embed_on_page: body.embed_on_page,
        target_page_slug: body.target_page_slug,
      },
      req.params.id
    ));
  } catch (e) { fail(res, e); }
});

/* ── Site modules (Standard / Premium) ── */

router.get('/modules', requireClient, async (req, res) => {
  try {
    ok(res, await portal.listSiteModules(
      req.client.workspace_id,
      req.client.lead_id,
      req.client.email
    ));
  } catch (e) { fail(res, e, 500); }
});

router.post('/modules/upload-image', requireClient, actionLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id)
      || Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = await portal.applyModuleAssetUpload(
      req.client.workspace_id,
      req.client.lead_id,
      req.body || {}
    );
    ok(res, data);
  } catch (e) { fail(res, e, e.code === 'EMPTY' || e.code === 'INVALID_IMAGE' || e.code === 'TOO_LARGE' ? 400 : 500); }
});

/* Bookings admin routes must be registered before /modules/:type/:id */
router.get('/modules/bookings/admin', requireClient, async (req, res) => {
  try {
    const includeArchived = req.query.includeArchived === '1'
      || String(req.query.includeArchived || '').toLowerCase() === 'true';
    ok(res, await portal.getBookingAdmin(
      req.client.workspace_id,
      req.client.lead_id,
      req.client.email,
      { includeArchived }
    ));
  } catch (e) { fail(res, e); }
});

router.put('/modules/bookings/settings', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.saveBookingSettings(
      req.client.workspace_id,
      req.client.lead_id,
      req.body || {},
      req.client.email
    ));
  } catch (e) { fail(res, e); }
});

router.put('/modules/bookings/hours', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.saveBookingHours(
      req.client.workspace_id,
      req.client.lead_id,
      req.body || {},
      req.client.email
    ));
  } catch (e) { fail(res, e); }
});

router.put('/modules/bookings/appointments/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.updateBookingAppointment(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.id,
      req.body || {},
      req.client.email
    ));
  } catch (e) { fail(res, e); }
});

router.post('/modules/bookings/blocks', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.createBookingBlockAdmin(
      req.client.workspace_id,
      req.client.lead_id,
      req.body || {},
      req.client.email
    ));
  } catch (e) { fail(res, e); }
});

router.delete('/modules/bookings/blocks/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.deleteBookingBlockAdmin(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.id,
      req.client.email
    ));
  } catch (e) { fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400); }
});

/* Chatbot admin (must be before /modules/:type) */
router.get('/modules/chatbot/admin', requireClient, async (req, res) => {
  try {
    ok(res, await portal.getChatbotAdmin(
      req.client.workspace_id,
      req.client.lead_id,
      req.client.email
    ));
  } catch (e) { fail(res, e); }
});

router.put('/modules/chatbot/settings', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.saveChatbotSettings(
      req.client.workspace_id,
      req.client.lead_id,
      req.body || {},
      req.client.email
    ));
  } catch (e) { fail(res, e); }
});

router.post('/modules/chatbot/knowledge/upload', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.uploadChatbotKnowledge(
      req.client.workspace_id,
      req.client.lead_id,
      req.body || {},
      req.client.email
    ));
  } catch (e) { fail(res, e); }
});

router.post('/modules/chatbot/escalations/:id/resolve', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.resolveChatbotEscalation(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.id,
      req.client.email
    ));
  } catch (e) { fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400); }
});

router.get('/modules/:type', requireClient, async (req, res) => {
  try {
    const includeArchived = req.query.includeArchived === '1'
      || String(req.query.includeArchived || '').toLowerCase() === 'true';
    ok(res, await portal.listModuleItems(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.type,
      req.client.email,
      { includeArchived }
    ));
  } catch (e) { fail(res, e); }
});

router.post('/modules/:type', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.createModuleItem(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.type,
      req.body || {},
      req.client.email
    ));
  } catch (e) { fail(res, e); }
});

router.put('/modules/:type/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.updateModuleItem(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.type,
      req.params.id,
      req.body || {},
      req.client.email
    ));
  } catch (e) { fail(res, e); }
});

router.delete('/modules/:type/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.deleteModuleItem(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.type,
      req.params.id,
      req.client.email
    ));
  } catch (e) { fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400); }
});

router.post('/modules/:type/:id/children', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.addModuleChild(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.type,
      req.params.id,
      req.body || {},
      req.client.email
    ));
  } catch (e) { fail(res, e); }
});

router.delete('/modules/:type/children/:childId', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.deleteModuleChild(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.type,
      req.params.childId,
      req.client.email
    ));
  } catch (e) { fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400); }
});

router.post('/modules/:type/attach', requireClient, actionLimit, async (req, res) => {
  try {
    const body = req.body || {};
    ok(res, await portal.attachSiteModule(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.type,
      {
        title: body.title,
        target_page_slug: body.target_page_slug,
        embed_enabled: body.embed_enabled != null ? body.embed_enabled : body.toSite,
        toSite: body.toSite,
      },
      req.client.email
    ));
  } catch (e) { fail(res, e); }
});

router.post('/modules/:type/detach', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.detachSiteModule(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.type,
      req.client.email
    ));
  } catch (e) { fail(res, e); }
});

/* ── LeadScout (form + booking contacts) ── */

router.get('/leadscout/contacts', requireClient, async (req, res) => {
  try {
    ok(res, {
      contacts: await portal.listLeadScoutContacts(
        req.client.workspace_id,
        req.client.lead_id,
        {
          q: req.query.q,
          limit: req.query.limit,
          offset: req.query.offset,
        }
      ),
      health: await portal.leadScoutHealth(req.client.workspace_id, req.client.lead_id),
    });
  } catch (e) { fail(res, e, 500); }
});

router.get('/leadscout/contacts/:id', requireClient, async (req, res) => {
  try {
    ok(res, await portal.getLeadScoutContact(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.id
    ));
  } catch (e) { fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500); }
});

router.get('/leadscout/health', requireClient, async (req, res) => {
  try {
    ok(res, await portal.leadScoutHealth(req.client.workspace_id, req.client.lead_id));
  } catch (e) { fail(res, e, 500); }
});

router.post('/leadscout/retry', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.retryLeadScoutFailures(req.client.workspace_id, req.client.lead_id));
  } catch (e) { fail(res, e); }
});

/** Standard/Premium: lead-scoped MCP tokens for this client site. */
router.get('/mcp/tokens', requireClient, async (req, res) => {
  try {
    ok(res, await portal.listClientMcpTokens(
      req.client.workspace_id,
      req.client.lead_id,
      req.client.email
    ));
  } catch (e) { fail(res, e); }
});

router.post('/mcp/token', requireClient, actionLimit, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    ok(res, await portal.createClientMcpToken(
      req.client.workspace_id,
      req.client.lead_id,
      req.client.email,
      { name: body.name }
    ));
  } catch (e) { fail(res, e); }
});

router.delete('/mcp/token/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.revokeClientMcpToken(
      req.client.workspace_id,
      req.client.lead_id,
      req.client.email,
      req.params.id
    ));
  } catch (e) { fail(res, e); }
});

module.exports = router;
