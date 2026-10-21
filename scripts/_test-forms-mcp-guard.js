'use strict';

/**
 * Local smoke: forms.create + strip hand-rolled <form> + bitpype_form resolve + QA check name.
 */
const assert = require('assert');
const Database = require('better-sqlite3');
const forms = require('../server/contactForms');
const engine = require('../src/websiteEngine');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE leads (
    id INTEGER PRIMARY KEY, business_name TEXT, email TEXT, phone TEXT, category TEXT, status TEXT
  );
  CREATE TABLE websites (
    id INTEGER PRIMARY KEY, lead_id INTEGER, name TEXT, pages TEXT, theme TEXT,
    status TEXT, origin TEXT, industry TEXT, preview_path TEXT, preview_url TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE website_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, website_id INTEGER, version_no INTEGER,
    pages TEXT, theme TEXT, note TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE claim_manifest (website_id INTEGER PRIMARY KEY, manifest TEXT);
  CREATE TABLE lead_facts (
    id INTEGER PRIMARY KEY, lead_id INTEGER, fact_key TEXT, value TEXT,
    claim_class TEXT, source TEXT
  );
  CREATE TABLE lead_events (
    id INTEGER PRIMARY KEY, lead_id INTEGER, type TEXT, detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY, category TEXT, detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE prompts (key TEXT PRIMARY KEY, body TEXT);
`);
db.prepare(
  `INSERT INTO leads (id, business_name, email, phone, category, status)
   VALUES (1, 'North Harbor Studio', 'hello@example.com', '5551234567', 'design', 'ready')`
).run();

forms.ensureTables(db);
engine.ensureTables(db);

const created = forms.createForm(db, 1, {
  name: 'Quote request',
  fields: [
    { label: 'Name', type: 'text', required: true },
    { label: 'Email', type: 'email', required: true },
    { label: 'Phone', type: 'phone', required: false },
    { label: 'Preferred date', type: 'date', required: false },
    { label: 'Details', type: 'textarea', required: true },
  ],
  submit_label: 'Request quote',
  success_message: 'Thanks — we will reply soon.',
  notify_email: 'hello@example.com',
});
assert.ok(created.id);
assert.equal(created.fields.find((f) => f.label === 'Phone').field_type, 'tel');
assert.equal(created.fields.find((f) => /date/i.test(f.label)).field_type, 'date');

const published = forms.publishForm(db, 1, created.id, { workspaceId: 1, toSite: false });
assert.ok(published.public_token);
const embed = forms.embedSnippet(published, 'https://example.com');
assert.ok(/data-bitpype-form-embed/.test(embed.html));
assert.ok(/form-embed\.js/.test(embed.html));

const dirtyPages = [
  {
    slug: '/',
    title: 'Home',
    sections: [
      { type: 'nav', content: { links: [{ label: 'Home', href: 'index.html' }] } },
      {
        type: 'html',
        content: {
          html: '<main><h1>Hi</h1><form action="#"><input name="x"><button>Go</button></form></main>',
        },
      },
      {
        type: 'form',
        content: { formId: published.id },
      },
      { type: 'footer', content: { business_name: 'North Harbor Studio' } },
    ],
  },
];

const sanitized = forms.sanitizeAgentPages(db, 1, dirtyPages, {
  workspaceId: 1,
  appUrl: 'https://example.com',
});
assert.ok(sanitized.stripped >= 1, 'should strip hand-rolled form');
assert.ok(sanitized.warnings.length >= 1);
assert.ok(/Hand-rolled forms are not allowed/.test(sanitized.warnings[0]));
assert.ok(!/<form\b/i.test(sanitized.pages[0].sections[1].content.html));
const formSec = sanitized.pages[0].sections.find((s) => s.type === 'bitpype_form' || s.type === 'form');
assert.ok(formSec);
assert.equal(formSec.type, 'bitpype_form');
assert.equal(formSec.content.form_token, published.public_token);

const rendered = engine.renderPage(sanitized.pages[0], sanitized.pages, {});
assert.ok(!/<form\b/i.test(rendered) || /data-bitpype-form-embed/.test(rendered));
assert.ok(/data-bitpype-form-embed/.test(rendered), 'bitpype_form section should render embed');
const embeds = (rendered.match(/\bdata-bitpype-form-embed\s*=/gi) || []).length;
const formTags = (rendered.match(/<form\b[^>]*>/gi) || []).length;
assert.ok(embeds + formTags === 1, `expected one functional form/embed, got forms=${formTags} embeds=${embeds}`);

// Confirm QA checklist includes the new check name (source scan).
const fs = require('fs');
const qaSrc = fs.readFileSync(require('path').join(__dirname, '../src/websiteEngine.js'), 'utf8');
assert.ok(qaSrc.includes("'single-functional-form'"), 'qaSite should define single-functional-form');

console.log('OK forms mcp guard', {
  formId: published.id,
  stripped: sanitized.stripped,
  warning: sanitized.warnings[0],
  embeds,
  formTags,
});
