'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const forms = require('../server/contactForms');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE leads (id INTEGER PRIMARY KEY, email TEXT, business_name TEXT);
  INSERT INTO leads VALUES (1,'a@b.com','Acme');
  CREATE TABLE websites (id INTEGER PRIMARY KEY, lead_id INTEGER, pages TEXT, theme TEXT, updated_at TEXT);
  INSERT INTO websites VALUES (
    1, 1,
    '[{"slug":"/","title":"Home","sections":[]},{"slug":"/contact","title":"Contact","sections":[{"type":"contact_form","content":{"email":"a@b.com"}},{"type":"footer","content":{}}]}]',
    '{}',
    datetime('now')
  );
`);

forms.ensureTables(db);
const a = forms.createForm(db, 1, { name: 'A', embed_enabled: true, target_page_slug: 'contact' });
const b = forms.createForm(db, 1, { name: 'B', embed_enabled: false, target_page_slug: 'home' });
assert.notEqual(a.id, b.id);
assert.equal(forms.listFormsForLead(db, 1).length, 2);

forms.publishForm(db, 1, { formId: a.id, workspaceId: 1 });
forms.publishForm(db, 1, { formId: b.id, workspaceId: 1 });

const sync = forms.syncSiteFormEmbeds(db, 1);
assert.ok(sync.synced, 'sync should succeed');

const site = db.prepare('SELECT pages FROM websites WHERE id=1').get();
const pages = JSON.parse(site.pages);
const contact = pages.find((p) => String(p.slug).includes('contact'));
assert.ok(contact, 'contact page exists');
const contactJson = JSON.stringify(contact);
assert.ok(
  /embed\/form\.html/.test(contactJson),
  `contact should contain form embed: ${contactJson.slice(0, 300)}`
);

const home = pages.find((p) => p.slug === '/' || normalize(p.slug) === 'home');
const homeJson = JSON.stringify(home || {});
assert.ok(
  !homeJson.includes(b.public_token),
  'disabled embed form should not appear on home'
);

forms.deleteForm(db, 1, b.id);
assert.equal(forms.listFormsForLead(db, 1).length, 1);
console.log('smoke ok', { a: a.id, bDeleted: b.id, syncForms: sync.forms });

function normalize(slug) {
  return String(slug || '').replace(/^\//, '').toLowerCase();
}
