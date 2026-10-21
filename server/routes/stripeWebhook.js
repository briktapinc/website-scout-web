'use strict';

const express = require('express');
const { getStripe, getWebhookSecret } = require('../stripeClient');
const billing = require('../billing');

const router = express.Router();

// Mounted with express.raw({ type: 'application/json' }) in server.js
router.post('/', async (req, res) => {
  const secret = String(await getWebhookSecret() || '').trim();
  if (!secret) {
    console.error('[stripe.webhook] missing webhook secret');
    return res.status(503).send('Webhook secret not configured');
  }
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const stripe = await getStripe();
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[stripe.webhook] signature:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    await billing.handleWebhookEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe.webhook] handler:', event.type, err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
