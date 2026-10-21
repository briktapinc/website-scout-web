'use strict';

const Stripe = require('stripe');
const platform = require('./platform');
const { PLAN_STANDARD, PLAN_PREMIUM, normalizePlanId } = require('./plans');

let cached = { key: null, client: null };

async function getSecretKey() {
  const fromEnv = process.env.STRIPE_SECRET_KEY || '';
  if (fromEnv) return fromEnv;
  return platform.getPlatformSetting('stripe.secret_key', '');
}

async function getStripe() {
  const key = String(await getSecretKey() || '').trim();
  if (!key) {
    const e = new Error('Stripe is not configured (stripe.secret_key / STRIPE_SECRET_KEY)');
    e.code = 'STRIPE_NOT_CONFIGURED';
    throw e;
  }
  if (cached.client && cached.key === key) return cached.client;
  // StripeClient pattern (not deprecated global apiKey)
  // Use the SDK's bundled API version (keep Stripe Node current).
  const client = new Stripe(key);
  cached = { key, client };
  return client;
}

async function getWebhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET
    || (await platform.getPlatformSetting('stripe.webhook_secret', ''));
}

async function getPublishableKey() {
  return process.env.STRIPE_PUBLISHABLE_KEY
    || (await platform.getPlatformSetting('stripe.publishable_key', ''));
}

/** @deprecated Prefer getPriceIdForPlan — kept for one-price legacy installs. */
async function getPriceId() {
  return getPriceIdForPlan(PLAN_STANDARD);
}

/**
 * Resolve Stripe Price ID for a paid plan.
 * Env: STRIPE_PRICE_ID_STANDARD / STRIPE_PRICE_ID_PREMIUM
 * Legacy: STRIPE_PRICE_ID or stripe.price_id maps to Standard.
 */
async function getPriceIdForPlan(planId) {
  const plan = normalizePlanId(planId);
  if (plan === PLAN_PREMIUM) {
    const fromEnv = process.env.STRIPE_PRICE_ID_PREMIUM || '';
    if (fromEnv) return String(fromEnv).trim();
    return String(await platform.getPlatformSetting('stripe.price_id_premium', '') || '').trim();
  }
  if (plan === PLAN_STANDARD) {
    const fromEnv = process.env.STRIPE_PRICE_ID_STANDARD || process.env.STRIPE_PRICE_ID || '';
    if (fromEnv) return String(fromEnv).trim();
    const dedicated = String(await platform.getPlatformSetting('stripe.price_id_standard', '') || '').trim();
    if (dedicated) return dedicated;
    return String(await platform.getPlatformSetting('stripe.price_id', '') || '').trim();
  }
  return '';
}

async function getConfiguredPriceIds() {
  const standard = await getPriceIdForPlan(PLAN_STANDARD);
  const premium = await getPriceIdForPlan(PLAN_PREMIUM);
  return { standard, premium };
}

/** Map a Stripe price_… id back to a plan tier. */
async function planIdFromPriceId(priceId) {
  const pid = String(priceId || '').trim();
  if (!pid) return null;
  const { standard, premium } = await getConfiguredPriceIds();
  if (premium && pid === premium) return PLAN_PREMIUM;
  if (standard && pid === standard) return PLAN_STANDARD;
  return null;
}

function appUrl() {
  const raw = String(process.env.APP_URL || '').trim();
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw Object.assign(new Error('APP_URL must be set in production'), { code: 'APP_URL_REQUIRED' });
    }
    return 'http://localhost:3000';
  }
  return raw.replace(/\/$/, '');
}

function integrationId(label = 'billing-checkout') {
  const suffix = Array.from({ length: 8 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26))
  ).join('');
  return `${label}-${suffix}`;
}

module.exports = {
  getStripe,
  getWebhookSecret,
  getPublishableKey,
  getPriceId,
  getPriceIdForPlan,
  getConfiguredPriceIds,
  planIdFromPriceId,
  getSecretKey,
  appUrl,
  integrationId,
};
