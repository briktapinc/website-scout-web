'use strict';
/**
 * outreach.js — campaign / queue / intent / pipeline business logic.
 *
 * All functions take a better-sqlite3 db instance (per CONTRACT.md).
 * Sending NEVER happens without checking, in order:
 *   1. automation_paused setting
 *   2. suppression_list (recipient email)
 *   3. cost.max_outreach_per_day daily cap
 *
 * src/ai.js is owned by another workstream: we require it defensively and
 * degrade gracefully (template-only personalization) when it is absent.
 */

const { getProvider, personalize, isValidEmail, sanitizeEmailHtml, looksLikeHtml } = require('./email');
const {
  normalizePhone, isValidPhone, getSmsProvider, resolveSmsSettings, plainSmsBody,
} = require('./sms');

let ai = null;
try {
  ai = require('./ai'); // owned by Website Engine workstream
} catch {
  ai = null; // degrade gracefully: no AI personalization
}

/* ------------------------------------------------------------------ */
/* Schema patches (idempotent)                                         */
/* ------------------------------------------------------------------ */

function tableHasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  } catch {
    return false;
  }
}

function templateHasEmail(tpl) {
  if (!tpl) return false;
  const body = String(tpl.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return !!body;
}

function templateHasSms(tpl) {
  if (!tpl) return false;
  if (String(tpl.sms_body || '').trim()) return true;
  // Legacy SMS-only rows stored plain text in body with channel=sms
  return String(tpl.channel || '').toLowerCase() === 'sms' && !!String(tpl.body || '').trim();
}

function templateSmsText(tpl) {
  if (!tpl) return '';
  const fromCol = plainSmsBody(tpl.sms_body || '');
  if (fromCol) return fromCol;
  if (String(tpl.channel || '').toLowerCase() === 'sms') return plainSmsBody(tpl.body || '');
  return '';
}

/**
 * Merge legacy channel-split templates into dual-channel rows (sms_body on email).
 * Match SMS rows to email rows by name when possible; otherwise convert in place.
 */
function migrateUnifiedTemplates(db) {
  if (!tableHasColumn(db, 'email_templates', 'channel')) return;
  if (!tableHasColumn(db, 'email_templates', 'sms_body')) return;
  let smsRows;
  try {
    smsRows = db.prepare(
      `SELECT * FROM email_templates WHERE lower(IFNULL(channel, 'email')) = 'sms'`
    ).all();
  } catch {
    return;
  }
  if (!smsRows.length) return;

  const txn = db.transaction(() => {
    for (const sms of smsRows) {
      const smsText = plainSmsBody(sms.sms_body || sms.body || '');
      const emailMatch = db.prepare(
        `SELECT * FROM email_templates
         WHERE lower(name) = lower(?) AND id != ?
           AND lower(IFNULL(channel, 'email')) != 'sms'`
      ).get(sms.name, sms.id);

      if (emailMatch) {
        if (!String(emailMatch.sms_body || '').trim() && smsText) {
          db.prepare('UPDATE email_templates SET sms_body = ? WHERE id = ?')
            .run(smsText, emailMatch.id);
        }
        try {
          db.prepare('UPDATE campaigns SET template_id = ? WHERE template_id = ?')
            .run(emailMatch.id, sms.id);
        } catch { /* ignore */ }
        db.prepare('DELETE FROM email_templates WHERE id = ?').run(sms.id);
      } else {
        const subject = (sms.subject && sms.subject !== '(SMS)')
          ? sms.subject
          : (sms.name || 'Outreach');
        db.prepare(
          `UPDATE email_templates
           SET sms_body = ?, body = '', subject = ?, channel = 'email'
           WHERE id = ?`
        ).run(smsText, subject, sms.id);
      }
    }
  });
  txn();
}

/** Add dual-channel template + message columns (safe on existing DBs). */
function ensureTables(db) {
  if (!tableHasColumn(db, 'email_templates', 'channel')) {
    try { db.exec(`ALTER TABLE email_templates ADD COLUMN channel TEXT NOT NULL DEFAULT 'email'`); }
    catch { /* race / already added */ }
  }
  if (!tableHasColumn(db, 'email_templates', 'sms_body')) {
    try { db.exec(`ALTER TABLE email_templates ADD COLUMN sms_body TEXT NOT NULL DEFAULT ''`); }
    catch { /* race / already added */ }
  }
  if (!tableHasColumn(db, 'campaign_messages', 'channel')) {
    try { db.exec(`ALTER TABLE campaign_messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'email'`); }
    catch { /* ignore */ }
  }
  if (!tableHasColumn(db, 'campaign_messages', 'to_phone')) {
    try { db.exec(`ALTER TABLE campaign_messages ADD COLUMN to_phone TEXT`); }
    catch { /* ignore */ }
  }
  if (!tableHasColumn(db, 'campaign_messages', 'media_url')) {
    try { db.exec(`ALTER TABLE campaign_messages ADD COLUMN media_url TEXT`); }
    catch { /* ignore */ }
  }
  if (!tableHasColumn(db, 'campaign_messages', 'send_mode')) {
    try { db.exec(`ALTER TABLE campaign_messages ADD COLUMN send_mode TEXT`); }
    catch { /* ignore */ }
  }
  try {
    require('./siteScreenshots').ensureTables(db);
  } catch { /* optional until module loads */ }
  try { migrateUnifiedTemplates(db); }
  catch (e) {
    try { logActivity(db, 'outreach', `Template migrate skipped: ${String(e && e.message || e).slice(0, 200)}`); }
    catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/* Settings helpers                                                    */
/* ------------------------------------------------------------------ */

function readSettings(db) {
  const out = {};
  try {
    for (const row of db.prepare('SELECT key, value FROM settings').all()) {
      out[row.key] = row.value;
    }
  } catch { /* settings table may not exist yet in tests */ }
  return out;
}

function getSetting(db, key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  } catch {
    return fallback;
  }
}

function isAutomationPaused(db) {
  return getSetting(db, 'automation_paused', '0') === '1';
}

function logActivity(db, area, message) {
  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(area, message);
  } catch { /* activity logging must never break business logic */ }
}

/* ------------------------------------------------------------------ */
/* Intent scoring (spec section 31)                                    */
/* ------------------------------------------------------------------ */

// NOTE: Email open/click tracking is BEST-EFFORT in this desktop app — there
// is no hosted endpoint for tracking pixels. Open/click (and all other)
// prospect events are recorded manually via intent:record or generated by
// campaign send events. Nothing here invents engagement data.
const INTENT_POINTS = {
  'email.opened': 2,
  'email.clicked': 10,
  'email.interested': 25,
  'email.uninterested': 0,
  'preview.viewed': 10,
  'preview.viewed_twice': 10,
  'editor.opened': 15,
  'text.changed': 10,
  'logo.uploaded': 15,
  'site.claimed': 20,
  'pricing.viewed': 10,
  'domain.searched': 15,
  'domain.purchased': 30,
  'trial.activated': 40,
  // Deferred claim choice from preview/claim popup — analytics only, not positive.
  'claim.later': 0,
  // 0-point operational events (recorded for the timeline, not scored)
  'email.sent': 0,
  'email.failed': 0,
  'sms.sent': 0,
  'sms.failed': 0,
};

function intentLabel(score, leadStatus) {
  if (leadStatus === 'customer') return 'Customer';
  if (score >= 61) return 'Hot';
  if (score >= 31) return 'Interested';
  if (score >= 11) return 'Warm';
  return 'Cold';
}

/**
 * Record a prospect event and recompute the lead's intent score from ALL of
 * its events (spec section 31 point table). Stores a new intent_scores row.
 */
function recordIntent(db, leadId, type, detail) {
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid leadId');
  if (!Object.prototype.hasOwnProperty.call(INTENT_POINTS, type)) {
    throw new Error(`Unknown intent event type: ${type}`);
  }
  const lead = db.prepare('SELECT id, business_name, status FROM leads WHERE id = ?').get(id);
  if (!lead) throw new Error(`Lead ${id} not found`);

  db.prepare('INSERT INTO prospect_events (lead_id, type, detail) VALUES (?, ?, ?)')
    .run(id, type, detail || null);

  const events = db.prepare('SELECT type FROM prospect_events WHERE lead_id = ?').all(id);
  const breakdown = {};
  let score = 0;
  for (const e of events) {
    const pts = INTENT_POINTS[e.type] || 0;
    if (pts > 0) {
      score += pts;
      breakdown[e.type] = (breakdown[e.type] || 0) + pts;
    }
  }
  const prev = db.prepare(
    'SELECT label FROM intent_scores WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
  ).get(id);
  const label = intentLabel(score, lead.status);
  db.prepare('INSERT INTO intent_scores (lead_id, score, label, breakdown) VALUES (?, ?, ?, ?)')
    .run(id, score, label, JSON.stringify(breakdown));

  // Spec section 33: 61+ = notify admin of a HOT LEAD.
  if (label === 'Hot' && (!prev || prev.label !== 'Hot')) {
    logActivity(db, 'intent', `HOT LEAD: ${lead.business_name} — intent score ${score}`);
  }
  return { leadId: id, score, label, breakdown };
}

/** Latest intent score row for a lead (defaults to Cold/0). */
function getIntent(db, leadId) {
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid leadId');
  const row = db.prepare(
    'SELECT score, label, breakdown, at FROM intent_scores WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
  ).get(id);
  if (!row) return { leadId: id, score: 0, label: 'Cold', breakdown: {}, at: null };
  let breakdown = {};
  try { breakdown = JSON.parse(row.breakdown || '{}'); } catch { /* keep {} */ }
  return { leadId: id, score: row.score, label: row.label, breakdown, at: row.at };
}

/* ------------------------------------------------------------------ */
/* Suppression list                                                    */
/* ------------------------------------------------------------------ */

const SUPPRESSION_REASONS = ['unsubscribed', 'bounced', 'do-not-contact', 'complaint'];

function isSuppressed(db, email) {
  if (!email) return null;
  return db.prepare('SELECT * FROM suppression_list WHERE email = ?')
    .get(String(email).trim().toLowerCase()) || null;
}

function listSuppressions(db, opts = {}) {
  const { pageArgs, pageResult } = require('./paginate');
  const { page, pageSize, offset } = pageArgs(opts, { pageSize: 50, maxSize: 200 });
  const total = db.prepare('SELECT COUNT(*) AS c FROM suppression_list').get().c;
  const rows = db.prepare(
    'SELECT * FROM suppression_list ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(pageSize, offset);
  return pageResult(rows, total, page, pageSize);
}

function addSuppression(db, email, reason) {
  const clean = String(email || '').trim().toLowerCase();
  if (!isValidEmail(clean)) throw new Error('Invalid email address');
  const r = String(reason || 'do-not-contact');
  if (!SUPPRESSION_REASONS.includes(r)) throw new Error(`Invalid reason (expected one of ${SUPPRESSION_REASONS.join(', ')})`);
  db.prepare('INSERT OR IGNORE INTO suppression_list (email, reason) VALUES (?, ?)').run(clean, r);
  // Anything still queued for this address must never send.
  const upd = db.prepare(
    `UPDATE campaign_messages SET status = 'suppressed', error = ?
     WHERE lower(to_email) = ? AND status = 'queued'`
  ).run(`suppressed: ${r}`, clean);
  logActivity(db, 'compliance', `Suppression added: ${clean} (${r}); ${upd.changes} queued message(s) suppressed`);
  return { email: clean, reason: r, suppressedQueued: upd.changes };
}

function removeSuppression(db, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new Error('Invalid suppression id');
  const res = db.prepare('DELETE FROM suppression_list WHERE id = ?').run(n);
  return { removed: res.changes };
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

function listTemplates(db, opts = {}) {
  ensureTables(db);
  const rows = db.prepare('SELECT * FROM email_templates ORDER BY name').all();
  // Optional filter: templates usable for a send channel (has that content).
  const channel = opts && opts.channel ? String(opts.channel).toLowerCase() : '';
  if (channel === 'sms') return rows.filter(templateHasSms);
  if (channel === 'email') return rows.filter(templateHasEmail);
  return rows;
}

/**
 * Canonical public URL for the lead's active website (latest websites row).
 * Prefer Cloudflare preview_url; else APP_URL /site-previews/… from preview_path.
 * Never returns a filesystem path. Empty string when unknown (same as other merge vars).
 */
function resolveWebsiteLink(db, leadId) {
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0) return '';
  let site = null;
  try {
    site = db.prepare(
      `SELECT preview_url, preview_path, custom_domain FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
    ).get(id);
  } catch {
    try {
      site = db.prepare(
        `SELECT preview_url, preview_path FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
      ).get(id);
    } catch {
      return '';
    }
  }
  if (!site) return '';
  const custom = site.custom_domain && String(site.custom_domain).trim().toLowerCase();
  if (custom) return `https://${custom.replace(/^https?:\/\//, '')}`;
  if (site.preview_url && String(site.preview_url).trim()) {
    return String(site.preview_url).trim();
  }
  const appBase = String(process.env.APP_URL || '').replace(/\/$/, '');
  if (!appBase || !site.preview_path) return '';
  const p = String(site.preview_path).replace(/\\/g, '/');
  const m = p.match(/website-scout-exports\/([^/]+)/i)
    || p.match(/\/([^/]+-site-[^/]+)\/?$/i);
  if (m) return `${appBase}/site-previews/${m[1]}/`;
  const parts = p.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  if (last && /site|ws-/i.test(last)) return `${appBase}/site-previews/${last}/`;
  return '';
}

/* ------------------------------------------------------------------ */
/* Signed interest / not-interested email links                        */
/* ------------------------------------------------------------------ */

/** HMAC secret — same family as Meta OAuth state (SESSION_SECRET). */
function interestLinkSecret() {
  const secret = process.env.SESSION_SECRET || process.env.OUTREACH_LINK_SECRET || '';
  if (secret && secret !== 'dev-change-me') return secret;
  // Refuse the hardcoded dev fallback on real public hosts (forging risk).
  const app = String(process.env.APP_URL || '');
  const publicHost = app
    && !/localhost|127\.0\.0\.1/i.test(app)
    && /^https?:\/\//i.test(app);
  if (publicHost || process.env.NODE_ENV === 'production') {
    throw Object.assign(
      new Error('SESSION_SECRET (or OUTREACH_LINK_SECRET) must be set for interest response links'),
      { code: 'MISCONFIGURED' }
    );
  }
  return secret || 'dev-change-me';
}

/**
 * Token payload: { w: workspaceId, l: leadId, a: 'i'|'u'|'c', v: 1 }
 * a=c is the claim/Yes-No page (not a direct interested click).
 * Format: base64url(json).base64url(hmac-sha256) — matches socialPublic OAuth state.
 */
function normalizeInterestAction(action) {
  const raw = String(action || '').toLowerCase();
  if (raw === 'uninterested' || raw === 'u') return 'u';
  if (raw === 'claim' || raw === 'c') return 'c';
  if (raw === 'interested' || raw === 'i' || raw === '') return 'i';
  return null;
}

function signInterestToken({ workspaceId, leadId, action }) {
  const crypto = require('crypto');
  const a = normalizeInterestAction(action);
  if (!a) throw new Error('Invalid interest action');
  const w = Number(workspaceId);
  const l = Number(leadId);
  if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(l) || l <= 0) {
    throw new Error('workspaceId and leadId are required to sign interest links');
  }
  const body = Buffer.from(JSON.stringify({ w, l, a, v: 1 })).toString('base64url');
  const sig = crypto.createHmac('sha256', interestLinkSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyInterestToken(token) {
  const crypto = require('crypto');
  const raw = String(token || '').trim();
  const [body, sig] = raw.split('.');
  if (!body || !sig) {
    throw Object.assign(new Error('Invalid response link'), { code: 'INVALID_TOKEN' });
  }
  const expect = crypto.createHmac('sha256', interestLinkSecret()).update(body).digest('base64url');
  const aBuf = Buffer.from(sig);
  const bBuf = Buffer.from(expect);
  if (aBuf.length !== bBuf.length || !crypto.timingSafeEqual(aBuf, bBuf)) {
    throw Object.assign(new Error('Invalid or forged response link'), { code: 'INVALID_TOKEN' });
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid response link'), { code: 'INVALID_TOKEN' });
  }
  const workspaceId = Number(payload.w);
  const leadId = Number(payload.l);
  const action = payload.a === 'u'
    ? 'uninterested'
    : payload.a === 'c'
      ? 'claim'
      : payload.a === 'i'
        ? 'interested'
        : null;
  if (!Number.isInteger(workspaceId) || workspaceId <= 0
    || !Number.isInteger(leadId) || leadId <= 0 || !action) {
    throw Object.assign(new Error('Invalid response link'), { code: 'INVALID_TOKEN' });
  }
  return { workspaceId, leadId, action };
}

/** Public GET path (no session) for interest / not-interested clicks. */
function interestResponsePath(token) {
  return `/api/v1/outreach/public/response/${encodeURIComponent(token)}`;
}

/**
 * HTML anchor for {{interested}} / {{uninterested}}.
 * Empty string when APP_URL or workspaceId is missing (same as other merge vars).
 */
function buildInterestAnchor(workspaceId, leadId, action) {
  const base = String(process.env.APP_URL || '').replace(/\/$/, '');
  const w = Number(workspaceId);
  if (!base || !Number.isInteger(w) || w <= 0) return '';
  const act = action === 'uninterested' || action === 'u' ? 'uninterested' : 'interested';
  try {
    const token = signInterestToken({ workspaceId: w, leadId, action: act });
    const url = `${base}${interestResponsePath(token)}`;
    const label = act === 'uninterested' ? 'Not interested' : "I'm interested";
    return `<a href="${url}">${label}</a>`;
  } catch {
    return '';
  }
}

/**
 * Apply a verified interest / not-interested click. Idempotent for status + events.
 * - interested → lead status `engaged` (does not demote claimed/trial/customer)
 * - uninterested → lead status `lost` (skips paying customers) + suppression
 */
function applyInterestResponse(db, leadId, action) {
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid leadId');
  const lead = db.prepare(
    'SELECT id, business_name, email, status FROM leads WHERE id = ?'
  ).get(id);
  if (!lead) throw Object.assign(new Error('Lead not found'), { code: 'NOT_FOUND' });

  const act = action === 'uninterested' ? 'uninterested' : 'interested';
  const eventType = act === 'uninterested' ? 'email.uninterested' : 'email.interested';
  const prior = db.prepare(
    'SELECT id FROM prospect_events WHERE lead_id = ? AND type = ? LIMIT 1'
  ).get(id, eventType);
  const already = !!prior;

  if (act === 'interested') {
    if (!['claimed', 'trial', 'customer'].includes(lead.status)) {
      db.prepare(
        `UPDATE leads SET status = 'engaged', updated_at = datetime('now') WHERE id = ?`
      ).run(id);
    }
    if (!prior) {
      recordIntent(db, id, 'email.interested', 'Clicked interested link in outreach email');
    }
    const statusRow = db.prepare('SELECT status FROM leads WHERE id = ?').get(id);
    logActivity(db, 'outreach',
      `${already ? 'Re-click' : 'Click'} interested: ${lead.business_name} (#${id}) → ${statusRow.status}`);
    return {
      action: act,
      leadId: id,
      status: statusRow.status,
      already,
      businessName: lead.business_name || '',
    };
  }

  // uninterested
  if (lead.status !== 'customer') {
    db.prepare(
      `UPDATE leads SET status = 'lost', updated_at = datetime('now') WHERE id = ?`
    ).run(id);
  }
  if (!prior) {
    recordIntent(db, id, 'email.uninterested', 'Clicked not-interested link in outreach email');
  }
  if (lead.email) {
    try { addSuppression(db, lead.email, 'do-not-contact'); }
    catch { /* already suppressed or invalid — ignore */ }
  }
  const statusRow = db.prepare('SELECT status FROM leads WHERE id = ?').get(id);
  logActivity(db, 'outreach',
    `${already ? 'Re-click' : 'Click'} not interested: ${lead.business_name} (#${id}) → ${statusRow.status}`);
  return {
    action: act,
    leadId: id,
    status: statusRow.status,
    already,
    businessName: lead.business_name || '',
  };
}

/**
 * Claim popup / claim page decision: Yes / No / Later.
 * - interested | uninterested → applyInterestResponse (engaged / lost)
 * - later | deferred | maybe → record claim.later (0 pts); does not change status;
 *   popup may re-show on a future visit (session hide only on the client)
 */
function applyClaimResponse(db, leadId, action) {
  const raw = String(action || '').toLowerCase().trim();
  if (raw === 'later' || raw === 'deferred' || raw === 'maybe' || raw === 'maybe_later') {
    const id = Number(leadId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid leadId');
    const lead = db.prepare(
      'SELECT id, business_name, status FROM leads WHERE id = ?'
    ).get(id);
    if (!lead) throw Object.assign(new Error('Lead not found'), { code: 'NOT_FOUND' });
    const priorCount = db.prepare(
      `SELECT COUNT(*) AS c FROM prospect_events WHERE lead_id = ? AND type = 'claim.later'`
    ).get(id);
    const already = Number(priorCount && priorCount.c) > 0;
    recordIntent(db, id, 'claim.later', 'Chose Maybe later on claim popup');
    logActivity(db, 'outreach',
      `Claim later: ${lead.business_name} (#${id}) → ${lead.status}`);
    return {
      action: 'later',
      leadId: id,
      status: lead.status,
      already,
      deferred: true,
      businessName: lead.business_name || '',
    };
  }
  const act = raw === 'uninterested' || raw === 'no' ? 'uninterested' : 'interested';
  const detailNote = act === 'uninterested'
    ? 'Chose No on claim popup'
    : 'Chose Yes on claim popup';
  const result = applyInterestResponse(db, leadId, act);
  // Prefer claim-specific activity wording when coming from the claim UI
  // (applyInterestResponse already logged email-link style; keep return shape).
  if (!result.already) {
    try {
      logActivity(db, 'outreach', `${detailNote}: ${result.businessName} (#${result.leadId}) → ${result.status}`);
    } catch { /* optional */ }
  }
  return result;
}

/** Merge extras for personalize(): website_link, interested/uninterested anchors, from_name, site screenshots. */
function personalizeExtras(db, leadId, fromName, opts = {}) {
  const websiteLink = resolveWebsiteLink(db, leadId);
  const workspaceId = Number(opts && opts.workspaceId);
  const out = {
    from_name: fromName || '',
    website_link: websiteLink,
    preview_url: websiteLink,
    interested: buildInterestAnchor(workspaceId, leadId, 'interested'),
    uninterested: buildInterestAnchor(workspaceId, leadId, 'uninterested'),
  };
  try {
    const shots = require('./siteScreenshots').screenshotMergeFields(db, leadId, {
      websiteLink,
      forSms: !!(opts && opts.forSms),
    });
    Object.assign(out, shots);
  } catch { /* screenshots optional */ }
  return out;
}

/**
 * Save a dual-channel outreach template (email subject/body + optional sms_body).
 * Legacy callers that pass channel:'sms' with body-as-SMS are accepted and stored in sms_body.
 */
function saveTemplate(db, { id, name, subject, body, sms_body, smsBody, channel }) {
  ensureTables(db);
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Template name is required');

  let cleanBody = String(body == null ? '' : body).trim();
  let cleanSubject = String(subject == null ? '' : subject).trim();
  let cleanSms = plainSmsBody(
    sms_body != null ? sms_body : (smsBody != null ? smsBody : '')
  );

  // Backward compat: old SMS-only save shape.
  if (String(channel || '').toLowerCase() === 'sms' && !cleanSms) {
    cleanSms = plainSmsBody(cleanBody);
    cleanBody = '';
    if (cleanSubject === '(SMS)') cleanSubject = '';
  }

  if (cleanBody && looksLikeHtml(cleanBody)) cleanBody = sanitizeEmailHtml(cleanBody);
  if (cleanSms.length > 1600) throw new Error('SMS body must be 1600 characters or fewer');

  const hasEmail = !!String(cleanBody || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const hasSms = !!cleanSms;
  if (!hasEmail && !hasSms) throw new Error('Provide an email body and/or SMS body');
  if (hasEmail && !cleanSubject) throw new Error('Template subject is required');
  if (!cleanSubject) cleanSubject = cleanName;

  if (id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new Error('Invalid template id');
    const res = db.prepare(
      `UPDATE email_templates
       SET name = ?, subject = ?, body = ?, sms_body = ?, channel = 'email'
       WHERE id = ?`
    ).run(cleanName, cleanSubject, cleanBody, cleanSms, n);
    if (!res.changes) throw new Error('Template not found');
    return { id: n, hasEmail, hasSms };
  }
  const res = db.prepare(
    `INSERT INTO email_templates (name, subject, body, sms_body, channel)
     VALUES (?, ?, ?, ?, 'email')`
  ).run(cleanName, cleanSubject, cleanBody, cleanSms);
  return { id: Number(res.lastInsertRowid), hasEmail, hasSms };
}

function deleteTemplate(db, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new Error('Invalid template id');
  const inUse = db.prepare('SELECT COUNT(*) AS c FROM campaigns WHERE template_id = ?').get(n).c;
  if (inUse > 0) throw new Error(`Template is used by ${inUse} campaign(s); cannot delete`);
  const res = db.prepare('DELETE FROM email_templates WHERE id = ?').run(n);
  if (!res.changes) throw new Error('Template not found');
  return { deleted: true };
}

/* ------------------------------------------------------------------ */
/* Campaigns                                                           */
/* ------------------------------------------------------------------ */

const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'done', 'cancelled'];

function listCampaigns(db, opts = {}) {
  const { pageArgs, pageResult } = require('./paginate');
  const { page, pageSize, offset } = pageArgs(opts, { pageSize: 25, maxSize: 100 });
  const total = db.prepare('SELECT COUNT(*) AS c FROM campaigns').get().c;
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM campaign_messages m WHERE m.campaign_id = c.id AND m.status = 'queued') AS queued,
      (SELECT COUNT(*) FROM campaign_messages m WHERE m.campaign_id = c.id AND m.status = 'sent') AS sent,
      (SELECT COUNT(*) FROM campaign_messages m WHERE m.campaign_id = c.id AND m.status = 'failed') AS failed,
      (SELECT COUNT(*) FROM campaign_messages m WHERE m.campaign_id = c.id AND m.status = 'suppressed') AS suppressed
    FROM campaigns c ORDER BY c.created_at DESC
    LIMIT ? OFFSET ?
  `).all(pageSize, offset);
  return pageResult(rows, total, page, pageSize);
}

function cancelQueuedMessages(db, campaignId) {
  const upd = db.prepare(
    `UPDATE campaign_messages SET status = 'suppressed', error = ?
     WHERE campaign_id = ? AND status = 'queued'`
  ).run('campaign cancelled', campaignId);
  return upd.changes;
}

function setCampaignStatus(db, id, status) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new Error('Invalid campaign id');
  if (!CAMPAIGN_STATUSES.includes(status)) throw new Error(`Invalid status (expected one of ${CAMPAIGN_STATUSES.join(', ')})`);
  const row = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(n);
  if (!row) throw new Error('Campaign not found');
  if (row.status === 'cancelled' && status !== 'cancelled') {
    throw new Error('Cancelled campaigns cannot be resumed');
  }
  let cancelledQueued = 0;
  const run = db.transaction(() => {
    db.prepare('UPDATE campaigns SET status = ? WHERE id = ?').run(status, n);
    if (status === 'cancelled') cancelledQueued = cancelQueuedMessages(db, n);
  });
  run();
  logActivity(db, 'outreach', `Campaign ${n} → ${status}` + (cancelledQueued ? ` (${cancelledQueued} queued cancelled)` : ''));
  return { id: n, status, cancelledQueued };
}

/** Permanently stop a campaign; queued unsent messages will not send. */
function cancelCampaign(db, id) {
  return setCampaignStatus(db, id, 'cancelled');
}

/**
 * Hard-delete a campaign. campaign_messages (and email_events via CASCADE) are removed.
 * Prefer this over soft-delete — analytics that join messages lose those rows by design.
 */
function deleteCampaign(db, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new Error('Invalid campaign id');
  const row = db.prepare('SELECT id, name, status FROM campaigns WHERE id = ?').get(n);
  if (!row) throw new Error('Campaign not found');
  const msgCount = db.prepare('SELECT COUNT(*) AS c FROM campaign_messages WHERE campaign_id = ?').get(n).c;
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(n);
  logActivity(db, 'outreach', `Campaign ${n} (${row.name}) deleted with ${msgCount} message(s)`);
  return { deleted: true, id: n, messagesDeleted: msgCount };
}

function listMessages(db, campaignId, status, opts = {}) {
  const n = Number(campaignId);
  if (!Number.isInteger(n) || n <= 0) throw new Error('Invalid campaign id');
  const { pageArgs, pageResult } = require('./paginate');
  const { page, pageSize, offset } = pageArgs(opts, { pageSize: 50, maxSize: 200 });
  let where = 'WHERE m.campaign_id = ?';
  const params = [n];
  if (status) { where += ' AND m.status = ?'; params.push(status); }
  const total = db.prepare(
    `SELECT COUNT(*) AS c FROM campaign_messages m ${where}`
  ).get(...params).c;
  const rows = db.prepare(
    `SELECT m.*, l.business_name FROM campaign_messages m
     LEFT JOIN leads l ON l.id = m.lead_id ${where}
     ORDER BY m.scheduled_at ASC, m.id ASC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);
  return pageResult(rows, total, page, pageSize);
}

function getLeadFacts(db, leadId) {
  try {
    return db.prepare('SELECT fact_key, value, claim_class FROM business_facts WHERE lead_id = ?').all(leadId);
  } catch {
    return [];
  }
}

/**
 * Create a campaign from a dual-channel template.
 * `channel` / `channels`: 'email' | 'sms' | 'both' — which content to queue per lead.
 * scheduled_at is staggered by rate_per_hour across all queued messages.
 */
function createCampaign(db, { name, templateId, leadIds, ratePerHour, workspaceId, channel, channels }) {
  ensureTables(db);
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Campaign name is required');
  const tid = Number(templateId);
  if (!Number.isInteger(tid) || tid <= 0) throw new Error('Invalid templateId');
  const template = db.prepare('SELECT * FROM email_templates WHERE id = ?').get(tid);
  if (!template) throw new Error('Template not found');

  const chRaw = String(channels || channel || 'email').toLowerCase();
  const sendEmail = chRaw === 'email' || chRaw === 'both' || chRaw === 'all';
  const sendSms = chRaw === 'sms' || chRaw === 'both' || chRaw === 'all';
  if (!sendEmail && !sendSms) throw new Error('channel must be email, sms, or both');
  if (sendEmail && !templateHasEmail(template)) {
    throw new Error('This template has no email body — add one or choose SMS');
  }
  if (sendSms && !templateHasSms(template)) {
    throw new Error('This template has no SMS body — add one or choose Email');
  }

  if (!Array.isArray(leadIds) || leadIds.length === 0) throw new Error('Select at least one lead');
  const rate = Math.max(1, Math.min(1000, Number(ratePerHour) || 30));

  const settings = readSettings(db);
  const footer = settings['mail.footer'] || '';
  const fromName = settings['smtp.from_name'] || settings['app.name'] || '';
  const smsSource = templateSmsText(template);

  const uniqueIds = [...new Set(leadIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!uniqueIds.length) throw new Error('No valid lead ids');

  const insertCampaign = db.prepare(
    'INSERT INTO campaigns (name, template_id, status, rate_per_hour) VALUES (?, ?, \'active\', ?)'
  );
  const hasMediaCol = tableHasColumn(db, 'campaign_messages', 'media_url');
  const insertMsg = hasMediaCol
    ? db.prepare(
      `INSERT INTO campaign_messages
         (campaign_id, lead_id, to_email, subject, body, status, scheduled_at, error, channel, to_phone, media_url, send_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    : db.prepare(
      `INSERT INTO campaign_messages
         (campaign_id, lead_id, to_email, subject, body, status, scheduled_at, error, channel, to_phone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
  const runInsert = (args) => {
    if (hasMediaCol) {
      return insertMsg.run(
        args.campaignId, args.leadId, args.toEmail, args.subject, args.body,
        args.status, args.scheduledAt, args.error, args.channel, args.toPhone,
        args.mediaUrl || null, args.sendMode || null
      );
    }
    return insertMsg.run(
      args.campaignId, args.leadId, args.toEmail, args.subject, args.body,
      args.status, args.scheduledAt, args.error, args.channel, args.toPhone
    );
  };
  const markOutreachPending = db.prepare(
    `UPDATE leads SET status = 'outreach_pending', updated_at = datetime('now')
     WHERE id = ? AND status IN ('new','researching','qualified','building','qa_pending','ready')`
  );

  const spacingSec = 3600 / rate;
  const now = Date.now();
  let queued = 0;
  let suppressed = 0;
  let slot = 0;

  const txn = db.transaction(() => {
    const campaignId = Number(insertCampaign.run(cleanName, tid, rate).lastInsertRowid);
    for (const leadId of uniqueIds) {
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
      if (!lead) {
        suppressed++;
        continue;
      }
      const facts = getLeadFacts(db, leadId);
      const extras = personalizeExtras(db, leadId, fromName, { workspaceId });
      const smsExtras = personalizeExtras(db, leadId, fromName, { workspaceId, forSms: true });
      let marked = false;

      if (sendEmail) {
        let toEmail = String(lead.email || '').trim().toLowerCase();
        let suppressReason = null;
        if (!toEmail || !isValidEmail(toEmail)) {
          suppressReason = 'no email address';
        } else {
          const s = isSuppressed(db, toEmail);
          if (s) suppressReason = `suppression list: ${s.reason}`;
        }
        if (suppressReason) {
          runInsert({
            campaignId, leadId, toEmail: toEmail || '(none)', subject: template.subject, body: template.body,
            status: 'suppressed', scheduledAt: null, error: suppressReason, channel: 'email', toPhone: null,
          });
          suppressed++;
        } else {
          let { subject, body } = personalize(
            { subject: template.subject, body: template.body },
            lead, facts, extras
          );
          if (footer) body = `${body}\n\n${footer}`;
          const scheduledAt = new Date(now + slot * spacingSec * 1000)
            .toISOString().slice(0, 19).replace('T', ' ');
          slot++;
          runInsert({
            campaignId, leadId, toEmail, subject, body,
            status: 'queued', scheduledAt, error: null, channel: 'email', toPhone: null,
          });
          queued++;
          if (!marked) { markOutreachPending.run(leadId); marked = true; }
        }
      }

      if (sendSms) {
        const toPhone = normalizePhone(lead.phone);
        const toEmail = toPhone || '(no phone)';
        if (!toPhone) {
          runInsert({
            campaignId, leadId, toEmail, subject: '(SMS)', body: smsSource || template.body,
            status: 'suppressed', scheduledAt: null, error: 'no phone number', channel: 'sms', toPhone: null,
          });
          suppressed++;
        } else {
          let { subject, body } = personalize(
            { subject: '(SMS)', body: smsSource },
            lead, facts, smsExtras
          );
          body = plainSmsBody(body);
          subject = subject || '(SMS)';
          const mediaUrl = String(smsExtras.site_screenshot_media_url || smsExtras.site_screenshot_mms || '').trim() || null;
          const wantsShot = /\{\{\s*site_screenshot(_mms|_url|_media_url)?\s*\}\}/i.test(smsSource || '');
          const scheduledAt = new Date(now + slot * spacingSec * 1000)
            .toISOString().slice(0, 19).replace('T', ' ');
          slot++;
          runInsert({
            campaignId, leadId, toEmail, subject, body,
            status: 'queued', scheduledAt, error: null, channel: 'sms', toPhone,
            mediaUrl: wantsShot ? mediaUrl : null,
            sendMode: wantsShot && mediaUrl ? 'mms_pending' : 'sms',
          });
          queued++;
          if (!marked) { markOutreachPending.run(leadId); marked = true; }
        }
      }
    }
    return campaignId;
  });

  const campaignId = txn();
  const chLabel = sendEmail && sendSms ? 'both' : (sendSms ? 'sms' : 'email');
  logActivity(db, 'outreach', `Campaign "${cleanName}" (${chLabel}) launched: ${queued} queued, ${suppressed} suppressed (${rate}/hour)`);
  return { id: campaignId, queued, suppressed, ratePerHour: rate, channel: chLabel };
}

/* ------------------------------------------------------------------ */
/* Queue processing                                                    */
/* ------------------------------------------------------------------ */

/** Emails successfully sent today (local date) — enforces the daily cap. */
function sentTodayCount(db) {
  try {
    return db.prepare(
      `SELECT COUNT(*) AS c FROM email_events WHERE type = 'sent' AND date(at) = date('now', 'localtime')`
    ).get().c;
  } catch {
    return 0;
  }
}

/**
 * Send due queued messages for all ACTIVE campaigns (email + SMS).
 * Honors automation_paused, rate spacing (via scheduled_at), and the daily cap.
 * Returns {sent, failed, suppressed, emailSent, smsSent}.
 */
async function processQueue(db) {
  ensureTables(db);
  if (isAutomationPaused(db)) {
    return { sent: 0, failed: 0, suppressed: 0, emailSent: 0, smsSent: 0, aborted: 'automation_paused' };
  }
  const settings = readSettings(db);
  const dailyCap = Math.max(1, Number(settings['cost.max_outreach_per_day']) || 200);
  const emailProvider = getProvider(settings, db);
  const smsSettings = await resolveSmsSettings(settings);
  const smsProvider = getSmsProvider(smsSettings, db);

  const due = db.prepare(`
    SELECT m.*, c.rate_per_hour, c.name AS campaign_name
    FROM campaign_messages m
    JOIN campaigns c ON c.id = m.campaign_id
    WHERE m.status = 'queued' AND c.status = 'active'
      AND (m.scheduled_at IS NULL OR m.scheduled_at <= datetime('now', 'localtime'))
    ORDER BY m.scheduled_at ASC, m.id ASC
    LIMIT 100
  `).all();

  const updateMsg = db.prepare(
    'UPDATE campaign_messages SET status = ?, sent_at = ?, error = ? WHERE id = ?'
  );
  const insertEvent = db.prepare(
    'INSERT INTO email_events (message_id, type, detail) VALUES (?, ?, ?)'
  );
  const markContacted = db.prepare(
    `UPDATE leads SET status = 'contacted', updated_at = datetime('now')
     WHERE id = ? AND status NOT IN ('engaged','claimed','trial','customer','lost')`
  );

  let sent = 0, failed = 0, suppressed = 0, emailSent = 0, smsSent = 0;

  for (const msg of due) {
    if (isAutomationPaused(db)) {
      logActivity(db, 'outreach', 'Queue processing aborted: automation paused mid-run');
      return { sent, failed, suppressed, emailSent, smsSent, aborted: 'automation_paused' };
    }
    if (sentTodayCount(db) >= dailyCap) {
      logActivity(db, 'outreach', `Daily outreach cap reached (${dailyCap}/day); ${due.length - sent - failed - suppressed} message(s) left queued`);
      return { sent, failed, suppressed, emailSent, smsSent, aborted: 'daily_cap' };
    }

    const channel = String(msg.channel || 'email').toLowerCase() === 'sms' ? 'sms' : 'email';

    if (channel === 'email') {
      const s = isSuppressed(db, msg.to_email);
      if (s) {
        updateMsg.run('suppressed', null, `suppressed at send time: ${s.reason}`, msg.id);
        insertEvent.run(msg.id, 'unsubscribed', `suppressed: ${s.reason}`);
        suppressed++;
        continue;
      }
    }

    try {
      const lead = db.prepare('SELECT id, phone FROM leads WHERE id = ?').get(msg.lead_id);
      if (!lead) throw new Error('Lead no longer exists');

      if (channel === 'sms') {
        const phone = normalizePhone(msg.to_phone) || normalizePhone(lead.phone) || normalizePhone(msg.to_email);
        if (!phone) throw new Error('Lead has no phone number');
        let mediaUrl = msg.media_url ? String(msg.media_url).trim() : '';
        // Per-lead personalization: if queued without media but template used screenshot vars, resolve now.
        if (!mediaUrl) {
          try {
            const shot = require('./siteScreenshots').getCurrentMmsShot(db, msg.lead_id)
              || require('./siteScreenshots').getCurrentEmailShot(db, msg.lead_id);
            if (shot && shot.publicUrl) mediaUrl = shot.publicUrl;
          } catch { /* optional */ }
        }
        const smsResult = await smsProvider.send({
          to: phone,
          body: plainSmsBody(msg.body),
          mediaUrl: mediaUrl || undefined,
        });
        const mode = (smsResult && smsResult.mode) || (mediaUrl ? 'mms' : 'sms');
        if (tableHasColumn(db, 'campaign_messages', 'send_mode')) {
          try {
            db.prepare('UPDATE campaign_messages SET send_mode = ? WHERE id = ?').run(mode, msg.id);
          } catch { /* */ }
        }
        updateMsg.run('sent', new Date().toISOString().slice(0, 19).replace('T', ' '), null, msg.id);
        const detail = mode === 'sms_fallback'
          ? `sms via ${smsProvider.name} (MMS unsupported → text+link; ${String(smsResult.fallbackReason || '').slice(0, 120)})`
          : `${mode} via ${smsProvider.name}`;
        insertEvent.run(msg.id, 'sent', detail);
        markContacted.run(msg.lead_id);
        db.prepare('INSERT INTO prospect_events (lead_id, type, detail) VALUES (?, ?, ?)')
          .run(msg.lead_id, mode === 'mms' ? 'mms.sent' : 'sms.sent', `campaign "${msg.campaign_name}" (${mode})`);
        sent++;
        smsSent++;
      } else {
        // Same Mailjet Inactive-sender guard as designJobs / platform mailer.
        const { assertMailjetSenderActive } = require('./mailjetSender');
        await assertMailjetSenderActive(settings);
        await emailProvider.send({ to: msg.to_email, subject: msg.subject, html: msg.body });
        updateMsg.run('sent', new Date().toISOString().slice(0, 19).replace('T', ' '), null, msg.id);
        insertEvent.run(msg.id, 'sent', `via ${emailProvider.name}`);
        markContacted.run(msg.lead_id);
        db.prepare('INSERT INTO prospect_events (lead_id, type, detail) VALUES (?, ?, ?)')
          .run(msg.lead_id, 'email.sent', `campaign "${msg.campaign_name}"`);
        sent++;
        emailSent++;
      }
    } catch (err) {
      updateMsg.run('failed', null, String(err && err.message || err), msg.id);
      insertEvent.run(msg.id, 'failed', String(err && err.message || err));
      try {
        db.prepare('INSERT INTO prospect_events (lead_id, type, detail) VALUES (?, ?, ?)')
          .run(msg.lead_id, channel === 'sms' ? 'sms.failed' : 'email.failed', String(err && err.message || err).slice(0, 500));
      } catch { /* ignore */ }
      failed++;
    }
  }

  // Auto-complete campaigns with nothing left queued.
  try {
    db.prepare(`
      UPDATE campaigns SET status = 'done'
      WHERE status = 'active' AND NOT EXISTS (
        SELECT 1 FROM campaign_messages m
        WHERE m.campaign_id = campaigns.id AND m.status = 'queued'
      )
    `).run();
  } catch { /* non-fatal */ }

  if (sent || failed || suppressed) {
    logActivity(db, 'outreach', `Queue processed: ${sent} sent (${emailSent} email, ${smsSent} sms), ${failed} failed, ${suppressed} suppressed`);
  }
  return { sent, failed, suppressed, emailSent, smsSent };
}

/* ------------------------------------------------------------------ */
/* Stats / timeline / pipeline                                         */
/* ------------------------------------------------------------------ */

function getOutreachStats(db) {
  const q = (sql, ...p) => { try { return db.prepare(sql).get(...p); } catch { return null; } };
  const qa = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch { return []; } };
  const msgByStatus = qa(`SELECT status, COUNT(*) AS c FROM campaign_messages GROUP BY status`);
  const eventsByType = qa(`SELECT type, COUNT(*) AS c FROM email_events GROUP BY type`);
  return {
    campaigns: (q('SELECT COUNT(*) AS c FROM campaigns') || { c: 0 }).c,
    activeCampaigns: (q(`SELECT COUNT(*) AS c FROM campaigns WHERE status = 'active'`) || { c: 0 }).c,
    messagesByStatus: Object.fromEntries(msgByStatus.map((r) => [r.status, r.c])),
    eventsByType: Object.fromEntries(eventsByType.map((r) => [r.type, r.c])),
    sentToday: sentTodayCount(db),
    dailyCap: Math.max(1, Number(getSetting(db, 'cost.max_outreach_per_day', '200')) || 200),
    suppressionCount: (q('SELECT COUNT(*) AS c FROM suppression_list') || { c: 0 }).c,
    templates: (q('SELECT COUNT(*) AS c FROM email_templates') || { c: 0 }).c,
    // Best-effort note: open/click tracking needs a hosted endpoint which a
    // desktop app does not have; counts below only reflect manually recorded events.
    trackingNote: 'Open/click tracking is best-effort: this desktop app has no hosted tracking endpoint. Record opens/clicks manually via intent:record.',
  };
}

/** Merged timeline: lead_events + prospect_events + email_events (newest first). */
function getTimeline(db, leadId, opts = {}) {
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid leadId');
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 100));
  const rows = [];
  try {
    for (const r of db.prepare('SELECT at, type, detail FROM lead_events WHERE lead_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(id, limit)) {
      rows.push({ at: r.at, kind: 'lead', type: r.type, detail: r.detail });
    }
  } catch { /* table may not exist in tests */ }
  try {
    for (const r of db.prepare('SELECT at, type, detail FROM prospect_events WHERE lead_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(id, limit)) {
      rows.push({ at: r.at, kind: 'prospect', type: r.type, detail: r.detail });
    }
  } catch { /* ignore */ }
  try {
    for (const r of db.prepare(`
        SELECT e.at, e.type, e.detail FROM email_events e
        JOIN campaign_messages m ON m.id = e.message_id
        WHERE m.lead_id = ?
        ORDER BY e.at DESC, e.id DESC LIMIT ?`).all(id, limit)) {
      rows.push({ at: r.at, kind: 'email', type: r.type, detail: r.detail });
    }
  } catch { /* ignore */ }
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return rows.slice(0, limit);
}

// Kanban columns (spec section 59 + task mapping). Schema lead statuses mapped sensibly.
const PIPELINE_COLUMNS = [
  { key: 'discovered', title: 'Discovered', statuses: ['new', 'researching'] },
  { key: 'qualified', title: 'Qualified', statuses: ['qualified'] },
  { key: 'site_ready', title: 'Site Ready', statuses: ['building', 'qa_pending', 'ready'] },
  { key: 'contacted', title: 'Contacted', statuses: ['outreach_pending', 'contacted'] },
  { key: 'viewed', title: 'Viewed', statuses: ['engaged'] },
  { key: 'editing', title: 'Editing', statuses: ['claimed'] },
  { key: 'trial', title: 'Trial', statuses: ['trial'] },
  { key: 'customer', title: 'Customer', statuses: ['customer'] },
  { key: 'lost', title: 'Lost', statuses: ['lost'] },
];

/** Leads grouped into kanban columns with latest intent label attached. */
function pipelineBoard(db, opts = {}) {
  const perColumn = Math.min(200, Math.max(10, Number(opts.perColumn) || 40));
  const leadSelect = `
    SELECT l.id, l.business_name, l.category, l.status, l.email, l.score,
      (SELECT s.label FROM intent_scores s WHERE s.lead_id = l.id ORDER BY s.id DESC LIMIT 1) AS intent_label,
      (SELECT s.score FROM intent_scores s WHERE s.lead_id = l.id ORDER BY s.id DESC LIMIT 1) AS intent_score
    FROM leads l`;

  function mapLead(l) {
    return {
      id: l.id,
      business_name: l.business_name,
      category: l.category,
      status: l.status,
      email: l.email,
      score: l.score,
      intent_label: l.intent_label || 'Cold',
      intent_score: l.intent_score === null || l.intent_score === undefined ? 0 : l.intent_score,
    };
  }

  const mapped = new Set(PIPELINE_COLUMNS.flatMap((c) => c.statuses));
  const columns = PIPELINE_COLUMNS.map((col) => {
    const ph = col.statuses.map(() => '?').join(',');
    const total = db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE status IN (${ph})`).get(...col.statuses).c;
    const leads = db.prepare(
      `${leadSelect} WHERE l.status IN (${ph}) ORDER BY l.updated_at DESC LIMIT ?`
    ).all(...col.statuses, perColumn).map(mapLead);
    return {
      key: col.key,
      title: col.title,
      statuses: col.statuses,
      leads,
      total,
      shown: leads.length,
      hasMore: total > leads.length,
    };
  });

  // Unmapped statuses land in Discovered (capped).
  const unmappedPh = [...mapped].map(() => '?').join(',');
  let unmappedTotal = 0;
  let unmapped = [];
  try {
    unmappedTotal = db.prepare(
      `SELECT COUNT(*) AS c FROM leads WHERE status NOT IN (${unmappedPh})`
    ).get(...mapped).c;
    if (unmappedTotal) {
      const room = Math.max(0, perColumn - columns[0].leads.length);
      if (room > 0) {
        unmapped = db.prepare(
          `${leadSelect} WHERE l.status NOT IN (${unmappedPh}) ORDER BY l.updated_at DESC LIMIT ?`
        ).all(...mapped, room).map(mapLead);
        columns[0].leads.push(...unmapped);
      }
      columns[0].total += unmappedTotal;
      columns[0].shown = columns[0].leads.length;
      columns[0].hasMore = columns[0].total > columns[0].leads.length;
    }
  } catch { /* ignore */ }

  return { columns, perColumn };
}

module.exports = {
  readSettings,
  getSetting,
  isAutomationPaused,
  logActivity,
  ensureTables,
  migrateUnifiedTemplates,
  templateHasEmail,
  templateHasSms,
  templateSmsText,
  INTENT_POINTS,
  intentLabel,
  recordIntent,
  getIntent,
  isSuppressed,
  listSuppressions,
  addSuppression,
  removeSuppression,
  listTemplates,
  saveTemplate,
  deleteTemplate,
  resolveWebsiteLink,
  personalizeExtras,
  signInterestToken,
  verifyInterestToken,
  buildInterestAnchor,
  interestResponsePath,
  applyInterestResponse,
  applyClaimResponse,
  listCampaigns,
  setCampaignStatus,
  cancelCampaign,
  deleteCampaign,
  listMessages,
  createCampaign,
  sentTodayCount,
  processQueue,
  getOutreachStats,
  getTimeline,
  pipelineBoard,
  PIPELINE_COLUMNS,
  SUPPRESSION_REASONS,
  normalizePhone,
  isValidPhone,
  aiAvailable: () => ai !== null,
};
