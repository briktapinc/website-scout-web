'use strict';

/**
 * Public site-module JSON for in-page module-embed.js mounts
 * (token: `{workspaceId}_{random}`). /embed/module.html is a standalone viewer only.
 */

const express = require('express');
const domain = require('../domain');
const siteModules = require('../siteModules');
const { requireCaptcha, getCaptchaConfig } = require('../captcha');
const { rateLimit } = require('../rateLimit');
const { assertWorkspaceExists } = require('../workspaceExists');

const router = express.Router();
const readLimit = rateLimit({ windowMs: 60 * 1000, max: 120 });
const bookLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
const captcha = requireCaptcha();

function fail(res, e, status = 400) {
  const http = e.code === 'NOT_FOUND' ? 404
    : e.code === 'VALIDATION' ? (e.status === 409 ? 409 : 400)
    : (typeof e.status === 'number' ? e.status : status);
  res.status(http).json({ ok: false, error: e.message || String(e), code: e.code });
}

async function workspaceFromReq(req) {
  const fromToken = siteModules.parseWorkspaceFromToken(req.params.token);
  const fromQuery = Number(
    (req.query && (req.query.w || req.query.workspaceId))
    || (req.body && (req.body.w || req.body.workspaceId))
  );
  const workspaceId = fromToken || fromQuery;
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
    const err = new Error('Could not resolve workspace for this module');
    err.code = 'INVALID';
    throw err;
  }
  await assertWorkspaceExists(workspaceId);
  return workspaceId;
}

router.get('/:token', readLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const slug = req.query.slug || req.query.item || null;
    const data = domain.withDb(workspaceId, (db) => {
      if (slug) return siteModules.getPublicModuleItem(db, req.params.token, slug);
      return siteModules.getPublicModuleByToken(db, req.params.token);
    });
    const captchaCfg = await getCaptchaConfig();
    res.json({ ok: true, data: { ...data, workspaceId, captcha: captchaCfg } });
  } catch (e) { fail(res, e); }
});

/** Available time slots for the bookings module (calendar day + service). */
router.get('/:token/slots', readLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const date = req.query.date || req.query.day;
    if (!date) {
      const err = new Error('date is required (YYYY-MM-DD)');
      err.code = 'VALIDATION';
      throw err;
    }
    const data = domain.withDb(workspaceId, (db) => siteModules.getPublicBookingSlots(db, req.params.token, {
      date,
      serviceId: req.query.serviceId || req.query.service_id || null,
      serviceSlug: req.query.service || req.query.serviceSlug || null,
    }));
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) { fail(res, e); }
});

/** Public appointment booking (creates pending or auto-confirmed appointment). */
router.post('/:token/book', bookLimit, captcha, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const body = req.body || {};
    const data = domain.withDb(workspaceId, (db) => siteModules.createPublicBookingByToken(db, req.params.token, body));
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) { fail(res, e); }
});

module.exports = router;
