'use strict';
const f = require('../server/contactForms');
const Database = require('better-sqlite3');
const db = new Database(':memory:');
f.ensureTables(db);
db.exec('CREATE TABLE leads (id INTEGER PRIMARY KEY, email TEXT, business_name TEXT)');
db.exec(`CREATE TABLE websites (
  id INTEGER PRIMARY KEY, lead_id INTEGER, pages TEXT, theme TEXT, updated_at TEXT
)`);
db.prepare('INSERT INTO leads VALUES (1, ?, ?)').run('a@b.com', 'Test Co');
db.prepare(
  "INSERT INTO websites (id, lead_id, pages, theme, updated_at) VALUES (1, 1, ?, '{}', datetime('now'))"
).run(JSON.stringify([
  { slug: 'home', title: 'Home', html: '<main><h1>Home</h1></main>' },
  { slug: 'contact', title: 'Contact', html: '<main><section id="contact"><h1>Contact</h1></section></main>' },
]));

const a = f.createForm(db, 1, { name: 'Form A' });
const b = f.createForm(db, 1, { name: 'Form B', embed_enabled: false, target_page_slug: 'about' });
console.log('forms', f.listFormsForLead(db, 1).map((x) => `${x.name}:${x.embed_on_page}:${x.target_page_slug}`));

const pub = f.publishForm(db, 1, a.id, { workspaceId: 9, embed_on_page: true, target_page_slug: 'contact' });
console.log('pub', pub.published, String(pub.public_token || '').startsWith('9_'));

const sync = f.syncSiteFormEmbeds(db, 1, { appUrl: 'https://bitpype.com' });
console.log('sync', sync);
const site = db.prepare('SELECT pages FROM websites WHERE id = 1').get();
const pages = JSON.parse(site.pages);
const contactHtml = pages.find((p) => p.slug === 'contact').html;
console.log('hasEmbed', /data-bitpype-managed/.test(contactHtml), /embed\/form\.html/.test(contactHtml));
console.log('homeClean', !/data-bitpype-managed/.test(pages.find((p) => p.slug === 'home').html));

const engine = require('../src/websiteEngine');
const sanitized = engine.sanitizeHtml(contactHtml);
console.log('sanitizeKeepsIframe', /iframe/i.test(sanitized) && /embed\/form\.html/.test(sanitized));

f.deleteForm(db, 1, b.id);
console.log('afterDelete', f.listFormsForLead(db, 1).length);
console.log('OK');
