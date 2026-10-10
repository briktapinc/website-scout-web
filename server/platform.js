'use strict';

/**
 * Platform-wide (super-admin) settings — defaults for new workspaces,
 * global email/SMS, registration flags, etc.
 */

const { query } = require('./db');

const PLATFORM_SECRET_KEYS = [
  'ai.api_key',
  'smtp.pass',
  'cf.api_token',
  'pexels.api_key',
  'providers.tavily.api_key',
  'fal.api_key',
  'sms.auth_token',
  'sms.api_key',
];

/** Catalog of platform settings shown in the admin UI. */
const PLATFORM_SETTING_DEFS = [
  // General
  { key: 'app.name', group: 'general', label: 'App name', default: 'Website Scout' },
  { key: 'support.email', group: 'general', label: 'Support email', default: '' },
  { key: 'registration.open', group: 'general', label: 'Open registration (1/0)', default: '1' },
  { key: 'maintenance_mode', group: 'general', label: 'Maintenance mode (1/0)', default: '0' },
  { key: 'default.workspace_name', group: 'general', label: 'Default workspace name pattern', default: "{name}'s workspace" },

  // Cost defaults for new workspaces
  { key: 'cost.daily_budget_usd', group: 'general', label: 'Default daily AI budget (USD)', default: '10' },
  { key: 'cost.max_websites_per_day', group: 'general', label: 'Default max websites / day', default: '25' },
  { key: 'cost.max_outreach_per_day', group: 'general', label: 'Default max outreach / day', default: '200' },

  // Email / SMTP
  { key: 'smtp.host', group: 'email', label: 'SMTP host', default: '' },
  { key: 'smtp.port', group: 'email', label: 'SMTP port', default: '587' },
  { key: 'smtp.secure', group: 'email', label: 'SMTP secure (1/0)', default: '0' },
  { key: 'smtp.user', group: 'email', label: 'SMTP user', default: '' },
  { key: 'smtp.pass', group: 'email', label: 'SMTP password', default: '', secret: true },
  { key: 'smtp.from_name', group: 'email', label: 'From name', default: 'Website Scout' },
  { key: 'smtp.from_email', group: 'email', label: 'From email', default: '' },
  { key: 'mail.footer', group: 'email', label: 'Default mail footer', default: 'Reply STOP to opt out of future messages.' },

  // SMS
  { key: 'sms.enabled', group: 'sms', label: 'SMS enabled (1/0)', default: '0' },
  { key: 'sms.provider', group: 'sms', label: 'Provider (twilio|vonage|custom)', default: 'twilio' },
  { key: 'sms.account_sid', group: 'sms', label: 'Account SID / key id', default: '' },
  { key: 'sms.auth_token', group: 'sms', label: 'Auth token', default: '', secret: true },
  { key: 'sms.api_key', group: 'sms', label: 'API key (alternate)', default: '', secret: true },
  { key: 'sms.from_number', group: 'sms', label: 'From number', default: '' },
  { key: 'sms.webhook_url', group: 'sms', label: 'Inbound webhook URL', default: '' },

  // Default API keys / AI (copied into new workspaces when empty)
  { key: 'ai.api_key', group: 'keys', label: 'OpenAI / AI API key', default: '', secret: true },
  { key: 'ai.base_url', group: 'keys', label: 'AI base URL', default: 'https://api.openai.com/v1' },
  { key: 'ai.model.default', group: 'keys', label: 'Default AI model', default: 'gpt-4o-mini' },
  { key: 'providers.tavily.api_key', group: 'keys', label: 'Tavily API key', default: '', secret: true },
  { key: 'pexels.api_key', group: 'keys', label: 'Pexels API key', default: '', secret: true },
  { key: 'fal.api_key', group: 'keys', label: 'Fal API key', default: '', secret: true },
  { key: 'cf.api_token', group: 'keys', label: 'Cloudflare API token', default: '', secret: true },
  { key: 'cf.account_id', group: 'keys', label: 'Cloudflare account id', default: '' },
  { key: 'cf.project', group: 'keys', label: 'Cloudflare Pages project', default: '' },
  { key: 'cf.preview_domain', group: 'keys', label: 'Cloudflare preview domain', default: '' },
];

const WORKSPACE_SEED_KEYS = PLATFORM_SETTING_DEFS
  .filter((d) => ['email', 'keys', 'general'].includes(d.group) || d.key.startsWith('cost.') || d.key.startsWith('mail.') || d.key.startsWith('smtp.') || d.key.startsWith('ai.') || d.key.startsWith('cf.') || d.key.startsWith('providers.') || d.key === 'pexels.api_key' || d.key === 'fal.api_key')
  .map((d) => d.key)
  // Don't push registration/maintenance into workspace sqlite
  .filter((k) => !['registration.open', 'maintenance_mode', 'support.email', 'default.workspace_name'].includes(k));

async function ensurePlatformTables() {
  // no-op: migrate creates tables; kept for callers
}

async function getPlatformSetting(key, fallback = '') {
  const rows = await query(
    'SELECT value FROM platform_settings WHERE `key` = :key LIMIT 1',
    { key }
  );
  if (rows && rows[0]) return rows[0].value;
  const def = PLATFORM_SETTING_DEFS.find((d) => d.key === key);
  return def ? def.default : fallback;
}

async function setPlatformSetting(key, value) {
  const def = PLATFORM_SETTING_DEFS.find((d) => d.key === key);
  if (!def) {
    const e = new Error(`Unknown platform setting: ${key}`);
    e.code = 'UNKNOWN_SETTING';
    throw e;
  }
  const v = value == null ? '' : String(value);
  await query(
    `INSERT INTO platform_settings (\`key\`, value)
     VALUES (:key, :value)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    { key, value: v }
  );
  return { key, set: true };
}

async function seedPlatformDefaults() {
  for (const def of PLATFORM_SETTING_DEFS) {
    await query(
      'INSERT IGNORE INTO platform_settings (`key`, value) VALUES (:key, :value)',
      { key: def.key, value: def.default }
    );
  }
}

async function getAllPlatformSettings({ redact = true } = {}) {
  const rows = await query('SELECT `key`, value FROM platform_settings');
  const map = {};
  for (const def of PLATFORM_SETTING_DEFS) map[def.key] = def.default;
  for (const r of rows || []) map[r.key] = r.value;
  if (redact) {
    for (const k of PLATFORM_SECRET_KEYS) {
      if (map[k]) map[k] = '***';
    }
  }
  return map;
}

async function setPlatformSettingsBatch(entries, { secretsOnly = false } = {}) {
  const out = [];
  for (const [key, value] of Object.entries(entries || {})) {
    const def = PLATFORM_SETTING_DEFS.find((d) => d.key === key);
    if (!def) continue;
    if (secretsOnly && !def.secret && !PLATFORM_SECRET_KEYS.includes(key)) continue;
    if (PLATFORM_SECRET_KEYS.includes(key) || def.secret) {
      if (value === '***' || value === '' || value == null) continue;
    }
    await setPlatformSetting(key, value);
    out.push(key);
  }
  return { updated: out };
}

async function audit(actorUserId, action, detail) {
  try {
    await query(
      `INSERT INTO platform_audit (actor_user_id, action, detail)
       VALUES (:actorUserId, :action, :detail)`,
      {
        actorUserId: actorUserId || null,
        action: String(action || '').slice(0, 80),
        detail: detail == null ? '' : String(detail).slice(0, 4000),
      }
    );
  } catch (e) {
    console.warn('[platform.audit]', e.message);
  }
}

async function listAudit({ limit = 50 } = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  return query(
    `SELECT a.id, a.actor_user_id, a.action, a.detail, a.at, u.email AS actor_email
     FROM platform_audit a
     LEFT JOIN users u ON u.id = a.actor_user_id
     ORDER BY a.id DESC
     LIMIT ${lim}`
  );
}

/** Keys+values from platform that should seed a workspace. */
async function workspaceSeedFromPlatform() {
  const all = await getAllPlatformSettings({ redact: false });
  const out = {};
  for (const key of WORKSPACE_SEED_KEYS) {
    if (all[key] != null && String(all[key]).trim() !== '') out[key] = String(all[key]);
  }
  return out;
}

module.exports = {
  PLATFORM_SECRET_KEYS,
  PLATFORM_SETTING_DEFS,
  WORKSPACE_SEED_KEYS,
  ensurePlatformTables,
  getPlatformSetting,
  setPlatformSetting,
  seedPlatformDefaults,
  getAllPlatformSettings,
  setPlatformSettingsBatch,
  audit,
  listAudit,
  workspaceSeedFromPlatform,
};
