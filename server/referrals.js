'use strict';

/**
 * Portal referrals — clients refer leads; when a referred lead activates a paid
 * plan, the referrer's workspace earns social credits (~10% of plan value).
 *
 * Credit math (documented):
 *   rewardUsd = planAmountUsd * (referrals.reward_percent / 100)   // default 10%
 *   credits   = max(1, round(rewardUsd / usdPerCredit))
 *   usdPerCredit is derived from the Stripe credits pack price when configured
 *   (pack unit_amount / credits.pack_amount), else platform setting
 *   credits.usd_per_credit (default 1 → $1 ≈ 1 credit).
 *   Example: $100/mo plan × 10% = $10 → ~10 credits at $1/credit.
 */

const { query, driver } = require('./db');
const platform = require('./platform');

const STATUS_PENDING = 'pending';
const STATUS_SIGNED_UP = 'signed_up';
const STATUS_CREDITED = 'credited';

function fail(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

function normalizePhone(raw) {
  return String(raw || '').replace(/[^\d+]/g, '').trim().slice(0, 40);
}

function normalizeBusiness(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseUsdFromLabel(label) {
  const m = String(label || '').match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function rewardPercent() {
  const n = Number(await platform.getPlatformSetting('referrals.reward_percent', '10'));
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(50, n);
}

/**
 * Dollars per credit for referral conversion.
 * Prefer live Stripe credits pack price ÷ pack size.
 */
async function usdPerCredit() {
  const credits = require('./credits');
  const cfg = await credits.packConfig();
  if (cfg.priceId && cfg.packAmount > 0) {
    try {
      const { getStripe } = require('./stripeClient');
      const stripe = await getStripe();
      const price = await stripe.prices.retrieve(cfg.priceId);
      const unit = Number(price && price.unit_amount) || 0;
      if (unit > 0) {
        return (unit / 100) / cfg.packAmount;
      }
    } catch (e) {
      console.warn('[referrals] credits price lookup:', e.message);
    }
  }
  const fallback = Number(await platform.getPlatformSetting('credits.usd_per_credit', '1'));
  return Math.max(0.01, Number.isFinite(fallback) && fallback > 0 ? fallback : 1);
}

function creditsFromPlanCents(planCents, percent, perCreditUsd) {
  const cents = Math.max(0, Math.floor(Number(planCents) || 0));
  const rewardUsd = (cents / 100) * (Number(percent) / 100);
  const rate = Math.max(0.01, Number(perCreditUsd) || 1);
  return Math.max(1, Math.round(rewardUsd / rate));
}

async function estimatePlanCents(planId) {
  const key = planId === 'premium'
    ? 'billing.amount_label_premium'
    : 'billing.amount_label_standard';
  const label = await platform.getPlatformSetting(
    key,
    planId === 'premium' ? 'Premium · $99/mo' : 'Standard · $49/mo'
  );
  const usd = parseUsdFromLabel(label);
  if (usd != null) return Math.round(usd * 100);
  // Fallbacks when labels have no dollar amount.
  return planId === 'premium' ? 9900 : 4900;
}

function planAmountCentsFromSubscription(subscription) {
  try {
    const item = subscription
      && subscription.items
      && subscription.items.data
      && subscription.items.data[0];
    const price = item && item.price;
    const unit = Number(price && price.unit_amount) || 0;
    const qty = Math.max(1, Math.floor(Number(item && item.quantity) || 1));
    if (unit > 0) return unit * qty;
  } catch { /* */ }
  return 0;
}

async function creditMathSummary() {
  const percent = await rewardPercent();
  const perCredit = await usdPerCredit();
  const standardCents = await estimatePlanCents('standard');
  const premiumCents = await estimatePlanCents('premium');
  return {
    rewardPercent: percent,
    usdPerCredit: Math.round(perCredit * 1000) / 1000,
    standardEstimateCredits: creditsFromPlanCents(standardCents, percent, perCredit),
    premiumEstimateCredits: creditsFromPlanCents(premiumCents, percent, perCredit),
    standardEstimateUsd: standardCents / 100,
    premiumEstimateUsd: premiumCents / 100,
    note: `Earn ~${percent}% of a referred client's first paid plan value as social credits `
      + `(≈ $${perCredit % 1 === 0 ? perCredit.toFixed(0) : perCredit.toFixed(2)} per credit). `
      + `Example: $${(standardCents / 100).toFixed(0)} Standard → ~${creditsFromPlanCents(standardCents, percent, perCredit)} credits.`,
  };
}

function validateReferralInput(body = {}) {
  const name = String(body.name || body.referred_name || '').trim().slice(0, 160);
  const email = normalizeEmail(body.email || body.referred_email);
  const phone = normalizePhone(body.phone || body.referred_phone);
  const businessName = String(body.businessName || body.business_name || body.referred_business_name || '')
    .trim()
    .slice(0, 200);

  if (!email && !businessName) {
    throw fail('INVALID', 'Provide an email or a business name.');
  }
  if (!email && !phone) {
    throw fail('INVALID', 'Add an email or phone so we can contact them.');
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw fail('INVALID', 'That email does not look valid.');
  }
  if (!name && !businessName && !email) {
    throw fail('INVALID', 'Add a name, business name, or email.');
  }
  return { name, email: email || null, phone: phone || null, businessName: businessName || null };
}

async function createReferral(portalUser, body = {}) {
  if (!portalUser || !portalUser.id) throw fail('AUTH_REQUIRED', 'Sign in required', 401);
  const fields = validateReferralInput(body);
  const referrerEmail = normalizeEmail(portalUser.email);
  const referrerBiz = normalizeBusiness(portalUser.business_name);

  if (fields.email && fields.email === referrerEmail) {
    throw fail('SELF_REFERRAL', 'You cannot refer yourself.');
  }
  if (fields.businessName && referrerBiz && normalizeBusiness(fields.businessName) === referrerBiz) {
    throw fail('SELF_REFERRAL', 'That looks like your own business.');
  }

  // Avoid exact duplicate pending rows from the same referrer.
  if (fields.email) {
    const dup = await query(
      `SELECT id FROM portal_referrals
       WHERE referrer_portal_user_id = :uid
         AND LOWER(IFNULL(referred_email,'')) = :email
         AND status IN ('pending','signed_up')
       LIMIT 1`,
      { uid: Number(portalUser.id), email: fields.email }
    );
    if (dup[0]) throw fail('DUPLICATE', 'You already referred that email.');
  }

  const nowSql = driver() === 'sqlite' ? "datetime('now')" : 'CURRENT_TIMESTAMP';
  const result = await query(
    `INSERT INTO portal_referrals
       (referrer_portal_user_id, referrer_workspace_id, referrer_lead_id,
        referred_name, referred_email, referred_phone, referred_business_name,
        status, created_at, updated_at)
     VALUES
       (:uid, :ws, :leadId, :name, :email, :phone, :biz, 'pending', ${nowSql}, ${nowSql})`,
    {
      uid: Number(portalUser.id),
      ws: Number(portalUser.workspace_id),
      leadId: portalUser.lead_id != null ? Number(portalUser.lead_id) : null,
      name: fields.name || '',
      email: fields.email,
      phone: fields.phone,
      biz: fields.businessName,
    }
  );

  const id = (result && result.insertId)
    || (await query(
      `SELECT id FROM portal_referrals
       WHERE referrer_portal_user_id = :uid
       ORDER BY id DESC LIMIT 1`,
      { uid: Number(portalUser.id) }
    ))[0]?.id;

  // Best-effort: mark signed_up if they already have a portal account.
  if (id) await refreshReferralMatch(id).catch(() => {});

  return getReferral(id);
}

async function getReferral(id) {
  const rows = await query(
    `SELECT * FROM portal_referrals WHERE id = :id LIMIT 1`,
    { id: Number(id) }
  );
  return rows[0] || null;
}

async function listReferralsForPortalUser(portalUserId) {
  const uid = Number(portalUserId);
  if (!uid) return [];
  return query(
    `SELECT id, referrer_portal_user_id, referrer_workspace_id, referrer_lead_id,
            referred_name, referred_email, referred_phone, referred_business_name,
            status, linked_lead_id, linked_portal_user_id, linked_user_id,
            plan_id, plan_amount_cents, credits_awarded, credited_at,
            stripe_subscription_id, created_at, updated_at
     FROM portal_referrals
     WHERE referrer_portal_user_id = :uid
     ORDER BY id DESC
     LIMIT 200`,
    { uid }
  );
}

async function findPortalMatch({ email, businessName } = {}) {
  const e = normalizeEmail(email);
  const biz = normalizeBusiness(businessName);
  if (e) {
    const byEmail = await query(
      `SELECT id, email, workspace_id, lead_id, business_name, status
       FROM client_portal_users
       WHERE LOWER(email) = :email
       LIMIT 1`,
      { email: e }
    );
    if (byEmail[0]) return byEmail[0];
  }
  if (biz) {
    const byBiz = await query(
      `SELECT id, email, workspace_id, lead_id, business_name, status
       FROM client_portal_users
       WHERE LOWER(TRIM(business_name)) = :biz
       LIMIT 5`,
      { biz }
    );
    // Prefer exact normalized match when multiple.
    const hit = (byBiz || []).find((r) => normalizeBusiness(r.business_name) === biz);
    if (hit) return hit;
  }
  return null;
}

async function refreshReferralMatch(referralId) {
  const row = await getReferral(referralId);
  if (!row || row.status === STATUS_CREDITED) return row;
  const match = await findPortalMatch({
    email: row.referred_email,
    businessName: row.referred_business_name,
  });
  if (!match) return row;
  if (Number(match.id) === Number(row.referrer_portal_user_id)) return row;

  const nowSql = driver() === 'sqlite' ? "datetime('now')" : 'CURRENT_TIMESTAMP';
  await query(
    `UPDATE portal_referrals SET
       linked_portal_user_id = :puid,
       linked_lead_id = :leadId,
       status = CASE WHEN status = 'credited' THEN status ELSE 'signed_up' END,
       updated_at = ${nowSql}
     WHERE id = :id AND status != 'credited'`,
    {
      id: Number(row.id),
      puid: Number(match.id),
      leadId: match.lead_id != null ? Number(match.lead_id) : null,
    }
  );
  return getReferral(row.id);
}

async function summaryForPortalUser(portalUser) {
  const math = await creditMathSummary();
  const rows = await listReferralsForPortalUser(portalUser.id);
  // Refresh pending matches (best-effort, capped).
  for (const r of rows.filter((x) => x.status === STATUS_PENDING).slice(0, 20)) {
    await refreshReferralMatch(r.id).catch(() => {});
  }
  const fresh = await listReferralsForPortalUser(portalUser.id);
  let earned = 0;
  let estimatedPending = 0;
  for (const r of fresh) {
    if (r.status === STATUS_CREDITED) {
      earned += Math.max(0, Number(r.credits_awarded) || 0);
    } else {
      estimatedPending += math.standardEstimateCredits;
    }
  }
  return {
    referrals: fresh.map(publicReferral),
    totals: {
      earnedCredits: earned,
      estimatedPendingCredits: estimatedPending,
      count: fresh.length,
      pending: fresh.filter((r) => r.status === STATUS_PENDING).length,
      signedUp: fresh.filter((r) => r.status === STATUS_SIGNED_UP).length,
      credited: fresh.filter((r) => r.status === STATUS_CREDITED).length,
    },
    creditMath: math,
  };
}

function publicReferral(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.referred_name || '',
    email: row.referred_email || '',
    phone: row.referred_phone || '',
    businessName: row.referred_business_name || '',
    status: row.status || STATUS_PENDING,
    linkedLeadId: row.linked_lead_id || null,
    planId: row.plan_id || null,
    planAmountCents: row.plan_amount_cents != null ? Number(row.plan_amount_cents) : null,
    creditsAwarded: Number(row.credits_awarded) || 0,
    creditedAt: row.credited_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

/**
 * Called from billing.syncSubscription when a user lands on an active paid plan.
 * Idempotent via credit ledger key + status=credited.
 */
async function tryAwardForPaidUser(userId, {
  plan = null,
  subscription = null,
  planAmountCents = null,
} = {}) {
  const uid = Number(userId);
  if (!uid) return { awarded: false, reason: 'no_user' };

  const users = await query(
    `SELECT id, email, name, billing_plan, subscription_status
     FROM users WHERE id = :id LIMIT 1`,
    { id: uid }
  );
  const user = users[0];
  if (!user) return { awarded: false, reason: 'user_missing' };

  const email = normalizeEmail(user.email);
  const portalRows = email
    ? await query(
      `SELECT id, email, workspace_id, lead_id, business_name
       FROM client_portal_users WHERE LOWER(email) = :email LIMIT 1`,
      { email }
    )
    : [];
  const portalUser = portalRows[0] || null;
  const bizNorm = normalizeBusiness(portalUser && portalUser.business_name);

  // Find open referrals matching email or business name.
  let candidates = [];
  if (email) {
    candidates = await query(
      `SELECT * FROM portal_referrals
       WHERE status IN ('pending','signed_up')
         AND referred_email IS NOT NULL
         AND LOWER(referred_email) = :email
       ORDER BY id ASC
       LIMIT 20`,
      { email }
    );
  }
  if ((!candidates || !candidates.length) && bizNorm) {
    const byBiz = await query(
      `SELECT * FROM portal_referrals
       WHERE status IN ('pending','signed_up')
         AND referred_business_name IS NOT NULL
         AND referred_business_name != ''
       ORDER BY id ASC
       LIMIT 100`,
      {}
    );
    candidates = (byBiz || []).filter(
      (r) => normalizeBusiness(r.referred_business_name) === bizNorm
    );
  }
  if (!candidates.length) return { awarded: false, reason: 'no_match' };

  // Skip self-referrals (same portal user or same email as referrer).
  const filtered = [];
  for (const r of candidates) {
    if (portalUser && Number(r.referrer_portal_user_id) === Number(portalUser.id)) continue;
    const refRows = await query(
      `SELECT id, email FROM client_portal_users WHERE id = :id LIMIT 1`,
      { id: Number(r.referrer_portal_user_id) }
    );
    const ref = refRows[0];
    if (ref && email && normalizeEmail(ref.email) === email) continue;
    filtered.push(r);
  }
  if (!filtered.length) return { awarded: false, reason: 'self_or_empty' };

  const primary = filtered[0];
  const others = filtered.slice(1);

  let cents = Number(planAmountCents);
  if (!Number.isFinite(cents) || cents < 1) {
    cents = planAmountCentsFromSubscription(subscription);
  }
  if (!Number.isFinite(cents) || cents < 1) {
    cents = await estimatePlanCents(plan || 'standard');
  }

  const percent = await rewardPercent();
  const perCredit = await usdPerCredit();
  const creditCount = creditsFromPlanCents(cents, percent, perCredit);
  const subId = subscription && subscription.id ? String(subscription.id) : null;
  const idem = `referral:${primary.id}:sub:${subId || `user:${uid}`}`;

  const credits = require('./credits');
  const grantResult = await credits.grant(Number(primary.referrer_workspace_id), creditCount, {
    userId: uid,
    reason: 'referral_reward',
    refType: 'referral',
    refId: String(primary.id),
    idempotencyKey: idem,
  });

  const nowSql = driver() === 'sqlite' ? "datetime('now')" : 'CURRENT_TIMESTAMP';
  if (!grantResult.duplicate) {
    await query(
      `UPDATE portal_referrals SET
         status = 'credited',
         linked_user_id = :uid,
         linked_portal_user_id = COALESCE(:puid, linked_portal_user_id),
         linked_lead_id = COALESCE(:leadId, linked_lead_id),
         plan_id = :plan,
         plan_amount_cents = :cents,
         credits_awarded = :credits,
         stripe_subscription_id = :subId,
         credited_at = ${nowSql},
         updated_at = ${nowSql}
       WHERE id = :id`,
      {
        id: Number(primary.id),
        uid,
        puid: portalUser ? Number(portalUser.id) : null,
        leadId: portalUser && portalUser.lead_id != null ? Number(portalUser.lead_id) : null,
        plan: String(plan || '').slice(0, 40) || null,
        cents,
        credits: creditCount,
        subId,
      }
    );
  } else {
    // Already granted — ensure row reflects credited state.
    await query(
      `UPDATE portal_referrals SET
         status = 'credited',
         linked_user_id = COALESCE(linked_user_id, :uid),
         credits_awarded = CASE WHEN credits_awarded > 0 THEN credits_awarded ELSE :credits END,
         plan_amount_cents = COALESCE(plan_amount_cents, :cents),
         stripe_subscription_id = COALESCE(stripe_subscription_id, :subId),
         credited_at = COALESCE(credited_at, ${nowSql}),
         updated_at = ${nowSql}
       WHERE id = :id`,
      { id: Number(primary.id), uid, credits: creditCount, cents, subId }
    );
  }

  // Other matches for the same person: mark signed_up (no credits).
  for (const o of others) {
    await query(
      `UPDATE portal_referrals SET
         status = CASE WHEN status = 'credited' THEN status ELSE 'signed_up' END,
         linked_user_id = COALESCE(linked_user_id, :uid),
         linked_portal_user_id = COALESCE(:puid, linked_portal_user_id),
         updated_at = ${nowSql}
       WHERE id = :id AND status != 'credited'`,
      {
        id: Number(o.id),
        uid,
        puid: portalUser ? Number(portalUser.id) : null,
      }
    );
  }

  return {
    awarded: !grantResult.duplicate,
    duplicate: !!grantResult.duplicate,
    referralId: primary.id,
    credits: creditCount,
    balance: grantResult.balance,
    planAmountCents: cents,
  };
}

module.exports = {
  STATUS_PENDING,
  STATUS_SIGNED_UP,
  STATUS_CREDITED,
  createReferral,
  listReferralsForPortalUser,
  summaryForPortalUser,
  getReferral,
  publicReferral,
  tryAwardForPaidUser,
  creditMathSummary,
  creditsFromPlanCents,
  usdPerCredit,
  rewardPercent,
  validateReferralInput,
};
