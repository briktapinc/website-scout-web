'use strict';

/**
 * Public contact form schema + submit (Turnstile captcha).
 * Token format: `{workspaceId}_{random}` (see contactForms.makePublicToken).
 */

const express = require('express');
const domain = require('../domain');
const contactForms = require('../contactForms');
const billing = require('../billing');
const { requireCaptcha, clientIp, getCaptchaConfig } = require('../captcha');
const { rateLimit } = require('../rateLimit');
const { assertWorkspaceExists } = require('../workspaceExists');

const router = express.Router();
const submitLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
const readLimit = rateLimit({ windowMs: 60 * 1000, max: 120 });
const captcha = requireCaptcha();

function fail(res, e, status = 400) {
  const http = e.code === 'NOT_FOUND' ? 404
    : e.code === 'EMAIL_FAILED' ? 502
    : e.code === 'VALIDATION' ? 400
    : (typeof e.status === 'number' ? e.status : status);
  const msg = http >= 500 ? 'Server error' : (e.message || String(e));
  res.status(http).json({ ok: false, error: msg, code: e.code });
}

async function workspaceFromReq(req) {
  const fromToken = contactForms.parseWorkspaceFromToken(req.params.token);
  const fromQuery = Number(
    (req.query && (req.query.w || req.query.workspaceId))
    || (req.body && (req.body.w || req.body.workspaceId))
  );
  const workspaceId = fromToken || fromQuery;
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
    const err = new Error('Could not resolve workspace for this form');
    err.code = 'INVALID';
    throw err;
  }
  // Refuse to create SQLite files for arbitrary positive integers.
  await assertWorkspaceExists(workspaceId);
  return workspaceId;
}

router.get('/:token', readLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const data = domain.withDb(workspaceId, (db) => contactForms.getPublicFormByToken(db, req.params.token));
    const captchaCfg = await getCaptchaConfig();
    res.json({
      ok: true,
      data: {
        ...data,
        workspaceId,
        captcha: captchaCfg,
      },
    });
  } catch (e) { fail(res, e); }
});

router.post('/:token/submit', submitLimit, captcha, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const planId = await billing.workspacePlan(workspaceId);
    const values = (req.body && req.body.values)
      || (req.body && typeof req.body === 'object'
        ? Object.fromEntries(
          Object.entries(req.body).filter(([k]) => !['w', 'workspaceId', 'captchaToken', 'cf-turnstile-response', 'values'].includes(k))
        )
        : {});
    const data = await domain.withDb(workspaceId, (db) => contactForms.acceptSubmission(db, {
      token: req.params.token,
      values,
      workspaceId,
      planId,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    }));
    res.json({ ok: true, data });
  } catch (e) { fail(res, e); }
});

module.exports = router;
