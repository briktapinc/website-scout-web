'use strict';

// Cloudflare Pages publishing for Website Scout (WORKSTREAM 6).
//
// Optional feature: publishes an exported static site folder to Cloudflare
// Pages via the "Direct Upload" REST API. No wrangler shell-out, no npm
// dependencies — only node:https, node:fs, node:crypto, node:path.
//
// Security: the API token lives in the settings table (key cf.api_token).
// It is read only at request time, is NEVER returned by getConfig(), and is
// never written to logs or error detail strings.

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const API_HOST = 'api.cloudflare.com';
const API_BASE = '/client/v4';

// Cloudflare Pages direct-upload limits.
const MAX_FILE_BYTES = 25 * 1024 * 1024; // files larger than this are skipped
const MAX_FILES = 20000;                 // hard cap on files per deployment

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
const PROJECT_RE = /^[a-z0-9]([a-z0-9-]{0,56}[a-z0-9])?$/; // 1-58 chars
const TOKEN_RE = /^[A-Za-z0-9._~-]{12,}$/;                 // plausible token shape
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

// ---------------------------------------------------------------------------
// Settings helpers (defensive: settings table is owned by the seed/core
// workstream; we only assume the documented key/value shape).
// ---------------------------------------------------------------------------

function getSetting(db, key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && typeof row.value === 'string' ? row.value : null;
  } catch (err) {
    return null;
  }
}

function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

// Never include secrets in an error string.
function safeMessage(err) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return 'Unknown error';
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// Idempotently adds websites.preview_url + deployment tracking columns.
// Safe to call on every publish and at startup; checks PRAGMA table_info first.
function ensureColumn(db) {
  const cols = db.prepare('PRAGMA table_info(websites)').all();
  const names = new Set((cols || []).map((c) => c && c.name).filter(Boolean));
  if (!names.has('preview_url')) {
    db.exec('ALTER TABLE websites ADD COLUMN preview_url TEXT');
  }
  if (!names.has('cf_deployment_id')) {
    db.exec('ALTER TABLE websites ADD COLUMN cf_deployment_id TEXT');
  }
  if (!names.has('deployed_version_no')) {
    db.exec('ALTER TABLE websites ADD COLUMN deployed_version_no INTEGER');
  }
  if (!names.has('deployed_at')) {
    db.exec('ALTER TABLE websites ADD COLUMN deployed_at TEXT');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Reads cf.api_token / cf.account_id / cf.project / cf.preview_domain.
// NEVER returns the token.
// Project is optional: when empty, publishDirectory uses a per-site name (site-{id}).
function getConfig(db) {
  const accountId = getSetting(db, 'cf.account_id') || '';
  const project = getSetting(db, 'cf.project') || '';
  const previewDomain = getSetting(db, 'cf.preview_domain') || '';
  const token = getSetting(db, 'cf.api_token') || '';
  const configured = token.length > 0 && ACCOUNT_ID_RE.test(accountId);
  return { configured, accountId, project, previewDomain };
}

/**
 * Per-site Pages project when cf.project is unset.
 * Includes workspaceId so tenants cannot collide on a shared Cloudflare account.
 */
function defaultProjectForWebsite(websiteId, workspaceId) {
  const id = Number(websiteId);
  if (!Number.isInteger(id) || id <= 0) return '';
  const ws = Number(workspaceId);
  if (Number.isInteger(ws) && ws > 0) return `bp-w${ws}-s${id}`;
  // Legacy fallback (prefer passing workspaceId).
  return `bp-preview-s${id}`;
}

/**
 * Resolve the Pages project name for a publish.
 * Prefer explicit override, then workspace cf.project, then bp-w{ws}-s{site}.
 */
function resolveProjectName(db, websiteId, override, workspaceId) {
  const fromArg = typeof override === 'string' ? override.trim().toLowerCase() : '';
  if (fromArg && PROJECT_RE.test(fromArg)) return fromArg;
  const fromSettings = (getSetting(db, 'cf.project') || '').trim().toLowerCase();
  if (fromSettings && PROJECT_RE.test(fromSettings)) return fromSettings;
  const auto = defaultProjectForWebsite(websiteId, workspaceId);
  return PROJECT_RE.test(auto) ? auto : '';
}

/** Prefer workspace CF settings; fall back to platform (BitPype-operated previews). */
async function resolveCfCredentials(db) {
  let token = (getSetting(db, 'cf.api_token') || '').trim();
  let accountId = (getSetting(db, 'cf.account_id') || '').trim().toLowerCase();
  let previewDomain = (getSetting(db, 'cf.preview_domain') || '').trim().toLowerCase();
  if (token && ACCOUNT_ID_RE.test(accountId)) {
    return { token, accountId, previewDomain, via: 'workspace' };
  }
  try {
    const platform = require('../server/platform');
    if (!token) token = String(await platform.getPlatformSetting('cf.api_token', '') || '').trim();
    if (!ACCOUNT_ID_RE.test(accountId)) {
      accountId = String(await platform.getPlatformSetting('cf.account_id', '') || '').trim().toLowerCase();
    }
    if (!previewDomain) {
      previewDomain = String(await platform.getPlatformSetting('cf.preview_domain', '') || '').trim().toLowerCase();
    }
  } catch { /* platform optional */ }
  return {
    token,
    accountId,
    previewDomain,
    via: token && ACCOUNT_ID_RE.test(accountId) ? 'platform' : 'none',
  };
}

/**
 * Public preview URL after a Pages publish.
 * Prefer the URL Cloudflare returned (reachable after deploy). When missing,
 * fall back to https://{project}.{cf.preview_domain}.
 */
function publicPreviewUrl(projectName, previewDomain, cfUrl) {
  if (typeof cfUrl === 'string' && /^https?:\/\//i.test(cfUrl.trim())) {
    return cfUrl.trim().replace(/\/+$/, '');
  }
  const domain = typeof previewDomain === 'string' ? previewDomain.trim().toLowerCase() : '';
  const project = typeof projectName === 'string' ? projectName.trim().toLowerCase() : '';
  if (domain && PROJECT_RE.test(project) && DOMAIN_RE.test(domain)) {
    return `https://${project}.${domain}`;
  }
  return null;
}

// Validates and stores the Cloudflare credentials/settings.
function saveConfig(db, cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const apiToken = typeof c.apiToken === 'string' ? c.apiToken.trim() : '';
  const accountId = typeof c.accountId === 'string' ? c.accountId.trim() : '';
  const project = typeof c.project === 'string' ? c.project.trim().toLowerCase() : '';
  const previewDomain =
    typeof c.previewDomain === 'string' ? c.previewDomain.trim().toLowerCase() : '';

  if (!TOKEN_RE.test(apiToken)) {
    return {
      ok: false,
      error: 'INVALID_TOKEN',
      hint: 'Paste the full API token (check for stray whitespace).',
    };
  }
  if (!ACCOUNT_ID_RE.test(accountId)) {
    return {
      ok: false,
      error: 'INVALID_ACCOUNT_ID',
      hint: 'Account ID is 32 hex characters (Cloudflare dashboard → account overview).',
    };
  }
  // Project is optional (empty → per-site auto name on publish).
  if (project && !PROJECT_RE.test(project)) {
    return {
      ok: false,
      error: 'INVALID_PROJECT',
      hint: 'Project name: lowercase letters, numbers, hyphens; 1–58 chars. Leave blank to use site-{id}.',
    };
  }
  if (previewDomain && !DOMAIN_RE.test(previewDomain)) {
    return { ok: false, error: 'INVALID_PREVIEW_DOMAIN' };
  }

  setSetting(db, 'cf.api_token', apiToken);
  setSetting(db, 'cf.account_id', accountId.toLowerCase());
  setSetting(db, 'cf.project', project);
  setSetting(db, 'cf.preview_domain', previewDomain);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HTTP layer (node:https only)
// ---------------------------------------------------------------------------

function apiRequest({ method, apiPath, token, body, contentType, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (contentType) headers['Content-Type'] = contentType;
    const bodyBuf = body ? Buffer.from(body) : null;
    if (bodyBuf) headers['Content-Length'] = bodyBuf.length;

    const req = https.request(
      { host: API_HOST, path: apiPath, method, timeout: timeoutMs || 30000, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (err) {
            json = null;
          }
          resolve({ statusCode: res.statusCode, json, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('REQUEST_TIMEOUT')));
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// Extract Cloudflare's own error message; never echo the token.
function cfError(resp, fallback) {
  if (resp && resp.json && Array.isArray(resp.json.errors) && resp.json.errors.length > 0) {
    const e = resp.json.errors[0];
    if (e && e.message) return String(e.message);
  }
  return (fallback || 'Cloudflare request failed') + ' (HTTP ' + (resp ? resp.statusCode : '?') + ')';
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

// GETs the account's Pages project list with the stored token.
// Returns {ok:true, projects:[names]} or {ok:false, error, ...}.
async function testConnection(db) {
  const token = getSetting(db, 'cf.api_token');
  const accountId = getSetting(db, 'cf.account_id');
  if (!token || !ACCOUNT_ID_RE.test(accountId || '')) {
    return {
      ok: false,
      error: 'NOT_CONFIGURED',
      hint: 'Save your Cloudflare API token and account ID first (Settings).',
    };
  }
  let resp;
  try {
    resp = await apiRequest({
      method: 'GET',
      // Pages projects list only accepts per_page up to 10 (20/25/100 → error 8000024).
      apiPath: `${API_BASE}/accounts/${accountId}/pages/projects?page=1&per_page=10`,
      token,
    });
  } catch (err) {
    return { ok: false, error: 'NETWORK_ERROR', detail: safeMessage(err) };
  }
  if (resp.statusCode === 200 && resp.json && resp.json.success) {
    const projects = (resp.json.result || [])
      .map((p) => p && p.name)
      .filter((n) => typeof n === 'string');
    return { ok: true, projects };
  }
  return { ok: false, error: cfError(resp, 'Connection test failed') };
}

// ---------------------------------------------------------------------------
// Project management
// ---------------------------------------------------------------------------

async function ensureProject(token, accountId, project) {
  let get;
  try {
    get = await apiRequest({
      method: 'GET',
      apiPath: `${API_BASE}/accounts/${accountId}/pages/projects/${project}`,
      token,
    });
  } catch (err) {
    return { ok: false, error: 'NETWORK_ERROR', detail: safeMessage(err) };
  }
  if (get.statusCode === 200 && get.json && get.json.success) {
    return { ok: true, created: false };
  }
  const notFound =
    get.statusCode === 404 ||
    (get.json &&
      Array.isArray(get.json.errors) &&
      get.json.errors.some((e) => e && (e.code === 8000007 || e.code === 8000002)));
  if (!notFound) {
    return { ok: false, error: cfError(get, 'Could not check Pages project') };
  }
  let create;
  try {
    create = await apiRequest({
      method: 'POST',
      apiPath: `${API_BASE}/accounts/${accountId}/pages/projects`,
      token,
      body: JSON.stringify({ name: project, production_branch: 'main' }),
      contentType: 'application/json',
    });
  } catch (err) {
    return { ok: false, error: 'NETWORK_ERROR', detail: safeMessage(err) };
  }
  if ((create.statusCode === 200 || create.statusCode === 201) && create.json && create.json.success) {
    return { ok: true, created: true };
  }
  return { ok: false, error: cfError(create, 'Could not create Pages project') };
}

// ---------------------------------------------------------------------------
// Export folder -> manifest + multipart
// ---------------------------------------------------------------------------

// sha256 of a file, streamed in 1MB chunks so large files stay cheap.
function sha256File(abs) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n = 0;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * Wrangler / Pages Direct Upload asset key (must match hashFile in
 * @cloudflare/deploy-helpers):
 *   blake3( base64(fileBytes) + extensionWithoutDot ) → first 32 hex chars.
 * Hashing raw bytes (previous bug) creates deployments that return HTTP 500.
 */
function pagesAssetKey(fileBytes, relPath) {
  const { blake3 } = require('@noble/hashes/blake3');
  const { bytesToHex } = require('@noble/hashes/utils');
  // Match wrangler: extname(...).substring(1) — do not force lowercase.
  const ext = path.extname(relPath || '').replace(/^\./, '');
  const data = Buffer.isBuffer(fileBytes) ? fileBytes : Buffer.from(fileBytes);
  const base64Contents = data.toString('base64');
  const input = Buffer.from(base64Contents + ext, 'utf8');
  return bytesToHex(blake3(input)).slice(0, 32);
}

// Recursively walks dir. Returns [{rel, abs, size, key, bytes}] where rel is the
// Pages-style path ("/index.html") and key is the wrangler asset hash.
// Skips symlinks (escape risk) and files larger than 25MB.
function collectFiles(dir) {
  const root = path.resolve(dir);
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (err) {
      throw new Error('Cannot read directory: ' + cur);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const abs = path.join(cur, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      let st;
      try {
        st = fs.statSync(abs);
      } catch (err) {
        continue;
      }
      if (st.size > MAX_FILE_BYTES) continue; // >25MB: skipped
      const rel = '/' + path.relative(root, abs).split(path.sep).join('/');
      const bytes = fs.readFileSync(abs);
      const key = pagesAssetKey(bytes, rel);
      files.push({
        rel,
        abs,
        size: st.size,
        key,
        // Keep sha256 for unit tests / debugging (not used by Pages API).
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        bytes,
      });
      if (files.length > MAX_FILES) {
        throw new Error('FILE_LIMIT_EXCEEDED: more than ' + MAX_FILES + ' files');
      }
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return files;
}

// {"/index.html": "<assetKey>", ...} — the manifest field of the upload.
function buildManifest(files) {
  const manifest = {};
  for (const f of files) manifest[f.rel] = f.key || f.sha256;
  return manifest;
}

function sanitizeFilename(name) {
  return String(name).replace(/["\\\r\n]/g, '_');
}

function guessContentType(rel) {
  const ext = path.extname(rel).toLowerCase();
  switch (ext) {
    case '.html':
    case '.htm':
      return 'text/html';
    case '.css':
      return 'text/css';
    case '.js':
    case '.mjs':
      return 'application/javascript';
    case '.json':
    case '.map':
      return 'application/json';
    case '.txt':
      return 'text/plain';
    case '.xml':
      return 'application/xml';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.ttf':
      return 'font/ttf';
    case '.otf':
      return 'font/otf';
    default:
      return 'application/octet-stream';
  }
}

// Legacy multipart builder kept for unit tests (hash field = asset key).
function buildFormData(files) {
  const boundary = '----WebsiteScoutPages' + crypto.randomBytes(16).toString('hex');
  const manifestJson = JSON.stringify(buildManifest(files));
  const parts = [
    {
      name: 'manifest',
      filename: null,
      contentType: 'application/json',
      kind: 'buffer',
      buffer: Buffer.from(manifestJson, 'utf8'),
    },
  ];
  const seen = new Set();
  for (const f of files) {
    const key = f.key || f.sha256;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    parts.push({
      name: key,
      filename: f.rel,
      contentType: guessContentType(f.rel),
      kind: 'file',
      abs: f.abs,
      size: f.size,
    });
  }
  const prepared = parts.map((p) => {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) header += `; filename="${sanitizeFilename(p.filename)}"`;
    header += `\r\nContent-Type: ${p.contentType}\r\n\r\n`;
    const headerBuf = Buffer.from(header, 'utf8');
    const footerBuf = Buffer.from('\r\n', 'utf8');
    const bodyLen = p.kind === 'buffer' ? p.buffer.length : p.size;
    return { ...p, headerBuf, footerBuf, bodyLen };
  });
  const tail = Buffer.from(`--${boundary}--\r\n`, 'utf8');
  const contentLength =
    prepared.reduce((n, p) => n + p.headerBuf.length + p.bodyLen + p.footerBuf.length, 0) +
    tail.length;
  return { boundary, manifestJson, parts: prepared, tail, contentLength };
}

async function getUploadJwt(token, accountId, project) {
  let resp;
  try {
    resp = await apiRequest({
      method: 'GET',
      apiPath: `${API_BASE}/accounts/${accountId}/pages/projects/${project}/upload-token`,
      token,
    });
  } catch (err) {
    return { ok: false, error: 'NETWORK_ERROR', detail: safeMessage(err) };
  }
  const jwt = resp.json && resp.json.result && resp.json.result.jwt;
  if (resp.statusCode === 200 && resp.json && resp.json.success && jwt) {
    return { ok: true, jwt };
  }
  return { ok: false, error: cfError(resp, 'Could not get Pages upload token') };
}

/**
 * Register file blobs in the Pages asset store (required before deploy).
 * Auth uses the short-lived JWT from getUploadJwt — not the account API token.
 */
async function checkMissingAssets(jwt, hashes) {
  let resp;
  try {
    resp = await apiRequest({
      method: 'POST',
      apiPath: `${API_BASE}/pages/assets/check-missing`,
      token: jwt,
      body: JSON.stringify({ hashes }),
      contentType: 'application/json',
      timeoutMs: 60 * 1000,
    });
  } catch (err) {
    return { ok: false, error: 'NETWORK_ERROR', detail: safeMessage(err) };
  }
  if (resp.statusCode === 200 && resp.json && resp.json.success && Array.isArray(resp.json.result)) {
    return { ok: true, missing: resp.json.result };
  }
  // If check-missing fails, upload everything (safe fallback).
  return { ok: true, missing: hashes, fallback: true };
}

async function upsertAssetHashes(jwt, hashes) {
  let resp;
  try {
    resp = await apiRequest({
      method: 'POST',
      apiPath: `${API_BASE}/pages/assets/upsert-hashes`,
      token: jwt,
      body: JSON.stringify({ hashes }),
      contentType: 'application/json',
      timeoutMs: 60 * 1000,
    });
  } catch (err) {
    return { ok: false, error: 'NETWORK_ERROR', detail: safeMessage(err) };
  }
  if (resp.statusCode === 200 && resp.json && resp.json.success) {
    return { ok: true };
  }
  // Non-fatal for serving (wrangler only warns); caching of future uploads may suffer.
  return { ok: false, error: cfError(resp, 'upsert-hashes failed') };
}

async function uploadAssets(jwt, files) {
  const unique = new Map(); // key -> {key, contentType, valueB64}
  for (const f of files) {
    if (!f.key || unique.has(f.key)) continue;
    const bytes = f.bytes || fs.readFileSync(f.abs);
    unique.set(f.key, {
      key: f.key,
      base64: true,
      value: bytes.toString('base64'),
      metadata: { contentType: guessContentType(f.rel) },
    });
  }
  const allHashes = [...unique.keys()];
  const missingRes = await checkMissingAssets(jwt, allHashes);
  if (!missingRes.ok) return missingRes;
  const missingSet = new Set(missingRes.missing || allHashes);
  const items = [...unique.values()].filter((item) => missingSet.has(item.key));
  // Keep each request under ~12MB of JSON/base64 payload.
  const MAX_BATCH_BYTES = 12 * 1024 * 1024;
  let batch = [];
  let batchBytes = 0;

  async function flush() {
    if (!batch.length) return { ok: true };
    let resp;
    try {
      resp = await apiRequest({
        method: 'POST',
        apiPath: `${API_BASE}/pages/assets/upload`,
        token: jwt,
        body: JSON.stringify(batch),
        contentType: 'application/json',
        timeoutMs: 10 * 60 * 1000,
      });
    } catch (err) {
      return { ok: false, error: 'NETWORK_ERROR', detail: safeMessage(err) };
    }
    if (!(resp.statusCode === 200 || resp.statusCode === 201) || !resp.json || !resp.json.success) {
      return { ok: false, error: cfError(resp, 'Asset upload failed') };
    }
    batch = [];
    batchBytes = 0;
    return { ok: true };
  }

  for (const item of items) {
    const size = item.value.length + 200;
    if (batch.length && batchBytes + size > MAX_BATCH_BYTES) {
      const flushed = await flush();
      if (!flushed.ok) return flushed;
    }
    batch.push(item);
    batchBytes += size;
  }
  const uploaded = await flush();
  if (!uploaded.ok) return uploaded;
  await upsertAssetHashes(jwt, allHashes);
  return { ok: true, uploaded: items.length, skipped: allHashes.length - items.length };
}

/**
 * Create a deployment from an already-uploaded asset manifest.
 * Multipart with only the manifest field (no file parts).
 */
function postManifestDeployment({ token, accountId, project, manifest, branch }) {
  return new Promise((resolve, reject) => {
    const boundary = '----WebsiteScoutPages' + crypto.randomBytes(16).toString('hex');
    const manifestJson = JSON.stringify(manifest);
    const branchName = typeof branch === 'string' && branch.trim() ? branch.trim() : 'main';
    let body = '';
    body += `--${boundary}\r\n`;
    body += 'Content-Disposition: form-data; name="branch"\r\n\r\n';
    body += `${branchName}\r\n`;
    body += `--${boundary}\r\n`;
    body += 'Content-Disposition: form-data; name="manifest"\r\n';
    body += 'Content-Type: application/json\r\n\r\n';
    body += `${manifestJson}\r\n`;
    body += `--${boundary}--\r\n`;
    const bodyBuf = Buffer.from(body, 'utf8');

    const req = https.request(
      {
        host: API_HOST,
        path: `${API_BASE}/accounts/${accountId}/pages/projects/${project}/deployments`,
        method: 'POST',
        timeout: 10 * 60 * 1000,
        headers: {
          Accept: 'application/json',
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': bodyBuf.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (err) {
            json = null;
          }
          resolve({ statusCode: res.statusCode, json, text });
        });
      }
    );
    req.setHeader('Authorization', 'Bearer ' + token);
    req.on('timeout', () => req.destroy(new Error('UPLOAD_TIMEOUT')));
    req.on('error', reject);
    req.end(bodyBuf);
  });
}

/**
 * Full Direct Upload: upload-token → assets/upload → deployments(manifest).
 * The old single multipart (manifest + file parts) creates "success" deploys
 * that serve HTTP 500 because asset blobs were never registered.
 */
async function postDeployment({ token, accountId, project, files, branch }) {
  const tok = await getUploadJwt(token, accountId, project);
  if (!tok.ok) return { statusCode: 400, json: { success: false, errors: [{ message: tok.error || 'UPLOAD_TOKEN' }] }, _detail: tok };

  const uploaded = await uploadAssets(tok.jwt, files);
  if (!uploaded.ok) {
    return {
      statusCode: 400,
      json: { success: false, errors: [{ message: uploaded.error || 'ASSET_UPLOAD' }] },
      _detail: uploaded,
    };
  }

  const manifest = buildManifest(files);
  try {
    return await postManifestDeployment({
      token,
      accountId,
      project,
      manifest,
      branch: branch || 'main',
    });
  } catch (err) {
    return {
      statusCode: 0,
      json: { success: false, errors: [{ message: safeMessage(err) }] },
      _detail: { error: 'NETWORK_ERROR', detail: safeMessage(err) },
    };
  }
}

async function getDeployment(token, accountId, project, deploymentId) {
  let resp;
  try {
    resp = await apiRequest({
      method: 'GET',
      apiPath: `${API_BASE}/accounts/${accountId}/pages/projects/${project}/deployments/${deploymentId}`,
      token,
    });
  } catch (err) {
    return { ok: false, error: 'NETWORK_ERROR', detail: safeMessage(err) };
  }
  if (resp.statusCode === 200 && resp.json && resp.json.success && resp.json.result) {
    return { ok: true, deployment: resp.json.result };
  }
  return { ok: false, error: cfError(resp, 'Could not fetch deployment') };
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

// Publishes an exported static folder to Cloudflare Pages (direct upload).
// On success stores the public URL in websites.preview_url and logs to
// activity_log (area 'cloudflare'). Returns {ok:true, url} or {ok:false, error}.
async function publishDirectory(db, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const websiteId = o.websiteId;
  const workspaceId = o.workspaceId != null ? Number(o.workspaceId) : null;
  const dir = o.dir;

  if (!Number.isInteger(websiteId) || websiteId <= 0) {
    return { ok: false, error: 'INVALID_WEBSITE_ID' };
  }
  if (typeof dir !== 'string' || dir.trim() === '') {
    return { ok: false, error: 'INVALID_DIR' };
  }
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (err) {
    return { ok: false, error: 'INVALID_DIR', hint: 'Folder does not exist.' };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: 'INVALID_DIR', hint: 'Not a folder.' };
  }

  const site = db.prepare('SELECT id, name FROM websites WHERE id = ?').get(websiteId);
  if (!site) return { ok: false, error: 'UNKNOWN_WEBSITE' };

  const creds = await resolveCfCredentials(db);
  const token = creds.token;
  const accountId = creds.accountId;
  if (!token || !ACCOUNT_ID_RE.test(accountId || '')) {
    return {
      ok: false,
      error: 'NOT_CONFIGURED',
      hint: 'Save your Cloudflare API token and account ID first (Settings), or configure platform CF.',
    };
  }
  const projectName = resolveProjectName(db, websiteId, o.project, workspaceId);
  if (!PROJECT_RE.test(projectName)) {
    return {
      ok: false,
      error: 'INVALID_PROJECT',
      hint: 'Set a valid Pages project name in settings, or leave blank to auto-use bp-w{workspace}-s{site}.',
    };
  }
  const sharedProject = !!(getSetting(db, 'cf.project') || '').trim();
  const previewDomain = creds.previewDomain || '';

  let files;
  try {
    files = collectFiles(dir);
  } catch (err) {
    if (String(err.message).startsWith('FILE_LIMIT_EXCEEDED')) {
      return { ok: false, error: 'FILE_LIMIT_EXCEEDED', hint: 'Too many files (max 20,000).' };
    }
    return { ok: false, error: 'EXPORT_READ_FAILED', detail: safeMessage(err) };
  }
  if (files.length === 0) {
    return {
      ok: false,
      error: 'EMPTY_DIRECTORY',
      hint: 'Nothing to publish — the export folder has no files.',
    };
  }

  const ensured = await ensureProject(token, accountId, projectName);
  if (!ensured.ok) return ensured;

  let resp;
  try {
    resp = await postDeployment({ token, accountId, project: projectName, files, branch: 'main' });
  } catch (err) {
    return { ok: false, error: 'UPLOAD_FAILED', detail: safeMessage(err) };
  }
  if (
    !(resp.statusCode === 200 || resp.statusCode === 201) ||
    !resp.json ||
    !resp.json.success
  ) {
    if (resp && resp._detail && resp._detail.error) {
      return {
        ok: false,
        error: resp._detail.error,
        hint: resp._detail.hint || resp._detail.detail || 'Pages asset upload / deploy failed.',
        detail: resp._detail.detail,
      };
    }
    return { ok: false, error: cfError(resp, 'Deployment failed') };
  }

  const result = resp.json.result || {};
  const deploymentId = result.id || null;
  let cfUrl = result.url || null;

  // Shared project: keep the unique deployment URL so sites do not overwrite
  // each other's public link. Per-site projects: prefer production alias.
  if (deploymentId) {
    try {
      const got = await getDeployment(token, accountId, projectName, deploymentId);
      if (got.ok) {
        const d = got.deployment;
        if (sharedProject) {
          if (d.url) cfUrl = d.url;
          else if (Array.isArray(d.aliases) && d.aliases.length > 0) cfUrl = d.aliases[0];
        } else if (Array.isArray(d.aliases) && d.aliases.length > 0) {
          cfUrl = d.aliases[0];
        } else if (d.url) {
          cfUrl = d.url;
        }
      }
    } catch (err) {
      // Non-fatal: keep the URL from the POST response.
    }
  }
  if (!cfUrl) {
    return {
      ok: false,
      error: 'NO_DEPLOYMENT_URL',
      hint: 'Cloudflare accepted the deployment but returned no URL.',
    };
  }

  const url = publicPreviewUrl(projectName, previewDomain, cfUrl) || cfUrl;

  ensureColumn(db);
  // Pin deployed version: prefer caller-supplied version, else latest website_versions row.
  let deployedVersion = o.deployedVersion != null ? Number(o.deployedVersion) : null;
  if (!Number.isInteger(deployedVersion) || deployedVersion < 1) {
    try {
      const vrow = db.prepare(
        'SELECT COALESCE(MAX(version_no), 0) AS m FROM website_versions WHERE website_id = ?'
      ).get(websiteId);
      deployedVersion = Number(vrow && vrow.m) || null;
    } catch { deployedVersion = null; }
  }
  try {
    db.prepare(`
      UPDATE websites SET
        preview_url = ?,
        cf_deployment_id = ?,
        deployed_version_no = ?,
        deployed_at = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(url, deploymentId || null, deployedVersion, websiteId);
  } catch {
    db.prepare("UPDATE websites SET preview_url = ?, updated_at = datetime('now') WHERE id = ?").run(
      url,
      websiteId
    );
  }
  db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
    'cloudflare',
    `Published preview for website #${websiteId} (${projectName}): ${url}`
      + (deployedVersion != null ? ` v${deployedVersion}` : '')
      + (deploymentId ? ` deploy=${deploymentId}` : '')
  );
  return {
    ok: true,
    url,
    cfUrl,
    deploymentId,
    project: projectName,
    sharedProject,
    deployedVersion,
    version: deployedVersion,
  };
}

function isLocalPreviewUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return true;
  try {
    const u = new URL(url);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
  } catch {
    return true;
  }
}

module.exports = {
  ensureColumn,
  getConfig,
  saveConfig,
  testConnection,
  publishDirectory,
  resolveProjectName,
  resolveCfCredentials,
  defaultProjectForWebsite,
  publicPreviewUrl,
  isLocalPreviewUrl,
  pagesAssetKey,
  // Exported for unit tests (manifest / multipart builders):
  collectFiles,
  buildManifest,
  buildFormData,
  MAX_FILE_BYTES,
  MAX_FILES,
};
