'use strict';

(async () => {
  const platform = require('../server/platform');
  const p = await platform.savePlatformDefaultsSnapshot();
  console.log('snapshot', p);
  const s = await platform.getPlatformSetting('smtp.from_email', '');
  const n = await platform.getPlatformSetting('smtp.from_name', '');
  console.log('from', s, n);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
