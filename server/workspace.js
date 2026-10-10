'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, withConnection } = require('./db');
const { SETTING_SEEDS, PROMPT_SEEDS } = require('./settingsKeys');

function slugify(name) {
  const base = String(name || 'workspace')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'workspace';
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

async function seedWorkspaceDefaults(conn, workspaceId) {
  // Start from product seeds, then overlay platform defaults (super-admin).
  const merged = new Map(SETTING_SEEDS);
  try {
    const platform = require('./platform');
    const fromPlatform = await platform.workspaceSeedFromPlatform();
    for (const [k, v] of Object.entries(fromPlatform)) merged.set(k, v);
  } catch { /* platform optional during early migrate */ }

  for (const [key, value] of merged) {
    await conn.execute(
      'INSERT IGNORE INTO workspace_settings (workspace_id, `key`, value) VALUES (?, ?, ?)',
      [workspaceId, key, value]
    );
  }
  for (const p of PROMPT_SEEDS) {
    await conn.execute(
      'INSERT IGNORE INTO prompts (workspace_id, `key`, name, body) VALUES (?, ?, ?, ?)',
      [workspaceId, p.key, p.name, p.body]
    );
  }
}

async function createUserWithWorkspace({ email, password, name, workspaceName }) {
  const hash = await bcrypt.hash(String(password), 12);
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(name || '').trim() || cleanEmail.split('@')[0];
  const wsName = String(workspaceName || `${cleanName}'s workspace`).trim();

  return withConnection(async (conn) => {
    await conn.beginTransaction();
    try {
      const [userRes] = await conn.execute(
        'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)',
        [cleanEmail, hash, cleanName]
      );
      const userId = userRes.insertId;
      const slug = slugify(wsName);
      const [wsRes] = await conn.execute(
        'INSERT INTO workspaces (name, slug) VALUES (?, ?)',
        [wsName, slug]
      );
      const workspaceId = wsRes.insertId;
      await conn.execute(
        'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
        [workspaceId, userId, 'owner']
      );
      await seedWorkspaceDefaults(conn, workspaceId);
      await conn.commit();
      return { userId, workspaceId, slug };
    } catch (e) {
      await conn.rollback();
      throw e;
    }
  });
}

async function findUserByEmail(email) {
  const rows = await query(
    `SELECT id, email, password_hash, name, is_super_admin, status, last_login_at, created_at
     FROM users WHERE email = :email LIMIT 1`,
    { email: String(email || '').trim().toLowerCase() }
  );
  return rows[0] || null;
}

async function listWorkspacesForUser(userId) {
  return query(
    `SELECT w.id, w.name, w.slug, m.role
     FROM workspace_members m
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = :userId
     ORDER BY w.name`,
    { userId }
  );
}

async function getMembership(userId, workspaceId) {
  const rows = await query(
    `SELECT m.role, w.id, w.name, w.slug
     FROM workspace_members m
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = :userId AND m.workspace_id = :workspaceId
     LIMIT 1`,
    { userId, workspaceId }
  );
  return rows[0] || null;
}

async function getSetting(workspaceId, key, fallback = '') {
  const rows = await query(
    'SELECT value FROM workspace_settings WHERE workspace_id = :workspaceId AND `key` = :key LIMIT 1',
    { workspaceId, key }
  );
  return rows[0] ? rows[0].value : fallback;
}

async function setSetting(workspaceId, key, value) {
  await query(
    `INSERT INTO workspace_settings (workspace_id, \`key\`, value)
     VALUES (:workspaceId, :key, :value)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    { workspaceId, key, value: value == null ? '' : String(value) }
  );
}

async function logActivity(workspaceId, area, message) {
  await query(
    'INSERT INTO activity_log (workspace_id, area, message) VALUES (:workspaceId, :area, :message)',
    { workspaceId, area, message }
  );
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function createWorkspaceToken(workspaceId, name = 'MCP') {
  const raw = `ws_${crypto.randomBytes(24).toString('hex')}`;
  const tokenHash = hashToken(raw);
  const prefix = raw.slice(0, 10);
  await query(
    `INSERT INTO workspace_tokens (workspace_id, name, token_hash, token_prefix)
     VALUES (:workspaceId, :name, :tokenHash, :prefix)`,
    { workspaceId, name, tokenHash, prefix }
  );
  return { token: raw, prefix };
}

async function findWorkspaceByToken(rawToken) {
  const tokenHash = hashToken(rawToken);
  const rows = await query(
    `SELECT t.id AS token_id, t.workspace_id, w.name, w.slug
     FROM workspace_tokens t
     JOIN workspaces w ON w.id = t.workspace_id
     WHERE t.token_hash = :tokenHash
     LIMIT 1`,
    { tokenHash }
  );
  if (!rows[0]) return null;
  await query(
    'UPDATE workspace_tokens SET last_used_at = UTC_TIMESTAMP() WHERE id = :id',
    { id: rows[0].token_id }
  );
  return rows[0];
}

module.exports = {
  createUserWithWorkspace,
  findUserByEmail,
  listWorkspacesForUser,
  getMembership,
  getSetting,
  setSetting,
  logActivity,
  createWorkspaceToken,
  findWorkspaceByToken,
  seedWorkspaceDefaults,
  hashToken,
  slugify,
};
