'use strict';

process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = require('path').join(require('os').tmpdir(), `ws-upsell-${Date.now()}.sqlite`);

const assert = require('assert');
const { migrate } = require('../server/db');
const tips = require('../server/upsellTips');

(async () => {
  await migrate();
  await tips.ensureTables();

  const list = await tips.listTips({ includeStats: true });
  assert.ok(list.length >= 4, 'default tips seeded');
  assert.ok(list.every((t) => t.enabled), 'defaults enabled');

  const created = await tips.createTip({
    title: 'Did you know?',
    body: 'Test tip about chatbot',
    feature_key: 'chatbot',
    frequency_hours: 1,
    weight: 5,
    target_plans: 'free',
  });
  assert.ok(created && created.id);

  const next = await tips.nextTipForClient({ portalUserId: 99, planId: 'free' });
  assert.ok(next.tip, 'free user gets a tip');
  assert.ok(next.tip.cta_label, 'cta present');

  const cooled = await tips.nextTipForClient({ portalUserId: 99, planId: 'free' });
  assert.strictEqual(cooled.tip, null, 'global cooldown blocks immediate second tip');
  assert.ok(cooled.reason === 'global_cooldown' || cooled.reason === 'none_eligible');

  const paid = await tips.nextTipForClient({ portalUserId: 100, planId: 'premium' });
  assert.strictEqual(paid.tip, null, 'premium gets no free-targeted tip');

  await tips.updateTip(created.id, { enabled: false });
  const off = await tips.getTip(created.id);
  assert.strictEqual(off.enabled, false);

  await tips.deleteTip(created.id);
  assert.strictEqual(await tips.getTip(created.id), null);

  console.log('upsell tips smoke OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
