'use strict';

const { query, driver } = require('./db');
const platform = require('./platform');
const {
  PLAN_FREE,
  PLAN_STANDARD,
  PLAN_PREMIUM,
  normalizePlanId,
  getPlan,
  listPlans,
  isPaidPlan,
  maxPlan,
  publicPlan,
} = require('./plans');
const {
  getStripe,
  getPriceIdForPlan,
  getConfiguredPriceIds,
  planIdFromPriceId,
  getPublishableKey,
  integrationId,
} = require('./stripeClient');
const credits = require('./credits');
const { staffUrl } = require('./appUrls');

/** Includes past_due for grace access (banner + portal to update card). */
const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);
/** Healthy paid — used for upgrades / “all clear” UI (excludes past_due). */
const HEALTHY_PAID_STATUSES = new Set(['active', 'trialing']);

async function getUserBilling(userId) {
  const rows = await query(
    `SELECT id, email, name, status, is_super_admin,
            stripe_customer_id, stripe_subscription_id, subscription_status,
            subscription_price_id, billing_plan, current_period_end, deleted_at
     FROM users WHERE id = :id LIMIT 1`,
    { id: Number(userId) }
  );
  return rows[0] || null;
}

/** Active paid Stripe subscription (Standard or Premium), including past_due grace. */
function isSubscribed(user) {
  if (!user) return false;
  if (Number(user.is_super_admin) === 1) return true;
  if (String(user.status || 'active') === 'disabled' || user.deleted_at) return false;
  return ACTIVE_STATUSES.has(String(user.subscription_status || ''));
}

function isHealthyPaid(user) {
  if (!user) return false;
  if (Number(user.is_super_admin) === 1) return true;
  if (String(user.status || 'active') === 'disabled' || user.deleted_at) return false;
  return HEALTHY_PAID_STATUSES.has(String(user.subscription_status || ''));
}

/** Block upgrades / credit purchases while subscription is past_due (use Billing Portal). */
function assertNotPastDue(user) {
  if (!user) return;
  if (Number(user.is_super_admin) === 1) return;
  if (String(user.subscription_status || '') === 'past_due') {
    throw Object.assign(
      new Error('Payment past due — update your card in Billing Portal before purchasing or upgrading'),
      { code: 'PAST_DUE', status: 402 }
    );
  }
}

function planOfUser(user) {
  if (!user) return PLAN_FREE;
  if (Number(user.is_super_admin) === 1) return PLAN_PREMIUM;
  if (String(user.status || 'active') === 'disabled' || user.deleted_at) return PLAN_FREE;
  const stored = normalizePlanId(user.billing_plan);
  if (isSubscribed(user) && isPaidPlan(stored)) return stored;
  if (isSubscribed(user)) return PLAN_STANDARD; // legacy paid without mapped plan
  return PLAN_FREE;
}

/**
 * Core product access (website, edits, leads, etc.).
 * Free tier always has core access — Checkout is only for Standard/Premium upgrades.
 * billing.require_subscription controls paid entitlements elsewhere, not this gate.
 */
function hasProductAccess(user) {
  if (!user) return false;
  if (Number(user.is_super_admin) === 1) return true;
  if (String(user.status || 'active') === 'disabled' || user.deleted_at) return false;
  return true;
}

async function requireSubscriptionEnabled() {
  return (await platform.getPlatformSetting('billing.require_subscription', '1')) === '1';
}

async function workspaceOwnerRows(workspaceId) {
  if (!workspaceId) return [];
  return query(
    `SELECT u.id, u.is_super_admin, u.subscription_status, u.status, u.deleted_at,
            u.billing_plan, u.subscription_price_id
     FROM workspace_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = :workspaceId AND m.role IN ('owner','admin')`,
    { workspaceId: Number(workspaceId) }
  );
}

/** True if any owner/admin has an active paid plan. */
async function workspaceHasSubscription(workspaceId) {
  const members = await workspaceOwnerRows(workspaceId);
  return (members || []).some((u) => isSubscribed(u));
}

/** Highest plan among workspace owners/admins (Free if none paid). */
async function workspacePlan(workspaceId) {
  const members = await workspaceOwnerRows(workspaceId);
  let best = PLAN_FREE;
  for (const u of members || []) {
    best = maxPlan(best, planOfUser(u));
  }
  return best;
}

/**
 * Entitlement plan for an actor: max(workspace owner/admin plan, actor's own plan).
 * Portal clients pay as members — their subscription must unlock features.
 */
async function effectivePlan(workspaceId, opts = {}) {
  let best = await workspacePlan(workspaceId);
  let user = null;
  if (opts.userId != null && Number(opts.userId) > 0) {
    user = await getUserBilling(opts.userId);
  } else if (opts.email) {
    const email = String(opts.email || '').trim().toLowerCase();
    if (email) {
      const rows = await query(
        `SELECT id, email, name, status, is_super_admin,
                stripe_customer_id, stripe_subscription_id, subscription_status,
                subscription_price_id, billing_plan, current_period_end, deleted_at
         FROM users WHERE email = :email LIMIT 1`,
        { email }
      );
      user = rows[0] || null;
    }
  }
  if (user) best = maxPlan(best, planOfUser(user));
  return best;
}

/** Claim Stripe event.id for idempotency. Returns false if already processed. */
async function claimStripeEvent(event) {
  if (!event || !event.id) return true;
  const id = String(event.id);
  const type = String(event.type || '');
  try {
    await query(
      `INSERT INTO stripe_events (event_id, type) VALUES (:id, :type)`,
      { id, type }
    );
    return true;
  } catch (e) {
    const msg = String(e && e.message || e);
    const code = e && (e.code || e.errno);
    if (
      code === 'ER_DUP_ENTRY'
      || code === 'SQLITE_CONSTRAINT_UNIQUE'
      || code === 'SQLITE_CONSTRAINT'
      || /Duplicate entry|UNIQUE constraint/i.test(msg)
    ) {
      return false;
    }
    throw e;
  }
}

async function releaseStripeEvent(eventId) {
  if (!eventId) return;
  try {
    await query('DELETE FROM stripe_events WHERE event_id = :id', { id: String(eventId) });
  } catch (e) {
    console.warn('[billing] releaseStripeEvent:', e.message);
  }
}

async function workspaceHasProductAccess(workspaceId) {
  if (!workspaceId) return false;
  const required = await requireSubscriptionEnabled();
  if (!required) return true;
  const members = await workspaceOwnerRows(workspaceId);
  return (members || []).some((u) => hasProductAccess(u));
}

async function ensureCustomer(user) {
  // Re-read — parallel checkouts may have filled stripe_customer_id already.
  const fresh = await getUserBilling(user.id);
  if (fresh && fresh.stripe_customer_id) return fresh.stripe_customer_id;

  const stripe = await getStripe();
  let existingId = null;

  try {
    const found = await stripe.customers.search({
      query: `metadata['user_id']:'${Number(user.id)}'`,
      limit: 1,
    });
    if (found.data && found.data[0]) existingId = found.data[0].id;
  } catch { /* Search API may be unavailable on some accounts */ }

  // Only reuse a Stripe customer when metadata.user_id matches — never bind by email alone.
  if (!existingId && user.email) {
    try {
      const listed = await stripe.customers.list({ email: user.email, limit: 10 });
      const match = (listed.data || []).find(
        (c) => c.metadata && String(c.metadata.user_id) === String(user.id)
      );
      if (match) existingId = match.id;
    } catch { /* ignore */ }
  }

  if (!existingId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name || undefined,
      metadata: { user_id: String(user.id) },
    });
    existingId = customer.id;
  }

  // Only win the write if still empty (another request may have stored a customer).
  await query(
    `UPDATE users SET stripe_customer_id = :cid
     WHERE id = :id AND (stripe_customer_id IS NULL OR stripe_customer_id = '')`,
    { cid: existingId, id: user.id }
  );
  const again = await getUserBilling(user.id);
  return (again && again.stripe_customer_id) || existingId;
}

/**
 * Start Checkout for Standard or Premium.
 * @param {number} userId
 * @param {string} [planId] standard|premium (default standard)
 * @param {{ successUrl?: string, cancelUrl?: string }} [opts]
 */
async function createCheckoutSession(userId, planId = PLAN_STANDARD, opts = {}) {
  const user = await getUserBilling(userId);
  if (!user) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  if (String(user.status) === 'disabled' || user.deleted_at) {
    throw Object.assign(new Error('ACCOUNT_DISABLED'), { code: 'ACCOUNT_DISABLED' });
  }
  assertNotPastDue(user);
  const plan = normalizePlanId(planId);
  if (!isPaidPlan(plan)) {
    throw Object.assign(new Error('Choose Standard or Premium to subscribe'), { code: 'INVALID_PLAN' });
  }
  if (isSubscribed(user) && user.stripe_subscription_id && !opts.forceCheckout) {
    throw Object.assign(
      new Error('You already have an active subscription — use change-plan to switch'),
      { code: 'ALREADY_SUBSCRIBED' }
    );
  }
  const priceId = String(await getPriceIdForPlan(plan) || '').trim();
  if (!priceId) {
    throw Object.assign(
      new Error(`No Stripe price configured for ${plan} (stripe.price_id_${plan})`),
      { code: 'PRICE_NOT_CONFIGURED' }
    );
  }
  const stripe = await getStripe();
  // Never open a second Checkout while Stripe still reports an active subscription.
  if (opts.forceCheckout && user.stripe_subscription_id) {
    try {
      const existingSub = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
      if (ACTIVE_STATUSES.has(String(existingSub.status || ''))) {
        throw Object.assign(
          new Error('Active subscription exists — use Billing Portal or change-plan'),
          { code: 'ALREADY_SUBSCRIBED' }
        );
      }
    } catch (e) {
      if (e.code === 'ALREADY_SUBSCRIBED') throw e;
      // retrieve failed — safe to start a new checkout
    }
  }
  const customerId = await ensureCustomer(user);
  const successUrl = opts.successUrl
    || staffUrl('billing', { checkout: 'success', plan });
  const cancelUrl = opts.cancelUrl || staffUrl('billing', { checkout: 'cancel' });
  const params = {
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: String(user.id),
    metadata: { user_id: String(user.id), plan },
    subscription_data: {
      metadata: { user_id: String(user.id), plan },
    },
    // Omit payment_method_types — dynamic payment methods from Dashboard
  };
  const trialDays = Math.max(0, Math.min(365, Number(await platform.getPlatformSetting('billing.trial_days', '0')) || 0));
  if (trialDays > 0) params.subscription_data.trial_period_days = trialDays;
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      ...params,
      integration_identifier: integrationId(`sub-${plan}`),
    });
  } catch (e) {
    if (String(e.message || '').includes('integration_identifier')) {
      session = await stripe.checkout.sessions.create(params);
    } else {
      throw e;
    }
  }
  return { action: 'checkout', url: session.url, sessionId: session.id, plan };
}

async function createPortalSession(userId) {
  const user = await getUserBilling(userId);
  if (!user || !user.stripe_customer_id) {
    throw Object.assign(new Error('No Stripe customer yet — subscribe first'), { code: 'NO_CUSTOMER' });
  }
  const stripe = await getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: staffUrl('billing'),
  });
  return { url: session.url };
}

/**
 * Fetch live Stripe subscription flags (cancel_at_period_end, item price).
 * Returns null when the user has no subscription id.
 */
async function getLiveSubscription(user) {
  if (!user || !user.stripe_subscription_id) return null;
  try {
    const stripe = await getStripe();
    return await stripe.subscriptions.retrieve(user.stripe_subscription_id);
  } catch (e) {
    console.warn('[billing] retrieve subscription:', e.message);
    return null;
  }
}

/**
 * Cancel at period end (downgrade to Free after current period).
 * Access stays paid until current_period_end; webhook clears plan when canceled.
 */
async function scheduleCancelAtPeriodEnd(userId) {
  const user = await getUserBilling(userId);
  if (!user) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  if (String(user.status) === 'disabled' || user.deleted_at) {
    throw Object.assign(new Error('ACCOUNT_DISABLED'), { code: 'ACCOUNT_DISABLED' });
  }
  if (!isSubscribed(user) || !user.stripe_subscription_id) {
    throw Object.assign(new Error('No active subscription to cancel'), { code: 'NO_SUBSCRIPTION' });
  }
  const stripe = await getStripe();
  const updated = await stripe.subscriptions.update(user.stripe_subscription_id, {
    cancel_at_period_end: true,
  });
  await syncSubscription(updated);
  const periodEnd = updated.current_period_end
    ? new Date(updated.current_period_end * 1000).toISOString()
    : (user.current_period_end || null);
  return {
    action: 'cancel_at_period_end',
    plan: planOfUser(await getUserBilling(userId)),
    cancelAtPeriodEnd: true,
    currentPeriodEnd: periodEnd,
    message: 'Your plan stays active until the end of the billing period, then moves to Free.',
  };
}

/**
 * Clear a scheduled cancel (keep current paid plan).
 */
async function resumeSubscription(userId) {
  const user = await getUserBilling(userId);
  if (!user) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  if (!isSubscribed(user) || !user.stripe_subscription_id) {
    throw Object.assign(new Error('No active subscription to resume'), { code: 'NO_SUBSCRIPTION' });
  }
  const stripe = await getStripe();
  const updated = await stripe.subscriptions.update(user.stripe_subscription_id, {
    cancel_at_period_end: false,
  });
  await syncSubscription(updated);
  return {
    action: 'resumed',
    plan: planOfUser(await getUserBilling(userId)),
    cancelAtPeriodEnd: false,
    message: 'Cancellation withdrawn — your plan will renew as usual.',
  };
}

/**
 * Switch Standard ↔ Premium on an existing Stripe subscription (proration).
 * Falls back to Checkout when there is no active subscription.
 * planId=free schedules cancel at period end.
 */
async function changeSubscriptionPlan(userId, planId, opts = {}) {
  const user = await getUserBilling(userId);
  if (!user) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  if (String(user.status) === 'disabled' || user.deleted_at) {
    throw Object.assign(new Error('ACCOUNT_DISABLED'), { code: 'ACCOUNT_DISABLED' });
  }
  // Reject unknown ids before normalizePlanId (which maps unknowns → free).
  const raw = String(planId || '').trim().toLowerCase();
  if (!raw || ![PLAN_FREE, PLAN_STANDARD, PLAN_PREMIUM].includes(raw)) {
    throw Object.assign(new Error('Choose Free, Standard, or Premium'), { code: 'INVALID_PLAN' });
  }
  const plan = normalizePlanId(raw);

  if (plan === PLAN_FREE) {
    return scheduleCancelAtPeriodEnd(userId);
  }
  if (!isPaidPlan(plan)) {
    throw Object.assign(new Error('Choose Free, Standard, or Premium'), { code: 'INVALID_PLAN' });
  }
  // Upgrades / plan switches while past_due → Billing Portal for card update first.
  assertNotPastDue(user);

  const priceId = String(await getPriceIdForPlan(plan) || '').trim();
  if (!priceId) {
    throw Object.assign(
      new Error(`No Stripe price configured for ${plan} (stripe.price_id_${plan})`),
      { code: 'PRICE_NOT_CONFIGURED' }
    );
  }

  if (!isSubscribed(user) || !user.stripe_subscription_id) {
    const checkout = await createCheckoutSession(userId, plan, {
      ...opts,
      forceCheckout: true,
    });
    return { ...checkout, action: 'checkout' };
  }

  const stripe = await getStripe();
  let sub;
  try {
    sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
  } catch (e) {
    const checkout = await createCheckoutSession(userId, plan, {
      ...opts,
      forceCheckout: true,
    });
    return { ...checkout, action: 'checkout' };
  }

  if (!ACTIVE_STATUSES.has(String(sub.status || ''))) {
    const checkout = await createCheckoutSession(userId, plan, {
      ...opts,
      forceCheckout: true,
    });
    return { ...checkout, action: 'checkout' };
  }

  const item = sub.items && sub.items.data && sub.items.data[0];
  if (!item) {
    throw Object.assign(new Error('Subscription has no line items to update'), { code: 'NO_SUBSCRIPTION_ITEM' });
  }

  const currentPrice = item.price && item.price.id;
  if (currentPrice === priceId) {
    if (sub.cancel_at_period_end) {
      const resumed = await stripe.subscriptions.update(sub.id, {
        cancel_at_period_end: false,
        metadata: Object.assign({}, sub.metadata || {}, {
          user_id: String(user.id),
          plan,
        }),
      });
      await syncSubscription(resumed);
      return {
        action: 'resumed',
        plan,
        cancelAtPeriodEnd: false,
        message: 'You are already on this plan — renewal will continue.',
      };
    }
    return {
      action: 'unchanged',
      plan,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      message: 'You are already on this plan.',
    };
  }

  const updated = await stripe.subscriptions.update(sub.id, {
    items: [{ id: item.id, price: priceId }],
    // Prorate immediately so upgrades/downgrades settle on the next invoice.
    proration_behavior: 'create_prorations',
    cancel_at_period_end: false,
    metadata: Object.assign({}, sub.metadata || {}, {
      user_id: String(user.id),
      plan,
    }),
  });
  await syncSubscription(updated);
  const fresh = await getUserBilling(userId);
  return {
    action: 'updated',
    plan: planOfUser(fresh) || plan,
    subscriptionId: updated.id,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: fresh && fresh.current_period_end,
    message: plan === PLAN_PREMIUM
      ? 'Upgraded to Premium. Proration appears on your next invoice.'
      : 'Switched to Standard. Proration appears on your next invoice.',
  };
}

/**
 * Unified entry: Checkout for first subscribe, subscription update when already paid.
 */
async function startOrChangePlan(userId, planId, opts = {}) {
  return changeSubscriptionPlan(userId, planId, opts);
}

async function userBelongsToWorkspace(userId, workspaceId) {
  const rows = await query(
    `SELECT workspace_id FROM workspace_members
     WHERE user_id = :uid AND workspace_id = :wid LIMIT 1`,
    { uid: Number(userId), wid: Number(workspaceId) }
  );
  return !!rows[0];
}

async function resolveWorkspaceIdForUser(userId, preferredWorkspaceId) {
  const preferred = Number(preferredWorkspaceId || 0);
  if (preferred > 0 && await userBelongsToWorkspace(userId, preferred)) return preferred;
  const rows = await query(
    `SELECT workspace_id FROM workspace_members
     WHERE user_id = :uid
     ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, workspace_id ASC
     LIMIT 1`,
    { uid: Number(userId) }
  );
  return rows[0] ? Number(rows[0].workspace_id) : null;
}

/**
 * One-time Stripe Checkout for a credits pack (mode=payment).
 * Credits are granted on checkout.session.completed / async_payment_succeeded.
 */
async function createCreditsCheckoutSession(userId, workspaceId, opts = {}) {
  const user = await getUserBilling(userId);
  if (!user) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  if (String(user.status) === 'disabled' || user.deleted_at) {
    throw Object.assign(new Error('ACCOUNT_DISABLED'), { code: 'ACCOUNT_DISABLED' });
  }
  assertNotPastDue(user);
  const wid = Number(workspaceId);
  if (!Number.isFinite(wid) || wid < 1) {
    throw Object.assign(new Error('workspaceId is required to buy credits'), { code: 'WORKSPACE_REQUIRED' });
  }
  if (!(await userBelongsToWorkspace(userId, wid))) {
    throw Object.assign(new Error('You are not a member of this workspace'), { code: 'FORBIDDEN', status: 403 });
  }

  const cfg = await credits.packConfig();
  if (!cfg.priceId) {
    throw Object.assign(
      new Error('No credits Price ID configured (stripe.price_id_credits)'),
      { code: 'PRICE_NOT_CONFIGURED' }
    );
  }

  const quantity = Math.min(20, Math.max(1, Math.floor(Number(opts.quantity) || 1)));
  const totalCredits = cfg.packAmount * quantity;
  const stripe = await getStripe();
  const customerId = await ensureCustomer(user);
  const successUrl = opts.successUrl
    || staffUrl('billing', { checkout: 'credits_success' });
  const cancelUrl = opts.cancelUrl || staffUrl('billing', { checkout: 'cancel' });

  const params = {
    mode: 'payment',
    customer: customerId,
    line_items: [{ price: cfg.priceId, quantity }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: String(user.id),
    metadata: {
      purpose: 'credits',
      user_id: String(user.id),
      workspace_id: String(wid),
      credits: String(totalCredits),
      pack_amount: String(cfg.packAmount),
      quantity: String(quantity),
    },
    payment_intent_data: {
      metadata: {
        purpose: 'credits',
        user_id: String(user.id),
        workspace_id: String(wid),
        credits: String(totalCredits),
      },
    },
  };

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      ...params,
      integration_identifier: integrationId('credits-pack'),
    });
  } catch (e) {
    if (String(e.message || '').includes('integration_identifier')) {
      session = await stripe.checkout.sessions.create(params);
    } else {
      throw e;
    }
  }
  return {
    url: session.url,
    sessionId: session.id,
    credits: totalCredits,
    packAmount: cfg.packAmount,
    quantity,
    packLabel: cfg.packLabel,
  };
}

async function resolvePlanFromSubscription(subscription) {
  const priceId = subscription.items && subscription.items.data && subscription.items.data[0]
    ? subscription.items.data[0].price.id
    : null;
  let plan = await planIdFromPriceId(priceId);
  if (!plan && subscription.metadata && subscription.metadata.plan) {
    const meta = normalizePlanId(subscription.metadata.plan);
    if (isPaidPlan(meta)) plan = meta;
  }
  if (!ACTIVE_STATUSES.has(String(subscription.status || ''))) {
    return { plan: PLAN_FREE, priceId };
  }
  return { plan: plan || PLAN_STANDARD, priceId };
}

async function syncSubscription(subscription) {
  if (!subscription || !subscription.id) return;
  const userId = Number(
    (subscription.metadata && subscription.metadata.user_id) || 0
  );
  let uid = userId;
  if (!uid && subscription.customer) {
    const rows = await query(
      'SELECT id FROM users WHERE stripe_customer_id = :cid LIMIT 1',
      { cid: String(subscription.customer) }
    );
    if (rows[0]) uid = rows[0].id;
  }
  if (!uid) return;

  const { plan, priceId } = await resolvePlanFromSubscription(subscription);
  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000)
    : null;
  const periodEndSql = periodEnd
    ? periodEnd.toISOString().slice(0, 19).replace('T', ' ')
    : null;

  const active = ACTIVE_STATUSES.has(String(subscription.status || ''));
  await query(
    `UPDATE users SET
       stripe_subscription_id = :subId,
       subscription_status = :status,
       subscription_price_id = :priceId,
       billing_plan = :plan,
       current_period_end = :periodEnd
     WHERE id = :id`,
    {
      subId: subscription.id,
      status: subscription.status || '',
      priceId: priceId || '',
      plan: active ? plan : PLAN_FREE,
      periodEnd: periodEndSql,
      id: uid,
    }
  );

  // Referral rewards: when a referred client activates a paid plan, credit the referrer.
  if (active && isPaidPlan(plan)) {
    try {
      const referrals = require('./referrals');
      await referrals.tryAwardForPaidUser(uid, {
        plan,
        subscription,
      });
    } catch (e) {
      console.warn('[billing] referral award:', e.message);
    }
  }
}

async function recordPaymentFromInvoice(invoice) {
  if (!invoice || !invoice.id) return null;
  const existing = await query(
    'SELECT id FROM payments WHERE stripe_invoice_id = :iid LIMIT 1',
    { iid: invoice.id }
  );
  if (existing[0]) return existing[0].id;

  let userId = null;
  if (invoice.customer) {
    const rows = await query(
      'SELECT id FROM users WHERE stripe_customer_id = :cid LIMIT 1',
      { cid: String(invoice.customer) }
    );
    if (rows[0]) userId = rows[0].id;
  }
  if (!userId && invoice.subscription_details && invoice.subscription_details.metadata) {
    userId = Number(invoice.subscription_details.metadata.user_id) || null;
  }
  if (!userId && invoice.subscription) {
    const subId = typeof invoice.subscription === 'string'
      ? invoice.subscription
      : invoice.subscription.id;
    const rows = await query(
      'SELECT id FROM users WHERE stripe_subscription_id = :sid LIMIT 1',
      { sid: subId }
    );
    if (rows[0]) userId = rows[0].id;
  }

  const amount = Number(invoice.amount_paid != null ? invoice.amount_paid : invoice.amount_due) || 0;
  const pi = typeof invoice.payment_intent === 'string'
    ? invoice.payment_intent
    : (invoice.payment_intent && invoice.payment_intent.id) || null;
  const charge = typeof invoice.charge === 'string'
    ? invoice.charge
    : (invoice.charge && invoice.charge.id) || null;

  try {
    const result = await query(
      `INSERT INTO payments
        (user_id, stripe_invoice_id, stripe_payment_intent_id, stripe_charge_id,
         amount_cents, currency, status, description)
       VALUES
        (:userId, :invoiceId, :pi, :charge, :amount, :currency, :status, :description)`,
      {
        userId,
        invoiceId: invoice.id,
        pi,
        charge,
        amount,
        currency: String(invoice.currency || 'usd').toLowerCase(),
        status: invoice.status === 'paid' ? 'succeeded' : (invoice.status || 'open'),
        description: invoice.description || `Invoice ${invoice.number || invoice.id}`,
      }
    );
    return result.insertId || null;
  } catch (e) {
    // Concurrent invoice.paid webhooks — unique stripe_invoice_id.
    if (e.code === 'ER_DUP_ENTRY' || /unique|duplicate/i.test(String(e.message || ''))) {
      const rows = await query(
        'SELECT id FROM payments WHERE stripe_invoice_id = :iid LIMIT 1',
        { iid: invoice.id }
      );
      return rows[0] ? rows[0].id : null;
    }
    throw e;
  }
}

async function recordRefundFromCharge(charge, refund) {
  if (!refund || !refund.id) return null;
  const existing = await query(
    'SELECT id FROM refunds WHERE stripe_refund_id = :rid LIMIT 1',
    { rid: refund.id }
  );
  if (existing[0]) return existing[0].id;

  let paymentId = null;
  let userId = null;
  let paymentRow = null;
  if (charge && charge.id) {
    const pays = await query(
      'SELECT id, user_id, amount_cents, stripe_payment_intent_id, description FROM payments WHERE stripe_charge_id = :cid LIMIT 1',
      { cid: charge.id }
    );
    if (pays[0]) {
      paymentId = pays[0].id;
      userId = pays[0].user_id;
      paymentRow = pays[0];
    }
  }
  if (!paymentRow && charge && charge.payment_intent) {
    const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent.id;
    const pays = await query(
      'SELECT id, user_id, amount_cents, stripe_payment_intent_id, description FROM payments WHERE stripe_payment_intent_id = :pi LIMIT 1',
      { pi }
    );
    if (pays[0]) {
      paymentId = pays[0].id;
      userId = pays[0].user_id;
      paymentRow = pays[0];
    }
  }
  if (!userId && charge && charge.customer) {
    const rows = await query(
      'SELECT id FROM users WHERE stripe_customer_id = :cid LIMIT 1',
      { cid: String(charge.customer) }
    );
    if (rows[0]) userId = rows[0].id;
  }

  let insertId = null;
  try {
    const result = await query(
      `INSERT INTO refunds
        (payment_id, user_id, stripe_refund_id, amount_cents, currency, status, reason)
       VALUES
        (:paymentId, :userId, :refundId, :amount, :currency, :status, :reason)`,
      {
        paymentId,
        userId,
        refundId: refund.id,
        amount: Number(refund.amount) || 0,
        currency: String((charge && charge.currency) || refund.currency || 'usd').toLowerCase(),
        status: refund.status || 'succeeded',
        reason: refund.reason || '',
      }
    );
    insertId = result.insertId || null;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY' || /unique|duplicate/i.test(String(e.message || ''))) {
      const rows = await query(
        'SELECT id FROM refunds WHERE stripe_refund_id = :rid LIMIT 1',
        { rid: refund.id }
      );
      return rows[0] ? rows[0].id : null;
    }
    throw e;
  }
  if (paymentId && paymentRow) {
    const refundedCents = Number(refund.amount) || 0;
    const totalCents = Number(paymentRow.amount_cents) || 0;
    const status = (totalCents > 0 && refundedCents > 0 && refundedCents < totalCents)
      ? 'partially_refunded'
      : 'refunded';
    await query(
      'UPDATE payments SET status = :status WHERE id = :id AND status IN (\'succeeded\', \'partially_refunded\')',
      { id: paymentId, status }
    );
  } else if (paymentId) {
    await query(
      "UPDATE payments SET status = 'refunded' WHERE id = :id AND status = 'succeeded'",
      { id: paymentId }
    );
  }

  // Claw back credits for credit-pack purchases.
  try {
    const desc = paymentRow && paymentRow.description ? String(paymentRow.description) : '';
    if (/credits pack/i.test(desc) || (paymentRow && paymentRow.stripe_payment_intent_id)) {
      let checkoutSessionId = null;
      try {
        const stripe = await getStripe();
        const pi = (paymentRow && paymentRow.stripe_payment_intent_id)
          || (charge && charge.payment_intent
            ? (typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent.id)
            : null);
        if (pi) {
          const sessions = await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 });
          if (sessions.data && sessions.data[0]) checkoutSessionId = sessions.data[0].id;
        }
      } catch { /* optional */ }
      await credits.clawbackFromRefund({
        checkoutSessionId,
        refundId: refund.id,
        paymentIntentId: paymentRow && paymentRow.stripe_payment_intent_id,
      });
    }
  } catch (e) {
    console.warn('[billing] credit clawback:', e.message);
  }

  return insertId;
}

async function markSubscriptionAtRisk(customerId, reason) {
  if (!customerId) return;
  const rows = await query(
    'SELECT id, stripe_subscription_id FROM users WHERE stripe_customer_id = :cid LIMIT 1',
    { cid: String(customerId) }
  );
  if (!rows[0]) return;
  console.warn('[billing] risk event for customer', customerId, reason, 'user', rows[0].id);
  try {
    const members = await query(
      `SELECT workspace_id FROM workspace_members WHERE user_id = :uid AND role IN ('owner','admin','member')`,
      { uid: rows[0].id }
    );
    for (const m of members || []) {
      await credits.freezeWorkspaceCredits(m.workspace_id, `risk_${reason || 'flag'}`);
    }
  } catch (e) {
    console.warn('[billing] credit freeze on risk:', e.message);
  }
}

async function fulfillCreditsCheckout(session) {
  if (!session || session.mode !== 'payment') return;
  const purpose = session.metadata && session.metadata.purpose;
  if (String(purpose || '') !== 'credits') return;
  // Expand line_items when missing so pack quantity can be recomputed.
  let sess = session;
  if (!session.line_items || !session.line_items.data) {
    try {
      const stripe = await getStripe();
      sess = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items'] });
    } catch { /* use metadata only */ }
  }
  await credits.grantFromCheckoutSession(sess);
}

async function handleWebhookEvent(event) {
  const claimed = await claimStripeEvent(event);
  if (!claimed) {
    console.log('[billing] skip duplicate stripe event', event && event.id, event && event.type);
    return { duplicate: true };
  }

  try {
    await dispatchWebhookEvent(event);
    return { ok: true };
  } catch (e) {
    await releaseStripeEvent(event && event.id);
    throw e;
  }
}

async function dispatchWebhookEvent(event) {
  const type = event.type;
  const obj = event.data && event.data.object;

  if ((type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') && obj) {
    if (obj.mode === 'payment') {
      await fulfillCreditsCheckout(obj);
      return;
    }
    if (obj.mode === 'subscription' && obj.subscription) {
      const stripe = await getStripe();
      const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id;
      const sub = await stripe.subscriptions.retrieve(subId);
      const userRef = obj.client_reference_id || (obj.metadata && obj.metadata.user_id);
      const planMeta = (obj.metadata && obj.metadata.plan) || '';
      if (userRef && !sub.metadata.user_id) {
        const meta = { user_id: String(userRef) };
        if (planMeta) meta.plan = String(planMeta);
        await stripe.subscriptions.update(subId, { metadata: meta });
        sub.metadata = Object.assign({}, sub.metadata, meta);
      } else if (planMeta && !sub.metadata.plan) {
        await stripe.subscriptions.update(subId, {
          metadata: Object.assign({}, sub.metadata || {}, { plan: String(planMeta) }),
        });
        sub.metadata = Object.assign({}, sub.metadata, { plan: String(planMeta) });
      }
      await syncSubscription(sub);
    }
    return;
  }

  if (type.startsWith('customer.subscription.') && obj) {
    await syncSubscription(obj);
    return;
  }

  if (type === 'invoice.paid' && obj) {
    await recordPaymentFromInvoice(obj);
    if (obj.subscription) {
      const stripe = await getStripe();
      const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id;
      const sub = await stripe.subscriptions.retrieve(subId);
      await syncSubscription(sub);
    }
    return;
  }

  if (type === 'invoice.payment_failed' && obj) {
    await recordPaymentFromInvoice(obj);
    if (obj.subscription) {
      const stripe = await getStripe();
      const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id;
      const sub = await stripe.subscriptions.retrieve(subId);
      await syncSubscription(sub);
    }
    return;
  }

  if (type === 'charge.refunded' && obj) {
    const refunds = (obj.refunds && obj.refunds.data) || [];
    for (const r of refunds) await recordRefundFromCharge(obj, r);
    return;
  }

  if (type === 'charge.dispute.created' && obj) {
    await markSubscriptionAtRisk(obj.customer, 'dispute');
    return;
  }

  if (type === 'radar.early_fraud_warning.created' && obj) {
    const chargeId = typeof obj.charge === 'string' ? obj.charge : (obj.charge && obj.charge.id);
    if (chargeId) {
      try {
        const stripe = await getStripe();
        const charge = await stripe.charges.retrieve(chargeId);
        await markSubscriptionAtRisk(charge.customer, 'early_fraud_warning');
      } catch (e) {
        console.warn('[billing] early fraud lookup:', e.message);
      }
    }
  }
}

async function catalogForApi() {
  const prices = await getConfiguredPriceIds();
  const labelStd = await platform.getPlatformSetting('billing.amount_label_standard', 'Standard · monthly');
  const labelPrem = await platform.getPlatformSetting('billing.amount_label_premium', 'Premium · monthly');
  return listPlans().map((p) => {
    const extras = {};
    if (p.id === PLAN_STANDARD) {
      extras.priceLabel = labelStd;
      extras.priceConfigured = !!prices.standard;
      extras.checkout = true;
    } else if (p.id === PLAN_PREMIUM) {
      extras.priceLabel = labelPrem;
      extras.priceConfigured = !!prices.premium;
      extras.checkout = true;
    } else {
      extras.priceConfigured = true;
      extras.checkout = false;
    }
    return publicPlan(p.id, extras);
  });
}

async function billingSummary(userId, opts = {}) {
  const user = await getUserBilling(userId);
  if (!user) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  const prices = await getConfiguredPriceIds();
  const amountLabel = await platform.getPlatformSetting('billing.amount_label', 'Bitpype plans');
  const requireSub = await requireSubscriptionEnabled();
  const planId = planOfUser(user);
  const plan = getPlan(planId);
  const payments = await query(
    `SELECT id, amount_cents, currency, status, description, stripe_invoice_id, created_at
     FROM payments WHERE user_id = :id ORDER BY id DESC LIMIT 25`,
    { id: userId }
  );
  const productAccess = hasProductAccess(user);
  const healthyPaid = isHealthyPaid(user);
  const workspaceId = await resolveWorkspaceIdForUser(userId, opts.workspaceId);
  let creditInfo;
  if (workspaceId) {
    creditInfo = await credits.summaryForWorkspace(workspaceId);
  } else {
    const cfg = await credits.packConfig();
    creditInfo = {
      balance: 0,
      packAmount: cfg.packAmount,
      packLabel: cfg.packLabel,
      priceConfigured: cfg.configured,
      perSocialImage: cfg.perImage,
      perSocialContent: cfg.perContent,
      recent: [],
    };
  }
  let cancelAtPeriodEnd = false;
  if (isSubscribed(user) && user.stripe_subscription_id) {
    const live = await getLiveSubscription(user);
    cancelAtPeriodEnd = !!(live && live.cancel_at_period_end);
  }
  return {
    email: user.email,
    name: user.name,
    isSuperAdmin: Number(user.is_super_admin) === 1,
    subscriptionStatus: user.subscription_status || 'none',
    subscribed: isSubscribed(user),
    healthyPaid,
    pastDue: String(user.subscription_status || '') === 'past_due',
    productAccess,
    plan: planId,
    planName: plan.name,
    entitlements: { ...plan.entitlements },
    currentPeriodEnd: user.current_period_end,
    cancelAtPeriodEnd,
    stripeCustomerId: user.stripe_customer_id || null,
    hasCustomer: !!user.stripe_customer_id,
    hasActiveSubscription: isSubscribed(user) && !!user.stripe_subscription_id,
    priceId: prices.standard || null,
    priceIds: prices,
    publishableKey: (await getPublishableKey()) || null,
    amountLabel,
    requireSubscription: requireSub,
    plans: await catalogForApi(),
    payments,
    workspaceId,
    credits: creditInfo,
  };
}

async function listPayments({ limit = 100, q = '' } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  if (String(q || '').trim()) {
    const like = `%${String(q).trim()}%`;
    return query(
      `SELECT p.*, u.email AS user_email
       FROM payments p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE u.email LIKE :like OR p.stripe_invoice_id LIKE :like OR p.stripe_charge_id LIKE :like
       ORDER BY p.id DESC LIMIT ${lim}`,
      { like }
    );
  }
  return query(
    `SELECT p.*, u.email AS user_email
     FROM payments p
     LEFT JOIN users u ON u.id = p.user_id
     ORDER BY p.id DESC LIMIT ${lim}`
  );
}

async function listRefunds({ limit = 100 } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  return query(
    `SELECT r.*, u.email AS user_email, p.stripe_invoice_id
     FROM refunds r
     LEFT JOIN users u ON u.id = r.user_id
     LEFT JOIN payments p ON p.id = r.payment_id
     ORDER BY r.id DESC LIMIT ${lim}`
  );
}

async function adminRefundPayment(paymentId, { amountCents, reason } = {}) {
  const rows = await query('SELECT * FROM payments WHERE id = :id LIMIT 1', { id: Number(paymentId) });
  const payment = rows[0];
  if (!payment) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  if (!payment.stripe_charge_id && !payment.stripe_payment_intent_id) {
    throw Object.assign(new Error('Payment has no Stripe charge/PI to refund'), { code: 'NO_CHARGE' });
  }
  const stripe = await getStripe();
  const params = {
    reason: reason === 'fraudulent' || reason === 'duplicate' ? reason : 'requested_by_customer',
  };
  if (amountCents != null && Number(amountCents) > 0) params.amount = Number(amountCents);

  let refund;
  if (payment.stripe_charge_id) {
    params.charge = payment.stripe_charge_id;
    refund = await stripe.refunds.create(params);
  } else {
    params.payment_intent = payment.stripe_payment_intent_id;
    refund = await stripe.refunds.create(params);
  }

  const charge = payment.stripe_charge_id
    ? await stripe.charges.retrieve(payment.stripe_charge_id)
    : { id: null, currency: payment.currency, customer: null, refunds: { data: [refund] } };

  await recordRefundFromCharge(
    Object.assign(charge, { id: payment.stripe_charge_id || charge.id, currency: payment.currency }),
    refund
  );
  return { refundId: refund.id, status: refund.status, amount: refund.amount };
}

async function deleteAccount(userId, { immediate = true } = {}) {
  const user = await getUserBilling(userId);
  if (!user) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  if (Number(user.is_super_admin) === 1) {
    const admins = await query('SELECT COUNT(*) AS c FROM users WHERE is_super_admin = 1 AND (status = \'active\' OR status IS NULL)');
    if (Number(admins[0].c) <= 1) {
      throw Object.assign(new Error('Cannot delete the last super admin'), { code: 'LAST_SUPER_ADMIN' });
    }
  }

  if (user.stripe_subscription_id) {
    try {
      const stripe = await getStripe();
      await stripe.subscriptions.cancel(user.stripe_subscription_id, {
        invoice_now: false,
        prorate: !!immediate,
      });
    } catch (e) {
      console.warn('[billing.deleteAccount] cancel sub:', e.message);
    }
  }

  const tombstone = `deleted+${user.id}@deleted.local`;
  await query(
    `UPDATE users SET
       status = 'disabled',
       email = :email,
       name = 'Deleted user',
       password_hash = :hash,
       deleted_at = ${driver() === 'sqlite' ? "datetime('now')" : 'CURRENT_TIMESTAMP'},
       subscription_status = 'canceled',
       billing_plan = 'free',
       stripe_subscription_id = NULL
     WHERE id = :id`,
    {
      email: tombstone,
      hash: '!', // unusable hash
      id: user.id,
    }
  );

  await query('DELETE FROM workspace_members WHERE user_id = :id', { id: user.id });
  return { deleted: true };
}

module.exports = {
  ACTIVE_STATUSES,
  HEALTHY_PAID_STATUSES,
  getUserBilling,
  isSubscribed,
  isHealthyPaid,
  assertNotPastDue,
  planOfUser,
  hasProductAccess,
  requireSubscriptionEnabled,
  workspaceHasSubscription,
  workspaceHasProductAccess,
  workspacePlan,
  effectivePlan,
  claimStripeEvent,
  ensureCustomer,
  createCheckoutSession,
  createCreditsCheckoutSession,
  createPortalSession,
  getLiveSubscription,
  scheduleCancelAtPeriodEnd,
  resumeSubscription,
  changeSubscriptionPlan,
  startOrChangePlan,
  resolveWorkspaceIdForUser,
  syncSubscription,
  handleWebhookEvent,
  billingSummary,
  catalogForApi,
  listPayments,
  listRefunds,
  adminRefundPayment,
  deleteAccount,
  recordPaymentFromInvoice,
};
