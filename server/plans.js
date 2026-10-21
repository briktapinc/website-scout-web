'use strict';

/**
 * Bitpype subscription plan catalog.
 * Stripe Price IDs live in platform settings (stripe.price_id_standard / premium).
 * Users without an active paid sub are on Free.
 */

const PLAN_FREE = 'free';
const PLAN_STANDARD = 'standard';
const PLAN_PREMIUM = 'premium';

const PAID_PLANS = [PLAN_STANDARD, PLAN_PREMIUM];

const PLANS = {
  [PLAN_FREE]: {
    id: PLAN_FREE,
    name: 'Free',
    tagline: 'Launch a site and edit it yourself.',
    priceLabel: 'Free',
    interval: null,
    features: [
      'Free website',
      'Inline edits',
      'Preview hosting',
      'Design change requests',
      'Contact form builder — results emailed only',
      'No included support',
      'Social media images — use credits',
    ],
    entitlements: {
      website: true,
      inlineEdits: true,
      previewHosting: true,
      designChangeRequests: true,
      supportCadence: 'none',
      socialImagesIncluded: false,
      socialImagesPaid: true,
      formBuilder: true,
      formInbox: false,
      formMcp: false,
      formMuseEncrypt: false,
      socialMcpSchedule: false,
      siteModules: false,
      chatbot: false,
    },
  },
  [PLAN_STANDARD]: {
    id: PLAN_STANDARD,
    name: 'Standard',
    tagline: 'Monthly support with credit-based social ads.',
    priceLabel: 'Monthly',
    interval: 'month',
    features: [
      'Free website',
      'Inline edits',
      'Preview hosting',
      'Design change requests',
      'Contact form inbox in the portal',
      'Site modules — blog, shop, courses, gallery, directory, chatbot',
      'AI site chatbot (portal client MCP agent)',
      'Monthly support',
      'Social media images — use credits',
    ],
    entitlements: {
      website: true,
      inlineEdits: true,
      previewHosting: true,
      designChangeRequests: true,
      supportCadence: 'monthly',
      socialImagesIncluded: false,
      socialImagesPaid: true,
      formBuilder: true,
      formInbox: true,
      formMcp: false,
      formMuseEncrypt: false,
      socialMcpSchedule: false,
      siteModules: true,
      chatbot: true,
    },
  },
  [PLAN_PREMIUM]: {
    id: PLAN_PREMIUM,
    name: 'Premium',
    tagline: 'Weekly support with social images included.',
    priceLabel: 'Monthly',
    interval: 'month',
    features: [
      'Free website',
      'Inline edits',
      'Preview hosting',
      'Design change requests',
      'Encrypted form submissions + Muse + MCP',
      'Site modules — blog, shop, courses, gallery, directory, chatbot',
      'AI site chatbot (portal client MCP agent)',
      'MCP social post scheduling',
      'Weekly support',
      'Social media images included (no credit charge for images)',
    ],
    entitlements: {
      website: true,
      inlineEdits: true,
      previewHosting: true,
      designChangeRequests: true,
      supportCadence: 'weekly',
      socialImagesIncluded: true,
      socialImagesPaid: false,
      formBuilder: true,
      formInbox: true,
      formMcp: true,
      formMuseEncrypt: true,
      socialMcpSchedule: true,
      siteModules: true,
      chatbot: true,
    },
  },
};

const PLAN_RANK = {
  [PLAN_FREE]: 0,
  [PLAN_STANDARD]: 1,
  [PLAN_PREMIUM]: 2,
};

function normalizePlanId(raw) {
  const id = String(raw || '').trim().toLowerCase();
  if (id === PLAN_STANDARD || id === PLAN_PREMIUM || id === PLAN_FREE) return id;
  return PLAN_FREE;
}

function getPlan(planId) {
  return PLANS[normalizePlanId(planId)] || PLANS[PLAN_FREE];
}

function listPlans() {
  return [PLAN_FREE, PLAN_STANDARD, PLAN_PREMIUM].map((id) => ({ ...PLANS[id] }));
}

function isPaidPlan(planId) {
  return PAID_PLANS.includes(normalizePlanId(planId));
}

function maxPlan(a, b) {
  const pa = normalizePlanId(a);
  const pb = normalizePlanId(b);
  return (PLAN_RANK[pa] || 0) >= (PLAN_RANK[pb] || 0) ? pa : pb;
}

function publicPlan(planId, extras = {}) {
  const plan = getPlan(planId);
  return {
    id: plan.id,
    name: plan.name,
    tagline: plan.tagline,
    priceLabel: extras.priceLabel || plan.priceLabel,
    interval: plan.interval,
    features: plan.features.slice(),
    entitlements: { ...plan.entitlements },
    ...extras,
  };
}

module.exports = {
  PLAN_FREE,
  PLAN_STANDARD,
  PLAN_PREMIUM,
  PAID_PLANS,
  PLANS,
  PLAN_RANK,
  normalizePlanId,
  getPlan,
  listPlans,
  isPaidPlan,
  maxPlan,
  publicPlan,
};
