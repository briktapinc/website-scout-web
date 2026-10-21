'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const roots = ['/app/data/workspaces', '/data/workspaces', '/app/data'];
for (const r of roots) {
  let dirs = [];
  try { dirs = fs.readdirSync(r); } catch { continue; }
  for (const d of dirs) {
    const p = path.join(r, d, 'websitescout.db');
    if (!fs.existsSync(p)) continue;
    const db = new Database(p, { readonly: true });
    try {
      const row = db.prepare("SELECT id,name,pages,theme FROM websites WHERE name LIKE '%Delle%' LIMIT 1").get();
      if (!row) continue;
      const pages = JSON.parse(row.pages);
      const test = pages.find((x) => /test/i.test(x.slug || '') || /test/i.test(x.title || ''));
      console.log('db', p, 'site', row.id, row.name, 'pages', pages.length);
      if (!test) {
        console.log('no test page', pages.map((x) => x.slug));
        process.exit(0);
      }
      const h = test.html || '';
      const main = (h.match(/<main[\s\S]*?<\/main>/i) || [''])[0];
      console.log('MAIN:\n', main.slice(0, 4000));
      console.log('module-embed in main', /bitpype-module-embed/i.test(main));
      console.log('module-embed in html', /bitpype-module-embed/i.test(h));
      console.log('booking in html', /booking|Service|Haircut/i.test(h));

      let engine;
      try { engine = require('/app/src/websiteEngine'); }
      catch { engine = require('./src/websiteEngine'); }
      const theme = typeof row.theme === 'string' ? JSON.parse(row.theme) : (row.theme || {});
      const rendered = engine.renderPage(test, pages, theme, { editable: true, preview: true });
      const mainMarked = (rendered.match(/<main[\s\S]*?<\/main>/i) || [''])[0];
      console.log('MARKED MAIN:\n', mainMarked.slice(0, 1800));
      console.log('data-edit count', (rendered.match(/data-edit=/g) || []).length);
      console.log('data-ws-page', /data-ws-page=/.test(rendered));
      console.log('page-section control', /page-section/.test(rendered));
      console.log('caret guard', /contenteditable'\) === 'true'/.test(rendered));
      const testIdx = pages.indexOf(test);
      console.log('test page index', testIdx, 'edit ids for page', (rendered.match(new RegExp('data-edit="html:' + testIdx + ':', 'g')) || []).length);
      process.exit(0);
    } finally {
      db.close();
    }
  }
}
console.log('not found');
process.exit(1);
