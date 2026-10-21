'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const CF_INDEX_HASH = '2af9084b9af6e685d178b33f48b58db77649eebfd58305fb1f2631fad6e1a00f';
const candidates = [
  '/root/website-scout-exports/ws-1/delle-donne-electric-llc-website-1/index.html',
  '/root/website-scout-exports/ws-1-site-1/index.html',
  '/root/website-scout-exports/ws-1-site-1-csscheck/index.html',
  path.join(os.homedir(), 'website-scout-exports/ws-1/delle-donne-electric-llc-website-1/index.html'),
  path.join(os.homedir(), 'website-scout-exports/ws-1-site-1/index.html'),
];

for (const f of candidates) {
  if (!fs.existsSync(f)) {
    console.log('MISSING', f);
    continue;
  }
  const buf = fs.readFileSync(f);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const html = buf.toString('utf8');
  const styleChars = [...html.matchAll(/<style[\s\S]*?<\/style>/gi)].reduce((n, m) => n + m[0].length, 0);
  console.log(JSON.stringify({
    file: f,
    size: buf.length,
    hash,
    matchesCf: hash === CF_INDEX_HASH,
    styleChars,
    hasTheme: /data-ws-theme/.test(html),
    head: (html.match(/<head[\s\S]*?<\/head>/i) || [''])[0].slice(0, 300),
  }));
}
