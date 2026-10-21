'use strict';

/**
 * Per-lead contact form builder + plan-tiered submission routing.
 * Multiple forms per lead; optional embed into a chosen site page (default: contact).
 *
 * Free:     email only (no portal inbox / no MCP)
 * Standard: portal inbox (no MCP form tools)
 * Premium:  encrypted at rest + Muse webhook; MCP form.submissions.*
 *
 * Encryption key: SHA-256(SESSION_SECRET) — same pattern as socialMedia token enc.
 */

const crypto = require('crypto');
const { getPlan, normalizePlanId } = require('./plans');

const FIELD_TYPES = ['text', 'email', 'tel', 'phone', 'textarea', 'select', 'date', 'checkbox', 'number', 'url'];
const MANAGED_ATTR = 'data-bitpype-managed';
const EMBED_TOKEN_ATTR = 'data-bitpype-form-embed';
const SCRIPT_ATTR = 'data-bitpype-form-script';
const FORM_SCRIPT_VER = 'form7';
const HAND_ROLLED_FORM_WARNING =
  'Hand-rolled forms are not allowed — use the contact_form module, an existing form module, or create one with forms.create.';

/** Normalize agent/portal field types (phone → tel; unknown → text). */
function normalizeFieldType(raw) {
  let t = String(raw == null ? 'text' : raw).toLowerCase().trim();
  if (t === 'phone') t = 'tel';
  if (FIELD_TYPES.includes(t) && t !== 'phone') return t;
  return 'text';
}

function normalizeFieldInput(f, i = 0) {
  const src = f && typeof f === 'object' ? f : {};
  return {
    field_key: src.field_key || src.key || undefined,
    label: src.label,
    field_type: normalizeFieldType(src.field_type || src.type),
    required: !!src.required,
    placeholder: src.placeholder,
    options: src.options,
    sort_order: src.sort_order != null ? src.sort_order : i,
  };
}

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

/** Coerce MCP/portal booleans (false/0/"false" → false; missing → fallback). */
function coerceBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

/** Coerce MCP/portal booleans (false/0/"false" → false; missing → fallback). */
function coerceBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function appSecret() {
  const secret = process.env.SESSION_SECRET || process.env.FORM_PAYLOAD_SECRET || '';
  if (!secret || secret === 'dev-change-me' || secret === 'ChangeMe') {
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
      throw fail('MISCONFIGURED', 'SESSION_SECRET must be set to a strong value in production', 500);
    }
    return secret || 'dev-change-me';
  }
  return secret;
}

function encryptPayload(plainObj) {
  const key = crypto.createHash('sha256').update(appSecret()).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(plainObj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

function decryptPayload(blob) {
  if (!blob) return null;
  try {
    const buf = Buffer.from(String(blob), 'base64url');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const key = crypto.createHash('sha256').update(appSecret()).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

function tableSql(db, name) {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name);
  return row && row.sql ? String(row.sql) : '';
}

function columnNames(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  } catch {
    return new Set();
  }
}

function ensureTables(db) {
  // Create base tables first — do NOT create indexes on columns that may be
  // missing on older DBs (CREATE TABLE IF NOT EXISTS is a no-op for them).
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_forms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT 'Contact form',
      title TEXT NOT NULL DEFAULT 'Contact Us',
      intro TEXT NOT NULL DEFAULT '',
      submit_label TEXT NOT NULL DEFAULT 'Send Message',
      success_message TEXT NOT NULL DEFAULT 'Thanks — we received your message.',
      notify_email TEXT NOT NULL DEFAULT '',
      public_token TEXT,
      published INTEGER NOT NULL DEFAULT 0,
      published_to_site INTEGER NOT NULL DEFAULT 0,
      embed_enabled INTEGER NOT NULL DEFAULT 1,
      target_page_slug TEXT NOT NULL DEFAULT 'contact',
      sort_order INTEGER NOT NULL DEFAULT 0,
      form_kind TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS form_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      form_id INTEGER NOT NULL,
      field_key TEXT NOT NULL,
      label TEXT NOT NULL,
      field_type TEXT NOT NULL DEFAULT 'text',
      required INTEGER NOT NULL DEFAULT 0,
      placeholder TEXT NOT NULL DEFAULT '',
      options_json TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(form_id, field_key)
    );
    CREATE TABLE IF NOT EXISTS form_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      form_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      payload_json TEXT,
      encrypted_payload TEXT,
      routing TEXT NOT NULL DEFAULT 'email',
      muse_delivered INTEGER NOT NULL DEFAULT 0,
      muse_error TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_form_submissions_lead ON form_submissions(lead_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_contact_forms_token ON contact_forms(public_token);
  `);
  migrateMultiFormSchema(db);
  // Indexes that need migrated columns — safe after ALTER TABLE
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_form_fields_form ON form_fields(form_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_contact_forms_lead ON contact_forms(lead_id, sort_order, id);
    `);
  } catch (e) {
    console.warn('[contactForms] index create:', e.message);
  }
}

function migrateMultiFormSchema(db) {
  const cols = columnNames(db, 'contact_forms');
  if (!cols.size) return;

  const addCol = (table, name, ddl, set) => {
    if (!set.has(name)) {
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`); } catch { /* race / exists */ }
      set.add(name);
    }
  };
  addCol('contact_forms', 'name', "name TEXT NOT NULL DEFAULT 'Contact form'", cols);
  addCol('contact_forms', 'embed_enabled', 'embed_enabled INTEGER NOT NULL DEFAULT 1', cols);
  addCol('contact_forms', 'target_page_slug', "target_page_slug TEXT NOT NULL DEFAULT 'contact'", cols);
  addCol('contact_forms', 'sort_order', 'sort_order INTEGER NOT NULL DEFAULT 0', cols);
  addCol('contact_forms', 'form_kind', 'form_kind TEXT', cols);
  addCol('contact_forms', 'published_to_site', 'published_to_site INTEGER NOT NULL DEFAULT 0', cols);
  addCol('contact_forms', 'published', 'published INTEGER NOT NULL DEFAULT 0', cols);
  // Off by default: embedding a form must not force a top-nav link.
  addCol('contact_forms', 'add_to_nav', 'add_to_nav INTEGER NOT NULL DEFAULT 0', cols);

  const fieldCols = columnNames(db, 'form_fields');
  if (fieldCols.size) {
    addCol('form_fields', 'sort_order', 'sort_order INTEGER NOT NULL DEFAULT 0', fieldCols);
    addCol('form_fields', 'placeholder', "placeholder TEXT NOT NULL DEFAULT ''", fieldCols);
    addCol('form_fields', 'options_json', 'options_json TEXT', fieldCols);
  }

  // Backfill names / embed flags from legacy rows
  try {
    db.prepare(`
      UPDATE contact_forms SET name = COALESCE(NULLIF(TRIM(name), ''), title, 'Contact form')
      WHERE name IS NULL OR TRIM(name) = ''
    `).run();
    db.prepare(`
      UPDATE contact_forms SET embed_enabled = 1
      WHERE embed_enabled IS NULL
    `).run();
    db.prepare(`
      UPDATE contact_forms SET target_page_slug = 'contact'
      WHERE target_page_slug IS NULL OR TRIM(target_page_slug) = ''
    `).run();
    // Do NOT re-enable embed_enabled here — a prior bug forced embed_enabled=1 whenever
    // published+published_to_site, which silently undid forms.update { embed_enabled:false }.
    db.prepare(`
      UPDATE contact_forms SET add_to_nav = 0
      WHERE add_to_nav IS NULL
    `).run();
  } catch { /* best-effort */ }

  const sql = tableSql(db, 'contact_forms');
  if (sql && /lead_id\s+INTEGER\s+NOT\s+NULL\s+UNIQUE/i.test(sql)) {
    db.exec(`
      CREATE TABLE contact_forms_mig (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER NOT NULL,
        name TEXT NOT NULL DEFAULT 'Contact form',
        title TEXT NOT NULL DEFAULT 'Contact Us',
        intro TEXT NOT NULL DEFAULT '',
        submit_label TEXT NOT NULL DEFAULT 'Send Message',
        success_message TEXT NOT NULL DEFAULT 'Thanks — we received your message.',
        notify_email TEXT NOT NULL DEFAULT '',
        public_token TEXT,
        published INTEGER NOT NULL DEFAULT 0,
        published_to_site INTEGER NOT NULL DEFAULT 0,
        embed_enabled INTEGER NOT NULL DEFAULT 1,
        target_page_slug TEXT NOT NULL DEFAULT 'contact',
        sort_order INTEGER NOT NULL DEFAULT 0,
        form_kind TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO contact_forms_mig (
        id, lead_id, name, title, intro, submit_label, success_message, notify_email,
        public_token, published, published_to_site, embed_enabled, target_page_slug, sort_order,
        form_kind, status, created_at, updated_at
      )
      SELECT
        id, lead_id,
        COALESCE(NULLIF(TRIM(name), ''), title, 'Contact form'),
        title, intro, submit_label, success_message, notify_email,
        public_token, published, published_to_site,
        COALESCE(embed_enabled, 1),
        COALESCE(NULLIF(TRIM(target_page_slug), ''), 'contact'),
        COALESCE(sort_order, 0),
        form_kind,
        status, created_at, updated_at
      FROM contact_forms;
      DROP TABLE contact_forms;
      ALTER TABLE contact_forms_mig RENAME TO contact_forms;
      CREATE INDEX IF NOT EXISTS idx_contact_forms_token ON contact_forms(public_token);
      CREATE INDEX IF NOT EXISTS idx_contact_forms_lead ON contact_forms(lead_id, sort_order, id);
    `);
  }
}

function defaultFields() {
  return [
    { field_key: 'name', label: 'Name', field_type: 'text', required: 1, placeholder: 'Your name', sort_order: 0 },
    { field_key: 'email', label: 'Email', field_type: 'email', required: 1, placeholder: 'you@example.com', sort_order: 1 },
    { field_key: 'phone', label: 'Phone', field_type: 'tel', required: 0, placeholder: '', sort_order: 2 },
    { field_key: 'message', label: 'Message', field_type: 'textarea', required: 1, placeholder: '', sort_order: 3 },
  ];
}

/** Preset form kinds created when MCP/template builds a site. */
const FORM_PRESETS = {
  contact: {
    kind: 'contact',
    name: 'Contact form',
    title: 'Contact Us',
    submit_label: 'Send Message',
    success_message: 'Thanks — we received your message.',
    intro: (biz) => `Reach out to ${biz || 'us'} — we will get back to you soon.`,
    slugHints: ['contact', 'get-in-touch', 'get_in_touch', 'reach-us'],
    titleHints: ['contact', 'get in touch'],
    fields: () => defaultFields(),
  },
  quote: {
    kind: 'quote',
    name: 'Quote request',
    title: 'Request a Quote',
    submit_label: 'Request Quote',
    success_message: 'Thanks — we will send your quote shortly.',
    intro: (biz) => `Tell ${biz || 'us'} what you need and we will prepare a quote.`,
    slugHints: ['quote', 'estimate', 'pricing', 'get-a-quote', 'free-estimate'],
    titleHints: ['quote', 'estimate', 'pricing'],
    fields: () => [
      { field_key: 'name', label: 'Name', field_type: 'text', required: 1, placeholder: 'Your name', sort_order: 0 },
      { field_key: 'email', label: 'Email', field_type: 'email', required: 1, placeholder: 'you@example.com', sort_order: 1 },
      { field_key: 'phone', label: 'Phone', field_type: 'tel', required: 0, placeholder: '', sort_order: 2 },
      { field_key: 'service', label: 'Service needed', field_type: 'text', required: 1, placeholder: 'What do you need?', sort_order: 3 },
      { field_key: 'details', label: 'Project details', field_type: 'textarea', required: 1, placeholder: '', sort_order: 4 },
      { field_key: 'budget', label: 'Budget (optional)', field_type: 'text', required: 0, placeholder: '', sort_order: 5 },
    ],
  },
  appointment: {
    kind: 'appointment',
    name: 'Appointment request',
    title: 'Book an Appointment',
    submit_label: 'Request Appointment',
    success_message: 'Thanks — we will confirm your appointment soon.',
    intro: (biz) => `Request a time with ${biz || 'us'} and we will confirm.`,
    slugHints: ['appointment', 'book', 'booking', 'schedule', 'appointments'],
    titleHints: ['appointment', 'book', 'schedule', 'booking'],
    fields: () => [
      { field_key: 'name', label: 'Name', field_type: 'text', required: 1, placeholder: 'Your name', sort_order: 0 },
      { field_key: 'email', label: 'Email', field_type: 'email', required: 1, placeholder: 'you@example.com', sort_order: 1 },
      { field_key: 'phone', label: 'Phone', field_type: 'tel', required: 1, placeholder: '', sort_order: 2 },
      { field_key: 'preferred_date', label: 'Preferred date', field_type: 'text', required: 1, placeholder: 'YYYY-MM-DD', sort_order: 3 },
      { field_key: 'preferred_time', label: 'Preferred time', field_type: 'text', required: 0, placeholder: 'e.g. morning / 2pm', sort_order: 4 },
      { field_key: 'notes', label: 'Notes', field_type: 'textarea', required: 0, placeholder: '', sort_order: 5 },
    ],
  },
};

function pageMatchesKind(page, kind) {
  const preset = FORM_PRESETS[kind];
  if (!preset || !page) return false;
  const s = normalizeSlug(page.slug);
  const t = String(page.title || '').toLowerCase();
  if (preset.slugHints.some((h) => s === h || s.includes(h))) return true;
  if (preset.titleHints.some((h) => t.includes(h))) return true;
  if (kind === 'contact') {
    const sections = Array.isArray(page.sections) ? page.sections : [];
    if (sections.some((sec) => sec && sec.type === 'contact_form')) return true;
  }
  return false;
}

function resolveTargetSlug(pages, kind) {
  const list = Array.isArray(pages) ? pages : [];
  const idx = list.findIndex((p) => pageMatchesKind(p, kind));
  if (idx >= 0) return normalizeSlug(list[idx].slug) || kind;
  if (kind === 'contact') return 'contact';
  return null;
}

function inferFormKind(row) {
  if (row && row.form_kind && FORM_PRESETS[row.form_kind]) return row.form_kind;
  const n = String((row && (row.name || row.title)) || '').toLowerCase();
  if (/quote|estimate/.test(n)) return 'quote';
  if (/appoint|book|schedule/.test(n)) return 'appointment';
  if (/contact/.test(n)) return 'contact';
  return null;
}

function publicField(row) {
  let options = null;
  if (row.options_json) {
    try { options = JSON.parse(row.options_json); } catch { options = null; }
  }
  return {
    id: row.id,
    field_key: row.field_key,
    label: row.label,
    field_type: row.field_type,
    required: !!row.required,
    placeholder: row.placeholder || '',
    options,
    sort_order: row.sort_order,
  };
}

function publicForm(row, fields = []) {
  return {
    id: row.id,
    lead_id: row.lead_id,
    name: row.name || row.title || 'Contact form',
    title: row.title,
    intro: row.intro || '',
    submit_label: row.submit_label || 'Send Message',
    success_message: row.success_message || 'Thanks — we received your message.',
    notify_email: row.notify_email || '',
    public_token: row.public_token || null,
    published: !!row.published,
    published_to_site: !!row.published_to_site,
    embed_enabled: row.embed_enabled == null ? true : !!row.embed_enabled,
    // Alias for portal UI ("Add to page")
    embed_on_page: row.embed_enabled == null ? true : !!row.embed_enabled,
    // Off by default — embedding does not add a top-nav menu item.
    add_to_nav: row.add_to_nav == null ? false : !!row.add_to_nav,
    nav_visible: row.add_to_nav == null ? false : !!row.add_to_nav,
    target_page_slug: String(row.target_page_slug || 'contact').trim() || 'contact',
    sort_order: Number(row.sort_order) || 0,
    form_kind: row.form_kind || inferFormKind(row) || null,
    status: row.status,
    fields: fields.map(publicField),
    updated_at: row.updated_at,
    created_at: row.created_at,
  };
}

function listFormRows(db, leadId) {
  return db.prepare(`
    SELECT * FROM contact_forms WHERE lead_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(Number(leadId));
}

function getFormRowById(db, leadId, formId) {
  return db.prepare(
    'SELECT * FROM contact_forms WHERE id = ? AND lead_id = ?'
  ).get(Number(formId), Number(leadId));
}

/** @deprecated Prefer getFormRowById — returns first form for lead. */
function getFormRow(db, leadId) {
  return db.prepare(`
    SELECT * FROM contact_forms WHERE lead_id = ?
    ORDER BY sort_order ASC, id ASC LIMIT 1
  `).get(Number(leadId));
}

function listFields(db, formId) {
  return db.prepare(
    'SELECT * FROM form_fields WHERE form_id = ? ORDER BY sort_order ASC, id ASC'
  ).all(Number(formId));
}

function nextSortOrder(db, leadId) {
  const row = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) AS m FROM contact_forms WHERE lead_id = ?'
  ).get(Number(leadId));
  return (row && Number.isFinite(Number(row.m)) ? Number(row.m) : -1) + 1;
}

function insertFieldsList(db, formId, fields) {
  const ins = db.prepare(`
    INSERT INTO form_fields (form_id, field_key, label, field_type, required, placeholder, options_json, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  (fields || defaultFields()).forEach((raw, i) => {
    const f = normalizeFieldInput(raw, i);
    const type = normalizeFieldType(f.field_type);
    const options = Array.isArray(f.options) ? JSON.stringify(f.options.slice(0, 50).map(String)) : null;
    ins.run(
      formId,
      String(f.field_key || `field_${i + 1}`).slice(0, 40),
      String(f.label || f.field_key || `Field ${i + 1}`).slice(0, 120),
      type,
      f.required ? 1 : 0,
      String(f.placeholder || '').slice(0, 200),
      options,
      Number.isFinite(Number(f.sort_order)) ? Number(f.sort_order) : i
    );
  });
}

function insertDefaultFields(db, formId) {
  insertFieldsList(db, formId, defaultFields());
}

/** Purpose-built form intents (MCP forms.create / forms.suggestFields). */
const FORM_PURPOSES = [
  'appointment_request',
  'quote_request',
  'callback_request',
  'event_rsvp',
  'general_inquiry',
];

const STRUCTURED_PURPOSES = new Set([
  'appointment_request',
  'quote_request',
  'callback_request',
  'event_rsvp',
]);

function normalizePurpose(raw) {
  if (raw == null || raw === '') return null;
  const p = String(raw).trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (FORM_PURPOSES.includes(p)) return p;
  // Aliases from form_kind / casual names
  if (p === 'appointment' || p === 'booking' || p === 'book') return 'appointment_request';
  if (p === 'quote' || p === 'estimate') return 'quote_request';
  if (p === 'callback' || p === 'call_back') return 'callback_request';
  if (p === 'rsvp' || p === 'event' || p === 'event_rsvp') return 'event_rsvp';
  if (p === 'contact' || p === 'inquiry' || p === 'general') return 'general_inquiry';
  return null;
}

function purposeMeta(purpose, biz) {
  const name = biz || 'us';
  switch (purpose) {
    case 'appointment_request':
      return {
        form_kind: 'appointment',
        name: 'Appointment request',
        title: 'Request an Appointment',
        submit_label: 'Request Appointment',
        success_message: 'Thanks — we will confirm your appointment soon.',
        intro: `Request a time with ${name} and we will confirm.`,
        target_page_slug: 'book',
      };
    case 'quote_request':
      return {
        form_kind: 'quote',
        name: 'Quote request',
        title: 'Request a Quote',
        submit_label: 'Request Quote',
        success_message: 'Thanks — we will send your quote shortly.',
        intro: `Tell ${name} what you need and we will prepare a quote.`,
        target_page_slug: 'quote',
      };
    case 'callback_request':
      return {
        form_kind: 'contact',
        name: 'Callback request',
        title: 'Request a Callback',
        submit_label: 'Request Callback',
        success_message: 'Thanks — we will call you back soon.',
        intro: `Leave your number and ${name} will call you back.`,
        target_page_slug: 'contact',
      };
    case 'event_rsvp':
      return {
        form_kind: null,
        name: 'Event RSVP',
        title: 'RSVP',
        submit_label: 'Submit RSVP',
        success_message: 'Thanks — your RSVP is recorded.',
        intro: `Let ${name} know if you can make it.`,
        target_page_slug: 'events',
      };
    case 'general_inquiry':
    default:
      return {
        form_kind: 'contact',
        name: 'Contact form',
        title: 'Contact Us',
        submit_label: 'Send Message',
        success_message: 'Thanks — we received your message.',
        intro: `Reach out to ${name} — we will get back to you soon.`,
        target_page_slug: 'contact',
      };
  }
}

function leadServiceOptions(db, leadId) {
  const opts = [];
  try {
    const modules = require('./siteModules');
    modules.ensureTables(db);
    const services = modules.listBookingServices(db, Number(leadId), { includeDrafts: false }) || [];
    for (const s of services) {
      const n = String(s.name || '').trim();
      if (n) opts.push(n);
    }
  } catch { /* optional */ }
  if (!opts.length) {
    try {
      const facts = db.prepare(
        `SELECT fact_key, value FROM business_facts
         WHERE lead_id = ? AND (fact_key LIKE '%service%' OR fact_key LIKE '%offering%')
         LIMIT 20`
      ).all(Number(leadId));
      for (const f of facts || []) {
        const v = String(f.value || '').trim();
        if (v && v.length < 80) opts.push(v);
      }
    } catch { /* optional */ }
  }
  if (!opts.length) opts.push('General service', 'Consultation', 'Other');
  return [...new Set(opts)].slice(0, 30);
}

function leadStaffOptions(db, leadId) {
  const opts = ['First available'];
  try {
    const modules = require('./siteModules');
    modules.ensureTables(db);
    const team = modules.listTeamMembers(db, Number(leadId), { includeDrafts: false }) || [];
    for (const m of team) {
      const n = String(m.name || '').trim();
      if (n) opts.push(n);
    }
  } catch { /* optional */ }
  return [...new Set(opts)].slice(0, 30);
}

function leadEventOptions(db, leadId) {
  const opts = [];
  try {
    const modules = require('./siteModules');
    modules.ensureTables(db);
    const events = modules.listEvents(db, Number(leadId), { includeDrafts: false }) || [];
    for (const e of events) {
      const n = String(e.title || e.name || '').trim();
      if (n) opts.push(n);
    }
  } catch { /* optional */ }
  if (!opts.length) opts.push('Upcoming event', 'Other');
  return [...new Set(opts)].slice(0, 30);
}

function leadTimeWindowOptions(db, leadId) {
  const defaults = ['Morning', 'Afternoon', 'Evening'];
  try {
    const modules = require('./siteModules');
    modules.ensureTables(db);
    const hours = modules.listBookingHours(db, Number(leadId)) || [];
    if (!hours.length) return defaults;
    // Prefer shop-hour windows when available (unique start–end labels).
    const labels = hours.map((h) => {
      const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][Number(h.weekday)] || '';
      return `${day} ${h.start_time}–${h.end_time}`.trim();
    }).filter(Boolean);
    if (labels.length) return [...new Set([...defaults, ...labels])].slice(0, 20);
  } catch { /* optional */ }
  return defaults;
}

function leadDisplayName(db, leadId) {
  try {
    const lead = db.prepare('SELECT business_name, name FROM leads WHERE id = ?').get(Number(leadId));
    return String((lead && (lead.business_name || lead.name)) || '').trim();
  } catch {
    return '';
  }
}

/**
 * Build typed fields for a purpose using lead real data (services, staff, hours, events).
 * Never returns blank name/email/message-only for structured purposes.
 */
function suggestFieldsForPurpose(db, leadId, purposeRaw) {
  const purpose = normalizePurpose(purposeRaw) || 'general_inquiry';
  const biz = leadDisplayName(db, leadId) || 'our team';
  const meta = purposeMeta(purpose, biz);
  let fields = [];

  if (purpose === 'appointment_request') {
    const services = leadServiceOptions(db, leadId);
    const staff = leadStaffOptions(db, leadId);
    const windows = leadTimeWindowOptions(db, leadId);
    fields = [
      { field_key: 'name', label: 'Name', field_type: 'text', required: 1, placeholder: `Your name (for ${biz})`, sort_order: 0 },
      { field_key: 'phone', label: 'Phone', field_type: 'tel', required: 1, placeholder: 'Best number to reach you', sort_order: 1 },
      { field_key: 'service', label: 'Service', field_type: 'select', required: 1, options: services, sort_order: 2 },
      { field_key: 'preferred_date', label: 'Preferred date', field_type: 'date', required: 1, placeholder: '', sort_order: 3 },
      { field_key: 'time_window', label: 'Preferred time', field_type: 'select', required: 1, options: windows, sort_order: 4 },
      { field_key: 'staff_preference', label: 'Staff preference', field_type: 'select', required: 0, options: staff, sort_order: 5 },
      { field_key: 'notes', label: 'Notes', field_type: 'textarea', required: 0, placeholder: 'Anything we should know?', sort_order: 6 },
    ];
  } else if (purpose === 'quote_request') {
    const services = leadServiceOptions(db, leadId);
    fields = [
      { field_key: 'name', label: 'Name', field_type: 'text', required: 1, placeholder: `Your name (for ${biz})`, sort_order: 0 },
      { field_key: 'email', label: 'Email', field_type: 'email', required: 1, placeholder: 'you@example.com', sort_order: 1 },
      { field_key: 'phone', label: 'Phone', field_type: 'tel', required: 0, placeholder: '', sort_order: 2 },
      { field_key: 'service', label: 'Service needed', field_type: 'select', required: 1, options: services, sort_order: 3 },
      { field_key: 'details', label: 'Project details', field_type: 'textarea', required: 1, placeholder: 'Describe scope, timeline, location…', sort_order: 4 },
      { field_key: 'budget', label: 'Budget (optional)', field_type: 'text', required: 0, placeholder: '', sort_order: 5 },
    ];
  } else if (purpose === 'callback_request') {
    const windows = leadTimeWindowOptions(db, leadId);
    fields = [
      { field_key: 'name', label: 'Name', field_type: 'text', required: 1, placeholder: `Your name (for ${biz})`, sort_order: 0 },
      { field_key: 'phone', label: 'Phone', field_type: 'tel', required: 1, placeholder: 'Number to call', sort_order: 1 },
      { field_key: 'time_window', label: 'Best time to call', field_type: 'select', required: 1, options: windows, sort_order: 2 },
      { field_key: 'reason', label: 'Reason for call', field_type: 'textarea', required: 0, placeholder: 'Briefly, what is this about?', sort_order: 3 },
    ];
  } else if (purpose === 'event_rsvp') {
    const events = leadEventOptions(db, leadId);
    fields = [
      { field_key: 'name', label: 'Name', field_type: 'text', required: 1, placeholder: `Your name (for ${biz})`, sort_order: 0 },
      { field_key: 'email', label: 'Email', field_type: 'email', required: 1, placeholder: 'you@example.com', sort_order: 1 },
      { field_key: 'event', label: 'Event', field_type: 'select', required: 1, options: events, sort_order: 2 },
      { field_key: 'guests', label: 'Number of guests', field_type: 'number', required: 0, placeholder: '1', sort_order: 3 },
      { field_key: 'notes', label: 'Notes', field_type: 'textarea', required: 0, placeholder: 'Dietary needs, accessibility…', sort_order: 4 },
    ];
  } else {
    fields = [
      { field_key: 'name', label: 'Name', field_type: 'text', required: 1, placeholder: `Your name (for ${biz})`, sort_order: 0 },
      { field_key: 'email', label: 'Email', field_type: 'email', required: 1, placeholder: 'you@example.com', sort_order: 1 },
      { field_key: 'phone', label: 'Phone', field_type: 'tel', required: 0, placeholder: '', sort_order: 2 },
      { field_key: 'message', label: 'Message', field_type: 'textarea', required: 1, placeholder: `How can ${biz} help?`, sort_order: 3 },
    ];
  }

  return {
    purpose,
    form_kind: meta.form_kind,
    name: meta.name,
    title: meta.title,
    submit_label: meta.submit_label,
    success_message: meta.success_message,
    intro: meta.intro,
    target_page_slug: meta.target_page_slug,
    fields,
  };
}

/** True when a structured-purpose form lacks typed controls (select/date/number/checkbox). */
function isFreeTextOnlyFields(fields) {
  const list = Array.isArray(fields) ? fields : [];
  if (!list.length) return true;
  return !list.some((f) => {
    const t = normalizeFieldType(f.field_type || f.type);
    return t === 'select' || t === 'date' || t === 'checkbox' || t === 'number';
  });
}

/** Lead row for form helpers — tolerate older DBs missing optional columns. */
function readLeadForForms(db, leadId) {
  const id = Number(leadId);
  try {
    return db.prepare('SELECT id, email, business_name FROM leads WHERE id = ?').get(id) || null;
  } catch (e) {
    if (!/no such column/i.test(String(e && e.message || e))) throw e;
    try {
      return db.prepare('SELECT id, business_name FROM leads WHERE id = ?').get(id) || null;
    } catch {
      try {
        const row = db.prepare('SELECT id FROM leads WHERE id = ?').get(id);
        return row ? { id: row.id, email: '', business_name: '' } : null;
      } catch {
        return null;
      }
    }
  }
}

function createForm(db, leadId, opts = {}) {
  ensureTables(db);
  const lead = readLeadForForms(db, leadId);
  if (!lead) throw fail('NOT_FOUND', 'Lead not found');

  const purpose = normalizePurpose(opts.purpose);
  const suggested = purpose ? suggestFieldsForPurpose(db, leadId, purpose) : null;

  let kind = opts.form_kind && FORM_PRESETS[opts.form_kind] ? opts.form_kind : null;
  if (!kind && suggested && suggested.form_kind && FORM_PRESETS[suggested.form_kind]) {
    kind = suggested.form_kind;
  }
  const preset = kind ? FORM_PRESETS[kind] : null;

  const name = String(
    opts.name
    || (suggested && suggested.name)
    || (preset && preset.name)
    || opts.title
    || 'Contact form'
  ).trim().slice(0, 120) || 'Contact form';
  const title = String(
    opts.title
    || (suggested && suggested.title)
    || (preset && preset.title)
    || name
  ).slice(0, 160);
  const intro = opts.intro != null
    ? String(opts.intro).slice(0, 2000)
    : (suggested
      ? String(suggested.intro).slice(0, 2000)
      : (preset
        ? String(preset.intro(lead.business_name)).slice(0, 2000)
        : `Reach out to ${lead.business_name || 'us'} — we will get back to you soon.`));
  const submit_label = opts.submit_label != null
    ? String(opts.submit_label).slice(0, 80)
    : (suggested ? suggested.submit_label : (preset ? preset.submit_label : 'Send Message'));
  const success_message = opts.success_message != null
    ? String(opts.success_message).slice(0, 500)
    : (suggested ? suggested.success_message : (preset ? preset.success_message : 'Thanks — we received your message.'));
  const notify = String(opts.notify_email != null ? opts.notify_email : (lead.email || '')).trim().slice(0, 254);
  const embedRaw = opts.embed_enabled != null ? opts.embed_enabled : opts.embed_on_page;
  const embedEnabled = coerceBool(embedRaw, true) ? 1 : 0;
  const navRaw = opts.add_to_nav != null ? opts.add_to_nav
    : (opts.nav_visible != null ? opts.nav_visible : opts.navVisible);
  const addToNav = coerceBool(navRaw, false) ? 1 : 0;
  const target = String(
    opts.target_page_slug
    || (suggested && suggested.target_page_slug)
    || (kind || 'contact')
  ).trim().slice(0, 80) || 'contact';
  const sort = Number.isFinite(Number(opts.sort_order)) ? Number(opts.sort_order) : nextSortOrder(db, leadId);
  const info = db.prepare(`
    INSERT INTO contact_forms (
      lead_id, name, title, intro, submit_label, success_message, notify_email,
      embed_enabled, target_page_slug, sort_order, form_kind, add_to_nav, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
  `).run(
    Number(leadId), name, title, intro, submit_label, success_message, notify,
    embedEnabled, target, sort, kind, addToNav
  );
  const formId = Number(info.lastInsertRowid);
  const fields = Array.isArray(opts.fields) && opts.fields.length
    ? opts.fields
    : (suggested
      ? suggested.fields
      : (preset ? preset.fields() : defaultFields()));
  insertFieldsList(db, formId, fields);
  return getFormById(db, leadId, formId);
}

function ensureDefaultForm(db, leadId, notifyEmail = '') {
  ensureTables(db);
  const existing = listFormRows(db, leadId);
  if (existing.length) return existing[0];
  const created = createForm(db, leadId, {
    name: 'Contact form',
    title: 'Contact Us',
    notify_email: notifyEmail,
    embed_enabled: true,
    target_page_slug: 'contact',
  });
  return getFormRowById(db, leadId, created.id);
}

function getFormById(db, leadId, formId) {
  ensureTables(db);
  const row = getFormRowById(db, leadId, formId);
  if (!row) throw fail('NOT_FOUND', 'Form not found', 404);
  return publicForm(row, listFields(db, row.id));
}

function getFormForLead(db, leadId, notifyEmail) {
  const row = ensureDefaultForm(db, leadId, notifyEmail);
  return publicForm(row, listFields(db, row.id));
}

function listFormsForLead(db, leadId, notifyEmail) {
  ensureTables(db);
  ensureDefaultForm(db, leadId, notifyEmail);
  return listFormRows(db, leadId).map((row) => publicForm(row, listFields(db, row.id)));
}

function listSitePages(db, leadId) {
  const fallback = [
    { slug: 'home', title: 'Home' },
    { slug: 'about', title: 'About' },
    { slug: 'services', title: 'Services' },
    { slug: 'contact', title: 'Contact' },
  ];
  const site = db.prepare(
    'SELECT id, pages FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
  ).get(Number(leadId));
  if (!site) return fallback;
  let pages;
  try { pages = JSON.parse(site.pages || '[]'); } catch { return fallback; }
  if (!Array.isArray(pages) || !pages.length) return fallback;
  const mapped = pages.map((p, i) => ({
    slug: normalizeSlug((p && p.slug) || (i === 0 ? 'home' : `page-${i}`)),
    title: String((p && p.title) || (p && p.slug) || `Page ${i + 1}`),
  }));
  if (!mapped.some((p) => p.slug === 'contact' || String(p.title).toLowerCase().includes('contact'))) {
    mapped.push({ slug: 'contact', title: 'Contact' });
  }
  return mapped;
}

function slugKey(raw, fallback) {
  const s = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return s || fallback;
}

function replaceFormFields(db, formId, fields) {
  db.prepare('DELETE FROM form_fields WHERE form_id = ?').run(formId);
  const ins = db.prepare(`
    INSERT INTO form_fields (form_id, field_key, label, field_type, required, placeholder, options_json, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const used = new Set();
  fields.slice(0, 40).forEach((raw, i) => {
    const f = normalizeFieldInput(raw, i);
    let key = slugKey(f.field_key || f.label, `field_${i + 1}`);
    let n = 2;
    while (used.has(key)) {
      key = `${slugKey(f.field_key || f.label, `field_${i + 1}`)}_${n}`;
      n += 1;
    }
    used.add(key);
    const type = normalizeFieldType(f.field_type);
    const options = Array.isArray(f.options) ? JSON.stringify(f.options.slice(0, 50).map(String)) : null;
    ins.run(
      formId,
      key,
      String(f.label || key).slice(0, 120),
      type,
      f.required ? 1 : 0,
      String(f.placeholder || '').slice(0, 200),
      options,
      Number.isFinite(Number(f.sort_order)) ? Number(f.sort_order) : i
    );
  });
}

/** saveForm(db, leadId, formId, patch) — formId may be null (first form). */
function saveForm(db, leadId, formIdOrPatch = null, maybePatch = undefined) {
  ensureTables(db);
  let formId = null;
  let patch = {};
  if (maybePatch !== undefined) {
    formId = formIdOrPatch != null ? Number(formIdOrPatch) : null;
    patch = maybePatch || {};
  } else if (formIdOrPatch && typeof formIdOrPatch === 'object' && !Array.isArray(formIdOrPatch)) {
    patch = formIdOrPatch;
    formId = patch.id != null ? Number(patch.id) : null;
  } else if (formIdOrPatch != null) {
    formId = Number(formIdOrPatch);
  }

  let row;
  if (formId != null && Number.isFinite(formId)) {
    row = getFormRowById(db, leadId, formId);
    if (!row) throw fail('NOT_FOUND', 'Form not found', 404);
  } else {
    row = ensureDefaultForm(db, leadId, patch.notify_email);
  }

  const name = patch.name != null ? String(patch.name).trim().slice(0, 120) || row.name : row.name;
  const title = patch.title != null ? String(patch.title).slice(0, 160) : row.title;
  const intro = patch.intro != null ? String(patch.intro).slice(0, 2000) : row.intro;
  const submit_label = patch.submit_label != null ? String(patch.submit_label).slice(0, 80) : row.submit_label;
  const success_message = patch.success_message != null
    ? String(patch.success_message).slice(0, 500)
    : row.success_message;
  const notify_email = patch.notify_email != null
    ? String(patch.notify_email).trim().slice(0, 254)
    : row.notify_email;
  const embedFlag = patch.embed_enabled != null
    ? patch.embed_enabled
    : (patch.embed_on_page != null ? patch.embed_on_page : null);
  const embed_enabled = embedFlag != null
    ? (coerceBool(embedFlag, true) ? 1 : 0)
    : (row.embed_enabled == null ? 1 : (row.embed_enabled ? 1 : 0));
  const navFlag = patch.add_to_nav != null
    ? patch.add_to_nav
    : (patch.nav_visible != null ? patch.nav_visible
      : (patch.navVisible != null ? patch.navVisible : null));
  const add_to_nav = navFlag != null
    ? (coerceBool(navFlag, false) ? 1 : 0)
    : (row.add_to_nav == null ? 0 : (row.add_to_nav ? 1 : 0));
  const target_page_slug = patch.target_page_slug != null
    ? (String(patch.target_page_slug).trim().slice(0, 80) || 'contact')
    : (String(row.target_page_slug || 'contact').trim() || 'contact');
  const sort_order = patch.sort_order != null && Number.isFinite(Number(patch.sort_order))
    ? Number(patch.sort_order)
    : (Number(row.sort_order) || 0);

  db.prepare(`
    UPDATE contact_forms SET name = ?, title = ?, intro = ?, submit_label = ?, success_message = ?,
      notify_email = ?, embed_enabled = ?, target_page_slug = ?, sort_order = ?, add_to_nav = ?,
      updated_at = datetime('now') WHERE id = ?
  `).run(
    name, title, intro, submit_label, success_message, notify_email,
    embed_enabled, target_page_slug, sort_order, add_to_nav, row.id
  );

  if (Array.isArray(patch.fields)) {
    replaceFormFields(db, row.id, patch.fields);
  }

  // Keep site embeds in sync when attachment settings change on a published form
  if (row.published) {
    try { syncSiteFormEmbeds(db, leadId); } catch (e) {
      console.warn('[contactForms] sync after save:', e.message);
    }
  }

  return getFormById(db, leadId, row.id);
}

function deleteForm(db, leadId, formId) {
  ensureTables(db);
  const row = getFormRowById(db, leadId, formId);
  if (!row) throw fail('NOT_FOUND', 'Form not found', 404);
  const remaining = listFormRows(db, leadId);
  if (remaining.length <= 1) {
    throw fail('LAST_FORM', 'Keep at least one form — unpublish or edit instead of deleting the last one.', 400);
  }
  db.prepare('DELETE FROM form_fields WHERE form_id = ?').run(row.id);
  db.prepare('DELETE FROM form_submissions WHERE form_id = ?').run(row.id);
  db.prepare('DELETE FROM contact_forms WHERE id = ?').run(row.id);
  try { syncSiteFormEmbeds(db, leadId); } catch (e) {
    console.warn('[contactForms] sync after delete:', e.message);
  }
  return { deleted: row.id, forms: listFormsForLead(db, leadId) };
}

/** Public tokens are `{workspaceId}_{random}` so submit can resolve the workspace DB. */
function makePublicToken(workspaceId) {
  return `${Number(workspaceId)}_${crypto.randomBytes(18).toString('base64url')}`;
}

function parseWorkspaceFromToken(token) {
  const m = String(token || '').match(/^(\d+)_([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const workspaceId = Number(m[1]);
  return Number.isInteger(workspaceId) && workspaceId > 0 ? workspaceId : null;
}

/** publishForm(db, leadId, formId, opts) or publishForm(db, leadId, opts). */
function publishForm(db, leadId, formIdOrOpts = null, maybeOpts = undefined) {
  ensureTables(db);
  let formId = null;
  let opts = {};
  if (maybeOpts !== undefined) {
    formId = formIdOrOpts != null ? Number(formIdOrOpts) : null;
    opts = maybeOpts || {};
  } else if (formIdOrOpts && typeof formIdOrOpts === 'object' && !Array.isArray(formIdOrOpts)) {
    opts = formIdOrOpts;
    formId = opts.formId != null ? Number(opts.formId) : null;
  } else if (formIdOrOpts != null) {
    formId = Number(formIdOrOpts);
  }

  let row;
  if (formId != null && Number.isFinite(formId)) {
    row = getFormRowById(db, leadId, formId);
    if (!row) throw fail('NOT_FOUND', 'Form not found', 404);
  } else {
    row = ensureDefaultForm(db, leadId);
  }

  const workspaceId = opts.workspaceId;
  let token = row.public_token;
  if (!token || (workspaceId && !String(token).startsWith(`${Number(workspaceId)}_`))) {
    if (!workspaceId) throw fail('INVALID', 'workspaceId required to publish form');
    token = makePublicToken(workspaceId);
  }

  if (opts.target_page_slug != null) {
    const slug = String(opts.target_page_slug).trim().slice(0, 80) || 'contact';
    db.prepare('UPDATE contact_forms SET target_page_slug = ? WHERE id = ?').run(slug, row.id);
    row.target_page_slug = slug;
  }

  let embedEnabled = row.embed_enabled == null ? 1 : (row.embed_enabled ? 1 : 0);
  if (opts.embed_on_page != null) embedEnabled = coerceBool(opts.embed_on_page, true) ? 1 : 0;
  else if (opts.embed_enabled != null) embedEnabled = coerceBool(opts.embed_enabled, true) ? 1 : 0;
  else if (opts.toSite === true) embedEnabled = 1;
  else if (opts.toSite === false) embedEnabled = 0;

  const attach = !!embedEnabled;
  db.prepare(`
    UPDATE contact_forms SET public_token = ?, published = 1, published_to_site = ?,
      embed_enabled = ?, status = 'published', updated_at = datetime('now') WHERE id = ?
  `).run(token, attach ? 1 : 0, embedEnabled, row.id);

  try { syncSiteFormEmbeds(db, leadId); } catch (e) {
    console.warn('[contactForms] publish sync:', e.message);
  }
  return getFormById(db, leadId, row.id);
}

/** Alias used by domain.materializeWebsiteExport before writing static HTML. */
function prepareSitePagesForExport(db, leadId) {
  return syncSiteFormEmbeds(db, leadId);
}

/**
 * Idempotently create + publish contact / quote / appointment forms for a site.
 * Always ensures contact. Quote/appointment only when matching pages exist.
 * missingOnly (default true): never overwrite existing forms of the same kind.
 */
function ensureSiteForms(db, leadId, {
  workspaceId,
  pages: pagesArg = null,
  missingOnly = true,
  notifyEmail = '',
} = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const lead = readLeadForForms(db, lid);
  if (!lead) throw fail('NOT_FOUND', 'Lead not found');

  let pages = pagesArg;
  if (!Array.isArray(pages)) {
    const site = db.prepare(
      'SELECT pages FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
    ).get(lid);
    if (site) {
      try { pages = JSON.parse(site.pages || '[]'); } catch { pages = []; }
    } else {
      pages = [];
    }
  }
  if (!Array.isArray(pages)) pages = [];

  // Index existing forms by kind (backfill form_kind when inferable)
  const byKind = new Map();
  for (const row of listFormRows(db, lid)) {
    let kind = row.form_kind && FORM_PRESETS[row.form_kind] ? row.form_kind : inferFormKind(row);
    if (!kind && !byKind.has('contact') && listFormRows(db, lid).length === 1) {
      kind = 'contact';
    }
    if (kind && !row.form_kind) {
      try {
        db.prepare('UPDATE contact_forms SET form_kind = ? WHERE id = ?').run(kind, row.id);
        row.form_kind = kind;
      } catch { /* ignore */ }
    }
    if (kind && !byKind.has(kind)) byKind.set(kind, row);
  }

  const kindsNeeded = ['contact'];
  if (pages.some((p) => pageMatchesKind(p, 'quote'))) kindsNeeded.push('quote');
  // Appointment companion forms are owned by the bookings module (created once at
  // attach). Never silently re-provision them when a /book page exists.
  let bookingsOwnsAppointment = false;
  try {
    const emb = db.prepare(
      "SELECT id, settings_json FROM site_module_embeds WHERE lead_id = ? AND module_type = 'bookings' LIMIT 1"
    ).get(lid);
    if (emb) bookingsOwnsAppointment = true;
  } catch { /* table may not exist yet */ }
  if (!bookingsOwnsAppointment && pages.some((p) => pageMatchesKind(p, 'appointment'))) {
    kindsNeeded.push('appointment');
  }

  const created = [];
  const published = [];
  const notify = String(notifyEmail || lead.email || '').trim();

  for (const kind of kindsNeeded) {
    const target = resolveTargetSlug(pages, kind);
    if (!target && kind !== 'contact') continue;

    let row = byKind.get(kind);
    if (row && missingOnly) {
      // Existing form — leave fields + embed_enabled alone; only publish if never published.
      if (workspaceId && (!row.published || !row.public_token)) {
        publishForm(db, lid, row.id, {
          workspaceId,
          embed_enabled: row.embed_enabled == null ? true : !!row.embed_enabled,
          target_page_slug: row.target_page_slug || target || kind,
        });
        published.push(row.id);
      }
      continue;
    }

    if (!row) {
      const preset = FORM_PRESETS[kind];
      const form = createForm(db, lid, {
        form_kind: kind,
        name: preset.name,
        title: preset.title,
        intro: preset.intro(lead.business_name),
        submit_label: preset.submit_label,
        success_message: preset.success_message,
        notify_email: notify,
        embed_enabled: 1,
        add_to_nav: 0,
        target_page_slug: target || kind,
        fields: preset.fields(),
      });
      created.push(form.id);
      row = getFormRowById(db, lid, form.id);
      byKind.set(kind, row);
    }

    if (workspaceId) {
      publishForm(db, lid, row.id, {
        workspaceId,
        embed_enabled: row.embed_enabled == null ? true : !!row.embed_enabled,
        target_page_slug: row.target_page_slug || target || kind,
      });
      published.push(row.id);
    }
  }

  let sync = { synced: false };
  try {
    sync = syncSiteFormEmbeds(db, lid);
  } catch (e) {
    console.warn('[contactForms] ensureSiteForms sync:', e.message);
  }

  return {
    leadId: lid,
    kindsNeeded,
    created,
    published,
    sync,
    forms: listFormsForLead(db, lid, notify),
  };
}

function unpublishForm(db, leadId, formId = null) {
  ensureTables(db);
  const row = formId != null ? getFormRowById(db, leadId, formId) : getFormRow(db, leadId);
  if (!row) throw fail('NOT_FOUND', 'Form not found');
  db.prepare(`
    UPDATE contact_forms SET published = 0, published_to_site = 0, status = 'draft',
      updated_at = datetime('now') WHERE id = ?
  `).run(row.id);
  try { syncSiteFormEmbeds(db, leadId); } catch (e) {
    console.warn('[contactForms] unpublish sync:', e.message);
  }
  return getFormById(db, leadId, row.id);
}

function appBaseUrl() {
  return String(process.env.APP_URL || '').replace(/\/$/, '');
}

function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formScriptTag(appUrl) {
  const base = String(appUrl || appBaseUrl()).replace(/\/$/, '');
  const src = base
    ? `${base}/js/form-embed.js?v=${FORM_SCRIPT_VER}`
    : `/js/form-embed.js?v=${FORM_SCRIPT_VER}`;
  return `<script src="${escapeAttr(src)}" defer ${SCRIPT_ATTR}="1"></script>`;
}

function embedBlockHtml(form, appUrl) {
  const base = String(appUrl || appBaseUrl()).replace(/\/$/, '');
  const token = String(form.public_token || '');
  if (!/^\d+_[A-Za-z0-9_-]+$/.test(token)) {
    return '';
  }
  // In-page mount: published sites load form-embed.js and post to the public API.
  return (
    `<div class="bitpype-form-embed" ${MANAGED_ATTR}="1" ${EMBED_TOKEN_ATTR}="${escapeAttr(token)}" ` +
    `data-bitpype-api="${escapeAttr(base)}"></div>`
  );
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function htmlHasFormToken(html, token) {
  const t = String(token || '').trim();
  if (!t) return false;
  return new RegExp(
    `${EMBED_TOKEN_ATTR}\\s*=\\s*["']${escapeRegExp(t)}["']`,
    'i'
  ).test(String(html || ''));
}

function stripManagedEmbedsFromHtml(html) {
  let s = String(html || '');
  // Managed wrapper divs (with or without nested iframe / empty JS mounts)
  s = s.replace(
    new RegExp(
      `<div\\b[^>]*\\b${MANAGED_ATTR}\\s*=\\s*["']?1["']?[^>]*>[\\s\\S]*?<\\/div>`,
      'gi'
    ),
    ''
  );
  s = s.replace(
    new RegExp(
      `<div\\b[^>]*\\b${MANAGED_ATTR}\\s*=\\s*["']?1["']?[^>]*\\/?>`,
      'gi'
    ),
    ''
  );
  // Orphaned bitpype form iframes (legacy)
  s = s.replace(
    /<iframe\b[^>]*\/embed\/form\.html[^>]*>\s*<\/iframe>/gi,
    ''
  );
  s = s.replace(/<iframe\b[^>]*\/embed\/form\.html[^>]*\/>/gi, '');
  s = s.replace(
    new RegExp(`<script\\b[^>]*\\b${SCRIPT_ATTR}\\b[^>]*>\\s*<\\/script>`, 'gi'),
    ''
  );
  s = s.replace(/<script\b[^>]*\/js\/form-embed\.js[^>]*>\s*<\/script>/gi, '');
  // Keep empty form slots (image-column replacements) for the next inject pass.
  return s;
}

/** Strip managed form embeds whose token is not in keepTokens (preserve placement). */
function stripInactiveFormEmbedsFromHtml(html, keepTokens) {
  const keep = keepTokens instanceof Set ? keepTokens : new Set(keepTokens || []);
  let s = String(html || '');
  s = s.replace(
    new RegExp(
      `<div\\b[^>]*\\b${MANAGED_ATTR}\\s*=\\s*["']?1["']?[^>]*>[\\s\\S]*?<\\/div>`,
      'gi'
    ),
    (block) => {
      const m = block.match(new RegExp(`${EMBED_TOKEN_ATTR}\\s*=\\s*["']([^"']+)["']`, 'i'));
      const tok = m && m[1] ? m[1] : '';
      if (tok && keep.has(tok)) return block;
      return '';
    }
  );
  s = s.replace(
    new RegExp(
      `<div\\b[^>]*\\b${MANAGED_ATTR}\\s*=\\s*["']?1["']?[^>]*\\/?>`,
      'gi'
    ),
    (block) => {
      const m = block.match(new RegExp(`${EMBED_TOKEN_ATTR}\\s*=\\s*["']([^"']+)["']`, 'i'));
      const tok = m && m[1] ? m[1] : '';
      if (tok && keep.has(tok)) return block;
      return '';
    }
  );
  const stillHas = [...keep].some((t) => htmlHasFormToken(s, t));
  if (!stillHas) {
    s = s.replace(/<iframe\b[^>]*\/embed\/form\.html[^>]*>\s*<\/iframe>/gi, '');
    s = s.replace(/<iframe\b[^>]*\/embed\/form\.html[^>]*\/>/gi, '');
    s = s.replace(
      new RegExp(`<script\\b[^>]*\\b${SCRIPT_ATTR}\\b[^>]*>\\s*<\\/script>`, 'gi'),
      ''
    );
    s = s.replace(/<script\b[^>]*\/js\/form-embed\.js[^>]*>\s*<\/script>/gi, '');
  }
  // Drop empty companion shells left after embed removal (and malformed unclosed panels).
  s = stripEmptyFormPanels(s);
  return s;
}

/** Remove empty .bitpype-form-panel wrappers (and broken open-tags stuck before </main>). */
function stripEmptyFormPanels(html) {
  let s = String(html || '');
  // Well-formed empty panels
  s = s.replace(
    /<div\b[^>]*\bbitpype-form-panel\b[^>]*>\s*<\/div>/gi,
    ''
  );
  // Empty panels that only contain whitespace / comments
  s = s.replace(
    /<div\b[^>]*\bbitpype-form-panel\b[^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<\/div>/gi,
    ''
  );
  // Malformed: open panel tag immediately followed by </main> / </body> / </section> (missing </div>)
  s = s.replace(
    /<div\b[^>]*\bbitpype-form-panel\b[^>]*>\s*(?=<\/(?:main|body|section|div)\b)/gi,
    ''
  );
  // Orphan empty form slots (image-column placeholders with no embed inside)
  s = s.replace(
    /<div\b[^>]*\bdata-bitpype-form-slot\b[^>]*>\s*<\/div>/gi,
    ''
  );
  return s;
}

function pagesHaveFormToken(pages, token) {
  const want = String(token || '').trim();
  if (!want) return false;
  try {
    const scan = require('../src/pageContentScan');
    if (scan.collectTypedTokens(pages, { module: false, form: true }).has(want)) return true;
    return scan.pagesBlobHas(pages, (blob, ctx) => {
      if (ctx && ctx.kind === 'cell.widget' && ctx.widget) {
        const w = ctx.widget;
        const wt = String(w.type || '').toLowerCase();
        if (wt === 'form' || wt === 'bitpype_form') {
          return String(w.form_token || w.formToken || '').trim() === want;
        }
      }
      return htmlHasFormToken(blob, want);
    });
  } catch {
    for (const page of pages || []) {
      if (typeof page.html === 'string' && htmlHasFormToken(page.html, want)) return true;
      if (Array.isArray(page.sections)) {
        for (const sec of page.sections) {
          if (!sec || !sec.content) continue;
          const c = sec.content;
          if (typeof c.html === 'string' && htmlHasFormToken(c.html, want)) return true;
          if (typeof c.bitpype_embed_html === 'string' && htmlHasFormToken(c.bitpype_embed_html, want)) {
            return true;
          }
          const cells = Array.isArray(c.cells) ? c.cells : [];
          for (const cell of cells) {
            if (!cell) continue;
            if (typeof cell.html === 'string' && htmlHasFormToken(cell.html, want)) return true;
            if (cell.widget) {
              const tok = String(cell.widget.form_token || cell.widget.formToken || '').trim();
              if (tok === want) return true;
            }
          }
          const secType = String(sec.type || '').toLowerCase();
          if (secType === 'form' || secType === 'bitpype_form' || secType === 'contact_form') {
            const tok = String(c.form_token || c.bitpype_form_token || '').trim();
            if (tok && tok === want) return true;
          }
        }
      }
    }
    return false;
  }
}

/** Strip raw `<form>` tags from freeform / html section content (never from contact_form module). */
function stripFormsFromHtml(html) {
  let s = String(html || '');
  let stripped = 0;
  s = s.replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, () => {
    stripped += 1;
    return '';
  });
  s = s.replace(/<\/?form\b[^>]*\/?>/gi, () => {
    stripped += 1;
    return '';
  });
  return { html: s, stripped };
}

function stripFormsInCell(cell) {
  if (!cell || typeof cell !== 'object') return { cell, stripped: 0 };
  let stripped = 0;
  const next = Object.assign({}, cell);
  if (typeof next.html === 'string' && /<form\b/i.test(next.html)) {
    const r = stripFormsFromHtml(next.html);
    next.html = r.html;
    stripped += r.stripped;
  }
  if (typeof next.body === 'string' && /<form\b/i.test(next.body)) {
    const r = stripFormsFromHtml(next.body);
    next.body = r.html;
    stripped += r.stripped;
  }
  return { cell: next, stripped };
}

function stripFormsInSection(sec) {
  if (!sec || typeof sec !== 'object') return { section: sec, stripped: 0 };
  const type = String(sec.type || '').toLowerCase();
  // Native contact_form / bitpype_form modules are allowed — only strip hand-rolled HTML.
  if (type === 'contact_form' || type === 'form' || type === 'bitpype_form') {
    return { section: sec, stripped: 0 };
  }
  let stripped = 0;
  const next = Object.assign({}, sec);
  if (next.content && typeof next.content === 'object') {
    const c = Object.assign({}, next.content);
    if (typeof c.html === 'string' && /<form\b/i.test(c.html)) {
      const r = stripFormsFromHtml(c.html);
      c.html = r.html;
      stripped += r.stripped;
    }
    if (Array.isArray(c.cells)) {
      c.cells = c.cells.map((cell) => {
        const out = stripFormsInCell(cell);
        stripped += out.stripped;
        return out.cell;
      });
    }
    next.content = c;
  }
  return { section: next, stripped };
}

/**
 * Remove hand-rolled `<form>` from page.html and html/columns section content.
 * Returns { pages, stripped, warnings }.
 */
function stripHandRolledFormsFromPages(pages) {
  let stripped = 0;
  const out = (Array.isArray(pages) ? pages : []).map((page) => {
    if (!page || typeof page !== 'object') return page;
    const next = Object.assign({}, page);
    if (typeof next.html === 'string' && /<form\b/i.test(next.html)) {
      const r = stripFormsFromHtml(next.html);
      next.html = r.html;
      stripped += r.stripped;
    }
    if (Array.isArray(next.sections)) {
      next.sections = next.sections.map((sec) => {
        const r = stripFormsInSection(sec);
        stripped += r.stripped;
        return r.section;
      });
    }
    return next;
  });
  return {
    pages: out,
    stripped,
    warnings: stripped > 0 ? [HAND_ROLLED_FORM_WARNING] : [],
  };
}

function inferWorkspaceId(db, leadId, hint) {
  if (hint != null && Number.isFinite(Number(hint)) && Number(hint) > 0) return Number(hint);
  try {
    const rows = listFormRows(db, leadId);
    for (const row of rows || []) {
      const ws = parseWorkspaceFromToken(row.public_token);
      if (ws) return ws;
    }
  } catch { /* optional */ }
  return 1;
}

/**
 * Resolve form / bitpype_form sections to a published form_token (+ api_base).
 * Agents may pass content.formId or content.form_token.
 */
function resolveFormSections(db, leadId, pages, opts = {}) {
  ensureTables(db);
  const base = String(opts.appUrl || appBaseUrl()).replace(/\/$/, '');
  const workspaceId = inferWorkspaceId(db, leadId, opts.workspaceId);
  let resolved = 0;
  const out = (Array.isArray(pages) ? pages : []).map((page) => {
    if (!page || !Array.isArray(page.sections)) return page;
    const sections = page.sections.map((sec) => {
      if (!sec || typeof sec !== 'object') return sec;
      const type = String(sec.type || '').toLowerCase();
      if (type !== 'form' && type !== 'bitpype_form') return sec;
      const c = Object.assign({}, sec.content || {});
      let row = null;
      const formId = c.formId != null ? Number(c.formId)
        : (c.form_id != null ? Number(c.form_id) : null);
      if (Number.isInteger(formId) && formId > 0) {
        row = getFormRowById(db, Number(leadId), formId);
      }
      const tokenHint = String(c.form_token || c.bitpype_form_token || c.formToken || '').trim();
      if (!row && tokenHint) {
        row = db.prepare(
          'SELECT * FROM contact_forms WHERE lead_id = ? AND public_token = ?'
        ).get(Number(leadId), tokenHint);
      }
      if (!row) {
        const list = listFormRows(db, Number(leadId));
        row = (list && list[0]) || null;
      }
      if (!row) return sec;
      if (!row.public_token || !row.published) {
        try {
          publishForm(db, Number(leadId), row.id, {
            workspaceId,
            embed_enabled: row.embed_enabled == null ? 1 : row.embed_enabled,
            toSite: false,
          });
          row = getFormRowById(db, Number(leadId), row.id);
        } catch (e) {
          console.warn('[contactForms] resolveFormSections publish:', e.message);
        }
      }
      if (!row || !row.public_token) return sec;
      c.form_id = row.id;
      c.formId = row.id;
      c.form_token = row.public_token;
      c.bitpype_form_token = row.public_token;
      if (base) {
        c.api_base = base;
        c.bitpype_api = base;
      }
      resolved += 1;
      return Object.assign({}, sec, { type: 'bitpype_form', content: c });
    });
    return Object.assign({}, page, { sections });
  });
  return { pages: out, resolved };
}

/**
 * Guardrail used by website.edit / design.deliver / design.saveWebsite:
 * strip hand-rolled forms, then resolve form/bitpype_form section refs.
 */
function sanitizeAgentPages(db, leadId, pages, opts = {}) {
  const stripped = stripHandRolledFormsFromPages(pages);
  let next = stripped.pages;
  let resolved = 0;
  if (leadId != null) {
    try {
      const r = resolveFormSections(db, leadId, next, opts);
      next = r.pages;
      resolved = r.resolved || 0;
    } catch (e) {
      console.warn('[contactForms] resolveFormSections:', e.message);
    }
  }
  return {
    pages: next,
    stripped: stripped.stripped,
    resolved,
    warnings: stripped.warnings.slice(),
  };
}

function ensureFormEmbedScript(html, appUrl) {
  const tag = formScriptTag(appUrl);
  if (!tag) return String(html || '');
  let s = String(html || '');
  s = s.replace(
    new RegExp(`<script\\b[^>]*\\b${SCRIPT_ATTR}\\b[^>]*>\\s*<\\/script>`, 'gi'),
    ''
  );
  s = s.replace(/<script\b[^>]*\/js\/form-embed\.js[^>]*>\s*<\/script>/gi, '');
  if (/<\/body>/i.test(s)) return s.replace(/<\/body>/i, `${tag}\n</body>`);
  return `${s}\n${tag}`;
}

function normalizeSlug(slug) {
  try {
    const eng = require('../src/websiteEngine');
    if (typeof eng.normalizeRoute === 'function') return eng.normalizeRoute(slug);
  } catch { /* fall through */ }
  return String(slug || '')
    .trim()
    .toLowerCase()
    .replace(/^\//, '')
    .replace(/\.html$/i, '')
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'index';
}

function findPageIndex(pages, slug) {
  const want = normalizeSlug(slug || 'contact');
  let idx = pages.findIndex((p) => normalizeSlug(p && p.slug) === want);
  if (idx >= 0) return idx;
  if (want === 'contact') {
    idx = pages.findIndex((p) => {
      const s = normalizeSlug(p && p.slug);
      const t = String((p && p.title) || '').toLowerCase();
      if (s.includes('contact') || t.includes('contact')) return true;
      const sections = Array.isArray(p.sections) ? p.sections : [];
      return sections.some((sec) => sec && sec.type === 'contact_form');
    });
    if (idx >= 0) return idx;
  }
  if (want === 'home' || want === 'index') {
    idx = pages.findIndex((p) => {
      const s = normalizeSlug(p && p.slug);
      return s === 'home' || s === 'index' || s === '';
    });
    if (idx >= 0) return idx;
    return 0;
  }
  return -1;
}

function scanOpenTag(html, from, tag) {
  const re = new RegExp(`<${tag}\\b`, 'ig');
  re.lastIndex = Math.max(0, from || 0);
  const m = re.exec(html);
  if (!m || m.index < (from || 0)) return null;
  let quote = null;
  for (let i = m.index + m[0].length; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') {
      const selfClosing = html[i - 1] === '/';
      return {
        start: m.index,
        openEnd: i + 1,
        attrs: html.slice(m.index + m[0].length, selfClosing ? i - 1 : i),
        selfClosing,
      };
    }
  }
  return null;
}

function findElement(html, tag, from) {
  const open = scanOpenTag(html, from || 0, tag);
  if (!open) return null;
  if (open.selfClosing) {
    return {
      start: open.start,
      openEnd: open.openEnd,
      closeStart: open.openEnd,
      end: open.openEnd,
      attrs: open.attrs,
    };
  }
  let depth = 1;
  let i = open.openEnd;
  const closeRe = new RegExp(`</${tag}\\s*>`, 'ig');
  while (i < html.length && depth > 0) {
    const nextOpen = scanOpenTag(html, i, tag);
    closeRe.lastIndex = i;
    const nextClose = closeRe.exec(html);
    if (!nextClose) return null;
    if (nextOpen && nextOpen.start < nextClose.index) {
      depth += 1;
      i = nextOpen.openEnd;
    } else {
      depth -= 1;
      if (depth === 0) {
        return {
          start: open.start,
          openEnd: open.openEnd,
          closeStart: nextClose.index,
          end: nextClose.index + nextClose[0].length,
          attrs: open.attrs,
        };
      }
      i = nextClose.index + nextClose[0].length;
    }
  }
  return null;
}

function findElementByClass(html, tag, className) {
  const want = String(className || '').toLowerCase();
  let from = 0;
  while (from < html.length) {
    const el = findElement(html, tag, from);
    if (!el) return null;
    const cls = String(el.attrs || '');
    const m = cls.match(/\bclass\s*=\s*["']([^"']*)["']/i);
    const classes = m ? m[1].toLowerCase().split(/\s+/) : [];
    if (classes.includes(want)) return el;
    from = el.openEnd;
  }
  return null;
}

function insertBeforeClose(html, el, block) {
  if (!el || el.closeStart == null) return null;
  return html.slice(0, el.closeStart) + block + html.slice(el.closeStart);
}

function findSplitMediaFigure(html) {
  const split = findElementByClass(html, 'div', 'split');
  if (!split) return null;
  const inner = html.slice(split.openEnd, split.closeStart);
  // Prefer a <figure> that holds an <img> (the contact hero photo column).
  let from = 0;
  while (from < inner.length) {
    const fig = findElement(inner, 'figure', from);
    if (!fig) break;
    const body = inner.slice(fig.openEnd, fig.closeStart);
    if (/<img\b/i.test(body)) {
      return {
        start: split.openEnd + fig.start,
        end: split.openEnd + fig.end,
        split,
      };
    }
    from = fig.openEnd;
  }
  // Fallback: first non-contact-card child that is a media wrapper with an img.
  from = 0;
  while (from < inner.length) {
    const el = findElement(inner, 'div', from);
    if (!el) break;
    const cls = String(el.attrs || '');
    const m = cls.match(/\bclass\s*=\s*["']([^"']*)["']/i);
    const classes = m ? m[1].toLowerCase().split(/\s+/) : [];
    if (!classes.includes('contact-card')) {
      const body = inner.slice(el.openEnd, el.closeStart);
      if (/<img\b/i.test(body)) {
        return {
          start: split.openEnd + el.start,
          end: split.openEnd + el.end,
          split,
        };
      }
    }
    from = el.openEnd;
  }
  return null;
}

function slotName(attrs) {
  const m = String(attrs || '').match(/\bdata-bitpype-form-slot\s*=\s*["']([^"']*)["']/i);
  return m ? String(m[1] || '').trim().toLowerCase() : '';
}

/**
 * Find a form slot on the page. Prefers an empty slot matching hint
 * (form_kind / target slug like quote|appointment|contact), then any empty slot.
 */
function findFormSlot(html, hint) {
  const want = String(hint || '').trim().toLowerCase();
  const slots = [];
  let from = 0;
  while (from < html.length) {
    const el = findElement(html, 'div', from);
    if (!el) break;
    if (/\bdata-bitpype-form-slot\s*=/i.test(el.attrs || '')) {
      const inner = html.slice(el.openEnd, el.closeStart);
      const empty = !/\bdata-bitpype-form-embed\s*=/i.test(inner)
        && !/\bdata-bitpype-managed\s*=/i.test(inner);
      slots.push({ el, name: slotName(el.attrs), empty });
    }
    from = el.openEnd;
  }
  if (!slots.length) return null;
  if (want) {
    const named = slots.find((s) => s.empty && (s.name === want || s.name.includes(want)));
    if (named) return named.el;
  }
  const empty = slots.find((s) => s.empty);
  return (empty || slots[0]).el;
}

function formPanelHtml(block, className, slotHint) {
  const cls = String(className || 'contact-card bitpype-form-panel').trim() || 'contact-card bitpype-form-panel';
  const hint = String(slotHint || '1').trim() || '1';
  return (
    `<div class="${escapeAttr(cls)}" data-bitpype-form-slot="${escapeAttr(hint)}">` +
    `${block}` +
    `</div>`
  );
}

function elementClasses(attrs) {
  const m = String(attrs || '').match(/\bclass\s*=\s*["']([^"']*)["']/i);
  return m ? m[1].toLowerCase().split(/\s+/).filter(Boolean) : [];
}

/** Top-level card children inside a two-up grid/split on any form target page. */
function listGridCards(html, grid) {
  const inner = html.slice(grid.openEnd, grid.closeStart);
  const out = [];
  let from = 0;
  while (from < inner.length) {
    const nextTag = inner.slice(from).search(/<\/?[a-zA-Z]/);
    if (nextTag < 0) break;
    from += nextTag;
    if (inner.slice(from, from + 2) === '</') break;
    const open = scanOpenTag(inner, from, 'div');
    if (!open || open.start !== from) {
      from += 1;
      continue;
    }
    const el = findElement(inner, 'div', from);
    if (!el) break;
    const classes = elementClasses(el.attrs);
    const text = inner.slice(el.openEnd, el.closeStart);
    out.push({
      start: grid.openEnd + el.start,
      end: grid.openEnd + el.end,
      classes,
      text,
      panelClass: classes.includes('info')
        ? 'info bitpype-form-panel'
        : (classes.includes('contact-card')
          ? 'contact-card bitpype-form-panel'
          : `${classes.join(' ')} bitpype-form-panel`.trim()),
    });
    from = el.end;
  }
  return out;
}

function findPageFormGrid(html) {
  // Page HTML is already the form's target page — any two-up grid is fair game
  // (contact, quote, appointment, custom slugs).
  const prefer = ['contact-grid', 'info-grid', 'quote-grid', 'form-grid', 'grid', 'split', 'cards'];
  let from = 0;
  const found = [];
  while (from < html.length) {
    const el = findElement(html, 'div', from);
    if (!el) break;
    const classes = elementClasses(el.attrs);
    if (classes.some((c) => prefer.includes(c))) found.push(el);
    from = el.openEnd;
  }
  for (const grid of found) {
    const cards = listGridCards(html, grid);
    if (cards.length >= 2) return { grid, cards };
  }
  return null;
}

/**
 * Prefer replacing a teaser/"use the form" card (or the non-NAP column) in a
 * two-up layout so the live form sits in the designed column — not dumped
 * flush-left under </main>. Works for contact, quote, appointment, etc.
 */
function findFormTeaserCard(html) {
  const pack = findPageFormGrid(html);
  if (!pack) return null;
  const { cards } = pack;
  const teaserRe = /request (an )?estimate|use the (request )?form|contact form|quote form|booking form|appointment form|send (us )?(a )?request|fill out|get (a )?quote|message us|book (online|now|a)|schedule (online|now|a)|request (a )?callback/i;
  let pick = cards.find((c) => teaserRe.test(c.text));
  if (!pick) {
    const napRe = /\baddress\b|\b\d{1,5}\s+[A-Za-z].{0,40}\b(rd|st|ave|ln|dr|road|street|blvd)\b/i;
    const nonNap = cards.filter((c) => !napRe.test(c.text));
    pick = nonNap[nonNap.length - 1] || cards[cards.length - 1];
  }
  return pick || null;
}

function injectHtmlEmbed(pageHtml, block, opts = {}) {
  const slotHint = String(opts.slotHint || opts.formKind || opts.targetSlug || '1').trim() || '1';
  let html = String(pageHtml || '');
  const chunk = String(block || '');
  // Author / prior inject wins — same token or same form-slot kind skips a second inject.
  const token = (chunk.match(/\bdata-bitpype-form-embed\s*=\s*["']([^"']+)["']/i) || [])[1];
  if (token && htmlHasFormToken(html, token)) return html;
  if (slotHint && slotHint !== '1' && new RegExp(
    `\\bdata-bitpype-form-slot\\s*=\\s*["']${slotHint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>\\s*<div\\b[^>]*\\bdata-bitpype-form-embed\\b`,
    'i'
  ).test(html)) {
    return html;
  }
  if (!html.trim()) {
    return `<main class="bitpype-forms">${formPanelHtml(chunk, null, slotHint)}</main>`;
  }
  block = chunk;

  // Reuse a prior image/teaser-column slot after strip/resync (kind-aware).
  const slot = findFormSlot(html, slotHint);
  if (slot) {
    // Slot already holds a managed embed — keep author/prior placement.
    if (/\bdata-bitpype-form-embed\s*=/i.test(html.slice(slot.openEnd, slot.closeStart))) {
      return html;
    }
    return html.slice(0, slot.openEnd) + block + html.slice(slot.closeStart);
  }

  // Replace the split media/image column with the form (white card).
  const media = findSplitMediaFigure(html);
  if (media) {
    return html.slice(0, media.start) + formPanelHtml(block, null, slotHint) + html.slice(media.end);
  }

  // Two-up grids: replace the teaser / estimate / book / form card.
  const teaser = findFormTeaserCard(html);
  if (teaser) {
    return html.slice(0, teaser.start)
      + formPanelHtml(block, teaser.panelClass, slotHint)
      + html.slice(teaser.end);
  }

  // Else append inside an existing contact-card (under phone / location rows).
  const card = findElementByClass(html, 'div', 'contact-card');
  if (card) {
    const next = insertBeforeClose(html, card, `\n${block}\n`);
    if (next) return next;
  }

  // Prefer inside a named section (#contact / #quote / #appointment / …) .wrap
  const idRe = /<(section|div)([^>]*\bid\s*=\s*["'](contact|quote|estimate|appointment|book|booking|schedule|form)["'][^>]*)>/i;
  const named = html.match(idRe);
  if (named) {
    const tag = named[1];
    const el = findElement(html, tag, named.index);
    const wrap = el ? findElementByClass(html.slice(el.start, el.end), 'div', 'wrap') : null;
    if (wrap) {
      const absClose = el.start + wrap.closeStart;
      return html.slice(0, absClose) + formPanelHtml(block, null, slotHint) + html.slice(absClose);
    }
    const next = insertBeforeClose(html, el, formPanelHtml(block, null, slotHint));
    if (next) return next;
  }

  // Any .sec > .wrap on the page (quote/appointment pages often omit id=).
  const sec = html.match(/<section\b[^>]*>/i);
  if (sec) {
    const el = findElement(html, 'section', sec.index);
    const wrapInner = el ? findElement(html, 'div', el.openEnd) : null;
    if (wrapInner && elementClasses(wrapInner.attrs).includes('wrap')) {
      return html.slice(0, wrapInner.closeStart)
        + formPanelHtml(block, null, slotHint)
        + html.slice(wrapInner.closeStart);
    }
  }

  const mainWrap = (() => {
    const main = html.match(/<main\b[^>]*>/i);
    if (!main) return null;
    const el = findElement(html, 'main', main.index);
    if (!el) return null;
    const wrap = findElementByClass(html.slice(el.start, el.end), 'div', 'wrap');
    if (!wrap) return null;
    return { closeStart: el.start + wrap.closeStart };
  })();
  if (mainWrap) {
    return html.slice(0, mainWrap.closeStart)
      + formPanelHtml(block, null, slotHint)
      + html.slice(mainWrap.closeStart);
  }

  const wrapped = `<section class="sec"><div class="wrap">${formPanelHtml(block, null, slotHint)}</div></section>`;
  if (/<\/main>/i.test(html)) {
    return html.replace(/<\/main>/i, `${wrapped}</main>`);
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${wrapped}</body>`);
  }
  if (/<footer\b/i.test(html)) {
    return html.replace(/<footer\b/i, `${wrapped}<footer`);
  }
  return `${html}\n${wrapped}`;
}

/**
 * Inject / refresh published form embeds into the lead's website pages.
 * Removes stale managed embeds, then attaches each published+embed_enabled form
 * to its target_page_slug (default contact).
 */
function syncSiteFormEmbeds(db, leadId, { appUrl } = {}) {
  ensureTables(db);
  const site = db.prepare(
    'SELECT id, pages FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
  ).get(Number(leadId));
  if (!site) return { synced: false, reason: 'no_site' };

  let pages;
  try { pages = JSON.parse(site.pages || '[]'); } catch { return { synced: false, reason: 'bad_pages' }; }
  if (!Array.isArray(pages) || !pages.length) return { synced: false, reason: 'empty_pages' };

  const base = appUrl || appBaseUrl();
  // Bookings setting show_request_form:false → hide companion appointment panels.
  let hideBookingsCompanion = false;
  let bookingsSlug = 'book';
  try {
    const emb = db.prepare(
      "SELECT target_page_slug, settings_json FROM site_module_embeds WHERE lead_id = ? AND module_type = 'bookings' AND published = 1 LIMIT 1"
    ).get(Number(leadId));
    if (emb) {
      bookingsSlug = normalizeSlug(emb.target_page_slug || 'book') || 'book';
      let st = {};
      try { st = emb.settings_json ? JSON.parse(emb.settings_json) : {}; } catch { st = {}; }
      if (st.show_request_form === false || st.show_request_form === 0 || st.show_request_form === 'false') {
        hideBookingsCompanion = true;
      }
    }
  } catch { /* optional */ }

  const forms = listFormRows(db, leadId)
    .filter((r) => r.published && r.public_token && (r.embed_enabled == null || r.embed_enabled))
    .filter((r) => {
      if (!hideBookingsCompanion) return true;
      const kind = r.form_kind || inferFormKind(r);
      const slug = normalizeSlug(r.target_page_slug || '');
      if (kind === 'appointment' && (slug === bookingsSlug || pageMatchesKind({ slug, title: r.title }, 'appointment'))) {
        return false;
      }
      return true;
    })
    .map((r) => publicForm(r, []));
  const activeTokens = new Set(
    forms.map((f) => String(f.public_token || '').trim()).filter(Boolean)
  );

  const pageUsesSections = (page) =>
    !!(page && Array.isArray(page.sections) && page.sections.length > 0);

  // Pass 1: strip only inactive form embeds; keep placed widgets in design modules.
  for (const page of pages) {
    if (pageUsesSections(page)) {
      page.sections = page.sections
        .filter((sec) => {
          if (!(sec && sec.content && sec.content.bitpype_managed)) return true;
          const html = typeof sec.content.html === 'string' ? sec.content.html : '';
          return [...activeTokens].some((t) => htmlHasFormToken(html, t));
        })
        .map((sec) => {
          if (!sec || !sec.content) return sec;
          let next = sec;
          if (typeof sec.content.html === 'string' && /bitpype-form|form-embed\.js/i.test(sec.content.html)) {
            next = Object.assign({}, sec, {
              content: Object.assign({}, sec.content, {
                html: stripInactiveFormEmbedsFromHtml(sec.content.html, activeTokens),
              }),
            });
          }
          // contact_form sections: clear stale tokens when form is no longer active
          if (next.type === 'contact_form' && next.content) {
            const tok = String(next.content.form_token || '').trim();
            if (tok && !activeTokens.has(tok)) {
              const c = Object.assign({}, next.content);
              delete c.form_token;
              delete c.form_action;
              delete c.form_method;
              delete c.suppress_fields;
              delete c.bitpype_embed_html;
              next = Object.assign({}, next, { content: c });
            }
          }
          return next;
        });
      if (typeof page.html === 'string') delete page.html;
    } else if (typeof page.html === 'string' && page.html.trim()) {
      page.html = stripInactiveFormEmbedsFromHtml(page.html, activeTokens);
    }
  }

  // Pass 2: inject only forms that are not already present somewhere on the site.
  // Forms never invent a top-nav link. add_to_nav=true may reveal an existing
  // target page; missing targets are skipped (embed on an existing page instead).
  const byPage = new Map();
  for (const form of forms) {
    const token = String(form.public_token || '').trim();
    if (token && pagesHaveFormToken(pages, token)) continue;
    const slug = normalizeSlug(form.target_page_slug || 'contact');
    const idx = findPageIndex(pages, slug);
    if (idx < 0) continue;
    if (form.add_to_nav) {
      delete pages[idx].navVisible;
      delete pages[idx].nav_visible;
      delete pages[idx].hiddenInNav;
      delete pages[idx].hidden_in_nav;
    }
    // add_to_nav false: leave existing page navVisible alone (do not hide Contact, etc.)
    if (!byPage.has(idx)) byPage.set(idx, []);
    byPage.get(idx).push(form);
  }

  for (const [idx, pageForms] of byPage) {
    const page = pages[idx];
    const missing = pageForms.filter((f) => {
      const token = String(f.public_token || '').trim();
      return !token || !pagesHaveFormToken(pages, token);
    });
    if (!missing.length) continue;
    const blocks = missing.map((f) => embedBlockHtml(f, base)).join('\n');
    const blocksWithScript = `${blocks}\n${formScriptTag(base)}`;
    const usesSections = pageUsesSections(page);
    const hasHtml = !usesSections && typeof page.html === 'string' && page.html.trim();

    // Single write target — mirrors renderPage (sections win when non-empty).
    if (usesSections) {
      const contactSec = page.sections.find((s) => s && s.type === 'contact_form');
      if (contactSec) {
        contactSec.content = Object.assign({}, contactSec.content || {}, {
          suppress_fields: true,
          bitpype_embed_html: blocksWithScript,
        });
        const first = missing[0];
        if (first && first.public_token) {
          contactSec.content.form_token = first.public_token;
          contactSec.content.form_action = `${String(base).replace(/\/$/, '')}/api/v1/forms/public/${first.public_token}/submit`;
          contactSec.content.form_method = 'post';
          contactSec.content.embed_mode = 'js';
        }
      } else {
        // Prefer slot/teaser placement inside the main freestyle body section.
        const bodySec = page.sections.find((s) =>
          s && s.type === 'html' && typeof (s.content && s.content.html) === 'string'
          && /<main\b/i.test(s.content.html)
        ) || page.sections.find((s) => s && s.type === 'html' && s.content && typeof s.content.html === 'string');
        if (bodySec) {
          let html = bodySec.content.html;
          for (const form of missing) {
            const hint = String(form.form_kind || form.target_page_slug || 'form').trim() || 'form';
            html = injectHtmlEmbed(html, embedBlockHtml(form, base), {
              slotHint: hint,
              formKind: form.form_kind,
              targetSlug: form.target_page_slug,
            });
          }
          bodySec.content = Object.assign({}, bodySec.content, {
            html: ensureFormEmbedScript(html, base),
          });
        } else {
          const embedSec = {
            type: 'html',
            content: { html: blocksWithScript, bitpype_managed: 1 },
          };
          const footerAt = page.sections.findIndex((s) => s && s.type === 'footer');
          if (footerAt >= 0) page.sections.splice(footerAt, 0, embedSec);
          else page.sections.push(embedSec);
        }
      }
      if (typeof page.html === 'string') delete page.html;
    } else if (hasHtml) {
      let html = page.html;
      for (const form of missing) {
        const hint = String(form.form_kind || form.target_page_slug || 'form').trim() || 'form';
        html = injectHtmlEmbed(html, embedBlockHtml(form, base), {
          slotHint: hint,
          formKind: form.form_kind,
          targetSlug: form.target_page_slug,
        });
      }
      page.html = ensureFormEmbedScript(html, base);
    } else {
      page.sections = [{
        type: 'html',
        content: { html: blocksWithScript, bitpype_managed: 1 },
      }];
    }
  }

  // Ensure form script on pages that already host active embeds.
  for (const page of pages) {
    if (pageUsesSections(page)) {
      for (const sec of page.sections || []) {
        if (!sec || !sec.content || typeof sec.content.html !== 'string') continue;
        if (![...activeTokens].some((t) => htmlHasFormToken(sec.content.html, t))) continue;
        sec.content.html = ensureFormEmbedScript(sec.content.html, base);
      }
    } else if (typeof page.html === 'string' && page.html.trim()) {
      if ([...activeTokens].some((t) => htmlHasFormToken(page.html, t))) {
        page.html = ensureFormEmbedScript(page.html, base);
      }
    }
  }

  // Mark published_to_site only when the form token is actually on a page.
  const unembedded = [];
  for (const row of listFormRows(db, leadId)) {
    const token = String(row.public_token || '').trim();
    const wantsEmbed = row.published && (row.embed_enabled == null || row.embed_enabled);
    const on = token && pagesHaveFormToken(pages, token) ? 1 : 0;
    db.prepare('UPDATE contact_forms SET published_to_site = ? WHERE id = ?').run(on, row.id);
    if (wantsEmbed && !on) {
      const targetSlug = normalizeSlug(row.target_page_slug || 'contact');
      unembedded.push({
        formId: row.id,
        name: row.name,
        target_page_slug: targetSlug,
        reason: findPageIndex(pages, targetSlug) < 0 ? 'target_page_missing' : 'not_placed',
      });
    }
  }

  db.prepare("UPDATE websites SET pages = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(pages), site.id);

  return { synced: true, siteId: site.id, forms: forms.length, pages: byPage.size, unembedded };
}

/** Published forms with embed_enabled that are not present on site pages. */
function listUnembeddedForms(db, leadId) {
  ensureTables(db);
  const site = db.prepare(
    'SELECT pages FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
  ).get(Number(leadId));
  if (!site) return [];
  let pages;
  try { pages = JSON.parse(site.pages || '[]'); } catch { return []; }
  if (!Array.isArray(pages)) return [];
  const out = [];
  for (const row of listFormRows(db, leadId)) {
    if (!row.published || !(row.embed_enabled == null || row.embed_enabled)) continue;
    const token = String(row.public_token || '').trim();
    if (!token || pagesHaveFormToken(pages, token)) continue;
    const targetSlug = normalizeSlug(row.target_page_slug || 'contact');
    out.push({
      formId: row.id,
      name: row.name,
      target_page_slug: targetSlug,
      reason: findPageIndex(pages, targetSlug) < 0 ? 'target_page_missing' : 'not_placed',
    });
  }
  return out;
}

/** Legacy helper — now routes through syncSiteFormEmbeds. */
function patchSiteContactForm(db, leadId, publicToken) {
  void publicToken;
  return syncSiteFormEmbeds(db, leadId);
}

function getPublicFormByToken(db, token) {
  ensureTables(db);
  const row = db.prepare(
    'SELECT * FROM contact_forms WHERE public_token = ? AND published = 1'
  ).get(String(token || ''));
  if (!row) throw fail('NOT_FOUND', 'Form not found');
  return publicForm(row, listFields(db, row.id));
}

function validateSubmission(fields, values) {
  const out = {};
  for (const f of fields) {
    const raw = values[f.field_key];
    let val = raw == null ? '' : String(raw).trim();
    if (f.field_type === 'checkbox') {
      val = (raw === true || raw === 1 || raw === '1' || String(raw).toLowerCase() === 'on' || String(raw).toLowerCase() === 'true')
        ? 'yes' : '';
    }
    if (f.required && !val) {
      throw fail('VALIDATION', `${f.label || f.field_key} is required`);
    }
    if (f.field_type === 'email' && val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
      throw fail('VALIDATION', 'Enter a valid email');
    }
    if (val) out[f.field_key] = val.slice(0, 5000);
  }
  return out;
}

async function acceptSubmission(db, {
  token,
  values,
  workspaceId,
  planId,
  ip,
  userAgent,
  clientEmail,
} = {}) {
  ensureTables(db);
  const form = db.prepare(
    'SELECT * FROM contact_forms WHERE public_token = ? AND published = 1'
  ).get(String(token || ''));
  if (!form) throw fail('NOT_FOUND', 'Form not found');
  const fields = listFields(db, form.id).map(publicField);
  const payload = validateSubmission(fields, values || {});

  const plan = getPlan(planId);
  const ent = plan.entitlements || {};
  const encrypt = !!ent.formMuseEncrypt;
  const inbox = !!ent.formInbox;
  const routing = encrypt ? 'muse' : (inbox ? 'portal' : 'email');

  const encrypted = encrypt ? encryptPayload(payload) : null;
  const payloadJson = encrypt ? null : JSON.stringify(payload);

  const info = db.prepare(`
    INSERT INTO form_submissions (form_id, lead_id, payload_json, encrypted_payload, routing, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    form.id,
    form.lead_id,
    payloadJson,
    encrypted,
    routing,
    String(ip || '').slice(0, 80) || null,
    String(userAgent || '').slice(0, 300) || null
  );
  const submissionId = Number(info.lastInsertRowid);

  // LeadScout capture — never block the visitor; failures are retryable in portal.
  try {
    const portalContacts = require('./portalContacts');
    portalContacts.captureFromSubmission(db, {
      leadId: form.lead_id,
      formId: form.id,
      formName: form.title || form.name || 'Form',
      pageSlug: form.target_page_slug || '',
      submissionId,
      payload,
      encrypted: encrypt,
    });
  } catch (e) {
    console.warn('[contactForms] LeadScout capture failed; submission retained id=', submissionId);
  }

  const notifyTo = String(form.notify_email || clientEmail || '').trim();
  let emailResult = null;
  if (notifyTo) {
    try {
      const mailer = require('./mailer');
      const lines = Object.entries(payload).map(([k, v]) => `${k}: ${v}`);
      emailResult = await mailer.sendPlatformMail({
        to: notifyTo,
        subject: `New form submission — ${form.title || 'Contact'}`,
        title: 'New contact form message',
        paragraphs: [
          `Someone submitted your contact form (${form.title || form.name || 'Contact'}).`,
          ...lines,
        ],
        text: lines.join('\n'),
      });
    } catch (e) {
      console.warn('[contactForms] email failed:', e.message);
      // Never fail the visitor after a successful insert — Free plan has no
      // portal inbox, so a 502 would lose the only copy from their POV and
      // encourage duplicate submits. Surface emailed:false to the API.
      emailResult = { sent: false, error: e.message };
    }
  } else if (routing === 'email') {
    console.warn('[contactForms] Free/email routing with empty notify_email; submission kept id=', submissionId);
    emailResult = { sent: false, error: 'NO_NOTIFY_EMAIL' };
  }

  let museResult = null;
  if (encrypt) {
    const museRouter = require('./museRouter');
    museResult = await museRouter.routeEncryptedSubmission({
      workspaceId,
      leadId: form.lead_id,
      formId: form.id,
      submissionId,
      encryptedPayload: encrypted,
      meta: { formTitle: form.title, plan: normalizePlanId(planId) },
    });
    db.prepare(`
      UPDATE form_submissions SET muse_delivered = ?, muse_error = ? WHERE id = ?
    `).run(
      museResult && museResult.delivered ? 1 : 0,
      museResult && !museResult.delivered
        ? String(museResult.error || museResult.reason || '').slice(0, 300)
        : null,
      submissionId
    );
  }

  return {
    id: submissionId,
    routing,
    success_message: form.success_message,
    email: emailResult,
    muse: museResult,
  };
}

function listSubmissions(db, leadId, { limit = 50, offset = 0, includePayload = true, formId = null } = {}) {
  ensureTables(db);
  const forms = listFormRows(db, leadId);
  if (!forms.length) return { form: null, forms: [], submissions: [] };
  const lim = Math.min(100, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  let rows;
  if (formId != null) {
    rows = db.prepare(`
      SELECT * FROM form_submissions WHERE lead_id = ? AND form_id = ?
      ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(Number(leadId), Number(formId), lim, off);
  } else {
    rows = db.prepare(`
      SELECT * FROM form_submissions WHERE lead_id = ?
      ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(Number(leadId), lim, off);
  }

  const primary = formId != null
    ? forms.find((f) => Number(f.id) === Number(formId)) || forms[0]
    : forms[0];

  return {
    form: publicForm(primary, listFields(db, primary.id)),
    forms: forms.map((f) => publicForm(f, [])),
    submissions: rows.map((r) => publicSubmission(r, { includePayload })),
  };
}

function getSubmission(db, leadId, submissionId, { includePayload = true } = {}) {
  ensureTables(db);
  const row = db.prepare(
    'SELECT * FROM form_submissions WHERE id = ? AND lead_id = ?'
  ).get(Number(submissionId), Number(leadId));
  if (!row) throw fail('NOT_FOUND', 'Submission not found');
  return publicSubmission(row, { includePayload });
}

function publicSubmission(row, { includePayload = true } = {}) {
  let payload = null;
  if (includePayload) {
    if (row.encrypted_payload) {
      payload = decryptPayload(row.encrypted_payload);
    } else if (row.payload_json) {
      try { payload = JSON.parse(row.payload_json); } catch { payload = null; }
    }
  }
  return {
    id: row.id,
    form_id: row.form_id,
    lead_id: row.lead_id,
    routing: row.routing,
    encrypted: !!row.encrypted_payload,
    muse_delivered: !!row.muse_delivered,
    muse_error: row.muse_error || null,
    payload: includePayload ? payload : undefined,
    created_at: row.created_at,
  };
}

function embedSnippet(form, appUrl) {
  const base = String(appUrl || process.env.APP_URL || '').replace(/\/$/, '');
  if (!form || !form.public_token || !form.published) {
    return { html: '', url: null, embed_mode: 'js' };
  }
  const url = `${base}/embed/form.html?token=${encodeURIComponent(form.public_token)}`;
  const mount = embedBlockHtml(form, base);
  const html = `${mount}\n${formScriptTag(base)}`;
  return {
    html,
    url,
    embed_mode: 'js',
    script_url: `${base}/js/form-embed.js?v=${FORM_SCRIPT_VER}`,
    submitUrl: `${base}/api/v1/forms/public/${form.public_token}/submit`,
  };
}

module.exports = {
  FIELD_TYPES,
  FORM_PRESETS,
  FORM_PURPOSES,
  STRUCTURED_PURPOSES,
  HAND_ROLLED_FORM_WARNING,
  ensureTables,
  encryptPayload,
  decryptPayload,
  getFormForLead,
  getFormById,
  listFormsForLead,
  listSitePages,
  createForm,
  saveForm,
  deleteForm,
  publishForm,
  unpublishForm,
  ensureSiteForms,
  getPublicFormByToken,
  acceptSubmission,
  listSubmissions,
  getSubmission,
  embedSnippet,
  publicForm,
  publicSubmission,
  makePublicToken,
  parseWorkspaceFromToken,
  syncSiteFormEmbeds,
  prepareSitePagesForExport,
  patchSiteContactForm,
  stripManagedEmbedsFromHtml,
  embedBlockHtml,
  ensureFormEmbedScript,
  listFormRows,
  getFormRowById,
  htmlHasFormToken,
  stripInactiveFormEmbedsFromHtml,
  pagesHaveFormToken,
  normalizeFieldType,
  normalizeFieldInput,
  normalizePurpose,
  suggestFieldsForPurpose,
  isFreeTextOnlyFields,
  inferFormKind,
  listFields,
  stripHandRolledFormsFromPages,
  resolveFormSections,
  sanitizeAgentPages,
  listUnembeddedForms,
};
