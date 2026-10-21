'use strict';

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node _fetch-preview.js <url>');
    process.exit(1);
  }
  const res = await fetch(url, { redirect: 'follow' });
  console.log('status=', res.status, 'final=', res.url);
  const html = await res.text();
  console.log('html_len=', html.length);
  const head = (html.match(/<head[\s\S]*?<\/head>/i) || [html.slice(0, 2500)])[0];
  console.log('--- head ---');
  console.log(head.slice(0, 2000));
  const styleChars = [...html.matchAll(/<style[\s\S]*?<\/style>/gi)].reduce((n, m) => n + m[0].length, 0);
  console.log('inline_style_chars=', styleChars);
  const hasTheme = /data-ws-theme\s*=\s*["']1["']/.test(html);
  console.log('has_ws_theme=', hasTheme);
  if (styleChars < 100) {
    console.error('FAIL: little/no CSS in HTML');
    process.exit(1);
  }
  console.log('OK: CSS present');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
