'use strict';

const Stripe = require('stripe');
const platform = require('./platform');

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

async function getPriceId() {
  return process.env.STRIPE_PRICE_ID
    || (await platform.getPlatformSetting('stripe.price_id', ''));
}

function appUrl() {
  return String(process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
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
  getPriceId,
  getSecretKey,
  appUrl,
  integrationId,
};
