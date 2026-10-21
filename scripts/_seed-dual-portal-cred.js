'use strict';

/** One-shot: ensure a portal user exists and print { ok, email, password }. */
const bcrypt = require('bcryptjs');
const { query } = require('../server/db');
const { openWorkspaceDb, dataRoot } = require('../server/workspaceDb');
const fs = require('fs');
const path = require('path');

async function findAnyLead() {
  const rows = await query(
    `SELECT workspace_id, id AS lead_id FROM leads ORDER BY id ASC LIMIT 1`
  ).catch(() => []);
  if (rows[0]) return rows[0];

  const root = dataRoot();
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
    .map((d) => Number(d.name));
  for (const workspaceId of dirs) {
    const dbFile = path.join(root, String(workspaceId), 'websitescout.db');
    if (!fs.existsSync(dbFile)) continue;
    try {
      const db = openWorkspaceDb(workspaceId);
      const lead = db.prepare('SELECT id FROM leads ORDER BY id ASC LIMIT 1').get();
      if (lead) return { workspace_id: workspaceId, lead_id: lead.id };
    } catch { /* next */ }
  }
  return null;
}

async function main() {
  const password = `DualSess!${Date.now().toString(36)}`;
  const hash = await bcrypt.hash(password, 10);
  let email = 'dual-session-test@bitpype.local';

  const existing = await query(
    "SELECT id, email FROM client_portal_users WHERE status='active' ORDER BY id ASC LIMIT 1"
  );
  if (existing[0]) {
    email = existing[0].email;
    await query(
      "UPDATE client_portal_users SET password_hash = :hash, status = 'active' WHERE id = :id",
      { hash, id: existing[0].id }
    );
  } else {
    const lead = await findAnyLead();
    if (!lead) {
      console.log(JSON.stringify({ ok: false, skip: true, reason: 'no lead' }));
      process.exit(0);
    }
    await query(
      `INSERT INTO client_portal_users
        (email, password_hash, workspace_id, lead_id, business_name, status)
       VALUES (:email, :hash, :ws, :lead, '', 'active')
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), status = 'active'`,
      { email, hash, ws: lead.workspace_id, lead: lead.lead_id }
    );
  }
  console.log(JSON.stringify({ ok: true, email, password }));
  process.exit(0);
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
