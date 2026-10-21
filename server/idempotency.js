'use strict';

/**
 * Shared idempotency store for REST /api/v1 and MCP.
 * Same key + same body within 24h returns the original result on either surface.
 */

const crypto = require('crypto');

const TTL_HOURS = 24;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const WAIT_MS = 5000;

function fail(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_idempotency (
      key_hash TEXT NOT NULL,
      operation TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      status INTEGER NOT NULL DEFAULT 200,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (key_hash, operation)
    );
    CREATE INDEX IF NOT EXISTS idx_api_idempotency_created ON api_idempotency(created_at);
    CREATE TABLE IF NOT EXISTS api_idempotency_claims (
      key_hash TEXT NOT NULL,
      operation TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'processing',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (key_hash, operation)
    );
  `);
}

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key || '')).digest('hex');
}

function hashBody(body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body == null ? null : body);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function purgeExpired(db) {
  db.prepare(`
    DELETE FROM api_idempotency
    WHERE created_at < datetime('now', ?)
  `).run(`-${TTL_HOURS} hours`);
  // Uncertain/failed operations require reconciliation; never automatically rerun them.
  db.prepare(`DELETE FROM api_idempotency_claims
    WHERE state = 'completed' AND created_at < datetime('now', ?)`
  ).run(`-${TTL_HOURS} hours`);
}

/**
 * Look up a prior result. Returns null if miss.
 * Throws CONFLICT if same key was used with a different body.
 */
function lookup(db, operation, key, body) {
  if (!key) return null;
  ensureTable(db);
  purgeExpired(db);
  const keyHash = hashKey(key);
  const bodyHash = hashBody(body);
  const row = db.prepare(
    'SELECT body_hash, status, response_json FROM api_idempotency WHERE key_hash = ? AND operation = ?'
  ).get(keyHash, String(operation));
  if (!row) return null;
  if (row.body_hash !== bodyHash) {
    throw fail(
      'IDEMPOTENCY_CONFLICT',
      'Idempotency-Key was already used with a different request body',
      409
    );
  }
  let data = null;
  try { data = JSON.parse(row.response_json); } catch {
    throw fail('IDEMPOTENCY_CORRUPT', 'Saved result is unreadable; reconcile the original operation before retrying', 409);
  }
  return { status: row.status, data, replayed: true };
}

function store(db, operation, key, body, status, data) {
  if (!key) return;
  ensureTable(db);
  const json = JSON.stringify(data == null ? null : data);
  if (Buffer.byteLength(json, 'utf8') > MAX_RECEIPT_BYTES) {
    throw fail('IDEMPOTENCY_RECEIPT_TOO_LARGE', 'Operation result exceeds the replay limit; reconcile the original operation before retrying', 409);
  }
  // Never replace another request's receipt or truncate JSON.
  db.prepare(`
    INSERT INTO api_idempotency (key_hash, operation, body_hash, status, response_json, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(hashKey(key), String(operation), hashBody(body), Number(status) || 200, json);
}

function claimState(db, operation, key, body) {
  const row = db.prepare('SELECT body_hash, state FROM api_idempotency_claims WHERE key_hash = ? AND operation = ?')
    .get(hashKey(key), String(operation));
  if (row && row.body_hash !== hashBody(body)) {
    throw fail('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request body', 409);
  }
  return row;
}

/**
 * Persist an atomic claim before starting work. Other callers wait briefly for its receipt.
 * A crash or uncertain failure never releases a claim automatically: retry the same key to
 * recover its receipt, or reconcile the original side effect before taking further action.
 */
async function once(db, operation, key, body, fn) {
  if (!key) return fn();
  ensureTable(db);
  const claimed = db.transaction(() => {
    const hit = lookup(db, operation, key, body);
    if (hit) return { hit };
    const existing = claimState(db, operation, key, body);
    if (existing) return { existing };
    db.prepare(`INSERT INTO api_idempotency_claims (key_hash, operation, body_hash) VALUES (?, ?, ?)`)
      .run(hashKey(key), String(operation), hashBody(body));
    return { owner: true };
  }).immediate();
  if (claimed.hit) return claimed.hit.data;
  if (!claimed.owner) {
    const deadline = Date.now() + WAIT_MS;
    while (true) {
      const hit = lookup(db, operation, key, body);
      if (hit) return hit.data;
      const row = claimState(db, operation, key, body);
      if (row && row.state === 'failed') {
        throw fail('IDEMPOTENCY_FAILED', 'Previous attempt failed or its result could not be saved; reconcile the original operation before retrying', 409);
      }
      if (Date.now() >= deadline) {
        throw fail('IDEMPOTENCY_IN_PROGRESS', 'Operation is in progress or needs reconciliation after interruption; retry the same key to retrieve its result', 409);
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  try {
    const data = await fn();
    db.transaction(() => {
      store(db, operation, key, body, 200, data);
      db.prepare("UPDATE api_idempotency_claims SET state = 'completed' WHERE key_hash = ? AND operation = ?")
        .run(hashKey(key), String(operation));
    }).immediate();
    return data;
  } catch (error) {
    try {
      db.prepare("UPDATE api_idempotency_claims SET state = 'failed' WHERE key_hash = ? AND operation = ?")
        .run(hashKey(key), String(operation));
    } catch { /* Persistent processing claim still blocks duplicate work. */ }
    throw error;
  }
}

function extractKey(req) {
  if (!req || !req.headers) return null;
  const h = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];
  if (h == null || h === '') return null;
  const s = String(h).trim().slice(0, 256);
  return s || null;
}

module.exports = {
  ensureTable,
  lookup,
  store,
  once,
  extractKey,
  hashBody,
  TTL_HOURS,
  MAX_RECEIPT_BYTES,
};
