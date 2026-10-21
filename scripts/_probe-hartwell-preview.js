/* Probe Hartwell design job + render CSS presence on VPS/local */
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.argv[2] || path.join(__dirname, '..', 'data', 'workspaces', '1', 'websitescout.db');
const engine = require('../src/websiteEngine');

const db = new Database(dbPath, { readonly: true });
const jobs = db.prepare(
  `SELECT id, lead_id, title, type, status, website_id, updated_at
   FROM design_jobs
   WHERE lead_id = 195 OR title LIKE '%Hartwell%'
   ORDER BY id DESC LIMIT 5`
).all();
console.log('JOBS', JSON.stringify(jobs, null, 2));
if (!jobs[0]) process.exit(0);

const row = db.prepare('SELECT deliverable_json, website_id FROM design_jobs WHERE id = ?').get(jobs[0].id);
let d = null;
try { d = JSON.parse(row.deliverable_json || 'null'); } catch (e) { console.log('parse err', e.message); }
if (!d) { console.log('no deliverable'); process.exit(0); }

const pages = (d.pages || []).map((p) => ({
  slug: p.slug,
  title: p.title,
  htmlLen: (p.html || '').length,
  sections: (p.sections || []).length,
  hasDoctype: /^\s*(<!doctype\s+html|<html[\s>])/i.test(p.html || ''),
  styleTags: ((p.html || '').match(/<style/gi) || []).length,
  linkStyles: ((p.html || '').match(/<link[^>]+stylesheet/gi) || []).length,
}));
const t = d.theme || {};
console.log('THEME keys', Object.keys(t));
console.log('THEME fonts', t.font, t.headingFont);
console.log('baseCss', t.baseCss, typeof t.baseCss);
console.log('customCss len', (t.customCss || '').length);
console.log('customCss head', String(t.customCss || '').slice(0, 300));
console.log('PAGES', JSON.stringify(pages, null, 2));
console.log('website_id', row.website_id);

function summarizeHtml(label, html) {
  const h = String(html || '');
  console.log('\n==', label, '==');
  console.log('html len', h.length);
  console.log('has data-ws-theme', /data-ws-theme\s*=\s*["']1["']/.test(h));
  console.log('style tag count', (h.match(/<style/gi) || []).length);
  console.log('link stylesheet count', (h.match(/<link[^>]+stylesheet/gi) || []).length);
  console.log('google fonts', /fonts\.googleapis\.com/i.test(h));
  console.log('Hold the chair', /Hold the chair/i.test(h));
  const styleM = h.match(/<style[^>]*data-ws-theme[^>]*>([\s\S]*?)<\/style>/i);
  console.log('theme style len', styleM ? styleM[1].length : 0);
  console.log('theme style head', styleM ? styleM[1].slice(0, 200).replace(/\s+/g, ' ') : '');
  // Check if body looks unstyled (no class attrs on first chunks)
  const body = (h.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [])[1] || '';
  console.log('body class count', (body.match(/\bclass=/gi) || []).length);
  console.log('body style attr count', (body.match(/\bstyle=/gi) || []).length);
}

try {
  summarizeHtml('renderSite all', engine.renderSite(d.pages, d.theme || {}, { editable: true, preview: true }));
} catch (e) {
  console.log('renderSite err', e.message);
}
try {
  summarizeHtml('renderPageAt 0', engine.renderPageAt(d.pages, d.theme || {}, { editable: true, preview: true, pageIndex: 0 }));
} catch (e) {
  console.log('renderPageAt err', e.message);
}

if (row.website_id) {
  try {
    const site = engine.getWebsite(db, row.website_id);
    console.log('\nSITE id', site && site.id, 'pages', (site && site.pages || []).length);
    const st = (site && site.theme) || {};
    console.log('site theme customCss len', (st.customCss || '').length, 'baseCss', st.baseCss);
  } catch (e) {
    console.log('site err', e.message);
  }
}
