'use strict';

/**
 * Site Chatbot module (Standard + Premium).
 *
 * Boundary (enforced):
 * - Visitor traffic uses public token APIs only (no workspace/admin tokens).
 * - Client agent replies via portal/client-scoped MCP (chatbot.* on lead tokens).
 * - Module actions use public module/form endpoints — never admin MCP (lead.*, design.*, …).
 * - Escalations + knowledge CRUD go through portal APIs / client entitlements.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const CHAT_SCRIPT_VER = 'chat5';
const CHAT_ATTR = 'data-bitpype-chat';
const CHAT_TOKEN_ATTR = 'data-bitpype-chat-token';
const CHAT_SCRIPT_ATTR = 'data-bitpype-chat-script';

const DEFAULT_SETTINGS = {
  greeting: 'Hi! How can we help?',
  bubble_label: 'Chat',
  primary_color: '',
  position: 'bottom-right',
  escalate_email: '',
  escalate_notify_portal: true,
  suggest_lead_capture: true,
  agent_timeout_hint_sec: 90,
  /** When no live client MCP agent replies, ChatGPT answers as business CS from knowledge. */
  ai_fallback: true,
};

const AI_FALLBACK_DELAY_MS = 2000;
/** Minimum visitor turns before we may open the contact form (greetings alone never count). */
const MIN_VISITOR_TURNS_BEFORE_CAPTURE = 2;

const LEAD_CAPTURE_THANKS =
  'Thanks for sharing that. Our team can’t reply in this chat right away — '
  + 'tap “Leave your details” below (or the Details tab) so we can call or email you back.';
const LEAD_CAPTURE_SYSTEM =
  'Use the “Leave your details” button below, or open the Details tab, to share your contact info.';
const LEAD_CAPTURE_FORM_META = { source: 'ai_fallback', open_lead_form: true };

/** Debounced AI fallback timers keyed by workspaceId:sessionId */
const _aiFallbackTimers = new Map();

function formatHoursForSupport(hours) {
  if (hours == null || hours === '') return '';
  if (typeof hours === 'string') return hours.trim();
  if (Array.isArray(hours)) {
    return hours.map((h) => {
      if (typeof h === 'string') return h.trim();
      if (h && typeof h === 'object') {
        const day = h.day || h.name || h.label || '';
        const open = h.open || h.opens || h.from || '';
        const close = h.close || h.closes || h.to || '';
        if (day && open && close) return `${day}: ${open}–${close}`;
        if (day && (open || close)) return `${day}: ${open || close}`;
        try { return JSON.stringify(h); } catch { return ''; }
      }
      return String(h || '').trim();
    }).filter(Boolean).join('; ');
  }
  if (typeof hours === 'object') {
    try { return JSON.stringify(hours); } catch { return ''; }
  }
  return String(hours).trim();
}

/**
 * Profile for ChatGPT fallback: act as this business's customer support.
 * Lead columns + verified facts + website theme brandName.
 */
function loadBusinessSupportContext(db, leadId) {
  const lid = Number(leadId);
  let lead = null;
  try {
    const engine = require('../src/leadEngine');
    if (typeof engine.getLead === 'function') lead = engine.getLead(db, lid);
  } catch { /* ignore */ }
  if (!lead) {
    try { lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lid) || null; } catch { lead = null; }
  }

  let brandName = '';
  let siteName = '';
  try {
    const site = db.prepare(
      'SELECT name, theme FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
    ).get(lid);
    if (site) {
      siteName = String(site.name || '').trim();
      let theme = {};
      try {
        theme = typeof site.theme === 'string' ? JSON.parse(site.theme || '{}') : (site.theme || {});
      } catch { theme = {}; }
      brandName = String((theme && theme.brandName) || '').trim();
    }
  } catch { /* ignore */ }

  const factPick = {};
  try {
    const rows = db.prepare(`
      SELECT fact_key, value FROM business_facts
      WHERE lead_id = ?
        AND UPPER(COALESCE(claim_class, '')) IN ('VERIFIED', 'OWNER_PROVIDED')
        AND fact_key IN ('address', 'phone', 'email', 'hours', 'description', 'site.about', 'category')
      ORDER BY id DESC
    `).all(lid);
    for (const r of rows) {
      const key = String(r.fact_key || '');
      const val = String(r.value || '').trim();
      if (!val || factPick[key]) continue;
      factPick[key] = val;
    }
  } catch { /* ignore */ }

  const businessName = brandName
    || (lead && lead.business_name)
    || siteName
    || 'our business';
  const category = (lead && lead.category) || factPick.category || '';
  const phone = (lead && lead.phone) || factPick.phone || '';
  const email = (lead && lead.email) || factPick.email || '';
  const address = (lead && lead.address)
    || factPick.address
    || [lead && lead.city, lead && lead.state, lead && lead.postal_code].filter(Boolean).join(', ');
  const city = (lead && lead.city) || '';
  const state = (lead && lead.state) || '';
  const hours = formatHoursForSupport(lead && lead.hours) || factPick.hours || '';
  const about = String((lead && lead.description) || factPick.description || factPick['site.about'] || '')
    .trim()
    .slice(0, 800);
  const website = (lead && lead.website) || '';
  const services = Array.isArray(lead && lead.services)
    ? lead.services.map((s) => (typeof s === 'string' ? s : (s && s.name) || '')).filter(Boolean).slice(0, 12)
    : [];

  const lines = [
    `Business name: ${businessName}`,
    category ? `Industry / category: ${category}` : '',
    phone ? `Phone: ${phone}` : '',
    email ? `Email: ${email}` : '',
    address ? `Address: ${address}` : '',
    (city || state) && !address ? `Location: ${[city, state].filter(Boolean).join(', ')}` : '',
    hours ? `Hours: ${hours}` : '',
    website ? `Website: ${website}` : '',
    services.length ? `Services (labels only — verify details in knowledge): ${services.join(', ')}` : '',
    about ? `About: ${about}` : '',
  ].filter(Boolean);

  return {
    businessName: String(businessName).slice(0, 200),
    category: String(category || '').slice(0, 120),
    phone: String(phone || '').slice(0, 64),
    email: String(email || '').slice(0, 200),
    address: String(address || '').slice(0, 300),
    city: String(city || '').slice(0, 80),
    state: String(state || '').slice(0, 40),
    hours: String(hours || '').slice(0, 500),
    about,
    website: String(website || '').slice(0, 300),
    services,
    text: lines.join('\n'),
  };
}

function leadCaptureThanksFor(businessName) {
  const name = String(businessName || '').trim();
  if (name && !/^our business$/i.test(name)) {
    return `Thanks for sharing that with ${name}. Our team can’t reply in this chat right away — `
      + 'tap “Leave your details” below (or the Details tab) so we can call or email you back.';
  }
  return LEAD_CAPTURE_THANKS;
}

function isGreetingOnly(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || t.length > 40) return false;
  return /^(hi|hello|hey|howdy|yo|sup|good\s*(morning|afternoon|evening)|hiya|hola)[\s!.?]*$/i.test(t);
}

function visitorStatedNeed(messages) {
  const visitor = (messages || []).filter((m) => m && m.role === 'visitor');
  if (visitor.length < MIN_VISITOR_TURNS_BEFORE_CAPTURE) return false;
  const substantive = visitor.filter((m) => !isGreetingOnly(m.body));
  return substantive.length >= 1 && visitor.length >= MIN_VISITOR_TURNS_BEFORE_CAPTURE;
}

function heuristicSupportReply(latestVisitor, businessName, messages) {
  const name = String(businessName || '').trim() || 'our team';
  const latest = String(latestVisitor || '').trim();
  if (isGreetingOnly(latest) || !latest) {
    return {
      action: 'chat',
      reply: `Hi! Thanks for reaching out to ${name}. What can we help you with today?`,
    };
  }
  if (!visitorStatedNeed(messages)) {
    return {
      action: 'chat',
      reply: `Got it — thanks. Could you share a bit more about what you need (for example the issue, location, or timing) so we can help?`,
    };
  }
  return {
    action: 'capture',
    reply: leadCaptureThanksFor(businessName),
  };
}

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

function appBaseUrl() {
  return String(process.env.APP_URL || '').replace(/\/$/, '');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chatbot_settings (
      lead_id INTEGER PRIMARY KEY,
      greeting TEXT NOT NULL DEFAULT '',
      bubble_label TEXT NOT NULL DEFAULT 'Chat',
      primary_color TEXT NOT NULL DEFAULT '',
      position TEXT NOT NULL DEFAULT 'bottom-right',
      escalate_email TEXT NOT NULL DEFAULT '',
      escalate_notify_portal INTEGER NOT NULL DEFAULT 1,
      suggest_lead_capture INTEGER NOT NULL DEFAULT 1,
      agent_timeout_hint_sec INTEGER NOT NULL DEFAULT 90,
      settings_json TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chatbot_knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'link',
      title TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      content_text TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chatbot_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      session_token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'open',
      needs_agent INTEGER NOT NULL DEFAULT 0,
      visitor_meta_json TEXT,
      last_visitor_at TEXT,
      last_agent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chatbot_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      body TEXT NOT NULL,
      meta_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chatbot_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      session_id INTEGER,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chatbot_escalations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      session_id INTEGER,
      message TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chatbot_knowledge_lead ON chatbot_knowledge(lead_id);
    CREATE INDEX IF NOT EXISTS idx_chatbot_sessions_lead ON chatbot_sessions(lead_id, needs_agent);
    CREATE INDEX IF NOT EXISTS idx_chatbot_messages_session ON chatbot_messages(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_chatbot_leads_lead ON chatbot_leads(lead_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_chatbot_escalations_lead ON chatbot_escalations(lead_id, status);
  `);
}

function parseSettingsRow(row) {
  const base = { ...DEFAULT_SETTINGS };
  if (!row) return base;
  let extra = {};
  try { extra = JSON.parse(row.settings_json || '{}') || {}; } catch { extra = {}; }
  return {
    ...base,
    ...extra,
    greeting: row.greeting != null && String(row.greeting) !== '' ? String(row.greeting) : base.greeting,
    bubble_label: row.bubble_label != null && String(row.bubble_label) !== ''
      ? String(row.bubble_label).slice(0, 40)
      : base.bubble_label,
    primary_color: String(row.primary_color || ''),
    position: String(row.position || 'bottom-right'),
    escalate_email: String(row.escalate_email || ''),
    escalate_notify_portal: row.escalate_notify_portal == null ? true : !!row.escalate_notify_portal,
    suggest_lead_capture: row.suggest_lead_capture == null ? true : !!row.suggest_lead_capture,
    agent_timeout_hint_sec: Number(row.agent_timeout_hint_sec) || 90,
    ai_fallback: extra.ai_fallback == null ? base.ai_fallback : !!extra.ai_fallback,
  };
}

function getSettings(db, leadId) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM chatbot_settings WHERE lead_id = ?').get(Number(leadId));
  return parseSettingsRow(row);
}

function saveSettings(db, leadId, data = {}) {
  ensureTables(db);
  const cur = getSettings(db, leadId);
  const next = {
    greeting: data.greeting != null ? String(data.greeting).slice(0, 500) : cur.greeting,
    bubble_label: data.bubble_label != null ? String(data.bubble_label).slice(0, 40) : cur.bubble_label,
    primary_color: data.primary_color != null ? String(data.primary_color).slice(0, 32) : cur.primary_color,
    position: data.position != null ? String(data.position).slice(0, 32) : cur.position,
    escalate_email: data.escalate_email != null ? String(data.escalate_email).slice(0, 200) : cur.escalate_email,
    escalate_notify_portal: data.escalate_notify_portal != null
      ? !!data.escalate_notify_portal
      : cur.escalate_notify_portal,
    suggest_lead_capture: data.suggest_lead_capture != null
      ? !!data.suggest_lead_capture
      : cur.suggest_lead_capture,
    agent_timeout_hint_sec: data.agent_timeout_hint_sec != null
      ? Math.min(600, Math.max(15, Number(data.agent_timeout_hint_sec) || 90))
      : cur.agent_timeout_hint_sec,
    ai_fallback: data.ai_fallback != null ? !!data.ai_fallback : cur.ai_fallback,
  };
  const extras = { ai_fallback: next.ai_fallback };
  db.prepare(`
    INSERT INTO chatbot_settings (
      lead_id, greeting, bubble_label, primary_color, position, escalate_email,
      escalate_notify_portal, suggest_lead_capture, agent_timeout_hint_sec, settings_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(lead_id) DO UPDATE SET
      greeting=excluded.greeting,
      bubble_label=excluded.bubble_label,
      primary_color=excluded.primary_color,
      position=excluded.position,
      escalate_email=excluded.escalate_email,
      escalate_notify_portal=excluded.escalate_notify_portal,
      suggest_lead_capture=excluded.suggest_lead_capture,
      agent_timeout_hint_sec=excluded.agent_timeout_hint_sec,
      settings_json=excluded.settings_json,
      updated_at=datetime('now')
  `).run(
    Number(leadId),
    next.greeting,
    next.bubble_label,
    next.primary_color,
    next.position,
    next.escalate_email,
    next.escalate_notify_portal ? 1 : 0,
    next.suggest_lead_capture ? 1 : 0,
    next.agent_timeout_hint_sec,
    JSON.stringify(extras)
  );
  return getSettings(db, leadId);
}

function publicKnowledge(row) {
  if (!row) return null;
  return {
    id: row.id,
    lead_id: row.lead_id,
    kind: row.kind,
    title: row.title,
    url: row.url,
    content_text: row.content_text,
    file_name: row.file_name,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_file: !!row.file_path,
  };
}

function listKnowledge(db, leadId, { includeInactive = false } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM chatbot_knowledge WHERE lead_id = ?';
  if (!includeInactive) sql += " AND status = 'active'";
  sql += ' ORDER BY id DESC';
  return db.prepare(sql).all(Number(leadId)).map(publicKnowledge);
}

function getKnowledge(db, leadId, id) {
  ensureTables(db);
  return publicKnowledge(
    db.prepare('SELECT * FROM chatbot_knowledge WHERE lead_id = ? AND id = ?')
      .get(Number(leadId), Number(id))
  );
}

function addKnowledge(db, leadId, data = {}) {
  ensureTables(db);
  const kind = String(data.kind || (data.url ? 'link' : 'doc')).toLowerCase() === 'doc' ? 'doc' : 'link';
  const title = String(data.title || data.url || data.file_name || 'Knowledge').trim().slice(0, 200);
  const url = String(data.url || '').trim().slice(0, 2000);
  const content = String(data.content_text || data.content || data.body || '').slice(0, 200000);
  const fileName = String(data.file_name || data.fileName || '').slice(0, 200);
  const filePath = String(data.file_path || data.filePath || '').slice(0, 500);
  if (kind === 'link' && !url && !content) {
    throw fail('VALIDATION', 'url or content_text required for knowledge link', 400);
  }
  if (kind === 'doc' && !content && !filePath) {
    throw fail('VALIDATION', 'content_text or uploaded file required for knowledge doc', 400);
  }
  const info = db.prepare(`
    INSERT INTO chatbot_knowledge
      (lead_id, kind, title, url, content_text, file_name, file_path, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(Number(leadId), kind, title || (kind === 'link' ? url : 'Document'), url, content, fileName, filePath);
  return getKnowledge(db, leadId, info.lastInsertRowid);
}

function updateKnowledge(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM chatbot_knowledge WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
  if (!row) throw fail('NOT_FOUND', 'Knowledge item not found', 404);
  const kind = data.kind != null
    ? (String(data.kind).toLowerCase() === 'doc' ? 'doc' : 'link')
    : row.kind;
  const title = data.title != null ? String(data.title).trim().slice(0, 200) : row.title;
  const url = data.url != null ? String(data.url).trim().slice(0, 2000) : row.url;
  const content = data.content_text != null || data.content != null || data.body != null
    ? String(data.content_text != null ? data.content_text : (data.content != null ? data.content : data.body)).slice(0, 200000)
    : row.content_text;
  const status = data.status != null
    ? (String(data.status).toLowerCase() === 'inactive' ? 'inactive' : 'active')
    : row.status;
  db.prepare(`
    UPDATE chatbot_knowledge SET kind=?, title=?, url=?, content_text=?, status=?,
      updated_at=datetime('now') WHERE id=? AND lead_id=?
  `).run(kind, title, url, content, status, row.id, Number(leadId));
  return getKnowledge(db, leadId, row.id);
}

function deleteKnowledge(db, leadId, id) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM chatbot_knowledge WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
  if (!row) throw fail('NOT_FOUND', 'Knowledge item not found', 404);
  if (row.file_path) {
    try {
      const abs = path.isAbsolute(row.file_path)
        ? row.file_path
        : path.join(process.cwd(), row.file_path);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch { /* ignore */ }
  }
  db.prepare('DELETE FROM chatbot_knowledge WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

/** Snippets for agent prompt (client MCP chatbot.knowledge / reply context). */
function knowledgeSnippets(db, leadId, { limit = 12, maxChars = 6000, query = '' } = {}) {
  const extract = require('./chatbotKnowledgeExtract');
  const all = listKnowledge(db, leadId, { includeInactive: false });
  const q = String(query || '').trim();
  let items = all.slice();
  if (q) {
    items = items
      .map((it) => ({
        it,
        score: extract.scoreText(`${it.title}\n${it.content_text || ''}\n${it.url || ''}`, q),
      }))
      .sort((a, b) => b.score - a.score || b.it.id - a.it.id)
      .map((x) => x.it);
  }
  items = items.slice(0, limit);
  const perDoc = Math.max(400, Math.floor(maxChars / Math.max(1, Math.min(items.length, 6))));
  const chunks = [];
  let used = 0;
  for (const it of items) {
    const head = `[${it.kind}] ${it.title}${it.url ? ` (${it.url})` : ''}${it.file_name ? ` «${it.file_name}»` : ''}`;
    const raw = String(it.content_text || '').trim();
    const body = q && raw.length > perDoc
      ? extract.searchWindows(raw, q, { maxChars: perDoc })
      : raw.slice(0, perDoc);
    const piece = body ? `${head}\n${body}` : head;
    if (used + piece.length > maxChars) {
      const remain = Math.max(0, maxChars - used - 20);
      if (remain > 40) chunks.push(`${piece.slice(0, remain)}…`);
      break;
    }
    chunks.push(piece);
    used += piece.length + 2;
  }
  return {
    count: all.length,
    matched: items.length,
    query: q || undefined,
    snippets: chunks,
    text: chunks.join('\n\n---\n\n'),
    supported_types: extract.SUPPORTED_LABEL,
  };
}

function makeSessionToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function publicMessage(row) {
  if (!row) return null;
  let meta = null;
  try { meta = row.meta_json ? JSON.parse(row.meta_json) : null; } catch { meta = null; }
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    body: row.body,
    meta,
    created_at: row.created_at,
  };
}

function publicSession(row, { withMessages = false, messages = null } = {}) {
  if (!row) return null;
  let visitor = null;
  try { visitor = row.visitor_meta_json ? JSON.parse(row.visitor_meta_json) : null; } catch { visitor = null; }
  const out = {
    id: row.id,
    lead_id: row.lead_id,
    session_token: row.session_token,
    status: row.status,
    needs_agent: !!row.needs_agent,
    visitor,
    last_visitor_at: row.last_visitor_at,
    last_agent_at: row.last_agent_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (withMessages) out.messages = Array.isArray(messages) ? messages : [];
  return out;
}

function getSessionByToken(db, token) {
  ensureTables(db);
  return db.prepare('SELECT * FROM chatbot_sessions WHERE session_token = ?')
    .get(String(token || ''));
}

function getSessionById(db, leadId, id) {
  ensureTables(db);
  return db.prepare('SELECT * FROM chatbot_sessions WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
}

function listMessages(db, sessionId, { afterId = 0, limit = 100 } = {}) {
  ensureTables(db);
  const lim = Math.min(200, Math.max(1, Number(limit) || 100));
  const after = Number(afterId) || 0;
  return db.prepare(`
    SELECT * FROM chatbot_messages
    WHERE session_id = ? AND id > ?
    ORDER BY id ASC LIMIT ?
  `).all(Number(sessionId), after, lim).map(publicMessage);
}

function addMessage(db, sessionId, leadId, role, body, meta = null) {
  const text = String(body || '').trim().slice(0, 8000);
  if (!text) throw fail('VALIDATION', 'message body required', 400);
  const r = String(role || '').toLowerCase();
  if (!['visitor', 'agent', 'system'].includes(r)) {
    throw fail('VALIDATION', 'role must be visitor|agent|system', 400);
  }
  const info = db.prepare(`
    INSERT INTO chatbot_messages (session_id, lead_id, role, body, meta_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    Number(sessionId),
    Number(leadId),
    r,
    text,
    meta != null ? JSON.stringify(meta) : null
  );
  return publicMessage(
    db.prepare('SELECT * FROM chatbot_messages WHERE id = ?').get(info.lastInsertRowid)
  );
}

function resolveEmbedForLead(db, leadId) {
  const modules = require('./siteModules');
  modules.ensureTables(db);
  return modules.getEmbedRow(db, Number(leadId), 'chatbot');
}

function getPublicConfigByToken(db, token) {
  ensureTables(db);
  const modules = require('./siteModules');
  modules.ensureTables(db);
  const row = db.prepare(
    "SELECT * FROM site_module_embeds WHERE public_token = ? AND module_type = 'chatbot' AND published = 1"
  ).get(String(token || ''));
  if (!row || !row.embed_enabled) throw fail('NOT_FOUND', 'Chatbot not found', 404);
  const settings = getSettings(db, row.lead_id);
  return {
    embed: modules.publicEmbed(row),
    module_type: 'chatbot',
    settings: {
      greeting: settings.greeting,
      bubble_label: settings.bubble_label,
      primary_color: settings.primary_color,
      position: settings.position,
      suggest_lead_capture: settings.suggest_lead_capture,
      agent_timeout_hint_sec: settings.agent_timeout_hint_sec,
    },
    allowed_actions: listAllowedActions(db, row.lead_id),
    agent_path: {
      mode: 'portal_client_mcp',
      note: 'Visitor messages notify the client agent via portal MCP (chatbot.pending / chatbot.reply). No admin/workspace tools.',
    },
  };
}

function listAllowedActions(db, leadId) {
  const modules = require('./siteModules');
  modules.ensureTables(db);
  const embeds = modules.listEmbeds(db, Number(leadId)).filter((e) => e.published && e.embed_enabled);
  const byType = new Set(embeds.map((e) => e.module_type));
  const actions = [
    {
      id: 'lead_capture',
      label: 'Collect visitor contact details',
      via: 'public',
      endpoint: 'POST /api/v1/chat/public/:token/lead',
    },
    {
      id: 'escalate',
      label: 'Escalate to business (portal inbox)',
      via: 'client_mcp',
      tool: 'chatbot.escalate',
    },
  ];
  if (byType.has('bookings')) {
    const emb = embeds.find((e) => e.module_type === 'bookings');
    actions.push({
      id: 'bookings.slots',
      label: 'List available appointment slots',
      via: 'public',
      endpoint: `GET /api/v1/modules/public/${emb.public_token}/slots?date=YYYY-MM-DD`,
      capability: 'bookings',
    });
    actions.push({
      id: 'bookings.book',
      label: 'Book an appointment',
      via: 'public',
      endpoint: `POST /api/v1/modules/public/${emb.public_token}/book`,
      capability: 'bookings',
    });
  }
  try {
    const forms = require('./contactForms');
    forms.ensureTables(db);
    const formRows = db.prepare(
      "SELECT id, name, public_token FROM contact_forms WHERE lead_id = ? AND status = 'published' AND public_token IS NOT NULL AND public_token != '' LIMIT 20"
    ).all(Number(leadId));
    for (const f of formRows) {
      actions.push({
        id: `form.submit.${f.id}`,
        label: `Submit form: ${f.name || f.id}`,
        via: 'public',
        endpoint: `POST /api/v1/forms/public/${f.public_token}/submit`,
        formId: f.id,
        capability: 'forms',
      });
    }
  } catch { /* forms optional */ }
  if (byType.has('ecommerce')) {
    const emb = embeds.find((e) => e.module_type === 'ecommerce');
    actions.push({
      id: 'ecommerce.list',
      label: 'List shop products',
      via: 'public',
      endpoint: `GET /api/v1/modules/public/${emb.public_token}`,
      capability: 'ecommerce',
      note: 'Show products from public module JSON; checkout links when present.',
    });
  }
  return actions;
}

function notifyClientAgent(db, message, meta = {}) {
  try {
    if (typeof process !== 'undefined' && process.stderr && process.stderr.write) {
      process.stderr.write(`[chatbot-agent] ${message}\n`);
    }
  } catch { /* ignore */ }
  try {
    const { fireAgentTriggers } = require('../src/designAgentTrigger');
    fireAgentTriggers(db, {
      jobId: meta.sessionId || meta.jobId || null,
      reason: 'chatbot',
      status: 'waiting_on_agent',
      message,
      leadId: meta.leadId,
      sessionId: meta.sessionId,
      mcpHint: 'Client MCP only: chatbot.pending / chatbot.next / chatbot.reply / chatbot.escalate. Do not use admin design.* or lead.* tools.',
    });
  } catch { /* ignore */ }
}

function startOrGetSession(db, leadId, { sessionToken, visitor } = {}) {
  ensureTables(db);
  let row = null;
  if (sessionToken) row = getSessionByToken(db, sessionToken);
  if (row && Number(row.lead_id) !== Number(leadId)) {
    throw fail('FORBIDDEN', 'Session does not match chatbot', 403);
  }
  if (!row) {
    const token = makeSessionToken();
    const info = db.prepare(`
      INSERT INTO chatbot_sessions (lead_id, session_token, status, needs_agent, visitor_meta_json)
      VALUES (?, ?, 'open', 0, ?)
    `).run(
      Number(leadId),
      token,
      visitor != null ? JSON.stringify(visitor) : null
    );
    row = db.prepare('SELECT * FROM chatbot_sessions WHERE id = ?').get(info.lastInsertRowid);
  }
  return row;
}

function postVisitorMessage(db, token, { sessionToken, message, visitor, workspaceId } = {}) {
  ensureTables(db);
  const cfg = getPublicConfigByToken(db, token);
  const leadId = cfg.embed.lead_id;
  const session = startOrGetSession(db, leadId, { sessionToken, visitor });
  const msg = addMessage(db, session.id, leadId, 'visitor', message);
  db.prepare(`
    UPDATE chatbot_sessions
    SET needs_agent = 1, last_visitor_at = datetime('now'), updated_at = datetime('now'),
        visitor_meta_json = COALESCE(?, visitor_meta_json)
    WHERE id = ?
  `).run(visitor != null ? JSON.stringify(visitor) : null, session.id);

  notifyClientAgent(db,
    `Chatbot session #${session.id} needs a reply (lead ${leadId}). Client MCP: chatbot.next or chatbot.pending.`,
    { leadId, sessionId: session.id }
  );

  const settings = getSettings(db, leadId);
  if (settings.ai_fallback !== false && workspaceId) {
    scheduleAiFallbackReply({
      workspaceId: Number(workspaceId),
      leadId: Number(leadId),
      sessionId: Number(session.id),
    });
  }

  return {
    session: publicSession(getSessionByToken(db, session.session_token)),
    message: msg,
    poll_hint: 'GET /api/v1/chat/public/:token/messages?session=…&after=messageId',
    agent_boundary: 'portal_client_mcp_only',
    ai_fallback_scheduled: !!(settings.ai_fallback !== false && workspaceId),
  };
}

/**
 * Parse ChatGPT fallback output into { action: 'chat'|'answer'|'capture', reply }.
 * Accepts JSON (preferred), FOUND:/REPLY: markers, or ACTION: markers.
 * @param {string} raw
 * @param {{ businessName?: string, allowCapture?: boolean }} [opts]
 */
function parseAiFallbackResponse(raw, opts = {}) {
  const thanks = leadCaptureThanksFor(opts.businessName);
  const allowCapture = opts.allowCapture !== false;
  const text = String(raw || '').trim();
  if (!text) {
    return { action: allowCapture ? 'capture' : 'chat', found: false, reply: allowCapture ? thanks : 'What can we help you with today?' };
  }

  const normalize = (action, reply) => {
    let act = String(action || 'chat').toLowerCase();
    if (act === 'answer' || act === 'found' || act === 'yes') act = 'answer';
    if (act === 'capture' || act === 'lead' || act === 'escalate' || act === 'no' || act === 'false') act = 'capture';
    if (act !== 'answer' && act !== 'capture') act = 'chat';
    if (act === 'capture' && !allowCapture) act = 'chat';
    const body = String(reply || '').trim();
    if (act === 'capture' && !body) {
      return { action: 'capture', found: false, reply: thanks };
    }
    if (!body) {
      return { action: 'chat', found: false, reply: 'What can we help you with today?' };
    }
    return {
      action: act,
      found: act === 'answer',
      reply: body.slice(0, 4000),
    };
  };

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (obj && typeof obj === 'object') {
        const reply = String(obj.reply || obj.message || obj.answer || '').trim();
        if (obj.action != null) return normalize(obj.action, reply);
        // Legacy found:true|false
        const found = obj.found === true || obj.found === 'true' || obj.found === 1
          || /^yes$/i.test(String(obj.found || ''));
        if (found) return normalize('answer', reply);
        return normalize(allowCapture ? 'capture' : 'chat', reply || (allowCapture ? thanks : ''));
      }
    } catch { /* fall through */ }
  }

  const actionLine = text.match(/^\s*ACTION\s*:\s*(chat|answer|capture|lead)\s*$/im);
  const foundLine = text.match(/^\s*FOUND\s*:\s*(yes|no|true|false)\s*$/im);
  const replyBlock = text.match(/REPLY\s*:\s*([\s\S]+)/i);
  const reply = replyBlock ? String(replyBlock[1]).trim() : '';
  if (actionLine) return normalize(actionLine[1], reply);
  if (foundLine) {
    const found = /^(yes|true)$/i.test(foundLine[1]);
    return normalize(found ? 'answer' : (allowCapture ? 'capture' : 'chat'), reply);
  }

  if (/contact form is about to appear|opening a short contact form/i.test(text)) {
    return normalize(allowCapture ? 'capture' : 'chat', text);
  }
  return normalize('chat', text);
}

function postChatFallback(db, leadId, sessionId, replyText) {
  const msg = addMessage(db, sessionId, leadId, 'agent', String(replyText || '').trim().slice(0, 4000), {
    source: 'ai_fallback',
    action: 'chat',
  });
  // needs_agent cleared by claimNeedsAgent before applyFallbackAction.
  db.prepare(`
    UPDATE chatbot_sessions
    SET last_agent_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(Number(sessionId));
  return msg;
}

function postLeadCaptureFallback(db, leadId, sessionId, replyText, businessName) {
  const body = String(replyText || leadCaptureThanksFor(businessName)).trim()
    || leadCaptureThanksFor(businessName);
  // Agent warning first; client shows an in-chat button (Details tab) — never overlays messages.
  addMessage(db, sessionId, leadId, 'agent', body, {
    source: 'ai_fallback',
    action: 'capture',
    found: false,
  });
  const msg = addMessage(db, sessionId, leadId, 'system', LEAD_CAPTURE_SYSTEM, LEAD_CAPTURE_FORM_META);
  db.prepare(`
    UPDATE chatbot_sessions
    SET last_agent_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(Number(sessionId));
  return msg;
}

function aiFallbackTimerKey(workspaceId, sessionId) {
  return `${Number(workspaceId)}:${Number(sessionId)}`;
}

function cancelAiFallbackReply(workspaceId, sessionId) {
  const key = aiFallbackTimerKey(workspaceId, sessionId);
  if (!_aiFallbackTimers.has(key)) return false;
  clearTimeout(_aiFallbackTimers.get(key));
  _aiFallbackTimers.delete(key);
  return true;
}

function scheduleAiFallbackReply({ workspaceId, leadId, sessionId }) {
  const ws = Number(workspaceId);
  const lid = Number(leadId);
  const sid = Number(sessionId);
  if (!Number.isInteger(ws) || ws <= 0 || !Number.isInteger(lid) || !Number.isInteger(sid)) return;
  const key = aiFallbackTimerKey(ws, sid);
  if (_aiFallbackTimers.has(key)) clearTimeout(_aiFallbackTimers.get(key));
  const timer = setTimeout(() => {
    _aiFallbackTimers.delete(key);
    runAiFallbackReply(ws, lid, sid).catch((err) => {
      try {
        process.stderr.write(`[chatbot-ai] fallback failed session=${sid}: ${err && err.message}\n`);
      } catch { /* ignore */ }
    });
  }, AI_FALLBACK_DELAY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  _aiFallbackTimers.set(key, timer);
}

/** Atomically claim needs_agent so AI fallback and live agent cannot both reply. */
function claimNeedsAgent(db, sessionId) {
  const info = db.prepare(`
    UPDATE chatbot_sessions
    SET needs_agent = 0, last_agent_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND needs_agent = 1 AND status = 'open'
  `).run(Number(sessionId));
  return Number(info && info.changes) > 0;
}

function applyFallbackAction(db, leadId, sessionId, parsed, businessName) {
  const action = parsed && parsed.action;
  if (action === 'capture') {
    return {
      ok: true,
      action: 'capture',
      found: false,
      message: postLeadCaptureFallback(db, leadId, sessionId, parsed.reply, businessName),
    };
  }
  if (action === 'answer') {
    const msg = addMessage(db, sessionId, leadId, 'agent', parsed.reply, {
      source: 'ai_fallback',
      action: 'answer',
      found: true,
    });
    db.prepare(`
      UPDATE chatbot_sessions
      SET last_agent_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(Number(sessionId));
    return { ok: true, action: 'answer', found: true, message: msg };
  }
  return {
    ok: true,
    action: 'chat',
    found: false,
    message: postChatFallback(db, leadId, sessionId, parsed.reply),
  };
}

/**
 * ChatGPT (or heuristic) acts as business CS when no live client MCP agent has replied.
 * Brief chat to understand needs → warn → open contact form. Knowledge-only for facts.
 */
async function runAiFallbackReply(workspaceId, leadId, sessionId) {
  const domain = require('./domain');
  const { chat, aiConfigured } = require('../src/ai');

  const snapshot = domain.withDb(workspaceId, (db) => {
    const session = getSessionById(db, leadId, sessionId);
    if (!session || session.status !== 'open' || !session.needs_agent) {
      return { skip: true, reason: 'already_handled' };
    }
    const messages = listMessages(db, sessionId, { limit: 40 });
    const last = messages[messages.length - 1];
    if (last && (last.role === 'agent' || last.role === 'system')) {
      return { skip: true, reason: 'agent_already_replied' };
    }
    const visitorTexts = messages
      .filter((m) => m.role === 'visitor')
      .map((m) => m.body)
      .slice(-8);
    const latestVisitor = visitorTexts[visitorTexts.length - 1] || '';
    const knowledge = knowledgeSnippets(db, leadId, {
      query: visitorTexts.join(' '),
      limit: 12,
      maxChars: 8000,
    });
    const settings = getSettings(db, leadId);
    const business = loadBusinessSupportContext(db, leadId);
    return {
      skip: false,
      messages,
      visitorTexts,
      latestVisitor,
      knowledge,
      settings,
      business,
      configured: aiConfigured(db),
      allowCapture: visitorStatedNeed(messages),
    };
  });

  if (snapshot.skip) return { skipped: true, reason: snapshot.reason };

  const bizName = snapshot.business && snapshot.business.businessName;
  const thanks = leadCaptureThanksFor(bizName);
  const allowCapture = !!snapshot.allowCapture;

  // AI off → light heuristic conversation (never jump straight to form on "hi").
  if (!snapshot.configured) {
    const heur = heuristicSupportReply(snapshot.latestVisitor, bizName, snapshot.messages);
    return domain.withDb(workspaceId, (db) => {
      if (!claimNeedsAgent(db, sessionId)) return { skipped: true, reason: 'race' };
      return { ...applyFallbackAction(db, leadId, sessionId, heur, bizName), via: 'heuristic' };
    });
  }

  const historyLines = (snapshot.messages || []).slice(-12).map((m) => {
    const who = m.role === 'visitor' ? 'Visitor' : m.role === 'agent' ? 'Agent' : 'System';
    return `${who}: ${m.body}`;
  }).join('\n');

  const bizBlock = (snapshot.business && snapshot.business.text) || `Business name: ${bizName || 'our business'}`;
  const knowledgeBlock = (snapshot.knowledge && snapshot.knowledge.count > 0)
    ? snapshot.knowledge.text
    : '(no knowledge files uploaded yet)';

  let raw = '';
  try {
    const result = await domain.withDb(workspaceId, async (db) => chat({
      task: 'qa',
      db,
      leadId,
      note: `chatbot-fallback session=${sessionId}`,
      maxTokens: 450,
      messages: [
        {
          role: 'system',
          content: [
            `You are a friendly, professional customer-support agent for ${bizName || 'this business'}.`,
            'Speak as their website chat support — not a generic AI. Use the business name naturally.',
            'Goal: have a brief conversation, understand what the visitor needs, then (only when ready) hand off to a contact form because a human cannot reply in this chat immediately.',
            '',
            'Business profile (you may share contact/identity when asked):',
            bizBlock,
            '',
            'Conversation rules:',
            '- Greetings or vague hellos → action "chat": welcome them and ask what they need. NEVER open the form yet.',
            '- If their need is unclear → action "chat": ask one short clarifying question.',
            '- If knowledge clearly answers a factual question → action "answer" with a short reply.',
            '- Factual claims (services, pricing, policies, availability) ONLY from knowledge excerpts. Do not invent.',
            '- When you understand their need AND a human follow-up is the right next step → action "capture".',
            '- On capture, the reply MUST warn that a short contact form is about to appear (it overlays the chat) so they are not surprised, and explain the team will call/email them back.',
            allowCapture
              ? '- Capture is ALLOWED now (visitor has shared a need across at least two turns).'
              : '- Capture is NOT allowed yet — keep action "chat" until you understand their need.',
            '',
            'Respond with ONLY compact JSON:',
            '{"action":"chat"|"answer"|"capture","reply":"..."}',
            '',
            'Knowledge excerpts:',
            knowledgeBlock,
          ].join('\n'),
        },
        {
          role: 'user',
          content: `Conversation:\n${historyLines}\n\nLatest visitor message:\n${snapshot.latestVisitor}`,
        },
      ],
    }));
    raw = result && result.text ? result.text : '';
  } catch (err) {
    try {
      process.stderr.write(`[chatbot-ai] ChatGPT error session=${sessionId}: ${err && err.message}\n`);
    } catch { /* ignore */ }
    const heur = heuristicSupportReply(snapshot.latestVisitor, bizName, snapshot.messages);
    return domain.withDb(workspaceId, (db) => {
      if (!claimNeedsAgent(db, sessionId)) return { skipped: true, reason: 'race' };
      return { ...applyFallbackAction(db, leadId, sessionId, heur, bizName), via: 'ai_error' };
    });
  }

  let parsed = parseAiFallbackResponse(raw, { businessName: bizName, allowCapture });
  // Hard guard: never capture on greetings / too-early turns even if the model asks to.
  if (parsed.action === 'capture' && !allowCapture) {
    parsed = heuristicSupportReply(snapshot.latestVisitor, bizName, snapshot.messages);
  }
  if (parsed.action === 'capture' && !/form|appear|overlay|below/i.test(parsed.reply)) {
    parsed = { ...parsed, reply: thanks };
  }

  return domain.withDb(workspaceId, (db) => {
    if (!claimNeedsAgent(db, sessionId)) return { skipped: true, reason: 'race' };
    return { ...applyFallbackAction(db, leadId, sessionId, parsed, bizName), via: 'chatgpt' };
  });
}

function getSessionHistory(db, token, { sessionToken, afterId } = {}) {
  const cfg = getPublicConfigByToken(db, token);
  const session = getSessionByToken(db, sessionToken);
  if (!session || Number(session.lead_id) !== Number(cfg.embed.lead_id)) {
    throw fail('NOT_FOUND', 'Session not found', 404);
  }
  const messages = listMessages(db, session.id, { afterId });
  return {
    session: publicSession(session),
    messages,
  };
}

function captureLead(db, token, data = {}) {
  const cfg = getPublicConfigByToken(db, token);
  const leadId = cfg.embed.lead_id;
  let sessionId = null;
  if (data.session || data.sessionToken) {
    const session = getSessionByToken(db, data.session || data.sessionToken);
    if (session && Number(session.lead_id) === Number(leadId)) sessionId = session.id;
  }
  const name = String(data.name || '').trim().slice(0, 120);
  const email = String(data.email || '').trim().slice(0, 200);
  const phone = String(data.phone || '').trim().slice(0, 60);
  const message = String(data.message || '').trim().slice(0, 4000);
  if (!name && !email && !phone) {
    throw fail('VALIDATION', 'name, email, or phone required', 400);
  }
  const info = db.prepare(`
    INSERT INTO chatbot_leads (lead_id, session_id, name, email, phone, message, status)
    VALUES (?, ?, ?, ?, ?, ?, 'new')
  `).run(Number(leadId), sessionId, name, email, phone, message);

  if (sessionId) {
    addMessage(db, sessionId, leadId, 'system',
      'Thanks — we received your contact details and will follow up.');
  }

  const settings = getSettings(db, leadId);
  if (settings.escalate_notify_portal) {
    db.prepare(`
      INSERT INTO chatbot_escalations (lead_id, session_id, message, reason, status)
      VALUES (?, ?, ?, 'lead_capture', 'open')
    `).run(
      Number(leadId),
      sessionId,
      `Lead capture: ${[name, email, phone].filter(Boolean).join(' · ')}\n${message}`.slice(0, 4000)
    );
  }

  notifyClientAgent(db,
    `Chatbot lead captured for lead ${leadId} (session ${sessionId || 'n/a'}).`,
    { leadId, sessionId }
  );

  const business = loadBusinessSupportContext(db, leadId);
  let chatSummary = '';
  if (sessionId) {
    chatSummary = listMessages(db, sessionId, { limit: 30 })
      .filter((m) => m.role === 'visitor' || m.role === 'agent')
      .slice(-10)
      .map((m) => `${m.role === 'visitor' ? 'Visitor' : 'Chat'}: ${m.body}`)
      .join('\n');
  }

  return {
    lead: db.prepare('SELECT id, name, email, phone, message, status, created_at FROM chatbot_leads WHERE id = ?')
      .get(info.lastInsertRowid),
    message: 'Thanks — we will follow up shortly.',
    _notify: {
      leadId: Number(leadId),
      sessionId,
      name,
      email,
      phone,
      visitorMessage: message,
      chatSummary,
      business,
      escalateEmail: settings.escalate_email || '',
    },
  };
}

/**
 * Email + SMS the business owner after a visitor submits the chat contact form.
 * Fire-and-forget from the public route; never throws into the visitor response.
 */
async function notifyOwnerOnChatLead(workspaceId, payload = {}) {
  const out = { email: null, sms: null };
  try {
    const biz = payload.business || {};
    const bizName = biz.businessName || 'your business';
    const toEmail = String(payload.escalateEmail || biz.email || '').trim();
    const toPhone = String(biz.phone || '').trim();
    const visitorBits = [payload.name, payload.email, payload.phone].filter(Boolean).join(' · ');
    const need = String(payload.visitorMessage || '').trim()
      || String(payload.chatSummary || '').split('\n').filter((l) => /^Visitor:/i.test(l)).slice(-3).join(' | ')
      || '(see chat)';

    if (toEmail) {
      try {
        const mailer = require('./mailer');
        out.email = await mailer.sendPlatformMail({
          to: toEmail,
          subject: `New website chat lead — ${bizName}`,
          title: 'Someone left details in your website chat',
          paragraphs: [
            `A visitor on ${bizName}'s site asked for follow-up.`,
            `Contact: ${visitorBits || '(none)'}`,
            `What they need: ${need.slice(0, 800)}`,
            payload.chatSummary
              ? `Recent chat:\n${String(payload.chatSummary).slice(0, 1200)}`
              : '',
            'Please call or email them when you can — the chat bot told them a human would follow up.',
          ].filter(Boolean),
          text: [
            `New chat lead for ${bizName}`,
            `Contact: ${visitorBits}`,
            `Need: ${need}`,
            payload.chatSummary || '',
          ].filter(Boolean).join('\n\n'),
        });
      } catch (e) {
        out.email = { sent: false, error: e.message };
        try { process.stderr.write(`[chatbot-notify] email failed: ${e.message}\n`); } catch { /* ignore */ }
      }
    }

    if (toPhone) {
      try {
        const sms = require('../src/sms');
        const domain = require('./domain');
        const phone = sms.normalizePhone(toPhone);
        if (phone) {
          const settings = domain.withDb(workspaceId, (db) => {
            const rows = db.prepare('SELECT key, value FROM settings').all();
            const map = {};
            for (const r of rows) map[r.key] = r.value;
            return map;
          });
          const resolved = await sms.resolveSmsSettings(settings);
          const provider = sms.getSmsProvider(resolved, null);
          const body = sms.plainSmsBody(
            `${bizName}: new website chat lead — ${visitorBits || 'details in email'}. `
            + `Need: ${String(need).slice(0, 120)}. Please call them back.`
          );
          out.sms = await provider.send({ to: phone, body });
        }
      } catch (e) {
        out.sms = { ok: false, error: e.message };
        try { process.stderr.write(`[chatbot-notify] sms failed: ${e.message}\n`); } catch { /* ignore */ }
      }
    }
  } catch (e) {
    try { process.stderr.write(`[chatbot-notify] ${e.message}\n`); } catch { /* ignore */ }
  }
  return out;
}

/* ── Client MCP / portal agent surface ── */

function listPendingSessions(db, leadId, { limit = 10 } = {}) {
  ensureTables(db);
  const lim = Math.min(50, Math.max(1, Number(limit) || 10));
  const rows = db.prepare(`
    SELECT * FROM chatbot_sessions
    WHERE lead_id = ? AND needs_agent = 1 AND status = 'open'
    ORDER BY last_visitor_at ASC, id ASC
    LIMIT ?
  `).all(Number(leadId), lim);
  const sessions = rows.map((r) => {
    const messages = listMessages(db, r.id, { limit: 40 });
    return publicSession(r, { withMessages: true, messages });
  });
  const latestVisitor = sessions
    .flatMap((s) => (s.messages || []).filter((m) => m.role === 'visitor').map((m) => m.body))
    .slice(-3)
    .join(' ');
  return {
    total: rows.length,
    sessions,
    knowledge: knowledgeSnippets(db, leadId, { query: latestVisitor }),
    allowed_actions: listAllowedActions(db, leadId),
    hint: 'Reply with chatbot.reply (sessionId + message). Use knowledge snippets (query-ranked from uploaded docs). Escalate with chatbot.escalate when unsure. Module actions: use public bookings/forms endpoints listed in allowed_actions — never admin MCP tools.',
    boundary: 'portal_client_mcp_only',
  };
}

function claimNextSession(db, leadId) {
  const pending = listPendingSessions(db, leadId, { limit: 1 });
  const session = pending.sessions[0] || null;
  return {
    session,
    knowledge: pending.knowledge,
    allowed_actions: pending.allowed_actions,
    hint: pending.hint,
    boundary: 'portal_client_mcp_only',
  };
}

function agentReply(db, leadId, sessionId, message, meta = null, opts = {}) {
  ensureTables(db);
  const session = getSessionById(db, leadId, sessionId);
  if (!session) throw fail('NOT_FOUND', 'Session not found', 404);
  const ws = opts && opts.workspaceId != null ? Number(opts.workspaceId) : null;
  if (Number.isInteger(ws) && ws > 0) cancelAiFallbackReply(ws, session.id);
  const msg = addMessage(db, session.id, leadId, 'agent', message, meta);
  db.prepare(`
    UPDATE chatbot_sessions
    SET needs_agent = 0, last_agent_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(session.id);
  return {
    session: publicSession(getSessionById(db, leadId, session.id)),
    message: msg,
    boundary: 'portal_client_mcp_only',
  };
}

function escalateSession(db, leadId, { sessionId, message, reason } = {}) {
  ensureTables(db);
  const session = sessionId ? getSessionById(db, leadId, sessionId) : null;
  if (sessionId && !session) throw fail('NOT_FOUND', 'Session not found', 404);
  const text = String(message || '').trim().slice(0, 4000)
    || 'Agent requested human follow-up.';
  const why = String(reason || 'unsure').slice(0, 80);
  const info = db.prepare(`
    INSERT INTO chatbot_escalations (lead_id, session_id, message, reason, status)
    VALUES (?, ?, ?, ?, 'open')
  `).run(Number(leadId), session ? session.id : null, text, why);

  if (session) {
    addMessage(db, session.id, leadId, 'system',
      'I am connecting you with the team — feel free to leave your contact details.');
    addMessage(db, session.id, leadId, 'agent',
      'I want to make sure you get the right help. A team member will follow up, or you can leave your name and email below.');
    db.prepare(`
      UPDATE chatbot_sessions SET needs_agent = 0, updated_at = datetime('now') WHERE id = ?
    `).run(session.id);
  }

  return {
    escalation: db.prepare('SELECT * FROM chatbot_escalations WHERE id = ?').get(info.lastInsertRowid),
    suggest_lead_capture: getSettings(db, leadId).suggest_lead_capture,
    boundary: 'portal_client_mcp_only',
  };
}

function listEscalations(db, leadId, { status = 'open', limit = 50 } = {}) {
  ensureTables(db);
  const lim = Math.min(100, Math.max(1, Number(limit) || 50));
  let sql = 'SELECT * FROM chatbot_escalations WHERE lead_id = ?';
  const params = [Number(leadId)];
  if (status) {
    sql += ' AND status = ?';
    params.push(String(status));
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(lim);
  return db.prepare(sql).all(...params);
}

function resolveEscalation(db, leadId, id) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM chatbot_escalations WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
  if (!row) throw fail('NOT_FOUND', 'Escalation not found', 404);
  db.prepare(`
    UPDATE chatbot_escalations SET status = 'resolved', resolved_at = datetime('now')
    WHERE id = ? AND lead_id = ?
  `).run(row.id, Number(leadId));
  return db.prepare('SELECT * FROM chatbot_escalations WHERE id = ?').get(row.id);
}

function listChatLeads(db, leadId, { limit = 50 } = {}) {
  ensureTables(db);
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  return db.prepare(`
    SELECT id, session_id, name, email, phone, message, status, created_at
    FROM chatbot_leads WHERE lead_id = ? ORDER BY id DESC LIMIT ?
  `).all(Number(leadId), lim);
}

function portalChatbotSummary(db, leadId) {
  ensureTables(db);
  const modules = require('./siteModules');
  const emb = modules.getEmbedRow(db, Number(leadId), 'chatbot');
  return {
    settings: getSettings(db, leadId),
    knowledge: listKnowledge(db, leadId, { includeInactive: true }),
    embed: emb ? modules.publicEmbed(emb) : null,
    pending_sessions: db.prepare(
      "SELECT COUNT(*) AS c FROM chatbot_sessions WHERE lead_id = ? AND needs_agent = 1 AND status = 'open'"
    ).get(Number(leadId)).c,
    open_escalations: db.prepare(
      "SELECT COUNT(*) AS c FROM chatbot_escalations WHERE lead_id = ? AND status = 'open'"
    ).get(Number(leadId)).c,
    leads: listChatLeads(db, leadId, { limit: 20 }),
    escalations: listEscalations(db, leadId, { status: 'open', limit: 20 }),
    allowed_actions: listAllowedActions(db, leadId),
    agent_boundary: {
      mode: 'portal_client_mcp_only',
      tools: [
        'chatbot.pending', 'chatbot.next', 'chatbot.getSession', 'chatbot.reply',
        'chatbot.escalate', 'chatbot.knowledge.list', 'chatbot.knowledge.add',
        'chatbot.actions',
      ],
      forbidden: 'Admin MCP (lead.*, design.*, workspace tools) and workspace ws_ tokens must not be used for visitor chat.',
      actions: 'Bookings/forms/products via public module/form APIs listed in allowed_actions.',
    },
  };
}

/* ── Sitewide embed HTML ── */

function chatScriptTag(appUrl) {
  const base = String(appUrl || appBaseUrl()).replace(/\/$/, '');
  if (!base) return '';
  return (
    `<script src="${escapeAttr(base)}/js/chat-embed.js?v=${CHAT_SCRIPT_VER}" ` +
    `defer ${CHAT_SCRIPT_ATTR}="1"></script>`
  );
}

function chatEmbedBlockHtml(embed, appUrl) {
  const base = String(appUrl || appBaseUrl()).replace(/\/$/, '');
  const token = String(embed && embed.public_token || '');
  if (!/^\d+_[A-Za-z0-9_-]+$/.test(token)) return '';
  return (
    `<div class="bitpype-chat-embed" ${CHAT_ATTR}="1" ${CHAT_TOKEN_ATTR}="${escapeAttr(token)}" ` +
    `data-bitpype-api="${escapeAttr(base)}"></div>`
  );
}

function htmlHasChatToken(html, token) {
  const t = String(token || '').trim();
  if (!t) return false;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${CHAT_TOKEN_ATTR}\\s*=\\s*["']${esc}["']`, 'i').test(String(html || ''));
}

function stripChatEmbedsFromHtml(html, { keepToken } = {}) {
  let s = String(html || '');
  s = s.replace(
    /<div\b[^>]*\bdata-bitpype-chat\s*=\s*["']?1["']?[^>]*>[\s\S]*?<\/div>/gi,
    (block) => {
      if (keepToken && htmlHasChatToken(block, keepToken)) return block;
      return '';
    }
  );
  s = s.replace(
    /<div\b[^>]*\bdata-bitpype-chat\s*=\s*["']?1["']?[^>]*\/?>/gi,
    (block) => {
      if (keepToken && htmlHasChatToken(block, keepToken)) return block;
      return '';
    }
  );
  if (!keepToken || !htmlHasChatToken(s, keepToken)) {
    s = s.replace(
      new RegExp(`<script\\b[^>]*\\b${CHAT_SCRIPT_ATTR}\\b[^>]*>\\s*<\\/script>`, 'gi'),
      ''
    );
    s = s.replace(/<script\b[^>]*\/js\/chat-embed\.js[^>]*>\s*<\/script>/gi, '');
  }
  return s;
}

function ensureChatEmbedScript(html, appUrl) {
  const tag = chatScriptTag(appUrl);
  if (!tag) return String(html || '');
  let s = String(html || '');
  s = s.replace(
    new RegExp(`<script\\b[^>]*\\b${CHAT_SCRIPT_ATTR}\\b[^>]*>\\s*<\\/script>`, 'gi'),
    ''
  );
  s = s.replace(/<script\b[^>]*\/js\/chat-embed\.js[^>]*>\s*<\/script>/gi, '');
  if (/<\/body>/i.test(s)) return s.replace(/<\/body>/i, `${tag}\n</body>`);
  return `${s}\n${tag}`;
}

function injectChatOnPageHtml(html, block, appUrl) {
  let s = String(html || '');
  const chunk = String(block || '');
  const token = (chunk.match(new RegExp(`${CHAT_TOKEN_ATTR}\\s*=\\s*["']([^"']+)["']`, 'i')) || [])[1];
  if (token && htmlHasChatToken(s, token)) {
    return ensureChatEmbedScript(s, appUrl);
  }
  if (/<\/body>/i.test(s)) {
    s = s.replace(/<\/body>/i, `${chunk}\n</body>`);
  } else {
    s = `${s}\n${chunk}`;
  }
  return ensureChatEmbedScript(s, appUrl);
}

/**
 * Inject floating chatbot widget on every page (no nav page).
 * Called from siteModules.syncSiteModuleEmbeds when chatbot embed is active.
 */
function syncChatbotSitewide(db, leadId, pages, { appUrl } = {}) {
  ensureTables(db);
  const modules = require('./siteModules');
  const emb = modules.getEmbedRow(db, Number(leadId), 'chatbot');
  const active = !!(emb && emb.published && emb.embed_enabled && emb.public_token);
  const base = appUrl || appBaseUrl();
  const block = active ? chatEmbedBlockHtml(emb, base) : '';
  const token = active ? String(emb.public_token) : '';
  let touched = 0;

  for (const page of pages || []) {
    if (page && Array.isArray(page.sections) && page.sections.length) {
      let found = false;
      for (const sec of page.sections) {
        if (!sec || !sec.content || typeof sec.content.html !== 'string') continue;
        if (token && htmlHasChatToken(sec.content.html, token)) {
          sec.content.html = ensureChatEmbedScript(
            stripChatEmbedsFromHtml(sec.content.html, { keepToken: token }),
            base
          );
          found = true;
        } else {
          sec.content.html = stripChatEmbedsFromHtml(sec.content.html);
        }
      }
      if (active && !found) {
        const footerAt = page.sections.findIndex((s) => s && s.type === 'footer');
        const embedSec = {
          type: 'html',
          content: {
            html: ensureChatEmbedScript(block, base),
            bitpype_chat_managed: 1,
          },
        };
        // Prefer injecting into an existing freestyle body/html section before footer.
        let bodySec = page.sections.find((s) => s && s.type === 'html'
          && s.content && typeof s.content.html === 'string'
          && !s.content.bitpype_module_managed);
        if (!bodySec) {
          bodySec = page.sections.find((s) => s && s.type === 'html' && s.content);
        }
        if (bodySec && bodySec.content && typeof bodySec.content.html === 'string') {
          bodySec.content.html = injectChatOnPageHtml(bodySec.content.html, block, base);
        } else if (footerAt >= 0) {
          page.sections.splice(footerAt, 0, embedSec);
        } else {
          page.sections.push(embedSec);
        }
        touched += 1;
      } else if (!active) {
        page.sections = page.sections.filter((sec) => !(sec && sec.content && sec.content.bitpype_chat_managed));
      }
      if (typeof page.html === 'string') delete page.html;
    } else if (page && typeof page.html === 'string') {
      if (active) {
        const before = page.html;
        page.html = injectChatOnPageHtml(stripChatEmbedsFromHtml(page.html, { keepToken: token }), block, base);
        if (page.html !== before) touched += 1;
      } else {
        page.html = stripChatEmbedsFromHtml(page.html);
      }
    }
  }
  return { synced: true, sitewide: true, active, pagesTouched: touched };
}

const KNOWLEDGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Store one knowledge file under data/workspaces/{ws}/chatbot/{leadId}/ and extract text.
 * @returns {Promise<object>}
 */
async function storeKnowledgeUpload(workspaceId, leadId, { data, mimeType, fileName, title } = {}) {
  const extract = require('./chatbotKnowledgeExtract');
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length) throw fail('VALIDATION', 'file data required', 400);
  if (buf.length > KNOWLEDGE_MAX_BYTES) {
    throw fail('TOO_LARGE', 'Knowledge file max 5MB', 400);
  }
  const safeName = String(fileName || 'doc.txt')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 80) || 'doc.txt';
  const dir = path.join(process.cwd(), 'data', 'workspaces', String(workspaceId), 'chatbot', String(leadId));
  fs.mkdirSync(dir, { recursive: true });
  const stored = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
  const abs = path.join(dir, stored);
  fs.writeFileSync(abs, buf);

  const extracted = await extract.extractKnowledgeText(buf, {
    fileName: safeName,
    mimeType: mimeType || '',
  });
  let text = String(extracted.text || '');
  if (extracted.warning && !text) {
    text = `[Extraction note: ${extracted.warning}]`;
  } else if (extracted.warning && text) {
    text = `${text}\n\n[Extraction note: ${extracted.warning}]`.slice(0, extract.MAX_TEXT);
  }

  return {
    file_path: path.relative(process.cwd(), abs).replace(/\\/g, '/'),
    file_name: safeName,
    content_text: text,
    title: title || safeName.replace(/\.[^.]+$/, '').replace(/_/g, ' ') || safeName,
    extractor: extracted.extractor || 'none',
    extract_warning: extracted.warning || null,
    bytes: buf.length,
    mime_type: String(mimeType || ''),
  };
}

/**
 * Upload one or many knowledge files. Body may be a single file or { files: [...] }.
 */
async function storeKnowledgeUploads(workspaceId, leadId, body = {}) {
  const list = Array.isArray(body.files) && body.files.length
    ? body.files
    : (body.data ? [body] : []);
  if (!list.length) throw fail('VALIDATION', 'file data or files[] required', 400);
  if (list.length > 20) throw fail('VALIDATION', 'Max 20 files per upload', 400);
  const results = [];
  for (const file of list) {
    const stored = await storeKnowledgeUpload(workspaceId, leadId, {
      data: file.data,
      mimeType: file.mimeType || file.mime_type,
      fileName: file.fileName || file.file_name || file.name,
      title: file.title || body.title,
    });
    results.push(stored);
  }
  return results;
}

module.exports = {
  CHAT_SCRIPT_VER,
  CHAT_ATTR,
  CHAT_TOKEN_ATTR,
  CHAT_SCRIPT_ATTR,
  DEFAULT_SETTINGS,
  ensureTables,
  getSettings,
  saveSettings,
  listKnowledge,
  getKnowledge,
  addKnowledge,
  updateKnowledge,
  deleteKnowledge,
  knowledgeSnippets,
  getPublicConfigByToken,
  listAllowedActions,
  postVisitorMessage,
  getSessionHistory,
  captureLead,
  notifyOwnerOnChatLead,
  listPendingSessions,
  claimNextSession,
  agentReply,
  cancelAiFallbackReply,
  claimNeedsAgent,
  escalateSession,
  listEscalations,
  resolveEscalation,
  listChatLeads,
  portalChatbotSummary,
  chatScriptTag,
  chatEmbedBlockHtml,
  htmlHasChatToken,
  stripChatEmbedsFromHtml,
  ensureChatEmbedScript,
  syncChatbotSitewide,
  storeKnowledgeUpload,
  storeKnowledgeUploads,
  KNOWLEDGE_MAX_BYTES,
  notifyClientAgent,
  resolveEmbedForLead,
  listMessages,
  getSessionById,
  getSessionByToken,
  startOrGetSession,
  publicSession,
  scheduleAiFallbackReply,
  runAiFallbackReply,
  parseAiFallbackResponse,
  isGreetingOnly,
  visitorStatedNeed,
  loadBusinessSupportContext,
  leadCaptureThanksFor,
  LEAD_CAPTURE_THANKS,
  LEAD_CAPTURE_SYSTEM,
};
