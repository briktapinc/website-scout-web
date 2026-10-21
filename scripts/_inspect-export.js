'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, base, out);
    else out.push({ rel: path.relative(base, abs).replace(/\\/g, '/'), size: st.size });
  }
  return out;
}

const db = new Database('/app/data/workspaces/1/websitescout.db', { readonly: true });
const site = db.prepare('SELECT id, name, preview_url, preview_path, theme, pages FROM websites WHERE id = 1').get();
console.log('preview_url=', site.preview_url);
console.log('preview_path=', site.preview_path);

let theme = {};
let pages = [];
try { theme = JSON.parse(site.theme || '{}'); } catch {}
try { pages = JSON.parse(site.pages || '[]'); } catch {}
console.log('theme.keys=', Object.keys(theme));
console.log('theme.baseCss=', theme.baseCss, 'customCss_len=', (theme.customCss || '').length);
console.log('pages=', pages.map((p) => ({
  slug: p.slug,
  title: p.title,
  hasHtml: !!(p.html && String(p.html).trim()),
  htmlLen: p.html ? String(p.html).length : 0,
  fullDoc: p.html ? /^\s*(<!doctype|<html)/i.test(p.html) : false,
  sections: (p.sections || []).length,
})));

for (const p of pages) {
  if (!p.html) continue;
  const html = String(p.html);
  const links = [...html.matchAll(/<link[^>]+>/gi)].map((m) => m[0]);
  const styles = [...html.matchAll(/<style/gi)].length;
  const cssRefs = [...html.matchAll(/(?:href|src)=["']([^"']+\.css[^"']*)["']/gi)].map((m) => m[1]);
  console.log('page', p.slug, 'link_tags=', links.length, 'style_tags=', styles, 'cssRefs=', cssRefs);
  for (const l of links.slice(0, 10)) console.log('  LINK', l);
  // Show whether relative links exist
  const relLinks = [...html.matchAll(/<link[^>]+href=["'](?!https?:)([^"']+)["'][^>]*>/gi)].map((m) => m[0]);
  console.log('  relative_link_tags=', relLinks.length);
  for (const l of relLinks.slice(0, 10)) console.log('  REL', l);
}

const exportDirs = [
  site.preview_path,
  path.join(require('os').homedir(), 'website-scout-exports'),
  '/root/website-scout-exports',
].filter(Boolean);

for (const root of exportDirs) {
  console.log('--- walk', root, 'exists=', fs.existsSync(root));
  if (!fs.existsSync(root)) continue;
  const st = fs.statSync(root);
  if (st.isFile()) {
    console.log(' is file size', st.size);
    continue;
  }
  // If this is the site folder itself
  const files = walk(root).slice(0, 80);
  console.log(' files=', files);
  const index = files.find((f) => f.rel.endsWith('index.html') || f.rel === 'index.html');
  if (index) {
    const abs = path.join(root, index.rel);
    const html = fs.readFileSync(abs, 'utf8');
    console.log('INDEX', abs, 'len=', html.length);
    const head = (html.match(/<head[\s\S]*?<\/head>/i) || [html.slice(0, 2000)])[0];
    console.log(head.slice(0, 2500));
    const cssRefs = [...html.matchAll(/(?:href|src)=["']([^"']+\.css[^"']*)["']/gi)].map((m) => m[1]);
    console.log('exported cssRefs=', cssRefs);
    const styleLen = [...html.matchAll(/<style[\s\S]*?<\/style>/gi)].reduce((n, m) => n + m[0].length, 0);
    console.log('exported inline style chars=', styleLen);
  }
}

// Also list children of exports root
const er = path.join(require('os').homedir(), 'website-scout-exports');
if (fs.existsSync(er)) {
  for (const name of fs.readdirSync(er).slice(0, 30)) {
    const abs = path.join(er, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      console.log('dir', name, walk(abs).map((f) => f.rel).join(', '));
    }
  }
}
db.close();
