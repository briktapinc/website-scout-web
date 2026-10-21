'use strict';
const Database = require('better-sqlite3');
const db = new Database('/app/data/workspaces/1/websitescout.db', { readonly: true });

function brief(html, n = 220) {
  return String(html || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

const row = db.prepare('SELECT pages FROM websites WHERE id=1').get();
const pages = JSON.parse(row.pages || '[]');
for (const slug of ['shop', '/test', 'test', 'blog', 'index', 'contact']) {
  const p = pages.find((x) => String(x.slug) === slug || String(x.slug).replace(/^\//, '') === slug.replace(/^\//, ''));
  if (!p) { console.log('missing', slug); continue; }
  console.log('\n====', p.slug, '====');
  (p.sections || []).forEach((s, i) => {
    const c = s.content || {};
    const html = String(c.html || '');
    console.log(
      i, s.type,
      'managed', !!c.bitpype_module_managed,
      'siteMod', s.type === 'site_module',
      'modType', c.module_type || '',
      'token', (c.public_token || '').slice(0, 16),
      'htmlLen', html.length,
      'emb', (html.match(/bitpype-module-embed/g) || []).length,
      'js', (html.match(/module-embed\.js/g) || []).length,
      'form', (html.match(/bitpype-form-embed/g) || []).length,
      'snip', brief(html || JSON.stringify(c).slice(0, 180))
    );
  });
}
db.close();
