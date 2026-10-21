'use strict';
const domain = require('../server/domain');

async function main() {
  const r = domain.designRenderHtml(1, { id: 11, editable: true });
  const h = r.html || '';
  console.log('html len', h.length);
  console.log('data-ws-theme', /data-ws-theme/.test(h));
  console.log('ht-stage css', /\.ht-stage/.test(h));
  console.log('Fraunces', /Fraunces/.test(h));
  console.log('Hold the chair', /Hold the chair/.test(h));
  const m = h.match(/<style[^>]*data-ws-theme[^>]*>([\s\S]*?)<\/style>/i);
  console.log('theme style len', m ? m[1].length : 0);
  const bySlug = domain.designRenderHtml(1, { id: 11, editable: true, pageSlug: 'home' });
  const hs = bySlug.html || '';
  console.log('home page theme style', /data-ws-theme/.test(hs) && /\.ht-stage/.test(hs));

  // Confirm getJob deliverable now exposes customCss
  const job = domain.designGet(1, 11);
  const cssLen = (((job && job.job && job.job.deliverable) || job.deliverable || {}).theme || {}).customCss;
  const len = typeof cssLen === 'string' ? cssLen.length : 0;
  console.log('getJob customCss len', len);
  if (!/\.ht-stage/.test(h) || len < 1000) {
    console.error('VERIFY FAILED');
    process.exit(1);
  }
  console.log('VERIFY OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
