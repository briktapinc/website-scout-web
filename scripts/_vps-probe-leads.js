'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const root = process.env.WORKSPACE_DATA_DIR || '/app/data/workspaces';
console.log('root', root, 'exists', fs.existsSync(root));
if (!fs.existsSync(root)) process.exit(0);
for (const name of fs.readdirSync(root)) {
  const dbFile = path.join(root, name, 'websitescout.db');
  if (!fs.existsSync(dbFile)) continue;
  const db = new Database(dbFile, { readonly: true });
  const leadCount = db.prepare('SELECT COUNT(*) AS c FROM leads').get().c;
  const withEmail = db.prepare(
    `SELECT COUNT(*) AS c FROM leads WHERE email IS NOT NULL AND trim(email) != ''`
  ).get().c;
  let jobs = 0;
  let jobEmails = 0;
  try {
    jobs = db.prepare('SELECT COUNT(*) AS c FROM design_jobs').get().c;
    jobEmails = db.prepare(
      `SELECT COUNT(*) AS c FROM design_jobs WHERE contact_email IS NOT NULL AND trim(contact_email) != ''`
    ).get().c;
  } catch { /* */ }
  let sites = 0;
  try { sites = db.prepare('SELECT COUNT(*) AS c FROM websites').get().c; } catch { /* */ }
  const sample = db.prepare('SELECT id, business_name, email FROM leads ORDER BY id DESC LIMIT 5').all();
  console.log(JSON.stringify({ workspaceId: name, leadCount, withEmail, jobs, jobEmails, sites, sample }, null, 2));
  db.close();
}
