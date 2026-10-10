'use strict';

// Website Scout — stdio MCP server (JSON-RPC 2.0 over stdin/stdout,
// newline-delimited). Any MCP client can launch it; the handshake does not
// require Cursor-specific fields. Runs WITHOUT Electron:
//   node src/mcp.js          (or: npm run mcp)
// DB resolution: WS_DB_PATH env var, else ~/.config/Website Scout/websitescout.db
// initialize echoes the client's protocolVersion when this server supports it.
// Every tool call is validated, redacted, and logged to activity_log (area='mcp').
//
// Tools: lead.search, lead.get, lead.qualify, lead.create, lead.update, lead.delete,
//        lead.addFact, website.create, design.create,
//        website.preview, website.edit, design.pending, design.next, design.list,
//        design.get, design.ask, design.answers, design.deliver, design.emailQuestions,
//        design.images, design.generateImage, design.openPreview, design.previewUrl, design.review, design.redesign,
//        design.improve, design.emailRedesign, design.lessons, design.agentTrigger,
//        email.compose, email.send, prospect.score, analytics.get, automation.pause
// Resource: website-scout://design/pending (same summary as design.pending)

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const {
  server: SERVER_INFO,
  protocolVersion: LATEST_PROTOCOL_VERSION,
  protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
  tools: MCP_CATALOG,
} = require('./mcpCatalog');

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function resolveDbPath() {
  if (process.env.WS_DB_PATH && process.env.WS_DB_PATH.trim()) {
    return process.env.WS_DB_PATH.trim();
  }
  // Electron's app.getPath('userData') on Linux: ~/.config/<productName>.
  // productName per package.json build config is "Website Scout".
  return path.join(os.homedir(), '.config', 'Website Scout', 'websitescout.db');
}

const DB_PATH = resolveDbPath();
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const Database = require('better-sqlite3');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Ensure schema exists (idempotent). Schema file ships with the app.
try {
  require('./leadEngine').ensureLeadColumns(db);
} catch (e) {
  process.stderr.write(`[mcp] warning: lead column migration: ${e.message}\n`);
}
try {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
} catch (e) {
  process.stderr.write(`[mcp] warning: could not apply schema.sql: ${e.message}\n`);
  try { require('./leadEngine').ensureLeadColumns(db); } catch { /* ignore */ }
}
try {
  require('./designJobs').ensureTables(db);
} catch (e) {
  process.stderr.write(`[mcp] warning: design tables: ${e.message}\n`);
}

// Seed only the minimal settings this server depends on (INSERT OR IGNORE —
// never overwrites existing values). Full seeding belongs to src/seed.js.
const MIN_SETTINGS = [
  ['automation_paused', '0'],
  ['cost.daily_budget_usd', '10'],
  ['cost.max_websites_per_day', '25'],
  ['cost.max_outreach_per_day', '200'],
  ['cost.per_1k_prompt', '0.0015'],
  ['cost.per_1k_completion', '0.002'],
  ['score.threshold_qualified', '50'],
  ['score.threshold_hot', '70'],
  ['smtp.port', '587'],
  ['smtp.secure', '0'],
  ['mail.footer', 'Reply STOP to opt out of future messages.'],
];
const seedSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of MIN_SETTINGS) seedSetting.run(k, v);

const getSetting = (key) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
};
const setSetting = (key, value) => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
};
function logActivity(area, message) {
  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(area, String(message).slice(0, 2000));
  } catch (e) {
    process.stderr.write(`[mcp] activity log failed: ${e.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Redaction (secrets must never hit the activity log or tool output)
// ---------------------------------------------------------------------------

const SECRET_PATTERN = /(api[_-]?key|password|pass(word)?|secret|token|bearer|auth|credential)/i;
function redact(value) {
  if (value == null) return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_PATTERN.test(k) ? '***' : redact(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function vInt(v, { min = -Infinity, max = Infinity, def = null } = {}) {
  if (v == null || v === '') return def;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return { __err: true };
  return n;
}
function vStr(v, { max = 500, def = '' } = {}) {
  if (v == null) return def;
  const s = String(v);
  if (s.length > max) return { __err: true };
  return s;
}
function isErr(x) { return x && typeof x === 'object' && x.__err === true; }
function requireId(v, name) {
  const n = vInt(v, { min: 1 });
  if (isErr(n) || n == null) throw argError(`${name} must be a positive integer.`);
  return n;
}
function argError(msg) { const e = new Error(msg); e.code = 'INVALID_ARGS'; return e; }

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function leadSummary(row) {
  if (!row) return null;
  let tags = row.tags;
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags); } catch { /* keep string */ }
  }
  return {
    id: row.id, business_name: row.business_name, category: row.category,
    phone: row.phone, email: row.email, website: row.website,
    address: row.address || null,
    city: row.city, state: row.state, postal_code: row.postal_code || null,
    rating: row.rating,
    review_count: row.review_count, status: row.status,
    score: row.score, qualified: !!row.qualified, tags,
    lead_group: row.lead_group || null,
    notes: row.notes || null,
    source: row.source || null,
  };
}

function runLeadEngine(fn) {
  try {
    return fn();
  } catch (e) {
    if (e && e.code === 'VALIDATION_ERROR') throw argError(e.message || 'Invalid lead input.');
    throw e;
  }
}

function scoreLabel(score) {
  const q = parseInt(getSetting('score.threshold_qualified'), 10) || 50;
  const h = parseInt(getSetting('score.threshold_hot'), 10) || 70;
  if (score >= h) return 'Hot';
  if (score >= q) return 'Qualified';
  return 'Cold';
}

function ensureNotPaused() {
  if (getSetting('automation_paused') === '1') {
    const e = new Error('Automation is PAUSED (kill switch). Resume it in the desktop app before sending.');
    e.code = 'AUTOMATION_PAUSED';
    throw e;
  }
}

function dailySentCount() {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM campaign_messages
    WHERE status = 'sent' AND date(sent_at) = date('now', 'localtime')
  `).get().c;
}

// ---------------------------------------------------------------------------
// Minimal SMTP client (stdlib only: net/tls). Used by email.send.
// ---------------------------------------------------------------------------

function smtpSend({ host, port, secure, user, pass, from, to, subject, body }) {
  return new Promise((resolve, reject) => {
    const TIMEOUT = 25000;
    let socket;
    let buffer = '';
    let stage = 0;
    let tlsUpgraded = false;

    const fail = (msg) => { clearTimeout(timer); try { socket && socket.destroy(); } catch {} reject(new Error(msg)); };
    const timer = setTimeout(() => fail('SMTP connection timed out'), TIMEOUT);

    const send = (line) => socket.write(line + '\r\n');

    const step = (code, full) => {
      // full = complete multi-line server response; lastLine = its final line.
      const lastLine = (full.trim().split('\r\n').pop() || '');
      try {
        if (stage === 0) { // greeting
          if (code !== 220) return fail(`SMTP greeting failed: ${lastLine}`);
          send(`EHLO websitescout`);
          stage = 1;
        } else if (stage === 1) { // EHLO response
          if (code !== 250) return fail(`SMTP EHLO failed: ${lastLine}`);
          // Upgrade via STARTTLS when plaintext and the server offers it.
          if (!secure && !tlsUpgraded && /STARTTLS/i.test(full)) {
            send('STARTTLS');
            stage = 2;
          } else if (user) {
            send('AUTH LOGIN');
            stage = 3;
          } else {
            send(`MAIL FROM:<${from}>`);
            stage = 4;
          }
        } else if (stage === 2) { // STARTTLS accepted
          if (code !== 220) return fail(`SMTP STARTTLS failed: ${lastLine}`);
          socket.removeAllListeners('data');
          socket = tls.connect({ socket, servername: host });
          tlsUpgraded = true;
          attach();
          send('EHLO websitescout');
          stage = 1;
        } else if (stage === 3) { // AUTH LOGIN: username?
          if (code === 334) { send(Buffer.from(user, 'utf8').toString('base64')); stage = 30; }
          else return fail(`SMTP AUTH rejected: ${lastLine}`);
        } else if (stage === 30) { // AUTH LOGIN: password?
          if (code === 334) { send(Buffer.from(pass, 'utf8').toString('base64')); stage = 31; }
          else return fail(`SMTP username rejected: ${lastLine}`);
        } else if (stage === 31) { // auth result
          if (code !== 235) return fail(`SMTP authentication failed: ${lastLine}`);
          send(`MAIL FROM:<${from}>`);
          stage = 4;
        } else if (stage === 4) { // MAIL FROM
          if (code !== 250) return fail(`SMTP MAIL FROM rejected: ${lastLine}`);
          send(`RCPT TO:<${to}>`);
          stage = 5;
        } else if (stage === 5) { // RCPT TO
          if (code !== 250 && code !== 251) return fail(`SMTP RCPT TO rejected: ${lastLine}`);
          send('DATA');
          stage = 6;
        } else if (stage === 6) { // DATA go-ahead
          if (code !== 354) return fail(`SMTP DATA rejected: ${lastLine}`);
          const msg = [
            `From: ${from}`, `To: ${to}`,
            `Subject: ${subject}`,
            'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8',
            '', body, '',
          ].join('\r\n');
          socket.write(msg + '\r\n.\r\n');
          stage = 7;
        } else if (stage === 7) { // queued
          if (code !== 250) return fail(`SMTP message rejected: ${lastLine}`);
          send('QUIT');
          clearTimeout(timer);
          resolve({ ok: true });
        }
      } catch (e) { fail(`SMTP error: ${e.message}`); }
    };

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      // Multi-line replies end with "XYZ <text>" (space after code).
      const lines = buffer.split('\r\n');
      const last = lines.filter(Boolean).pop() || '';
      const m = last.match(/^(\d{3})([ -])/);
      if (m && m[2] === ' ') {
        const code = parseInt(m[1], 10);
        const full = buffer;
        buffer = '';
        step(code, full);
      }
    };
    const attach = () => {
      socket.on('data', onData);
      socket.on('error', (e) => fail(`SMTP socket error: ${e.message}`));
    };

    try {
      socket = secure
        ? tls.connect({ host, port, servername: host })
        : net.createConnection({ host, port });
      attach();
    } catch (e) { fail(`SMTP connect failed: ${e.message}`); }
  });
}

// ---------------------------------------------------------------------------
// HTML escaping + preview rendering (deterministic, lead facts only)
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderPreviewHtml(site) {
  // Use the real engine so freeform multipage sites preview correctly.
  const engine = require('./websiteEngine');
  const pages = safeJson(site.pages, []);
  const theme = safeJson(site.theme, {});
  if (!pages.length) {
    return `<!DOCTYPE html><html><body><p>No pages.</p></body></html>`;
  }
  return engine.renderPage(engine.homePage(pages) || pages[0], pages, theme);
}

function safeJson(text, fallback) {
  try { const v = JSON.parse(text); return v == null ? fallback : v; }
  catch { return fallback; }
}

/** Strip giant base64 screenshot previews from review payloads over MCP. */
function mcpSafeReview(review) {
  if (!review || typeof review !== 'object') return review;
  const safe = { ...review };
  delete safe.screenshot_previews;
  return safe;
}

function mcpSafeJob(job) {
  if (!job || typeof job !== 'object') return job;
  if (!job.review) return job;
  return { ...job, review: mcpSafeReview(job.review) };
}

// ---------------------------------------------------------------------------
// Tool implementations — each returns {ok:true, data} or throws.
// ---------------------------------------------------------------------------

const TOOLS = {
  'lead.search': {
    description: 'Search leads by keyword, status, and minimum score.',
    schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Keyword matched against name, category, city, email' },
        status: { type: 'string', description: 'Lead status filter' },
        minScore: { type: 'integer', minimum: 0, maximum: 100 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    },
    run(args) {
      const q = vStr(args.q, { max: 200, def: '' });
      const status = vStr(args.status, { max: 40, def: '' });
      const minScore = vInt(args.minScore, { min: 0, max: 100, def: 0 });
      const limit = vInt(args.limit, { min: 1, max: 100, def: 20 });
      for (const [k, v] of [['q', q], ['status', status], ['minScore', minScore], ['limit', limit]]) {
        if (isErr(v)) throw argError(`Invalid ${k}.`);
      }
      const where = []; const params = [];
      if (q) { where.push('(business_name LIKE ? OR category LIKE ? OR city LIKE ? OR email LIKE ?)'); const like = `%${q}%`; params.push(like, like, like, like); }
      if (status) { where.push('status = ?'); params.push(status); }
      where.push('score >= ?'); params.push(minScore);
      const rows = db.prepare(
        `SELECT * FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY score DESC, id DESC LIMIT ?`
      ).all(...params, limit);
      return { ok: true, data: { count: rows.length, leads: rows.map(leadSummary) } };
    },
  },

  'lead.get': {
    description: 'Get full details for one lead, including facts and latest score.',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
    run(args) {
      const id = requireId(args.id, 'id');
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
      if (!lead) throw argError(`Lead ${id} not found.`);
      const facts = db.prepare('SELECT fact_key, value, source, confidence, claim_class FROM business_facts WHERE lead_id = ? ORDER BY id').all(id);
      const scores = db.prepare('SELECT score, breakdown, at FROM lead_scores WHERE lead_id = ? ORDER BY id DESC LIMIT 3').all(id);
      const events = db.prepare('SELECT type, detail, at FROM lead_events WHERE lead_id = ? ORDER BY id DESC LIMIT 10').all(id);
      return { ok: true, data: { lead: leadSummary(lead), facts, scores, events } };
    },
  },

  'lead.qualify': {
    description: 'Mark a lead as qualified with an optional note.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        note: { type: 'string', maxLength: 2000 },
      },
      required: ['id'],
    },
    run(args) {
      const id = requireId(args.id, 'id');
      const note = vStr(args.note, { max: 2000, def: '' });
      if (isErr(note)) throw argError('Invalid note.');
      const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(id);
      if (!lead) throw argError(`Lead ${id} not found.`);
      db.prepare(`UPDATE leads SET qualified = 1, status = 'qualified', qualification_note = ?, updated_at = datetime('now') WHERE id = ?`).run(note, id);
      db.prepare('INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)').run(id, 'qualified', note || 'Qualified via MCP');
      return { ok: true, data: { id, qualified: true } };
    },
  },

  'lead.create': {
    description: 'Create a lead. Requires business_name.',
    schema: {
      type: 'object',
      properties: {
        business_name: { type: 'string' },
        category: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        website: { type: 'string' },
        address: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        postal_code: { type: 'string' },
        country: { type: 'string' },
        description: { type: 'string' },
        notes: { type: 'string' },
        status: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        group: { type: 'string' },
        lead_group: { type: 'string' },
        source: { type: 'string' },
        rating: { type: 'number' },
        review_count: { type: 'integer' },
      },
      required: ['business_name'],
    },
    run(args) {
      const name = vStr(args.business_name, { max: 200, def: '' });
      if (isErr(name) || !String(name).trim()) throw argError('business_name is required.');
      const engine = require('./leadEngine');
      const payload = {
        business_name: String(name).trim(),
        category: args.category,
        phone: args.phone,
        email: args.email,
        website: args.website,
        address: args.address,
        city: args.city,
        state: args.state,
        postal_code: args.postal_code,
        country: args.country,
        description: args.description,
        notes: args.notes,
        status: args.status,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        group: args.group != null ? args.group : args.lead_group,
        lead_group: args.lead_group != null ? args.lead_group : args.group,
        source: args.source != null && String(args.source).trim() ? args.source : 'mcp',
        rating: args.rating,
        review_count: args.review_count,
      };
      const lead = runLeadEngine(() => engine.createLead(db, payload));
      return { ok: true, data: { lead: leadSummary(lead) } };
    },
  },

  'lead.update': {
    description: 'Partial-update an existing lead.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        business_name: { type: 'string' },
        category: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        website: { type: 'string' },
        address: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        postal_code: { type: 'string' },
        country: { type: 'string' },
        description: { type: 'string' },
        notes: { type: 'string' },
        status: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        group: { type: 'string' },
        lead_group: { type: 'string' },
        source: { type: 'string' },
        rating: { type: 'number' },
        review_count: { type: 'integer' },
      },
      required: ['id'],
    },
    run(args) {
      const id = requireId(args.id, 'id');
      const engine = require('./leadEngine');
      const patch = {};
      for (const key of [
        'business_name', 'category', 'phone', 'email', 'website', 'address',
        'city', 'state', 'postal_code', 'country', 'description', 'notes',
        'status', 'source', 'rating', 'review_count', 'lead_group', 'group',
      ]) {
        if (args[key] !== undefined) patch[key] = args[key];
      }
      if (args.tags !== undefined) {
        if (!Array.isArray(args.tags)) throw argError('tags must be an array of strings.');
        patch.tags = args.tags.map(String);
      }
      if (!Object.keys(patch).length) throw argError('Pass at least one field to update.');
      const lead = runLeadEngine(() => engine.updateLead(db, id, patch));
      if (!lead) throw argError(`Lead ${id} not found.`);
      return { ok: true, data: { lead: leadSummary(lead) } };
    },
  },

  'lead.delete': {
    description: 'Permanently delete a lead.',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
    run(args) {
      const id = requireId(args.id, 'id');
      const engine = require('./leadEngine');
      const result = runLeadEngine(() => engine.deleteLead(db, id));
      return { ok: true, data: result };
    },
  },

  'lead.addFact': {
    description: 'Add a business fact to a lead.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        fact_key: { type: 'string' },
        value: { type: 'string' },
        source: { type: 'string' },
        source_url: { type: 'string' },
        confidence: { type: 'string' },
        claim_class: { type: 'string' },
      },
      required: ['id', 'fact_key', 'value', 'source', 'claim_class'],
    },
    run(args) {
      const id = requireId(args.id, 'id');
      const fact_key = vStr(args.fact_key, { max: 200, def: '' });
      const value = vStr(args.value, { max: 80000, def: '' });
      const source = vStr(args.source, { max: 200, def: '' });
      const claim_class = vStr(args.claim_class, { max: 40, def: '' });
      for (const [k, v] of [['fact_key', fact_key], ['value', value], ['source', source], ['claim_class', claim_class]]) {
        if (isErr(v) || !String(v).trim()) throw argError(`${k} is required.`);
      }
      let source_url;
      if (args.source_url != null && String(args.source_url).trim()) {
        source_url = vStr(args.source_url, { max: 1000 });
        if (isErr(source_url)) throw argError('source_url is too long.');
      }
      let confidence;
      if (args.confidence != null && String(args.confidence).trim()) {
        confidence = vStr(args.confidence, { max: 20 });
        if (isErr(confidence)) throw argError('confidence is invalid.');
      }
      const engine = require('./leadEngine');
      const fact = runLeadEngine(() => engine.addFact(db, id, {
        fact_key: String(fact_key).trim(),
        value: String(value),
        source: String(source).trim(),
        source_url,
        confidence,
        claim_class: String(claim_class).trim(),
      }));
      return {
        ok: true,
        data: {
          id: fact.id,
          lead_id: fact.lead_id,
          fact_key: fact.fact_key,
          value: fact.value,
          source: fact.source,
          claim_class: fact.claim_class,
          confidence: fact.confidence,
        },
      };
    },
  },

  'website.create': {
    description: 'Open a website design job for the agent.',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        site_shape: { type: 'string', enum: ['landing', 'multipage'] },
        siteShape: { type: 'string', enum: ['landing', 'multipage'] },
      },
      required: ['leadId'],
    },
    run(args) {
      const leadId = requireId(args.leadId, 'leadId');
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
      if (!lead) throw argError(`Lead ${leadId} not found.`);
      const design = require('./designJobs');
      const rawShape = args.site_shape != null ? args.site_shape : args.siteShape;
      let siteShape;
      if (rawShape != null && String(rawShape).trim() !== '') {
        siteShape = design.normalizeSiteShape(rawShape);
        if (!siteShape) throw argError('site_shape must be "landing" or "multipage".');
      }
      const effectiveShape = siteShape || design.defaultSiteShape(db, leadId, 'website') || 'multipage';
      const job = design.createJob(db, {
        type: 'website',
        leadId,
        site_shape: siteShape || effectiveShape,
        title: `${lead.business_name || 'Business'} website`,
        instructions: design.defaultWebsiteInstructions(),
      });
      db.prepare('INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)')
        .run(leadId, 'site_assigned', `Design job #${job.id} assigned via MCP (agent-owned design, ${job.site_shape || 'multipage'})`);
      return { ok: true, data: { jobId: job.id, status: job.status, type: 'website', site_shape: job.site_shape } };
    },
  },

  'design.create': {
    description: 'Create any design job kind (website, logo, social, flyer, brand, other, or custom).',
    schema: {
      type: 'object',
      properties: {
        type: { type: 'string', maxLength: 40 },
        title: { type: 'string', maxLength: 200 },
        instructions: { type: 'string', maxLength: 8000 },
        leadId: { type: 'integer', minimum: 1 },
        contactEmail: { type: 'string', maxLength: 254 },
        site_shape: { type: 'string', enum: ['landing', 'multipage'] },
        siteShape: { type: 'string', enum: ['landing', 'multipage'] },
      },
      required: ['type', 'title', 'instructions'],
    },
    run(args) {
      const design = require('./designJobs');
      const type = vStr(args.type, { max: 40, def: '' });
      const title = vStr(args.title, { max: 200, def: '' });
      const instructions = vStr(args.instructions, { max: 8000, def: '' });
      if (isErr(type) || !String(type).trim()) throw argError('type is required.');
      if (isErr(title) || !String(title).trim()) throw argError('title is required.');
      if (isErr(instructions) || !String(instructions).trim()) throw argError('instructions are required.');
      let leadId;
      if (args.leadId != null && args.leadId !== '') {
        leadId = requireId(args.leadId, 'leadId');
        const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(leadId);
        if (!lead) throw argError(`Lead ${leadId} not found.`);
      }
      let contactEmail;
      if (args.contactEmail != null && String(args.contactEmail).trim()) {
        contactEmail = vStr(args.contactEmail, { max: 254 });
        if (isErr(contactEmail)) throw argError('contactEmail is too long.');
      }
      const job = design.createJob(db, {
        type: String(type).trim(),
        title: String(title).trim(),
        instructions: String(instructions).trim(),
        leadId,
        contactEmail,
        site_shape: args.site_shape != null ? args.site_shape : args.siteShape,
      });
      if (leadId && String(type).trim() === 'website') {
        db.prepare('INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)')
          .run(leadId, 'site_assigned', `Design job #${job.id} assigned via MCP design.create (${job.site_shape || 'n/a'})`);
      }
      return {
        ok: true,
        data: {
          jobId: job.id,
          id: job.id,
          status: job.status,
          type: job.type,
          site_shape: job.site_shape,
          hint: 'Job is waiting_on_agent. Claim with design.next (optional agent trigger may already have fired).',
        },
      };
    },
  },

  'website.preview': {
    description: 'Export a website to HTML and return a localhost preview URL + path.',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
    async run(args) {
      const id = requireId(args.id, 'id');
      const site = db.prepare('SELECT * FROM websites WHERE id = ?').get(id);
      if (!site) throw argError(`Website ${id} not found.`);
      const openPreviewMod = require('./openPreview');
      const engine = require('./websiteEngine');
      const pages = safeJson(site.pages, []);
      const theme = safeJson(site.theme, {});
      // Also keep legacy previews/ under the DB dir for backwards compatibility.
      const legacyDir = path.join(path.dirname(DB_PATH), 'previews', `site-${id}`);
      engine.writeStaticPages(pages, theme, legacyDir);
      db.prepare("UPDATE websites SET preview_path = ?, updated_at = datetime('now') WHERE id = ?").run(legacyDir, id);
      const preview = await openPreviewMod.previewUrlForPages(pages, theme, `site-${id}`);
      return {
        ok: true,
        data: {
          id,
          url: preview.url,
          previewPath: preview.path,
          files: preview.files || [],
        },
      };
    },
  },

  'website.edit': {
    description: 'Apply a safe structural edit to a website (theme color, business name, add section, phone). Anything else is queued as a note when AI is unavailable — the response says which.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        instruction: { type: 'string', maxLength: 2000 },
      },
      required: ['id', 'instruction'],
    },
    run(args) {
      const id = requireId(args.id, 'id');
      const instruction = vStr(args.instruction, { max: 2000, def: '' });
      if (isErr(instruction) || !instruction.trim()) throw argError('instruction must be a non-empty string (max 2000 chars).');
      const site = db.prepare('SELECT * FROM websites WHERE id = ?').get(id);
      if (!site) throw argError(`Website ${id} not found.`);
      const theme = safeJson(site.theme, {});
      const pages = safeJson(site.pages, []);
      const text = instruction.trim();
      let applied = null;

      const colorMatch = text.match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/);
      if (/primary\s*colou?r|theme\s*colou?r|brand\s*colou?r/i.test(text) && colorMatch) {
        theme.primary = colorMatch[0];
        applied = `Set primary theme color to ${colorMatch[0]}.`;
      } else if (/business name|rename/i.test(text)) {
        const m = text.match(/(?:to|as)\s+["']?([^"']{1,120})["']?$/i);
        if (!m) throw argError('Could not parse the new business name. Try: "rename business to Acme Plumbing".');
        site.name = m[1].trim();
        applied = `Renamed website to "${m[1].trim()}".`;
      } else if (/add (a |an )?section/i.test(text)) {
        const m = text.match(/section[:\s]+(.{1,1000})$/is);
        if (!m) throw argError('Could not parse the section text. Try: "add section: We offer 24/7 emergency repairs".');
        const home = pages.find((p) => p.slug === 'home') || pages[0];
        if (!home) throw argError('Website has no pages to edit.');
        home.sections = home.sections || [];
        home.sections.push({ type: 'custom', heading: '', body: m[1].trim() });
        applied = 'Added a custom section to the home page.';
      } else if (/phone/i.test(text)) {
        const m = text.match(/(\+?[\d][\d\s().-]{6,20})/);
        if (!m) throw argError('Could not parse a phone number from the instruction.');
        const contact = (pages.find((p) => p.slug === 'home') || pages[0] || {}).sections?.find((s) => s.type === 'contact');
        if (contact) contact.body = m[1].trim();
        applied = `Set contact phone to ${m[1].trim()}.`;
      }

      if (!applied) {
        // Honest fallback: queue for manual/AI editing instead of pretending.
        logActivity('mcp', `website.edit queued (no safe structural edit matched): site=${id} instruction="${text.slice(0, 200)}"`);
        return { ok: true, data: { id, applied: false, queued: true, note: 'Instruction did not match a safe structural edit; queued for manual review in the desktop app.' } };
      }

      // Snapshot current version before mutating.
      const vno = (db.prepare('SELECT COALESCE(MAX(version_no), 0) AS m FROM website_versions WHERE website_id = ?').get(id).m || 0) + 1;
      db.prepare('INSERT INTO website_versions (website_id, version_no, pages, theme, note) VALUES (?, ?, ?, ?, ?)')
        .run(id, vno, site.pages, site.theme, `Before MCP edit: ${text.slice(0, 200)}`);
      db.prepare("UPDATE websites SET name = ?, pages = ?, theme = ?, updated_at = datetime('now') WHERE id = ?")
        .run(site.name, JSON.stringify(pages), JSON.stringify(theme), id);
      return { ok: true, data: { id, applied: true, summary: applied, version: vno } };
    },
  },

  'design.pending': {
    description: 'Summary of design jobs waiting on the MCP agent.',
    schema: { type: 'object', properties: {} },
    run(args) {
      const design = require('./designJobs');
      let previewLimit = 10;
      if (args.previewLimit != null && args.previewLimit !== '') {
        previewLimit = vInt(args.previewLimit, { min: 1, max: 50, def: 10 });
        if (isErr(previewLimit)) throw argError('previewLimit must be an integer from 1 to 50.');
      }
      const summary = design.pendingAgentSummary(db, { previewLimit });
      return { ok: true, data: summary };
    },
  },

  'design.next': {
    description: 'Claim the oldest waiting_on_agent design job.',
    schema: { type: 'object', properties: {} },
    run() {
      const design = require('./designJobs');
      const job = design.claimNextAgentJob(db);
      if (!job) {
        return {
          ok: true,
          data: {
            job: null,
            message: 'No design jobs with status waiting_on_agent. Poll design.pending or design.list.',
          },
        };
      }
      return { ok: true, data: { job: mcpSafeJob(job), claimed: true, id: job.id } };
    },
  },

  'design.list': {
    description: 'List design jobs assigned to the agent.',
    schema: { type: 'object', properties: {} },
    run(args) {
      const design = require('./designJobs');
      const status = args.status == null || args.status === '' ? undefined : vStr(args.status, { max: 40 });
      if (isErr(status)) throw argError('Invalid status.');
      const limit = vInt(args.limit, { min: 1, max: 100, def: 50 });
      if (isErr(limit)) throw argError('limit must be an integer from 1 to 100.');
      const listed = design.listJobs(db, { status: status || undefined, limit, page: 1, pageSize: limit });
      return { ok: true, data: { jobs: listed.jobs, total: listed.total, page: listed.page, pageSize: listed.pageSize } };
    },
  },

  'design.get': {
    description: 'Read one design job. Be freely creative — the app does not design or restyle the work. Only verified_facts may be labeled VERIFIED for contact details.',
    schema: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] },
    run(args) {
      const design = require('./designJobs');
      const id = requireId(args.id, 'id');
      return { ok: true, data: { job: mcpSafeJob(design.getJob(db, id, { markInProgress: true })) } };
    },
  },

  'design.ask': {
    description: 'Post a clarifying question.',
    schema: { type: 'object', properties: {}, required: ['id', 'question'] },
    run(args) {
      const design = require('./designJobs');
      const id = requireId(args.id, 'id');
      const question = vStr(args.question, { max: 2000, def: '' });
      if (isErr(question) || !String(question).trim()) throw argError('question is required (max 2000 chars).');
      return { ok: true, data: design.askQuestion(db, id, question) };
    },
  },

  'design.answers': {
    description: 'Read questions and user answers.',
    schema: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] },
    run(args) {
      const design = require('./designJobs');
      const id = requireId(args.id, 'id');
      return { ok: true, data: { id, questions: design.listAnswers(db, id) } };
    },
  },

  'design.emailQuestions': {
    description: 'Queue the unanswered questions for one design job. Does not send mail.',
    schema: { type: 'object', properties: {}, required: [] },
    run(args) {
      const design = require('./designJobs');
      const raw = args.jobId != null ? args.jobId : args.id;
      const jobId = requireId(raw, 'jobId');
      const result = design.emailQuestions(db, jobId);
      return { ok: true, data: result };
    },
  },

  'design.deliver': {
    description: 'Store the agent delivery exactly (freeform HTML/CSS allowed; no template rewrite).',
    schema: { type: 'object', properties: {}, required: ['id', 'payload'] },
    async run(args) {
      const design = require('./designJobs');
      const id = requireId(args.id, 'id');
      if (!args.payload || typeof args.payload !== 'object' || Array.isArray(args.payload)) {
        throw argError('payload must be an object.');
      }
      const job = design.deliverJob(db, id, args.payload, args.claims, {
        site_shape: args.site_shape != null ? args.site_shape : args.siteShape,
      });
      const data = {
        id: job.id,
        type: job.type,
        status: job.status,
        website_id: job.website_id,
        built_by: job.built_by,
        site_shape: job.site_shape,
      };
      if (job.type === 'website') {
        try {
          const preview = await design.previewUrl(db, id, { open: false });
          data.previewUrl = preview.url;
          data.previewPath = preview.path;
        } catch { /* preview optional on deliver */ }
      }
      return { ok: true, data };
    },
  },

  'design.images': {
    description: 'Attach Pexels photos to a delivered website.',
    schema: { type: 'object', properties: {}, required: ['id'] },
    async run(args) {
      ensureNotPaused();
      const design = require('./designJobs');
      const id = requireId(args.id, 'id');
      let query;
      if (args.query != null && String(args.query).trim()) {
        query = vStr(args.query, { max: 120 });
        if (isErr(query)) throw argError('query is too long.');
      }
      let count;
      if (args.count != null && args.count !== '') {
        count = vInt(args.count, { min: 1, max: 6 });
        if (isErr(count) || count == null) throw argError('count must be an integer from 1 to 6.');
      }
      const result = await design.addImages(db, id, { query, count });
      return { ok: true, data: result };
    },
  },

  'design.generateImage': {
    description: 'Generate images via OpenAI Images API and attach to a design job.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        prompt: { type: 'string' },
        n: { type: 'integer' },
        size: { type: 'string' },
        quality: { type: 'string' },
        model: { type: 'string' },
      },
      required: ['id'],
    },
    async run(args) {
      ensureNotPaused();
      const design = require('./designJobs');
      const id = requireId(args.id, 'id');
      let prompt;
      if (args.prompt != null && String(args.prompt).trim()) {
        prompt = vStr(args.prompt, { max: 4000 });
        if (isErr(prompt)) throw argError('prompt is too long.');
      }
      let n;
      if (args.n != null && args.n !== '') {
        n = vInt(args.n, { min: 1, max: 4 });
        if (isErr(n) || n == null) throw argError('n must be an integer from 1 to 4.');
      }
      let size;
      if (args.size != null && String(args.size).trim()) {
        size = vStr(args.size, { max: 32 });
        if (isErr(size)) throw argError('size is invalid.');
      }
      let quality;
      if (args.quality != null && String(args.quality).trim()) {
        quality = vStr(args.quality, { max: 32 });
        if (isErr(quality)) throw argError('quality is invalid.');
      }
      let model;
      if (args.model != null && String(args.model).trim()) {
        model = vStr(args.model, { max: 120 });
        if (isErr(model)) throw argError('model is invalid.');
      }
      const result = await design.generateJobImages(db, id, { prompt, n, size, quality, model });
      return {
        ok: true,
        data: {
          id: result.id,
          count: result.count,
          model: result.model,
          prompt: result.prompt,
          paths: result.paths,
        },
      };
    },
  },

  'design.openPreview': {
    description: 'Open a website delivery in the default browser; returns path + localhost url.',
    schema: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] },
    async run(args) {
      const design = require('./designJobs');
      const id = requireId(args.id, 'id');
      const result = await design.openPreview(db, id);
      return { ok: true, data: result };
    },
  },

  'design.previewUrl': {
    description: 'Export a delivered website and return a localhost http:// preview URL for the agent.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        open: { type: 'boolean' },
      },
      required: ['id'],
    },
    async run(args) {
      const design = require('./designJobs');
      const id = requireId(args.id, 'id');
      const result = await design.previewUrl(db, id, { open: !!args.open });
      return { ok: true, data: result };
    },
  },

  'design.review': {
    description: 'Review a delivered website (QA + optional screenshots/vision). Returns redesign_instructions and improvement_instructions. No base64 over MCP.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        skipAi: { type: 'boolean' },
        skipScreenshots: { type: 'boolean' },
      },
      required: ['id'],
    },
    async run(args) {
      const design = require('./designJobs');
      const id = requireId(args.id, 'id');
      const review = await design.reviewJob(db, id, {
        skipAi: !!args.skipAi,
        skipScreenshots: !!args.skipScreenshots,
      });
      return { ok: true, data: { id, review: mcpSafeReview(review) } };
    },
  },

  'design.redesign': {
    description: 'Queue a FULL redesign (waiting_on_agent). Use design.improve for incremental polish.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        instructions: { type: 'string' },
        refresh: { type: 'boolean' },
        forceReview: { type: 'boolean' },
        skipAi: { type: 'boolean' },
      },
      required: ['id'],
    },
    async run(args) {
      const design = require('./designJobs');
      const id = requireId(args.id, 'id');
      let instructions;
      if (args.instructions != null && String(args.instructions).trim()) {
        instructions = vStr(args.instructions, { max: 8000 });
        if (isErr(instructions)) throw argError('instructions are too long.');
      }
      const job = await design.redesignJob(db, id, {
        instructions,
        refresh: args.refresh !== false,
        forceReview: !!args.forceReview,
        skipAi: !!args.skipAi,
      });
      return {
        ok: true,
        data: {
          id: job.id,
          status: job.status,
          request_kind: 'redesign',
          site_shape: job.site_shape,
          review: mcpSafeReview(job.review),
          hint: 'Job is waiting_on_agent (redesign). Claim with design.next, then revise and design.deliver.',
        },
      };
    },
  },

  'design.improve': {
    description: 'Queue INCREMENTAL improvements (waiting_on_agent). Not a full redesign.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        instructions: { type: 'string' },
        refresh: { type: 'boolean' },
        forceReview: { type: 'boolean' },
        skipAi: { type: 'boolean' },
      },
      required: ['id'],
    },
    async run(args) {
      const design = require('./designJobs');
      const id = requireId(args.id, 'id');
      let instructions;
      if (args.instructions != null && String(args.instructions).trim()) {
        instructions = vStr(args.instructions, { max: 8000 });
        if (isErr(instructions)) throw argError('instructions are too long.');
      }
      const job = await design.improveJob(db, id, {
        instructions,
        refresh: args.refresh !== false,
        forceReview: !!args.forceReview,
        skipAi: !!args.skipAi,
      });
      return {
        ok: true,
        data: {
          id: job.id,
          status: job.status,
          request_kind: 'improvements',
          site_shape: job.site_shape,
          review: mcpSafeReview(job.review),
          hint: 'Job is waiting_on_agent (improvements). Claim with design.next; apply polish only, then design.deliver.',
        },
      };
    },
  },

  'design.emailRedesign': {
    description: 'List/ingest/submit/dismiss/scan inbound email redesign or improvements requests.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'ingest', 'submit', 'dismiss', 'scan'] },
        id: { type: 'integer', minimum: 1 },
        requestId: { type: 'integer', minimum: 1 },
        jobId: { type: 'integer', minimum: 1 },
        designJobId: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        fromEmail: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        reply: { type: 'string' },
        requestKind: { type: 'string' },
        request_kind: { type: 'string' },
        force: { type: 'boolean' },
        instructions: { type: 'string' },
        status: { type: 'string' },
        pendingOnly: { type: 'boolean' },
        includeAll: { type: 'boolean' },
        limit: { type: 'integer' },
      },
      required: ['action'],
    },
    async run(args) {
      const emailRedesign = require('./emailRedesign');
      emailRedesign.ensureTables(db);
      const action = String(args.action || '').trim().toLowerCase();
      const requestIdRaw = args.id != null ? args.id : args.requestId;

      if (action === 'list') {
        const limit = vInt(args.limit, { min: 1, max: 200, def: 50 });
        if (isErr(limit)) throw argError('limit must be an integer from 1 to 200.');
        let jobId;
        if (args.jobId != null && args.jobId !== '') jobId = requireId(args.jobId, 'jobId');
        const opts = { limit, includeAll: !!args.includeAll };
        if (jobId != null) opts.jobId = jobId;
        if (args.status) opts.status = String(args.status);
        if (args.pendingOnly != null) opts.pendingOnly = !!args.pendingOnly;
        return {
          ok: true,
          data: {
            requests: emailRedesign.listEmailRedesigns(db, opts),
            dropDir: emailRedesign.resolveDropDir(db),
            note: 'No IMAP mailbox yet — use ingest, paste in the Design UI, or scan the drop folder.',
          },
        };
      }

      if (action === 'get') {
        const id = requireId(requestIdRaw, 'id');
        return { ok: true, data: { request: emailRedesign.getEmailRedesign(db, id) } };
      }

      if (action === 'ingest') {
        const body = args.body != null ? args.body : args.reply;
        if (body == null || !String(body).trim()) throw argError('body is required for ingest.');
        const bodyStr = vStr(body, { max: 12000 });
        if (isErr(bodyStr)) throw argError('body must be 12000 characters or fewer.');
        let designJobId;
        if (args.designJobId != null && args.designJobId !== '') {
          designJobId = requireId(args.designJobId, 'designJobId');
        } else if (args.jobId != null && args.jobId !== '') {
          designJobId = requireId(args.jobId, 'jobId');
        }
        let leadId;
        if (args.leadId != null && args.leadId !== '') leadId = requireId(args.leadId, 'leadId');
        const result = emailRedesign.ingestInboundEmail(db, {
          fromEmail: args.fromEmail,
          subject: args.subject,
          body: String(bodyStr),
          designJobId,
          leadId,
          source: args.source || 'inbound_hook',
          force: args.force !== false,
          requestKind: args.requestKind || args.request_kind,
        });
        if (result.skipped) {
          return {
            ok: true,
            data: {
              skipped: true,
              reason: result.reason || 'not_a_redesign_request',
              hint: 'Pass force:true or include redesign/improvements language in subject/body.',
            },
          };
        }
        return { ok: true, data: { request: result.request, skipped: false } };
      }

      if (action === 'submit') {
        const id = requireId(requestIdRaw, 'id');
        let instructions;
        if (args.instructions != null && String(args.instructions).trim()) {
          instructions = vStr(args.instructions, { max: 8000 });
          if (isErr(instructions)) throw argError('instructions are too long.');
        }
        let designJobId;
        if (args.designJobId != null && args.designJobId !== '') {
          designJobId = requireId(args.designJobId, 'designJobId');
        }
        const out = await emailRedesign.submitEmailRedesign(db, id, {
          designJobId,
          instructions,
          requestKind: args.requestKind || args.request_kind,
        });
        return {
          ok: true,
          data: {
            request: out.request,
            job: mcpSafeJob(out.job),
            hint: 'Job is waiting_on_agent. Claim with design.next (agent trigger may have fired).',
          },
        };
      }

      if (action === 'dismiss') {
        const id = requireId(requestIdRaw, 'id');
        return { ok: true, data: { request: emailRedesign.dismissEmailRedesign(db, id) } };
      }

      if (action === 'scan') {
        const scanned = emailRedesign.scanDropFolder(db);
        return { ok: true, data: scanned };
      }

      throw argError('action must be list, get, ingest, submit, dismiss, or scan.');
    },
  },

  'design.agentTrigger': {
    description: 'Read-only agent trigger file path and status. Does not fire a trigger.',
    schema: { type: 'object', properties: {} },
    run() {
      const trigger = require('./designAgentTrigger');
      return { ok: true, data: trigger.agentTriggerStatus(db) };
    },
  },

  'design.lessons': {
    description: 'Design learning: list raw events, read/clear playbook, or force distill. Lessons also appear on job briefs as brief.learned_lessons.',
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'list', 'playbook', 'clear', 'distill'],
        },
        what: { type: 'string', enum: ['all', 'playbook', 'events'] },
        jobId: { type: 'integer', minimum: 1 },
        eventType: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        force: { type: 'boolean' },
      },
    },
    async run(args = {}) {
      const learning = require('./designLearning');
      learning.ensureTables(db);
      const action = String(args.action || 'status').trim().toLowerCase();
      if (action === 'status') {
        return { ok: true, data: learning.getStatus(db) };
      }
      if (action === 'list') {
        return {
          ok: true,
          data: {
            events: learning.listEvents(db, {
              jobId: args.jobId,
              eventType: args.eventType,
              limit: args.limit,
            }),
            status: learning.getStatus(db),
          },
        };
      }
      if (action === 'playbook') {
        return {
          ok: true,
          data: {
            playbook: learning.getPlaybook(db),
            status: learning.getStatus(db),
          },
        };
      }
      if (action === 'clear') {
        const what = String(args.what || 'playbook').toLowerCase();
        if (what === 'events') return { ok: true, data: learning.clearEvents(db) };
        if (what === 'all') return { ok: true, data: learning.clearAll(db) };
        return { ok: true, data: learning.clearPlaybook(db) };
      }
      if (action === 'distill') {
        const result = await learning.maybeDistill(db, { force: !!args.force });
        return { ok: true, data: result };
      }
      throw argError('action must be status, list, playbook, clear, or distill.');
    },
  },

  'email.compose': {
    description: 'Compose a queued outreach message for a lead from a template (supports {{placeholders}}).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        templateId: { type: 'integer', minimum: 1 },
      },
      required: ['leadId', 'templateId'],
    },
    run(args) {
      const leadId = requireId(args.leadId, 'leadId');
      const templateId = requireId(args.templateId, 'templateId');
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
      if (!lead) throw argError(`Lead ${leadId} not found.`);
      if (!lead.email) throw argError(`Lead ${leadId} has no email address.`);
      const tpl = db.prepare('SELECT * FROM email_templates WHERE id = ?').get(templateId);
      if (!tpl) throw argError(`Template ${templateId} not found.`);
      const footer = getSetting('mail.footer') || '';
      const vars = {
        business_name: lead.business_name || '', name: lead.business_name || '',
        first_name: String(lead.business_name || '').split(' ')[0],
        email: lead.email || '', phone: lead.phone || '',
        city: lead.city || '', category: lead.category || '',
      };
      const render = (t) => String(t).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => (vars[k.toLowerCase()] ?? ''));
      const subject = render(tpl.subject);
      const body = render(tpl.body) + (footer ? `\n\n--\n${footer}` : '');
      let campaign = db.prepare("SELECT id FROM campaigns WHERE name = ? AND status = 'draft'").get('MCP compose');
      if (!campaign) {
        campaign = { id: db.prepare('INSERT INTO campaigns (name, template_id, status) VALUES (?, ?, ?)').run('MCP compose', templateId, 'draft').lastInsertRowid };
      }
      const r = db.prepare(
        'INSERT INTO campaign_messages (campaign_id, lead_id, to_email, subject, body, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(Number(campaign.id), leadId, lead.email, subject, body, 'queued');
      return { ok: true, data: { messageId: Number(r.lastInsertRowid), to: lead.email, subject } };
    },
  },

  'email.send': {
    description: 'Send a queued message. Respects suppression list, automation pause, and daily outreach cap.',
    schema: {
      type: 'object',
      properties: { messageId: { type: 'integer', minimum: 1 } },
      required: ['messageId'],
    },
    async run(args) {
      const messageId = requireId(args.messageId, 'messageId');
      ensureNotPaused();
      const msg = db.prepare('SELECT * FROM campaign_messages WHERE id = ?').get(messageId);
      if (!msg) throw argError(`Message ${messageId} not found.`);
      if (msg.status !== 'queued') throw argError(`Message ${messageId} is not queued (status: ${msg.status}).`);
      const suppressed = db.prepare('SELECT reason FROM suppression_list WHERE lower(email) = lower(?)').get(msg.to_email);
      if (suppressed) {
        db.prepare("UPDATE campaign_messages SET status = 'suppressed' WHERE id = ?").run(messageId);
        return { ok: true, data: { messageId, sent: false, suppressed: true, reason: suppressed.reason } };
      }
      const cap = parseInt(getSetting('cost.max_outreach_per_day'), 10) || 200;
      if (dailySentCount() >= cap) {
        const e = new Error(`Daily outreach cap reached (${cap}). Message left queued.`);
        e.code = 'CAP_REACHED';
        throw e;
      }
      const host = getSetting('smtp.host');
      const fromEmail = getSetting('smtp.from_email');
      if (!host || !fromEmail) throw argError('SMTP is not configured (smtp.host / smtp.from_email). Set it in the desktop app first.');
      const fail = (err) => {
        db.prepare("UPDATE campaign_messages SET status = 'failed', error = ? WHERE id = ?").run(String(err).slice(0, 1000), messageId);
        db.prepare('INSERT INTO email_events (message_id, type, detail) VALUES (?, ?, ?)').run(messageId, 'failed', String(err).slice(0, 500));
        const e = new Error(`SMTP send failed: ${err}`);
        e.code = 'SMTP_FAILED';
        throw e;
      };
      try {
        await smtpSend({
          host,
          port: parseInt(getSetting('smtp.port'), 10) || 587,
          secure: getSetting('smtp.secure') === '1',
          user: getSetting('smtp.user') || '',
          pass: getSetting('smtp.pass') || '',
          from: fromEmail,
          to: msg.to_email,
          subject: msg.subject,
          body: msg.body,
        });
      } catch (e) { fail(e.message); }
      db.prepare("UPDATE campaign_messages SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(messageId);
      db.prepare('INSERT INTO email_events (message_id, type) VALUES (?, ?)').run(messageId, 'sent');
      return { ok: true, data: { messageId, sent: true, to: msg.to_email } };
    },
  },

  'prospect.score': {
    description: 'Return a lead\'s score with its Qualified/Hot label from current thresholds.',
    schema: {
      type: 'object',
      properties: { leadId: { type: 'integer', minimum: 1 } },
      required: ['leadId'],
    },
    run(args) {
      const leadId = requireId(args.leadId, 'leadId');
      const lead = db.prepare('SELECT id, business_name, score, qualified FROM leads WHERE id = ?').get(leadId);
      if (!lead) throw argError(`Lead ${leadId} not found.`);
      const latest = db.prepare('SELECT score, breakdown, at FROM lead_scores WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(leadId);
      return { ok: true, data: { leadId, score: lead.score, label: scoreLabel(lead.score), qualified: !!lead.qualified, latest } };
    },
  },

  'analytics.get': {
    description: 'Dashboard stats: lead counts by status, websites, outreach today, AI spend.',
    schema: { type: 'object', properties: {} },
    run() {
      const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM leads GROUP BY status').all();
      const totalLeads = db.prepare('SELECT COUNT(*) AS c FROM leads').get().c;
      const hot = parseInt(getSetting('score.threshold_hot'), 10) || 70;
      const hotLeads = db.prepare('SELECT COUNT(*) AS c FROM leads WHERE score >= ?').get(hot).c;
      const qualified = db.prepare('SELECT COUNT(*) AS c FROM leads WHERE qualified = 1').get().c;
      const sitesByStatus = db.prepare('SELECT status, COUNT(*) AS n FROM websites GROUP BY status').all();
      const sentToday = db.prepare(`SELECT COUNT(*) AS c FROM campaign_messages WHERE status = 'sent' AND date(sent_at) = date('now', 'localtime')`).get().c;
      const queued = db.prepare(`SELECT COUNT(*) AS c FROM campaign_messages WHERE status = 'queued'`).get().c;
      const aiToday = db.prepare(`SELECT ROUND(COALESCE(SUM(cost_usd),0),4) AS c FROM ai_usage WHERE date(at) = date('now','localtime')`).get().c;
      const aiMonth = db.prepare(`SELECT ROUND(COALESCE(SUM(cost_usd),0),4) AS c FROM ai_usage WHERE strftime('%Y-%m', at) = strftime('%Y-%m','now','localtime')`).get().c;
      const design = require('./designJobs');
      const designQueue = design.pendingAgentSummary(db, { previewLimit: 5 });
      return {
        ok: true,
        data: {
          totalLeads, byStatus, qualified, hotLeads, sitesByStatus, sentToday, queued,
          aiCostTodayUsd: aiToday, aiCostMonthUsd: aiMonth,
          designJobsWaitingOnAgent: designQueue.counts.waiting_on_agent,
          designJobsQuestionsPending: designQueue.counts.questions_pending,
        },
      };
    },
  },

  'automation.pause': {
    description: 'Engage the kill switch: stop scanning, generation, campaigns, follow-ups, and AI actions.',
    schema: { type: 'object', properties: {} },
    run() {
      setSetting('automation_paused', '1');
      logActivity('automation', 'Automation PAUSED via MCP (kill switch).');
      return { ok: true, data: { paused: true } };
    },
  },
};

// App-parity tools (leads admin, websites, outreach, settings, …)
Object.assign(
  TOOLS,
  require('./mcpParityTools').createParityTools({
    db,
    vStr,
    vInt,
    requireId,
    isErr,
    argError,
    ensureNotPaused,
    leadSummary,
    mcpSafeJob,
    logActivity,
    getSetting,
    setSetting,
    runLeadEngine,
  })
);

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 transport (newline-delimited over stdio)
// ---------------------------------------------------------------------------

for (const entry of MCP_CATALOG) {
  const impl = TOOLS[entry.name];
  if (!impl || typeof impl.run !== 'function') {
    throw new Error(`MCP catalog tool ${entry.name} has no run() in mcp.js`);
  }
  impl.description = entry.description;
  impl.schema = entry.schema;
}
for (const name of Object.keys(TOOLS)) {
  if (!MCP_CATALOG.some((t) => t.name === name)) {
    throw new Error(`MCP tool ${name} is missing from src/mcpCatalog.js`);
  }
}

const DESIGN_PENDING_URI = 'website-scout://design/pending';

function toolListPayload() {
  return {
    tools: Object.entries(TOOLS).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.schema,
    })),
  };
}

function resourceListPayload() {
  return {
    resources: [{
      uri: DESIGN_PENDING_URI,
      name: 'Design jobs waiting on agent',
      description: 'JSON summary of waiting_on_agent and questions_pending jobs. Poll via resources/read or call design.pending / design.next.',
      mimeType: 'application/json',
    }],
  };
}

// A JSON-RPC notification omits `id`. The server must not reply to one —
// an error with `"id": null` makes strict clients drop the session.
function isNotification(req) {
  return !Object.prototype.hasOwnProperty.call(req, 'id');
}

// Spec name is notifications/initialized. `initialized` is the pre-prefix
// name some SDKs and hosts still send after a successful initialize.
function isInitializedNotification(method) {
  return method === 'notifications/initialized' || method === 'initialized';
}

function negotiateProtocolVersion(params) {
  const requested = params && typeof params.protocolVersion === 'string'
    ? params.protocolVersion
    : '';
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return requested;
  return LATEST_PROTOCOL_VERSION;
}

async function handleRequest(req) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request.' } };
  }

  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params && typeof req.params === 'object' && !Array.isArray(req.params))
    ? req.params
    : {};
  const notification = isNotification(req);
  const id = notification ? null : req.id;
  const result = (payload) => (notification ? null : { jsonrpc: '2.0', id, result: payload });
  const failure = (code, message) => (
    notification ? null : { jsonrpc: '2.0', id, error: { code, message } }
  );

  if (!method) return failure(-32600, 'Invalid Request: missing method.');

  try {
    if (method === 'initialize') {
      // clientInfo and capabilities are optional. Nothing host-specific is required.
      return result({
        protocolVersion: negotiateProtocolVersion(params),
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: SERVER_INFO.name, version: SERVER_INFO.version },
      });
    }
    if (isInitializedNotification(method) || method.startsWith('notifications/')) {
      return notification ? null : result({});
    }
    if (method === 'ping') return result({});
    if (method === 'tools/list') return result(toolListPayload());
    if (method === 'resources/list') return result(resourceListPayload());
    if (method === 'resources/read') {
      const uri = typeof params.uri === 'string' ? params.uri : '';
      if (uri !== DESIGN_PENDING_URI) return failure(-32602, `Unknown resource: ${uri || '(missing uri)'}`);
      const design = require('./designJobs');
      const summary = design.pendingAgentSummary(db, { previewLimit: 20 });
      return result({
        contents: [{
          uri: DESIGN_PENDING_URI,
          mimeType: 'application/json',
          text: JSON.stringify(summary, null, 2),
        }],
      });
    }
    if (method === 'tools/call') {
      const name = params.name;
      const args = (params.arguments && typeof params.arguments === 'object') ? params.arguments : {};
      const tool = TOOLS[name];
      if (!tool) return failure(-32602, `Unknown tool: ${name}`);
      const t0 = Date.now();
      let outcome;
      try {
        const res = await tool.run(args);
        outcome = res && res.ok === false ? res : { ok: true, data: (res && res.data) || {} };
      } catch (e) {
        outcome = { ok: false, error: e.message || String(e) };
      }
      const ms = Date.now() - t0;
      logActivity('mcp', `tool=${name} ok=${outcome.ok} ${ms}ms args=${JSON.stringify(redact(args)).slice(0, 500)}${outcome.ok ? '' : ' error=' + String(outcome.error).slice(0, 200)}`);
      return result({
        content: [{ type: 'text', text: JSON.stringify(outcome) }],
        isError: !outcome.ok,
      });
    }
    return failure(-32601, `Method not found: ${method}`);
  } catch (e) {
    return failure(-32603, e.message || String(e));
  }
}

function startStdioTransport() {
  // Line-oriented stdin reader. Tracks in-flight requests so the process never
  // exits (on stdin 'end') before every response has been written.
  let stdinBuffer = '';
  let pending = 0;
  let stdinEnded = false;
  function maybeExit() {
    if (stdinEnded && pending === 0) process.exit(0);
  }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    stdinBuffer += chunk;
    let idx;
    while ((idx = stdinBuffer.indexOf('\n')) >= 0) {
      const line = stdinBuffer.slice(0, idx).trim();
      stdinBuffer = stdinBuffer.slice(idx + 1);
      if (!line) continue;
      let req;
      try { req = JSON.parse(line); }
      catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
      pending++;
      Promise.resolve(handleRequest(req)).then((resp) => {
        if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
      }).finally(() => { pending--; maybeExit(); });
    }
  });
  process.stdin.on('end', () => { stdinEnded = true; maybeExit(); });
  // Safety net: never hang forever if a handler stalls.
  setInterval(() => { if (stdinEnded && pending > 0) process.stderr.write(`[mcp] waiting on ${pending} pending request(s)\n`); }, 15000).unref();
  process.stderr.write(`[mcp] website-scout-mcp ready (db: ${DB_PATH})\n`);
}

module.exports = {
  handleRequest,
  DB_PATH,
  SERVER_INFO,
  startStdioTransport,
};

if (require.main === module) {
  startStdioTransport();
}
