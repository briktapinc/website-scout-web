'use strict';

const domain = require('../server/domain');

const ws = 1;

(async () => {
  const listed = domain.formsList(ws, { leadId: 185 });
  console.log('list_count', (listed.forms || []).length);

  const created = domain.formsCreate(ws, {
    leadId: 185,
    name: 'MCP QA Temporary Form',
    fields: [
      { label: 'Name', type: 'text', required: true },
      { label: 'Email', type: 'email', required: true },
      { label: 'Phone', type: 'phone' },
      { label: 'Notes', type: 'textarea' },
    ],
    submit_label: 'Send',
    success_message: 'Thanks',
    notify_email: 'hello@example.com',
  });
  console.log('created', created.formId, !!(created.embed && created.embed.html));
  console.log('sectionHint', JSON.stringify(created.sectionHint));

  const del = domain.formsDelete(ws, { leadId: 185, formId: created.formId });
  console.log('deleted', del.deleted, 'remaining', (del.forms || []).length);

  const site = domain.sitesGet(ws, 5);
  let pages = site && site.pages;
  if (typeof pages === 'string') {
    try { pages = JSON.parse(pages); } catch { pages = []; }
  }
  if (!Array.isArray(pages)) pages = [];
  pages = JSON.parse(JSON.stringify(pages));
  const contact = pages.find((p) => String(p.slug || '').includes('contact')) || pages[0];
  if (!contact) throw new Error('No pages on site 5');
  const htmlSec = (contact.sections || []).find((s) => s && s.type === 'html');
  if (htmlSec && htmlSec.content) {
    htmlSec.content.html = `${htmlSec.content.html || ''}<form action="#"><input name="x"></form>`;
  } else {
    contact.sections = contact.sections || [];
    contact.sections.splice(1, 0, {
      type: 'html',
      content: { html: '<form action="#"><button>x</button></form>' },
    });
  }

  const saved = domain.sitesSave(ws, 5, {
    pages,
    theme: site.theme || {},
    note: 'forms-guard e2e',
  });
  console.log('save_warnings', saved.warnings);

  // Confirm stripped from stored pages
  const after = domain.sitesGet(ws, 5);
  const blob = JSON.stringify(after.pages);
  console.log('stored_has_raw_form', /<form\b/i.test(blob));

  const qa = await domain.sitesQa(ws, 5);
  const check = (qa.checks || []).find((c) => c.name === 'single-functional-form');
  console.log('qa_form_check', check && { pass: check.pass, detail: check.detail });
  console.log('e2e_ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
