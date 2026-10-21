'use strict';

/**
 * Pluggable Muse delivery adapter.
 * Premium form submissions POST an encrypted payload to muse.webhook_url
 * when muse.enabled=1. No credentials are invented — configure via platform settings.
 *
 * SSRF: shared assertPublicUrl + pinned DNS fetch (see urlSafety.js).
 */

const platform = require('./platform');
const { assertPublicUrl, fetchPublic, isPrivateIp } = require('./urlSafety');

async function museConfig() {
  const enabled = String(await platform.getPlatformSetting('muse.enabled', '0') || '0').trim() === '1';
  const webhookUrl = String(await platform.getPlatformSetting('muse.webhook_url', '') || '').trim();
  return { enabled, webhookUrl };
}

/**
 * Validate webhook URL before fetch — HTTPS only (http localhost in non-prod),
 * no credentials, no private destinations.
 */
async function assertSafeWebhookUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || ''));
  } catch {
    throw new Error('Invalid Muse webhook URL');
  }
  const host = (u.hostname || '').toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const prod = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

  if (u.protocol !== 'https:') {
    if (!(u.protocol === 'http:' && isLocal && !prod)) {
      throw new Error('Muse webhook must use HTTPS');
    }
  }
  if (u.username || u.password) {
    throw new Error('Muse webhook URL must not include credentials');
  }
  if (isLocal && prod) {
    throw new Error('Muse webhook cannot target localhost in production');
  }

  await assertPublicUrl(u.toString(), { allowHttpLocal: !prod && isLocal });
  return u.toString();
}

/**
 * Deliver ciphertext (+ metadata) to Muse webhook.
 * @returns {{ delivered: boolean, skipped?: boolean, status?: number, error?: string }}
 */
async function routeEncryptedSubmission({
  workspaceId,
  leadId,
  formId,
  submissionId,
  encryptedPayload,
  cipher = 'aes-256-gcm',
  meta = {},
} = {}) {
  const cfg = await museConfig();
  if (!cfg.enabled || !cfg.webhookUrl) {
    return { delivered: false, skipped: true, reason: 'muse_not_configured' };
  }

  let safeUrl;
  try {
    safeUrl = await assertSafeWebhookUrl(cfg.webhookUrl);
  } catch (e) {
    console.warn('[museRouter] blocked webhook URL:', e.message);
    return { delivered: false, error: e.message || 'unsafe_webhook_url' };
  }

  const body = {
    type: 'bitpype.form_submission',
    workspaceId: Number(workspaceId),
    leadId: Number(leadId),
    formId: Number(formId),
    submissionId: Number(submissionId),
    cipher,
    encryptedPayload: String(encryptedPayload || ''),
    meta: meta && typeof meta === 'object' ? {
      formTitle: meta.formTitle != null ? String(meta.formTitle).slice(0, 160) : undefined,
      plan: meta.plan != null ? String(meta.plan).slice(0, 40) : undefined,
    } : {},
    at: new Date().toISOString(),
  };

  try {
    const res = await fetchPublic(safeUrl, {
      method: 'POST',
      timeoutMs: 15000,
      maxRedirects: 0,
      allowHttpLocal: String(process.env.NODE_ENV || '').toLowerCase() !== 'production',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Bitpype-MuseRouter/1.0',
        'X-Bitpype-Event': 'form_submission',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn('[museRouter] webhook non-OK', res.status);
      return { delivered: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { delivered: true, status: res.status };
  } catch (e) {
    console.warn('[museRouter] webhook failed:', e.message);
    return { delivered: false, error: e.message || String(e) };
  }
}

module.exports = {
  museConfig,
  assertSafeWebhookUrl,
  routeEncryptedSubmission,
  isPrivateIp,
};
