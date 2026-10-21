'use strict';

/**
 * Confirm from_email, list Mailjet senders, validate / switch if possible,
 * then send a distinctive test when an Active sender exists.
 *
 * Usage: node scripts/_mailjet-fix-from.js [testTo]
 */

const https = require('https');
const Database = require('better-sqlite3');

const testTo = process.argv[2] || 'eliayertey@gmail.com';
const TS = new Date().toISOString();

function httpJson(method, url, { auth, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        Accept: 'application/json',
        ...(payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}),
        ...(auth ? { Authorization: 'Basic ' + Buffer.from(auth).toString('base64') } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch { /* raw */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

async function platformSettings() {
  const { platformSmtpSettings } = require('../server/mailer');
  return platformSmtpSettings();
}

function workspaceSettings(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  db.close();
  return out;
}

function setWorkspaceFrom(dbPath, email) {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('smtp.from_email', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(email);
  db.close();
}

async function setPlatformFrom(email) {
  const platform = require('../server/platform');
  await platform.setPlatformSetting('smtp.from_email', email);
}

(async () => {
  const platform = await platformSettings();
  const wsPath = '/app/data/workspaces/1/websitescout.db';
  let workspace = {};
  try { workspace = workspaceSettings(wsPath); } catch (e) {
    console.warn('workspace read failed:', e.message);
  }

  console.log('=== from_email ===');
  console.log(JSON.stringify({
    platform_from: platform['smtp.from_email'],
    platform_name: platform['smtp.from_name'],
    workspace_from: workspace['smtp.from_email'],
    workspace_name: workspace['smtp.from_name'],
    smtp_host: platform['smtp.host'] || workspace['smtp.host'],
    smtp_user_set: !!(platform['smtp.user'] || workspace['smtp.user']),
    smtp_pass_set: !!(platform['smtp.pass'] || workspace['smtp.pass']),
  }, null, 2));

  const apiKey = platform['smtp.user'] || workspace['smtp.user'];
  const apiSecret = platform['smtp.pass'] || workspace['smtp.pass'];
  if (!apiKey || !apiSecret) {
    console.error('No Mailjet API credentials in SMTP user/pass');
    process.exit(2);
  }
  const auth = `${apiKey}:${apiSecret}`;

  console.log('\n=== Mailjet senders ===');
  let senders = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender?Limit=100', { auth });
  console.log(JSON.stringify(senders.body, null, 2));

  const list = (senders.body && senders.body.Data) || [];
  const active = list.filter((s) => String(s.Status).toLowerCase() === 'active');
  const team = list.find((s) => String(s.Email).toLowerCase() === 'team@bitpype.com');
  const gmail = list.find((s) => String(s.Email).toLowerCase() === 'eliayertey@gmail.com');

  // Ensure team@ exists and re-trigger validation
  if (!team) {
    console.log('\n=== create team@bitpype.com sender ===');
    const created = await httpJson('POST', 'https://api.mailjet.com/v3/REST/sender', {
      auth,
      body: { Email: 'team@bitpype.com', Name: 'Bitpype', EmailType: 'transactional' },
    });
    console.log(JSON.stringify(created, null, 2));
    senders = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender?Limit=100', { auth });
  }

  const team2 = ((senders.body && senders.body.Data) || [])
    .find((s) => String(s.Email).toLowerCase() === 'team@bitpype.com');
  if (team2) {
    console.log('\n=== validate team@bitpype.com id=', team2.ID, 'status=', team2.Status, '===');
    const v = await httpJson('POST', `https://api.mailjet.com/v3/REST/sender/${team2.ID}/validate`, { auth });
    console.log(JSON.stringify(v, null, 2));
  }

  // Ensure gmail sender exists + validate (user can click this)
  let gmailId = gmail && gmail.ID;
  if (!gmail) {
    console.log('\n=== create eliayertey@gmail.com sender ===');
    const created = await httpJson('POST', 'https://api.mailjet.com/v3/REST/sender', {
      auth,
      body: { Email: 'eliayertey@gmail.com', Name: 'Bitpype', EmailType: 'transactional' },
    });
    console.log(JSON.stringify(created, null, 2));
    gmailId = created.body && created.body.Data && created.body.Data[0] && created.body.Data[0].ID;
  }
  if (gmailId) {
    console.log('\n=== validate eliayertey@gmail.com id=', gmailId, '===');
    const v = await httpJson('POST', `https://api.mailjet.com/v3/REST/sender/${gmailId}/validate`, { auth });
    console.log(JSON.stringify(v, null, 2));
  }

  // Refresh list
  senders = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender?Limit=100', { auth });
  const finalList = (senders.body && senders.body.Data) || [];
  const finalActive = finalList.filter((s) => String(s.Status).toLowerCase() === 'active');

  console.log('\n=== final senders ===');
  console.log(JSON.stringify(finalList.map((s) => ({
    Email: s.Email, Status: s.Status, ID: s.ID, DNSID: s.DNSID,
  })), null, 2));

  let switchedTo = null;
  if (finalActive.length) {
    const pick = finalActive[0].Email;
    console.log('\n=== Active sender found — switching from_email to', pick, '===');
    await setPlatformFrom(pick);
    try { setWorkspaceFrom(wsPath, pick); } catch (e) {
      console.warn('workspace from update failed:', e.message);
    }
    switchedTo = pick;
  } else {
    console.log('\n=== NO Active senders — cannot switch from_email yet ===');
  }

  const afterPlat = await platformSettings();
  let afterWs = {};
  try { afterWs = workspaceSettings(wsPath); } catch { /* */ }
  console.log('\n=== from_email after ===');
  console.log(JSON.stringify({
    platform_from: afterPlat['smtp.from_email'],
    workspace_from: afterWs['smtp.from_email'],
    switchedTo,
  }, null, 2));

  if (switchedTo) {
    console.log('\n=== send test via platform mailer ===');
    const { sendPlatformMail } = require('../server/mailer');
    const subject = `[Bitpype] FROM-FIXED test ${TS}`;
    try {
      const result = await sendPlatformMail({
        to: testTo,
        subject,
        text: [
          `Test after switching smtp.from_email to ${switchedTo}.`,
          `Time: ${TS}`,
          'If you see this, delivery works.',
        ].join('\n'),
      });
      console.log('SEND_OK', JSON.stringify({ subject, to: testTo, ...result }));
    } catch (e) {
      console.log('SEND_FAIL', e.code || '', e.message);
    }
  } else {
    console.log('\n=== skipping send — no Active Mailjet sender ===');
    console.log(JSON.stringify({
      needsUserAction: true,
      teamValidation: 'API triggered ActivationEmail for team@bitpype.com — but bitpype.com has no MX, so that link may never arrive. Prefer validating eliayertey@gmail.com (ActivationEmail also triggered).',
      gmailAction: 'Check Gmail for Mailjet sender validation email for eliayertey@gmail.com and click Activate. Then re-run this script or tell the agent to switch from_email.',
      uiSteps: [
        'Mailjet → Account Settings → Sender addresses (or Senders & Domains)',
        'Add/validate team@bitpype.com OR eliayertey@gmail.com',
        'Also add domain bitpype.com and confirm SPF/DKIM (SPF+DKIM TXT already exist in public DNS)',
        'After Active, set smtp.from_email to that address (or keep team@ once validated)',
      ],
    }, null, 2));
  }
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
