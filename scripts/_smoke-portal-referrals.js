'use strict';

/**
 * Smoke: referrals module + table + credit math + billing hook presence.
 * Run inside the app container: node /app/scripts/_smoke-portal-referrals.js
 */

async function main() {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');

  const mustExist = [
    'server/referrals.js',
    'server/billing.js',
    'server/routes/portal.js',
    'public/portal.html',
    'public/js/portal.js',
  ];
  for (const f of mustExist) {
    if (!fs.existsSync(path.join(root, f))) throw new Error(`missing ${f}`);
  }

  const billingSrc = fs.readFileSync(path.join(root, 'server/billing.js'), 'utf8');
  if (!/tryAwardForPaidUser/.test(billingSrc)) {
    throw new Error('billing.syncSubscription missing referral award hook');
  }
  const portalRoutes = fs.readFileSync(path.join(root, 'server/routes/portal.js'), 'utf8');
  if (!/\/referrals/.test(portalRoutes)) throw new Error('portal routes missing /referrals');
  const portalHtml = fs.readFileSync(path.join(root, 'public/portal.html'), 'utf8');
  if (!/nav-referrals/.test(portalHtml) || !/sec-referrals/.test(portalHtml)) {
    throw new Error('portal.html missing Referrals tab markup');
  }
  const portalJs = fs.readFileSync(path.join(root, 'public/js/portal.js'), 'utf8');
  if (!/loadReferrals/.test(portalJs)) throw new Error('portal.js missing loadReferrals');
  if (!/referrals:\s*'referrals'/.test(portalJs)) {
    throw new Error('portal.js PANEL_ALIASES missing referrals (hash would snap back to website)');
  }
  if (!/resolvePortalPanel/.test(portalJs)) {
    throw new Error('portal.js missing resolvePortalPanel');
  }

  const db = require('../server/db');
  await db.migrate();
  const rows = await db.query(
    `SELECT COUNT(*) AS c FROM portal_referrals`
  ).catch(async (e) => {
    throw new Error(`portal_referrals table missing after migrate: ${e.message}`);
  });
  console.log('portal_referrals ok, rows=', rows[0] && rows[0].c);

  const referrals = require('../server/referrals');
  const math = await referrals.creditMathSummary();
  console.log('creditMath', {
    rewardPercent: math.rewardPercent,
    usdPerCredit: math.usdPerCredit,
    standardEstimateCredits: math.standardEstimateCredits,
    premiumEstimateCredits: math.premiumEstimateCredits,
  });
  if (!(math.rewardPercent > 0) || !(math.standardEstimateCredits >= 1)) {
    throw new Error('unexpected credit math');
  }

  // Validation smoke (no DB write of self without a user).
  try {
    referrals.validateReferralInput({ businessName: 'Acme', phone: '555-0100' });
    console.log('validate ok (biz+phone)');
  } catch (e) {
    throw e;
  }
  try {
    referrals.validateReferralInput({ name: 'Only name' });
    throw new Error('expected validation failure');
  } catch (e) {
    if (e.code !== 'INVALID') throw e;
    console.log('validate rejects incomplete');
  }

  console.log('SMOKE_OK referrals');
}

main().catch((e) => {
  console.error('SMOKE_FAIL', e.message || e);
  process.exit(1);
});
