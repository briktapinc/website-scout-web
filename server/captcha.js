'use strict';

/**
 * Cloudflare Turnstile verification for public forms.
 * Production: keys required at boot unless CAPTCHA_OPTIONAL=1.
 * Missing keys fail closed (never silently skip).
 */

const platform = require('./platform');

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function getCaptchaConfig() {
  const siteKey = String(await platform.getPlatformSetting('captcha.site_key', '') || '').trim();
  const secretKey = String(await platform.getPlatformSetting('captcha.secret_key', '') || '').trim();
  const forceOff = String(await platform.getPlatformSetting('captcha.enabled', '1') || '1').trim() === '0';
  const optional = String(process.env.CAPTCHA_OPTIONAL || '').trim() === '1';
  const allowSkip = optional || process.env.NODE_ENV !== 'production';
  const keysPresent = !!(siteKey && secretKey);
  // Production: captcha stays on whenever not force-disabled. Missing keys fail closed
  // at verify time instead of silently skipping login/register protection.
  const enabled = !forceOff && (keysPresent || !allowSkip);
  return {
    enabled,
    provider: 'turnstile',
    siteKey: keysPresent && enabled ? siteKey : '',
    keysPresent,
    forceOff,
    misconfigured: enabled && !keysPresent,
  };
}

/** Refuse to boot production without Turnstile keys (unless CAPTCHA_OPTIONAL=1). */
async function assertProductionReady() {
  if (process.env.NODE_ENV !== 'production') return;
  if (String(process.env.CAPTCHA_OPTIONAL || '').trim() === '1') {
    console.warn('[boot] CAPTCHA_OPTIONAL=1 — captcha may be skipped');
    return;
  }
  const cfg = await getCaptchaConfig();
  if (cfg.forceOff) {
    console.error('[boot] captcha.enabled=0 is not allowed in production without CAPTCHA_OPTIONAL=1');
    process.exit(1);
  }
  if (!cfg.keysPresent) {
    console.error('[boot] Turnstile captcha.site_key + captcha.secret_key required in production (or set CAPTCHA_OPTIONAL=1)');
    process.exit(1);
  }
}

async function verifyCaptchaToken(token, remoteip) {
  const cfg = await getCaptchaConfig();
  if (!cfg.enabled) return { ok: true, skipped: true };

  if (cfg.misconfigured) {
    const err = new Error('Captcha is required but not configured');
    err.code = 'CAPTCHA_NOT_CONFIGURED';
    throw err;
  }

  const secretKey = String(await platform.getPlatformSetting('captcha.secret_key', '') || '').trim();
  const response = String(token || '').trim();
  if (!response) {
    const err = new Error('Please complete the captcha');
    err.code = 'CAPTCHA_REQUIRED';
    throw err;
  }

  const body = new URLSearchParams();
  body.set('secret', secretKey);
  body.set('response', response);
  if (remoteip) body.set('remoteip', String(remoteip));

  let data;
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10000),
    });
    data = await res.json();
  } catch (e) {
    const err = new Error('Captcha verification failed (network)');
    err.code = 'CAPTCHA_ERROR';
    throw err;
  }

  if (!data || data.success !== true) {
    const err = new Error('Captcha verification failed');
    err.code = 'CAPTCHA_FAILED';
    throw err;
  }
  return { ok: true };
}

/** Prefer Express req.ip (honors trust proxy). Do not trust leftmost X-Forwarded-For. */
function clientIp(req) {
  return String((req && req.ip) || '').trim();
}

/** Express middleware — expects captchaToken (or cf-turnstile-response) in JSON body. */
function requireCaptcha() {
  return async (req, res, next) => {
    try {
      const token = (req.body && (req.body.captchaToken || req.body['cf-turnstile-response'])) || '';
      await verifyCaptchaToken(token, clientIp(req));
      return next();
    } catch (e) {
      const status = e.code === 'CAPTCHA_REQUIRED' || e.code === 'CAPTCHA_FAILED' ? 400
        : e.code === 'CAPTCHA_NOT_CONFIGURED' ? 503
        : 502;
      return res.status(status).json({ ok: false, error: e.message || 'Captcha failed', code: e.code || 'CAPTCHA_FAILED' });
    }
  };
}

module.exports = {
  getCaptchaConfig,
  verifyCaptchaToken,
  requireCaptcha,
  clientIp,
  assertProductionReady,
};
