'use strict';
const p = require('../server/clientPortal');
const b = require('../server/billing');
if (typeof p.ensureBillingUserForPortalClient !== 'function') process.exit(2);
if (typeof p.openCheckout !== 'function') process.exit(3);
if (typeof b.createCheckoutSession !== 'function') process.exit(4);
console.log('portal-billing-ok');
