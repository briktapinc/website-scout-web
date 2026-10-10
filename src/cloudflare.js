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

// Idempotently adds websites.preview_url (the public Pages URL). Safe to call
// on every publish and at startup; checks PRAGMA table_info first.
function ensureColumn(db) {
  const cols = db.prepare('PRAGMA table_info(websites)').all();
  if (!cols.some((c) => c && c.name === 'preview_url')) {
    db.exec('ALTER TABLE websites ADD COLUMN preview_url TEXT');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Reads cf.api_token / cf.account_id / cf.project / cf.preview_domain.
// NEVER returns the token.
function getConfig(db) {
  const accountId = getSetting(db, 'cf.account_id') || '';
  const project = getSetting(db, 'cf.project') || '';
  const previewDomain = getSetting(db, 'cf.preview_domain') || '';
  const token = getSetting(db, 'cf.api_token') || '';
  const configured =
    token.length > 0 && ACCOUNT_ID_RE.test(accountId) && project.length > 0;
  return { configured, accountId, project, previewDomain };
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
  if (!PROJECT_RE.test(project)) {
    return {
      ok: false,
      error: 'INVALID_PROJECT',
      hint: 'Project name: lowercase letters, numbers, hyphens; 1–58 chars.',
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
      apiPath: `${API_BASE}/accounts/${accountId}/pages/projects?per_page=100`,
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

// Recursively walks dir. Returns [{rel, abs, size, sha256}] where rel is the
// Pages-style path ("/index.html"). Skips symlinks (escape risk) and files
// larger than 25MB. Throws on unreadable dirs or >MAX_FILES files.
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
      files.push({ rel, abs, size: st.size, sha256: sha256File(abs) });
      if (files.length > MAX_FILES) {
        throw new Error('FILE_LIMIT_EXCEEDED: more than ' + MAX_FILES + ' files');
      }
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return files;
}

// {"/index.html": "<sha256hex>", ...} — the manifest field of the upload.
function buildManifest(files) {
  const manifest = {};
  for (const f of files) manifest[f.rel] = f.sha256;
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

// Builds the multipart/form-data payload description for a direct upload:
// one `manifest` JSON field plus one part per unique file, each part named
// by its sha256 hash (duplicate content uploads once). Exported for tests.
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
    if (seen.has(f.sha256)) continue;
    seen.add(f.sha256);
    parts.push({
      name: f.sha256,
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

function onceDrain(stream) {
  return new Promise((resolve) => stream.once('drain', resolve));
}

function streamFileInto(req, abs) {
  return new Promise((resolve, reject) => {
    const s = fs.createReadStream(abs);
    s.on('error', reject);
    s.on('end', resolve);
    s.pipe(req, { end: false });
  });
}

// POSTs the multipart deployment. Streams file bodies so memory stays flat.
function postDeployment({ token, accountId, project, files }) {
  return new Promise((resolve, reject) => {
    const form = buildFormData(files);
    const req = https.request(
      {
        host: API_HOST,
        path: `${API_BASE}/accounts/${accountId}/pages/projects/${project}/deployments`,
        method: 'POST',
        timeout: 10 * 60 * 1000,
        headers: {
          Accept: 'application/json',
          'Content-Type': `multipart/form-data; boundary=${form.boundary}`,
          'Content-Length': form.contentLength,
          // NOTE: the Authorization header is set below via setHeader so the
          // token value never passes through a logged object literal.
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

    (async () => {
      try {
        for (const p of form.parts) {
          if (!req.write(p.headerBuf)) await onceDrain(req);
          if (p.kind === 'buffer') {
            if (!req.write(p.buffer)) await onceDrain(req);
          } else {
            await streamFileInto(req, p.abs);
          }
          if (!req.write(p.footerBuf)) await onceDrain(req);
        }
        req.end(form.tail);
      } catch (err) {
        req.destroy(err);
      }
    })();
  });
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

  const token = getSetting(db, 'cf.api_token');
  const accountId = getSetting(db, 'cf.account_id');
  if (!token || !ACCOUNT_ID_RE.test(accountId || '')) {
    return {
      ok: false,
      error: 'NOT_CONFIGURED',
      hint: 'Save your Cloudflare API token and account ID first (Settings).',
    };
  }
  const override = typeof o.project === 'string' ? o.project.trim().toLowerCase() : '';
  const projectName = override || (getSetting(db, 'cf.project') || '').trim().toLowerCase();
  if (!PROJECT_RE.test(projectName)) {
    return {
      ok: false,
      error: 'INVALID_PROJECT',
      hint: 'Set a valid Pages project name in settings (or pass project).',
    };
  }

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
    resp = await postDeployment({ token, accountId, project: projectName, files });
  } catch (err) {
    return { ok: false, error: 'UPLOAD_FAILED', detail: safeMessage(err) };
  }
  if (
    !(resp.statusCode === 200 || resp.statusCode === 201) ||
    !resp.json ||
    !resp.json.success
  ) {
    return { ok: false, error: cfError(resp, 'Deployment failed') };
  }

  const result = resp.json.result || {};
  const deploymentId = result.id || null;
  let url = result.url || null;

  // Also query the deployment for its preview alias; prefer it as the
  // canonical public URL.
  if (deploymentId) {
    try {
      const got = await getDeployment(token, accountId, projectName, deploymentId);
      if (got.ok) {
        const d = got.deployment;
        if (Array.isArray(d.aliases) && d.aliases.length > 0) url = d.aliases[0];
        else if (d.url) url = d.url;
      }
    } catch (err) {
      // Non-fatal: keep the URL from the POST response.
    }
  }
  if (!url) {
    return {
      ok: false,
      error: 'NO_DEPLOYMENT_URL',
      hint: 'Cloudflare accepted the deployment but returned no URL.',
    };
  }

  ensureColumn(db);
  db.prepare("UPDATE websites SET preview_url = ?, updated_at = datetime('now') WHERE id = ?").run(
    url,
    websiteId
  );
  db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
    'cloudflare',
    `Published preview for website #${websiteId} (${projectName}): ${url}`
  );
  return { ok: true, url, deploymentId, project: projectName };
}

module.exports = {
  ensureColumn,
  getConfig,
  saveConfig,
  testConnection,
  publishDirectory,
  // Exported for unit tests (manifest / multipart builders):
  collectFiles,
  buildManifest,
  buildFormData,
  MAX_FILE_BYTES,
  MAX_FILES,
};
