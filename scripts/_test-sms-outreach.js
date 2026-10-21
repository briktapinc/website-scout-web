'use strict';
const Database = require('better-sqlite3');
const db = new Database(':memory:');

db.exec(`
CREATE TABLE email_templates (id INTEGER PRIMARY KEY, name TEXT, subject TEXT, body TEXT, created_at TEXT);
CREATE TABLE campaigns (id INTEGER PRIMARY KEY, name TEXT, template_id INTEGER, status TEXT, rate_per_hour INTEGER, created_at TEXT);
CREATE TABLE campaign_messages (id INTEGER PRIMARY KEY, campaign_id INTEGER, lead_id INTEGER, to_email TEXT, subject TEXT, body TEXT, status TEXT, scheduled_at TEXT, sent_at TEXT, error TEXT);
CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT, phone TEXT, email TEXT, status TEXT, category TEXT, city TEXT, state TEXT, updated_at TEXT);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE activity_log (id INTEGER PRIMARY KEY, area TEXT, message TEXT, at TEXT DEFAULT (datetime('now')));
CREATE TABLE business_facts (id INTEGER PRIMARY KEY, lead_id INTEGER, fact_key TEXT, value TEXT, claim_class TEXT);
CREATE TABLE websites (id INTEGER PRIMARY KEY, lead_id INTEGER, preview_url TEXT, preview_path TEXT);
CREATE TABLE suppression_list (id INTEGER PRIMARY KEY, email TEXT, reason TEXT, created_at TEXT);
CREATE TABLE email_events (id INTEGER PRIMARY KEY, message_id INTEGER, type TEXT, detail TEXT, at TEXT);
CREATE TABLE prospect_events (id INTEGER PRIMARY KEY, lead_id INTEGER, type TEXT, detail TEXT, at TEXT);
`);

db.prepare(
  "INSERT INTO leads (id, business_name, phone, email, status) VALUES (1, 'Acme HVAC', '5551234567', 'a@b.com', 'qualified')"
).run();
db.prepare("INSERT INTO websites (lead_id, preview_url) VALUES (1, 'https://preview.example/acme/')").run();

const o = require('../src/outreach');
const sms = require('../src/sms');
o.ensureTables(db);

const cols = db.prepare('PRAGMA table_info(email_templates)').all().map((c) => c.name);
if (!cols.includes('sms_body')) throw new Error('sms_body column missing');
const msgCols = db.prepare('PRAGMA table_info(campaign_messages)').all().map((c) => c.name);
if (!msgCols.includes('channel') || !msgCols.includes('to_phone')) {
  throw new Error('msg cols missing ' + msgCols.join(','));
}

const link = o.resolveWebsiteLink(db, 1);
const draft = sms.companionSmsDraft({ businessName: 'Acme HVAC', websiteLink: link });

// Unified template: email + SMS together
const t = o.saveTemplate(db, {
  name: 'Intro',
  subject: 'Quick preview for {{business_name}}',
  body: '<p>Hi {{business_name}}, see {{website_link}} — {{interested}}</p>',
  sms_body: 'Hi {{business_name}} — preview: {{website_link}}',
});
if (!t.hasEmail || !t.hasSms) throw new Error('expected dual-channel template');

const campSms = o.createCampaign(db, {
  name: 'SMS camp', templateId: t.id, leadIds: [1], ratePerHour: 60, channel: 'sms',
});
const msg = db.prepare('SELECT * FROM campaign_messages WHERE campaign_id=?').get(campSms.id);
if (msg.channel !== 'sms') throw new Error('channel');
if (!msg.to_phone) throw new Error('phone');
if (!msg.body.includes('https://preview.example/acme/')) throw new Error('link in body');

const campBoth = o.createCampaign(db, {
  name: 'Both camp', templateId: t.id, leadIds: [1], ratePerHour: 60, channel: 'both',
});
const bothMsgs = db.prepare('SELECT channel FROM campaign_messages WHERE campaign_id=? ORDER BY id').all(campBoth.id);
if (bothMsgs.length !== 2) throw new Error('expected 2 messages for both');
if (!bothMsgs.some((m) => m.channel === 'email') || !bothMsgs.some((m) => m.channel === 'sms')) {
  throw new Error('both channels');
}

db.prepare(
  "INSERT INTO leads (id, business_name, phone, email, status) VALUES (2, 'NoPhone', null, 'x@y.com', 'qualified')"
).run();
const camp2 = o.createCampaign(db, {
  name: 'SMS2', templateId: t.id, leadIds: [2], ratePerHour: 60, channel: 'sms',
});
if (camp2.suppressed !== 1) throw new Error('expected suppressed');

// Legacy SMS-only row → migrate into sms_body
db.prepare(
  "INSERT INTO email_templates (name, subject, body, channel, sms_body) VALUES ('Legacy Pair', 'Hello', '<p>Email</p>', 'email', '')"
).run();
db.prepare(
  "INSERT INTO email_templates (name, subject, body, channel, sms_body) VALUES ('Legacy Pair', '(SMS)', 'Text {{website_link}}', 'sms', '')"
).run();
o.migrateUnifiedTemplates(db);
const merged = db.prepare("SELECT * FROM email_templates WHERE name = 'Legacy Pair'").all();
if (merged.length !== 1) throw new Error('expected merge by name, got ' + merged.length);
if (!String(merged[0].sms_body || '').includes('{{website_link}}')) throw new Error('merged sms_body');
if (String(merged[0].channel).toLowerCase() === 'sms') throw new Error('channel should not stay sms');

// Legacy channel:'sms' save still works
const legacySave = o.saveTemplate(db, {
  name: 'Old API SMS', body: 'Hi {{business_name}} {{website_link}}', channel: 'sms',
});
const legacyRow = db.prepare('SELECT * FROM email_templates WHERE id=?').get(legacySave.id);
if (!legacyRow.sms_body.includes('{{website_link}}')) throw new Error('legacy save sms_body');
if (String(legacyRow.body || '').trim()) throw new Error('legacy save should clear email body');

console.log(JSON.stringify({
  link, draft: draft.slice(0, 60), campSms, campBoth, to_phone: msg.to_phone,
  mergedSms: merged[0].sms_body, legacySave,
}, null, 2));
console.log('ALL TESTS PASSED');
