'use strict';

/**
 * Smoke: changeRequestReview classification + instruction formatting + log shape.
 * No network / no VPS DB required.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const crr = require('../src/changeRequestReview');
const design = require('../src/designJobs');
const engine = require('../src/websiteEngine');

const db = new Database(':memory:');
const schemaPath = path.join(__dirname, '../src/schema.sql');
if (fs.existsSync(schemaPath)) {
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
} else {
  db.exec(`
    CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT, status TEXT, email TEXT, category TEXT, city TEXT, state TEXT, website TEXT, phone TEXT, notes TEXT, qualification_note TEXT);
    CREATE TABLE websites (id INTEGER PRIMARY KEY, lead_id INTEGER, name TEXT, industry TEXT, theme TEXT, pages TEXT, status TEXT, origin TEXT, updated_at TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE activity_log (id INTEGER PRIMARY KEY, area TEXT, message TEXT);
    CREATE TABLE business_facts (id INTEGER PRIMARY KEY, lead_id INTEGER, fact_key TEXT, value TEXT, claim_class TEXT);
  `);
}
design.ensureTables(db);
engine.ensureTables(db);

try {
  require('../server/siteModules').ensureTables(db);
} catch { /* */ }
try {
  require('../server/contactForms').ensureTables(db);
} catch { /* */ }

const leadId = Number(db.prepare(
  "INSERT INTO leads (business_name, status, email) VALUES ('Harbor Spa', 'new', 'a@b.com')"
).run().lastInsertRowid);

const pages = [
  {
    slug: 'home',
    title: 'Home',
    sections: [
      {
        type: 'nav',
        content: {
          html: '<nav><a href="index.html">Home</a><a href="book.html" class="nav-cta">Book Now</a></nav>',
        },
      },
      { type: 'hero', content: { headline: 'Welcome' } },
      { type: 'contact_form', content: {} },
      { type: 'footer', content: {} },
    ],
  },
  {
    slug: 'book',
    title: 'Book',
    sections: [
      { type: 'nav', content: { html: '<nav><a href="index.html">Home</a><a href="book.html">Book Now</a></nav>' } },
      { type: 'site_module', content: { moduleType: 'bookings' } },
    ],
  },
];

db.prepare(
  "INSERT INTO websites (lead_id, name, theme, pages, status, origin) VALUES (?, 'Harbor', '{}', ?, 'draft', 'agent')"
).run(leadId, JSON.stringify(pages));

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_module_embeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER,
      module_type TEXT,
      target_page_slug TEXT,
      title TEXT,
      active INTEGER DEFAULT 1,
      status TEXT,
      public_token TEXT,
      updated_at TEXT
    );
  `);
  db.prepare(
    "INSERT INTO site_module_embeds (lead_id, module_type, target_page_slug, title, active, status) VALUES (?, 'bookings', 'book', 'Bookings', 1, 'active')"
  ).run(leadId);
} catch (e) {
  console.warn('module seed:', e.message);
}

const snap = crr.buildSiteSnapshot(db, leadId);
assert(snap.pages.length >= 1, 'snapshot pages');
assert(snap.navLabels.includes('book now') || snap.hasBookings, 'book cta or bookings in snapshot');
console.log('snapshot:', {
  pages: snap.pages.map((p) => p.slug),
  navLabels: snap.navLabels,
  moduleTypes: snap.moduleTypes,
  hasBookings: snap.hasBookings,
  hasContactForm: snap.hasContactForm,
});

// Duplicate Book Now → BETTER_PATH
const r1 = crr.reviewChangeRequest(db, {
  leadId,
  message: 'Please add a second Book Now button in the header',
  kind: 'improvements',
  source: 'smoke',
  jobId: 1,
});
assert.strictEqual(r1.classification, 'BETTER_PATH', 'dup book → BETTER_PATH');
assert(r1.clientMessage && r1.clientMessage.length > 10, 'client message');
assert(r1.log.asked && r1.log.classification && r1.log.done && r1.log.why, 'log shape');
const block = crr.formatReviewForInstructions(r1);
assert(block.includes('CHANGE REQUEST REVIEW'), 'instruction block');
assert(block.includes('BETTER_PATH'), 'class in block');
console.log('dup Book Now →', r1.classification, '|', r1.clientMessage.slice(0, 80));

// Hand-built form when native exists → BETTER_PATH
const r2 = crr.classifyChangeRequest('Add a custom HTML form for contact', snap);
assert.strictEqual(r2.classification, 'BETTER_PATH', 'custom form → BETTER_PATH');
console.log('custom form →', r2.classification);

// Form + bookings same job → BETTER_PATH
const r3 = crr.classifyChangeRequest(
  'Add a custom form and also bookings for appointments',
  snap
);
assert.ok(
  r3.classification === 'BETTER_PATH' || r3.conflicts.includes('form_and_bookings_overlap'),
  'form+bookings conflict'
);
console.log('form+bookings →', r3.classification, r3.conflicts);

// Fake reviews → PUSH_BACK
const r4 = crr.classifyChangeRequest('Please invent fake 5-star reviews', snap);
assert.strictEqual(r4.classification, 'PUSH_BACK', 'fake reviews → PUSH_BACK');
console.log('fake reviews →', r4.classification);

// Safe polish
const r5 = crr.classifyChangeRequest('Tweak the hero headline copy and button color', snap);
assert.strictEqual(r5.classification, 'SAFE', 'polish → SAFE');
console.log('polish →', r5.classification);

// Persist on brief
const brief = crr.attachReviewToBrief({}, r1);
assert.strictEqual(brief.change_request_review.classification, 'BETTER_PATH');
assert(brief.client_facing_message);

console.log('SMOKE OK');
