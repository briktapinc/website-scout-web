'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

async function main() {
  const db = new Database('/app/data/workspaces/1/websitescout.db', { readonly: true });
  const site = db.prepare('SELECT id, name, preview_url, preview_path FROM websites WHERE id = 1').get();
  console.log('site=', JSON.stringify(site));
  db.close();

  const url = site && site.preview_url;
  if (!url) {
    console.log('NO_PREVIEW_URL — will try publish via domain');
    process.env.APP_URL = process.env.APP_URL || 'https://bitpype.com';
    const domain = require('../server/domain');
    const result = await domain.sitesPreview(1, 1, { force: true });
    console.log('published=', JSON.stringify(result, null, 2));
    await inspectUrl(result.url);
    return;
  }
  await inspectUrl(url);
}

async function inspectUrl(url) {
  console.log('FETCH', url);
  const res = await fetch(url, { redirect: 'follow' });
  console.log('status=', res.status, 'final=', res.url);
  const html = await res.text();
  console.log('html_len=', html.length);
  console.log('--- head snippet ---');
  const head = (html.match(/<head[\s\S]*?<\/head>/i) || [html.slice(0, 2500)])[0];
  console.log(head.slice(0, 3000));

  const links = [...html.matchAll(/<link[^>]+>/gi)].map((m) => m[0]);
  console.log('link_tags=', links.length);
  for (const l of links) console.log(' ', l);

  const styles = [...html.matchAll(/<style[\s\S]*?<\/style>/gi)];
  console.log('inline_style_blocks=', styles.length, 'total_css_chars=', styles.reduce((n, m) => n + m[0].length, 0));

  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
  const cssHrefs = hrefs.filter((h) => /\.css(\?|$)/i.test(h) || /stylesheet/i.test(h));
  console.log('css_hrefs=', cssHrefs);

  for (const href of cssHrefs) {
    const abs = new URL(href, res.url).toString();
    try {
      const r = await fetch(abs, { redirect: 'follow' });
      const ct = r.headers.get('content-type') || '';
      const body = await r.text();
      console.log('CSS', abs, 'status=', r.status, 'ct=', ct, 'len=', body.length, 'start=', body.slice(0, 80).replace(/\s+/g, ' '));
    } catch (e) {
      console.log('CSS FAIL', abs, e.message);
    }
  }

  // Also check local export if present
  const exportRoot = path.join(require('os').homedir(), 'website-scout-exports');
  if (fs.existsSync(exportRoot)) {
    console.log('exportRoot=', exportRoot);
    const dirs = fs.readdirSync(exportRoot).slice(0, 20);
    console.log('export dirs=', dirs);
    for (const d of dirs) {
      const dir = path.join(exportRoot, d);
      if (!fs.statSync(dir).isDirectory()) continue;
      const files = walk(dir).slice(0, 40);
      console.log(' ', d, 'files=', files);
    }
  }
}

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs).replace(/\\/g, '/'));
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
