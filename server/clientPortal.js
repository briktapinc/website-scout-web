'use strict';

/**
 * Client portal — end-customer identity (separate from staff workspace users).
 * Linked by contact email on leads / design jobs / social campaigns.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { query, driver } = require('./db');
const { sendPlatformMail } = require('./mailer');
const { appUrl } = require('./stripeClient');
const { openWorkspaceDb, dataRoot } = require('./workspaceDb');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function generatePassword() {
  // 12 chars, URL-safe, easy to copy from email
  return crypto.randomBytes(9).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** Per-email rate limit for requestAccess (in addition to IP limiter on the route). */
const accessEmailHits = new Map(); // email -> { n, resetAt }
function allowAccessEmail(email) {
  const key = String(email || '');
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const max = 3;
  let row = accessEmailHits.get(key);
  if (!row || now >= row.resetAt) {
    row = { n: 0, resetAt: now + windowMs };
    accessEmailHits.set(key, row);
  }
  if (row.n >= max) return false;
  row.n += 1;
  if (accessEmailHits.size > 5000) {
    for (const [k, v] of accessEmailHits) {
      if (now >= v.resetAt) accessEmailHits.delete(k);
    }
  }
  return true;
}

async function findById(id) {
  const rows = await query(
    `SELECT id, email, password_hash, workspace_id, lead_id, business_name, status,
            last_login_at, created_at, updated_at
     FROM client_portal_users WHERE id = :id LIMIT 1`,
    { id: Number(id) }
  );
  return rows[0] || null;
}

async function findByEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  const rows = await query(
    `SELECT id, email, password_hash, workspace_id, lead_id, business_name, status,
            last_login_at, created_at, updated_at
     FROM client_portal_users WHERE email = :email LIMIT 1`,
    { email: e }
  );
  return rows[0] || null;
}

/** Active portal login email for a lead — platform DB only (never workspace SQLite). */
async function activeEmailForLead(workspaceId, leadId) {
  const ws = Number(workspaceId);
  const lid = Number(leadId);
  if (!ws || !lid) return '';
  try {
    const rows = await query(
      `SELECT email FROM client_portal_users
       WHERE workspace_id = :ws AND lead_id = :lead AND status = 'active'
       ORDER BY id DESC LIMIT 1`,
      { ws, lead: lid }
    );
    return rows[0] ? normalizeEmail(rows[0].email) : '';
  } catch (e) {
    console.warn('[clientPortal] activeEmailForLead:', e.message || e);
    return '';
  }
}

/**
 * Portal entitlement: lead must already have a website and/or design job.
 * Random outreach leads without a project must not self-provision portal access.
 */
function leadHasPortalEntitlement(db, leadId) {
  const id = Number(leadId);
  if (!id) return false;
  try {
    const site = db.prepare('SELECT id FROM websites WHERE lead_id = ? LIMIT 1').get(id);
    if (site) return true;
  } catch { /* optional table */ }
  try {
    const job = db.prepare('SELECT id FROM design_jobs WHERE lead_id = ? LIMIT 1').get(id);
    if (job) return true;
  } catch { /* optional table */ }
  return false;
}

/** Scan workspace SQLite DBs for an entitled lead/contact matching this email. */
function findLeadMatches(email) {
  const e = normalizeEmail(email);
  if (!e) return [];
  const root = dataRoot();
  if (!fs.existsSync(root)) return [];

  const matches = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => Number(d.name));
  } catch {
    return [];
  }

  for (const workspaceId of dirs) {
    const dbFile = path.join(root, String(workspaceId), 'websitescout.db');
    if (!fs.existsSync(dbFile)) continue;
    let db;
    try {
      db = openWorkspaceDb(workspaceId);
    } catch {
      continue;
    }

    const seenLead = new Set();
    const pushMatch = (leadId, businessName, source) => {
      const id = Number(leadId);
      if (!id || seenLead.has(id)) return;
      if (!leadHasPortalEntitlement(db, id)) return;
      seenLead.add(id);
      matches.push({
        workspaceId,
        leadId: id,
        businessName: businessName || '',
        source,
      });
    };

    try {
      const byLead = db.prepare(
        `SELECT id, business_name, email, city, state, status
         FROM leads WHERE lower(trim(email)) = ? LIMIT 20`
      ).all(e);
      for (const lead of byLead) {
        pushMatch(lead.id, lead.business_name || '', 'lead');
      }
    } catch { /* table missing */ }

    try {
      const byJob = db.prepare(
        `SELECT j.id AS job_id, j.lead_id, j.contact_email, j.title,
                l.business_name
         FROM design_jobs j
         LEFT JOIN leads l ON l.id = j.lead_id
         WHERE lower(trim(j.contact_email)) = ? AND j.lead_id IS NOT NULL
         ORDER BY j.id DESC LIMIT 20`
      ).all(e);
      for (const row of byJob) {
        pushMatch(row.lead_id, row.business_name || row.title || '', 'design_job');
      }
    } catch { /* optional */ }

    try {
      const bySocial = db.prepare(
        `SELECT c.lead_id, c.client_email, l.business_name
         FROM social_campaigns c
         LEFT JOIN leads l ON l.id = c.lead_id
         WHERE lower(trim(c.client_email)) = ? AND c.lead_id IS NOT NULL
         ORDER BY c.id DESC LIMIT 20`
      ).all(e);
      for (const row of bySocial) {
        pushMatch(row.lead_id, row.business_name || '', 'social');
      }
    } catch { /* optional */ }
  }

  return matches;
}

/**
 * Request access: only for existing portal users or a uniquely matched entitled lead.
 * Sends a one-time magic sign-in link (never invents/emails a password).
 * Always returns a generic { ok: true } — no enumeration of whether the email exists.
 */
async function requestAccess(email) {
  const e = normalizeEmail(email);
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw Object.assign(new Error('Enter a valid email address'), { code: 'INVALID_EMAIL' });
  }

  // Uniform ok for rate-limited / unknown / disabled / not entitled — no enumeration.
  if (!allowAccessEmail(e)) {
    return { ok: true };
  }

  let existing = await findByEmail(e);
  let match = null;

  // Admin-disabled accounts must not self-reactivate via "request access".
  if (existing && String(existing.status || '') === 'disabled') {
    return { ok: true };
  }

  if (existing && existing.workspace_id && existing.lead_id) {
    // Already provisioned portal user — entitled by prior binding.
    match = {
      workspaceId: existing.workspace_id,
      leadId: existing.lead_id,
      businessName: existing.business_name || '',
    };
  } else {
    const matches = findLeadMatches(e);
    // Unknown / not entitled / ambiguous: do nothing (still generic ok).
    if (!matches.length || matches.length > 1) {
      return { ok: true };
    }
    match = matches[0];
  }

  const businessName = match.businessName || (existing && existing.business_name) || '';
  let portalUserId = existing ? existing.id : null;

  if (!existing) {
    // Unusable random hash only — never emailed. Sign-in is via magic link.
    const passwordHash = await bcrypt.hash(generatePassword(), 12);
    await query(
      `INSERT INTO client_portal_users
        (email, password_hash, workspace_id, lead_id, business_name, status)
       VALUES (:email, :hash, :ws, :lead, :name, 'active')`,
      {
        email: e,
        hash: passwordHash,
        ws: match.workspaceId,
        lead: match.leadId,
        name: businessName,
      }
    );
    existing = await findByEmail(e);
    portalUserId = existing && existing.id;
  }
  // Existing users: never rotate password on access request (prevents lockout attacks).

  if (!portalUserId) return { ok: true };

  const raw = crypto.randomBytes(24).toString('hex');
  const tokenHash = hashToken(raw);
  const expires = new Date(Date.now() + 30 * 60 * 1000);
  const expiresSql = expires.toISOString().slice(0, 19).replace('T', ' ');
  await query(
    'DELETE FROM client_portal_login_tokens WHERE portal_user_id = :uid',
    { uid: portalUserId }
  );
  await query(
    `INSERT INTO client_portal_login_tokens (portal_user_id, token_hash, expires_at)
     VALUES (:uid, :tokenHash, :expiresAt)`,
    { uid: portalUserId, tokenHash, expiresAt: expiresSql }
  );

  const magicUrl = `${appUrl()}/portal?magic=${encodeURIComponent(raw)}`;
  const safeName = businessName ? ` for ${businessName}` : '';
  try {
    await sendPlatformMail({
      to: e,
      subject: 'Your Bitpype client portal sign-in link',
      title: 'Client portal access',
      paragraphs: [
        `Use this link to sign in to the Bitpype client portal${safeName}.`,
        'This link expires in 30 minutes and can only be used once.',
        'If you did not request this, you can ignore this email. No password was created or changed.',
      ],
      cta: { url: magicUrl, label: 'Sign in to the portal' },
      text: `Bitpype client portal${safeName}\nSign in: ${magicUrl}\nExpires in 30 minutes.\n`,
    });
  } catch (err) {
    // Never put magic links or passwords in the HTTP response body.
    if (err.code === 'SMTP_NOT_CONFIGURED' && process.env.NODE_ENV !== 'production') {
      console.warn('[clientPortal] SMTP not configured — magic link (dev console only):', magicUrl);
    } else {
      console.warn('[clientPortal] email send failed:', err.message);
    }
  }

  return { ok: true };
}

async function loginWithMagicToken(rawToken) {
  const raw = String(rawToken || '').trim();
  if (!raw || raw.length < 16) {
    throw Object.assign(new Error('INVALID_CREDENTIALS'), { code: 'INVALID_CREDENTIALS' });
  }
  const tokenHash = hashToken(raw);
  const rows = await query(
    `SELECT t.id AS token_id, t.expires_at, t.used_at, u.id, u.email, u.workspace_id, u.lead_id,
            u.business_name, u.status
     FROM client_portal_login_tokens t
     JOIN client_portal_users u ON u.id = t.portal_user_id
     WHERE t.token_hash = :tokenHash LIMIT 1`,
    { tokenHash }
  );
  const row = rows[0];
  if (!row || row.used_at || String(row.status) !== 'active') {
    throw Object.assign(new Error('INVALID_CREDENTIALS'), { code: 'INVALID_CREDENTIALS' });
  }
  const exp = new Date(String(row.expires_at).replace(' ', 'T') + 'Z');
  if (Number.isFinite(exp.getTime()) && exp.getTime() < Date.now()) {
    throw Object.assign(new Error('INVALID_CREDENTIALS'), { code: 'INVALID_CREDENTIALS' });
  }
  await query(
    driver() === 'sqlite'
      ? "UPDATE client_portal_login_tokens SET used_at = datetime('now') WHERE id = :id"
      : 'UPDATE client_portal_login_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = :id',
    { id: row.token_id }
  );
  const stamp = driver() === 'sqlite'
    ? "UPDATE client_portal_users SET last_login_at = datetime('now') WHERE id = :id"
    : 'UPDATE client_portal_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = :id';
  await query(stamp, { id: row.id });
  return {
    id: row.id,
    email: row.email,
    workspaceId: row.workspace_id,
    leadId: row.lead_id,
    businessName: row.business_name || '',
  };
}

const DUMMY_PORTAL_HASH = bcrypt.hashSync('timing-pad-not-a-real-password', 12);

async function login(email, password) {
  const e = normalizeEmail(email);
  const user = await findByEmail(e);
  const hash = (user && String(user.status) === 'active') ? user.password_hash : DUMMY_PORTAL_HASH;
  const ok = await bcrypt.compare(String(password || ''), hash);
  if (!user || String(user.status) !== 'active' || !ok) {
    throw Object.assign(new Error('INVALID_CREDENTIALS'), { code: 'INVALID_CREDENTIALS' });
  }
  if (!user.workspace_id || !user.lead_id) {
    throw Object.assign(new Error('Portal account is not linked to a site yet'), {
      code: 'NOT_LINKED',
    });
  }

  const stamp = driver() === 'sqlite'
    ? "UPDATE client_portal_users SET last_login_at = datetime('now') WHERE id = :id"
    : 'UPDATE client_portal_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = :id';
  await query(stamp, { id: user.id });

  return {
    id: user.id,
    email: user.email,
    workspaceId: user.workspace_id,
    leadId: user.lead_id,
    businessName: user.business_name || '',
  };
}

function publicClient(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    workspaceId: user.workspace_id || user.workspaceId,
    leadId: user.lead_id || user.leadId,
    businessName: user.business_name || user.businessName || '',
  };
}

function loadLeadContext(workspaceId, leadId) {
  const domain = require('./domain');
  return domain.withDb(workspaceId, (db) => {
    const lead = db.prepare(
      `SELECT id, business_name, category, email, phone, city, state, website, status
       FROM leads WHERE id = ? LIMIT 1`
    ).get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }

    let site = null;
    try {
      site = db.prepare(
        `SELECT id, name, status, preview_url, preview_path, updated_at
         FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
      ).get(lead.id);
    } catch { /* optional */ }

    let designJob = null;
    try {
      designJob = db.prepare(
        `SELECT id, title, type, status, client_form_token, contact_email, updated_at
         FROM design_jobs WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
      ).get(lead.id);
    } catch { /* optional */ }

    const previewUrl = resolvePreviewUrl(site);
    return { lead, site, designJob, previewUrl };
  });
}

function resolvePreviewUrl(site) {
  if (!site) return null;
  if (site.preview_url && String(site.preview_url).trim()) {
    return String(site.preview_url).trim();
  }
  if (site.preview_path && String(site.preview_path).trim()) {
    const p = String(site.preview_path).replace(/\\/g, '/');
    const m = p.match(/website-scout-exports\/([^/]+)/i)
      || p.match(/\/([^/]+-site-[^/]+)\/?$/i);
    if (m) {
      return `${appUrl()}/site-previews/${m[1]}/`;
    }
    // Absolute export folder name as last path segment
    const parts = p.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && /site|ws-/i.test(last)) {
      return `${appUrl()}/site-previews/${last}/`;
    }
  }
  return null;
}

/**
 * Base URL for srcdoc asset resolution. Prefer APP_URL /site-previews/…
 * (local rematerialized export) over Cloudflare preview_url so portal image
 * uploads are visible immediately without a Pages republish.
 * Folder must match materializeWebsiteExport (ws-{ws}-site-{id}-{export_slug}).
 */
function resolveExportPreviewBase(workspaceId, site) {
  if (!site || site.id == null) return resolvePreviewUrl(site);
  const base = String(appUrl() || '').replace(/\/+$/, '');
  if (!base) return resolvePreviewUrl(site);
  if (site.preview_path && String(site.preview_path).trim()) {
    const p = String(site.preview_path).replace(/\\/g, '/');
    // Prefer full folder segment (includes export_slug). Avoid bare ws-N-site-M
    // which truncates slug folders like ws-1-site-1-c59b… → ws-1-site-1.
    const m = p.match(/website-scout-exports\/([^/]+)/i)
      || p.match(/\/(ws-\d+-site-\d+(?:-[A-Za-z0-9_-]+)?)(?:\/|$)/i);
    if (m) return `${base}/site-previews/${m[1]}/`;
  }
  try {
    const domain = require('./domain');
    const folder = domain.resolveSiteExportFolder(workspaceId, site);
    return `${base}/site-previews/${folder}/`;
  } catch { /* fall through */ }
  const folder = `ws-${Number(workspaceId)}-site-${Number(site.id)}`;
  return `${base}/site-previews/${folder}/`;
}

/** Paths clients must not change via inline portal edit (verified facts / URLs). */
const PORTAL_LOCKED_PATH = /(^|\.)(phone|phone_display|email|address|address_lines|hours|rating|review_count|business_name|href|cta_href|cta_secondary_href|button_href|url|photographer|photographer_url|pexels_url)$/;

function isPortalLockedPath(path) {
  return PORTAL_LOCKED_PATH.test(String(path || ''));
}

function setContentPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (cur[key] == null || typeof cur[key] !== 'object') {
      cur[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    cur = cur[key];
  }
  const last = parts[parts.length - 1];
  cur[/^\d+$/.test(last) ? Number(last) : last] = value;
}

function pagesHaveEditableSections(pages) {
  return Array.isArray(pages)
    && pages.some((p) => Array.isArray(p.sections) && p.sections.length > 0);
}

/** Section model or freeform page.html — both support portal inline text edit. */
function pagesSupportInlineEdit(pages) {
  return Array.isArray(pages) && pages.some((p) =>
    (Array.isArray(p.sections) && p.sections.length > 0)
    || (typeof p.html === 'string' && p.html.trim())
  );
}

function pagesHaveFreeformHtml(pages) {
  return Array.isArray(pages)
    && pages.some((p) => typeof p.html === 'string' && p.html.trim());
}

function parseJsonSafe(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Resolve the client's site for their linked lead only (workspace + lead scoped).
 */
function resolveClientSite(db, leadId) {
  const lid = Number(leadId);
  let site = null;
  try {
    site = db.prepare(
      `SELECT id, lead_id, name, status, pages, theme, preview_url, preview_path, export_slug, updated_at
       FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
    ).get(lid);
  } catch (e) {
    // Older workspace DBs may lack export_slug until ensureExportSlug runs.
    if (!/no such column:\s*export_slug/i.test(String(e && e.message || e))) throw e;
    try {
      const domain = require('./domain');
      if (typeof domain.ensureExportSlugColumn === 'function') {
        domain.ensureExportSlugColumn(db);
      } else if (typeof domain.ensureExportSlug === 'function') {
        // ensureExportSlug needs a site id — add column first via bare ALTER.
        try { db.exec('ALTER TABLE websites ADD COLUMN export_slug TEXT'); } catch { /* exists */ }
      }
    } catch { /* best-effort */ }
    try {
      site = db.prepare(
        `SELECT id, lead_id, name, status, pages, theme, preview_url, preview_path, export_slug, updated_at
         FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
      ).get(lid);
    } catch {
      site = db.prepare(
        `SELECT id, lead_id, name, status, pages, theme, preview_url, preview_path, updated_at
         FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
      ).get(lid);
    }
  }
  if (!site) return null;
  return {
    id: site.id,
    lead_id: site.lead_id,
    name: site.name,
    status: site.status,
    pages: parseJsonSafe(site.pages, []),
    theme: parseJsonSafe(site.theme, {}) || {},
    preview_url: site.preview_url,
    preview_path: site.preview_path,
    export_slug: site.export_slug || null,
    updated_at: site.updated_at,
  };
}

/**
 * Render the client's website HTML with editable markers (data-edit / ws-edit).
 * Ownership: workspaceId + leadId from the portal session only.
 */
function renderClientSite(workspaceId, leadId, opts = {}) {
  const domain = require('./domain');
  const leadOk = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available to edit yet'), { code: 'NO_SITE' });
    }
    return site;
  });
  const editableWanted = opts.editable !== false;
  const canInlineEdit = editableWanted && pagesSupportInlineEdit(leadOk.pages);
  const rendered = domain.sitesRenderHtml(workspaceId, leadOk.id, {
    editable: canInlineEdit,
    pageSlug: opts.pageSlug,
    pageIndex: opts.pageIndex,
  });
  const previewUrl = resolvePreviewUrl(leadOk);
  const assetBase = resolveExportPreviewBase(workspaceId, leadOk);
  const engine = require('../src/websiteEngine');
  // srcdoc has no document URL — relative images/… need a preview base.
  const html = (canInlineEdit && assetBase)
    ? engine.injectPreviewBaseHref(rendered.html, assetBase)
    : rendered.html;
  const theme = leadOk.theme && typeof leadOk.theme === 'object' ? leadOk.theme : {};
  const normalized = engine.normalizeTheme(theme);
  const themePalette = require('../src/themePalette');
  const { palette } = themePalette.extractPalette(leadOk.pages, normalized);
  const logoMode = String(theme.logoMode || 'text').toLowerCase() === 'image' && theme.logoUrl
    ? 'image'
    : 'text';
  const logoUrl = theme.logoUrl ? String(theme.logoUrl) : '';
  const logoPublicUrl = logoUrl && assetBase
    ? `${String(assetBase).replace(/\/+$/, '')}/${logoUrl.replace(/^\.?\//, '')}`
    : (logoUrl && previewUrl
      ? `${String(previewUrl).replace(/\/+$/, '')}/${logoUrl.replace(/^\.?\//, '')}`
      : null);
  return {
    siteId: leadOk.id,
    name: leadOk.name,
    editable: canInlineEdit,
    freeform: pagesHaveFreeformHtml(leadOk.pages),
    previewUrl,
    assetBase,
    html,
    pages: rendered.pages,
    theme: {
      primary: normalized.primary,
      secondary: normalized.secondary,
      bg: normalized.bg,
      text: normalized.text,
      font: normalized.font,
      headingFont: normalized.headingFont || '',
      palette,
    },
    logo: {
      mode: logoMode,
      url: logoUrl || null,
      publicUrl: logoPublicUrl,
      brandName: theme.brandName || null,
    },
  };
}

const THEME_COLOR_KEYS = ['primary', 'secondary', 'bg', 'text'];

function normalizePortalHex(value) {
  let s = String(value == null ? '' : value).trim();
  if (!s) return null;
  if (s[0] !== '#') s = `#${s}`;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return null;
  return s.toLowerCase();
}

function rewriteThemeHexInCss(css, oldTheme, newTheme) {
  const themePalette = require('../src/themePalette');
  const map = themePalette.buildReplacementMap(oldTheme, newTheme, []);
  return themePalette.rewriteHexMap(css, map);
}

/**
 * Update website theme colors from the client portal.
 * Merges primary/secondary/bg/text, rewrites matching hexes in customCss + page HTML,
 * optional replacements:[{from,to}] for extra palette colors, saves a new version.
 */
async function applyClientThemeColors(workspaceId, leadId, colors = {}) {
  const domain = require('./domain');
  const engine = require('../src/websiteEngine');
  const themePalette = require('../src/themePalette');
  const googleFonts = require('../public/js/fonts.js');
  const patch = {};
  for (const key of THEME_COLOR_KEYS) {
    if (colors[key] == null || colors[key] === '') continue;
    const hex = normalizePortalHex(colors[key]);
    if (!hex) {
      throw Object.assign(new Error(`Invalid ${key} color (use #RRGGBB)`), { code: 'INVALID_COLOR' });
    }
    patch[key] = hex;
  }
  if (colors.font != null && String(colors.font).trim()) {
    patch.font = googleFonts.safeStack(colors.font);
  }
  if (colors.headingFont != null) {
    const heading = String(colors.headingFont).trim();
    patch.headingFont = heading ? googleFonts.safeStack(heading) : '';
  }
  let elementPatch = null;
  if (colors.elementFonts && typeof colors.elementFonts === 'object' && !Array.isArray(colors.elementFonts)) {
    elementPatch = colors.elementFonts;
  }
  const replacements = Array.isArray(colors.replacements) ? colors.replacements : [];
  if (!Object.keys(patch).length && !elementPatch && !replacements.length) {
    throw Object.assign(new Error('Provide at least one theme color, palette replacement, or font'), { code: 'EMPTY' });
  }

  const prepared = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available to edit yet'), { code: 'NO_SITE' });
    }
    const oldTheme = site.theme && typeof site.theme === 'object' ? site.theme : {};
    const oldNorm = engine.normalizeTheme(oldTheme);
    const map = themePalette.buildReplacementMap(oldNorm, patch, replacements);
    let theme = Object.assign({}, oldTheme, patch);
    if (elementPatch) {
      const prev = Object.assign({}, oldTheme.elementFonts || {});
      for (const [id, val] of Object.entries(elementPatch)) {
        if (!/^[\w:.-]{1,80}$/.test(id)) continue;
        if (val == null || val === '' || val === 'system') delete prev[id];
        else {
          const name = googleFonts.matchName(val);
          if (name) prev[id] = name;
        }
      }
      theme.elementFonts = prev;
    }
    if (typeof theme.customCss === 'string' && theme.customCss && Object.keys(map).length) {
      theme.customCss = themePalette.rewriteHexMap(theme.customCss, map);
    }
    let pages = site.pages;
    if (Object.keys(map).length) {
      const applied = themePalette.applyHexMapToPages(pages, map);
      pages = applied.pages;
    }
    const normalized = engine.normalizeTheme(theme);
    const { palette } = themePalette.extractPalette(pages, normalized);
    return {
      siteId: site.id,
      pages,
      theme,
      colors: {
        primary: normalized.primary,
        secondary: normalized.secondary,
        bg: normalized.bg,
        text: normalized.text,
        font: normalized.font,
        headingFont: normalized.headingFont || '',
        palette,
      },
      previewFallback: resolvePreviewUrl(site),
    };
  });

  const saved = domain.sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note: colors.font || colors.headingFont || elementPatch
      ? 'Client portal theme fonts'
      : 'Client portal theme colors',
  });

  syncDesignDeliverablePages(
    workspaceId,
    leadId,
    prepared.siteId,
    prepared.pages,
    prepared.theme
  );

  let previewUrl = prepared.previewFallback;
  let publicPreviewUpdated = false;
  try {
    const preview = await domain.sitesPreview(workspaceId, prepared.siteId, { force: true });
    if (preview && preview.url) {
      previewUrl = preview.url;
      publicPreviewUpdated = true;
    }
  } catch (e) {
    console.warn('[clientPortal] force preview after theme:', e.message);
    const previewRow = domain.withDb(workspaceId, (db) =>
      db.prepare('SELECT preview_url, preview_path FROM websites WHERE id = ?').get(prepared.siteId)
    );
    previewUrl = resolvePreviewUrl(previewRow) || prepared.previewFallback;
  }

  try {
    domain.intentRecord(workspaceId, Number(leadId), 'theme.colors', 'Client portal theme colors');
  } catch { /* optional */ }

  return {
    siteId: prepared.siteId,
    theme: prepared.colors,
    version: saved.version,
    previewUrl,
    publicPreviewUpdated,
  };
}

/**
 * Rematerialize the site export and refresh the public preview URL (Cloudflare Pages when configured).
 */
async function publishClientSitePreview(workspaceId, leadId) {
  const domain = require('./domain');
  const prepared = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available yet'), { code: 'NO_SITE' });
    }
    return {
      siteId: site.id,
      previewFallback: resolvePreviewUrl(site),
    };
  });

  const preview = await domain.sitesPreview(workspaceId, prepared.siteId, { force: true });
  const previewUrl = (preview && preview.url) || prepared.previewFallback;
  const via = (preview && preview.via) || 'unknown';
  return {
    siteId: prepared.siteId,
    previewUrl,
    via,
    publicPreviewUpdated: via === 'cloudflare' || via === 'app_url',
    folder: preview && preview.folder,
  };
}

/**
 * Apply text edits from portal postMessage ids (`page:section:path`).
 * Saves via sitesSave (re-materializes /site-previews) and syncs design deliverable when linked.
 */
async function applyClientTextEdits(workspaceId, leadId, edits) {
  const domain = require('./domain');
  const list = Array.isArray(edits) ? edits : [];
  if (!list.length) {
    throw Object.assign(new Error('No edits to save'), { code: 'EMPTY' });
  }
  if (list.length > 80) {
    throw Object.assign(new Error('Too many edits in one save'), { code: 'TOO_MANY' });
  }

  const prepared = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available to edit yet'), { code: 'NO_SITE' });
    }
    if (!pagesSupportInlineEdit(site.pages)) {
      throw Object.assign(
        new Error('This site layout does not support inline text edits. Use Request changes instead.'),
        { code: 'NOT_EDITABLE' }
      );
    }

    const engine = require('../src/websiteEngine');
    const pages = JSON.parse(JSON.stringify(site.pages));
    const theme = site.theme && typeof site.theme === 'object' ? site.theme : {};
    const applied = [];
    const skipped = [];
    /** @type {Map<number, Map<number, string>>} */
    const freeformByPage = new Map();
    /** @type {Map<string, Map<number, string>>} key = `${pi}:${si}` */
    const freeformBySection = new Map();

    for (const raw of list) {
      const id = String((raw && raw.id) || '').trim();
      const text = String((raw && raw.text) != null ? raw.text : '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4000);

      // Modular freestyle: html:pageIndex:sectionIndex:nodeIndex
      const freeSec = id.match(/^html:(\d+):(\d+):(\d+)$/);
      if (freeSec) {
        const pi = Number(freeSec[1]);
        const si = Number(freeSec[2]);
        const ni = Number(freeSec[3]);
        const page = pages[pi];
        const section = page && Array.isArray(page.sections) ? page.sections[si] : null;
        if (!section || !section.content || typeof section.content.html !== 'string') {
          skipped.push({ id, reason: 'missing' });
          continue;
        }
        const key = `${pi}:${si}`;
        if (!freeformBySection.has(key)) freeformBySection.set(key, new Map());
        freeformBySection.get(key).set(ni, text);
        applied.push(id);
        continue;
      }

      // Legacy freeform page.html: html:pageIndex:nodeIndex
      const free = id.match(/^html:(\d+):(\d+)$/);
      if (free) {
        const pi = Number(free[1]);
        const ni = Number(free[2]);
        const page = pages[pi];
        if (!page || typeof page.html !== 'string' || !page.html.trim()) {
          skipped.push({ id, reason: 'missing' });
          continue;
        }
        if (!freeformByPage.has(pi)) freeformByPage.set(pi, new Map());
        freeformByPage.get(pi).set(ni, text);
        applied.push(id);
        continue;
      }

      const m = id.match(/^(\d+):(\d+):(.+)$/);
      if (!m) {
        skipped.push({ id, reason: 'bad_id' });
        continue;
      }
      const pi = Number(m[1]);
      const si = Number(m[2]);
      const path = m[3];
      if (isPortalLockedPath(path)) {
        skipped.push({ id, reason: 'locked' });
        continue;
      }
      const page = pages[pi];
      const section = page && Array.isArray(page.sections) ? page.sections[si] : null;
      if (!section || !section.content || typeof section.content !== 'object') {
        skipped.push({ id, reason: 'missing' });
        continue;
      }
      setContentPath(section.content, path, text);
      applied.push(id);
    }

    for (const [key, nodeMap] of freeformBySection) {
      const [piStr, siStr] = key.split(':');
      const pi = Number(piStr);
      const si = Number(siStr);
      const section = pages[pi].sections[si];
      section.content.html = engine.applyFreeformTextEdits(section.content.html, nodeMap);
    }

    for (const [pi, nodeMap] of freeformByPage) {
      pages[pi].html = engine.applyFreeformTextEdits(pages[pi].html, nodeMap);
      try {
        const modules = require('./siteModules');
        if (typeof modules.ensureClientPageChrome === 'function') {
          pages[pi].html = modules.ensureClientPageChrome(pages[pi].html);
        }
      } catch { /* optional chrome upgrade */ }
    }

    if (!applied.length) {
      throw Object.assign(
        new Error(skipped.some((s) => s.reason === 'locked')
          ? 'Those fields are locked (contact details and links). Use Request changes for those.'
          : 'No valid text edits to apply'),
        { code: 'NO_VALID_EDITS' }
      );
    }

    return {
      siteId: site.id,
      pages,
      theme,
      applied,
      skipped,
      previewFallback: resolvePreviewUrl(site),
    };
  });

  // sitesSave rematerializes public /site-previews export folder.
  const saved = domain.sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note: 'Client portal inline edit',
  });

  domain.withDb(workspaceId, (db) => {
    try {
      const job = db.prepare(
        `SELECT id, website_id, deliverable FROM design_jobs
         WHERE lead_id = ? AND (website_id = ? OR website_id IS NULL)
         ORDER BY CASE WHEN website_id = ? THEN 0 ELSE 1 END, id DESC LIMIT 1`
      ).get(Number(leadId), prepared.siteId, prepared.siteId);
      if (job && job.deliverable) {
        const payload = parseJsonSafe(job.deliverable, null);
        if (payload && Array.isArray(payload.pages)) {
          payload.pages = prepared.pages;
          payload.theme = prepared.theme;
          db.prepare(
            `UPDATE design_jobs SET deliverable = ?, updated_at = datetime('now') WHERE id = ?`
          ).run(JSON.stringify(payload), job.id);
        }
      }
    } catch { /* optional sync */ }
  });

  let previewUrl = prepared.previewFallback;
  let publicPreviewUpdated = false;
  try {
    const preview = await domain.sitesPreview(workspaceId, prepared.siteId, { force: true });
    if (preview && preview.url) {
      previewUrl = preview.url;
      publicPreviewUpdated = true;
    }
  } catch (e) {
    console.warn('[clientPortal] force preview after edit:', e.message);
    const previewRow = domain.withDb(workspaceId, (db) =>
      db.prepare(`SELECT preview_url, preview_path FROM websites WHERE id = ?`).get(prepared.siteId)
    );
    previewUrl = resolvePreviewUrl(previewRow) || prepared.previewFallback;
  }

  return {
    siteId: prepared.siteId,
    applied: prepared.applied.length,
    skipped: prepared.skipped,
    version: saved.version,
    previewUrl,
    publicPreviewUpdated,
  };
}

const LIST_ITEM_MAX = 24;

function blankListItem(listKey, sectionType) {
  if (listKey === 'reviews') {
    return { name: 'Customer', text: 'Add your review text here.', stars: 5 };
  }
  if (listKey === 'paragraphs') {
    return 'Add a new paragraph here.';
  }
  if (sectionType === 'faq' || (listKey === 'items' && sectionType === 'faq')) {
    return { q: 'New question?', a: 'Add your answer here.' };
  }
  if (sectionType === 'services') {
    return { name: 'New service', description: 'Describe this service.' };
  }
  // benefits / generic cards
  return { title: 'New item', text: 'Describe this item.' };
}

/**
 * Add or delete an item in a section list (benefits/services/faq/reviews).
 * Body: { action: 'add'|'delete', pageIndex, sectionIndex, listKey, index? }
 */
function mutateClientListItem(workspaceId, leadId, body = {}) {
  const domain = require('./domain');
  const action = String(body.action || '').toLowerCase();
  if (action !== 'add' && action !== 'delete') {
    throw Object.assign(new Error('action must be add or delete'), { code: 'INVALID' });
  }
  const pageIndex = Number(body.pageIndex);
  const sectionIndex = Number(body.sectionIndex);
  const listKey = String(body.listKey || 'items').trim() || 'items';
  const index = Number(body.index);

  const prepared = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available to edit yet'), { code: 'NO_SITE' });
    }
    const pages = JSON.parse(JSON.stringify(site.pages));
    const page = pages[pageIndex];
    if (!page || !Array.isArray(page.sections)) {
      throw Object.assign(new Error('Page not found'), { code: 'NOT_FOUND' });
    }
    const section = page.sections[sectionIndex];
    if (!section || !section.content || typeof section.content !== 'object') {
      throw Object.assign(new Error('Section not found'), { code: 'NOT_FOUND' });
    }
    let list = section.content[listKey];
    if (!Array.isArray(list)) {
      // faq/services/benefits use items; reviews use reviews
      if (listKey === 'items' && Array.isArray(section.content.reviews)) list = section.content.reviews;
      else {
        section.content[listKey] = [];
        list = section.content[listKey];
      }
    }
    if (action === 'add') {
      if (list.length >= LIST_ITEM_MAX) {
        throw Object.assign(new Error('Maximum items reached'), { code: 'TOO_MANY' });
      }
      list.push(blankListItem(listKey, section.type));
    } else {
      if (list.length <= 1) {
        throw Object.assign(new Error('Keep at least one item'), { code: 'LAST_ITEM' });
      }
      if (!Number.isInteger(index) || index < 0 || index >= list.length) {
        throw Object.assign(new Error('Invalid item index'), { code: 'INVALID' });
      }
      list.splice(index, 1);
    }
    section.content[listKey] = list;
    return {
      siteId: site.id,
      pages,
      theme: site.theme && typeof site.theme === 'object' ? site.theme : {},
      previewFallback: resolvePreviewUrl(site),
    };
  });

  const saved = domain.sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note: action === 'add' ? 'Client portal: added list item' : 'Client portal: removed list item',
  });
  syncDesignDeliverablePages(workspaceId, leadId, prepared.siteId, prepared.pages, prepared.theme);
  const previewRow = domain.withDb(workspaceId, (db) =>
    db.prepare(`SELECT preview_url, preview_path FROM websites WHERE id = ?`).get(prepared.siteId)
  );
  return {
    siteId: prepared.siteId,
    action,
    version: saved.version,
    previewUrl: resolvePreviewUrl(previewRow) || prepared.previewFallback,
  };
}

/**
 * Forms and site modules placed on a page are one module block.
 * Delete turns embedding off so the next save does not put the block back.
 * Undo turns it on again.
 */
function applyEmbedPlacement(db, leadId, body) {
  const remove = body && body.embedRemove;
  const restore = body && body.embedRestore;
  const change = (remove && remove.kind) ? remove : ((restore && restore.kind) ? restore : null);
  if (!change) return;
  const on = !remove;
  const lid = Number(leadId);
  if (change.kind === 'module' && change.moduleType) {
    const type = String(change.moduleType).trim().toLowerCase();
    db.prepare(
      `UPDATE site_module_embeds
       SET published = ?, embed_enabled = ?, updated_at = datetime('now')
       WHERE lead_id = ? AND module_type = ?`
    ).run(on ? 1 : 0, on ? 1 : 0, lid, type);
    return;
  }
  if (change.kind === 'form' && change.token) {
    db.prepare(
      `UPDATE contact_forms
       SET embed_enabled = ?, updated_at = datetime('now')
       WHERE lead_id = ? AND public_token = ?`
    ).run(on ? 1 : 0, lid, String(change.token));
  }
}

/**
 * Replace freeform page.html after client-side clone/delete of a list block.
 * Body: { pageIndex, html }
 */
function saveClientPageHtml(workspaceId, leadId, body = {}) {
  const domain = require('./domain');
  const engine = require('../src/websiteEngine');
  const pageIndex = Number(body.pageIndex);
  const sectionIndexRaw = body.sectionIndex != null ? Number(body.sectionIndex) : NaN;
  let html = String(body.html || '');
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw Object.assign(new Error('Invalid pageIndex'), { code: 'INVALID' });
  }
  if (!html.trim()) {
    throw Object.assign(new Error('Empty HTML'), { code: 'EMPTY' });
  }
  if (html.length > 1_500_000) {
    throw Object.assign(new Error('HTML too large'), { code: 'TOO_LARGE' });
  }
  // Sanitize; drop edit chrome if any leaked through
  if (typeof engine.sanitizeHtml === 'function') {
    html = engine.sanitizeHtml(html);
  }
  html = html
    .replace(/<button\b[^>]*class="[^"]*ws-(?:add|del|ff)-[^"]*"[^>]*>[\s\S]*?<\/button>/gi, '')
    .replace(/\sdata-edit="[^"]*"/gi, '')
    .replace(/\sclass="ws-edit"/gi, '');

  const prepared = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available to edit yet'), { code: 'NO_SITE' });
    }
    const pages = JSON.parse(JSON.stringify(site.pages));
    const page = pages[pageIndex];
    if (!page) throw Object.assign(new Error('Page not found'), { code: 'NOT_FOUND' });

    const usesSections = Array.isArray(page.sections) && page.sections.length > 0;
    if (usesSections) {
      if (body.sectionIndex == null) {
        throw Object.assign(new Error('Select the original page section before saving this edit'), { code: 'SECTION_CONTEXT_REQUIRED', status: 409 });
      }
      const si = sectionIndexRaw;
      if (!Number.isInteger(si) || si < 0 || !page.sections[si]?.content || typeof page.sections[si].content.html !== 'string') {
        throw Object.assign(new Error('The selected HTML section is unavailable'), { code: 'NOT_FREEFORM', status: 409 });
      }
      const sec = page.sections[si];
      sec.content = Object.assign({}, sec.content || {}, { html });
      if (typeof page.html === 'string') delete page.html;
      applyEmbedPlacement(db, leadId, body);
      const theme = site.theme && typeof site.theme === 'object' ? site.theme : {};
      return {
        siteId: site.id,
        pages,
        theme,
        previewFallback: resolvePreviewUrl(site),
      };
    }

    if (typeof page.html !== 'string' || !page.html.trim()) {
      throw Object.assign(new Error('This page is not freeform HTML'), { code: 'NOT_FREEFORM' });
    }
    const original = page.html;
    // Prefer file hrefs in stored HTML (strip preview-only #page anchors when multipage).
    html = engine.normalizePagesNavLinks(
      pages.map((p, i) => (i === pageIndex ? { ...p, html } : p))
    )[pageIndex].html;
    if (/<body\b/i.test(original) || /<!DOCTYPE/i.test(original) || /<html\b/i.test(original)) {
      const split = original.match(/(<body\b[^>]*>)([\s\S]*)(<\/body\s*>)/i);
      if (split) {
        page.html = original.replace(split[0], `${split[1]}${html}${split[3]}`);
      } else {
        page.html = html;
      }
    } else {
      page.html = html;
    }
    try {
      const modules = require('./siteModules');
      if (typeof modules.ensureClientPageChrome === 'function') {
        page.html = modules.ensureClientPageChrome(page.html);
      }
    } catch { /* optional chrome upgrade */ }
    applyEmbedPlacement(db, leadId, body);
    return {
      siteId: site.id,
      pages,
      theme: site.theme && typeof site.theme === 'object' ? site.theme : {},
      previewFallback: resolvePreviewUrl(site),
    };
  });

  const saved = domain.sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note: 'Client portal: list item change',
  });
  syncDesignDeliverablePages(workspaceId, leadId, prepared.siteId, prepared.pages, prepared.theme);
  const previewRow = domain.withDb(workspaceId, (db) =>
    db.prepare(`SELECT preview_url, preview_path FROM websites WHERE id = ?`).get(prepared.siteId)
  );
  return {
    siteId: prepared.siteId,
    version: saved.version,
    previewUrl: resolvePreviewUrl(previewRow) || prepared.previewFallback,
  };
}

function syncDesignDeliverablePages(workspaceId, leadId, siteId, pages, theme) {
  const domain = require('./domain');
  domain.withDb(workspaceId, (db) => {
    try {
      const job = db.prepare(
        `SELECT id, website_id, deliverable FROM design_jobs
         WHERE lead_id = ? AND (website_id = ? OR website_id IS NULL)
         ORDER BY CASE WHEN website_id = ? THEN 0 ELSE 1 END, id DESC LIMIT 1`
      ).get(Number(leadId), Number(siteId), Number(siteId));
      if (job && job.deliverable) {
        const payload = parseJsonSafe(job.deliverable, null);
        if (payload && Array.isArray(payload.pages)) {
          payload.pages = pages;
          payload.theme = theme;
          db.prepare(
            `UPDATE design_jobs SET deliverable = ?, updated_at = datetime('now') WHERE id = ?`
          ).run(JSON.stringify(payload), job.id);
        }
      }
    } catch { /* optional */ }
  });
}

const PORTAL_IMAGE_MAX_BYTES = 5.5 * 1024 * 1024;
const PORTAL_IMAGE_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function sniffImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (
    buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WEBP'
  ) return 'image/webp';
  return null;
}

/** Normalize an img src from the preview iframe to a relative export path. */
function normalizePortalImageSrc(raw, previewUrl) {
  let s = String(raw || '').trim();
  if (!s) return null;
  s = s.split('#')[0].split('?')[0];
  if (/^data:/i.test(s) || /^blob:/i.test(s)) return null;

  const tryRel = (u) => {
    let r = String(u || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (r.startsWith('/')) r = r.replace(/^\/+/, '');
    if (!r || r.includes('..')) return null;
    if (/^images\//i.test(r)) return `images/${path.basename(r)}`;
    if (/^assets\//i.test(r)) return `assets/${path.basename(r)}`;
    if (/^https?:\/\//i.test(r)) return null;
    if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(r) && !r.includes('/')) {
      return `images/${r}`;
    }
    return null;
  };

  const direct = tryRel(s);
  if (direct) return direct;

  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const pathName = u.pathname.replace(/\\/g, '/');
      const m = pathName.match(/\/site-previews\/[^/]+\/(.+)$/i);
      if (m) {
        const rel = tryRel(m[1]);
        if (rel) return rel;
      }
      const imgTail = pathName.match(/\/((?:images|assets)\/[^/]+)$/i);
      if (imgTail) {
        const rel = tryRel(imgTail[1]);
        if (rel) return rel;
      }
      const base = String(previewUrl || '').trim();
      if (base) {
        const b = new URL(base.endsWith('/') ? base : `${base}/`);
        if (u.origin === b.origin && pathName.startsWith(b.pathname)) {
          const rel = tryRel(pathName.slice(b.pathname.length));
          if (rel) return rel;
        }
      }
      // Last resort: basename under images/ when replacing a local asset name.
      const baseName = path.basename(pathName);
      if (/\.(png|jpe?g|gif|webp)$/i.test(baseName)) return `images/${baseName}`;
    } catch { /* ignore */ }
  }
  return null;
}

function replaceSrcDeep(value, from, to) {
  if (typeof value === 'string') {
    if (value === from) return to;
    if (value.includes(from)) return value.split(from).join(to);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => replaceSrcDeep(v, from, to));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = replaceSrcDeep(v, from, to);
    return out;
  }
  return value;
}

/**
 * Client portal image replace: write under site export/images, update pages, rematerialize.
 * Ownership: workspaceId + leadId from the portal session only.
 */
async function applyClientImageUpload(workspaceId, leadId, payload = {}) {
  const domain = require('./domain');
  const openPreview = require('../src/openPreview');

  const replaceSrcRaw = String(payload.replaceSrc || payload.src || '').trim();
  const mimeClaimed = String(payload.mimeType || payload.contentType || '').trim().toLowerCase();
  const dataB64 = String(payload.data || payload.base64 || '')
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    .replace(/\s+/g, '');

  if (!replaceSrcRaw) {
    throw Object.assign(new Error('Missing image to replace'), { code: 'EMPTY' });
  }
  if (!dataB64) {
    throw Object.assign(new Error('Missing image data'), { code: 'EMPTY' });
  }

  let buffer;
  try {
    buffer = Buffer.from(dataB64, 'base64');
  } catch {
    throw Object.assign(new Error('Invalid image data'), { code: 'INVALID_IMAGE' });
  }
  if (!buffer.length || buffer.length > PORTAL_IMAGE_MAX_BYTES) {
    throw Object.assign(new Error('Image is too large (max ~5 MB after resize)'), { code: 'TOO_LARGE' });
  }

  let sniffed = sniffImageMime(buffer);
  if (!sniffed) {
    throw Object.assign(new Error('File is not a supported image (JPEG, PNG, WebP, GIF)'), { code: 'INVALID_IMAGE' });
  }
  let ext = PORTAL_IMAGE_MIME[sniffed] || PORTAL_IMAGE_MIME[mimeClaimed];
  if (!ext) {
    throw Object.assign(new Error('Unsupported image type'), { code: 'INVALID_IMAGE' });
  }

  try {
    const imageOptimize = require('../src/imageOptimize');
    const opt = await imageOptimize.optimizeBuffer(buffer, {
      fileName: `upload.${ext}`,
      role: 'photo',
      preferWebp: true,
    });
    if (!opt.skipped && opt.buffer && opt.buffer.length) {
      buffer = opt.buffer;
      if (opt.ext) ext = opt.ext.replace(/^\./, '');
      sniffed = opt.mime || sniffed;
    }
  } catch (e) {
    console.warn('[portal] image optimize skip:', e.message || e);
  }

  const prepared = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available to edit yet'), { code: 'NO_SITE' });
    }
    if (!pagesSupportInlineEdit(site.pages)) {
      throw Object.assign(
        new Error('This site layout does not support inline image edits. Use Request changes instead.'),
        { code: 'NOT_EDITABLE' }
      );
    }

    const previewFallback = resolvePreviewUrl(site);
    const assetBase = resolveExportPreviewBase(workspaceId, site);
    const oldRel = normalizePortalImageSrc(replaceSrcRaw, assetBase || previewFallback);
    if (!oldRel) {
      throw Object.assign(new Error('That image cannot be replaced from the portal'), { code: 'INVALID_IMAGE' });
    }

    const folder = domain.resolveSiteExportFolder(workspaceId, site, db);
    const isAsset = /^assets\//i.test(oldRel);
    // Stable assets/ keep their filename; images/ get a unique upload name.
    const name = isAsset
      ? path.basename(oldRel)
      : `upload-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    const sub = isAsset ? 'assets' : 'images';
    const imgDir = path.join(openPreview.exportRoot(), folder, sub);
    fs.mkdirSync(imgDir, { recursive: true });
    const absPath = path.join(imgDir, name);
    fs.writeFileSync(absPath, buffer);
    // Also mirror into site-{id}/{images|assets} so CF materialize always finds the file.
    try {
      const appDir = path.join(openPreview.exportRoot(), `site-${site.id}`, sub);
      fs.mkdirSync(appDir, { recursive: true });
      fs.copyFileSync(absPath, path.join(appDir, name));
    } catch { /* best effort */ }
    const newRel = `${sub}/${name}`;

    let pages = JSON.parse(JSON.stringify(site.pages));
    pages = replaceSrcDeep(pages, oldRel, newRel);
    // Common relative variants used in freeform HTML / CSS.
    if (oldRel.startsWith('images/') || oldRel.startsWith('assets/')) {
      pages = replaceSrcDeep(pages, `./${oldRel}`, newRel);
      pages = replaceSrcDeep(pages, `/${oldRel}`, newRel);
    }

    const theme = site.theme && typeof site.theme === 'object' ? site.theme : {};

    // Keep deliverable.images in sync so later rematerialize / publish keep the file.
    try {
      const job = db.prepare(
        `SELECT id, website_id, deliverable FROM design_jobs
         WHERE lead_id = ? AND (website_id = ? OR website_id IS NULL)
         ORDER BY CASE WHEN website_id = ? THEN 0 ELSE 1 END, id DESC LIMIT 1`
      ).get(Number(leadId), site.id, site.id);
      if (job && job.deliverable) {
        const payloadJob = parseJsonSafe(job.deliverable, null);
        if (payloadJob && typeof payloadJob === 'object') {
          if (Array.isArray(payloadJob.pages)) payloadJob.pages = pages;
          payloadJob.theme = theme;
          if (!Array.isArray(payloadJob.images)) payloadJob.images = [];
          payloadJob.images.push({
            name,
            path: absPath,
            url: newRel,
            source: 'client-portal',
            replaced: oldRel,
          });
          db.prepare(
            `UPDATE design_jobs SET deliverable = ?, updated_at = datetime('now') WHERE id = ?`
          ).run(JSON.stringify(payloadJob), job.id);
        }
      }
    } catch { /* optional */ }

    return {
      siteId: site.id,
      pages,
      theme,
      oldRel,
      newRel,
      previewFallback,
      assetBase,
      publicUrl: assetBase
        ? `${String(assetBase).replace(/\/+$/, '')}/${newRel}`
        : null,
    };
  });

  const saved = domain.sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note: 'Client portal image replace',
  });

  // Ensure the new file still exists after rematerialize (copy from our write if needed).
  try {
    const previewRowEarly = domain.withDb(workspaceId, (db) =>
      db.prepare(`SELECT preview_url, preview_path, export_slug FROM websites WHERE id = ?`).get(prepared.siteId)
    );
    const folder = domain.resolveSiteExportFolder(workspaceId, {
      id: prepared.siteId,
      preview_path: previewRowEarly && previewRowEarly.preview_path,
      export_slug: previewRowEarly && previewRowEarly.export_slug,
    });
    const dest = path.join(openPreview.exportRoot(), folder, prepared.newRel);
    if (!fs.existsSync(dest)) {
      // sitesSave may have used a fresh images copy; re-write from buffer we still have.
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buffer);
    }
  } catch { /* best effort */ }

  const previewRow = domain.withDb(workspaceId, (db) =>
    db.prepare(`SELECT preview_url, preview_path, export_slug FROM websites WHERE id = ?`).get(prepared.siteId)
  );
  const previewUrl = resolvePreviewUrl(previewRow) || prepared.previewFallback;

  return {
    siteId: prepared.siteId,
    replaced: prepared.oldRel,
    src: prepared.newRel,
    publicUrl: prepared.publicUrl
      || (previewUrl ? `${String(previewUrl).replace(/\/+$/, '')}/${prepared.newRel}` : null),
    version: saved.version,
    previewUrl,
  };
}

/**
 * Standalone image upload for site module content (covers, product photos, etc.).
 * Body: { data: "<base64>", mimeType: "image/jpeg" }
 */
async function applyModuleAssetUpload(workspaceId, leadId, payload = {}) {
  const domain = require('./domain');
  const openPreview = require('../src/openPreview');

  const mimeClaimed = String(payload.mimeType || payload.contentType || '').trim().toLowerCase();
  const dataB64 = String(payload.data || payload.base64 || '')
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    .replace(/\s+/g, '');

  if (!dataB64) {
    throw Object.assign(new Error('Missing image data'), { code: 'EMPTY' });
  }

  let buffer;
  try {
    buffer = Buffer.from(dataB64, 'base64');
  } catch {
    throw Object.assign(new Error('Invalid image data'), { code: 'INVALID_IMAGE' });
  }
  if (!buffer.length || buffer.length > PORTAL_IMAGE_MAX_BYTES) {
    throw Object.assign(new Error('Image is too large (max ~5 MB after resize)'), { code: 'TOO_LARGE' });
  }

  let sniffed = sniffImageMime(buffer);
  if (!sniffed) {
    throw Object.assign(new Error('File is not a supported image (JPEG, PNG, WebP, GIF)'), { code: 'INVALID_IMAGE' });
  }
  let ext = PORTAL_IMAGE_MIME[sniffed] || PORTAL_IMAGE_MIME[mimeClaimed];
  if (!ext) {
    throw Object.assign(new Error('Unsupported image type'), { code: 'INVALID_IMAGE' });
  }

  try {
    const imageOptimize = require('../src/imageOptimize');
    const opt = await imageOptimize.optimizeBuffer(buffer, {
      fileName: `module.${ext}`,
      role: 'photo',
      preferWebp: true,
    });
    if (!opt.skipped && opt.buffer && opt.buffer.length) {
      buffer = opt.buffer;
      if (opt.ext) ext = opt.ext.replace(/^\./, '');
    }
  } catch (e) {
    console.warn('[portal] module image optimize skip:', e.message || e);
  }

  const prepared = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }
    const site = resolveClientSite(db, leadId);
    if (!site) {
      throw Object.assign(new Error('No website is available yet'), { code: 'NO_SITE' });
    }

    const previewFallback = resolvePreviewUrl(site);
    const assetBase = resolveExportPreviewBase(workspaceId, site);
    const folder = domain.resolveSiteExportFolder(workspaceId, site, db);
    const imgDir = path.join(openPreview.exportRoot(), folder, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const name = `module-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(imgDir, name), buffer);
    const newRel = `images/${name}`;

    const publicUrl = assetBase
      ? `${String(assetBase).replace(/\/+$/, '')}/${newRel}`
      : (previewFallback
        ? `${String(previewFallback).replace(/\/+$/, '')}/${newRel}`
        : newRel);

    return { newRel, publicUrl };
  });

  return {
    src: prepared.newRel,
    url: prepared.publicUrl,
    publicUrl: prepared.publicUrl,
  };
}

/**
 * AI image generation for portal edit mode: OpenAI Images → replace site asset.
 * Credits: Free/Standard charge credits.per_social_image; Premium (socialImagesIncluded) is free.
 */
async function generateClientSiteImage(workspaceId, leadId, payload = {}, clientEmail = '') {
  const domain = require('./domain');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const openaiImages = require('../src/openaiImages');
  const fs = require('fs');

  const prompt = String(payload.prompt || payload.description || '').trim();
  const replaceSrc = String(payload.replaceSrc || payload.src || '').trim();
  if (!prompt) {
    throw Object.assign(new Error('Describe the image you want'), { code: 'EMPTY' });
  }
  if (prompt.length > 2000) {
    throw Object.assign(new Error('Description is too long (max 2000 characters)'), { code: 'INVALID' });
  }
  if (!replaceSrc) {
    throw Object.assign(new Error('Missing image to replace'), { code: 'EMPTY' });
  }

  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  const entitlements = getPlan(planId).entitlements;
  const included = !!entitlements.socialImagesIncluded;
  const creditMod = require('./credits');
  const cfg = await creditMod.packConfig();
  const imageCost = included ? 0 : cfg.perImage;

  let spendResult = null;
  if (imageCost > 0) {
    spendResult = await creditMod.spend(workspaceId, imageCost, {
      reason: 'portal_site_image',
      refType: 'website',
      refId: String(leadId),
    });
  }

  try {
    const gen = await domain.withDb(workspaceId, async (db) => {
      if (!openaiImages.imageConfigured(db)) {
        throw Object.assign(
          new Error('Image generation is not configured yet. Contact support.'),
          { code: 'AI_NOT_CONFIGURED' }
        );
      }
      return openaiImages.generateImages(db, prompt, {
        n: 1,
        size: payload.size || '1024x1024',
        quality: payload.quality != null ? payload.quality : 'low',
        leadId: Number(leadId),
        note: `portal site image lead=${leadId}`,
      });
    });

    const file = gen && Array.isArray(gen.images) ? gen.images[0] : null;
    if (!file || !file.path || !fs.existsSync(file.path)) {
      throw Object.assign(new Error('Image provider returned no image'), { code: 'AI_EMPTY' });
    }
    const buffer = fs.readFileSync(file.path);
    const mime = file.mime || 'image/png';
    const dataB64 = buffer.toString('base64');

    const out = await applyClientImageUpload(workspaceId, leadId, {
      replaceSrc,
      data: dataB64,
      mimeType: mime,
    });

    try {
      domain.intentRecord(workspaceId, Number(leadId), 'site.ai_image', prompt.slice(0, 160));
    } catch { /* optional */ }

    return {
      ...out,
      prompt,
      model: gen.model || null,
      credits_charged: imageCost,
      credits_balance: spendResult
        ? spendResult.balance
        : await creditMod.getBalance(workspaceId),
      social_images_included: included,
      plan: planId,
    };
  } catch (e) {
    if (imageCost > 0) {
      try {
        await creditMod.grant(workspaceId, imageCost, {
          reason: 'refund_failed_portal_site_image',
          refType: 'website',
          refId: String(leadId),
        });
      } catch (re) {
        console.warn('[credits] refund after failed portal site image:', re.message);
      }
    }
    throw e;
  }
}

/**
 * Upload or clear the site header logo.
 * Body: { data, mimeType } to set an image logo, or { mode: "text" } to revert.
 * Optional brandName. Image is cover-cropped and saved as transparent PNG.
 */
async function applyClientLogoUpload(workspaceId, leadId, payload = {}) {
  const domain = require('./domain');
  const modeRaw = String(payload.mode || '').trim().toLowerCase();
  const wantText = modeRaw === 'text' || payload.clear === true || payload.remove === true;
  const brandName = payload.brandName != null ? String(payload.brandName).trim().slice(0, 120) : undefined;

  if (wantText) {
    return domain.sitesSetLogo(workspaceId, null, {
      leadId: Number(leadId),
      mode: 'text',
      brandName,
      note: 'Client portal logo → text',
    });
  }

  const dataB64 = String(payload.data || payload.base64 || '')
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    .replace(/\s+/g, '');
  if (!dataB64) {
    throw Object.assign(new Error('Missing logo image data (or pass mode: "text" to use text logo)'), { code: 'EMPTY' });
  }

  let buffer;
  try {
    buffer = Buffer.from(dataB64, 'base64');
  } catch {
    throw Object.assign(new Error('Invalid logo image data'), { code: 'INVALID_IMAGE' });
  }
  if (!buffer.length || buffer.length > PORTAL_IMAGE_MAX_BYTES) {
    throw Object.assign(new Error('Logo image is too large (max ~5 MB)'), { code: 'TOO_LARGE' });
  }
  if (!sniffImageMime(buffer)) {
    throw Object.assign(new Error('File is not a supported image (JPEG, PNG, WebP, GIF)'), { code: 'INVALID_IMAGE' });
  }

  const result = await domain.sitesSetLogo(workspaceId, null, {
    leadId: Number(leadId),
    mode: 'image',
    buffer,
    brandName,
    note: 'Client portal logo upload',
  });

  try {
    domain.intentRecord(workspaceId, Number(leadId), 'logo.uploaded', 'Client portal logo upload');
  } catch { /* optional */ }

  return result;
}

async function calendarPosts(workspaceId, leadId, { year, month, clientEmail } = {}) {
  const domain = require('./domain');
  const social = require('../src/socialMedia');
  const platform = require('./platform');
  const now = new Date();
  const y = Number(year) || now.getUTCFullYear();
  const m = Number(month) || (now.getUTCMonth() + 1);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const endMonth = m === 12 ? 1 : m + 1;
  const endYear = m === 12 ? y + 1 : y;
  const end = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const platformPrice = await platform.getPlatformSetting('social.image_price_usd', '1');
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  const entitlements = getPlan(planId).entitlements;
  const imagesIncluded = !!entitlements.socialImagesIncluded;
  const creditMod = require('./credits');
  const creditCfg = await creditMod.packConfig();
  const creditBalance = await creditMod.getBalance(workspaceId);

  return domain.withDb(workspaceId, (db) => {
    social.ensureTables(db);
    const rows = db.prepare(
      `SELECT id, campaign_id, lead_id, day_index, scheduled_at, caption, platforms,
              image_url, status, client_notes
       FROM social_posts
       WHERE lead_id = ?
         AND scheduled_at >= ?
         AND scheduled_at < ?
       ORDER BY scheduled_at ASC, id ASC`
    ).all(Number(leadId), start, end);

    const posts = rows.map((row) => {
      let platforms = ['facebook', 'instagram'];
      try {
        const parsed = typeof row.platforms === 'string' ? JSON.parse(row.platforms || '[]') : row.platforms;
        if (Array.isArray(parsed) && parsed.length) platforms = parsed;
      } catch { /* */ }
      return {
        id: row.id,
        campaign_id: row.campaign_id,
        lead_id: row.lead_id,
        day_index: row.day_index,
        scheduled_at: row.scheduled_at,
        caption: row.caption,
        platforms,
        image_url: row.image_url,
        status: row.status,
        client_notes: row.client_notes,
        with_image: !!(row.image_url && String(row.image_url).trim()),
      };
    });

    const basePrice = social.imagePriceUsd(db, platformPrice);
    const image_price_usd = imagesIncluded ? 0 : basePrice;
    const image_credits = imagesIncluded ? 0 : creditCfg.perImage;
    return {
      year: y,
      month: m,
      posts,
      image_price_usd,
      image_credits,
      content_credits: creditCfg.perContent,
      credits_balance: creditBalance,
      credits_pack_label: creditCfg.packLabel,
      credits_configured: creditCfg.configured,
      social_images_included: imagesIncluded,
      plan: planId,
    };
  });
}

async function generatePostBrandedImage(workspaceId, leadId, postId, clientEmail = '') {
  const domain = require('./domain');
  const social = require('../src/socialMedia');
  const billing = require('./billing');
  const platform = require('./platform');
  const { getPlan } = require('./plans');

  const requireSub = (await platform.getPlatformSetting('billing.require_subscription', '1')) === '1';
  if (requireSub) {
    const ok = await billing.workspaceHasProductAccess(workspaceId);
    if (!ok) {
      throw Object.assign(
        new Error('An active Bitpype account is required to generate branded image ads.'),
        { code: 'PAYMENT_REQUIRED', status: 402 }
      );
    }
  }

  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  const entitlements = getPlan(planId).entitlements;
  const platformPrice = await platform.getPlatformSetting('social.image_price_usd', '1');
  const included = !!entitlements.socialImagesIncluded;
  const creditMod = require('./credits');
  const cfg = await creditMod.packConfig();
  const imageCost = included ? 0 : cfg.perImage;
  let spendResult = null;
  if (imageCost > 0) {
    spendResult = await creditMod.spend(workspaceId, imageCost, {
      reason: 'social_branded_image',
      refType: 'social_post',
      refId: String(postId),
    });
  }
  try {
    const out = await domain.withDb(workspaceId, async (db) => {
      social.ensureTables(db);
      return social.generateBrandedAdImage(db, {
        postId: Number(postId),
        leadId: Number(leadId),
        platformPriceFallback: platformPrice,
        chargeUsd: included ? 0 : undefined,
        includedInPlan: included,
        planId,
        creditsCharged: imageCost,
      });
    });
    return {
      ...out,
      credits_charged: imageCost,
      credits_balance: spendResult
        ? spendResult.balance
        : await creditMod.getBalance(workspaceId),
    };
  } catch (e) {
    if (imageCost > 0) {
      try {
        await creditMod.grant(workspaceId, imageCost, {
          reason: 'refund_failed_image',
          refType: 'social_post',
          refId: String(postId),
        });
      } catch (re) {
        console.warn('[credits] refund after failed image:', re.message);
      }
    }
    throw e;
  }
}

async function generateSocial(workspaceId, leadId, clientEmail, period) {
  const domain = require('./domain');
  const days = period === 'week' ? 7 : 30;
  const monthStart = new Date().toISOString().slice(0, 10);
  // Credits for content generation are spent inside domain.socialGenerateMonth.
  return domain.socialGenerateMonth(workspaceId, {
    leadId: Number(leadId),
    monthStart,
    days,
    withImages: false,
    clientEmail: clientEmail || '',
    requireClientApproval: true,
    activate: true,
  });
}

function socialAccountsForClient(workspaceId, leadId) {
  const domain = require('./domain');
  return domain.socialAccounts(workspaceId, Number(leadId));
}

function socialOauthStartForClient(workspaceId, leadId, returnTo) {
  const domain = require('./domain');
  const dest = returnTo || '/portal?connected=1#/social';
  return domain.socialOauthStart(workspaceId, Number(leadId), dest);
}

function socialDisconnectForClient(workspaceId, leadId, accountId) {
  const domain = require('./domain');
  const social = require('../src/socialMedia');
  return domain.withDb(workspaceId, (db) => {
    social.ensureTables(db);
    const row = db.prepare('SELECT * FROM social_accounts WHERE id = ?').get(Number(accountId));
    if (!row || Number(row.lead_id) !== Number(leadId)) {
      throw Object.assign(new Error('Account not found'), { code: 'NOT_FOUND' });
    }
    return social.disconnectAccount(db, Number(accountId));
  });
}

function socialUpdatePostForClient(workspaceId, leadId, postId, patch = {}) {
  const domain = require('./domain');
  const social = require('../src/socialMedia');
  return domain.withDb(workspaceId, (db) => {
    social.ensureTables(db);
    const row = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(Number(postId));
    if (!row || Number(row.lead_id) !== Number(leadId)) {
      throw Object.assign(new Error('Post not found'), { code: 'NOT_FOUND' });
    }
    const allowed = {};
    if (patch.scheduled_at != null) allowed.scheduled_at = patch.scheduled_at;
    if (patch.caption != null) allowed.caption = patch.caption;
    if (patch.status != null) {
      const st = String(patch.status);
      if (['scheduled', 'approved', 'draft', 'pending_approval', 'rejected'].includes(st)) {
        allowed.status = st;
      }
    }
    if (patch.client_notes != null) allowed.client_notes = patch.client_notes;
    return social.updatePost(db, Number(postId), allowed);
  });
}

function socialApprovePostsForClient(workspaceId, leadId, postIds) {
  const domain = require('./domain');
  const social = require('../src/socialMedia');
  const ids = (Array.isArray(postIds) ? postIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return domain.withDb(workspaceId, (db) => {
    social.ensureTables(db);
    const approved = [];
    for (const id of ids) {
      const row = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(id);
      if (!row || Number(row.lead_id) !== Number(leadId)) continue;
      db.prepare(
        "UPDATE social_posts SET status = 'scheduled', updated_at = datetime('now') WHERE id = ? AND status IN ('draft','pending_approval','approved','rejected')"
      ).run(id);
      approved.push(id);
    }
    return { approved };
  });
}

async function listContactForms(workspaceId, leadId, clientEmail) {
  const domain = require('./domain');
  const forms = require('./contactForms');
  const { appUrl } = require('./stripeClient');
  return domain.withDb(workspaceId, (db) => {
    const list = forms.listFormsForLead(db, Number(leadId), clientEmail);
    const pages = forms.listSitePages(db, Number(leadId));
    return {
      forms: list.map((form) => ({ form, embed: forms.embedSnippet(form, appUrl()) })),
      pages,
      workspaceId: Number(workspaceId),
    };
  });
}

async function getContactForm(workspaceId, leadId, clientEmail, formId) {
  const domain = require('./domain');
  const forms = require('./contactForms');
  const { appUrl } = require('./stripeClient');
  return domain.withDb(workspaceId, (db) => {
    const form = formId != null
      ? forms.getFormById(db, Number(leadId), Number(formId))
      : forms.getFormForLead(db, Number(leadId), clientEmail);
    const pages = forms.listSitePages(db, Number(leadId));
    const embed = forms.embedSnippet(form, appUrl());
    return { form, embed, pages, workspaceId: Number(workspaceId) };
  });
}

async function createContactForm(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const forms = require('./contactForms');
  const { appUrl } = require('./stripeClient');
  return domain.withDb(workspaceId, (db) => {
    const form = forms.createForm(db, Number(leadId), Object.assign({}, body || {}, {
      notify_email: (body && body.notify_email) != null ? body.notify_email : clientEmail,
    }));
    const pages = forms.listSitePages(db, Number(leadId));
    return { form, embed: forms.embedSnippet(form, appUrl()), pages, workspaceId: Number(workspaceId) };
  });
}

async function saveContactForm(workspaceId, leadId, patch, clientEmail, formId) {
  const domain = require('./domain');
  const forms = require('./contactForms');
  const { appUrl } = require('./stripeClient');
  const id = formId != null ? Number(formId) : (patch && patch.id != null ? Number(patch.id) : null);
  return domain.withDb(workspaceId, (db) => {
    const form = forms.saveForm(db, Number(leadId), id, Object.assign({}, patch || {}, {
      notify_email: patch && patch.notify_email != null ? patch.notify_email : clientEmail,
    }));
    try {
      if (form.published) {
        forms.syncSiteFormEmbeds(db, Number(leadId));
        const site = db.prepare(
          'SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
        ).get(Number(leadId));
        if (site) rematerializeFormSite(db, workspaceId, site.id);
      }
    } catch { /* optional */ }
    const pages = forms.listSitePages(db, Number(leadId));
    return { form, embed: forms.embedSnippet(form, appUrl()), pages, workspaceId: Number(workspaceId) };
  });
}

async function deleteContactForm(workspaceId, leadId, formId) {
  const domain = require('./domain');
  const forms = require('./contactForms');
  return domain.withDb(workspaceId, (db) => {
    const result = forms.deleteForm(db, Number(leadId), Number(formId));
    try {
      const site = db.prepare(
        'SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
      ).get(Number(leadId));
      if (site) rematerializeFormSite(db, workspaceId, site.id);
    } catch { /* optional */ }
    return result;
  });
}

function rematerializeFormSite(db, workspaceId, siteId) {
  try {
    const domain = require('./domain');
    domain.materializeWebsiteExport(db, workspaceId, siteId);
  } catch (e) {
    console.warn('[clientPortal] rematerialize form site:', e.message);
  }
}

/**
 * Rematerialize local export, then force Cloudflare/app preview so live Pages
 * HTML matches portal form/module attach (not just /site-previews).
 */
async function publishLiveAfterEmbed(workspaceId, siteId) {
  const domain = require('./domain');
  const id = Number(siteId);
  if (!Number.isInteger(id) || id < 1) return null;
  try {
    return await domain.sitesPreview(workspaceId, id, { force: true });
  } catch (e) {
    console.warn('[clientPortal] live publish after embed:', e.message);
    try {
      domain.withDb(workspaceId, (db) => rematerializeFormSite(db, workspaceId, id));
    } catch { /* best-effort local export */ }
    return null;
  }
}

async function publishContactForm(workspaceId, leadId, opts = {}, formId) {
  const domain = require('./domain');
  const forms = require('./contactForms');
  const { appUrl } = require('./stripeClient');
  const id = formId != null ? Number(formId) : (opts.formId != null ? Number(opts.formId) : null);
  const packed = domain.withDb(workspaceId, (db) => {
    // Persist attachment settings before publish when provided.
    if (id != null && (opts.embed_on_page != null || opts.embed_enabled != null || opts.target_page_slug != null)) {
      forms.saveForm(db, Number(leadId), id, {
        embed_enabled: opts.embed_enabled != null ? opts.embed_enabled : opts.embed_on_page,
        target_page_slug: opts.target_page_slug,
      });
    }
    const form = forms.publishForm(db, Number(leadId), {
      formId: id,
      toSite: opts.toSite,
      workspaceId: Number(workspaceId),
    });
    const site = db.prepare(
      'SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
    ).get(Number(leadId));
    const pages = forms.listSitePages(db, Number(leadId));
    return {
      form,
      embed: forms.embedSnippet(form, appUrl()),
      pages,
      workspaceId: Number(workspaceId),
      siteId: site && site.id,
    };
  });
  let preview = null;
  if (packed.siteId) {
    preview = await publishLiveAfterEmbed(workspaceId, packed.siteId);
  }
  return {
    form: packed.form,
    embed: packed.embed,
    pages: packed.pages,
    workspaceId: packed.workspaceId,
    previewUrl: preview && preview.url,
    via: preview && preview.via,
    publicPreviewUpdated: !!(preview && (preview.via === 'cloudflare' || preview.via === 'app_url')),
  };
}

async function listFormSubmissions(workspaceId, leadId, opts = {}) {
  const domain = require('./domain');
  const forms = require('./contactForms');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const planId = await billing.effectivePlan(workspaceId, { email: opts.clientEmail });
  const ent = getPlan(planId).entitlements;
  if (!ent.formInbox) {
    return {
      plan: planId,
      inbox: false,
      notice: 'On Free, form submissions are emailed only. Upgrade to Standard or Premium for a portal inbox.',
      submissions: [],
    };
  }
  return domain.withDb(workspaceId, (db) => {
    const data = forms.listSubmissions(db, Number(leadId), {
      limit: opts.limit,
      offset: opts.offset,
      formId: opts.formId,
    });
    return { plan: planId, inbox: true, ...data };
  });
}

async function getFormSubmission(workspaceId, leadId, submissionId, clientEmail = '') {
  const domain = require('./domain');
  const forms = require('./contactForms');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  if (!getPlan(planId).entitlements.formInbox) {
    throw Object.assign(new Error('Form inbox requires Standard or Premium'), { code: 'FORBIDDEN', status: 403 });
  }
  return domain.withDb(workspaceId, (db) => forms.getSubmission(db, Number(leadId), Number(submissionId)));
}

async function requireSiteModules(workspaceId, clientEmail) {
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  const ent = getPlan(planId).entitlements;
  if (!ent.siteModules) {
    throw Object.assign(
      new Error('Site modules require Standard or Premium. Upgrade in Billing.'),
      { code: 'PLAN_REQUIRED', status: 403, plan: planId }
    );
  }
  return planId;
}

async function listSiteModules(workspaceId, leadId, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const { appUrl } = require('./stripeClient');
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  const ents = getPlan(planId).entitlements;
  const siteModules = !!ents.siteModules;
  return domain.withDb(workspaceId, (db) => ({
    plan: planId,
    chatbot: !!ents.chatbot,
    ...modules.portalSummary(db, Number(leadId), { appUrl: appUrl(), siteModules }),
  }));
}

async function listModuleItems(workspaceId, leadId, moduleType, clientEmail, opts = {}) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  const { appUrl } = require('./stripeClient');
  await requireSiteModules(workspaceId, clientEmail);
  const type = String(moduleType || '').toLowerCase();
  const includeArchived = !!(opts && opts.includeArchived);
  return domain.withDb(workspaceId, (db) => {
    modules.ensureTables(db);
    let items = [];
    let booking = null;
    if (type === 'blog') items = modules.listBlogPosts(db, Number(leadId));
    else if (type === 'ecommerce') {
      items = modules.listProducts(db, Number(leadId)).map((p) => ({
        ...p,
        price_label: modules.formatPrice(p.price_cents, p.currency),
      }));
    } else if (type === 'courses') items = modules.listCourses(db, Number(leadId));
    else if (type === 'gallery') items = modules.listAlbums(db, Number(leadId));
    else if (type === 'directory') items = modules.listListings(db, Number(leadId));
    else if (type === 'faq') items = modules.listFaqItems(db, Number(leadId));
    else if (type === 'testimonials') items = modules.listTestimonials(db, Number(leadId));
    else if (type === 'team') items = modules.listTeamMembers(db, Number(leadId));
    else if (type === 'events') items = modules.listEvents(db, Number(leadId));
    else if (type === 'bookings') {
      modules.ensureDefaultBookingHours(db, Number(leadId));
      items = modules.listBookingServices(db, Number(leadId));
      booking = {
        settings: modules.getBookingSettings(db, Number(leadId)),
        hours: modules.listBookingHours(db, Number(leadId)),
        appointments: modules.listAppointments(db, Number(leadId), {
          limit: 100,
          includeArchived,
        }),
        // Nav badge source of truth: never includes archived.
        active_appointment_count: modules.moduleItemCount(db, Number(leadId), 'bookings'),
        blocks: modules.listBookingBlocks(db, Number(leadId)),
      };
    } else if (type === 'chatbot') {
      const chat = require('./chatbot');
      const summary = chat.portalChatbotSummary(db, Number(leadId));
      const emb = modules.getEmbedRow(db, Number(leadId), type);
      return {
        module_type: type,
        items: summary.knowledge || [],
        embed: modules.publicEmbed(emb, appUrl()),
        pages: modules.listSitePages(db, Number(leadId)),
        chatbot: summary,
      };
    } else throw Object.assign(new Error('Unknown module type'), { code: 'VALIDATION', status: 400 });
    const emb = modules.getEmbedRow(db, Number(leadId), type);
    const out = {
      module_type: type,
      items,
      embed: modules.publicEmbed(emb, appUrl()),
      pages: modules.listSitePages(db, Number(leadId)),
    };
    if (booking) out.booking = booking;
    return out;
  });
}

async function createModuleItem(workspaceId, leadId, moduleType, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const type = String(moduleType || '').toLowerCase();
  return domain.withDb(workspaceId, (db) => {
    let item;
    if (type === 'blog') item = modules.createBlogPost(db, Number(leadId), body || {});
    else if (type === 'ecommerce') item = modules.createProduct(db, Number(leadId), body || {});
    else if (type === 'courses') item = modules.createCourse(db, Number(leadId), body || {});
    else if (type === 'gallery') item = modules.createAlbum(db, Number(leadId), body || {});
    else if (type === 'directory') item = modules.createListing(db, Number(leadId), body || {});
    else if (type === 'faq') item = modules.createFaqItem(db, Number(leadId), body || {});
    else if (type === 'testimonials') item = modules.createTestimonial(db, Number(leadId), body || {});
    else if (type === 'team') item = modules.createTeamMember(db, Number(leadId), body || {});
    else if (type === 'events') item = modules.createEvent(db, Number(leadId), body || {});
    else if (type === 'bookings') item = modules.createBookingService(db, Number(leadId), body || {});
    else if (type === 'chatbot') {
      const chat = require('./chatbot');
      item = chat.addKnowledge(db, Number(leadId), body || {});
    }
    else throw Object.assign(new Error('Unknown module type'), { code: 'VALIDATION', status: 400 });
    return { item, module_type: type };
  });
}

async function updateModuleItem(workspaceId, leadId, moduleType, id, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const type = String(moduleType || '').toLowerCase();
  return domain.withDb(workspaceId, (db) => {
    let item;
    if (type === 'blog') item = modules.updateBlogPost(db, Number(leadId), id, body || {});
    else if (type === 'ecommerce') item = modules.updateProduct(db, Number(leadId), id, body || {});
    else if (type === 'courses') item = modules.updateCourse(db, Number(leadId), id, body || {});
    else if (type === 'gallery') item = modules.updateAlbum(db, Number(leadId), id, body || {});
    else if (type === 'directory') item = modules.updateListing(db, Number(leadId), id, body || {});
    else if (type === 'faq') item = modules.updateFaqItem(db, Number(leadId), id, body || {});
    else if (type === 'testimonials') item = modules.updateTestimonial(db, Number(leadId), id, body || {});
    else if (type === 'team') item = modules.updateTeamMember(db, Number(leadId), id, body || {});
    else if (type === 'events') item = modules.updateEvent(db, Number(leadId), id, body || {});
    else if (type === 'bookings') item = modules.updateBookingService(db, Number(leadId), id, body || {});
    else if (type === 'chatbot') {
      const chat = require('./chatbot');
      item = chat.updateKnowledge(db, Number(leadId), id, body || {});
    }
    else throw Object.assign(new Error('Unknown module type'), { code: 'VALIDATION', status: 400 });
    return { item, module_type: type };
  });
}

async function deleteModuleItem(workspaceId, leadId, moduleType, id, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const type = String(moduleType || '').toLowerCase();
  return domain.withDb(workspaceId, (db) => {
    if (type === 'blog') return modules.deleteBlogPost(db, Number(leadId), id);
    if (type === 'ecommerce') return modules.deleteProduct(db, Number(leadId), id);
    if (type === 'courses') return modules.deleteCourse(db, Number(leadId), id);
    if (type === 'gallery') return modules.deleteAlbum(db, Number(leadId), id);
    if (type === 'directory') return modules.deleteListing(db, Number(leadId), id);
    if (type === 'faq') return modules.deleteFaqItem(db, Number(leadId), id);
    if (type === 'testimonials') return modules.deleteTestimonial(db, Number(leadId), id);
    if (type === 'team') return modules.deleteTeamMember(db, Number(leadId), id);
    if (type === 'events') return modules.deleteEvent(db, Number(leadId), id);
    if (type === 'bookings') return modules.deleteBookingService(db, Number(leadId), id);
    if (type === 'chatbot') {
      const chat = require('./chatbot');
      return chat.deleteKnowledge(db, Number(leadId), id);
    }
    throw Object.assign(new Error('Unknown module type'), { code: 'VALIDATION', status: 400 });
  });
}

async function getChatbotAdmin(workspaceId, leadId, clientEmail) {
  const domain = require('./domain');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  await requireSiteModules(workspaceId, clientEmail);
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  if (!getPlan(planId).entitlements.chatbot) {
    throw Object.assign(new Error('Chatbot requires Standard or Premium.'), {
      code: 'PLAN_REQUIRED',
      status: 403,
    });
  }
  return domain.withDb(workspaceId, (db) => {
    const chat = require('./chatbot');
    return { plan: planId, ...chat.portalChatbotSummary(db, Number(leadId)) };
  });
}

async function saveChatbotSettings(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  await requireSiteModules(workspaceId, clientEmail);
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  if (!getPlan(planId).entitlements.chatbot) {
    throw Object.assign(new Error('Chatbot requires Standard or Premium.'), {
      code: 'PLAN_REQUIRED',
      status: 403,
    });
  }
  return domain.withDb(workspaceId, (db) => {
    const chat = require('./chatbot');
    return { settings: chat.saveSettings(db, Number(leadId), body || {}) };
  });
}

async function uploadChatbotKnowledge(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const extract = require('./chatbotKnowledgeExtract');
  await requireSiteModules(workspaceId, clientEmail);
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  if (!getPlan(planId).entitlements.chatbot) {
    throw Object.assign(new Error('Chatbot requires Standard or Premium.'), {
      code: 'PLAN_REQUIRED',
      status: 403,
    });
  }
  const chat = require('./chatbot');
  const storedList = await chat.storeKnowledgeUploads(workspaceId, leadId, body || {});
  return domain.withDb(workspaceId, (db) => {
    const items = storedList.map((stored) => chat.addKnowledge(db, Number(leadId), {
      kind: 'doc',
      title: stored.title,
      content_text: stored.content_text,
      file_name: stored.file_name,
      file_path: stored.file_path,
    }));
    return {
      item: items[0] || null,
      items,
      count: items.length,
      extractors: storedList.map((s) => ({
        file_name: s.file_name,
        extractor: s.extractor,
        warning: s.extract_warning,
        chars: String(s.content_text || '').length,
      })),
      supported_types: extract.SUPPORTED_LABEL,
    };
  });
}

async function resolveChatbotEscalation(workspaceId, leadId, id, clientEmail) {
  const domain = require('./domain');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => {
    const chat = require('./chatbot');
    return { escalation: chat.resolveEscalation(db, Number(leadId), id) };
  });
}

async function getBookingAdmin(workspaceId, leadId, clientEmail, opts = {}) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const includeArchived = !!(opts && opts.includeArchived);
  return domain.withDb(workspaceId, (db) => {
    modules.ensureDefaultBookingHours(db, Number(leadId));
    return {
      settings: modules.getBookingSettings(db, Number(leadId)),
      hours: modules.listBookingHours(db, Number(leadId)),
      appointments: modules.listAppointments(db, Number(leadId), {
        limit: 200,
        includeArchived,
      }),
      blocks: modules.listBookingBlocks(db, Number(leadId)),
      services: modules.listBookingServices(db, Number(leadId)),
    };
  });
}

async function saveBookingSettings(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    settings: modules.updateBookingSettings(db, Number(leadId), body || {}),
  }));
}

async function saveBookingHours(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const hours = Array.isArray(body && body.hours) ? body.hours : (Array.isArray(body) ? body : []);
  return domain.withDb(workspaceId, (db) => ({
    hours: modules.setBookingHours(db, Number(leadId), hours),
  }));
}

async function updateBookingAppointment(workspaceId, leadId, id, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => {
    let appointment = null;
    if (body && body.status != null) {
      appointment = modules.updateAppointmentStatus(db, Number(leadId), id, body.status);
    }
    if (body && body.archived != null) {
      appointment = modules.setAppointmentArchived(db, Number(leadId), id, body.archived);
    }
    if (appointment) return { appointment };
    throw Object.assign(new Error('status or archived is required'), { code: 'VALIDATION', status: 400 });
  });
}

async function createBookingBlockAdmin(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    block: modules.createBookingBlock(db, Number(leadId), body || {}),
  }));
}

async function deleteBookingBlockAdmin(workspaceId, leadId, id, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => modules.deleteBookingBlock(db, Number(leadId), id));
}

async function addModuleChild(workspaceId, leadId, moduleType, parentId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const type = String(moduleType || '').toLowerCase();
  return domain.withDb(workspaceId, (db) => {
    if (type === 'courses') {
      return { lesson: modules.addLesson(db, Number(leadId), parentId, body || {}) };
    }
    if (type === 'gallery') {
      return { image: modules.addGalleryImage(db, Number(leadId), parentId, body || {}) };
    }
    throw Object.assign(new Error('Child items only for courses (lessons) or gallery (images)'), {
      code: 'VALIDATION',
      status: 400,
    });
  });
}

async function deleteModuleChild(workspaceId, leadId, moduleType, childId, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const type = String(moduleType || '').toLowerCase();
  return domain.withDb(workspaceId, (db) => {
    if (type === 'courses') return modules.deleteLesson(db, Number(leadId), childId);
    if (type === 'gallery') return modules.deleteGalleryImage(db, Number(leadId), childId);
    throw Object.assign(new Error('Child delete only for courses or gallery'), {
      code: 'VALIDATION',
      status: 400,
    });
  });
}

async function attachSiteModule(workspaceId, leadId, moduleType, opts = {}, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const { appUrl } = require('./stripeClient');
  await requireSiteModules(workspaceId, clientEmail);
  if (String(moduleType || '').toLowerCase() === 'chatbot') {
    const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
    if (!getPlan(planId).entitlements.chatbot) {
      throw Object.assign(new Error('Chatbot requires Standard or Premium.'), {
        code: 'PLAN_REQUIRED',
        status: 403,
      });
    }
  }
  const packed = domain.withDb(workspaceId, (db) => {
    const result = modules.attachModule(db, Number(leadId), moduleType, {
      workspaceId: Number(workspaceId),
      title: opts.title,
      target_page_slug: opts.target_page_slug,
      embed_enabled: opts.embed_enabled != null ? opts.embed_enabled : opts.toSite !== false,
      appUrl: appUrl(),
    });
    const site = db.prepare(
      'SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
    ).get(Number(leadId));
    return {
      ...result,
      pages: modules.listSitePages(db, Number(leadId)),
      siteId: site && site.id,
    };
  });
  let preview = null;
  if (packed.siteId) {
    preview = await publishLiveAfterEmbed(workspaceId, packed.siteId);
  }
  const { siteId, ...rest } = packed;
  return {
    ...rest,
    previewUrl: preview && preview.url,
    via: preview && preview.via,
    publicPreviewUpdated: !!(preview && (preview.via === 'cloudflare' || preview.via === 'app_url')),
  };
}

async function detachSiteModule(workspaceId, leadId, moduleType, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const packed = domain.withDb(workspaceId, (db) => {
    const result = modules.detachModule(db, Number(leadId), moduleType);
    const site = db.prepare(
      'SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
    ).get(Number(leadId));
    return { ...result, siteId: site && site.id };
  });
  let preview = null;
  if (packed.siteId) {
    preview = await publishLiveAfterEmbed(workspaceId, packed.siteId);
  }
  const { siteId, ...rest } = packed;
  return {
    ...rest,
    previewUrl: preview && preview.url,
    via: preview && preview.via,
    publicPreviewUpdated: !!(preview && (preview.via === 'cloudflare' || preview.via === 'app_url')),
  };
}

async function requireClientMcpPlan(workspaceId, clientEmail) {
  const billing = require('./billing');
  const { isPaidPlan } = require('./plans');
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  if (!isPaidPlan(planId)) {
    throw Object.assign(
      new Error('Client MCP tokens require Standard or Premium. Upgrade in Billing.'),
      { code: 'FORBIDDEN', status: 403 }
    );
  }
  return planId;
}

async function listClientMcpTokens(workspaceId, leadId, clientEmail) {
  await requireClientMcpPlan(workspaceId, clientEmail);
  const tokens = await query(
    `SELECT id, name, token_prefix, last_used_at, created_at
     FROM workspace_tokens
     WHERE workspace_id = :workspaceId AND lead_id = :leadId
     ORDER BY id DESC`,
    { workspaceId, leadId: Number(leadId) }
  );
  return { tokens, endpoint: '/mcp' };
}

async function revokeClientMcpToken(workspaceId, leadId, clientEmail, tokenId) {
  await requireClientMcpPlan(workspaceId, clientEmail);
  const id = Number(tokenId);
  if (!id) {
    throw Object.assign(new Error('Invalid token id'), { code: 'INVALID', status: 400 });
  }
  const result = await query(
    `DELETE FROM workspace_tokens
     WHERE id = :id AND workspace_id = :workspaceId AND lead_id = :leadId`,
    { id, workspaceId, leadId: Number(leadId) }
  );
  if (!result.affectedRows) {
    throw Object.assign(new Error('Token not found'), { code: 'NOT_FOUND', status: 404 });
  }
  return { id };
}

async function createClientMcpToken(workspaceId, leadId, clientEmail, opts = {}) {
  const { createWorkspaceToken } = require('./workspace');
  await requireClientMcpPlan(workspaceId, clientEmail);
  const custom = String(opts.name || '').trim().slice(0, 80);
  const name = custom
    || `Client portal · ${String(clientEmail || '').slice(0, 40)} · lead ${leadId}`;
  const created = await createWorkspaceToken(workspaceId, name, { leadId: Number(leadId), expiresAt: opts.expiresAt ?? null, oauthUserId: opts.oauthUserId ?? null });
  return {
    ...created,
    hint:
      'Lead-scoped Bearer token for Muse or any MCP client. Connect to your workspace /mcp URL. '
      + 'Start with site.get, then site.editText / pages.structure.update / modules.* / site.publish. '
      + 'Social post scheduling via social.posts.* is Premium only; form inbox stays in the portal UI.',
  };
}

async function submitChangeRequest(workspaceId, leadId, clientEmail, body = {}) {
  const domain = require('./domain');
  const designJobs = require('../src/designJobs');
  const message = String(body.message || body.instructions || '').trim();
  const kind = String(body.kind || 'improvements').toLowerCase() === 'redesign'
    ? 'redesign'
    : 'improvements';

  if (!message) {
    throw Object.assign(new Error('Describe the changes you need'), { code: 'EMPTY' });
  }

  return domain.withDb(workspaceId, async (db) => {
    designJobs.ensureTables(db);
    let job = db.prepare(
      `SELECT * FROM design_jobs WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
    ).get(Number(leadId));

    if (!job) {
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(leadId));
      const created = designJobs.createJob(db, {
        leadId: Number(leadId),
        type: 'website',
        title: `${(lead && lead.business_name) || 'Client'} website`,
        instructions: 'Client portal change request — details in follow-up.',
        contactEmail: clientEmail || (lead && lead.email) || '',
      });
      job = db.prepare('SELECT * FROM design_jobs WHERE id = ?').get(created.id);
      if (!job) {
        throw Object.assign(new Error('Could not create change request'), { code: 'CREATE_FAILED' });
      }
    }

    const token = designJobs.ensureClientFormToken(db, job.id);
    return designJobs.submitClientForm(db, token, {
      message,
      kind,
      email: clientEmail || '',
      answers: body.answers || {},
    });
  });
}

/**
 * Ensure a staff `users` row + workspace membership for portal billing.
 * Stripe subscriptions attach to users; workspace plan reads owner/admin members.
 * Portal-only clients get a random password (staff login unused — they use /portal).
 */
async function ensureBillingUserForPortalClient(workspaceId, clientEmail, businessName = '') {
  const e = normalizeEmail(clientEmail);
  if (!e) {
    throw Object.assign(new Error('Email required for billing'), { code: 'EMAIL_REQUIRED' });
  }
  const ws = Number(workspaceId);
  if (!ws) {
    throw Object.assign(new Error('Workspace required for billing'), { code: 'WORKSPACE_REQUIRED' });
  }

  let rows = await query(
    `SELECT id, email, stripe_customer_id, status, deleted_at
     FROM users WHERE email = :email LIMIT 1`,
    { email: e }
  );
  let user = rows[0] || null;

  if (!user) {
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    const name = String(businessName || '').trim() || e.split('@')[0] || 'Client';
    const result = await query(
      `INSERT INTO users (email, password_hash, name) VALUES (:email, :hash, :name)`,
      { email: e, hash, name: name.slice(0, 120) }
    );
    let userId = result && result.insertId;
    if (!userId) {
      rows = await query(`SELECT id FROM users WHERE email = :email LIMIT 1`, { email: e });
      userId = rows[0] && rows[0].id;
    }
    if (!userId) {
      throw Object.assign(new Error('Could not create billing account'), { code: 'BILLING_USER_CREATE_FAILED' });
    }
    user = { id: userId, email: e, stripe_customer_id: null };
  }

  if (String(user.status || 'active') === 'disabled' || user.deleted_at) {
    throw Object.assign(new Error('Billing account is disabled'), { code: 'ACCOUNT_DISABLED' });
  }

  const members = await query(
    `SELECT id, role FROM workspace_members
     WHERE workspace_id = :ws AND user_id = :uid LIMIT 1`,
    { ws, uid: Number(user.id) }
  );
  // Billing linkage only — never promote portal clients to owner/admin.
  if (!members[0]) {
    await query(
      `INSERT IGNORE INTO workspace_members (workspace_id, user_id, role)
       VALUES (:ws, :uid, 'member')`,
      { ws, uid: Number(user.id) }
    );
  }

  return Number(user.id);
}

async function billingForClient(workspaceId, clientEmail) {
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const owners = await query(
    `SELECT u.id, u.email, u.name, u.subscription_status, u.billing_plan, u.current_period_end,
            u.stripe_customer_id, u.is_super_admin, u.status, u.deleted_at
     FROM workspace_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = :ws AND m.role IN ('owner','admin')
     ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, u.id ASC`,
    { ws: Number(workspaceId) }
  );
  const subscribedOwner = (owners || []).find((u) => billing.isSubscribed(u)) || (owners || [])[0] || null;
  const workspaceSubscribed = await billing.workspaceHasSubscription(workspaceId);
  const workspacePlanId = await billing.workspacePlan(workspaceId);

  let selfBilling = null;
  const e = normalizeEmail(clientEmail);
  if (e) {
    const rows = await query(
      `SELECT id, email, subscription_status, billing_plan, current_period_end,
              stripe_customer_id, stripe_subscription_id,
              is_super_admin, status, deleted_at
       FROM users WHERE email = :email LIMIT 1`,
      { email: e }
    );
    if (rows[0]) selfBilling = rows[0];
  }

  const statusSource = selfBilling || subscribedOwner;
  const selfPlan = selfBilling ? billing.planOfUser(selfBilling) : workspacePlanId;
  const selfSubscribed = !!(selfBilling && billing.isSubscribed(selfBilling));
  // Agency-covered workspace (someone else's paid plan) — contact us to change.
  // Free / self-owned billing — client can subscribe or manage via Stripe.
  const coveredByOthers = workspaceSubscribed && !selfSubscribed;
  const canSelfServe = !coveredByOthers;

  let cancelAtPeriodEnd = false;
  if (selfSubscribed && selfBilling && selfBilling.stripe_customer_id) {
    const live = await billing.getLiveSubscription(selfBilling);
    cancelAtPeriodEnd = !!(live && live.cancel_at_period_end);
  }

  const creditInfo = await require('./credits').summaryForWorkspace(workspaceId);

  // Entitlements: max(workspace owners, self). Display: self when self-serve, else workspace.
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  const displayPlan = canSelfServe && selfBilling ? selfPlan : workspacePlanId;
  const displayPlanObj = getPlan(displayPlan);

  const entitlementPlan = getPlan(planId);
  return {
    workspaceSubscribed,
    plan: displayPlan,
    planName: displayPlanObj.name,
    entitlements: { ...entitlementPlan.entitlements },
    entitlementPlan: planId,
    plans: await billing.catalogForApi(),
    subscriptionStatus: statusSource
      ? (statusSource.subscription_status || (workspaceSubscribed ? 'active' : (displayPlan === 'free' ? 'free' : 'none')))
      : (workspaceSubscribed ? 'active' : (displayPlan === 'free' ? 'free' : 'none')),
    currentPeriodEnd: statusSource ? statusSource.current_period_end : null,
    cancelAtPeriodEnd,
    canManage: canSelfServe,
    canSelfServe,
    hasCustomer: !!(selfBilling && selfBilling.stripe_customer_id),
    hasActiveSubscription: selfSubscribed,
    billingUserId: selfBilling ? selfBilling.id : null,
    selfPlan,
    amountLabel: await require('./platform').getPlatformSetting('billing.amount_label', 'Bitpype plans'),
    notice: coveredByOthers
      ? 'Your service is active under your Bitpype plan. Contact us to change billing.'
      : (cancelAtPeriodEnd
        ? 'Cancellation scheduled — you keep access until the period ends, then move to Free.'
        : null),
    credits: creditInfo,
  };
}

async function openBillingPortal(workspaceId, clientEmail) {
  const info = await billingForClient(workspaceId, clientEmail);
  if (!info.canSelfServe) {
    throw Object.assign(
      new Error(info.notice || 'Billing is managed by your Bitpype account manager'),
      { code: 'NO_SELF_BILLING' }
    );
  }
  const portalUser = await findByEmail(clientEmail);
  const userId = await ensureBillingUserForPortalClient(
    workspaceId,
    clientEmail,
    portalUser && portalUser.business_name
  );
  const billing = require('./billing');
  const { getStripe, appUrl: base } = require('./stripeClient');
  const user = await billing.getUserBilling(userId);
  if (!user || !user.stripe_customer_id) {
    return billing.createCheckoutSession(userId, 'standard', {
      forceCheckout: true,
      successUrl: `${base()}/portal?checkout=success&plan=standard`,
      cancelUrl: `${base()}/portal?checkout=cancel`,
    });
  }
  const stripe = await getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: `${base()}/portal`,
  });
  return { url: session.url };
}

async function openCheckout(workspaceId, clientEmail, planId = 'standard') {
  const info = await billingForClient(workspaceId, clientEmail);
  if (!info.canSelfServe) {
    throw Object.assign(
      new Error(info.notice || 'Billing is managed by your Bitpype account manager'),
      { code: 'NO_SELF_BILLING' }
    );
  }
  const portalUser = await findByEmail(clientEmail);
  const userId = await ensureBillingUserForPortalClient(
    workspaceId,
    clientEmail,
    portalUser && portalUser.business_name
  );
  const { appUrl: base } = require('./stripeClient');
  const plan = planId || 'standard';
  // First subscribe → Checkout; already subscribed → proration update (no second Checkout).
  return require('./billing').startOrChangePlan(userId, plan, {
    successUrl: `${base()}/portal?checkout=success&plan=${encodeURIComponent(plan)}`,
    cancelUrl: `${base()}/portal?checkout=cancel`,
  });
}

async function changePlan(workspaceId, clientEmail, planId) {
  const info = await billingForClient(workspaceId, clientEmail);
  if (!info.canSelfServe) {
    throw Object.assign(
      new Error(info.notice || 'Billing is managed by your Bitpype account manager'),
      { code: 'NO_SELF_BILLING' }
    );
  }
  const portalUser = await findByEmail(clientEmail);
  const userId = await ensureBillingUserForPortalClient(
    workspaceId,
    clientEmail,
    portalUser && portalUser.business_name
  );
  const { appUrl: base } = require('./stripeClient');
  const plan = planId || 'standard';
  return require('./billing').startOrChangePlan(userId, plan, {
    successUrl: `${base()}/portal?checkout=success&plan=${encodeURIComponent(plan)}`,
    cancelUrl: `${base()}/portal?checkout=cancel`,
  });
}

async function cancelToFree(workspaceId, clientEmail) {
  return changePlan(workspaceId, clientEmail, 'free');
}

async function resumeBilling(workspaceId, clientEmail) {
  const info = await billingForClient(workspaceId, clientEmail);
  if (!info.canSelfServe) {
    throw Object.assign(
      new Error(info.notice || 'Billing is managed by your Bitpype account manager'),
      { code: 'NO_SELF_BILLING' }
    );
  }
  const portalUser = await findByEmail(clientEmail);
  const userId = await ensureBillingUserForPortalClient(
    workspaceId,
    clientEmail,
    portalUser && portalUser.business_name
  );
  return require('./billing').resumeSubscription(userId);
}

async function openCreditsCheckout(workspaceId, clientEmail, quantity = 1) {
  const info = await billingForClient(workspaceId, clientEmail);
  if (!info.canSelfServe) {
    throw Object.assign(
      new Error(info.notice || 'Billing is managed by your Bitpype account manager'),
      { code: 'NO_SELF_BILLING' }
    );
  }
  const portalUser = await findByEmail(clientEmail);
  const userId = await ensureBillingUserForPortalClient(
    workspaceId,
    clientEmail,
    portalUser && portalUser.business_name
  );
  const { appUrl: base } = require('./stripeClient');
  return require('./billing').createCreditsCheckoutSession(userId, workspaceId, {
    quantity,
    successUrl: `${base()}/portal?checkout=credits_success`,
    cancelUrl: `${base()}/portal?checkout=cancel`,
  });
}

function leadScoutScope(leadId, workspaceWide) {
  if (workspaceWide === true) return null;
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error('Valid business scope required'), { code: 'FORBIDDEN', status: 403 });
  }
  return id;
}

function listLeadScoutContacts(workspaceId, leadId, opts = {}, { workspaceWide = false } = {}) {
  const domain = require('./domain');
  const contacts = require('./portalContacts');
  return domain.withDb(workspaceId, (db) => contacts.listContacts(db, {
    leadId: leadScoutScope(leadId, workspaceWide),
    q: opts.q || '',
    limit: opts.limit,
    offset: opts.offset,
  }));
}

function getLeadScoutContact(workspaceId, leadId, contactId, { workspaceWide = false } = {}) {
  const domain = require('./domain');
  const contacts = require('./portalContacts');
  const scope = leadScoutScope(leadId, workspaceWide);
  return domain.withDb(workspaceId, (db) => contacts.getContact(db, contactId, { leadId: scope }));
}

function leadScoutHealth(workspaceId, leadId, { workspaceWide = false } = {}) {
  const domain = require('./domain');
  const contacts = require('./portalContacts');
  const scope = leadScoutScope(leadId, workspaceWide);
  return domain.withDb(workspaceId, (db) => contacts.captureHealth(db, { leadId: scope }));
}

function retryLeadScoutFailures(workspaceId, leadId) {
  const domain = require('./domain');
  const contacts = require('./portalContacts');
  const scope = leadScoutScope(leadId, false);
  return domain.withDb(workspaceId, (db) => contacts.retryOpenFailures(db, { leadId: scope }));
}

module.exports = {
  normalizeEmail,
  generatePassword,
  findById,
  findByEmail,
  activeEmailForLead,
  findLeadMatches,
  requestAccess,
  login,
  loginWithMagicToken,
  publicClient,
  loadLeadContext,
  calendarPosts,
  generatePostBrandedImage,
  generateSocial,
  socialAccountsForClient,
  socialOauthStartForClient,
  socialDisconnectForClient,
  socialUpdatePostForClient,
  socialApprovePostsForClient,
  listLeadScoutContacts,
  getLeadScoutContact,
  leadScoutHealth,
  retryLeadScoutFailures,
  listContactForms,
  getContactForm,
  createContactForm,
  saveContactForm,
  deleteContactForm,
  publishContactForm,
  listFormSubmissions,
  getFormSubmission,
  listSiteModules,
  listModuleItems,
  createModuleItem,
  updateModuleItem,
  deleteModuleItem,
  addModuleChild,
  deleteModuleChild,
  attachSiteModule,
  detachSiteModule,
  getChatbotAdmin,
  saveChatbotSettings,
  uploadChatbotKnowledge,
  resolveChatbotEscalation,
  getBookingAdmin,
  saveBookingSettings,
  saveBookingHours,
  updateBookingAppointment,
  createBookingBlockAdmin,
  deleteBookingBlockAdmin,
  createClientMcpToken,
  listClientMcpTokens,
  revokeClientMcpToken,
  runSiteAgentChat,
  submitChangeRequest,
  ensureBillingUserForPortalClient,
  billingForClient,
  openBillingPortal,
  openCheckout,
  changePlan,
  cancelToFree,
  resumeBilling,
  openCreditsCheckout,
  resolvePreviewUrl,
  resolveExportPreviewBase,
  renderClientSite,
  applyClientThemeColors,
  publishClientSitePreview,
  applyClientTextEdits,
  applyClientImageUpload,
  applyModuleAssetUpload,
  generateClientSiteImage,
  applyClientLogoUpload,
  mutateClientListItem,
  saveClientPageHtml,
  getClientSiteStructure,
  applyClientStructureReorder,
  prepareCanvasBlock,
  normalizePortalImageSrc,
  isPortalLockedPath,
};

/**
 * Portal Muse agent chat: run lead-scoped improve loop, then return fresh editable HTML.
 * Body: { message, history?, pageSlug? }
 */
async function runSiteAgentChat(workspaceId, leadId, body = {}) {
  const museAgent = require('./museAgent');
  const domain = require('./domain');
  const message = String((body && body.message) || '').trim();
  if (!message) {
    throw Object.assign(new Error('Message is required'), { code: 'EMPTY' });
  }
  if (message.length > 4000) {
    throw Object.assign(new Error('Message is too long (max 4000 characters)'), { code: 'TOO_LONG' });
  }

  domain.withDb(workspaceId, (db) => {
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available yet'), { code: 'NO_SITE' });
    }
  });

  const pageSlug = body.pageSlug != null && String(body.pageSlug).trim() !== ''
    ? String(body.pageSlug).trim()
    : undefined;

  const loop = await domain.withDb(workspaceId, async (db) => museAgent.runPortalImproveLoop(workspaceId, leadId, {
    db,
    message,
    history: body.history,
    pageSlug,
  }));

  if (loop && loop.error === 'muse_not_configured') {
    throw Object.assign(
      new Error('AI site chat is not configured yet. Ask your BitPype admin to add the Muse Model API key.'),
      { code: 'AI_NOT_CONFIGURED' }
    );
  }
  if (loop && loop.error === 'budget_exceeded') {
    throw Object.assign(
      new Error('Daily AI budget reached. Try again tomorrow or contact support.'),
      { code: 'BUDGET_EXCEEDED' }
    );
  }

  if (loop && loop.error && !loop.mutated) {
    console.warn('[clientPortal] AI improvement failed:', String(loop.error).slice(0, 80));
    throw Object.assign(new Error('The AI could not apply this change. No website changes were saved. Please try again.'), { code: 'AI_IMPROVEMENT_FAILED', status: 502 });
  }

  // Ensure preview is rematerialized even if Muse skipped publish.
  if (loop && loop.mutated && !loop.published) {
    try {
      await publishClientSitePreview(workspaceId, leadId);
      loop.published = true;
    } catch (e) {
      console.warn('[clientPortal] agent-chat publish:', e.message || e);
    }
  } else if (loop && loop.mutated) {
    // Publish already ran inside the loop; still rematerialize local export for srcdoc.
    try {
      await publishClientSitePreview(workspaceId, leadId);
    } catch (e) {
      console.warn('[clientPortal] agent-chat rematerialize:', e.message || e);
    }
  }

  const rendered = renderClientSite(workspaceId, leadId, {
    editable: true,
    pageSlug,
  });

  return {
    reply: (loop && loop.reply) || '',
    steps: (loop && loop.steps) || 0,
    toolCalls: (loop && loop.toolCalls) || 0,
    mutated: !!(loop && loop.mutated),
    published: !!(loop && loop.published),
    model: loop && loop.model,
    error: loop && loop.error && loop.error !== 'muse_not_configured' && loop.error !== 'budget_exceeded'
      ? loop.error
      : null,
    html: rendered.html,
    previewUrl: rendered.previewUrl,
    editable: !!rendered.editable,
    theme: rendered.theme || null,
    logo: rendered.logo || null,
    pages: rendered.pages || null,
  };
}

/**
 * Build HTML for canvas insert (design module or widget) without relocating
 * existing embeds. Enables module/form embeds when placing a widget.
 * Body: { kind: 'layout'|'module'|'form', type?, cols?, formId? }
 */
function prepareCanvasBlock(workspaceId, leadId, body = {}) {
  const domain = require('./domain');
  const structure = require('../src/siteStructure');
  const engine = require('../src/websiteEngine');
  const modules = require('./siteModules');
  const forms = require('./contactForms');
  const { appUrl } = require('./stripeClient');
  const kind = String(body.kind || body.mode || 'layout').toLowerCase();
  const base = appUrl();

  if (kind === 'layout' || kind === 'design-module' || kind === 'design_module' || kind === 'section') {
    const sectionType = String(body.type || body.sectionType || body.section_type || 'text').trim().toLowerCase();
    if (!sectionType) {
      throw Object.assign(new Error('type is required'), { code: 'INVALID' });
    }
    const cols = body.cols != null ? Number(body.cols) : undefined;
    const content = structure.defaultSectionContent(sectionType, { cols });
    let html = engine.sectionToHtml({ type: sectionType, content }, {});
    if (typeof engine.sanitizeHtml === 'function') html = engine.sanitizeHtml(html);
    return { kind: 'layout', type: sectionType, html };
  }

  if (kind === 'module' || kind === 'widget-module') {
    const moduleType = String(body.type || body.moduleType || body.module_type || '').trim().toLowerCase();
    if (!moduleType) {
      throw Object.assign(new Error('module type is required'), { code: 'INVALID' });
    }
    return domain.withDb(workspaceId, (db) => {
      const mod = ensureModuleTokenForInsert(db, workspaceId, leadId, moduleType);
      db.prepare(
        `UPDATE site_module_embeds
         SET published = 1, embed_enabled = 1, updated_at = datetime('now')
         WHERE lead_id = ? AND module_type = ?`
      ).run(Number(leadId), moduleType);
      const row = modules.getEmbedRow(db, Number(leadId), moduleType);
      const embed = modules.publicEmbed(row, mod.apiBase || base);
      let html = modules.embedBlockHtml(embed, mod.apiBase || base);
      if (typeof modules.ensureModuleEmbedScript === 'function') {
        html = modules.ensureModuleEmbedScript(html, mod.apiBase || base);
      }
      return {
        kind: 'module',
        type: moduleType,
        html,
        embedEnable: {
          kind: 'module',
          moduleType,
          token: embed && embed.public_token ? embed.public_token : mod.token,
        },
      };
    });
  }

  if (kind === 'form' || kind === 'widget-form') {
    const formId = body.formId != null ? Number(body.formId) : Number(body.id);
    return domain.withDb(workspaceId, (db) => {
      let row = null;
      if (Number.isInteger(formId) && formId > 0 && typeof forms.getFormRowById === 'function') {
        row = forms.getFormRowById(db, Number(leadId), formId);
      }
      if (!row && body.token) {
        row = db.prepare(
          'SELECT * FROM contact_forms WHERE lead_id = ? AND public_token = ?'
        ).get(Number(leadId), String(body.token));
      }
      if (!row && typeof forms.listFormRows === 'function') {
        const list = forms.listFormRows(db, Number(leadId));
        row = (list || [])[0] || null;
      }
      if (!row || !row.public_token) {
        throw Object.assign(new Error('No form available to place'), { code: 'NOT_FOUND' });
      }
      db.prepare(
        `UPDATE contact_forms
         SET published = 1, embed_enabled = 1, updated_at = datetime('now')
         WHERE id = ?`
      ).run(row.id);
      const pub = forms.publicForm(row, []);
      let html = forms.embedBlockHtml(pub, base);
      if (typeof forms.ensureFormEmbedScript === 'function') {
        html = forms.ensureFormEmbedScript(html, base);
      }
      return {
        kind: 'form',
        type: 'form',
        formId: row.id,
        html,
        embedEnable: {
          kind: 'form',
          moduleType: '',
          token: row.public_token,
        },
      };
    });
  }

  throw Object.assign(new Error('Unknown canvas block kind'), { code: 'INVALID' });
}

/**
 * Menu + section structure for portal reorder UI.
 */
function getClientSiteStructure(workspaceId, leadId) {
  const domain = require('./domain');
  const structure = require('../src/siteStructure');
  return domain.withDb(workspaceId, (db) => {
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available yet'), { code: 'NO_SITE' });
    }
    const summary = structure.summarizeStructure(site.pages);
    return {
      siteId: site.id,
      name: site.name,
      freeform: pagesHaveFreeformHtml(site.pages),
      hasSections: pagesHaveEditableSections(site.pages),
      menu: summary.menu,
      pages: summary.pages,
    };
  });
}

/**
 * Reorder menu (pages) or sections. Banner/hero/nav sections stay pinned.
 * Body: { scope: 'menu'|'sections', pageIndex?, fromIndex, direction?: -1|1,
 *         action?: 'move'|'nest'|'unnest' } — nest/unnest = WordPress-style submenu indent.
 */
function ensureModuleTokenForInsert(db, workspaceId, leadId, moduleType) {
  const modules = require('./siteModules');
  const { appUrl } = require('./stripeClient');
  const type = String(moduleType || '').trim().toLowerCase();
  if (!modules.MODULE_TYPES.includes(type)) {
    throw Object.assign(new Error(`Unknown module type: ${type}`), { code: 'INVALID' });
  }
  const meta = modules.MODULE_META[type];
  const base = appUrl();
  // Token only — do not attachModule/sync here (that strips managed embeds and
  // dual-writes html+sections). Structure insert owns the in-page mount.
  let row = modules.getEmbedRow(db, Number(leadId), type);
  if (!row) {
    row = modules.ensureEmbed(db, Number(leadId), type, {
      workspaceId: Number(workspaceId),
      title: meta.defaultTitle,
    });
  }
  if (!row.public_token) {
    const token = modules.makePublicToken(Number(workspaceId));
    db.prepare(
      "UPDATE site_module_embeds SET public_token = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(token, row.id);
    row = modules.getEmbedRow(db, Number(leadId), type);
  }
  return {
    token: row.public_token,
    apiBase: base,
    title: row.title || meta.label,
  };
}

function applyClientStructureReorder(workspaceId, leadId, body = {}) {
  const domain = require('./domain');
  const structure = require('../src/siteStructure');
  const modules = require('./siteModules');
  const scope = String(body.scope || '').toLowerCase();
  const fromIndex = Number(body.fromIndex);
  const action = String(body.action || 'move').toLowerCase();
  const isNest = action === 'nest' || action === 'indent';
  const isUnnest = action === 'unnest' || action === 'outdent';
  const isToggleNav = action === 'togglenav' || action === 'toggle-nav' || action === 'toggle_nav';
  const isInsertModule = action === 'insertmodule' || action === 'insert-module' || action === 'insert_module';
  const isInsertSection = action === 'insertsection' || action === 'insert-section' || action === 'insert_section'
    || action === 'insertblock' || action === 'insert-block' || action === 'insert_block';
  const isAddPage = action === 'addpage' || action === 'add-page' || action === 'add_page';
  if (scope !== 'menu' && scope !== 'sections') {
    throw Object.assign(new Error('scope must be menu or sections'), { code: 'INVALID' });
  }
  if (isInsertModule || isInsertSection) {
    if (scope !== 'sections') {
      throw Object.assign(new Error('insert requires scope sections'), { code: 'INVALID' });
    }
  } else if (isAddPage) {
    if (scope !== 'menu') {
      throw Object.assign(new Error('addPage requires scope menu'), { code: 'INVALID' });
    }
  } else if (!Number.isInteger(fromIndex) || fromIndex < 0) {
    throw Object.assign(new Error('Invalid fromIndex'), { code: 'INVALID' });
  }
  if (!isInsertModule && !isInsertSection && !isAddPage && scope === 'sections' && (!isNest && !isUnnest && !isToggleNav)) {
    const direction = Number(body.direction);
    if (direction !== 1 && direction !== -1) {
      throw Object.assign(new Error('direction must be 1 or -1'), { code: 'INVALID' });
    }
  }
  if (!isInsertModule && !isInsertSection && !isAddPage && scope === 'menu' && (!isNest && !isUnnest && !isToggleNav)) {
    const direction = Number(body.direction);
    if (direction !== 1 && direction !== -1) {
      throw Object.assign(new Error('direction must be 1 or -1'), { code: 'INVALID' });
    }
  }

  const prepared = domain.withDb(workspaceId, (db) => {
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available yet'), { code: 'NO_SITE' });
    }
    let result;
    if (isAddPage) {
      const title = String(body.title || '').trim();
      if (!title) {
        throw Object.assign(new Error('Page title is required'), { code: 'INVALID' });
      }
      const slug = body.slug != null ? String(body.slug).trim() : undefined;
      const shellHtml = modules.shellHtmlFromPages(site.pages, slug || structure.titleToPageSlug(title));
      result = structure.createClientPage(site.pages, {
        title,
        slug,
        shellHtml,
        fillShellMain: modules.fillShellMain,
        defaultInner: modules.defaultClientPageInner,
      });
      if (!result.changed) {
        throw Object.assign(new Error('Could not create page'), { code: 'NO_MOVE' });
      }
      if (result.pageIndex != null && result.pages[result.pageIndex]
        && typeof result.pages[result.pageIndex].html === 'string') {
        result.pages[result.pageIndex].html = modules.ensureClientPageChrome(
          result.pages[result.pageIndex].html
        );
      }
    } else if (isInsertSection) {
      const pageIndex = Number(body.pageIndex);
      const afterIndex = Number(body.afterIndex);
      const sectionType = String(body.sectionType || body.section_type || body.type || '').trim().toLowerCase();
      if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        throw Object.assign(new Error('Invalid pageIndex'), { code: 'INVALID' });
      }
      if (!Number.isInteger(afterIndex) || afterIndex < -1) {
        throw Object.assign(new Error('Invalid afterIndex'), { code: 'INVALID' });
      }
      if (!sectionType) {
        throw Object.assign(new Error('sectionType is required'), { code: 'INVALID' });
      }
      const cols = body.cols != null ? Number(body.cols) : undefined;
      const html = body.html != null ? String(body.html) : undefined;
      result = structure.insertContentSection(site.pages, pageIndex, afterIndex, sectionType, { cols, html });
      if (!result.changed) {
        throw Object.assign(
          new Error(result.reason === 'no_sections'
            ? 'This page has no modular sections yet'
            : 'Cannot insert that section type'),
          { code: 'NO_MOVE' }
        );
      }
    } else if (isInsertModule) {
      const pageIndex = Number(body.pageIndex);
      const afterIndex = Number(body.afterIndex);
      const moduleType = String(body.moduleType || body.module_type || '').trim().toLowerCase();
      if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        throw Object.assign(new Error('Invalid pageIndex'), { code: 'INVALID' });
      }
      if (!Number.isInteger(afterIndex) || afterIndex < -1) {
        throw Object.assign(new Error('Invalid afterIndex'), { code: 'INVALID' });
      }
      if (!moduleType) {
        throw Object.assign(new Error('moduleType is required'), { code: 'INVALID' });
      }
      const mod = ensureModuleTokenForInsert(db, workspaceId, leadId, moduleType);
      const page = site.pages[pageIndex];
      const hasSections = page && Array.isArray(page.sections) && page.sections.length;
      if (hasSections) {
        result = structure.insertModuleSection(site.pages, pageIndex, afterIndex, {
          module_type: moduleType,
          public_token: mod.token,
          api_base: mod.apiBase,
          title: mod.title,
        });
      } else if (page && typeof page.html === 'string' && page.html.trim()) {
        const embed = modules.publicEmbed(modules.getEmbedRow(db, Number(leadId), moduleType), mod.apiBase);
        const block = modules.embedBlockHtml(embed, mod.apiBase);
        const pagesCopy = JSON.parse(JSON.stringify(site.pages));
        const p = pagesCopy[pageIndex];
        p.html = modules.ensureModuleEmbedScript(modules.injectHtmlEmbed(p.html, block), mod.apiBase);
        result = { pages: pagesCopy, changed: true };
      } else {
        throw Object.assign(new Error('This page has no sections to insert into'), { code: 'NO_MOVE' });
      }
      if (!result.changed) {
        throw Object.assign(new Error('Cannot insert module on this page'), { code: 'NO_MOVE' });
      }
    } else if (scope === 'menu') {
      result = structure.applyMenuAction(site.pages, {
        action: isToggleNav ? 'toggleNav' : (isNest ? 'nest' : (isUnnest ? 'unnest' : 'move')),
        fromIndex,
        direction: body.direction,
      });
    } else {
      const pageIndex = Number(body.pageIndex);
      if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        throw Object.assign(new Error('Invalid pageIndex'), { code: 'INVALID' });
      }
      result = structure.reorderSections(site.pages, pageIndex, fromIndex, Number(body.direction));
    }
    if (!result.changed) {
      throw Object.assign(new Error('Cannot move that item'), { code: 'NO_MOVE' });
    }
    return {
      siteId: site.id,
      pages: result.pages,
      theme: site.theme && typeof site.theme === 'object' ? site.theme : {},
      previewFallback: resolvePreviewUrl(site),
      newPageIndex: result.pageIndex,
    };
  });

  const note = isAddPage
    ? 'Client portal: added page'
    : (isInsertSection
      ? 'Client portal: inserted layout section'
      : (isInsertModule
        ? 'Client portal: inserted module section'
        : (scope === 'menu'
          ? (isToggleNav ? 'Client portal: menu visibility'
            : (isNest ? 'Client portal: nested menu item'
              : (isUnnest ? 'Client portal: unnested menu item' : 'Client portal: reordered menu')))
          : 'Client portal: reordered sections')));
  const saved = domain.sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note,
  });
  syncDesignDeliverablePages(workspaceId, leadId, prepared.siteId, prepared.pages, prepared.theme);
  const previewRow = domain.withDb(workspaceId, (db) =>
    db.prepare(`SELECT preview_url, preview_path FROM websites WHERE id = ?`).get(prepared.siteId)
  );
  const summary = structure.summarizeStructure(prepared.pages);
  return {
    siteId: prepared.siteId,
    scope,
    version: saved.version,
    previewUrl: resolvePreviewUrl(previewRow) || prepared.previewFallback,
    menu: summary.menu,
    pages: summary.pages,
    pageIndex: prepared.newPageIndex,
  };
}
