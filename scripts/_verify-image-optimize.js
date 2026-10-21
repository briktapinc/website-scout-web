'use strict';
const io = require('../src/imageOptimize');
const domain = require('../server/domain');
const cat = require('../src/mcpCatalog');

if (typeof domain.sitesOptimizeImages !== 'function') {
  console.error('sitesOptimizeImages missing');
  process.exit(2);
}
if (!cat.tools.some((t) => t.name === 'website.optimizeImages')) {
  console.error('catalog missing website.optimizeImages');
  process.exit(3);
}
console.log('verify_ok');

(async () => {
  const sharp = require('sharp');
  const big = await sharp({
    create: { width: 2000, height: 1200, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).jpeg({ quality: 90 }).toBuffer();
  const r = await io.optimizeBuffer(big, { fileName: 'hero.jpg', role: 'photo' });
  console.log('smoke', {
    before: r.bytesBefore,
    after: r.bytesAfter,
    ext: r.ext,
    reason: r.reason,
    skipped: r.skipped,
  });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
