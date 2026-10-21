'use strict';

const bcrypt = require('bcryptjs');
const { query, withConnection, driver } = require('./db');
const platform = require('./platform');
const { createUserWithWorkspace, slugify } = require('./workspace');

async function isSuperAdmin(userId) {
  const rows = await query(
    'SELECT is_super_admin FROM users WHERE id = :id LIMIT 1',
    { id: Number(userId) }
  );
  return !!(rows[0] && Number(rows[0].is_super_admin) === 1);
}

async function setSuperAdmin(userId, on) {
  await query(
    'UPDATE users SET is_super_admin = :flag WHERE id = :id',
    { id: Number(userId), flag: on ? 1 : 0 }
  );
}

async function overview() {
  const one = async (sql) => {
    const rows = await query(sql);
    return rows && rows[0] ? Number(rows[0].c || 0) : 0;
  };
  return {
    users: await one('SELECT COUNT(*) AS c FROM users'),
    usersActive: await one("SELECT COUNT(*) AS c FROM users WHERE status = 'active' OR status IS NULL OR status = ''"),
    usersDisabled: await one("SELECT COUNT(*) AS c FROM users WHERE status = 'disabled'"),
    superAdmins: await one('SELECT COUNT(*) AS c FROM users WHERE is_super_admin = 1'),
    workspaces: await one('SELECT COUNT(*) AS c FROM workspaces'),
    mcpTokens: await one('SELECT COUNT(*) AS c FROM workspace_tokens'),
    scheduledJobs: await one('SELECT COUNT(*) AS c FROM scheduled_jobs'),
    registrationOpen: (await platform.getPlatformSetting('registration.open', '1')) === '1',
    maintenanceMode: (await platform.getPlatformSetting('maintenance_mode', '0')) === '1',
  };
}

function notDeletedClause(alias = 'u') {
  // MySQL DATETIME rejects '' comparisons; soft-delete uses NULL when active.
  return `${alias}.deleted_at IS NULL`;
}

async function listUsers({ q = '', limit = 100 } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const like = `%${String(q || '').trim()}%`;
  if (String(q || '').trim()) {
    return query(
      `SELECT u.id, u.email, u.name, u.is_super_admin, u.status, u.last_login_at, u.created_at,
              (SELECT COUNT(*) FROM workspace_members m WHERE m.user_id = u.id) AS workspace_count
       FROM users u
       WHERE ${notDeletedClause('u')}
         AND (u.email LIKE :like OR u.name LIKE :like)
       ORDER BY u.id DESC
       LIMIT ${lim}`,
      { like }
    );
  }
  return query(
    `SELECT u.id, u.email, u.name, u.is_super_admin, u.status, u.last_login_at, u.created_at,
            (SELECT COUNT(*) FROM workspace_members m WHERE m.user_id = u.id) AS workspace_count
     FROM users u
     WHERE ${notDeletedClause('u')}
     ORDER BY u.id DESC
     LIMIT ${lim}`
  );
}

async function getUser(id) {
  const rows = await query(
    `SELECT id, email, name, is_super_admin, status, last_login_at, created_at, updated_at, deleted_at
     FROM users WHERE id = :id LIMIT 1`,
    { id: Number(id) }
  );
  if (!rows[0] || rows[0].deleted_at) return null;
  const memberships = await query(
    `SELECT m.role, w.id AS workspace_id, w.name, w.slug
     FROM workspace_members m
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = :id
     ORDER BY w.name`,
    { id: Number(id) }
  );
  return { user: rows[0], memberships };
}

async function createUser({ email, password, name, workspaceName, superAdmin = false }) {
  const existing = await query(
    'SELECT id FROM users WHERE email = :email LIMIT 1',
    { email: String(email || '').trim().toLowerCase() }
  );
  if (existing[0]) {
    const e = new Error('EMAIL_IN_USE');
    e.code = 'EMAIL_IN_USE';
    throw e;
  }
  const created = await createUserWithWorkspace({
    email,
    password,
    name,
    workspaceName: workspaceName || undefined,
  });
  if (superAdmin) await setSuperAdmin(created.userId, true);
  return created;
}

/** Normalize status: UI "blocked" maps to DB status "disabled" (blocks sign-in). */
function normalizeStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'disabled' || s === 'blocked') return 'disabled';
  if (s === 'active' || s === 'enabled' || s === 'unblocked') return 'active';
  return null;
}

async function updateUser(id, patch = {}, { actorUserId = null } = {}) {
  const uid = Number(id);
  const actor = actorUserId != null ? Number(actorUserId) : null;
  const cur = await getUser(uid);
  if (!cur) {
    const e = new Error('NOT_FOUND');
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (patch.name != null) {
    await query('UPDATE users SET name = :name WHERE id = :id', {
      id: uid,
      name: String(patch.name).trim().slice(0, 120),
    });
  }
  if (patch.email != null) {
    const email = String(patch.email).trim().toLowerCase();
    if (!email || !email.includes('@')) {
      const e = new Error('Invalid email');
      e.code = 'INVALID_EMAIL';
      throw e;
    }
    const existing = await query(
      'SELECT id FROM users WHERE email = :email AND id != :id LIMIT 1',
      { email, id: uid }
    );
    if (existing[0]) {
      const e = new Error('EMAIL_IN_USE');
      e.code = 'EMAIL_IN_USE';
      throw e;
    }
    await query('UPDATE users SET email = :email WHERE id = :id', { id: uid, email });
  }
  if (patch.status != null) {
    const status = normalizeStatus(patch.status);
    if (!status) {
      const e = new Error('Invalid status');
      e.code = 'INVALID_STATUS';
      throw e;
    }
    if (status === 'disabled' && actor != null && actor === uid) {
      const e = new Error('Cannot block your own account');
      e.code = 'SELF_BLOCK';
      throw e;
    }
    if (status === 'disabled' && Number(cur.user.is_super_admin) === 1) {
      const admins = await query(
        `SELECT COUNT(*) AS c FROM users
         WHERE is_super_admin = 1 AND (status = 'active' OR status IS NULL OR status = '')
           AND deleted_at IS NULL`
      );
      if (Number(admins[0].c) <= 1) {
        const e = new Error('Cannot block the last active super admin');
        e.code = 'LAST_SUPER_ADMIN';
        throw e;
      }
    }
    await query('UPDATE users SET status = :status WHERE id = :id', { id: uid, status });
  }
  if (patch.is_super_admin != null || patch.superAdmin != null) {
    const on = !!(patch.is_super_admin != null ? patch.is_super_admin : patch.superAdmin);
    if (!on && actor != null && actor === uid) {
      const e = new Error('Cannot demote your own account');
      e.code = 'SELF_DEMOTE';
      throw e;
    }
    if (!on && Number(cur.user.is_super_admin) === 1) {
      const admins = await query(
        `SELECT COUNT(*) AS c FROM users
         WHERE is_super_admin = 1 AND deleted_at IS NULL`
      );
      if (Number(admins[0].c) <= 1) {
        const e = new Error('Cannot demote the last super admin');
        e.code = 'LAST_SUPER_ADMIN';
        throw e;
      }
    }
    await setSuperAdmin(uid, on);
  }
  if (patch.password) {
    if (String(patch.password).length < 8) {
      const e = new Error('password must be at least 8 characters');
      e.code = 'WEAK_PASSWORD';
      throw e;
    }
    const hash = await bcrypt.hash(String(patch.password), 12);
    await query('UPDATE users SET password_hash = :hash WHERE id = :id', { id: uid, hash });
  }
  return getUser(uid);
}

/**
 * Soft-delete a user (same pattern as billing.deleteAccount):
 * tombstone email, disable, set deleted_at, remove workspace memberships.
 * Workspaces are kept; sole-owned workspaces become ownerless (manage via Workspaces tab).
 */
async function deleteUser(id, { actorUserId = null } = {}) {
  const uid = Number(id);
  const actor = actorUserId != null ? Number(actorUserId) : null;
  if (actor != null && actor === uid) {
    const e = new Error('Cannot delete your own account from admin');
    e.code = 'SELF_DELETE';
    throw e;
  }
  const cur = await getUser(uid);
  if (!cur) {
    const e = new Error('NOT_FOUND');
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (Number(cur.user.is_super_admin) === 1) {
    const admins = await query(
      `SELECT COUNT(*) AS c FROM users
       WHERE is_super_admin = 1 AND (status = 'active' OR status IS NULL OR status = '')
         AND deleted_at IS NULL`
    );
    if (Number(admins[0].c) <= 1) {
      const e = new Error('Cannot delete the last super admin');
      e.code = 'LAST_SUPER_ADMIN';
      throw e;
    }
  }

  const soleOwned = await query(
    `SELECT m.workspace_id, w.name
     FROM workspace_members m
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = :id AND m.role = 'owner'
       AND NOT EXISTS (
         SELECT 1 FROM workspace_members m2
         WHERE m2.workspace_id = m.workspace_id AND m2.user_id != :id AND m2.role = 'owner'
       )`,
    { id: uid }
  );

  const tombstone = `deleted+${uid}@deleted.local`;
  await query(
    `UPDATE users SET
       status = 'disabled',
       email = :email,
       name = 'Deleted user',
       password_hash = :hash,
       deleted_at = ${driver() === 'sqlite' ? "datetime('now')" : 'CURRENT_TIMESTAMP'},
       is_super_admin = 0
     WHERE id = :id`,
    { email: tombstone, hash: '!', id: uid }
  );
  await query('DELETE FROM workspace_members WHERE user_id = :id', { id: uid });

  return {
    deleted: true,
    userId: uid,
    soleOwnedWorkspaces: (soleOwned || []).map((r) => ({
      id: r.workspace_id,
      name: r.name,
    })),
  };
}

async function listWorkspaces({ q = '', limit = 100 } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const like = `%${String(q || '').trim()}%`;
  if (String(q || '').trim()) {
    return query(
      `SELECT w.id, w.name, w.slug, w.created_at, w.updated_at,
              (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS member_count,
              (SELECT COUNT(*) FROM workspace_tokens t WHERE t.workspace_id = w.id) AS token_count
       FROM workspaces w
       WHERE w.name LIKE :like OR w.slug LIKE :like
       ORDER BY w.id DESC
       LIMIT ${lim}`,
      { like }
    );
  }
  return query(
    `SELECT w.id, w.name, w.slug, w.created_at, w.updated_at,
            (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS member_count,
            (SELECT COUNT(*) FROM workspace_tokens t WHERE t.workspace_id = w.id) AS token_count
     FROM workspaces w
     ORDER BY w.id DESC
     LIMIT ${lim}`
  );
}

async function getWorkspace(id) {
  const wid = Number(id);
  const rows = await query(
    'SELECT id, name, slug, created_at, updated_at FROM workspaces WHERE id = :id LIMIT 1',
    { id: wid }
  );
  if (!rows[0]) return null;
  const members = await query(
    `SELECT m.role, m.created_at, u.id AS user_id, u.email, u.name, u.status
     FROM workspace_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = :id
     ORDER BY m.role, u.email`,
    { id: wid }
  );
  return { workspace: rows[0], members };
}

async function createWorkspace({ name, ownerUserId }) {
  const wsName = String(name || 'Workspace').trim().slice(0, 160);
  const slug = slugify(wsName);
  return withConnection(async (conn) => {
    await conn.beginTransaction();
    try {
      const [wsRes] = await conn.execute(
        'INSERT INTO workspaces (name, slug) VALUES (?, ?)',
        [wsName, slug]
      );
      const workspaceId = wsRes.insertId;
      const { seedWorkspaceDefaults } = require('./workspace');
      await seedWorkspaceDefaults(conn, workspaceId);
      if (ownerUserId) {
        await conn.execute(
          'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
          [workspaceId, Number(ownerUserId), 'owner']
        );
      }
      await conn.commit();
      return { workspaceId, slug };
    } catch (e) {
      await conn.rollback();
      throw e;
    }
  });
}

async function updateWorkspace(id, patch = {}) {
  const wid = Number(id);
  if (patch.name != null) {
    await query('UPDATE workspaces SET name = :name WHERE id = :id', {
      id: wid,
      name: String(patch.name).trim().slice(0, 160),
    });
  }
  return getWorkspace(wid);
}

async function deleteWorkspace(id) {
  const wid = Number(id);
  await query('DELETE FROM workspaces WHERE id = :id', { id: wid });
  // Per-workspace SQLite file can remain on disk; best-effort remove
  try {
    const fs = require('fs');
    const path = require('path');
    const { dbPathFor } = require('./workspaceDb');
    const file = dbPathFor(wid);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const dir = path.dirname(file);
    if (fs.existsSync(dir)) fs.rmdirSync(dir, { recursive: true });
  } catch { /* ignore */ }
  return { deleted: wid };
}

async function addMember(workspaceId, userId, role = 'member') {
  const r = ['owner', 'admin', 'member'].includes(role) ? role : 'member';
  const wid = Number(workspaceId);
  const uid = Number(userId);
  await query(
    'DELETE FROM workspace_members WHERE workspace_id = :workspaceId AND user_id = :userId',
    { workspaceId: wid, userId: uid }
  );
  await query(
    'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (:workspaceId, :userId, :role)',
    { workspaceId: wid, userId: uid, role: r }
  );
  return getWorkspace(workspaceId);
}

async function removeMember(workspaceId, userId) {
  await query(
    'DELETE FROM workspace_members WHERE workspace_id = :workspaceId AND user_id = :userId',
    { workspaceId: Number(workspaceId), userId: Number(userId) }
  );
  return getWorkspace(workspaceId);
}

/** Push platform defaults into every workspace (MySQL settings + SQLite when present). */
async function pushDefaultsToWorkspaces({ force = false, keys = null } = {}) {
  const seed = await platform.workspaceSeedFromPlatform();
  const useKeys = Array.isArray(keys) && keys.length
    ? keys.filter((k) => seed[k] != null)
    : Object.keys(seed);
  const workspaces = await query('SELECT id FROM workspaces');
  let updated = 0;
  for (const w of workspaces) {
    for (const key of useKeys) {
      const value = seed[key];
      if (value == null || value === '') continue;
      if (!force) {
        const rows = await query(
          'SELECT value FROM workspace_settings WHERE workspace_id = :workspaceId AND `key` = :key LIMIT 1',
          { workspaceId: w.id, key }
        );
        if (rows[0] && String(rows[0].value || '').trim() !== '') continue;
      }
      await query(
        `INSERT INTO workspace_settings (workspace_id, \`key\`, value)
         VALUES (:workspaceId, :key, :value)
         ON DUPLICATE KEY UPDATE value = VALUES(value)`,
        { workspaceId: w.id, key, value }
      );
      updated++;
    }
    // Sync into per-workspace SQLite if already initialized
    try {
      const { openWorkspaceDb } = require('./workspaceDb');
      const db = openWorkspaceDb(w.id);
      for (const key of useKeys) {
        const value = seed[key];
        if (value == null || value === '') continue;
        if (!force) {
          const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
          if (row && String(row.value || '').trim() !== '') continue;
        }
        db.prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        ).run(key, value);
      }
    } catch { /* workspace sqlite optional */ }
  }
  return { workspaces: workspaces.length, keys: useKeys.length, cellsUpdated: updated, force: !!force };
}

async function touchLogin(userId) {
  try {
    await query(
      driver() === 'sqlite'
        ? "UPDATE users SET last_login_at = datetime('now') WHERE id = :id"
        : 'UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = :id',
      { id: Number(userId) }
    );
  } catch { /* ignore */ }
}

module.exports = {
  isSuperAdmin,
  setSuperAdmin,
  overview,
  listUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  listWorkspaces,
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  addMember,
  removeMember,
  pushDefaultsToWorkspaces,
  touchLogin,
};
