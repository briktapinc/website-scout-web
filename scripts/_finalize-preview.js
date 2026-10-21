'use strict';

async function main() {
  process.env.APP_URL = process.env.APP_URL || 'https://bitpype.com';
  const domain = require('../server/domain');
  const result = await domain.sitesPreview(1, 1, { force: true });
  console.log(JSON.stringify(result, null, 2));

  const url = result.url;
  if (!url || /127\.0\.0\.1|localhost|:8755/i.test(url)) {
    console.error('FAIL bad url');
    process.exit(1);
  }

  // Verify from this process (APP_URL should work inside container via public host)
  const res = await fetch(url, { redirect: 'follow' });
  const html = await res.text();
  console.log('GET', url, 'status=', res.status, 'len=', html.length);
  const styleChars = [...html.matchAll(/<style[\s\S]*?<\/style>/gi)].reduce((n, m) => n + m[0].length, 0);
  console.log('style_chars=', styleChars, 'has_ws_theme=', /data-ws-theme/.test(html));
  if (!res.ok || styleChars < 100) {
    console.error('FAIL css missing or bad status');
    process.exit(1);
  }
  console.log('OK styled preview=', url);
  process.exit(0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
