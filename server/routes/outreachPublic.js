'use strict';

/**
 * Public (no session) outreach response links from email merge vars
 * {{interested}} / {{uninterested}}, plus claim Yes/No page API.
 * Tokens are HMAC-signed in src/outreach.js.
 */

const express = require('express');
const domain = require('../domain');
const { rateLimit } = require('../rateLimit');

const router = express.Router();
const clickLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 120 });

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page({ title, heading, body, tone }) {
  const accent = tone === 'ok' ? '#0b5442' : tone === 'warn' ? '#6b5a3e' : '#333';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>${esc(title)}</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: Georgia, "Times New Roman", serif;
      background: linear-gradient(165deg, #f3f7f5 0%, #e4ece8 45%, #d7e3dc 100%);
      color: #1a2420;
    }
    main {
      width: min(32rem, calc(100% - 2rem));
      padding: 2rem 1.75rem;
      background: rgba(255,255,255,0.88);
      border: 1px solid rgba(11,84,66,0.12);
      box-shadow: 0 12px 40px rgba(20,40,30,0.08);
    }
    .brand { font-size: 0.8rem; letter-spacing: 0.12em; text-transform: uppercase; color: #0b5442; margin: 0 0 1rem; }
    h1 { font-size: 1.55rem; line-height: 1.25; margin: 0 0 0.75rem; color: ${accent}; font-weight: 600; }
    p { margin: 0; line-height: 1.55; font-size: 1.05rem; color: #33443d; }
  </style>
</head>
<body>
  <main>
    <p class="brand">Bitpype</p>
    <h1>${esc(heading)}</h1>
    <p>${body}</p>
  </main>
</body>
</html>`;
}

function jsonOk(res, data) {
  return res.status(200).json({ ok: true, data });
}

function jsonFail(res, e) {
  const code = e && e.code;
  const status = code === 'NOT_FOUND' ? 404
    : code === 'INVALID_TOKEN' || code === 'MISCONFIGURED' ? 400
      : 400;
  return res.status(status).json({ ok: false, error: (e && e.message) || 'Request failed', code: code || undefined });
}

router.get('/response/:token', clickLimit, (req, res) => {
  try {
    const result = domain.outreachInterestResponse(req.params.token);
    if (result.action === 'interested') {
      const name = result.businessName ? ` for ${esc(result.businessName)}` : '';
      return res.status(200).type('html').send(page({
        title: 'Thanks — Bitpype',
        heading: 'Thank you!',
        tone: 'ok',
        body: `We received your interest${name}. Someone from Bitpype will be reaching out soon to complete the project.`,
      }));
    }
    return res.status(200).type('html').send(page({
      title: 'Preference saved — Bitpype',
      heading: 'Got it',
      tone: 'warn',
      body: 'Thanks for letting us know. We have marked you as not interested and will not follow up about this project.',
    }));
  } catch (e) {
    const code = e && e.code;
    const status = code === 'NOT_FOUND' ? 404 : code === 'INVALID_TOKEN' ? 400 : 400;
    return res.status(status).type('html').send(page({
      title: 'Link problem — Bitpype',
      heading: 'This link is not valid',
      tone: 'warn',
      body: 'The response link may be incomplete or no longer valid. If you still want to reach us, reply to the original email.',
    }));
  }
});

/** Claim page meta for /claim.html (HMAC claim token). */
router.get('/claim/:token', clickLimit, (req, res) => {
  try {
    return jsonOk(res, domain.outreachClaimMeta(req.params.token));
  } catch (e) {
    return jsonFail(res, e);
  }
});

/** Apply Yes / No / Later from claim page or preview popup. */
router.post('/claim/:token', clickLimit, express.json({ limit: '8kb' }), (req, res) => {
  try {
    const action = req.body && req.body.action;
    return jsonOk(res, domain.outreachClaimDecide(req.params.token, action));
  } catch (e) {
    return jsonFail(res, e);
  }
});

module.exports = router;
