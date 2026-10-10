'use strict';

/**
 * Inbound email change requests (redesign vs improvements).
 *
 * Capture paths:
 *   1. Paste / import in the Design UI (source: paste)
 *   2. Drop .eml / .txt into the inbound drop folder (source: drop)
 *   3. IMAP poller (source: imap) via src/imapInbound.js
 *   4. ingestInboundEmail() hook (source: inbound_hook)
 *
 * Outbound subjects include "[Job #N]" so replies match the design job.
 *
 * Pending rows are shown on the design job; Submit routes by request_kind:
 *   redesign     → redesignJob / requestRedesign
 *   improvements → improveJob / requestImprovements
 * Shared vocabulary with designReview / designAgentTrigger: redesign | improvements.
 */

const fs = require('fs');
const path = require('path');

const STATUSES = ['pending', 'submitted', 'dismissed'];
const REQUEST_KINDS = ['redesign', 'improvements'];
const REDESIGN_SUBJECT_RE = /\b(re\s*[-:]?\s*)?(design\s*)?(redesign|revise|revision|changes?\s+(to|for)\s+(the\s+)?(site|website|design)|please\s+change|update\s+(the\s+)?(site|website|design))\b/i;
const REDESIGN_BODY_RE = /\b(redesign|please\s+revise|please\s+change|can\s+you\s+(change|update|fix)|needs?\s+(a\s+)?(redesign|revision)|===?\s*REDESIGN\s+REQUEST\s*===?)\b/i;
const IMPROVEMENTS_SUBJECT_RE = /\b(improvements?|polish|tweaks?|small\s+fixes?|copy\s+tweaks?|cta\s+(fix|tweak)|mobile\s+(fix|sizing)|imagery)\b/i;
const IMPROVEMENTS_BODY_RE = /\b(improvements?|polish|small\s+(fix|tweak|change)|copy\s+tweak|cta|mobile\s+sizing|===?\s*IMPROVEMENTS?\s+REQUEST\s*===?)\b/i;
// Match [Job #12], Job #12, project #12, Questions about project #12:, etc.
const JOB_ID_RE = /\[Job\s*#\s*(\d+)\]|\b(?:design\s*job|project|job|website)\s*#\s*(\d+)\b/i;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function getSetting(db, key, def = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (row && row.value != null && String(row.value) !== '') return String(row.value);
  } catch { /* ignore */ }
  return def;
}

function resolveDbDir() {
  try {
    if (process.env.WS_DB_PATH) return path.dirname(path.resolve(process.env.WS_DB_PATH));
  } catch { /* ignore */ }
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      return electron.app.getPath('userData');
    }
  } catch { /* MCP / plain Node */ }
  return process.cwd();
}

function defaultDropDir() {
  return path.join(resolveDbDir(), 'inbound-email');
}

function resolveDropDir(db) {
  const custom = db ? getSetting(db, 'mail.inbound_drop_dir', '').trim() : '';
  return custom || defaultDropDir();
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS design_email_redesigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      design_job_id INTEGER REFERENCES design_jobs(id) ON DELETE SET NULL,
      lead_id INTEGER,
      from_email TEXT,
      subject TEXT,
      body TEXT NOT NULL,
      body_excerpt TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL DEFAULT 'paste',
      received_at TEXT DEFAULT (datetime('now')),
      submitted_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_design_email_redesigns_job
      ON design_email_redesigns(design_job_id, status);
    CREATE INDEX IF NOT EXISTS idx_design_email_redesigns_status
      ON design_email_redesigns(status, received_at);
  `);
  const cols = db.prepare('PRAGMA table_info(design_email_redesigns)').all();
  if (cols.length && !cols.some((c) => c.name === 'request_kind')) {
    db.exec(`ALTER TABLE design_email_redesigns ADD COLUMN request_kind TEXT DEFAULT 'redesign'`);
  }
}

function cleanEmailOptional(value) {
  const email = String(value || '').trim().toLowerCase().slice(0, 254);
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw fail('INVALID_ARGS', 'from email is not a valid address.');
  }
  return email;
}

function excerpt(body, max = 400) {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function looksLikeRedesignRequest(subject, body) {
  const sub = String(subject || '');
  const text = String(body || '');
  if (REDESIGN_SUBJECT_RE.test(sub)) return true;
  if (REDESIGN_BODY_RE.test(text)) return true;
  if (REDESIGN_BODY_RE.test(sub)) return true;
  if (IMPROVEMENTS_SUBJECT_RE.test(sub)) return true;
  if (IMPROVEMENTS_BODY_RE.test(text)) return true;
  if (IMPROVEMENTS_BODY_RE.test(sub)) return true;
  return false;
}

/**
 * Infer redesign vs improvements from subject/body.
 * Explicit === IMPROVEMENTS REQUEST === / === REDESIGN REQUEST === wins;
 * otherwise improvements keywords beat generic "change/update" when clear.
 */
function detectRequestKind(subject, body, override) {
  if (override != null) {
    const k = String(override).trim().toLowerCase();
    if (k === 'improvements' || k === 'improvement' || k === 'improve') return 'improvements';
    if (k === 'redesign') return 'redesign';
  }
  const hay = `${subject || ''}\n${body || ''}`;
  if (/===?\s*IMPROVEMENTS?\s+REQUEST\s*===?/i.test(hay)) return 'improvements';
  if (/===?\s*REDESIGN\s+REQUEST\s*===?/i.test(hay)) return 'redesign';
  const improveHit = IMPROVEMENTS_SUBJECT_RE.test(subject || '') || IMPROVEMENTS_BODY_RE.test(body || '');
  const redesignHit = REDESIGN_SUBJECT_RE.test(subject || '') || REDESIGN_BODY_RE.test(body || '')
    || REDESIGN_BODY_RE.test(subject || '');
  if (improveHit && !/\bredesign\b/i.test(hay)) return 'improvements';
  if (redesignHit) return 'redesign';
  if (improveHit) return 'improvements';
  return 'redesign';
}

function extractJobId(subject, body) {
  const hay = `${subject || ''}\n${body || ''}`;
  const m = hay.match(JOB_ID_RE);
  if (!m) return null;
  const id = Number(m[1] || m[2]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Canonical subject token clients should keep when replying. */
function jobSubjectTag(jobId) {
  return `[Job #${Number(jobId)}]`;
}

function publicRow(row) {
  if (!row) return null;
  const kind = REQUEST_KINDS.includes(row.request_kind) ? row.request_kind : 'redesign';
  return {
    id: row.id,
    design_job_id: row.design_job_id != null ? Number(row.design_job_id) : null,
    lead_id: row.lead_id != null ? Number(row.lead_id) : null,
    from_email: row.from_email || null,
    subject: row.subject || '',
    body: row.body,
    body_excerpt: row.body_excerpt || excerpt(row.body),
    request_kind: kind,
    status: row.status,
    source: row.source,
    received_at: row.received_at,
    submitted_at: row.submitted_at || null,
    created_at: row.created_at,
  };
}

function resolveJobLink(db, designJobId, fromEmail) {
  if (designJobId != null && Number.isFinite(Number(designJobId))) {
    const id = Number(designJobId);
    const job = db.prepare('SELECT id, lead_id, contact_email, type, deliverable FROM design_jobs WHERE id = ?').get(id);
    if (!job) throw fail('JOB_NOT_FOUND', `Design job #${id} not found.`);
    return job;
  }
  const from = fromEmail ? String(fromEmail).trim().toLowerCase() : '';
  if (!from) return null;
  // Prefer a delivered website whose contact matches the sender.
  const byContact = db.prepare(
    `SELECT id, lead_id, contact_email, type, deliverable FROM design_jobs
     WHERE lower(contact_email) = ? AND type = 'website' AND deliverable IS NOT NULL
     ORDER BY updated_at DESC LIMIT 1`
  ).get(from);
  if (byContact) return byContact;
  const byLead = db.prepare(
    `SELECT j.id, j.lead_id, j.contact_email, j.type, j.deliverable
     FROM design_jobs j
     JOIN leads l ON l.id = j.lead_id
     WHERE lower(l.email) = ? AND j.type = 'website' AND j.deliverable IS NOT NULL
     ORDER BY j.updated_at DESC LIMIT 1`
  ).get(from);
  return byLead || null;
}

/**
 * Durable ingest hook. Call this from paste UI, drop-folder scanner, or a future IMAP poller.
 *
 * @param {object} db
 * @param {{ fromEmail?: string, subject?: string, body: string, designJobId?: number, leadId?: number, source?: string, force?: boolean, receivedAt?: string, requestKind?: string }} input
 */
function ingestInboundEmail(db, input = {}) {
  ensureTables(db);
  const body = String(input.body || '').trim();
  if (!body) throw fail('INVALID_ARGS', 'email body is required.');
  if (body.length > 12000) throw fail('INVALID_ARGS', 'email body must be 12000 characters or fewer.');

  const subject = String(input.subject || '').trim().slice(0, 500);
  const fromEmail = cleanEmailOptional(input.fromEmail);
  const source = String(input.source || 'paste').slice(0, 40) || 'paste';
  // Paste UI always stores; drop/IMAP only when keywords match (or force:true).
  const force = input.force === true || source === 'paste';
  const requestKind = detectRequestKind(subject, body, input.requestKind);

  const guessedId = input.designJobId != null
    ? Number(input.designJobId)
    : extractJobId(subject, body);

  if (!force && !looksLikeRedesignRequest(subject, body)) {
    return { ok: false, skipped: true, reason: 'not_a_redesign_request' };
  }

  let job = null;
  try {
    job = resolveJobLink(db, Number.isFinite(guessedId) ? guessedId : null, fromEmail);
  } catch (e) {
    if (e.code === 'JOB_NOT_FOUND' && source === 'paste' && Number.isFinite(guessedId)) throw e;
    job = null;
  }

  // Explicit job id from the caller wins even if resolve failed above only for link;
  // paste with job id already validated in resolveJobLink when provided.
  if (input.designJobId != null && !job) {
    job = resolveJobLink(db, Number(input.designJobId), fromEmail);
  }

  const leadId = input.leadId != null
    ? Number(input.leadId)
    : (job && job.lead_id != null ? Number(job.lead_id) : null);

  const receivedAt = input.receivedAt
    ? String(input.receivedAt)
    : null;

  const info = receivedAt
    ? db.prepare(
      `INSERT INTO design_email_redesigns
         (design_job_id, lead_id, from_email, subject, body, body_excerpt, status, source, received_at, request_kind)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(
      job ? job.id : null,
      leadId,
      fromEmail,
      subject || null,
      body,
      excerpt(body),
      source,
      receivedAt,
      requestKind
    )
    : db.prepare(
      `INSERT INTO design_email_redesigns
         (design_job_id, lead_id, from_email, subject, body, body_excerpt, status, source, request_kind)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(
      job ? job.id : null,
      leadId,
      fromEmail,
      subject || null,
      body,
      excerpt(body),
      source,
      requestKind
    );

  const id = Number(info.lastInsertRowid);
  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'design',
      `Email ${requestKind} request #${id} saved${job ? ` for job #${job.id}` : ' (unlinked)'} (${source}).`
    );
  } catch { /* ignore */ }

  const saved = publicRow(db.prepare('SELECT * FROM design_email_redesigns WHERE id = ?').get(id));
  try {
    require('./designLearning').observeEmailMessage(db, {
      id: saved.id,
      design_job_id: saved.design_job_id,
      lead_id: saved.lead_id,
      from_email: saved.from_email,
      subject: saved.subject,
      body: body,
      body_excerpt: saved.body_excerpt,
      request_kind: saved.request_kind,
      source: saved.source,
      status: saved.status,
    });
  } catch { /* learning must not block ingest */ }

  return {
    ok: true,
    skipped: false,
    request: saved,
  };
}

function listEmailRedesigns(db, opts = {}) {
  ensureTables(db);
  const where = [];
  const params = [];
  if (opts.jobId != null) {
    where.push('design_job_id = ?');
    params.push(Number(opts.jobId));
  }
  if (opts.status) {
    where.push('status = ?');
    params.push(String(opts.status));
  } else if (opts.pendingOnly !== false && opts.includeAll !== true) {
    where.push("status = 'pending'");
  }
  const sql = `SELECT * FROM design_email_redesigns
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY datetime(received_at) DESC, id DESC
    LIMIT ?`;
  params.push(Math.min(Math.max(Number(opts.limit) || 50, 1), 200));
  return db.prepare(sql).all(...params).map(publicRow);
}

function getEmailRedesign(db, id) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM design_email_redesigns WHERE id = ?').get(Number(id));
  if (!row) throw fail('NOT_FOUND', `Email redesign request #${id} not found.`);
  return publicRow(row);
}

function dismissEmailRedesign(db, id) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM design_email_redesigns WHERE id = ?').get(Number(id));
  if (!row) throw fail('NOT_FOUND', `Email redesign request #${id} not found.`);
  if (row.status === 'submitted') throw fail('ALREADY_SUBMITTED', 'This request was already submitted.');
  db.prepare(
    `UPDATE design_email_redesigns SET status = 'dismissed' WHERE id = ?`
  ).run(row.id);
  return publicRow(db.prepare('SELECT * FROM design_email_redesigns WHERE id = ?').get(row.id));
}

/**
 * Queue redesign or improvements via the shared agent-change path using the email body.
 */
async function submitEmailRedesign(db, id, opts = {}) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM design_email_redesigns WHERE id = ?').get(Number(id));
  if (!row) throw fail('NOT_FOUND', `Email redesign request #${id} not found.`);
  if (row.status === 'submitted') throw fail('ALREADY_SUBMITTED', 'This request was already submitted.');

  let jobId = opts.designJobId != null ? Number(opts.designJobId) : row.design_job_id;
  if (jobId == null) throw fail('NO_JOB', 'Link this request to a design job before submitting.');

  const job = db.prepare('SELECT * FROM design_jobs WHERE id = ?').get(jobId);
  if (!job) throw fail('JOB_NOT_FOUND', `Design job #${jobId} not found.`);
  if (job.type !== 'website') throw fail('NOT_A_WEBSITE', 'Change requests apply to website jobs.');
  if (!job.deliverable) throw fail('NO_DELIVERY', 'Deliver a website before requesting changes.');

  const instructions = String(opts.instructions != null ? opts.instructions : row.body).trim();
  if (!instructions) throw fail('NO_INSTRUCTIONS', 'Instructions are empty.');

  const kind = detectRequestKind(row.subject, row.body, opts.requestKind != null ? opts.requestKind : row.request_kind);
  const design = require('./designJobs');
  const queueOpts = {
    instructions,
    refresh: false,
    skipAi: true,
    skipScreenshots: true,
  };
  const updated = kind === 'improvements'
    ? await design.improveJob(db, jobId, queueOpts)
    : await design.redesignJob(db, jobId, queueOpts);

  db.prepare(
    `UPDATE design_email_redesigns
     SET status = 'submitted', submitted_at = datetime('now'), design_job_id = ?, request_kind = ?
     WHERE id = ?`
  ).run(jobId, kind, row.id);

  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'design',
      `Email ${kind} request #${row.id} submitted → job #${jobId} waiting_on_agent.`
    );
  } catch { /* ignore */ }

  const submitted = publicRow(db.prepare('SELECT * FROM design_email_redesigns WHERE id = ?').get(row.id));
  try {
    require('./designLearning').observeEmailSubmit(db, jobId, kind, {
      id: row.id,
      lead_id: row.lead_id,
      from_email: row.from_email,
      subject: row.subject,
      body: row.body,
      body_excerpt: row.body_excerpt,
      request_kind: kind,
      source: row.source,
    });
  } catch { /* learning must not block submit */ }

  return {
    request: submitted,
    job: updated,
  };
}

function parseSimpleEmail(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  let fromEmail = '';
  let subject = '';
  let body = text;

  const headerEnd = text.search(/\n\n/);
  if (headerEnd >= 0) {
    const headers = text.slice(0, headerEnd);
    body = text.slice(headerEnd + 2).trim();
    const fromLine = headers.match(/^From:\s*(.+)$/im);
    if (fromLine) {
      const angle = fromLine[1].match(/<([^>]+)>/);
      fromEmail = (angle ? angle[1] : fromLine[1]).trim();
    }
    const subLine = headers.match(/^Subject:\s*(.+)$/im);
    if (subLine) subject = subLine[1].trim();
  }
  // Strip a bare text/plain MIME preamble if present
  const mimeSplit = body.match(/\n--[^\n]+\nContent-Type:\s*text\/plain[^\n]*\n(?:Content-Transfer-Encoding:[^\n]*\n)?\n([\s\S]*?)(?:\n--|$)/i);
  if (mimeSplit) body = mimeSplit[1].trim();

  return { fromEmail, subject, body };
}

/**
 * Scan the inbound drop folder for .eml / .txt files and ingest redesign-looking messages.
 * Processed files move to inbound-email/processed/.
 */
function scanDropFolder(db) {
  ensureTables(db);
  const dir = resolveDropDir(db);
  fs.mkdirSync(dir, { recursive: true });
  const processedDir = path.join(dir, 'processed');
  fs.mkdirSync(processedDir, { recursive: true });

  const names = fs.readdirSync(dir).filter((n) => /\.(eml|txt)$/i.test(n));
  const results = [];
  for (const name of names) {
    const full = path.join(dir, name);
    let raw;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (e) {
      results.push({ file: name, ok: false, error: e.message || String(e) });
      continue;
    }
    const parsed = parseSimpleEmail(raw);
    try {
      const out = ingestInboundEmail(db, {
        fromEmail: parsed.fromEmail || undefined,
        subject: parsed.subject,
        body: parsed.body || raw,
        source: 'drop',
      });
      const dest = path.join(processedDir, `${Date.now()}-${name}`);
      try { fs.renameSync(full, dest); } catch { /* leave in place */ }
      results.push({ file: name, ...out });
    } catch (e) {
      results.push({ file: name, ok: false, error: e.message || String(e), code: e.code });
    }
  }
  return { dropDir: dir, scanned: names.length, results };
}

module.exports = {
  STATUSES,
  REQUEST_KINDS,
  ensureTables,
  looksLikeRedesignRequest,
  detectRequestKind,
  extractJobId,
  jobSubjectTag,
  ingestInboundEmail,
  listEmailRedesigns,
  getEmailRedesign,
  dismissEmailRedesign,
  submitEmailRedesign,
  scanDropFolder,
  resolveDropDir,
  defaultDropDir,
  parseSimpleEmail,
};
