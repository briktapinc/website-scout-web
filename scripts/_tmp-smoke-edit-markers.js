'use strict';
/**
 * Smoke: modular freestyle pages get data-edit markers when editable=true.
 */
const Database = require('better-sqlite3');
const engine = require('../src/websiteEngine');

const DB = process.env.WS_DB || '/app/data/workspaces/1/websitescout.db';
const db = new Database(DB, { readonly: true });

for (const id of [1, 2, 3]) {
  const row = db.prepare('SELECT id, name, pages, theme FROM websites WHERE id=?').get(id);
  if (!row) { console.log('missing', id); continue; }
  const pages = JSON.parse(row.pages || '[]');
  const theme = JSON.parse(row.theme || '{}');
  const home = pages.find((p) => ['/', 'home', 'index'].includes(String(p.slug))) || pages[0];
  const html = engine.renderPage(home, pages, theme, { editable: true, preview: true });
  const edits = (html.match(/data-edit="/g) || []).length;
  const shtml = (html.match(/data-edit="html:\d+:\d+:\d+"/g) || []).length;
  const legacy = (html.match(/data-edit="html:\d+:\d+"/g) || []).length;
  const structured = edits - shtml - legacy;
  const chromeOk = /ws-nav-chrome/.test(html) && /<\/header>/i.test(html);
  const orphan = /callbtn[\s\S]{0,40}<\/header>/i.test(html.split('ws-html-block')[1] || '');
  console.log(JSON.stringify({
    id,
    name: row.name,
    edits,
    shtml,
    legacy,
    structured,
    chromeOk,
    bodyOrphanHeader: orphan,
    cssLen: String(theme.customCss || '').length,
  }));
}
db.close();
