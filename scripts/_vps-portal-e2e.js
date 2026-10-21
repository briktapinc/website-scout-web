'use strict';

/**
 * In-container e2e for client portal (bypasses HTTP/captcha).
 * Finds a lead with email, requests access, logs in, loads context.
 */
const fs = require('fs');
const path = require('path');

async function main() {
  const portal = require('../server/clientPortal');
  const { migrate, ping } = require('../server/db');
  await ping();
  await migrate();

  const root = process.env.WORKSPACE_DATA_DIR || path.join(__dirname, '..', 'data', 'workspaces');
  let pick = null;
  if (fs.existsSync(root)) {
    for (const name of fs.readdirSync(root)) {
      if (!/^\d+$/.test(name)) continue;
      const dbFile = path.join(root, name, 'websitescout.db');
      if (!fs.existsSync(dbFile)) continue;
      const Database = require('better-sqlite3');
      const db = new Database(dbFile, { readonly: true });
      try {
        const row = db.prepare(
          `SELECT id, email, business_name FROM leads
           WHERE email IS NOT NULL AND trim(email) != '' LIMIT 1`
        ).get();
        if (row) {
          pick = { workspaceId: Number(name), leadId: row.id, email: row.email, businessName: row.business_name };
          break;
        }
      } catch { /* */ }
      finally { db.close(); }
    }
  }

  if (!pick) {
    console.log(JSON.stringify({ ok: false, reason: 'NO_LEAD_WITH_EMAIL' }));
    process.exit(2);
  }

  process.env.DEV_RETURN_PORTAL_PASSWORD = '1';
  const access = await portal.requestAccess(pick.email);
  if (!access.devPassword && !access.emailed) {
    // SMTP may have sent; create a known password via login path reset by calling requestAccess again
    // If SMTP configured, we still need a password — set one directly.
  }

  let password = access.devPassword;
  if (!password) {
    // Force a known password hash for smoke (do not print after)
    const bcrypt = require('bcryptjs');
    const { query } = require('../server/db');
    password = portal.generatePassword();
    const hash = await bcrypt.hash(password, 12);
    await query(
      `UPDATE client_portal_users SET password_hash = :hash WHERE email = :email`,
      { hash, email: String(pick.email).trim().toLowerCase() }
    );
  }

  const client = await portal.login(pick.email, password);
  const ctx = portal.loadLeadContext(client.workspaceId, client.leadId);
  const cal = portal.calendarPosts(client.workspaceId, client.leadId, {});
  const bill = await portal.billingForClient(client.workspaceId, client.email);

  console.log(JSON.stringify({
    ok: true,
    email: client.email,
    workspaceId: client.workspaceId,
    leadId: client.leadId,
    businessName: client.businessName || pick.businessName,
    previewUrl: ctx.previewUrl,
    hasSite: !!ctx.site,
    calendarPosts: cal.posts.length,
    billingStatus: bill.subscriptionStatus,
    workspaceSubscribed: bill.workspaceSubscribed,
    accessEmailed: !!access.emailed,
  }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message, code: e.code }));
  process.exit(1);
});
