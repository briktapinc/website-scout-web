'use strict';

const https = require('https');
const fs = require('fs');
const Database = require('better-sqlite3');

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

function setWs(dbPath, key, value) {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
  db.close();
}

function patchDefaults(email) {
  const file = '/app/data/platform-defaults.json';
  if (!fs.existsSync(file)) return null;
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (obj.settings && typeof obj.settings === 'object') {
    obj.settings['smtp.from_email'] = email;
    obj.settings['smtp.from_name'] = 'Bitpype';
  } else {
    obj['smtp.from_email'] = email;
    obj['smtp.from_name'] = 'Bitpype';
  }
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  return file;
}

(async () => {
  const platform = require('../server/platform');
  const { platformSmtpSettings, sendPlatformMail } = require('../server/mailer');
  const s = await platformSmtpSettings();
  const auth = `${s['smtp.user']}:${s['smtp.pass']}`;

  // Ensure account-owner Gmail is a sender too
  const owner = 'briktapinc@gmail.com';
  console.log('=== ensure sender', owner, '===');
  const existing = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender?Limit=100', { auth });
  const list = (existing.body && existing.body.Data) || [];
  let ownerRow = list.find((x) => String(x.Email).toLowerCase() === owner);
  if (!ownerRow) {
    const created = await httpJson('POST', 'https://api.mailjet.com/v3/REST/sender', {
      auth,
      body: { Email: owner, Name: 'Bitpype', EmailType: 'transactional' },
    });
    console.log('create', JSON.stringify(created.body, null, 2));
    ownerRow = created.body && created.body.Data && created.body.Data[0];
  } else {
    console.log('exists', ownerRow.Status, ownerRow.ID);
  }
  if (ownerRow && ownerRow.ID) {
    const v = await httpJson('POST', `https://api.mailjet.com/v3/REST/sender/${ownerRow.ID}/validate`, { auth });
    console.log('validate', JSON.stringify(v.body, null, 2));
  }

  const refreshed = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender?Limit=100', { auth });
  const senders = (refreshed.body && refreshed.body.Data) || [];
  console.log('=== senders ===');
  console.log(JSON.stringify(senders.map((x) => ({ Email: x.Email, Status: x.Status, ID: x.ID })), null, 2));

  const active = senders.filter((x) => String(x.Status).toLowerCase() === 'active');
  console.log('activeCount', active.length);

  // Poll earlier probe message hrefs
  for (const href of [
    'https://api.mailjet.com/v3/REST/message/1152921545514104822',
    'https://api.mailjet.com/v3/REST/message/576460793235803567',
  ]) {
    const id = href.split('/').pop();
    const msg = await httpJson('GET', href, { auth });
    const hist = await httpJson('GET', `https://api.mailjet.com/v3/REST/messagehistory/${id}`, { auth });
    console.log('msg', id, JSON.stringify({ status: msg.status, body: msg.body, hist: hist.body }, null, 2));
  }

  if (!active.length) {
    console.log('NO_ACTIVE — refusing to set from_email / send via preflight path');
    // Bypass check: raw SMTP once to capture Mailjet SMTP wording for each from
    const { getProvider } = require('../src/email');
    for (const from of ['eliayertey@gmail.com', 'team@bitpype.com', owner]) {
      const cfg = { ...s, 'smtp.from_email': from, 'smtp.from_name': 'Bitpype' };
      const provider = getProvider(cfg, null);
      const subject = `[Bitpype] RAW-SMTP ${from} ${new Date().toISOString()}`;
      try {
        const r = await provider.send({
          to: 'eliayertey@gmail.com',
          subject,
          text: `Raw SMTP probe from ${from}`,
        });
        console.log('RAW_OK', from, JSON.stringify(r));
      } catch (e) {
        console.log('RAW_FAIL', from, e.message);
      }
    }
    process.exit(3);
  }

  const team = active.find((x) => String(x.Email).toLowerCase() === 'team@bitpype.com');
  const pick = (team || active[0]).Email;
  console.log('PICK', pick);

  await platform.setPlatformSetting('smtp.from_email', pick);
  await platform.setPlatformSetting('smtp.from_name', 'Bitpype');
  setWs('/app/data/workspaces/1/websitescout.db', 'smtp.from_email', pick);
  setWs('/app/data/workspaces/1/websitescout.db', 'smtp.from_name', 'Bitpype');
  const defaults = patchDefaults(pick);

  const TS = new Date().toISOString();
  const subject = `[Bitpype] ACTIVE-SENDER-TEST-${TS}`;
  const result = await sendPlatformMail({
    to: 'eliayertey@gmail.com',
    subject,
    text: `Delivery test from Active sender ${pick} at ${TS}`,
  });
  console.log('SEND', JSON.stringify({ pick, defaults, subject, result }, null, 2));
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
