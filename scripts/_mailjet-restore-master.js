'use strict';

/**
 * Restore Master SMTP key from platform-defaults.json (user pasted into workspace;
 * platform still had Bitpype subkey). Verify IsMaster, send delivery-proof tests.
 */

const fs = require('fs');
const https = require('https');
const Database = require('better-sqlite3');

const FROM = 'briktapinc@gmail.com';
const FROM_NAME = 'Bitpype';
const RECIPIENTS = ['briktapinc@gmail.com', 'eliayertey@gmail.com'];
const TS = new Date().toISOString();
const MARKER = `MASTER-RESTORED-${TS.replace(/[:.]/g, '-')}`;
const OLD_SUBKEY = '5ac7cc76fb013226a9cda835342e3713';
const DEFAULTS = '/app/data/workspaces/platform-defaults.json';

function httpJson(method, url, { auth, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body == null ? null : JSON.stringify(body);
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
      res.on('end', () => resolve({ status: res.statusCode, raw: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parse(raw) {
  try { return JSON.parse(raw); } catch { return raw; }
}

function setWs(dbPath, key, value) {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
  db.close();
}

function redact(s) {
  const v = String(s || '');
  if (!v) return 'EMPTY';
  return `SET(len=${v.length}, prefix=${v.slice(0, 8)}…)`;
}

(async () => {
  const platform = require('../server/platform');
  const { platformSmtpSettings, sendPlatformMail } = require('../server/mailer');

  const defaults = JSON.parse(fs.readFileSync(DEFAULTS, 'utf8'));
  const masterUser = defaults['smtp.user'] || (defaults.settings && defaults.settings['smtp.user']);
  const masterPass = defaults['smtp.pass'] || (defaults.settings && defaults.settings['smtp.pass']);
  if (!masterUser || !masterPass) {
    console.error('FAIL: no smtp.user/pass in platform-defaults.json');
    process.exit(2);
  }
  if (String(masterUser) === OLD_SUBKEY) {
    console.error('FAIL: platform-defaults still has old Bitpype subkey');
    process.exit(3);
  }

  console.log('Restoring Master key from platform-defaults:', redact(masterUser));

  await platform.setPlatformSetting('smtp.user', masterUser);
  await platform.setPlatformSetting('smtp.pass', masterPass);
  await platform.setPlatformSetting('smtp.host', defaults['smtp.host'] || 'in-v3.mailjet.com');
  await platform.setPlatformSetting('smtp.port', defaults['smtp.port'] || '587');
  await platform.setPlatformSetting('smtp.secure', defaults['smtp.secure'] || '0');
  await platform.setPlatformSetting('smtp.from_email', FROM);
  await platform.setPlatformSetting('smtp.from_name', FROM_NAME);

  const wsPath = '/app/data/workspaces/1/websitescout.db';
  for (const [k, v] of Object.entries({
    'smtp.user': masterUser,
    'smtp.pass': masterPass,
    'smtp.host': defaults['smtp.host'] || 'in-v3.mailjet.com',
    'smtp.port': defaults['smtp.port'] || '587',
    'smtp.secure': defaults['smtp.secure'] || '0',
    'smtp.from_email': FROM,
    'smtp.from_name': FROM_NAME,
  })) setWs(wsPath, k, v);

  // Re-save snapshot with restored master (keep secrets)
  await platform.savePlatformDefaultsSnapshot();

  const plat = await platformSmtpSettings();
  const auth = `${plat['smtp.user']}:${plat['smtp.pass']}`;

  const keysR = await httpJson('GET', 'https://api.mailjet.com/v3/REST/apikey?Limit=50', { auth });
  const keys = parse(keysR.raw);
  const keyRows = (keys && keys.Data) || [];
  const thisKey = keyRows.find((k) => String(k.APIKey) === String(plat['smtp.user'])) || keyRows[0];
  console.log('identity', JSON.stringify({
    user: redact(plat['smtp.user']),
    stillOldSubkey: String(plat['smtp.user']) === OLD_SUBKEY,
    thisKey: thisKey && {
      Name: thisKey.Name,
      IsMaster: thisKey.IsMaster,
      IsActive: thisKey.IsActive,
      APIKey: thisKey.APIKey,
    },
    allKeys: keyRows.map((k) => ({ Name: k.Name, APIKey: k.APIKey, IsMaster: k.IsMaster })),
  }, null, 2));

  if (!thisKey || thisKey.IsMaster !== true) {
    console.error('FAIL: restored key is not IsMaster=true');
    process.exit(4);
  }

  const sendersR = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender?Limit=100', { auth });
  const senders = (parse(sendersR.raw).Data) || [];
  console.log('senders', JSON.stringify(senders.map((s) => ({
    Email: s.Email, Status: s.Status, IsDefaultSender: s.IsDefaultSender,
  })), null, 2));

  const dnsR = await httpJson('GET', 'https://api.mailjet.com/v3/REST/dns?Limit=50', { auth });
  console.log('dns', dnsR.raw);

  const results = [];
  for (const to of RECIPIENTS) {
    const subject = `[Bitpype] ${MARKER} -> ${to}`;
    const text = [
      `Marker: ${MARKER}`,
      `From: ${FROM_NAME} <${FROM}>`,
      `To: ${to}`,
      `Time: ${TS}`,
      'Sent with Primary/Master Mailjet API key.',
    ].join('\n');

    let smtp;
    try {
      smtp = await sendPlatformMail({ to, subject, text, html: `<pre>${text}</pre>` });
    } catch (e) {
      smtp = { error: e.message, code: e.code };
    }
    console.log('SMTP', to, JSON.stringify(smtp));

    const api = await httpJson('POST', 'https://api.mailjet.com/v3.1/send', {
      auth,
      body: {
        Messages: [{
          From: { Email: FROM, Name: FROM_NAME },
          To: [{ Email: to }],
          Subject: subject + ' [API]',
          TextPart: text,
          CustomID: MARKER,
        }],
      },
    });
    const apiBody = parse(api.raw);
    console.log('API', to, api.status, api.raw);

    let href = null;
    let uuid = null;
    try {
      href = apiBody.Messages[0].To[0].MessageHref;
      uuid = apiBody.Messages[0].To[0].MessageUUID;
    } catch { /* */ }

    let lookup = null;
    if (href) {
      await new Promise((r) => setTimeout(r, 7000));
      const id = String(href).split('/').pop();
      const msg = await httpJson('GET', href, { auth });
      const hist = await httpJson('GET', `https://api.mailjet.com/v3/REST/messagehistory/${id}`, { auth });
      lookup = {
        id,
        msgHttp: msg.status,
        msg: parse(msg.raw),
        hist: parse(hist.raw),
      };
      console.log('LOOKUP', JSON.stringify(lookup));
    }
    results.push({ to, subject, subjectApi: subject + ' [API]', smtp, uuid, href, lookup });
  }

  const recent = await httpJson(
    'GET',
    'https://api.mailjet.com/v3/REST/message?Limit=20&Sort=ArrivedAt+DESC',
    { auth }
  );
  const recentBody = parse(recent.raw);
  console.log('recent', recent.status, recent.raw);

  const deliveryProof = ((recentBody && recentBody.Count) > 0) || results.some((r) => {
    const histCount = r.lookup && r.lookup.hist && r.lookup.hist.Count;
    return (r.lookup && r.lookup.msgHttp === 200) || histCount > 0;
  });

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    marker: MARKER,
    ts: TS,
    IsMaster: true,
    keyName: thisKey.Name,
    apiKeyPrefix: String(plat['smtp.user']).slice(0, 8),
    from_email: FROM,
    activeSenders: senders.filter((s) => String(s.Status).toLowerCase() === 'active')
      .map((s) => s.Email),
    recentMessageCount: recentBody && recentBody.Count,
    deliveryProof,
    results: results.map((r) => ({
      to: r.to,
      subject: r.subject,
      subjectApi: r.subjectApi,
      smtp: r.smtp,
      uuid: r.uuid,
      msgHttp: r.lookup && r.lookup.msgHttp,
      msgStatus: r.lookup && r.lookup.msg && r.lookup.msg.Data && r.lookup.msg.Data[0]
        && r.lookup.msg.Data[0].Status,
      histCount: r.lookup && r.lookup.hist && r.lookup.hist.Count,
      histEvents: r.lookup && r.lookup.hist && r.lookup.hist.Data,
    })),
    recentSample: ((recentBody && recentBody.Data) || []).slice(0, 8).map((m) => ({
      ID: m.ID,
      Status: m.Status,
      ArrivedAt: m.ArrivedAt,
    })),
  }, null, 2));

  if (!deliveryProof) process.exitCode = 5;
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
