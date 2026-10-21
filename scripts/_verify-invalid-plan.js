'use strict';
const billing = require('../server/billing');
billing.startOrChangePlan(1, 'gold')
  .then((r) => {
    console.error('unexpected ok', r);
    process.exit(2);
  })
  .catch((e) => {
    console.log('invalid_plan', e.code, e.message);
    if (e.code !== 'INVALID_PLAN') process.exit(3);
  });
