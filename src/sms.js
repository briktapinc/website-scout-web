'use strict';
/**
 * sms.js — SMS provider abstraction for Bitpype / Website Scout outreach.
 *
 * Providers:
 *   - TwilioProvider : REST Messages API (account SID + auth token + from number)
 *   - StubProvider   : when sms.enabled≠1 or credentials missing — logs and
 *                      marks as sent so draft/queue flows work in dev.
 *
 * Credentials come from workspace settings, optionally filled from
 * platform_settings (Admin → SMS) via resolveSmsSettings().
 */

const crypto = require('node:crypto');

const SMS_SETTING_KEYS = [
  'sms.enabled',
  'sms.provider',
  'sms.account_sid',
  'sms.auth_token',
  'sms.api_key',
  'sms.from_number',
  'sms.webhook_url',
];

/** Digits-only; keep leading country code if present (10–15 digits). */
function normalizePhone(phone) {
  if (phone == null || phone === '') return '';
  let d = String(phone).replace(/\D/g, '');
  if (!d) return '';
  // US common: 10 digits → assume +1
  if (d.length === 10) d = '1' + d;
  if (d.length < 10 || d.length > 15) return '';
  return '+' + d;
}

function isValidPhone(phone) {
  return Boolean(normalizePhone(phone));
}

function readSmsConfig(settings) {
  const get = (k, dflt = '') => {
    const v = settings && settings[k];
    return v === undefined || v === null ? dflt : String(v).trim();
  };
  const enabledRaw = get('sms.enabled', '0').toLowerCase();
  return {
    enabled: enabledRaw === '1' || enabledRaw === 'true' || enabledRaw === 'yes',
    provider: (get('sms.provider', 'twilio') || 'twilio').toLowerCase(),
    accountSid: get('sms.account_sid'),
    authToken: get('sms.auth_token') || get('sms.api_key'),
    fromNumber: get('sms.from_number'),
    webhookUrl: get('sms.webhook_url'),
  };
}

function validateSmsConfig(cfg) {
  const errors = [];
  if (!cfg.enabled) errors.push('sms.enabled is off');
  if (!cfg.accountSid) errors.push('sms.account_sid is empty');
  if (!cfg.authToken) errors.push('sms.auth_token is empty');
  if (!normalizePhone(cfg.fromNumber)) errors.push('sms.from_number is missing or invalid');
  return errors;
}

/**
 * Merge workspace settings with platform_settings for any empty sms.* keys.
 * Safe when server/platform is unavailable (Electron / tests).
 */
async function resolveSmsSettings(workspaceSettings) {
  const out = { ...(workspaceSettings || {}) };
  try {
    const platform = require('../server/platform');
    for (const key of SMS_SETTING_KEYS) {
      const cur = out[key] != null ? String(out[key]).trim() : '';
      if (cur && cur !== '***') continue;
      const plat = await platform.getPlatformSetting(key, '');
      if (plat != null && String(plat).trim() !== '') out[key] = String(plat);
    }
  } catch { /* platform optional */ }
  return out;
}

class StubSmsProvider {
  constructor(db, reason) {
    this.db = db || null;
    this.name = 'stub';
    this.reason = reason || 'SMS not configured';
  }

  async send({ to, body, mediaUrl }) {
    const messageId = 'stub-sms-' + crypto.randomBytes(8).toString('hex');
    const hasMedia = !!(mediaUrl && String(mediaUrl).trim());
    const mode = hasMedia ? 'mms' : 'sms';
    if (this.db) {
      try {
        this.db.prepare(
          `INSERT INTO activity_log (area, message) VALUES ('outreach', ?)`
        ).run(`[stub] ${mode.toUpperCase()} to ${to} — "${String(body || '').slice(0, 80)}"${hasMedia ? ` media=${String(mediaUrl).slice(0, 120)}` : ''} (${this.reason}; marked sent)`);
      } catch { /* ignore */ }
    }
    return { ok: true, provider: 'stub', messageId, stub: true, mode, mediaUrl: hasMedia ? String(mediaUrl).trim() : null };
  }
}

class TwilioProvider {
  constructor(cfg) {
    this.cfg = cfg;
    this.name = 'twilio';
  }

  async send({ to, body, mediaUrl }) {
    const toNorm = normalizePhone(to);
    const fromNorm = normalizePhone(this.cfg.fromNumber);
    if (!toNorm) throw new Error('Invalid destination phone number');
    if (!fromNorm) throw new Error('Invalid sms.from_number');
    const text = String(body || '').trim();
    if (!text) throw new Error('SMS body is empty');
    if (text.length > 1600) throw new Error('SMS body exceeds 1600 characters');

    const media = mediaUrl && String(mediaUrl).trim() && /^https:\/\//i.test(String(mediaUrl).trim())
      ? String(mediaUrl).trim()
      : '';
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}/Messages.json`;
    const auth = Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64');

    const postOnce = async (withMedia) => {
      const params = new URLSearchParams({
        To: toNorm,
        From: fromNorm,
        Body: text,
      });
      if (withMedia && media) params.append('MediaUrl', media);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
      const raw = await res.text();
      let data = {};
      try { data = JSON.parse(raw); } catch { /* keep */ }
      return { res, raw, data };
    };

    let { res, raw, data } = await postOnce(!!media);
    let mode = media ? 'mms' : 'sms';
    let fallbackReason = null;
    if (!res.ok && media) {
      const msg = (data && (data.message || data.error_message)) || raw.slice(0, 300) || res.statusText;
      const mmsFail = /media|mms|21604|21620|12300|unsubscribed|not.+support/i.test(msg)
        || res.status === 400;
      if (mmsFail) {
        // Graceful fallback: plain SMS with media URL appended if not already in body.
        fallbackReason = msg;
        let fallbackBody = text;
        if (media && !fallbackBody.includes(media)) {
          fallbackBody = `${fallbackBody}\n${media}`.slice(0, 1600);
        }
        const params = new URLSearchParams({
          To: toNorm,
          From: fromNorm,
          Body: fallbackBody,
        });
        const res2 = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
        });
        const raw2 = await res2.text();
        let data2 = {};
        try { data2 = JSON.parse(raw2); } catch { /* keep */ }
        if (!res2.ok) {
          const msg2 = (data2 && (data2.message || data2.error_message)) || raw2.slice(0, 300) || res2.statusText;
          throw new Error(`Twilio ${res2.status}: ${msg2}`);
        }
        return {
          ok: true,
          provider: 'twilio',
          messageId: data2.sid || null,
          status: data2.status || null,
          mode: 'sms_fallback',
          mediaUrl: null,
          fallbackFrom: 'mms',
          fallbackReason,
        };
      }
      throw new Error(`Twilio ${res.status}: ${msg}`);
    }
    if (!res.ok) {
      const msg = (data && (data.message || data.error_message)) || raw.slice(0, 300) || res.statusText;
      throw new Error(`Twilio ${res.status}: ${msg}`);
    }
    return {
      ok: true,
      provider: 'twilio',
      messageId: data.sid || null,
      status: data.status || null,
      mode,
      mediaUrl: media || null,
    };
  }
}

/**
 * Choose SMS provider. Returns Stub when disabled or misconfigured so the
 * queue can still complete in environments without Twilio keys.
 */
function getSmsProvider(settings, db) {
  const cfg = readSmsConfig(settings || {});
  const errors = validateSmsConfig(cfg);
  if (errors.length) {
    return new StubSmsProvider(db, errors.join('; '));
  }
  if (cfg.provider === 'twilio' || cfg.provider === 'custom') {
    return new TwilioProvider(cfg);
  }
  // vonage / unknown → stub with clear reason until implemented
  return new StubSmsProvider(db, `SMS provider "${cfg.provider}" is not implemented; use twilio`);
}

/**
 * Short plain-text companion SMS for an outreach email draft.
 * Always includes the website link (resolved URL or {{website_link}}).
 */
function companionSmsDraft({ businessName, websiteLink, fromName } = {}) {
  const link = (websiteLink && String(websiteLink).trim()) || '{{website_link}}';
  const name = (businessName && String(businessName).trim()) || '{{business_name}}';
  const from = (fromName && String(fromName).trim()) || '';
  let text = from
    ? `Hi ${name}, ${from} made a free website preview for you: ${link}`
    : `Hi ${name} — free website preview for your business: ${link}`;
  if (text.length > 280) {
    text = `Website preview for ${name}: ${link}`;
  }
  if (text.length > 320) text = `Preview: ${link}`;
  return text.slice(0, 320);
}

/** Strip HTML and collapse whitespace for SMS bodies. */
function plainSmsBody(text) {
  let s = String(text || '');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  return s.slice(0, 1600);
}

module.exports = {
  SMS_SETTING_KEYS,
  normalizePhone,
  isValidPhone,
  readSmsConfig,
  validateSmsConfig,
  resolveSmsSettings,
  getSmsProvider,
  companionSmsDraft,
  plainSmsBody,
  StubSmsProvider,
  TwilioProvider,
};
