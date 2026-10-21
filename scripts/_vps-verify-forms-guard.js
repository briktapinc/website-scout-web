'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const eng = require('../src/websiteEngine');
const forms = require('../server/contactForms');

const candidates = [
  process.env.DB_PATH,
  '/data/website-scout-web.sqlite',
  '/data/workspaces/1/websitescout.db',
  '/app/data/website-scout-web.sqlite',
  '/app/data/workspaces/1/websitescout.db',
].filter(Boolean);

let db = null;
let dbPath = null;
for (const p of candidates) {
  try {
    if (fs.existsSync(p)) {
      db = new Database(p, { readonly: true });
      dbPath = p;
      break;
    }
  } catch { /* try next */ }
}
if (!db) {
  console.log('no_db');
  process.exit(0);
}
console.log('db', dbPath);

const row = db.prepare('SELECT id, name, lead_id, pages FROM websites WHERE id = 5').get();
if (!row) {
  console.log('site5_missing');
  process.exit(0);
}
const pages = JSON.parse(row.pages || '[]');
let contact = null;
for (const p of pages) {
  for (const s of (p.sections || [])) {
    if (s && s.type === 'contact_form') {
      contact = { slug: p.slug, page: p, sec: s };
      break;
    }
  }
  if (contact) break;
}
console.log('site', row.id, row.name, 'lead', row.lead_id);
console.log('contact_form_page', contact && contact.slug);
const c = (contact && contact.sec && contact.sec.content) || {};
console.log('has_embed', !!(c.bitpype_embed_html || c.form_token));
console.log('suppress_fields', !!c.suppress_fields);

const page = (contact && contact.page) || pages[0];
const html = eng.renderPage(page, pages, {});
const formTags = (html.match(/<form\b[^>]*>/gi) || []).length;
const embeds = (html.match(/\bdata-bitpype-form-embed\s*=/gi) || []).length;
console.log('render_forms', formTags, 'render_embeds', embeds, 'functional', formTags + embeds);

const dirty = forms.stripHandRolledFormsFromPages([{
  slug: '/x',
  title: 'X',
  sections: [{ type: 'html', content: { html: '<form action="#"><input></form>' } }],
}]);
console.log('strip_ok', dirty.stripped >= 1);

const tools = require('../src/mcpCatalog').tools || [];
const formTools = tools.filter((t) => String(t.name || '').startsWith('forms.')).map((t) => t.name).sort();
console.log('mcp_form_tools', formTools.join(','));

if ((formTags + embeds) !== 1) {
  console.error('expected exactly 1 functional form/embed on North Harbor contact');
  process.exit(2);
}
if (!formTools.includes('forms.create')) {
  console.error('forms.create missing from mcp catalog');
  process.exit(3);
}
console.log('north_harbor_ok');
