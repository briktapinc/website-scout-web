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
    : (typeof e.status === 'number' ? e.status : status);
  res.status(http).json({ ok: false, error: e.message || String(e), code: e.code });
}

router.get('/summary', async (req, res) => {
  try { ok(res, await billing.billingSummary(req.session.userId)); }
  catch (e) { fail(res, e, 500); }
});

router.post('/checkout', async (req, res) => {
  try { ok(res, await billing.createCheckoutSession(req.session.userId)); }
  catch (e) { fail(res, e); }
});

router.post('/portal', async (req, res) => {
  try { ok(res, await billing.createPortalSession(req.session.userId)); }
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
      res.clearCookie('scout.sid');
      res.clearCookie('connect.sid');
      ok(res, result);
    });
  } catch (e) { fail(res, e); }
});

module.exports = router;
