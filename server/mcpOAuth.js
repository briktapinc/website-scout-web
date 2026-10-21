'use strict';

/**
 * Minimal MCP OAuth 2.1 (authorization code + PKCE S256) for Claude.ai / Claude Code.
 * Issues lead-scoped portal MCP Bearer tokens (cl_*) — not staff workspace tokens.
 *
 * Auth codes, refresh tokens, and DCR clients are persisted in MySQL/SQLite with TTL
 * so deploy/restart does not drop in-flight OAuth. Access tokens (cl_*) stay in
 * workspace_tokens as before.
 */

const crypto = require('crypto');
const { query } = require('./db');
const { hashToken } = require('./workspace');
const portal = require('./clientPortal');

const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL_SEC = 90 * 24 * 60 * 60; // 90 days
const REFRESH_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const CLIENT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const SCOPE = 'mcp';
const STATIC_CLIENT_ID = 'website-scout';

const CLAUDE_HOSTED_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const LOOPBACK_PATHS = new Set(['/callback', '/']);

let _tablesReady = false;
let _lastPruneAt = 0;
const PRUNE_EVERY_MS = 60 * 1000;

function appBaseUrl() {
  const raw = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (raw) return raw;
  return 'http://127.0.0.1:3000';
}

function mcpResourceUrl() {
  return `${appBaseUrl()}/mcp`;
}

function issuerUrl() {
  return appBaseUrl();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

function randomToken(bytes = 32) {
  return b64url(crypto.randomBytes(bytes));
}

function extraRedirectUris() {
  return String(process.env.MCP_OAUTH_REDIRECT_URIS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function staticClient() {
  return {
    client_id: STATIC_CLIENT_ID,
    client_name: 'Website Scout / BitPype MCP',
    redirect_uris: [CLAUDE_HOSTED_REDIRECT, ...extraRedirectUris()],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    static: true,
  };
}

function affected(result) {
  if (!result || Array.isArray(result)) return 0;
  return Number(result.affectedRows || result.changes || 0);
}

async function ensureOAuthTables() {
  if (_tablesReady) return;
  const driver = String(process.env.DB_DRIVER || 'mysql').toLowerCase();
  if (driver === 'sqlite') {
    await query(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_auth_codes (
        code TEXT NOT NULL PRIMARY KEY,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
        token_hash TEXT NOT NULL PRIMARY KEY,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
        client_id TEXT NOT NULL PRIMARY KEY,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    await query('CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_exp ON mcp_oauth_auth_codes(expires_at)');
    await query('CREATE INDEX IF NOT EXISTS idx_mcp_oauth_refresh_exp ON mcp_oauth_refresh_tokens(expires_at)');
    await query('CREATE INDEX IF NOT EXISTS idx_mcp_oauth_clients_exp ON mcp_oauth_clients(expires_at)');
  } else {
    await query(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_auth_codes (
        code VARCHAR(128) NOT NULL PRIMARY KEY,
        payload_json MEDIUMTEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        KEY idx_mcp_oauth_codes_exp (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
        token_hash VARCHAR(128) NOT NULL PRIMARY KEY,
        payload_json MEDIUMTEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        KEY idx_mcp_oauth_refresh_exp (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
        client_id VARCHAR(128) NOT NULL PRIMARY KEY,
        payload_json MEDIUMTEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        KEY idx_mcp_oauth_clients_exp (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }
  _tablesReady = true;
}

async function pruneExpired() {
  const now = Date.now();
  if (now - _lastPruneAt < PRUNE_EVERY_MS) return;
  _lastPruneAt = now;
  try {
    await ensureOAuthTables();
    await query('DELETE FROM mcp_oauth_auth_codes WHERE expires_at <= :now', { now });
    await query('DELETE FROM mcp_oauth_refresh_tokens WHERE expires_at <= :now', { now });
    await query('DELETE FROM mcp_oauth_clients WHERE expires_at <= :now', { now });
  } catch (e) {
    try {
      process.stderr.write(`[mcp-oauth] prune failed: ${e && e.message}\n`);
    } catch { /* ignore */ }
  }
}

async function getClient(clientId) {
  const id = String(clientId || '');
  if (!id) return null;
  if (id === STATIC_CLIENT_ID) return staticClient();
  await ensureOAuthTables();
  await pruneExpired();
  const rows = await query(
    'SELECT payload_json, expires_at FROM mcp_oauth_clients WHERE client_id = :id LIMIT 1',
    { id }
  );
  const row = rows && rows[0];
  if (!row) return null;
  if (Number(row.expires_at) <= Date.now()) {
    await query('DELETE FROM mcp_oauth_clients WHERE client_id = :id', { id });
    return null;
  }
  try {
    return JSON.parse(row.payload_json);
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

/**
 * Exact match, plus RFC 8252 port-agnostic match for localhost / 127.0.0.1 callbacks.
 */
function redirectUriAllowed(client, redirectUri) {
  const requested = String(redirectUri || '');
  if (!requested) return false;
  const allowed = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
  if (allowed.includes(requested)) return true;

  let reqUrl;
  try {
    reqUrl = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopbackHost(reqUrl.hostname)) return false;
  if (reqUrl.protocol !== 'http:') return false;
  const reqPath = reqUrl.pathname || '/';
  if (!LOOPBACK_PATHS.has(reqPath) && reqPath !== '/callback') return false;

  for (const uri of allowed) {
    let reg;
    try {
      reg = new URL(uri);
    } catch {
      continue;
    }
    if (!isLoopbackHost(reg.hostname)) continue;
    if (reg.protocol !== 'http:') continue;
    const regPath = reg.pathname || '/';
    if (regPath === reqPath || (LOOPBACK_PATHS.has(regPath) && LOOPBACK_PATHS.has(reqPath))) {
      return true;
    }
  }

  // Claude Code CIMD declares http://localhost/callback and http://127.0.0.1/callback
  // without a port — accept any port for those paths even if not listed on static client.
  if (client.client_id === STATIC_CLIENT_ID || client.allow_loopback) {
    if (reqPath === '/callback') return true;
  }
  return false;
}

function protectedResourceMetadata() {
  const base = issuerUrl();
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
  };
}

function authorizationServerMetadata() {
  const base = issuerUrl();
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    scopes_supported: [SCOPE, 'offline_access'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    service_documentation: `${base}/portal#/mcp`,
  };
}

function wwwAuthenticateHeader() {
  const meta = `${issuerUrl()}/.well-known/oauth-protected-resource/mcp`;
  return `Bearer realm="mcp", resource_metadata="${meta}", scope="${SCOPE}"`;
}

async function validateAuthorizeParams(q) {
  const responseType = String(q.response_type || '');
  const clientId = String(q.client_id || '');
  const redirectUri = String(q.redirect_uri || '');
  const state = q.state != null ? String(q.state) : '';
  const codeChallenge = String(q.code_challenge || '');
  const method = String(q.code_challenge_method || '');
  const scope = String(q.scope || SCOPE);
  const resource = q.resource != null ? String(q.resource) : '';

  if (responseType !== 'code') {
    return { error: 'unsupported_response_type', error_description: 'Only response_type=code is supported' };
  }
  const client = await getClient(clientId);
  if (!client) {
    return { error: 'invalid_client', error_description: 'Unknown client_id' };
  }
  if (!redirectUriAllowed(client, redirectUri)) {
    return { error: 'invalid_request', error_description: 'redirect_uri is not allowed for this client' };
  }
  if (!codeChallenge || method !== 'S256') {
    return { error: 'invalid_request', error_description: 'PKCE S256 code_challenge is required' };
  }
  if (codeChallenge.length < 43 || codeChallenge.length > 128) {
    return { error: 'invalid_request', error_description: 'Invalid code_challenge' };
  }
  if (resource && resource.replace(/\/+$/, '') !== mcpResourceUrl()) {
    return { error: 'invalid_target', error_description: 'resource must match the MCP endpoint URL' };
  }

  return {
    ok: true,
    pending: {
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope: scope.split(/\s+/).filter(Boolean).includes(SCOPE) ? SCOPE : SCOPE,
      resource: resource || mcpResourceUrl(),
      client_name: client.client_name || clientId,
      redirect_host: (() => {
        try { return new URL(redirectUri).hostname; } catch { return ''; }
      })(),
    },
  };
}

async function registerClient(body = {}) {
  await ensureOAuthTables();
  await pruneExpired();
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!redirectUris.length) {
    const err = new Error('redirect_uris required');
    err.code = 'invalid_client_metadata';
    err.status = 400;
    throw err;
  }
  for (const uri of redirectUris) {
    let u;
    try {
      u = new URL(uri);
    } catch {
      const err = new Error('Invalid redirect_uri');
      err.code = 'invalid_redirect_uri';
      err.status = 400;
      throw err;
    }
    const okHosted = uri === CLAUDE_HOSTED_REDIRECT || extraRedirectUris().includes(uri);
    const okLoop = u.protocol === 'http:' && isLoopbackHost(u.hostname);
    if (!okHosted && !okLoop) {
      const err = new Error('redirect_uri not allowed');
      err.code = 'invalid_redirect_uri';
      err.status = 400;
      throw err;
    }
  }

  const clientId = `dcr_${randomToken(18)}`;
  const client = {
    client_id: clientId,
    client_name: String(body.client_name || 'MCP client').slice(0, 120),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    allow_loopback: true,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    expiresAt: Date.now() + CLIENT_TTL_MS,
  };
  await query(
    `REPLACE INTO mcp_oauth_clients (client_id, payload_json, expires_at)
     VALUES (:clientId, :payload, :expiresAt)`,
    {
      clientId,
      payload: JSON.stringify(client),
      expiresAt: client.expiresAt,
    }
  );
  return {
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    response_types: client.response_types,
    token_endpoint_auth_method: 'none',
    client_id_issued_at: client.client_id_issued_at,
    client_secret_expires_at: 0,
  };
}

async function createAuthorizationCode(pending, portalUser) {
  await ensureOAuthTables();
  await pruneExpired();
  const code = randomToken(24);
  const row = {
    ...pending,
    workspaceId: Number(portalUser.workspace_id),
    leadId: Number(portalUser.lead_id),
    email: String(portalUser.email || ''),
    portalUserId: Number(portalUser.id),
    expiresAt: Date.now() + CODE_TTL_MS,
  };
  await query(
    `REPLACE INTO mcp_oauth_auth_codes (code, payload_json, expires_at)
     VALUES (:code, :payload, :expiresAt)`,
    {
      code,
      payload: JSON.stringify(row),
      expiresAt: row.expiresAt,
    }
  );
  return code;
}

function verifyPkce(verifier, challenge) {
  const v = String(verifier || '');
  if (v.length < 43 || v.length > 128) return false;
  const computed = b64url(sha256(v));
  return computed === String(challenge || '');
}

async function mintAccessToken(row) {
  const identity = await portal.findByEmail(row.email);
  if (!identity || (row.portalUserId && Number(row.portalUserId) !== Number(identity.id)) || identity.status !== 'active'
    || Number(identity.workspace_id) !== Number(row.workspaceId)
    || Number(identity.lead_id) !== Number(row.leadId)) {
    throw Object.assign(new Error('OAuth client identity is inactive or no longer matches this site'), { oauth: 'invalid_grant', status: 400 });
  }
  const name = `Claude OAuth · ${String(row.email || '').slice(0, 36)} · lead ${row.leadId}`;
  const created = await portal.createClientMcpToken(
    row.workspaceId,
    row.leadId,
    row.email,
    { name, expiresAt: Date.now() + ACCESS_TTL_SEC * 1000, oauthUserId: Number(identity.id) }
  );
  const tokenHash = hashToken(created.token);
  const rows = await query(
    'SELECT id FROM workspace_tokens WHERE token_hash = :tokenHash LIMIT 1',
    { tokenHash }
  );
  const tokenId = rows[0] && rows[0].id;
  return { accessToken: created.token, tokenId, prefix: created.prefix, portalUserId: Number(identity.id) };
}

async function storeRefresh(refreshRaw, meta) {
  await ensureOAuthTables();
  const key = hashToken(refreshRaw);
  const expiresAt = Date.now() + REFRESH_TTL_MS;
  await query(
    `REPLACE INTO mcp_oauth_refresh_tokens (token_hash, payload_json, expires_at)
     VALUES (:tokenHash, :payload, :expiresAt)`,
    {
      tokenHash: key,
      payload: JSON.stringify({ ...meta, expiresAt }),
      expiresAt,
    }
  );
}

async function takeAuthCode(code) {
  await ensureOAuthTables();
  const now = Date.now();
  const rows = await query(
    'SELECT payload_json, expires_at FROM mcp_oauth_auth_codes WHERE code = :code LIMIT 1',
    { code }
  );
  const row = rows && rows[0];
  if (!row) return null;
  if (Number(row.expires_at) <= now) {
    await query('DELETE FROM mcp_oauth_auth_codes WHERE code = :code', { code });
    return null;
  }
  const del = await query('DELETE FROM mcp_oauth_auth_codes WHERE code = :code', { code });
  if (!affected(del)) return null;
  try {
    return JSON.parse(row.payload_json);
  } catch {
    return null;
  }
}

async function takeRefresh(tokenHash) {
  await ensureOAuthTables();
  const now = Date.now();
  const rows = await query(
    'SELECT payload_json, expires_at FROM mcp_oauth_refresh_tokens WHERE token_hash = :tokenHash LIMIT 1',
    { tokenHash }
  );
  const row = rows && rows[0];
  if (!row) return null;
  if (Number(row.expires_at) <= now) {
    await query('DELETE FROM mcp_oauth_refresh_tokens WHERE token_hash = :tokenHash', { tokenHash });
    return null;
  }
  const del = await query(
    'DELETE FROM mcp_oauth_refresh_tokens WHERE token_hash = :tokenHash',
    { tokenHash }
  );
  if (!affected(del)) return null;
  try {
    return JSON.parse(row.payload_json);
  } catch {
    return null;
  }
}

async function exchangeAuthorizationCode(params) {
  await pruneExpired();
  const clientId = String(params.client_id || '');
  const code = String(params.code || '');
  const redirectUri = String(params.redirect_uri || '');
  const verifier = String(params.code_verifier || '');
  const client = await getClient(clientId);
  if (!client) {
    const err = new Error('Unknown client');
    err.oauth = 'invalid_client';
    err.status = 401;
    throw err;
  }
  const row = await takeAuthCode(code);
  if (!row || Number(row.expiresAt) <= Date.now()) {
    const err = new Error('Invalid or expired authorization code');
    err.oauth = 'invalid_grant';
    err.status = 400;
    throw err;
  }
  if (row.client_id !== clientId || row.redirect_uri !== redirectUri) {
    const err = new Error('Code does not match client or redirect_uri');
    err.oauth = 'invalid_grant';
    err.status = 400;
    throw err;
  }
  if (!verifyPkce(verifier, row.code_challenge)) {
    const err = new Error('PKCE verification failed');
    err.oauth = 'invalid_grant';
    err.status = 400;
    throw err;
  }

  const minted = await mintAccessToken(row);
  const refreshRaw = randomToken(32);
  await storeRefresh(refreshRaw, {
    clientId,
    workspaceId: row.workspaceId,
    leadId: row.leadId,
    email: row.email,
    tokenId: minted.tokenId,
    portalUserId: minted.portalUserId,
  });

  return {
    access_token: minted.accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SEC,
    refresh_token: refreshRaw,
    scope: SCOPE,
  };
}

async function exchangeRefreshToken(params) {
  await pruneExpired();
  const clientId = String(params.client_id || '');
  const refreshRaw = String(params.refresh_token || '');
  const client = await getClient(clientId);
  if (!client) {
    const err = new Error('Unknown client');
    err.oauth = 'invalid_client';
    err.status = 401;
    throw err;
  }
  const key = hashToken(refreshRaw);
  const row = await takeRefresh(key);
  if (!row || Number(row.expiresAt) <= Date.now()) {
    const err = new Error('Invalid refresh token');
    err.oauth = 'invalid_grant';
    err.status = 400;
    throw err;
  }
  if (row.clientId !== clientId) {
    const err = new Error('Refresh token client mismatch');
    err.oauth = 'invalid_grant';
    err.status = 400;
    throw err;
  }

  // Consuming the refresh alone cannot revive a manually revoked access credential.
  const revoked = row.tokenId ? await query(`DELETE FROM workspace_tokens
    WHERE id = :id AND workspace_id = :workspaceId AND lead_id = :leadId`,
    { id: Number(row.tokenId), workspaceId: row.workspaceId, leadId: row.leadId }) : null;
  if (!affected(revoked)) {
    throw Object.assign(new Error('OAuth access was revoked; reconnect to authorize again'), { oauth: 'invalid_grant', status: 400 });
  }

  const minted = await mintAccessToken(row);
  const newRefresh = randomToken(32);
  await storeRefresh(newRefresh, {
    clientId,
    workspaceId: row.workspaceId,
    leadId: row.leadId,
    email: row.email,
    tokenId: minted.tokenId,
    portalUserId: minted.portalUserId,
  });

  return {
    access_token: minted.accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SEC,
    refresh_token: newRefresh,
    scope: SCOPE,
  };
}

async function handleTokenRequest(body = {}) {
  const grant = String(body.grant_type || '');
  if (grant === 'authorization_code') {
    return exchangeAuthorizationCode(body);
  }
  if (grant === 'refresh_token') {
    return exchangeRefreshToken(body);
  }
  const err = new Error('Unsupported grant_type');
  err.oauth = 'unsupported_grant_type';
  err.status = 400;
  throw err;
}

function oauthErrorRedirect(redirectUri, state, error, description) {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  if (description) u.searchParams.set('error_description', String(description).slice(0, 200));
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

function successRedirect(redirectUri, state, code) {
  const u = new URL(redirectUri);
  u.searchParams.set('code', code);
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

module.exports = {
  STATIC_CLIENT_ID,
  SCOPE,
  CLAUDE_HOSTED_REDIRECT,
  appBaseUrl,
  mcpResourceUrl,
  issuerUrl,
  protectedResourceMetadata,
  authorizationServerMetadata,
  wwwAuthenticateHeader,
  validateAuthorizeParams,
  registerClient,
  createAuthorizationCode,
  handleTokenRequest,
  redirectUriAllowed,
  getClient,
  oauthErrorRedirect,
  successRedirect,
  ensureOAuthTables,
};
