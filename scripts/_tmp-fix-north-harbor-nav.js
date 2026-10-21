'use strict';

const Database = require('better-sqlite3');
const eng = require('../src/websiteEngine');
const structure = require('../src/siteStructure');

const db = new Database('/app/data/workspaces/1/websitescout.db');
const row = db.prepare(
  "SELECT id, name, pages FROM websites WHERE name LIKE '%North Harbor%' ORDER BY id DESC LIMIT 1"
).get();
if (!row) {
  console.log('no_north_harbor');
  process.exit(0);
}

function countBook(html) {
  const navs = String(html || '').match(/<nav\b[\s\S]*?<\/nav>/gi) || [];
  let n = 0;
  for (const nav of navs) {
    n += [...nav.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].filter((m) =>
      /\bbook now\b/i.test(m[0].replace(/<[^>]+>/g, ''))
    ).length;
  }
  return n;
}

function navSrc(p) {
  const sec = (p.sections || []).find((s) => s && s.type === 'nav');
  return (sec && sec.content && sec.content.html) || p.html || '';
}

let pages = JSON.parse(row.pages || '[]');
console.log('site', row.id, row.name);
console.log('stored_before', pages.map((p) => ({ slug: p.slug, book: countBook(navSrc(p)) })));
const synced = structure.syncFreeformNavOrder(JSON.parse(JSON.stringify(pages)));
console.log('synced', synced.map((p) => ({ slug: p.slug, book: countBook(navSrc(p)) })));
const changed = JSON.stringify(pages) !== JSON.stringify(synced);
console.log('pages_changed', changed);
if (changed) {
  db.prepare("UPDATE websites SET pages = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(synced), row.id);
  console.log('persisted site', row.id);
}
const rendered = eng.renderPage(synced[0], synced, { name: row.name }, { preview: false });
console.log('render_book', countBook(rendered), 'dupIssues', eng.findNavDuplicateIssues(rendered).length);
