'use strict';
const url = process.argv[2] || 'https://bd479c7a.bp-preview-s1.pages.dev/';
fetch(url, { redirect: 'follow', headers: { Accept: 'text/html' } })
  .then(async (r) => {
    const t = await r.text();
    console.log(JSON.stringify({
      status: r.status,
      ok: r.ok,
      len: t.length,
      hasHtml: /<html[\s>]|<!doctype\s+html/i.test(t),
      start: t.slice(0, 120),
    }));
  })
  .catch((e) => {
    console.log(JSON.stringify({ error: e.message }));
    process.exit(1);
  });
