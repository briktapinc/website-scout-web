'use strict';

const express = require('express');
const invites = require('../invites');
const { requireWorkspace, requireRole, requireSubscription } = require('../middleware');

const router = express.Router();
router.use(requireWorkspace, requireSubscription, requireRole('owner', 'admin'));

function ok(res, data) { res.json({ ok: true, data }); }
function fail(res, e, status = 400) {
  res.status(e.code === 'NOT_FOUND' ? 404 : status).json({ ok: false, error: e.message || String(e), code: e.code });
}

router.get('/', async (req, res) => {
  try { ok(res, { invites: await invites.listInvites(req.auth.workspaceId) }); }
  catch (e) { fail(res, e, 500); }
});

router.post('/', async (req, res) => {
  try {
    const data = await invites.createInvite({
      workspaceId: req.auth.workspaceId,
      email: req.body && req.body.email,
      role: (req.body && req.body.role) || 'member',
      invitedBy: req.auth.userId || req.session.userId,
    });
    ok(res, data);
  } catch (e) { fail(res, e); }
});

module.exports = router;
