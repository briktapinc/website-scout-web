'use strict';

const express = require('express');
const billing = require('../billing');
const { requireAuth } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

function ok(res, data) { res.json({ ok: true, data }); }
function fail(res, e, status = 400) {
  const http = e.code === 'NOT_FOUND' ? 404
    : e.code === 'STRIPE_NOT_CONFIGURED' || e.code === 'PRICE_NOT_CONFIGURED' ? 503
    : e.code === 'INVALID_PLAN' || e.code === 'WORKSPACE_REQUIRED'
      || e.code === 'NO_SUBSCRIPTION' || e.code === 'ALREADY_SUBSCRIBED'
      || e.code === 'NO_SUBSCRIPTION_ITEM' ? 400
    : e.code === 'INSUFFICIENT_CREDITS' || e.code === 'PAST_DUE' ? 402
    : e.code === 'FORBIDDEN' ? 403
    : (typeof e.status === 'number' ? e.status : status);
  res.status(http).json({ ok: false, error: e.message || String(e), code: e.code });
}

router.get('/summary', async (req, res) => {
  try {
    const workspaceId = (req.session && req.session.workspaceId)
      || (req.query && req.query.workspaceId)
      || null;
    ok(res, await billing.billingSummary(req.session.userId, { workspaceId }));
  } catch (e) { fail(res, e, 500); }
});

router.post('/checkout', async (req, res) => {
  try {
    const plan = (req.body && (req.body.plan || req.body.planId)) || 'standard';
    ok(res, await billing.createCheckoutSession(req.session.userId, plan));
  } catch (e) { fail(res, e); }
});

router.post('/credits/checkout', async (req, res) => {
  try {
    const workspaceId = (req.body && req.body.workspaceId)
      || (req.session && req.session.workspaceId);
    const quantity = req.body && req.body.quantity;
    ok(res, await billing.createCreditsCheckoutSession(req.session.userId, workspaceId, { quantity }));
  } catch (e) { fail(res, e); }
});

router.post('/portal', async (req, res) => {
  try { ok(res, await billing.createPortalSession(req.session.userId)); }
  catch (e) { fail(res, e); }
});

/** Switch plan (proration) or Checkout if no active sub; plan=free cancels at period end. */
router.post('/change-plan', async (req, res) => {
  try {
    const plan = (req.body && (req.body.plan || req.body.planId)) || '';
    ok(res, await billing.startOrChangePlan(req.session.userId, plan));
  } catch (e) { fail(res, e); }
});

/** Downgrade to Free — cancel at period end. */
router.post('/cancel', async (req, res) => {
  try { ok(res, await billing.scheduleCancelAtPeriodEnd(req.session.userId)); }
  catch (e) { fail(res, e); }
});

/** Withdraw a scheduled cancel. */
router.post('/resume', async (req, res) => {
  try { ok(res, await billing.resumeSubscription(req.session.userId)); }
  catch (e) { fail(res, e); }
});

router.delete('/account', async (req, res) => {
  try {
    const confirm = String((req.body && req.body.confirm) || '');
    if (confirm !== 'DELETE') {
      return fail(res, Object.assign(new Error('Send { confirm: "DELETE" } to delete your account'), { code: 'CONFIRM_REQUIRED' }));
    }
    const result = await billing.deleteAccount(req.session.userId);
    req.session.destroy(() => {
      const locals = (req.app && req.app.locals) || {};
      const base = locals.sessionCookie || { path: '/' };
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
      ok(res, result);
    });
  } catch (e) { fail(res, e); }
});

module.exports = router;
