'use strict';

/**
 * Public chatbot API for visitor widget (token: `{workspaceId}_{random}`).
 * No session cookies / no workspace admin tokens — public only.
 */

const express = require('express');
const domain = require('../domain');
const chatbot = require('../chatbot');
const siteModules = require('../siteModules');
const { rateLimit } = require('../rateLimit');
const { assertWorkspaceExists } = require('../workspaceExists');

const router = express.Router();
const readLimit = rateLimit({ windowMs: 60 * 1000, max: 180 });
const writeLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 80 });

function fail(res, e, status = 400) {
  const http = e.code === 'NOT_FOUND' ? 404
    : e.code === 'FORBIDDEN' ? 403
    : e.code === 'VALIDATION' ? 400
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
    const err = new Error('Could not resolve workspace for this chatbot');
    err.code = 'INVALID';
    throw err;
  }
  await assertWorkspaceExists(workspaceId);
  return workspaceId;
}

router.get('/:token', readLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const data = domain.withDb(workspaceId, (db) => chatbot.getPublicConfigByToken(db, req.params.token));
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) { fail(res, e); }
});

router.post('/:token/session', writeLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const body = req.body || {};
    const data = domain.withDb(workspaceId, (db) => {
      const cfg = chatbot.getPublicConfigByToken(db, req.params.token);
      const row = chatbot.startOrGetSession(db, cfg.embed.lead_id, {
        sessionToken: body.session || body.sessionToken || null,
        visitor: body.visitor || null,
      });
      return { session: chatbot.publicSession(row), settings: cfg.settings };
    });
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) { fail(res, e); }
});

router.post('/:token/message', writeLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const body = req.body || {};
    const message = body.message || body.text || body.body;
    if (!message || !String(message).trim()) {
      const err = new Error('message is required');
      err.code = 'VALIDATION';
      throw err;
    }
    const data = domain.withDb(workspaceId, (db) => chatbot.postVisitorMessage(db, req.params.token, {
      sessionToken: body.session || body.sessionToken,
      message,
      visitor: body.visitor || null,
      workspaceId,
    }));
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) { fail(res, e); }
});

router.get('/:token/messages', readLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const sessionToken = req.query.session || req.query.sessionToken;
    if (!sessionToken) {
      const err = new Error('session is required');
      err.code = 'VALIDATION';
      throw err;
    }
    const data = domain.withDb(workspaceId, (db) => chatbot.getSessionHistory(db, req.params.token, {
      sessionToken,
      afterId: req.query.after || req.query.afterId || 0,
    }));
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) { fail(res, e); }
});

router.post('/:token/lead', writeLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const data = domain.withDb(workspaceId, (db) => chatbot.captureLead(db, req.params.token, req.body || {}));
    const notifyPayload = data && data._notify;
    if (data && data._notify) delete data._notify;
    res.json({ ok: true, data: { ...data, workspaceId } });
    if (notifyPayload) {
      chatbot.notifyOwnerOnChatLead(workspaceId, notifyPayload).catch((err) => {
        console.warn('[chatbotPublic] lead notify failed:', err && err.message ? err.message : err);
      });
    }
  } catch (e) { fail(res, e); }
});

router.get('/:token/actions', readLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const data = domain.withDb(workspaceId, (db) => {
      const cfg = chatbot.getPublicConfigByToken(db, req.params.token);
      return {
        allowed_actions: cfg.allowed_actions,
        agent_path: cfg.agent_path,
        boundary: 'portal_client_mcp_only',
      };
    });
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) { fail(res, e); }
});

module.exports = router;
