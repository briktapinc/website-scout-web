'use strict';
/**
 * email.js — mail provider abstraction for Website Scout (single-user desktop app).
 *
 * Providers:
 *   - SmtpProvider : minimal SMTP client over node:net / node:tls
 *                    (EHLO, STARTTLS, AUTH LOGIN, MAIL FROM, RCPT TO, DATA).
 *                    No third-party mail dependencies.
 *   - StubProvider  : used when smtp.host is empty. Logs to activity_log and
 *                    reports the message as "sent" without touching the network.
 *
 * Also: personalize() — template variable substitution restricted to verified
 * business facts and lead columns. Unknown variables become an empty string;
 * facts are NEVER invented.
 *
 * No secrets live in this file. Credentials come from the settings store.
 */

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CONNECT_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 30000;

/** True when value is a syntactically plausible email address. */
function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

/**
 * Pull the smtp.* / mail.* settings out of a flat settings object
 * (keys like 'smtp.host', 'smtp.port', ...).
 */
function readSmtpConfig(settings) {
  const get = (k, dflt = '') => {
    const v = settings && settings[k];
    return v === undefined || v === null ? dflt : String(v).trim();
  };
  const portRaw = get('smtp.port', '');
  const secureRaw = get('smtp.secure', '').toLowerCase();
  const secure = secureRaw === '1' || secureRaw === 'true' || secureRaw === 'yes';
  return {
    host: get('smtp.host'),
    port: portRaw ? parseInt(portRaw, 10) : (secure ? 465 : 587),
    secure,
    user: get('smtp.user'),
    pass: get('smtp.pass'),
    fromName: get('smtp.from_name'),
    fromEmail: get('smtp.from_email'),
  };
}

/** Returns an array of human-readable config problems (empty = OK). */
function validateSmtpConfig(cfg) {
  const errors = [];
  if (!cfg.host) errors.push('smtp.host is empty');
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    errors.push('smtp.port must be 1-65535');
  }
  if (!isValidEmail(cfg.fromEmail)) errors.push('smtp.from_email is not a valid email address');
  if (cfg.user && !cfg.pass) errors.push('smtp.user is set but smtp.pass is empty');
  return errors;
}

/** Build a multipart/alternative MIME message. Handles dot-stuffing. */
function buildMime({ fromName, fromEmail, to, subject, html, text }) {
  const boundary = 'ws_' + crypto.randomBytes(12).toString('hex');
  const date = new Date().toUTCString();
  const msgId = `<${crypto.randomBytes(16).toString('hex')}@${fromEmail.split('@')[1] || 'localhost'}>`;
  const from = fromName ? `"${fromName.replace(/["\\]/g, '')}" <${fromEmail}>` : fromEmail;
  const plain = (text && text.trim()) ? text : stripHtml(html || '');
  const htmlPart = (html && html.trim()) ? html : `<pre>${escapeHtml(plain)}</pre>`;

  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject || '')}`,
    `Date: ${date}`,
    `Message-ID: ${msgId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    plain,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    htmlPart,
    '',
    `--${boundary}--`,
    '',
  ];
  // SMTP dot-stuffing: lines starting with '.' get an extra dot.
  return lines.join('\r\n').replace(/^\./gm, '..');
}

function encodeSubject(s) {
  // RFC 2047 for non-ASCII subjects.
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

function stripHtml(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Minimal line-oriented SMTP conversation driver. */
class SmtpClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.socket = null;
    this.buffer = '';
    this.pending = null; // {resolve, reject, timer}
  }

  _onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this._onLine(line);
    }
  }

  _onLine(line) {
    if (!this.pending) return; // unsolicited greeting handled by initial read
    this.pending.lines.push(line);
    const m = /^(\d{3})([ -])/.exec(line);
    if (!m) return;
    if (m[2] === ' ') {
      const { resolve, timer } = this.pending;
      const lines = this.pending.lines;
      this.pending = null;
      clearTimeout(timer);
      resolve({ code: parseInt(m[1], 10), lines });
    }
  }

  _readResponse(timeoutMs = COMMAND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error('SMTP response timeout'));
      }, timeoutMs);
      this.pending = { resolve, reject, timer, lines: [] };
      if (this.buffer.includes('\r\n')) this._onData(''); // drain buffered lines
    });
  }

  async _command(cmd, expect) {
    const want = Array.isArray(expect) ? expect : [expect];
    const sendLine = cmd === null ? null : cmd + '\r\n';
    const respP = this._readResponse();
    if (sendLine) this.socket.write(sendLine, 'utf8');
    const resp = await respP;
    if (!want.includes(resp.code)) {
      throw new Error(`SMTP error: expected ${want.join('/')} but got ${resp.code} (${resp.lines.join(' | ')})`);
    }
    return resp;
  }

  async connect() {
    const { host, port, secure } = this.cfg;
    const socket = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SMTP connect timeout (${host}:${port})`)), CONNECT_TIMEOUT_MS);
      const s = (secure ? tls : net).connect({ host, port, servername: host }, () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
    this.socket = socket;
    socket.setTimeout(COMMAND_TIMEOUT_MS, () => socket.destroy(new Error('SMTP socket timeout')));
    socket.on('data', (c) => this._onData(c));
    socket.on('error', () => {
      if (this.pending) {
        const { reject, timer } = this.pending;
        this.pending = null;
        clearTimeout(timer);
        reject(new Error('SMTP socket error'));
      }
    });

    const greet = await this._readResponse();
    if (greet.code !== 220) throw new Error(`SMTP greeting failed: ${greet.lines.join(' | ')}`);

    const ehlo = await this._command(`EHLO ${host}`, 250);
    const extensions = ehlo.lines.join('\n').toUpperCase();

    if (!secure && extensions.includes('STARTTLS')) {
      await this._command('STARTTLS', 220);
      await new Promise((resolve, reject) => {
        const upgraded = tls.connect({ socket: this.socket, servername: host }, () => resolve(upgraded));
        upgraded.once('error', reject);
        this.socket.removeAllListeners('data');
        this.socket = upgraded;
        upgraded.setTimeout(COMMAND_TIMEOUT_MS, () => upgraded.destroy(new Error('SMTP socket timeout')));
        upgraded.on('data', (c) => this._onData(c));
      });
      await this._command(`EHLO ${host}`, 250); // re-EHLO after TLS
    }

    const { user, pass } = this.cfg;
    if (user) {
      await this._command('AUTH LOGIN', 334);
      await this._command(Buffer.from(user, 'utf8').toString('base64'), 334);
      await this._command(Buffer.from(pass || '', 'utf8').toString('base64'), 235);
    }
  }

  async sendMail({ fromEmail, to, data }) {
    await this._command(`MAIL FROM:<${fromEmail}>`, 250);
    await this._command(`RCPT TO:<${to}>`, [250, 251]);
    await this._command('DATA', 354);
    const resp = await this._command(data + '\r\n.', 250);
    return resp.lines.join(' ');
  }

  async quit() {
    try { await this._command('QUIT', 221); } catch { /* best effort */ }
    if (this.socket) this.socket.destroy();
    this.socket = null;
  }
}

/** Real SMTP provider. */
class SmtpProvider {
  constructor(cfg) {
    const errors = validateSmtpConfig(cfg);
    if (errors.length) throw new Error('Invalid SMTP config: ' + errors.join('; '));
    this.cfg = cfg;
    this.name = 'smtp';
  }

  async send({ to, subject, html, text }) {
    if (!isValidEmail(to)) throw new Error(`Invalid recipient email: ${to}`);
    const data = buildMime({
      fromName: this.cfg.fromName,
      fromEmail: this.cfg.fromEmail,
      to: to.trim(),
      subject,
      html,
      text,
    });
    const msgIdMatch = /Message-ID:\s*(<[^>]+>)/i.exec(data);
    const client = new SmtpClient(this.cfg);
    try {
      await client.connect();
      const response = await client.sendMail({ fromEmail: this.cfg.fromEmail, to: to.trim(), data });
      return {
        ok: true,
        provider: 'smtp',
        response,
        messageId: msgIdMatch ? msgIdMatch[1] : undefined,
      };
    } finally {
      await client.quit();
    }
  }
}

/** No-op provider for when SMTP is not configured. Records activity only. */
class StubProvider {
  constructor(db) {
    this.db = db || null;
    this.name = 'stub';
  }

  async send({ to, subject }) {
    const messageId = 'stub-' + crypto.randomBytes(8).toString('hex');
    if (this.db) {
      try {
        this.db.prepare(
          `INSERT INTO activity_log (area, message) VALUES ('outreach', ?)`
        ).run(`[stub] email to ${to} — "${subject || ''}" (SMTP not configured; marked sent)`);
      } catch { /* activity_log must never break a send */ }
    }
    return { ok: true, provider: 'stub', messageId };
  }
}

/**
 * Choose a provider from flat settings. Returns StubProvider when smtp.host
 * is empty so the rest of the pipeline keeps working in dev / tests.
 * `db` is optional and only used by the stub for activity logging.
 */
function getProvider(settings, db) {
  const cfg = readSmtpConfig(settings || {});
  if (!cfg.host) return new StubProvider(db);
  return new SmtpProvider(cfg);
}

/* ------------------------------------------------------------------ */
/* Template personalization (anti-hallucination)                        */
/* ------------------------------------------------------------------ */

// Variables that may come straight from lead columns.
const LEAD_VARS = [
  'business_name', 'category', 'phone', 'email', 'website', 'address',
  'city', 'state', 'postal_code', 'country', 'rating', 'review_count',
  'description', 'preview_path', 'source',
];

// business_facts.fact_key values that are safe to expose as {{var}}.
// Only facts with claim_class VERIFIED or OWNER_PROVIDED are used.
const FACT_VAR_MAP = {
  phone: 'phone',
  email: 'email',
  website: 'website',
  address: 'address',
  city: 'city',
  state: 'state',
  hours: 'hours',
  services: 'services',
  description: 'description',
  category: 'category',
};

/**
 * Substitute {{variables}} in a template's subject/body.
 *
 * @param {{subject:string, body:string}} template
 * @param {object} lead            lead row (columns used as variables)
 * @param {Array}  facts           business_facts rows [{fact_key, value, claim_class}]
 * @param {object} extra           optional extra vars (e.g. {from_name})
 * @returns {{subject:string, body:string, used:string[], missing:string[]}}
 *
 * Rules: only VERIFIED / OWNER_PROVIDED facts are substituted; anything
 * unknown renders as an empty string — never invented copy.
 */
function personalize(template, lead, facts, extra) {
  const vars = {};
  const src = lead || {};
  for (const k of LEAD_VARS) {
    const v = src[k];
    vars[k] = v === null || v === undefined ? '' : String(v);
  }
  for (const f of facts || []) {
    if (!f || (f.claim_class !== 'VERIFIED' && f.claim_class !== 'OWNER_PROVIDED')) continue;
    const target = FACT_VAR_MAP[f.fact_key];
    if (target && !vars[target]) vars[target] = String(f.value);
  }
  for (const [k, v] of Object.entries(extra || {})) {
    vars[String(k).toLowerCase()] = v === null || v === undefined ? '' : String(v);
  }

  const used = new Set();
  const missing = new Set();
  const fill = (text) =>
    String(text || '').replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, name) => {
      const key = name.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== '') {
        used.add(key);
        return vars[key];
      }
      missing.add(key);
      return '';
    });

  return {
    subject: fill(template.subject),
    body: fill(template.body),
    used: [...used],
    missing: [...missing],
  };
}

module.exports = {
  isValidEmail,
  readSmtpConfig,
  validateSmtpConfig,
  buildMime,
  SmtpProvider,
  StubProvider,
  getProvider,
  personalize,
  LEAD_VARS,
};
