'use strict';

/**
 * Workspace credit wallet — buy packs via Stripe Checkout (mode=payment),
 * spend on social image + content generation.
 */

const { query, withConnection, driver } = require('./db');
const platform = require('./platform');

function fail(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

async function packConfig() {
  const priceId = String(
    process.env.STRIPE_PRICE_ID_CREDITS
      || (await platform.getPlatformSetting('stripe.price_id_credits', ''))
      || ''
  ).trim();
  const packAmount = Math.max(1, Math.floor(Number(
    await platform.getPlatformSetting('credits.pack_amount', '50')
  ) || 50));
  const packLabel = String(
    await platform.getPlatformSetting('credits.pack_label', '') || ''
  ).trim() || `${packAmount} credits`;
  const perImage = Math.max(0, Math.floor(Number(
    await platform.getPlatformSetting('credits.per_social_image', '1')
  ) || 0));
  const perContent = Math.max(0, Math.floor(Number(
    await platform.getPlatformSetting('credits.per_social_content', '1')
  ) || 0));
  return {
    priceId,
    packAmount,
    packLabel,
    perImage,
    perContent,
    configured: !!priceId,
  };
}

async function getBalance(workspaceId) {
  const wid = Number(workspaceId);
  if (!Number.isFinite(wid) || wid < 1) return 0;
  const rows = await query(
    'SELECT balance FROM credit_balances WHERE workspace_id = :wid LIMIT 1',
    { wid }
  );
  return rows[0] ? Math.max(0, Number(rows[0].balance) || 0) : 0;
}

async function listLedger(workspaceId, { limit = 40 } = {}) {
  const wid = Number(workspaceId);
  const lim = Math.min(200, Math.max(1, Number(limit) || 40));
  if (!Number.isFinite(wid) || wid < 1) return [];
  return query(
    `SELECT id, workspace_id, user_id, delta, balance_after, reason, ref_type, ref_id,
            stripe_checkout_session_id, created_at
     FROM credit_ledger
     WHERE workspace_id = :wid
     ORDER BY id DESC
     LIMIT ${lim}`,
    { wid }
  );
}

function spendIdempotencyKey(reason, refType, refId) {
  if (!refType || refId == null || refId === '') return null;
  return `spend:${String(reason || '').slice(0, 40)}:${String(refType).slice(0, 40)}:${String(refId).slice(0, 60)}`;
}

/**
 * Atomically apply a credit delta. Positive = grant, negative = spend.
 * Idempotent when stripeCheckoutSessionId / idempotencyKey is set (unique in ledger).
 */
async function applyDelta(workspaceId, delta, {
  userId = null,
  reason = '',
  refType = null,
  refId = null,
  stripeCheckoutSessionId = null,
  idempotencyKey = null,
} = {}) {
  const wid = Number(workspaceId);
  const d = Math.trunc(Number(delta) || 0);
  if (!Number.isFinite(wid) || wid < 1) throw fail('INVALID_WORKSPACE', 'workspaceId is required');
  if (!d) throw fail('INVALID_DELTA', 'Credit delta must be non-zero');

  const sessionKey = stripeCheckoutSessionId
    ? String(stripeCheckoutSessionId).trim()
    : (idempotencyKey ? String(idempotencyKey).trim() : null);

  if (sessionKey) {
    const existing = await query(
      'SELECT id, balance_after FROM credit_ledger WHERE stripe_checkout_session_id = :sid LIMIT 1',
      { sid: sessionKey }
    );
    if (existing[0]) {
      return {
        balance: Number(existing[0].balance_after) || 0,
        ledgerId: existing[0].id,
        duplicate: true,
      };
    }
  }

  return withConnection(async (conn) => {
    if (driver() === 'sqlite') {
      await conn.query('BEGIN IMMEDIATE');
    } else {
      await conn.beginTransaction();
    }
    try {
      // Ensure a balance row exists so FOR UPDATE / concurrent grants cannot race on missing rows.
      if (driver() === 'sqlite') {
        await conn.execute(
          `INSERT INTO credit_balances (workspace_id, balance, updated_at)
           VALUES (?, 0, datetime('now'))
           ON CONFLICT(workspace_id) DO NOTHING`,
          [wid]
        );
      } else {
        await conn.execute(
          `INSERT IGNORE INTO credit_balances (workspace_id, balance, updated_at)
           VALUES (?, 0, CURRENT_TIMESTAMP)`,
          [wid]
        );
      }

      const lockSql = driver() === 'sqlite'
        ? 'SELECT balance FROM credit_balances WHERE workspace_id = ? LIMIT 1'
        : 'SELECT balance FROM credit_balances WHERE workspace_id = ? FOR UPDATE';
      const [balRows] = await conn.execute(lockSql, [wid]);
      let balance = balRows[0] ? Number(balRows[0].balance) || 0 : 0;

      const next = balance + d;
      if (next < 0) {
        throw fail(
          'INSUFFICIENT_CREDITS',
          `Not enough credits (need ${Math.abs(d)}, have ${balance}). Buy more credits in Billing.`,
          402
        );
      }

      if (driver() === 'sqlite') {
        await conn.execute(
          `UPDATE credit_balances SET balance = ?, updated_at = datetime('now') WHERE workspace_id = ?`,
          [next, wid]
        );
        const info = await conn.execute(
          `INSERT INTO credit_ledger
             (workspace_id, user_id, delta, balance_after, reason, ref_type, ref_id, stripe_checkout_session_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
          [
            wid,
            userId != null ? Number(userId) : null,
            d,
            next,
            String(reason || '').slice(0, 120),
            refType ? String(refType).slice(0, 60) : null,
            refId != null ? String(refId).slice(0, 80) : null,
            sessionKey,
          ]
        );
        await conn.commit();
        return {
          balance: next,
          ledgerId: info[0] && info[0].insertId,
          duplicate: false,
        };
      }

      await conn.execute(
        `UPDATE credit_balances SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ?`,
        [next, wid]
      );
      const [result] = await conn.execute(
        `INSERT INTO credit_ledger
           (workspace_id, user_id, delta, balance_after, reason, ref_type, ref_id, stripe_checkout_session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          wid,
          userId != null ? Number(userId) : null,
          d,
          next,
          String(reason || '').slice(0, 120),
          refType ? String(refType).slice(0, 60) : null,
          refId != null ? String(refId).slice(0, 80) : null,
          sessionKey,
        ]
      );
      await conn.commit();
      return {
        balance: next,
        ledgerId: result.insertId,
        duplicate: false,
      };
    } catch (e) {
      try { await conn.rollback(); } catch { /* */ }
      if (e.code === 'ER_DUP_ENTRY' || /unique|duplicate/i.test(String(e.message || ''))) {
        if (sessionKey) {
          const existing = await query(
            'SELECT id, balance_after FROM credit_ledger WHERE stripe_checkout_session_id = :sid LIMIT 1',
            { sid: sessionKey }
          );
          if (existing[0]) {
            return {
              balance: Number(existing[0].balance_after) || 0,
              ledgerId: existing[0].id,
              duplicate: true,
            };
          }
        }
      }
      throw e;
    }
  });
}

async function grant(workspaceId, amount, meta = {}) {
  const n = Math.floor(Number(amount) || 0);
  if (n < 1) throw fail('INVALID_AMOUNT', 'Grant amount must be at least 1');
  return applyDelta(workspaceId, n, meta);
}

async function spend(workspaceId, amount, meta = {}) {
  const n = Math.floor(Number(amount) || 0);
  if (n < 1) {
    return { balance: await getBalance(workspaceId), ledgerId: null, skipped: true };
  }
  // Block new credit spend when the acting user is past_due (upgrades/purchases already gated).
  if (meta.userId != null) {
    try {
      const billing = require('./billing');
      const user = await billing.getUserBilling(meta.userId);
      billing.assertNotPastDue(user);
    } catch (e) {
      if (e && e.code === 'PAST_DUE') throw e;
      // ignore lookup failures — balance check still applies
    }
  }
  const idem = meta.idempotencyKey
    || spendIdempotencyKey(meta.reason, meta.refType, meta.refId);
  return applyDelta(workspaceId, -n, { ...meta, idempotencyKey: idem });
}

function creditsFromSession(session, packAmount) {
  const meta = session.metadata || {};
  const metaCredits = Math.floor(Number(meta.credits || 0) || 0);
  let qty = Math.floor(Number(meta.quantity || 0) || 0);
  if (!qty && session.line_items && session.line_items.data && session.line_items.data[0]) {
    qty = Math.floor(Number(session.line_items.data[0].quantity) || 0);
  }
  if (qty < 1) qty = 1;
  const recomputed = Math.max(1, packAmount) * qty;
  // Prefer recomputed pack math; metadata is only a hint when quantity unknown.
  if (meta.pack_amount != null || meta.quantity != null || qty > 0) return recomputed;
  return metaCredits > 0 ? metaCredits : recomputed;
}

async function grantFromCheckoutSession(session) {
  if (!session || !session.id) return null;
  const meta = session.metadata || {};
  if (String(meta.purpose || '') !== 'credits') return null;

  const workspaceId = Number(meta.workspace_id || 0);
  const userId = Number(meta.user_id || session.client_reference_id || 0) || null;
  const cfg = await packConfig();
  const creditCount = creditsFromSession(session, cfg.packAmount);
  if (!workspaceId || creditCount < 1) {
    console.warn('[credits] checkout session missing workspace/credits', session.id, meta);
    return null;
  }

  const paymentStatus = String(session.payment_status || '');
  if (paymentStatus && paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
    return null;
  }

  const result = await grant(workspaceId, creditCount, {
    userId,
    reason: 'stripe_purchase',
    refType: 'checkout_session',
    refId: session.id,
    stripeCheckoutSessionId: session.id,
  });

  if (!result.duplicate) {
    try {
      const amountCents = Number(session.amount_total || 0) || 0;
      const currency = String(session.currency || 'usd').toLowerCase();
      const pi = typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (session.payment_intent && session.payment_intent.id) || null;
      await query(
        `INSERT INTO payments
           (user_id, stripe_invoice_id, stripe_payment_intent_id, stripe_charge_id,
            amount_cents, currency, status, description)
         VALUES
           (:userId, NULL, :pi, NULL, :amount, :currency, 'succeeded', :desc)`,
        {
          userId,
          pi,
          amount: amountCents,
          currency,
          desc: `Credits pack (+${creditCount}) for workspace #${workspaceId}`,
        }
      );
    } catch (e) {
      console.warn('[credits] payment ledger:', e.message);
    }
  }

  return result;
}

/**
 * Claw back credits granted for a checkout session (refund / dispute).
 * Idempotent via stripe_checkout_session_id = refund:{refundId}.
 */
async function clawbackFromRefund({ checkoutSessionId, refundId, paymentIntentId } = {}) {
  let grantRow = null;
  const grantKey = checkoutSessionId ? String(checkoutSessionId).trim() : null;
  if (grantKey) {
    const rows = await query(
      `SELECT * FROM credit_ledger
       WHERE stripe_checkout_session_id = :sid AND delta > 0
       LIMIT 1`,
      { sid: grantKey }
    );
    grantRow = rows[0] || null;
  }
  if (!grantRow && paymentIntentId) {
    const pays = await query(
      `SELECT description FROM payments WHERE stripe_payment_intent_id = :pi ORDER BY id DESC LIMIT 1`,
      { pi: String(paymentIntentId) }
    );
    const desc = pays[0] && pays[0].description ? String(pays[0].description) : '';
    const m = desc.match(/workspace #(\d+)/i);
    const wid = m ? Number(m[1]) : 0;
    if (wid > 0) {
      const grantRows = await query(
        `SELECT * FROM credit_ledger
         WHERE reason = 'stripe_purchase' AND delta > 0 AND workspace_id = :wid
         ORDER BY id DESC LIMIT 5`,
        { wid }
      );
      grantRow = (grantRows || []).find((r) => r.stripe_checkout_session_id) || null;
    }
  }
  if (!grantRow) return { clawed: false, reason: 'no_grant' };

  const amount = Math.floor(Number(grantRow.delta) || 0);
  if (amount < 1) return { clawed: false, reason: 'zero' };
  const rid = refundId ? String(refundId) : `clawback:${grantRow.stripe_checkout_session_id}`;
  const result = await applyDelta(grantRow.workspace_id, -amount, {
    userId: grantRow.user_id,
    reason: 'stripe_refund',
    refType: 'refund',
    refId: rid,
    stripeCheckoutSessionId: `refund:${rid}`,
  });
  return { clawed: !result.duplicate, ...result };
}

async function freezeWorkspaceCredits(workspaceId, reason = 'risk_freeze') {
  const bal = await getBalance(workspaceId);
  if (bal < 1) return { frozen: 0, balance: bal };
  return applyDelta(workspaceId, -bal, {
    reason,
    refType: 'risk',
    refId: String(Date.now()),
    idempotencyKey: `freeze:${workspaceId}:${reason}:${Math.floor(Date.now() / 60000)}`,
  });
}

async function summaryForWorkspace(workspaceId) {
  const cfg = await packConfig();
  const balance = await getBalance(workspaceId);
  const recent = await listLedger(workspaceId, { limit: 15 });
  return {
    balance,
    packAmount: cfg.packAmount,
    packLabel: cfg.packLabel,
    priceConfigured: cfg.configured,
    perSocialImage: cfg.perImage,
    perSocialContent: cfg.perContent,
    recent,
  };
}

module.exports = {
  packConfig,
  getBalance,
  listLedger,
  grant,
  spend,
  applyDelta,
  grantFromCheckoutSession,
  clawbackFromRefund,
  freezeWorkspaceCredits,
  summaryForWorkspace,
  spendIdempotencyKey,
};
