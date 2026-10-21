'use strict';

const billing = require('../server/billing');
const { query } = require('../server/db');

(async () => {
  const free = await query(
    `SELECT id, email, stripe_subscription_id, subscription_status, billing_plan
     FROM users
     WHERE (deleted_at IS NULL)
       AND (status IS NULL OR status = 'active')
       AND (
         subscription_status IS NULL OR subscription_status = ''
         OR subscription_status IN ('canceled', 'none', 'incomplete_expired')
       )
     ORDER BY id ASC
     LIMIT 5`
  );
  console.log(
    'free_candidates',
    JSON.stringify((free || []).map((u) => ({
      id: u.id,
      email: u.email,
      status: u.subscription_status,
      plan: u.billing_plan,
    })))
  );

  const paid = await query(
    `SELECT id, email, stripe_subscription_id, subscription_status, billing_plan, subscription_price_id
     FROM users
     WHERE subscription_status IN ('active', 'trialing', 'past_due')
       AND stripe_subscription_id IS NOT NULL AND stripe_subscription_id != ''
       AND (deleted_at IS NULL)
     ORDER BY id ASC
     LIMIT 5`
  );
  console.log(
    'paid_candidates',
    JSON.stringify((paid || []).map((u) => ({
      id: u.id,
      email: u.email,
      status: u.subscription_status,
      plan: u.billing_plan,
      price: u.subscription_price_id,
      sub: u.stripe_subscription_id,
    })))
  );

  const u = (free || [])[0];
  if (u) {
    try {
      const r = await billing.startOrChangePlan(u.id, 'standard');
      console.log(
        'checkout_fallback',
        JSON.stringify({
          action: r.action,
          plan: r.plan,
          hasUrl: !!r.url,
          urlPrefix: r.url ? String(r.url).slice(0, 56) : null,
          sessionId: r.sessionId || null,
        })
      );
    } catch (e) {
      console.log('checkout_fallback_error', e.code || '', e.message);
    }
  } else {
    console.log('checkout_fallback_skipped');
  }

  try {
    await billing.startOrChangePlan((u && u.id) || 1, 'gold');
    console.log('invalid_unexpected_ok');
  } catch (e) {
    console.log('invalid_plan', e.code, e.message);
  }

  if (u) {
    try {
      await billing.scheduleCancelAtPeriodEnd(u.id);
      console.log('cancel_unexpected_ok');
    } catch (e) {
      console.log('cancel_no_sub', e.code, e.message);
    }
  }

  // Dry-run paid switch path: retrieve live sub + resolve target price, do NOT update.
  const p = (paid || [])[0];
  if (p) {
    const live = await billing.getLiveSubscription(p);
    const prices = await require('../server/stripeClient').getConfiguredPriceIds();
    const currentPrice = live && live.items && live.items.data && live.items.data[0]
      ? live.items.data[0].price.id
      : null;
    const target = currentPrice === prices.premium ? 'standard' : 'premium';
    const targetPrice = target === 'premium' ? prices.premium : prices.standard;
    console.log(
      'paid_switch_dry_run',
      JSON.stringify({
        userId: p.id,
        currentPlan: p.billing_plan,
        currentPrice,
        target,
        targetPrice,
        cancelAtPeriodEnd: !!(live && live.cancel_at_period_end),
        wouldCall: 'subscriptions.update with proration_behavior=create_prorations',
        skippedLiveUpdate: true,
      })
    );
  } else {
    console.log('paid_switch_dry_run_skipped');
  }

  console.log('smoke-plan-switch-ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
