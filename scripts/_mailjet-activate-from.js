'use strict';

/**
 * After user validates a Mailjet sender: pick Active from, set platform+workspace,
 * send distinctive test, poll Mailjet message status.
 *
 * Usage: node scripts/_mailjet-activate-from.js [testTo]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const Database = require('better-sqlite3');

const testTo = process.argv[2] || 'eliayertey@gmail.com';
const TS = new Date().toISOString();
const MARKER = `ACTIVE-SENDER-TEST-${TS.replace(/[:.]/g, '-')}`;

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
    if (payload) req.write(payload);
    req.end();
  });
}

function setWorkspaceKey(dbPath, key, value) {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
  db.close();
}

function getWorkspaceKey(dbPath, key) {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  db.close();
  return row ? row.value : '';
}

function patchPlatformDefaults(email) {
  const candidates = [
    '/app/data/platform-defaults.json',
    path.join(__dirname, '..', 'data', 'platform-defaults.json'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let obj;
    try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!obj || typeof obj !== 'object') obj = {};
    // Support both flat and nested shapes used historically
    if (obj.settings && typeof obj.settings === 'object') {
      obj.settings['smtp.from_email'] = email;
      obj.settings['smtp.from_name'] = obj.settings['smtp.from_name'] || 'Bitpype';
    } else {
      obj['smtp.from_email'] = email;
      if (!obj['smtp.from_name']) obj['smtp.from_name'] = 'Bitpype';
    }
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
    return file;
  }
  return null;
}

(async () => {
  const platform = require('../server/platform');
  const { platformSmtpSettings, sendPlatformMail } = require('../server/mailer');

  const settings = await platformSmtpSettings();
  const apiKey = settings['smtp.user'];
  const apiSecret = settings['smtp.pass'];
  if (!apiKey || !apiSecret) {
    console.error('FAIL: missing SMTP/Mailjet credentials');
    process.exit(2);
  }
  const auth = `${apiKey}:${apiSecret}`;

  console.log('=== Mailjet senders ===');
  const sendersResp = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender?Limit=100', { auth });
  const list = (sendersResp.body && sendersResp.body.Data) || [];
  console.log(JSON.stringify(list.map((s) => ({
    Email: s.Email, Status: s.Status, ID: s.ID,
  })), null, 2));

  const active = list.filter((s) => String(s.Status).toLowerCase() === 'active');
  if (!active.length) {
    console.error('FAIL: no Active senders yet');
    process.exit(3);
  }

  const teamActive = active.find((s) => String(s.Email).toLowerCase() === 'team@bitpype.com');
  const gmailActive = active.find((s) => String(s.Email).toLowerCase() === 'eliayertey@gmail.com');
  const pick = (teamActive || gmailActive || active[0]).Email;
  const preferred = teamActive ? 'team@bitpype.com' : 'temporary-gmail';

  console.log('\n=== choosing from_email ===');
  console.log(JSON.stringify({ pick, preferred, active: active.map((s) => s.Email) }, null, 2));

  await platform.setPlatformSetting('smtp.from_email', pick);
  await platform.setPlatformSetting('smtp.from_name', 'Bitpype');

  const wsPath = '/app/data/workspaces/1/websitescout.db';
  setWorkspaceKey(wsPath, 'smtp.from_email', pick);
  setWorkspaceKey(wsPath, 'smtp.from_name', 'Bitpype');

  const defaultsFile = patchPlatformDefaults(pick);

  const afterPlat = await platformSmtpSettings();
  const afterWsFrom = getWorkspaceKey(wsPath, 'smtp.from_email');
  const afterWsName = getWorkspaceKey(wsPath, 'smtp.from_name');

  console.log('\n=== from_email set ===');
  console.log(JSON.stringify({
    platform_from: afterPlat['smtp.from_email'],
    platform_name: afterPlat['smtp.from_name'],
    workspace_from: afterWsFrom,
    workspace_name: afterWsName,
    platform_defaults_file: defaultsFile,
    note: teamActive
      ? 'Using team@bitpype.com (Active)'
      : 'Using temporary Active sender; authenticate bitpype.com / validate team@ later',
  }, null, 2));

  const subject = `[Bitpype] ${MARKER}`;
  const text = [
    `Marker: ${MARKER}`,
    `From: Bitpype <${pick}>`,
    `To: ${testTo}`,
    `Time: ${TS}`,
    'If you see this in inbox, delivery works with the Active Mailjet sender.',
  ].join('\n');

  console.log('\n=== send test ===');
  let sendResult;
  try {
    sendResult = await sendPlatformMail({ to: testTo, subject, text, html: `<pre>${text}</pre>` });
    console.log('SEND_OK', JSON.stringify({ subject, to: testTo, from: pick, ...sendResult }));
  } catch (e) {
    console.log('SEND_FAIL', e.code || '', e.message);
    process.exit(1);
  }

  // Also send via Mailjet API for MessageHref status
  console.log('\n=== Mailjet API send + status ===');
  const apiSend = await httpJson('POST', 'https://api.mailjet.com/v3.1/send', {
    auth,
    body: {
      Messages: [{
        From: { Email: pick, Name: 'Bitpype' },
        To: [{ Email: testTo }],
        Subject: `[Bitpype] ${MARKER} MJ-API`,
        TextPart: text,
        CustomID: MARKER,
      }],
    },
  });
  console.log('apiSend', JSON.stringify(apiSend.body, null, 2));

  const href = apiSend.body && apiSend.body.Messages && apiSend.body.Messages[0]
    && apiSend.body.Messages[0].To && apiSend.body.Messages[0].To[0]
    && apiSend.body.Messages[0].To[0].MessageHref;
  const uuid = apiSend.body && apiSend.body.Messages && apiSend.body.Messages[0]
    && apiSend.body.Messages[0].To && apiSend.body.Messages[0].To[0]
    && apiSend.body.Messages[0].To[0].MessageUUID;

  if (href) {
    await new Promise((r) => setTimeout(r, 4000));
    const id = String(href).split('/').pop();
    const msg = await httpJson('GET', href, { auth });
    const hist = await httpJson('GET', `https://api.mailjet.com/v3/REST/messagehistory/${id}`, { auth });
    const info = await httpJson('GET', `https://api.mailjet.com/v3/REST/messageinformation/${id}`, { auth });
    console.log('messageStatus', JSON.stringify({
      MessageUUID: uuid,
      MessageHref: href,
      msg: msg.body,
      hist: hist.body,
      info: info.body,
    }, null, 2));
  }

  // Recent messages for recipient
  const recent = await httpJson(
    'GET',
    `https://api.mailjet.com/v3/REST/message?ContactAlt=${encodeURIComponent(testTo)}&Limit=5&Sort=ArrivedAt+DESC`,
    { auth }
  );
  console.log('recentForRecipient', JSON.stringify(recent.body, null, 2));

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    from_email: pick,
    from_name: 'Bitpype',
    preferred,
    testSubject: subject,
    testTo,
    smtpResponse: sendResult && sendResult.smtpResponse,
    messageId: sendResult && sendResult.messageId,
    apiMessageUUID: uuid,
  }, null, 2));
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
