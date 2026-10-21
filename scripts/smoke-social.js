'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const social = require('../src/socialMedia');

const dir = path.join(os.tmpdir(), 'ws-social-test');
fs.mkdirSync(dir, { recursive: true });
const dbPath = path.join(dir, 't.db');
try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
const db = new Database(dbPath);
db.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
social.ensureTables(db);
db.prepare(
  "INSERT INTO leads (business_name, category, city, email, status) VALUES ('Acme Plumbing', 'Plumber', 'Springfield', 'a@test.com', 'new')"
).run();

(async () => {
  const r = await social.generateMonth(db, {
    leadId: 1,
    monthStart: '2026-04-01',
    days: 7,
    withImages: false,
    requireClientApproval: true,
    clientEmail: 'a@test.com',
  });
  console.log('campaign', r.campaign.id, 'posts', r.posts.length);
  const w = await social.sendWeeklyBatch(db, { campaignId: r.campaign.id, workspaceId: 9, force: true });
  console.log('week', w.batchId, !!w.approveUrl, w.smtpConfigured);
  const token = new URL(w.approveUrl).searchParams.get('token');
  social.decideBatch(db, token, { action: 'approve' });
  const after = social.getCampaign(db, r.campaign.id);
  console.log('statuses', after.posts.map((p) => p.status).join(','));
  console.log('OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
