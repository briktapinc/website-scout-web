'use strict';

/**
 * Public (no session) social endpoints: Meta OAuth callback + client weekly approval.
 */

const express = require('express');
const domain = require('../domain');
const social = require('../../src/socialMedia');
const { requireCaptcha } = require('../captcha');
const { rateLimit } = require('../rateLimit');
const { assertWorkspaceExists } = require('../workspaceExists');
const { socialReturnPath } = require('../appUrls');

const router = express.Router();
const approveLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });
const readLimit = rateLimit({ windowMs: 60 * 1000, max: 120 });
const captcha = requireCaptcha();

function fail(res, e, status = 400) {
  const http = e.code === 'NOT_FOUND' ? 404 : status;
  res.status(http).json({ ok: false, error: e.message || String(e), code: e.code });
}

router.get('/meta/callback', async (req, res) => {
  try {
    const { code, state, error, error_description: errDesc } = req.query || {};
    if (error) {
      return res.status(400).send(`Meta OAuth error: ${error}${errDesc ? ` — ${errDesc}` : ''}`);
    }
    if (!code || !state) return res.status(400).send('Missing code or state');

    // Peek workspace from signed state without DB
    const st = (() => {
      const crypto = require('crypto');
      const secret = process.env.SESSION_SECRET || process.env.META_TOKEN_SECRET || 'dev-change-me';
      const [body, sig] = String(state).split('.');
      const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
      const a = Buffer.from(sig || '');
      const b = Buffer.from(expect);
      if (!body || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        throw Object.assign(new Error('Invalid OAuth state'), { code: 'INVALID_STATE' });
      }
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    })();

    await assertWorkspaceExists(Number(st.w));
    const result = await domain.socialOauthCallback(Number(st.w), String(code), String(state));
    const qs = new URLSearchParams({
      leadId: String(result.leadId || st.l || ''),
      connected: '1',
      fb: String(result.facebook || 0),
      ig: String(result.instagram || 0),
    });
    // Honor returnTo from signed OAuth state (portal uses /portal?connected=1#/social).
    const rawReturn = String(result.returnTo || st.r || '').trim();
    const dest = socialReturnPath(rawReturn, qs);
    return res.redirect(dest);
  } catch (e) {
    console.error('[social oauth]', e);
    return res.status(400).send(`Could not connect Meta: ${e.message}`);
  }
});

router.get('/approve/:token', readLimit, async (req, res) => {
  try {
    const workspaceId = Number(req.query.w || req.query.workspaceId);
    if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
      return fail(res, Object.assign(new Error('workspace id (w) required'), { code: 'INVALID' }));
    }
    await assertWorkspaceExists(workspaceId);
    const data = domain.socialBatchByToken(workspaceId, req.params.token);
    res.json({ ok: true, data });
  } catch (e) { fail(res, e); }
});

router.post('/approve/:token', approveLimit, captcha, async (req, res) => {
  try {
    const workspaceId = Number((req.body && (req.body.w || req.body.workspaceId)) || req.query.w);
    if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
      return fail(res, Object.assign(new Error('workspace id (w) required'), { code: 'INVALID' }));
    }
    await assertWorkspaceExists(workspaceId);
    const data = domain.socialDecideBatch(workspaceId, req.params.token, req.body || {});
    res.json({ ok: true, data });
  } catch (e) { fail(res, e); }
});

// Peek helpers exported for tests
router._social = social;

module.exports = router;
