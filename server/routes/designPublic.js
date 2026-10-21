'use strict';

/**
 * Public (no session) design client form — answer questions / submit change requests.
 */

const express = require('express');
const domain = require('../domain');
const { requireCaptcha } = require('../captcha');
const { rateLimit } = require('../rateLimit');
const { assertWorkspaceExists } = require('../workspaceExists');

const router = express.Router();
const formLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });
const readLimit = rateLimit({ windowMs: 60 * 1000, max: 120 });
const captcha = requireCaptcha();

function fail(res, e, status = 400) {
  const http = e.code === 'NOT_FOUND' ? 404 : e.code === 'INVALID' ? 400 : status;
  res.status(http).json({ ok: false, error: e.message || String(e), code: e.code });
}

async function workspaceIdFrom(req) {
  const w = Number(
    (req.query && (req.query.w || req.query.workspaceId))
    || (req.body && (req.body.w || req.body.workspaceId))
  );
  if (!Number.isInteger(w) || w <= 0) {
    const err = new Error('workspace id (w) required');
    err.code = 'INVALID';
    throw err;
  }
  await assertWorkspaceExists(w);
  return w;
}

router.get('/form/:token', readLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceIdFrom(req);
    const data = domain.designClientFormGet(workspaceId, req.params.token);
    res.json({ ok: true, data });
  } catch (e) { fail(res, e); }
});

router.post('/form/:token', formLimit, captcha, async (req, res) => {
  try {
    const workspaceId = await workspaceIdFrom(req);
    const data = await domain.designClientFormSubmit(workspaceId, req.params.token, req.body || {});
    res.json({ ok: true, data });
  } catch (e) { fail(res, e, e.code === 'EMPTY' ? 400 : 500); }
});

module.exports = router;
