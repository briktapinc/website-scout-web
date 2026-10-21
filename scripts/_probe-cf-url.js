'use strict';

/** Probe a Cloudflare Pages URL and print status + body start. */
const url = process.argv[2] || 'https://bd479c7a.bp-preview-s1.pages.dev/';

async function probe(u) {
  try {
    const res = await fetch(u, { redirect: 'follow', headers: { Accept: 'text/html,*/*' } });
    const text = await res.text();
    console.log(JSON.stringify({
      url: u,
      status: res.status,
      contentType: res.headers.get('content-type'),
      len: text.length,
      start: text.slice(0, 300),
    }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ url: u, error: e.message }, null, 2));
  }
}

(async () => {
  await probe(url);
  await probe(url.replace(/\/?$/, '/index.html'));
  // production alias
  try {
    const u = new URL(url);
    const parts = u.hostname.split('.');
    if (parts.length >= 3) {
      await probe(`https://${parts.slice(1).join('.')}/`);
    }
  } catch { /* ignore */ }
})();
