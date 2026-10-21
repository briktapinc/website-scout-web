'use strict';

/**
 * LeadScout — portal CRM for form + booking contacts (workspace DB).
 * Dedupe by email OR phone across all sites in the workspace.
 */

const submissionCopies = require('./submissionCopies');

function fail(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leadscout_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email_norm TEXT NOT NULL DEFAULT '',
      phone_norm TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_leadscout_email ON leadscout_contacts(email_norm);
    CREATE INDEX IF NOT EXISTS idx_leadscout_phone ON leadscout_contacts(phone_norm);

    CREATE TABLE IF NOT EXISTS leadscout_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      lead_id INTEGER,
      kind TEXT NOT NULL,
      source_label TEXT NOT NULL DEFAULT '',
      page_slug TEXT NOT NULL DEFAULT '',
      form_id INTEGER,
      submission_id INTEGER,
      booking_id INTEGER,
      payload_json TEXT,
      status TEXT NOT NULL DEFAULT '',
      starts_at TEXT,
      service_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(contact_id) REFERENCES leadscout_contacts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_leadscout_events_contact ON leadscout_events(contact_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_leadscout_events_lead ON leadscout_events(lead_id, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leadscout_sub_unique
      ON leadscout_events(submission_id) WHERE submission_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leadscout_book_unique
      ON leadscout_events(booking_id) WHERE booking_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS leadscout_capture_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      lead_id INTEGER,
      ref_id INTEGER,
      error TEXT NOT NULL DEFAULT '',
      payload_json TEXT,
      retries INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_leadscout_failures_open
      ON leadscout_capture_failures(resolved_at, id DESC);
  `);
}

function normEmail(email) {
  return String(email || '').trim().toLowerCase().slice(0, 240);
}

function normPhone(phone) {
  const digits = String(phone || '').replace(/\D+/g, '');
  if (digits.length < 7) return '';
  return digits.slice(-15);
}

function pickContactFields(payload = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const lower = {};
  Object.keys(p).forEach((k) => { lower[String(k).toLowerCase()] = p[k]; });
  const name = String(
    p.name || p.full_name || p.fullName || p.customer_name
    || lower.name || lower['full name'] || lower.fullname || ''
  ).trim().slice(0, 200);
  const email = String(
    p.email || p.Email || p.customer_email || lower.email || lower['e-mail'] || ''
  ).trim().slice(0, 240);
  const phone = String(
    p.phone || p.Phone || p.customer_phone || p.tel || lower.phone || lower.telephone || lower.mobile || ''
  ).trim().slice(0, 60);
  return { name, email, phone };
}

function findContact(db, { email, phone }) {
  const em = normEmail(email);
  const ph = normPhone(phone);
  if (em) {
    const byEmail = db.prepare(
      'SELECT * FROM leadscout_contacts WHERE email_norm = ? LIMIT 1'
    ).get(em);
    if (byEmail) return byEmail;
  }
  if (ph) {
    const byPhone = db.prepare(
      'SELECT * FROM leadscout_contacts WHERE phone_norm = ? LIMIT 1'
    ).get(ph);
    if (byPhone) return byPhone;
  }
  return null;
}

function upsertContact(db, { name, email, phone }) {
  ensureTables(db);
  const em = normEmail(email);
  const ph = normPhone(phone);
  if (!em && !ph) {
    throw fail('VALIDATION', 'LeadScout contact needs email or phone');
  }
  let row = findContact(db, { email: em, phone: ph });
  if (!row) {
    const info = db.prepare(`
      INSERT INTO leadscout_contacts (name, email, phone, email_norm, phone_norm)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      String(name || '').slice(0, 200),
      String(email || '').slice(0, 240),
      String(phone || '').slice(0, 60),
      em,
      ph
    );
    return db.prepare('SELECT * FROM leadscout_contacts WHERE id = ?').get(info.lastInsertRowid);
  }
  const nextName = String(name || '').trim() || row.name;
  const nextEmail = String(email || '').trim() || row.email;
  const nextPhone = String(phone || '').trim() || row.phone;
  db.prepare(`
    UPDATE leadscout_contacts
    SET name = ?, email = ?, phone = ?,
        email_norm = ?, phone_norm = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    nextName.slice(0, 200),
    nextEmail.slice(0, 240),
    nextPhone.slice(0, 60),
    normEmail(nextEmail) || row.email_norm,
    normPhone(nextPhone) || row.phone_norm,
    row.id
  );
  return db.prepare('SELECT * FROM leadscout_contacts WHERE id = ?').get(row.id);
}

function recordFailure(db, { kind, leadId, refId, error, payload, encrypted = false }) {
  ensureTables(db);
  db.prepare(`
    INSERT INTO leadscout_capture_failures (kind, lead_id, ref_id, error, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    String(kind || 'unknown'),
    leadId != null ? Number(leadId) : null,
    refId != null ? Number(refId) : null,
    kind === 'submission' && (encrypted || submissionCopies.encryptedSubmission(db, refId)) ? 'Submission capture failed' : String(error || '').slice(0, 500),
    payload != null ? (kind === 'submission' ? submissionCopies.serialize(db, refId, payload, { encrypted }) : JSON.stringify(payload).slice(0, 8000)) : null
  );
}

function captureFromSubmission(db, {
  leadId,
  formId,
  formName,
  pageSlug,
  submissionId,
  payload,
  encrypted = false,
} = {}) {
  ensureTables(db);
  const protect = encrypted || !!submissionCopies.encryptedSubmission(db, submissionId);
  try {
    const fields = pickContactFields(payload);
    if (!fields.email && !fields.phone) {
      // Nothing to attach — not a failure (anonymous / incomplete form).
      return { skipped: true, reason: 'no_identity' };
    }
    const contact = upsertContact(db, fields);
    const existing = db.prepare(
      'SELECT id FROM leadscout_events WHERE submission_id = ?'
    ).get(Number(submissionId));
    if (existing) return { contact, eventId: existing.id, deduped: true };
    const info = db.prepare(`
      INSERT INTO leadscout_events
        (contact_id, lead_id, kind, source_label, page_slug, form_id, submission_id, payload_json)
      VALUES (?, ?, 'submission', ?, ?, ?, ?, ?)
    `).run(
      contact.id,
      leadId != null ? Number(leadId) : null,
      String(formName || 'Form').slice(0, 160),
      String(pageSlug || '').slice(0, 120),
      formId != null ? Number(formId) : null,
      Number(submissionId),
      submissionCopies.serialize(db, submissionId, payload || {}, { encrypted: protect })
    );
    return { contact, eventId: info.lastInsertRowid };
  } catch (e) {
    recordFailure(db, {
      kind: 'submission',
      leadId,
      refId: submissionId,
      encrypted: protect,
      error: e.message || String(e),
      payload: { formId, pageSlug, payload },
    });
    return { error: protect ? 'Submission capture failed' : e.message || String(e) };
  }
}

function captureFromBooking(db, {
  leadId,
  booking,
  serviceName,
  pageSlug,
} = {}) {
  ensureTables(db);
  try {
    if (!booking || !booking.id) throw fail('VALIDATION', 'booking required');
    const fields = {
      name: booking.customer_name,
      email: booking.customer_email,
      phone: booking.customer_phone,
    };
    if (!fields.email && !fields.phone) {
      return { skipped: true, reason: 'no_identity' };
    }
    const contact = upsertContact(db, fields);
    const existing = db.prepare(
      'SELECT id FROM leadscout_events WHERE booking_id = ?'
    ).get(Number(booking.id));
    if (existing) {
      db.prepare(`
        UPDATE leadscout_events
        SET status = ?, starts_at = ?, service_name = ?
        WHERE id = ?
      `).run(
        String(booking.status || ''),
        booking.starts_at || null,
        String(serviceName || '').slice(0, 160),
        existing.id
      );
      return { contact, eventId: existing.id, deduped: true };
    }
    const info = db.prepare(`
      INSERT INTO leadscout_events
        (contact_id, lead_id, kind, source_label, page_slug, booking_id, status, starts_at, service_name, payload_json)
      VALUES (?, ?, 'appointment', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      contact.id,
      leadId != null ? Number(leadId) : null,
      'Booking',
      String(pageSlug || '').slice(0, 120),
      Number(booking.id),
      String(booking.status || ''),
      booking.starts_at || null,
      String(serviceName || '').slice(0, 160),
      JSON.stringify({
        customer_name: booking.customer_name,
        customer_email: booking.customer_email,
        customer_phone: booking.customer_phone,
        notes: booking.notes,
        ends_at: booking.ends_at,
      }).slice(0, 8000)
    );
    return { contact, eventId: info.lastInsertRowid };
  } catch (e) {
    recordFailure(db, {
      kind: 'appointment',
      leadId,
      refId: booking && booking.id,
      error: e.message || String(e),
      payload: { booking, serviceName, pageSlug },
    });
    return { error: e.message || String(e) };
  }
}

function validLeadScope(leadId) {
  if (leadId == null) return null; // Explicit workspace-level internal callers only.
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0) throw fail('FORBIDDEN', 'Valid business scope required', 403);
  return id;
}

// Shared deduplication rows can be updated by a different business. Client
// identities must come only from that business's own captured event snapshots.
function projectScopedContact(db, row, leadId) {
  const snapshots = db.prepare(`
    SELECT payload_json FROM leadscout_events
    WHERE contact_id = ? AND lead_id = ? ORDER BY id DESC LIMIT 100
  `).all(Number(row.id), leadId);
  const identity = { name: '', email: '', phone: '' };
  for (const snapshot of snapshots) {
    let payload;
    try { payload = submissionCopies.decode(snapshot.payload_json) || {}; } catch { continue; }
    const fields = pickContactFields(payload);
    for (const key of ['name', 'email', 'phone']) {
      if (!identity[key] && fields[key]) identity[key] = fields[key];
    }
    if (identity.name && identity.email && identity.phone) break;
  }
  return { ...row, ...identity, email_norm: normEmail(identity.email), phone_norm: normPhone(identity.phone) };
}

function listContacts(db, { leadId = null, q = '', limit = 50, offset = 0 } = {}) {
  ensureTables(db);
  leadId = validLeadScope(leadId);
  const lim = Math.min(100, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const query = String(q || '').trim().toLowerCase();
  let rows;
  if (leadId != null) {
    rows = db.prepare(`
      SELECT c.id,
        MIN(e.created_at) AS created_at, MAX(e.created_at) AS updated_at,
        COUNT(*) AS event_count, MAX(e.created_at) AS last_event_at
      FROM leadscout_contacts c
      JOIN leadscout_events e ON e.contact_id = c.id AND e.lead_id = ?
      GROUP BY c.id
      ORDER BY last_event_at DESC, c.id DESC
      LIMIT ? OFFSET ?
    `).all(leadId, lim, off).map((row) => projectScopedContact(db, row, leadId));
  } else {
    rows = db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM leadscout_events e WHERE e.contact_id = c.id) AS event_count,
        (SELECT MAX(e.created_at) FROM leadscout_events e WHERE e.contact_id = c.id) AS last_event_at
      FROM leadscout_contacts c
      ORDER BY COALESCE(
        (SELECT MAX(e.created_at) FROM leadscout_events e WHERE e.contact_id = c.id),
        c.updated_at
      ) DESC
      LIMIT ? OFFSET ?
    `).all(lim, off);
  }
  if (query) {
    rows = rows.filter((r) => {
      const blob = `${r.name} ${r.email} ${r.phone}`.toLowerCase();
      return blob.includes(query);
    });
  }
  return rows;
}

function getContact(db, id, { leadId = null } = {}) {
  ensureTables(db);
  leadId = validLeadScope(leadId);
  let contact = leadId == null
    ? db.prepare('SELECT * FROM leadscout_contacts WHERE id = ?').get(Number(id))
    : db.prepare(`
      SELECT c.id, MIN(e.created_at) AS created_at, MAX(e.created_at) AS updated_at,
        COUNT(*) AS event_count, MAX(e.created_at) AS last_event_at
      FROM leadscout_contacts c
      JOIN leadscout_events e ON e.contact_id = c.id AND e.lead_id = ?
      WHERE c.id = ? GROUP BY c.id
    `).get(leadId, Number(id));
  if (!contact) throw fail('NOT_FOUND', 'LeadScout contact not found', 404);
  if (leadId != null) contact = projectScopedContact(db, contact, leadId);
  const events = (leadId == null
    ? db.prepare('SELECT * FROM leadscout_events WHERE contact_id = ? ORDER BY id DESC LIMIT 100').all(Number(id))
    : db.prepare('SELECT * FROM leadscout_events WHERE contact_id = ? AND lead_id = ? ORDER BY id DESC LIMIT 100').all(Number(id), leadId)
  ).map((e) => {
    let payload = null;
    if (e.payload_json) {
      try { payload = submissionCopies.decode(e.payload_json); } catch { payload = null; }
    }
    return { ...e, payload };
  });
  return { contact, events, appointments: events.filter((e) => e.kind === 'appointment'), submissions: events.filter((e) => e.kind === 'submission') };
}

function captureHealth(db, { leadId = null } = {}) {
  ensureTables(db);
  leadId = validLeadScope(leadId);
  const scope = leadId == null ? '' : ' AND lead_id = ?';
  const params = leadId == null ? [] : [leadId];
  const open = db.prepare(`
    SELECT COUNT(*) AS c FROM leadscout_capture_failures WHERE resolved_at IS NULL${scope}
  `).get(...params);
  const recent = db.prepare(`
    SELECT * FROM leadscout_capture_failures
    WHERE resolved_at IS NULL${scope}
    ORDER BY id DESC LIMIT 20
  `).all(...params);
  return {
    ok: !(open && open.c),
    open_failures: Number(open && open.c) || 0,
    failures: recent,
  };
}

function retryOpenFailures(db, { leadId = null } = {}) {
  ensureTables(db);
  leadId = validLeadScope(leadId);
  const scope = leadId == null ? '' : ' AND lead_id = ?';
  const open = db.prepare(`
    SELECT * FROM leadscout_capture_failures
    WHERE resolved_at IS NULL${scope}
    ORDER BY id ASC LIMIT 50
  `).all(...(leadId == null ? [] : [leadId]));
  let resolved = 0;
  for (const row of open) {
    let payload = null;
    try { payload = row.payload_json ? submissionCopies.decode(row.payload_json) : null; } catch { payload = null; }
    let result = null;
    if (row.kind === 'submission' && payload) {
      result = captureFromSubmission(db, {
        leadId: row.lead_id,
        formId: payload.formId,
        formName: payload.formName,
        pageSlug: payload.pageSlug,
        submissionId: row.ref_id,
        payload: payload.payload || payload,
      });
    } else if (row.kind === 'appointment' && payload) {
      result = captureFromBooking(db, {
        leadId: row.lead_id,
        booking: payload.booking,
        serviceName: payload.serviceName,
        pageSlug: payload.pageSlug,
      });
    }
    db.prepare(`
      UPDATE leadscout_capture_failures
      SET retries = retries + 1, updated_at = datetime('now'),
          resolved_at = CASE WHEN ? THEN datetime('now') ELSE resolved_at END,
          error = CASE WHEN ? THEN error ELSE ? END
      WHERE id = ?
    `).run(
      result && !result.error ? 1 : 0,
      result && !result.error ? 1 : 0,
      result && result.error ? String(result.error).slice(0, 500) : row.error,
      row.id
    );
    if (result && !result.error) resolved += 1;
  }
  return { tried: open.length, resolved, health: captureHealth(db, { leadId }) };
}

module.exports = {
  ensureTables,
  upsertContact,
  captureFromSubmission,
  captureFromBooking,
  listContacts,
  getContact,
  captureHealth,
  retryOpenFailures,
  pickContactFields,
  normEmail,
  normPhone,
};
