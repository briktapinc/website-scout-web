'use strict';

// System IPC channels (Workstream 5): settings, secrets, prompt library,
// AI usage, automation kill switch, and activity log.
// src/db.js and src/ai.js are owned by other workstreams; they are loaded
// defensively here and everything degrades gracefully when absent.

const path = require('path');

// ---------------------------------------------------------------------------
// Settings keys
// ---------------------------------------------------------------------------

// Secrets may ONLY be written via settings:setSecret and are never returned
// in cleartext by settings:getAll (they come back as "***" when set).
const SECRET_KEYS = ['ai.api_key', 'smtp.pass', 'mail.imap.pass', 'cf.api_token', 'pexels.api_key', 'mcp.http_token', 'providers.tavily.api_key', 'fal.api_key', 'meta.app_secret', 'sms.auth_token', 'sms.api_key', 'design.agent_webhook_secret'];

// Keys writable via settings:set (secrets and automation_paused excluded).
const SETTABLE_KEYS = [
  'ai.base_url',
  'ai.model.default',
  'ai.model.research',
  'ai.model.generation',
  'ai.model.scoring',
  'ai.model.email',
  'ai.model.qa',
  'ai.model.editor',
  'ai.model.followup',
  'ai.model.image',
  'ai.model.vision',
  'cost.daily_budget_usd',
  'cost.per_1k_prompt',
  'cost.per_1k_completion',
  'cost.max_websites_per_day',
  'cost.max_outreach_per_day',
  'smtp.host',
  'smtp.port',
  'smtp.secure',
  'smtp.user',
  'smtp.from_name',
  'smtp.from_email',
  'mail.footer',
  'mail.inbound_drop_dir',
  'mail.imap.enabled',
  'mail.imap.host',
  'mail.imap.port',
  'mail.imap.secure',
  'mail.imap.user',
  'mail.imap.mailbox',
  'mail.imap.auto_submit',
  'score.threshold_qualified',
  'score.threshold_hot',
  'app.name',
  'cf.account_id',
  'cf.project',
  'cf.preview_domain',
  'mcp.public_url',
  'mcp.http_port',
  'providers.tavily.search_depth',
  'design.agent_notify',
  'design.agent_trigger_command',
  'design.agent_trigger_file',
  'design.agent_webhook_url',
  'design.agent_webhook_secret',
  'design.learning.enabled',
  'design.learning.max_playbook',
  'meta.app_id',
  'social.image_price_usd',
  'sms.enabled',
  'sms.provider',
  'sms.account_sid',
  'sms.from_number',
  'sms.webhook_url',
  'hands_off.enabled',
  'hands_off.min_score',
  'hands_off.max_sites_per_day',
  'hands_off.report_email',
  'hands_off.followup_days',
  'hands_off.template_id',
  'hands_off.channel',
];

const TASK_KEYS = ['research', 'generation', 'scoring', 'email', 'qa', 'editor', 'followup', 'image', 'vision'];

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function isNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return true;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return true;
  return false;
}
function toNum(v) { return Number(v); }
function toInt(v) { const n = Number(v); return Number.isInteger(n) ? n : null; }
function isHttpUrl(v) {
  if (typeof v !== 'string' || v.length > 500) return false;
  try { const u = new URL(v.trim()); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}
function isEmail(v) {
  return typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

// Returns {ok:true, value} with a normalized string, or {ok:false, error}.
function validateSetting(key, raw) {
  const value = raw == null ? '' : String(raw);
  if (!SETTABLE_KEYS.includes(key)) {
    return { ok: false, error: `Setting "${key}" is not writable via settings:set.` };
  }
  const fail = (why) => ({ ok: false, error: `Invalid value for ${key}: ${why}` });
  switch (key) {
    case 'ai.base_url':
      if (!isHttpUrl(value)) return fail('must be an http(s) URL');
      return { ok: true, value: value.trim() };
    case 'ai.model.default':
    case 'ai.model.research':
    case 'ai.model.generation':
    case 'ai.model.scoring':
    case 'ai.model.email':
    case 'ai.model.qa':
    case 'ai.model.editor':
    case 'ai.model.followup':
    case 'ai.model.image':
    case 'ai.model.vision':
      if (value.length > 200) return fail('must be 200 chars or fewer');
      if (key === 'ai.model.default' && value.trim() === '') return fail('default model may not be empty');
      return { ok: true, value: value.trim() };
    case 'cost.daily_budget_usd':
      if (!isNum(value)) return fail('must be a number');
      if (toNum(value) < 0 || toNum(value) > 100000) return fail('must be between 0 and 100000');
      return { ok: true, value: String(toNum(value)) };
    case 'cost.per_1k_prompt':
    case 'cost.per_1k_completion':
      if (!isNum(value)) return fail('must be a number');
      if (toNum(value) < 0 || toNum(value) > 100) return fail('must be between 0 and 100');
      return { ok: true, value: String(toNum(value)) };
    case 'cost.max_websites_per_day': {
      const n = toInt(value);
      if (n === null || n < 0 || n > 100000) return fail('must be an integer between 0 and 100000');
      return { ok: true, value: String(n) };
    }
    case 'cost.max_outreach_per_day': {
      const n = toInt(value);
      if (n === null || n < 0 || n > 1000000) return fail('must be an integer between 0 and 1000000');
      return { ok: true, value: String(n) };
    }
    case 'smtp.host':
      if (value.length > 255) return fail('must be 255 chars or fewer');
      if (value && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.trim())) return fail('not a valid hostname');
      return { ok: true, value: value.trim() };
    case 'smtp.port': {
      const n = toInt(value);
      if (n === null || n < 1 || n > 65535) return fail('must be an integer port 1-65535');
      return { ok: true, value: String(n) };
    }
    case 'smtp.secure': {
      const v = String(value).trim().toLowerCase();
      if (['1', 'true', 'yes'].includes(v)) return { ok: true, value: '1' };
      if (['0', 'false', 'no', ''].includes(v)) return { ok: true, value: '0' };
      return fail('must be boolean-like (0/1)');
    }
    case 'smtp.user':
    case 'smtp.from_name':
      if (value.length > 255) return fail('must be 255 chars or fewer');
      return { ok: true, value: value.trim() };
    case 'smtp.from_email':
      if (value.trim() !== '' && !isEmail(value)) return fail('must be a valid email address or empty');
      return { ok: true, value: value.trim() };
    case 'mail.footer':
      if (value.length > 5000) return fail('must be 5000 chars or fewer');
      return { ok: true, value };
    case 'mail.inbound_drop_dir':
      if (value.length > 500) return fail('must be 500 chars or fewer');
      return { ok: true, value: value.trim() };
    case 'mail.imap.enabled':
    case 'mail.imap.secure':
    case 'mail.imap.auto_submit': {
      const v = String(value).trim().toLowerCase();
      if (['1', 'true', 'yes'].includes(v)) return { ok: true, value: '1' };
      if (['0', 'false', 'no', ''].includes(v)) return { ok: true, value: '0' };
      return fail('must be boolean-like (0/1)');
    }
    case 'mail.imap.host':
      if (value.length > 255) return fail('must be 255 chars or fewer');
      if (value && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.trim())) return fail('not a valid hostname');
      return { ok: true, value: value.trim() };
    case 'mail.imap.port': {
      const n = toInt(value);
      if (n === null || n < 1 || n > 65535) return fail('must be an integer port 1-65535');
      return { ok: true, value: String(n) };
    }
    case 'mail.imap.user':
    case 'mail.imap.mailbox':
      if (value.length > 255) return fail('must be 255 chars or fewer');
      return { ok: true, value: value.trim() };
    case 'score.threshold_qualified':
    case 'score.threshold_hot': {
      const n = toInt(value);
      if (n === null || n < 0 || n > 100) return fail('must be an integer 0-100');
      return { ok: true, value: String(n) };
    }
    case 'app.name':
      if (value.length > 100) return fail('must be 100 chars or fewer');
      return { ok: true, value: value.trim() || 'Bitpype' };
    case 'cf.account_id':
      if (value.trim() !== '' && !/^[0-9a-fA-F]{32}$/.test(value.trim())) {
        return fail('must be a 32-character hex account ID or empty');
      }
      return { ok: true, value: value.trim() };
    case 'cf.project':
      if (value.trim() !== '' && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(value.trim())) {
        return fail('must be lowercase letters, numbers, hyphens (max 63 chars) or empty');
      }
      return { ok: true, value: value.trim() };
    case 'cf.preview_domain':
      if (value.length > 253) return fail('must be 253 chars or fewer');
      if (value.trim() !== '' && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(value.trim())) {
        return fail('must be a valid domain name or empty');
      }
      return { ok: true, value: value.trim() };
    case 'mcp.public_url': {
      const n = require('../mcpRemote').normalizePublicUrl(value);
      if (!n.ok) return fail(n.error);
      return { ok: true, value: n.value };
    }
    case 'mcp.http_port': {
      const n = toInt(value);
      if (n === null || n < 1 || n > 65535) return fail('must be an integer port 1-65535');
      return { ok: true, value: String(n) };
    }
    case 'providers.tavily.search_depth': {
      const v = value.trim().toLowerCase();
      if (v === 'basic' || v === 'advanced') return { ok: true, value: v };
      return fail('must be "basic" or "advanced"');
    }
    case 'design.agent_notify': {
      const v = String(value).trim().toLowerCase();
      if (['1', 'true', 'yes'].includes(v)) return { ok: true, value: '1' };
      if (['0', 'false', 'no', ''].includes(v)) return { ok: true, value: '0' };
      return fail('must be boolean-like (0/1)');
    }
    case 'design.agent_trigger_command':
      if (value.length > 2000) return fail('must be 2000 chars or fewer');
      if (value.includes('\0')) return fail('must not contain null bytes');
      return { ok: true, value };
    case 'design.agent_trigger_file':
      if (value.length > 500) return fail('must be 500 chars or fewer');
      if (value.includes('\0')) return fail('must not contain null bytes');
      return { ok: true, value: value.trim() };
    case 'design.agent_webhook_url': {
      const v = value.trim();
      if (v === '') return { ok: true, value: '' };
      if (!isHttpUrl(v)) return fail('must be an http(s) URL or empty');
      return { ok: true, value: v };
    }
    case 'design.agent_webhook_secret':
      if (value.length > 500) return fail('must be 500 chars or fewer');
      if (value.includes('\0')) return fail('must not contain null bytes');
      return { ok: true, value: value.trim() };
    case 'design.learning.enabled': {
      const v = String(value).trim().toLowerCase();
      if (['1', 'true', 'yes'].includes(v)) return { ok: true, value: '1' };
      if (['0', 'false', 'no', ''].includes(v)) return { ok: true, value: '0' };
      return fail('must be boolean-like (0/1)');
    }
    case 'design.learning.max_playbook': {
      const n = toInt(value);
      if (n === null || n < 4 || n > 60) return fail('must be an integer between 4 and 60');
      return { ok: true, value: String(n) };
    }
    case 'meta.app_id':
      if (value.length > 64) return fail('must be 64 chars or fewer');
      if (value.trim() !== '' && !/^\d+$/.test(value.trim())) return fail('must be a numeric Meta App ID or empty');
      return { ok: true, value: value.trim() };
    case 'hands_off.enabled': {
      const v = String(value).trim().toLowerCase();
      if (['1', 'true', 'yes'].includes(v)) return { ok: true, value: '1' };
      if (['0', 'false', 'no', ''].includes(v)) return { ok: true, value: '0' };
      return fail('must be boolean-like (0/1)');
    }
    case 'hands_off.min_score': {
      const n = toInt(value);
      if (n === null || n < 0 || n > 100) return fail('must be an integer 0-100');
      return { ok: true, value: String(n) };
    }
    case 'hands_off.max_sites_per_day': {
      const n = toInt(value);
      if (n === null || n < 0 || n > 1000) return fail('must be an integer between 0 and 1000');
      return { ok: true, value: String(n) };
    }
    case 'hands_off.report_email':
      if (value.trim() !== '' && !isEmail(value)) return fail('must be a valid email address or empty');
      return { ok: true, value: value.trim() };
    case 'hands_off.followup_days': {
      const n = toInt(value);
      if (n === null || n < 1 || n > 90) return fail('must be an integer between 1 and 90');
      return { ok: true, value: String(n) };
    }
    case 'hands_off.template_id': {
      if (value.trim() === '') return { ok: true, value: '' };
      const n = toInt(value);
      if (n === null || n < 1) return fail('must be a positive integer or empty');
      return { ok: true, value: String(n) };
    }
    case 'hands_off.channel': {
      const v = String(value).trim().toLowerCase();
      if (['email', 'sms', 'both', ''].includes(v)) return { ok: true, value: v || 'both' };
      return fail('must be email, sms, or both');
    }
    default:
      return { ok: false, error: `No validator for setting "${key}".` };
  }
}

// ---------------------------------------------------------------------------
// Seed prompt bodies (fallback if src/seed.js is unavailable — owned by
// another workstream). Prompts are system instructions, not secrets.
// ---------------------------------------------------------------------------

const FALLBACK_PROMPTS = {
  research_lead: {
    name: 'Research lead',
    body: 'You are a business research assistant. Given a local business name, category, and location, summarize only FACTS you are confident about: services offered, hours, contact details, and online presence. Never invent facts. If you do not know something, say UNKNOWN rather than guessing. Return a short JSON object with fields: services[], hours, phone, email, website, socials[], summary, confidence (high|medium|low).',
  },
  score_lead: {
    name: 'Score lead',
    body: 'You are a lead-scoring assistant for a website sales agency. Given a business profile (category, rating, review count, has website or not, location), output a score 0-100 and a brief breakdown of positive and negative signals as JSON: {score, breakdown: {signal: points}}. Do not invent data that was not provided.',
  },
  build_website: {
    name: 'Build website',
    body: 'You are a web designer generating a small-business website as structured JSON: {pages: [{slug, title, sections: [{type, heading, body}]}]}. Use ONLY facts provided in the brief. Mark every factual claim with claim_class: VERIFIED (from business data), OWNER_PROVIDED (owner told us), or AI_COPY (marketing filler). Never present AI_COPY as fact. Keep copy friendly and concise.',
  },
  qa_website: {
    name: 'QA website',
    body: 'You are a QA reviewer for generated small-business websites. Check the provided site JSON for: placeholder text left behind, factual claims without a VERIFIED/OWNER_PROVIDED source, broken structure, missing contact info, and mobile-hostile layouts. Return JSON: {pass: boolean, issues: [{severity, page, detail}]}.',
  },
  write_outreach: {
    name: 'Write outreach',
    body: 'You are writing a short cold email for a website agency to a local business owner. Personalize only with provided facts. Keep it under 120 words, one clear call to action (view their free website preview). No hype, no false claims, no fake testimonials. Return JSON: {subject, body}.',
  },
  follow_up: {
    name: 'Follow-up email',
    body: 'You are writing a brief follow-up email (max 80 words) referencing the earlier preview we sent. One call to action. Do not claim anything not in the provided facts. Return JSON: {subject, body}.',
  },
  site_editor: {
    name: 'Site editor',
    body: 'You are a precise website editor. Apply the requested change to the provided site JSON with the smallest possible diff. Do not invent new business facts. If the request needs a fact you do not have, leave a clearly-marked [NEEDS INFO] placeholder instead of guessing. Return JSON: {pages, theme, summary}.',
  },
};

function getSeedPrompts() {
  try {
    const seed = require('../seed.js'); // owned by another workstream
    if (seed && Array.isArray(seed.PROMPT_SEEDS) && seed.PROMPT_SEEDS.length) {
      return seed.PROMPT_SEEDS;
    }
  } catch { /* seed.js not ready yet — use fallback */ }
  return Object.entries(FALLBACK_PROMPTS).map(([key, p]) => ({ key, name: p.name, body: p.body }));
}

function seedBodyFor(key) {
  const found = getSeedPrompts().find((p) => p.key === key);
  return found ? found.body : null;
}

// ---------------------------------------------------------------------------
// Channel registration
// ---------------------------------------------------------------------------

function register(ipcMain, db) {
  const needDb = () => {
    if (!db) throw new Error('Database is not ready yet.');
  };
  const getSetting = (key) => {
    needDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  };
  const setSetting = (key, value) => {
    needDb();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  };
  const logActivity = (area, message) => {
    needDb();
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(area, String(message).slice(0, 2000));
  };

  // -- settings:getAll ------------------------------------------------------
  ipcMain.handle('settings:getAll', () => {
    needDb();
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const r of rows) {
      out[r.key] = SECRET_KEYS.includes(r.key) && r.value ? '***' : r.value;
    }
    return out;
  });

  // -- settings:set ---------------------------------------------------------
  ipcMain.handle('settings:set', (_evt, { key, value } = {}) => {
    const v = validateSetting(String(key || ''), value);
    if (!v.ok) throw new Error(v.error);
    setSetting(String(key), v.value);
    // Cross-field check: qualified threshold must stay below hot threshold.
    const q = parseInt(getSetting('score.threshold_qualified'), 10);
    const h = parseInt(getSetting('score.threshold_hot'), 10);
    if (Number.isInteger(q) && Number.isInteger(h) && q >= h) {
      throw new Error('score.threshold_qualified must be lower than score.threshold_hot.');
    }
    logActivity('settings', `Setting updated: ${key}`);
    return { ok: true, key, value: v.value };
  });

  // -- settings:setSecret ---------------------------------------------------
  ipcMain.handle('settings:setSecret', (_evt, { key, value } = {}) => {
    key = String(key || '');
    if (!SECRET_KEYS.includes(key)) {
      throw new Error(`"${key}" is not a secret setting. Use settings:set for regular settings.`);
    }
    const v = value == null ? '' : String(value);
    if (v.length > 2000) throw new Error('Secret value is too long (max 2000 chars).');
    setSetting(key, v);
    logActivity('settings', `Secret updated: ${key} (value redacted)`);
    return { ok: true, key, set: v !== '' };
  });

  // -- prompts:list ----------------------------------------------------------
  ipcMain.handle('prompts:list', () => {
    needDb();
    return db.prepare('SELECT key, name, body, updated_at FROM prompts ORDER BY key').all();
  });

  // -- prompts:save ----------------------------------------------------------
  ipcMain.handle('prompts:save', (_evt, { key, body } = {}) => {
    key = String(key || '');
    body = body == null ? '' : String(body);
    const seeds = getSeedPrompts();
    if (!seeds.some((p) => p.key === key)) throw new Error(`Unknown prompt key "${key}".`);
    if (body.trim() === '') throw new Error('Prompt body may not be empty.');
    if (body.length > 20000) throw new Error('Prompt body is too long (max 20000 chars).');
    needDb();
    db.prepare("UPDATE prompts SET body = ?, updated_at = datetime('now') WHERE key = ?").run(body, key);
    logActivity('prompts', `Prompt saved: ${key}`);
    return { ok: true, key };
  });

  // -- prompts:reset ---------------------------------------------------------
  ipcMain.handle('prompts:reset', (_evt, key = '') => {
    key = String(key || '');
    const body = seedBodyFor(key);
    if (body == null) throw new Error(`Unknown prompt key "${key}".`);
    needDb();
    db.prepare("UPDATE prompts SET body = ?, updated_at = datetime('now') WHERE key = ?").run(body, key);
    logActivity('prompts', `Prompt restored to seed default: ${key}`);
    return { ok: true, key };
  });

  // -- ai:status -------------------------------------------------------------
  ipcMain.handle('ai:status', () => {
    needDb();
    try {
      const ai = require('../ai');
      if (typeof ai.setDb === 'function') ai.setDb(db);
      const configured = !!(ai.aiConfigured && ai.aiConfigured());
      const modelImage = getSetting('ai.model.image') || 'gpt-image-2.5-sunburst';
      const modelDefault = getSetting('ai.model.default') || 'gpt-4o-mini';
      return { ok: true, configured, modelImage, modelDefault };
    } catch (e) {
      return { ok: false, configured: false, error: e.message || String(e) };
    }
  });

  // -- ai:usage --------------------------------------------------------------
  ipcMain.handle('ai:usage', (_evt, { days } = {}) => {
    needDb();
    let d = days == null ? 30 : parseInt(days, 10);
    if (!Number.isInteger(d) || d < 1 || d > 365) throw new Error('days must be an integer 1-365.');
    const byTask = db.prepare(`
      SELECT task,
             COUNT(*) AS calls,
             SUM(prompt_tokens) AS prompt_tokens,
             SUM(completion_tokens) AS completion_tokens,
             ROUND(SUM(cost_usd), 4) AS cost_usd
      FROM ai_usage
      WHERE at >= datetime('now', '-' || ? || ' days')
      GROUP BY task ORDER BY cost_usd DESC
    `).all(d);
    const today = db.prepare(`
      SELECT ROUND(COALESCE(SUM(cost_usd), 0), 4) AS c FROM ai_usage
      WHERE date(at) = date('now', 'localtime')
    `).get().c;
    const month = db.prepare(`
      SELECT ROUND(COALESCE(SUM(cost_usd), 0), 4) AS c FROM ai_usage
      WHERE strftime('%Y-%m', at) = strftime('%Y-%m', 'now', 'localtime')
    `).get().c;
    return { days: d, byTask, todayUsd: today, monthUsd: month };
  });

  // -- automation:pause / automation:resume -----------------------------------
  ipcMain.handle('automation:pause', () => {
    setSetting('automation_paused', '1');
    logActivity('automation', 'Automation PAUSED (kill switch engaged). Scanning, generation, campaigns, follow-ups and AI actions stopped.');
    return { ok: true, paused: true };
  });
  ipcMain.handle('automation:resume', () => {
    setSetting('automation_paused', '0');
    logActivity('automation', 'Automation RESUMED by user.');
    return { ok: true, paused: false };
  });

  // -- activity:recent --------------------------------------------------------
  ipcMain.handle('activity:recent', (_evt, args = {}) => {
    needDb();
    const { pageArgs, pageResult } = require('../paginate');
    // Back-compat: { limit } alone = first page of that size.
    const opts = args || {};
    const paging = pageArgs(
      { page: opts.page || 1, pageSize: opts.pageSize != null ? opts.pageSize : (opts.limit || 50) },
      { pageSize: 50, maxSize: 200 }
    );
    const total = db.prepare('SELECT COUNT(*) AS c FROM activity_log').get().c;
    const rows = db.prepare(
      'SELECT id, area, message, at FROM activity_log ORDER BY id DESC LIMIT ? OFFSET ?'
    ).all(paging.pageSize, paging.offset);
    return Object.assign({ rows }, pageResult(rows, total, paging.page, paging.pageSize));
  });

  // -- mcp:setup --------------------------------------------------------------
  // Describes the stdio server so any MCP client can connect. Does not start
  // the server (that process owns stdin). Also returns Tailscale HTTP details.
  ipcMain.handle('mcp:setup', async () => {
    needDb();
    const catalog = require('../mcpCatalog');
    const mcpRemote = require('../mcpRemote');
    const script = path.resolve(__dirname, '..', 'mcp.js');
    const dbPath = db && typeof db.name === 'string' && db.name ? path.resolve(db.name) : '';
    const entry = {
      command: 'node',
      args: [script],
      env: { WS_DB_PATH: dbPath },
    };
    const quote = (value) => JSON.stringify(String(value));
    const examples = [
      {
        title: 'Cursor, Claude Desktop, Windsurf',
        note: 'The same command, args, and env, under mcpServers.',
        body: JSON.stringify({ mcpServers: { 'website-scout': entry } }, null, 2),
      },
      {
        title: 'VS Code',
        note: 'The same stdio server, under servers, with type stdio.',
        body: JSON.stringify({
          servers: { 'website-scout': { type: 'stdio', ...entry } },
        }, null, 2),
      },
      {
        title: 'Codex',
        note: 'The same command as a stdio server entry in config.toml.',
        body: [
          '[mcp_servers.website-scout]',
          `command = ${quote(entry.command)}`,
          `args = [${entry.args.map(quote).join(', ')}]`,
          '',
          '[mcp_servers.website-scout.env]',
          `WS_DB_PATH = ${quote(dbPath)}`,
        ].join('\n'),
      },
    ];
    let recent = [];
    try {
      recent = db.prepare(`
        SELECT id, area, message, at FROM activity_log
        WHERE area = 'mcp' OR message LIKE '%via MCP%'
        ORDER BY id DESC LIMIT 15
      `).all();
    } catch { recent = []; }
    const versions = Array.isArray(catalog.protocolVersions) && catalog.protocolVersions.length
      ? catalog.protocolVersions
      : [catalog.protocolVersion];
    const remote = await mcpRemote.connectionInfo(db);
    return {
      server: catalog.server,
      protocolVersion: catalog.protocolVersion,
      protocolVersions: versions,
      transport: 'stdio',
      framing: 'newline-delimited JSON-RPC 2.0',
      script,
      dbPath,
      command: entry.command,
      args: entry.args,
      env: entry.env,
      config: JSON.stringify(entry, null, 2),
      examples,
      tools: catalog.tools,
      recent,
      remote,
      notes: [
        'Local: newline-delimited JSON-RPC 2.0 over stdin/stdout. Any MCP client starts it.',
        'Remote (Tailscale): start the HTTP listener on this page, then use the Tailscale URL + Bearer token from another device on your tailnet.',
        'WS_DB_PATH must be the desktop app database. Without it, the server uses ~/.config/Website Scout/websitescout.db, which is a different file on Windows.',
        'initialize echoes the client’s protocolVersion when this server supports it (' + versions[0] + ' through ' + versions[versions.length - 1] + ').',
        'Queuing waiting_on_agent (assign / redesign / improve / email submit) writes the optional agent trigger file and may desktop-notify or run Settings → Design agent command. Redesign/improvements also POST design.agent_webhook_url when set. Use design.agentTrigger for path/status; claim work with design.next.',
        'design.review returns screenshot paths only (no base64). design.emailRedesign covers paste/drop inbound change requests — IMAP is not wired yet.',
        'design.lessons exposes the learning playbook/events; briefs include learned_lessons when Settings → Design learning is on.',
        'email.send and other autonomous tools honor the kill switch, the suppression list, and the daily caps from Settings.',
        'Secrets are redacted in the MCP activity log. The HTTP bearer token is stored in Settings as mcp.http_token.',
      ],
    };
  });

  ipcMain.handle('mcp:httpStart', async () => {
    needDb();
    const mcpRemote = require('../mcpRemote');
    const result = await mcpRemote.start(db);
    const remote = await mcpRemote.connectionInfo(db);
    return { ...result, remote };
  });
  ipcMain.handle('mcp:httpStop', () => {
    needDb();
    return require('../mcpRemote').stop();
  });
  ipcMain.handle('mcp:httpStatus', async () => {
    needDb();
    const mcpRemote = require('../mcpRemote');
    const remote = await mcpRemote.connectionInfo(db);
    const http = remote.http || {};
    const health = { ok: !!http.healthOk };
    return {
      running: http.running,
      pid: http.pid,
      port: http.port,
      publicUrl: http.publicUrl,
      tokenSet: http.tokenSet,
      token: http.token,
      startedAt: http.startedAt,
      lastExit: http.lastExit,
      health,
      listening: http.listening,
      listenerSource: http.listenerSource,
      remote,
    };
  });
  ipcMain.handle('mcp:httpRotateToken', async () => {
    needDb();
    const mcpRemote = require('../mcpRemote');
    const result = await mcpRemote.rotateToken(db);
    const remote = await mcpRemote.connectionInfo(db);
    return { ...result, remote };
  });
  ipcMain.handle('mcp:setPublicUrl', async (_evt, args = {}) => {
    needDb();
    const mcpRemote = require('../mcpRemote');
    const result = mcpRemote.setPublicUrl(db, args && args.url != null ? args.url : args);
    const remote = await mcpRemote.connectionInfo(db);
    return { ...result, remote };
  });
  ipcMain.handle('mcp:setListenPort', async (_evt, args = {}) => {
    needDb();
    const mcpRemote = require('../mcpRemote');
    const result = mcpRemote.setListenPort(db, args && args.port != null ? args.port : args);
    const remote = await mcpRemote.connectionInfo(db);
    return { ...result, remote };
  });
}

// Stop HTTP MCP when the app is quitting (best-effort, once).
let quitHooked = false;
function hookQuit() {
  if (quitHooked) return;
  try {
    const { app } = require('electron');
    if (app && typeof app.on === 'function') {
      quitHooked = true;
      app.on('before-quit', () => {
        try { require('../mcpRemote').stop(); } catch { /* ignore */ }
      });
    }
  } catch { /* not in Electron */ }
}
hookQuit();

module.exports = { register, SETTABLE_KEYS, SECRET_KEYS, TASK_KEYS, validateSetting };
