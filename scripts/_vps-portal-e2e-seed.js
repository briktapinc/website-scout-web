'use strict';

/**
 * Seeds a contact email on the lead that owns a website, creates portal
 * credentials, and verifies login + dashboard data inside the container.
 */
const bcrypt = require('bcryptjs');
const { openWorkspaceDb } = require('../server/workspaceDb');
const portal = require('../server/clientPortal');
const { migrate, ping, query } = require('../server/db');

const SMOKE_EMAIL = process.env.PORTAL_SMOKE_EMAIL || 'portal-smoke@bitpype.com';

async function main() {
  await ping();
  await migrate();

  const workspaceId = 1;
  const db = openWorkspaceDb(workspaceId);
  const site = db.prepare(
    `SELECT id, lead_id, name, preview_url, preview_path FROM websites
     WHERE lead_id IS NOT NULL ORDER BY id DESC LIMIT 1`
  ).get();
  if (!site) throw new Error('No website with lead_id in workspace 1');

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(site.lead_id);
  if (!lead) throw new Error('Lead missing for site');

  db.prepare("UPDATE leads SET email = ?, updated_at = datetime('now') WHERE id = ?")
    .run(SMOKE_EMAIL, lead.id);

  const password = portal.generatePassword();
  const hash = await bcrypt.hash(password, 12);
  const existing = await portal.findByEmail(SMOKE_EMAIL);
  if (existing) {
    await query(
      `UPDATE client_portal_users
       SET password_hash = :hash, workspace_id = :ws, lead_id = :lead,
           business_name = :name, status = 'active'
       WHERE id = :id`,
      {
        hash,
        ws: workspaceId,
        lead: lead.id,
        name: lead.business_name || '',
        id: existing.id,
      }
    );
  } else {
    await query(
      `INSERT INTO client_portal_users
        (email, password_hash, workspace_id, lead_id, business_name, status)
       VALUES (:email, :hash, :ws, :lead, :name, 'active')`,
      {
        email: SMOKE_EMAIL,
        hash,
        ws: workspaceId,
        lead: lead.id,
        name: lead.business_name || '',
      }
    );
  }

  const client = await portal.login(SMOKE_EMAIL, password);
  const ctx = portal.loadLeadContext(client.workspaceId, client.leadId);
  const cal = portal.calendarPosts(client.workspaceId, client.leadId, {});
  const bill = await portal.billingForClient(client.workspaceId, client.email);

  // Soft-check requestAccess matching (does not print emailed password)
  const matches = portal.findLeadMatches(SMOKE_EMAIL);
  const matched = matches.some((m) => m.leadId === lead.id && m.workspaceId === workspaceId);

  console.log(JSON.stringify({
    ok: true,
    smokeEmail: SMOKE_EMAIL,
    smokePassword: password,
    loginUrl: 'https://bitpype.com/portal',
    workspaceId: client.workspaceId,
    leadId: client.leadId,
    businessName: lead.business_name,
    siteId: site.id,
    previewUrl: ctx.previewUrl,
    calendarPosts: cal.posts.length,
    billingStatus: bill.subscriptionStatus,
    workspaceSubscribed: bill.workspaceSubscribed,
    leadMatchOk: matched,
  }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message, stack: e.stack }));
  process.exit(1);
});
