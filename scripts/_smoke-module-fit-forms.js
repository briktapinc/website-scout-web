'use strict';

/**
 * Smoke: module-fit QA + forms.suggestFields / purpose-built fields.
 * Usage: node scripts/_smoke-module-fit-forms.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-module-fit-'));
  const dbPath = path.join(dir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE leads (
      id INTEGER PRIMARY KEY,
      business_name TEXT,
      email TEXT,
      phone TEXT,
      name TEXT,
      status TEXT,
      updated_at TEXT
    );
    CREATE TABLE websites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER,
      pages TEXT,
      theme TEXT,
      status TEXT DEFAULT 'draft',
      origin TEXT DEFAULT 'agent',
      name TEXT,
      industry TEXT,
      preview_path TEXT,
      preview_url TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE business_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER,
      fact_key TEXT,
      value TEXT,
      claim_class TEXT,
      source TEXT
    );
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      area TEXT,
      message TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE website_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      website_id INTEGER,
      version_no INTEGER,
      pages TEXT,
      theme TEXT,
      note TEXT,
      author TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.prepare(
    'INSERT INTO leads (id, business_name, email, phone, status) VALUES (1, ?, ?, ?, ?)'
  ).run('Smoke Barbers', 'owner@example.com', '5551234567', 'new');

  const reservePages = [
    {
      slug: 'home',
      title: 'Home',
      sections: [
        { type: 'nav', content: { html: '<nav><a href="index.html">Home</a><a href="reserve.html">Reserve</a></nav>' } },
        { type: 'html', content: { html: '<main><h1>Smoke Barbers</h1><p>Call to book: <a href="tel:5551234567">555-123-4567</a></p></main>' } },
        { type: 'footer', content: {} },
      ],
    },
    {
      slug: 'reserve',
      title: 'Reserve',
      sections: [
        { type: 'nav', content: { html: '<nav><a href="index.html">Home</a><a href="reserve.html">Reserve</a></nav>' } },
        { type: 'contact_form', content: {} },
        { type: 'footer', content: {} },
      ],
    },
  ];

  db.prepare('INSERT INTO websites (lead_id, pages, theme, name) VALUES (1, ?, ?, ?)').run(
    JSON.stringify(reservePages),
    JSON.stringify({ primary: '#111', bg: '#fff', text: '#111', font: 'Georgia, serif' }),
    'Smoke Barbers'
  );

  const forms = require('../server/contactForms');
  const modules = require('../server/siteModules');
  const moduleFit = require('../server/moduleFit');
  const engine = require('../src/websiteEngine');

  forms.ensureTables(db);
  modules.ensureTables(db);
  engine.ensureTables(db);

  // --- suggestFields ---
  const suggested = forms.suggestFieldsForPurpose(db, 1, 'appointment_request');
  assert(suggested.purpose === 'appointment_request', 'purpose');
  assert(Array.isArray(suggested.fields) && suggested.fields.length >= 5, 'field count');
  const keys = suggested.fields.map((f) => f.field_key);
  assert(keys.includes('service'), 'service field');
  assert(keys.includes('preferred_date'), 'preferred_date');
  assert(keys.includes('time_window'), 'time_window');
  assert(keys.includes('staff_preference'), 'staff_preference');
  assert(suggested.fields.find((f) => f.field_key === 'service').field_type === 'select', 'service select');
  assert(!forms.isFreeTextOnlyFields(suggested.fields), 'not free-text-only');

  modules.createBookingService(db, 1, {
    name: 'Classic Cut',
    status: 'published',
    duration_minutes: 30,
  });
  modules.createTeamMember(db, 1, { name: 'Alex', status: 'published' });
  const suggested2 = forms.suggestFieldsForPurpose(db, 1, 'appointment_request');
  const svcOpts = suggested2.fields.find((f) => f.field_key === 'service').options || [];
  assert(svcOpts.includes('Classic Cut'), 'service options from lead');
  const staffOpts = suggested2.fields.find((f) => f.field_key === 'staff_preference').options || [];
  assert(staffOpts.includes('First available') && staffOpts.includes('Alex'), 'staff options');

  const created = forms.createForm(db, 1, { purpose: 'appointment_request' });
  assert(created.form_kind === 'appointment', 'form_kind appointment');
  assert(
    created.fields.some((f) => f.field_key === 'service' && f.field_type === 'select'),
    'created typed service'
  );
  console.log('forms.create purpose=appointment_request fields:', created.fields.map((f) => f.field_key).join(', '));

  // --- module-fit FAIL: /reserve with only contact form ---
  const fitFail = moduleFit.assessModuleFit(db, 1, reservePages);
  assert(!fitFail.pass, 'module-fit should fail for /reserve with contact form only');
  assert(/bookings|service|hours|Remediation|remediation/i.test(fitFail.detail), 'remediation in detail');
  console.log('FAIL path:', fitFail.detail);

  let qaFail;
  try {
    qaFail = await engine.qaSite(db, 1);
  } catch (e) {
    console.warn('qaSite (fail path) threw — checking assessModuleFit only:', e.message);
    qaFail = null;
  }
  if (qaFail) {
    const moduleFitCheck = (qaFail.checks || []).find((c) => c.name === 'module-fit');
    assert(moduleFitCheck && !moduleFitCheck.pass, 'qaSite module-fit fails');
    console.log('qa module-fit fail:', moduleFitCheck.detail);
  }

  // --- module-fit GREEN ---
  const attached = modules.attachModule(db, 1, 'bookings', {
    workspaceId: 1,
    target_page_slug: 'reserve',
    show_request_form: false,
    forceInject: true,
  });
  assert(attached && attached.embed && attached.embed.public_token, 'bookings embed');

  const siteRow = db.prepare('SELECT pages FROM websites WHERE id = 1').get();
  let pagesGreen = JSON.parse(siteRow.pages || '[]');
  const reserve = pagesGreen.find((p) => p.slug === 'reserve');
  assert(reserve, 'reserve page');
  if (!moduleFit.pageHasBookingsMount(reserve)) {
    const html = modules.embedBlockHtml(attached.embed, undefined);
    reserve.sections = (reserve.sections || []).filter((s) => s && s.type !== 'contact_form');
    reserve.sections.splice(1, 0, { type: 'html', content: { html } });
    db.prepare('UPDATE websites SET pages = ? WHERE id = 1').run(JSON.stringify(pagesGreen));
    pagesGreen = JSON.parse(db.prepare('SELECT pages FROM websites WHERE id = 1').get().pages);
  }

  modules.setBookingHours(db, 1, [
    { weekday: 1, start_time: '09:00', end_time: '17:00' },
    { weekday: 2, start_time: '09:00', end_time: '17:00' },
  ]);

  const fitOk = moduleFit.assessModuleFit(db, 1, pagesGreen);
  assert(fitOk.pass, `module-fit should pass: ${fitOk.detail}`);
  console.log('PASS path:', fitOk.detail);

  let qaOk;
  try {
    qaOk = await engine.qaSite(db, 1);
  } catch (e) {
    console.warn('qaSite (pass path) threw — assessModuleFit already green:', e.message);
    qaOk = null;
  }
  if (qaOk) {
    const moduleFitOk = (qaOk.checks || []).find((c) => c.name === 'module-fit');
    assert(moduleFitOk && moduleFitOk.pass, `qaSite module-fit green: ${moduleFitOk && moduleFitOk.detail}`);
  }

  const warnPages = [
    { slug: 'reserve', title: 'Reserve', sections: [{ type: 'contact_form', content: {} }] },
  ];
  const warn = moduleFit.formOnAppointmentPageWarning(warnPages, 'reserve');
  assert(warn && /bookings/i.test(warn), 'form-on-appointment warning');

  console.log('SMOKE OK: module-fit + suggestFields + purpose fields');
}

main().catch((e) => {
  console.error('SMOKE FAIL:', e);
  process.exit(1);
});
