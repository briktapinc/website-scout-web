'use strict';

const express = require('express');
const { query } = require('../db');
const { createWorkspaceToken } = require('../workspace');
const { toolDefs, SERVER_INFO, PROTOCOL_VERSION } = require('../mcp');
const { requireWorkspace, requireRole } = require('../middleware');

const router = express.Router();
router.use(requireWorkspace);

function catalogFromDefs() {
  const catalog = toolDefs().map((t) => ({
    name: t.name,
    description: t.description || '',
  }));
  const groups = {};
  for (const t of catalog) {
    const key = t.name.includes('.') ? t.name.split('.')[0] : 'other';
    if (!groups[key]) groups[key] = [];
    groups[key].push(t.name);
  }
  return { catalog, groups, toolNames: catalog.map((t) => t.name) };
}

router.get('/status', async (req, res, next) => {
  try {
    const tokens = await query(
      `SELECT id, name, token_prefix, last_used_at, created_at
       FROM workspace_tokens WHERE workspace_id = :workspaceId ORDER BY id DESC`,
      { workspaceId: req.auth.workspaceId }
    );
    const { catalog, groups, toolNames } = catalogFromDefs();
    res.json({
      ok: true,
      data: {
        server: SERVER_INFO,
        protocolVersion: PROTOCOL_VERSION,
        endpoint: '/mcp',
        transport: 'streamable-http',
        auth: 'Bearer workspace token',
        tools: toolNames,
        catalog,
        groups,
        toolCount: toolNames.length,
        tokens,
      },
    });
  } catch (e) {
    next(e);
  }
});

router.post('/token', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const name = (req.body && req.body.name) || 'MCP';
    const created = await createWorkspaceToken(req.auth.workspaceId, name);
    res.json({
      ok: true,
      data: {
        token: created.token,
        prefix: created.prefix,
        hint: 'Copy now — the full token is shown only once.',
      },
    });
  } catch (e) {
    next(e);
  }
});

router.delete('/token/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const result = await query(
      'DELETE FROM workspace_tokens WHERE id = :id AND workspace_id = :workspaceId',
      { id: Number(req.params.id), workspaceId: req.auth.workspaceId }
    );
    if (!result.affectedRows) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    res.json({ ok: true, data: { id: Number(req.params.id) } });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
