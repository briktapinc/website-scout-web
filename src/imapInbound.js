'use strict';

/**
 * IMAP poller for design job replies.
 * Matches messages by [Job #N] (or project/job #N) in the subject/body,
 * records Q&A answers, and queues redesign/improve work for the agent.
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

function getSetting(db, key, def = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (row && row.value != null && String(row.value) !== '') return String(row.value);
  } catch { /* ignore */ }
  return def;
}

function ensureSeenTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS design_inbound_seen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT,
      uid INTEGER,
      mailbox TEXT NOT NULL DEFAULT 'INBOX',
      actions TEXT,
      processed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_design_inbound_seen_msgid
      ON design_inbound_seen(message_id) WHERE message_id IS NOT NULL AND message_id != '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_design_inbound_seen_uid
      ON design_inbound_seen(mailbox, uid);
  `);
}

function alreadySeen(db, messageId, mailbox, uid) {
  if (messageId) {
    const row = db.prepare('SELECT id FROM design_inbound_seen WHERE message_id = ? LIMIT 1').get(messageId);
    if (row) return true;
  }
  if (uid != null) {
    const row = db.prepare(
      'SELECT id FROM design_inbound_seen WHERE mailbox = ? AND uid = ? LIMIT 1'
    ).get(mailbox, Number(uid));
    if (row) return true;
  }
  return false;
}

function markSeen(db, messageId, mailbox, uid, actions) {
  db.prepare(
    `INSERT OR IGNORE INTO design_inbound_seen (message_id, uid, mailbox, actions)
     VALUES (?, ?, ?, ?)`
  ).run(messageId || null, uid != null ? Number(uid) : null, mailbox, JSON.stringify(actions || []));
}

function extractAddress(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    const m = value.match(/<([^>]+)>/);
    return (m ? m[1] : value).trim().toLowerCase();
  }
  if (value.value && value.value[0] && value.value[0].address) {
    return String(value.value[0].address).trim().toLowerCase();
  }
  if (value.text) {
    const m = String(value.text).match(/<([^>]+)>/);
    return (m ? m[1] : value.text).trim().toLowerCase();
  }
  return '';
}

function bodyText(parsed) {
  const text = String(parsed.text || '').trim();
  if (text) return text.slice(0, 12000);
  const html = String(parsed.html || '');
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);
}

function imapConfig(db) {
  const enabled = getSetting(db, 'mail.imap.enabled', '0') === '1';
  const host = getSetting(db, 'mail.imap.host', '').trim() || getSetting(db, 'smtp.host', '').trim();
  const user = getSetting(db, 'mail.imap.user', '').trim() || getSetting(db, 'smtp.user', '').trim();
  const pass = getSetting(db, 'mail.imap.pass', '') || getSetting(db, 'smtp.pass', '');
  const port = Number(getSetting(db, 'mail.imap.port', '993')) || 993;
  const secure = getSetting(db, 'mail.imap.secure', '1') !== '0';
  const mailbox = getSetting(db, 'mail.imap.mailbox', 'INBOX').trim() || 'INBOX';
  const autoSubmit = getSetting(db, 'mail.imap.auto_submit', '1') !== '0';
  return { enabled, host, user, pass, port, secure, mailbox, autoSubmit };
}

/**
 * Process one parsed message against the workspace DB.
 */
async function processMessage(db, { fromEmail, subject, body, messageId, uid, mailbox, autoSubmit }) {
  const emailRedesign = require('./emailRedesign');
  const design = require('./designJobs');
  const actions = [];
  const jobId = emailRedesign.extractJobId(subject, body);
  if (!jobId) {
    return { ok: false, skipped: true, reason: 'no_job_reference', subject };
  }

  let job = null;
  try {
    job = design.getJob(db, jobId);
  } catch {
    return { ok: false, skipped: true, reason: 'job_not_found', jobId, subject };
  }

  // 1) Answers to open questions
  try {
    const pending = (job.questions || []).filter((q) => q.answer == null);
    if (pending.length) {
      design.recordEmailReply(db, jobId, body, fromEmail);
      actions.push({ type: 'record_reply', jobId, questions: pending.length });
    }
  } catch (e) {
    if (e.code !== 'NO_QUESTIONS') {
      actions.push({ type: 'record_reply_error', error: e.message, code: e.code });
    }
  }

  // 2) Change / redesign / improvements → queue for agent
  const looksLikeChange = emailRedesign.looksLikeRedesignRequest(subject, body);
  const websiteReady = job.type === 'website' && !!job.deliverable;
  const answeredQuestions = actions.some((a) => a.type === 'record_reply');
  // Don't treat pure Q&A replies as redesigns; otherwise queue change work.
  if (looksLikeChange || (websiteReady && !answeredQuestions)) {
    const ingest = emailRedesign.ingestInboundEmail(db, {
      fromEmail,
      subject,
      body,
      designJobId: jobId,
      source: 'imap',
      force: true,
      requestKind: looksLikeChange ? undefined : 'improvements',
    });
    if (ingest.ok && ingest.request) {
      actions.push({ type: 'ingest', requestId: ingest.request.id, requestKind: ingest.request.request_kind });
      if (autoSubmit && websiteReady && ingest.request.status === 'pending') {
        try {
          const submitted = await emailRedesign.submitEmailRedesign(db, ingest.request.id, {
            designJobId: jobId,
          });
          actions.push({
            type: 'submit',
            requestId: ingest.request.id,
            jobId,
            status: submitted.job && submitted.job.status,
          });
        } catch (e) {
          actions.push({ type: 'submit_error', error: e.message, code: e.code });
        }
      }
    } else if (ingest.skipped) {
      actions.push({ type: 'ingest_skipped', reason: ingest.reason });
    }
  }

  markSeen(db, messageId, mailbox, uid, actions);
  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'design',
      `IMAP inbound for job #${jobId}: ${actions.map((a) => a.type).join(', ') || 'no-op'} (${fromEmail || 'unknown'})`
    );
  } catch { /* ignore */ }

  return { ok: true, jobId, subject, fromEmail, actions };
}

async function pollMailbox(db, opts = {}) {
  ensureSeenTable(db);
  const cfg = imapConfig(db);
  if (!cfg.enabled && !opts.force) {
    return { ok: false, skipped: true, reason: 'imap_disabled' };
  }
  if (!cfg.host || !cfg.user || !cfg.pass) {
    return { ok: false, skipped: true, reason: 'imap_not_configured' };
  }

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    emitLogs: false,
  });

  const results = [];
  let fetched = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      // Unseen first; also pick recent seen mail that we have not processed (crash recovery).
      const uids = [];
      for await (const msg of client.fetch({ seen: false }, { uid: true, source: true, envelope: true })) {
        uids.push(msg);
      }
      // Cap per poll
      const batch = uids.slice(0, Math.min(Number(opts.limit) || 25, 40));
      for (const msg of batch) {
        fetched += 1;
        const uid = msg.uid;
        let parsed;
        try {
          parsed = await simpleParser(msg.source);
        } catch (e) {
          results.push({ ok: false, uid, error: e.message });
          continue;
        }
        const messageId = String(parsed.messageId || '').trim().slice(0, 500);
        if (alreadySeen(db, messageId, cfg.mailbox, uid)) {
          results.push({ ok: true, skipped: true, reason: 'already_seen', uid });
          try { await client.messageFlagsAdd({ uid }, ['\\Seen']); } catch { /* ignore */ }
          continue;
        }
        const fromEmail = extractAddress(parsed.from);
        const subject = String(parsed.subject || '').trim().slice(0, 500);
        const body = bodyText(parsed);
        if (!body) {
          markSeen(db, messageId, cfg.mailbox, uid, [{ type: 'empty_body' }]);
          results.push({ ok: false, skipped: true, reason: 'empty_body', uid, subject });
          try { await client.messageFlagsAdd({ uid }, ['\\Seen']); } catch { /* ignore */ }
          continue;
        }
        try {
          const out = await processMessage(db, {
            fromEmail,
            subject,
            body,
            messageId,
            uid,
            mailbox: cfg.mailbox,
            autoSubmit: cfg.autoSubmit,
          });
          results.push({ uid, ...out });
        } catch (e) {
          results.push({ ok: false, uid, subject, error: e.message, code: e.code });
        }
        try { await client.messageFlagsAdd({ uid }, ['\\Seen']); } catch { /* ignore */ }
      }
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }

  return {
    ok: true,
    mailbox: cfg.mailbox,
    fetched,
    processed: results.filter((r) => r.ok && !r.skipped).length,
    results,
  };
}

function isConfigured(db) {
  const cfg = imapConfig(db);
  return !!(cfg.enabled && cfg.host && cfg.user && cfg.pass);
}

module.exports = {
  pollMailbox,
  processMessage,
  imapConfig,
  isConfigured,
  ensureSeenTable,
  extractAddress,
  bodyText,
};
