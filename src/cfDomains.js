'use strict';

/**
 * Cloudflare Registrar (search / check / purchase) + Pages custom-domain linking.
 * Credentials reuse Settings → Cloudflare (cf.api_token / cf.account_id).
 * Purchase bills the Cloudflare account payment method — not Bitpype Stripe.
 */

const https = require('node:https');
const cf = require('./cloudflare');

const API_HOST = 'api.cloudflare.com';
const API_BASE = '/client/v4';
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;

function fail(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
}

function normalizeDomain(name) {
  const d = String(name || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!DOMAIN_RE.test(d)) return null;
  return d;
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      website_id INTEGER,
      lead_id INTEGER,
      domain_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL DEFAULT 'registrar',
      years INTEGER,
      price TEXT,
      currency TEXT,
      pages_project TEXT,
      public_url TEXT,
      registration_state TEXT,
      error TEXT,
      meta TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_site_domains_name ON site_domains(domain_name);
    CREATE INDEX IF NOT EXISTS idx_site_domains_website ON site_domains(website_id);
    CREATE INDEX IF NOT EXISTS idx_site_domains_status ON site_domains(status);
  `);
  try {
    const cols = db.prepare('PRAGMA table_info(websites)').all();
    if (!cols.some((c) => c && c.name === 'custom_domain')) {
      db.exec('ALTER TABLE websites ADD COLUMN custom_domain TEXT');
    }
  } catch { /* */ }
}

function apiRequest({ method, apiPath, token, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const bodyBuf = body != null ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    if (bodyBuf) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = bodyBuf.length;
    }
    const req = https.request(
      { host: API_HOST, path: apiPath, method, timeout: timeoutMs || 45000, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = null; }
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

function cfError(resp, fallback) {
  let msg = '';
  if (resp && resp.json && Array.isArray(resp.json.errors) && resp.json.errors.length) {
    const e = resp.json.errors[0];
    if (e && e.message) msg = String(e.message);
  }
  if (!msg && resp && resp.json && resp.json.error && resp.json.error.message) {
    msg = String(resp.json.error.message);
  }
  if (!msg) msg = `${fallback || 'Cloudflare request failed'} (HTTP ${resp ? resp.statusCode : '?'})`;
  // Cloudflare returns generic "Authentication error" (code 10000) when the
  // token lacks Registrar scope — Pages can still work with the same token.
  if (resp && (resp.statusCode === 401 || resp.statusCode === 403)
    && /authentication error/i.test(msg)) {
    return 'Cloudflare rejected this Registrar call. Edit your API token (Settings → Cloudflare) and add Account → Registrar → Edit (keep Pages → Edit). Then save and retry.';
  }
  return msg;
}

async function creds(db) {
  const c = await cf.resolveCfCredentials(db);
  if (!c.token || !ACCOUNT_ID_RE.test(c.accountId || '')) {
    throw fail('NOT_CONFIGURED', 'Cloudflare is not configured. Add API token + Account ID in Settings → Cloudflare (token needs Registrar + Pages permissions).');
  }
  return c;
}

function mapSearchDomain(row) {
  if (!row || typeof row !== 'object') return null;
  const name = normalizeDomain(row.name || row.domain_name || row.domain);
  if (!name) return null;
  const pricing = row.pricing || {};
  return {
    domain: name,
    registrable: !!row.registrable,
    reason: row.reason || null,
    tier: row.tier || pricing.tier || null,
    currency: pricing.currency || row.currency || null,
    registrationCost: pricing.registration_cost || pricing.registrationCost || row.registration_cost || null,
    renewalCost: pricing.renewal_cost || pricing.renewalCost || row.renewal_cost || null,
  };
}

async function searchDomains(db, query, opts = {}) {
  const { token, accountId } = await creds(db);
  const q = String(query || '').trim();
  if (q.length < 2) throw fail('INVALID', 'Enter at least 2 characters to search.');
  const params = new URLSearchParams({ q });
  if (opts.limit) params.set('limit', String(Math.min(50, Number(opts.limit) || 20)));
  const resp = await apiRequest({
    method: 'GET',
    apiPath: `${API_BASE}/accounts/${accountId}/registrar/domain-search?${params}`,
    token,
  });
  if (resp.statusCode !== 200 || !(resp.json && (resp.json.success !== false))) {
    // Some CF betas omit success:true; accept 200 with result.
    if (resp.statusCode !== 200) throw fail('CF_ERROR', cfError(resp, 'Domain search failed'));
  }
  const result = (resp.json && resp.json.result) || {};
  const list = Array.isArray(result.domains) ? result.domains
    : (Array.isArray(resp.json.result) ? resp.json.result : []);
  const domains = list.map(mapSearchDomain).filter(Boolean);
  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'domains',
      `Domain search: "${q.slice(0, 80)}" → ${domains.length} result(s)`
    );
  } catch { /* */ }
  return { query: q, domains };
}

async function checkDomains(db, names) {
  const { token, accountId } = await creds(db);
  const domains = (Array.isArray(names) ? names : [names])
    .map(normalizeDomain)
    .filter(Boolean);
  if (!domains.length) throw fail('INVALID', 'Provide at least one valid domain name.');
  const resp = await apiRequest({
    method: 'POST',
    apiPath: `${API_BASE}/accounts/${accountId}/registrar/domain-check`,
    token,
    body: { domains },
  });
  if (resp.statusCode !== 200) throw fail('CF_ERROR', cfError(resp, 'Domain check failed'));
  const result = (resp.json && resp.json.result) || {};
  const list = Array.isArray(result.domains) ? result.domains
    : (Array.isArray(resp.json.result) ? resp.json.result : []);
  return { domains: list.map(mapSearchDomain).filter(Boolean) };
}

async function listOwnedDomains(db) {
  const { token, accountId } = await creds(db);
  const resp = await apiRequest({
    method: 'GET',
    apiPath: `${API_BASE}/accounts/${accountId}/registrar/domains?page=1&per_page=50`,
    token,
  });
  if (resp.statusCode !== 200) throw fail('CF_ERROR', cfError(resp, 'Could not list registrar domains'));
  const list = Array.isArray(resp.json && resp.json.result) ? resp.json.result : [];
  return {
    domains: list.map((row) => ({
      domain: normalizeDomain(row.name || row.domain_name) || String(row.name || ''),
      status: row.status || row.state || null,
      expiresAt: row.expires_at || row.expiresAt || null,
      autoRenew: row.auto_renew != null ? !!row.auto_renew : null,
    })).filter((d) => d.domain),
  };
}

async function registerDomain(db, domainName, opts = {}) {
  ensureTables(db);
  const domain = normalizeDomain(domainName);
  if (!domain) throw fail('INVALID', 'Invalid domain name.');
  const years = Math.min(10, Math.max(1, Number(opts.years) || 1));
  const websiteId = opts.websiteId != null ? Number(opts.websiteId) : null;
  const leadId = opts.leadId != null ? Number(opts.leadId) : null;

  // Real-time check before billable register
  const checked = await checkDomains(db, [domain]);
  const hit = (checked.domains || []).find((d) => d.domain === domain);
  if (!hit || !hit.registrable) {
    throw fail('NOT_REGISTRABLE', hit && hit.reason
      ? `Cannot register ${domain}: ${hit.reason}`
      : `${domain} is not available for registration via Cloudflare Registrar.`);
  }

  const { token, accountId } = await creds(db);
  const body = { domain_name: domain, years };
  const resp = await apiRequest({
    method: 'POST',
    apiPath: `${API_BASE}/accounts/${accountId}/registrar/registrations`,
    token,
    body,
    timeoutMs: 90000,
  });
  if (resp.statusCode !== 200 && resp.statusCode !== 201 && resp.statusCode !== 202) {
    throw fail('CF_ERROR', cfError(resp, 'Domain registration failed'));
  }

  const result = (resp.json && resp.json.result) || resp.json || {};
  const state = result.state || (result.completed ? 'succeeded' : 'in_progress');
  const row = db.prepare(`
    INSERT INTO site_domains
      (website_id, lead_id, domain_name, status, source, years, price, currency, registration_state, meta, updated_at)
    VALUES (?, ?, ?, ?, 'registrar', ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    Number.isInteger(websiteId) ? websiteId : null,
    Number.isInteger(leadId) ? leadId : null,
    domain,
    state === 'succeeded' ? 'registered' : 'registering',
    years,
    hit.registrationCost || null,
    hit.currency || null,
    state,
    JSON.stringify({ check: hit, workflow: result })
  );

  if (Number.isInteger(leadId) && leadId > 0) {
    try {
      const outreach = require('./outreach');
      if (typeof outreach.recordIntent === 'function') {
        outreach.recordIntent(db, leadId, 'domain.purchased', `Registered ${domain} via Cloudflare`);
      } else {
        db.prepare(
          'INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)'
        ).run(leadId, 'domain.purchased', `Registered ${domain}`);
      }
    } catch {
      try {
        db.prepare(
          'INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)'
        ).run(leadId, 'domain.purchased', `Registered ${domain}`);
      } catch { /* */ }
    }
  }

  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'domains',
      `Domain register started: ${domain} (state=${state})`
    );
  } catch { /* */ }

  return {
    id: row.lastInsertRowid,
    domain,
    status: state === 'succeeded' ? 'registered' : 'registering',
    registrationState: state,
    price: hit.registrationCost || null,
    currency: hit.currency || null,
    years,
    workflow: result,
  };
}

async function registrationStatus(db, domainName) {
  ensureTables(db);
  const domain = normalizeDomain(domainName);
  if (!domain) throw fail('INVALID', 'Invalid domain name.');
  const { token, accountId } = await creds(db);
  const resp = await apiRequest({
    method: 'GET',
    apiPath: `${API_BASE}/accounts/${accountId}/registrar/registrations/${encodeURIComponent(domain)}/registration-status`,
    token,
  });
  if (resp.statusCode !== 200) throw fail('CF_ERROR', cfError(resp, 'Could not get registration status'));
  const result = (resp.json && resp.json.result) || {};
  const state = result.state || null;
  const local = db.prepare('SELECT * FROM site_domains WHERE domain_name = ? ORDER BY id DESC LIMIT 1').get(domain);
  if (local) {
    let status = local.status;
    if (state === 'succeeded') status = local.website_id ? (local.status === 'linked' ? 'linked' : 'registered') : 'registered';
    if (state === 'failed') status = 'failed';
    db.prepare(`
      UPDATE site_domains SET status = ?, registration_state = ?, error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      status,
      state,
      state === 'failed' ? (result.error && result.error.message) || 'Registration failed' : null,
      local.id
    );
  }
  return { domain, state, completed: !!result.completed, workflow: result };
}

async function pagesAddDomain(db, projectName, domainName) {
  const { token, accountId } = await creds(db);
  const project = String(projectName || '').trim().toLowerCase();
  const domain = normalizeDomain(domainName);
  if (!project) throw fail('INVALID', 'Pages project name is required.');
  if (!domain) throw fail('INVALID', 'Invalid domain name.');
  const resp = await apiRequest({
    method: 'POST',
    apiPath: `${API_BASE}/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/domains`,
    token,
    body: { name: domain },
  });
  if (resp.statusCode !== 200 && resp.statusCode !== 201) {
    throw fail('CF_ERROR', cfError(resp, 'Could not attach domain to Pages project'));
  }
  return (resp.json && resp.json.result) || { name: domain };
}

async function pagesListDomains(db, projectName) {
  const { token, accountId } = await creds(db);
  const project = String(projectName || '').trim().toLowerCase();
  if (!project) throw fail('INVALID', 'Pages project name is required.');
  const resp = await apiRequest({
    method: 'GET',
    apiPath: `${API_BASE}/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/domains`,
    token,
  });
  if (resp.statusCode !== 200) throw fail('CF_ERROR', cfError(resp, 'Could not list Pages domains'));
  const list = Array.isArray(resp.json && resp.json.result) ? resp.json.result : [];
  return {
    project,
    domains: list.map((d) => ({
      name: d.name || d,
      status: d.status || null,
      verificationData: d.verification_data || d.verificationData || null,
    })),
  };
}

async function pagesDeleteDomain(db, projectName, domainName) {
  const { token, accountId } = await creds(db);
  const project = String(projectName || '').trim().toLowerCase();
  const domain = normalizeDomain(domainName);
  if (!project || !domain) throw fail('INVALID', 'Project and domain are required.');
  const resp = await apiRequest({
    method: 'DELETE',
    apiPath: `${API_BASE}/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}`,
    token,
  });
  if (resp.statusCode !== 200 && resp.statusCode !== 204) {
    throw fail('CF_ERROR', cfError(resp, 'Could not remove Pages domain'));
  }
  return { ok: true, project, domain };
}

/**
 * Attach a domain to a website's Pages project and store the link.
 * Publishes the site first when needed so a project exists.
 */
async function linkDomainToWebsite(db, opts = {}) {
  ensureTables(db);
  const domain = normalizeDomain(opts.domain);
  if (!domain) throw fail('INVALID', 'Invalid domain name.');
  const websiteId = Number(opts.websiteId);
  if (!Number.isInteger(websiteId) || websiteId <= 0) {
    throw fail('INVALID', 'websiteId is required.');
  }
  const engine = require('./websiteEngine');
  const site = engine.getWebsite(db, websiteId);
  const leadId = opts.leadId != null ? Number(opts.leadId) : (site.lead_id != null ? Number(site.lead_id) : null);

  let project = typeof opts.project === 'string' && opts.project.trim()
    ? opts.project.trim().toLowerCase()
    : '';
  if (!project) {
    project = cf.resolveProjectName(db, websiteId, null, opts.workspaceId);
  }
  if (!project) throw fail('NO_PROJECT', 'Could not resolve a Cloudflare Pages project for this site. Publish a preview first.');

  // Ensure project exists by publishing when preview is missing/local.
  const needsPublish = !site.preview_url || cf.isLocalPreviewUrl(site.preview_url) || opts.forcePublish;
  if (needsPublish && typeof opts.publishFn === 'function') {
    await opts.publishFn(websiteId, project);
  }

  const attached = await pagesAddDomain(db, project, domain);
  const publicUrl = `https://${domain}`;

  db.prepare(`
    UPDATE websites SET custom_domain = ?, preview_url = ?, updated_at = datetime('now') WHERE id = ?
  `).run(domain, publicUrl, websiteId);

  const existing = db.prepare(
    'SELECT id FROM site_domains WHERE domain_name = ? ORDER BY id DESC LIMIT 1'
  ).get(domain);
  if (existing) {
    db.prepare(`
      UPDATE site_domains SET website_id = ?, lead_id = ?, status = 'linked', pages_project = ?,
        public_url = ?, source = COALESCE(source, 'link'), error = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(websiteId, leadId, project, publicUrl, existing.id);
  } else {
    db.prepare(`
      INSERT INTO site_domains
        (website_id, lead_id, domain_name, status, source, pages_project, public_url, updated_at)
      VALUES (?, ?, ?, 'linked', ?, ?, ?, datetime('now'))
    `).run(websiteId, leadId, domain, opts.source || 'link', project, publicUrl);
  }

  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'domains',
      `Linked ${domain} → website #${websiteId} (project ${project})`
    );
  } catch { /* */ }

  return {
    websiteId,
    domain,
    project,
    publicUrl,
    pages: attached,
  };
}

async function unlinkDomain(db, opts = {}) {
  ensureTables(db);
  const domain = normalizeDomain(opts.domain);
  if (!domain) throw fail('INVALID', 'Invalid domain name.');
  const row = db.prepare(
    'SELECT * FROM site_domains WHERE domain_name = ? ORDER BY id DESC LIMIT 1'
  ).get(domain);
  const project = (opts.project || (row && row.pages_project) || '').trim().toLowerCase();
  if (project && opts.removeFromPages !== false) {
    try { await pagesDeleteDomain(db, project, domain); } catch { /* best effort */ }
  }
  if (row && row.website_id) {
    const site = db.prepare('SELECT id, custom_domain, preview_url FROM websites WHERE id = ?').get(row.website_id);
    if (site && String(site.custom_domain || '').toLowerCase() === domain) {
      db.prepare(
        `UPDATE websites SET custom_domain = NULL, updated_at = datetime('now') WHERE id = ?`
      ).run(site.id);
    }
  }
  if (row) {
    db.prepare(`
      UPDATE site_domains SET status = 'unlinked', updated_at = datetime('now') WHERE id = ?
    `).run(row.id);
  }
  return { ok: true, domain };
}

function listLinked(db, opts = {}) {
  ensureTables(db);
  const clauses = ['1=1'];
  const params = [];
  if (opts.websiteId != null) {
    clauses.push('website_id = ?');
    params.push(Number(opts.websiteId));
  }
  if (opts.leadId != null) {
    clauses.push('lead_id = ?');
    params.push(Number(opts.leadId));
  }
  if (opts.status) {
    clauses.push('status = ?');
    params.push(String(opts.status));
  } else {
    clauses.push("status IN ('linked','registered','registering','pending')");
  }
  return db.prepare(
    `SELECT * FROM site_domains WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT 200`
  ).all(...params).map(publicRow);
}

function publicRow(row) {
  if (!row) return null;
  let meta = row.meta;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = null; }
  }
  return {
    id: row.id,
    websiteId: row.website_id,
    leadId: row.lead_id,
    domain: row.domain_name,
    status: row.status,
    source: row.source,
    years: row.years,
    price: row.price,
    currency: row.currency,
    pagesProject: row.pages_project,
    publicUrl: row.public_url,
    registrationState: row.registration_state,
    error: row.error,
    meta,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function recordSearchIntent(db, leadId, query) {
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0) return;
  try {
    db.prepare(
      'INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)'
    ).run(id, 'domain.searched', `Searched domains: ${String(query || '').slice(0, 120)}`);
  } catch { /* */ }
}

module.exports = {
  ensureTables,
  normalizeDomain,
  searchDomains,
  checkDomains,
  listOwnedDomains,
  registerDomain,
  registrationStatus,
  pagesAddDomain,
  pagesListDomains,
  pagesDeleteDomain,
  linkDomainToWebsite,
  unlinkDomain,
  listLinked,
  recordSearchIntent,
  DOMAIN_RE,
};
