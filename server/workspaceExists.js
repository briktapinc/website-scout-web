'use strict';

/**
 * Verify a workspace id exists in MySQL/SQLite auth DB before opening per-tenant SQLite.
 * Cached with a size cap so public form endpoints cannot open arbitrary workspace files.
 */

const { query } = require('./db');

const CACHE_MAX = 2000;
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // id -> { ok: boolean, at: number }

function trimCache() {
  if (cache.size <= CACHE_MAX) return;
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.at > CACHE_TTL_MS) cache.delete(k);
  }
  while (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

async function workspaceExists(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ok;
  const rows = await query('SELECT id FROM workspaces WHERE id = :id LIMIT 1', { id });
  const ok = !!(rows && rows[0]);
  cache.set(id, { ok, at: Date.now() });
  trimCache();
  return ok;
}

async function assertWorkspaceExists(workspaceId) {
  const ok = await workspaceExists(workspaceId);
  if (!ok) {
    const err = new Error('Workspace not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return Number(workspaceId);
}

function clearWorkspaceExistsCache() {
  cache.clear();
}

module.exports = {
  workspaceExists,
  assertWorkspaceExists,
  clearWorkspaceExistsCache,
};
