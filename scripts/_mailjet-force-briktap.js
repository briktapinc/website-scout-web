'use strict';

/**
 * Re-check Mailjet senders carefully, set from to briktapinc@gmail.com,
 * send tests even if Status string is still Inactive (UI may be ahead).
 */

const fs = require('fs');
const https = require('https');
const Database = require('better-sqlite3');

const FROM = 'briktapinc@gmail.com';
const FROM_NAME = 'Bitpype';
const RECIPIENTS = ['eliayertey@gmail.com', 'briktapinc@gmail.com'];
const TS = new Date().toISOString();
const MARKER = `BRIKTAP-FROM-TEST-${TS.replace(/[:.]/g, '-')}`;

function httpJson(method, url, { auth, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
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
        ...(headers || {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseBody(raw) {
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

function getWs(dbPath, key) {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  db.close();
  return row ? row.value : '';
}

function patchDefaults(email) {
  const file = '/app/data/platform-defaults.json';
  if (!fs.existsSync(file)) return { file, ok: false, reason: 'missing' };
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { file, ok: false, reason: e.message };
  }
  if (obj.settings && typeof obj.settings === 'object') {
    obj.settings['smtp.from_email'] = email;
    obj.settings['smtp.from_name'] = FROM_NAME;
  } else {
    obj['smtp.from_email'] = email;
    obj['smtp.from_name'] = FROM_NAME;
  }
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  return { file, ok: true };
}

function isActiveStatus(status) {
  if (status === true || status === 1) return true;
  const s = String(status == null ? '' : status).trim().toLowerCase();
  return s === 'active' || s === 'validated' || s === 'enabled' || s === 'ok';
}

(async () => {
  const platform = require('../server/platform');
  const { platformSmtpSettings } = require('../server/mailer');
  const { getProvider } = require('../src/email');

  const settings = await platformSmtpSettings();
  const apiKey = settings['smtp.user'];
  const apiSecret = settings['smtp.pass'];
  const auth = `${apiKey}:${apiSecret}`;

  console.log('=== API key identity (redacted) ===');
  const apikey = await httpJson('GET', 'https://api.mailjet.com/v3/REST/apikey', { auth });
  const user = await httpJson('GET', 'https://api.mailjet.com/v3/REST/user', { auth });
  const apikeyBody = parseBody(apikey.raw);
  const userBody = parseBody(user.raw);
  const keyRow = apikeyBody && apikeyBody.Data && apikeyBody.Data[0];
  const userRow = userBody && userBody.Data && userBody.Data[0];
  console.log(JSON.stringify({
    apikey_http: apikey.status,
    APIKey: keyRow && keyRow.APIKey,
    Name: keyRow && keyRow.Name,
    IsActive: keyRow && keyRow.IsActive,
    IsMaster: keyRow && keyRow.IsMaster,
    UserID: keyRow && keyRow.UserID,
    user_http: user.status,
    userEmail: userRow && userRow.Email,
    username: userRow && userRow.Username,
  }, null, 2));

  console.log('\n=== GET /v3/REST/sender raw ===');
  const senders = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender?Limit=100', { auth });
  console.log('http', senders.status);
  console.log('raw', senders.raw);

  const sendersBody = parseBody(senders.raw);
  const rows = (sendersBody && sendersBody.Data) || [];
  console.log('\n=== parsed Status dump ===');
  for (const r of rows) {
    console.log(JSON.stringify({
      Email: r.Email,
      Status: r.Status,
      Status_typeof: typeof r.Status,
      Status_JSON: JSON.stringify(r.Status),
      IsDefaultSender: r.IsDefaultSender,
      IsDefaultSender_typeof: typeof r.IsDefaultSender,
      ID: r.ID,
      DNSID: r.DNSID,
      EmailType: r.EmailType,
      Name: r.Name,
      usable_by_isActiveStatus: isActiveStatus(r.Status),
    }));
  }

  // Per-id GET
  console.log('\n=== per-sender GET ===');
  for (const r of rows) {
    const g = await httpJson('GET', `https://api.mailjet.com/v3/REST/sender/${r.ID}`, { auth });
    console.log(r.ID, g.status, g.raw);
  }

  // Alternate paths (may 404)
  for (const path of [
    '/v3/sender',
    '/v3.1/sender',
    '/v3/REST/sender?Status=Active',
    '/v3/REST/sender?Active=true',
  ]) {
    const r = await httpJson('GET', 'https://api.mailjet.com' + path, { auth });
    console.log('\n=== alternate', path, 'http', r.status, '===');
    console.log(r.raw.slice(0, 1500));
  }

  const activeish = rows.filter((r) => isActiveStatus(r.Status));
  const briktap = rows.find((r) => String(r.Email).toLowerCase() === FROM);
  console.log('\n=== decision ===');
  console.log(JSON.stringify({
    activeish: activeish.map((r) => r.Email),
    briktapStatus: briktap && briktap.Status,
    forceFrom: FROM,
    reason: activeish.length
      ? 'API reports Active-like status'
      : 'API still Inactive; proceeding per UI insistence with briktapinc@gmail.com',
  }, null, 2));

  // Set from regardless (user insistence + UI Active)
  await platform.setPlatformSetting('smtp.from_email', FROM);
  await platform.setPlatformSetting('smtp.from_name', FROM_NAME);
  const wsPath = '/app/data/workspaces/1/websitescout.db';
  setWs(wsPath, 'smtp.from_email', FROM);
  setWs(wsPath, 'smtp.from_name', FROM_NAME);
  const defaults = patchDefaults(FROM);

  const afterPlat = await platformSmtpSettings();
  console.log('\n=== from_email set ===');
  console.log(JSON.stringify({
    platform_from: afterPlat['smtp.from_email'],
    platform_name: afterPlat['smtp.from_name'],
    workspace_from: getWs(wsPath, 'smtp.from_email'),
    workspace_name: getWs(wsPath, 'smtp.from_name'),
    platform_defaults: defaults,
  }, null, 2));

  // Send via raw provider (bypass Mailjet Active preflight if Status still Inactive)
  const cfg = {
    ...afterPlat,
    'smtp.from_email': FROM,
    'smtp.from_name': FROM_NAME,
  };
  const provider = getProvider(cfg, null);
  const smtpResults = [];
  for (const to of RECIPIENTS) {
    const subject = `[Bitpype] ${MARKER} -> ${to}`;
    const text = [
      `Marker: ${MARKER}`,
      `From: ${FROM_NAME} <${FROM}>`,
      `To: ${to}`,
      `Time: ${TS}`,
      `API Status for From: ${briktap ? JSON.stringify(briktap.Status) : 'missing'}`,
      'UI reported Active; testing delivery.',
    ].join('\n');
    try {
      const r = await provider.send({ to, subject, text, html: `<pre>${text}</pre>` });
      smtpResults.push({ to, subject, ok: true, ...r });
      console.log('SMTP_OK', JSON.stringify({ to, subject, response: r.response, messageId: r.messageId }));
    } catch (e) {
      smtpResults.push({ to, subject, ok: false, error: e.message, code: e.code });
      console.log('SMTP_FAIL', to, e.message);
    }
  }

  // Mailjet API send for MessageHref (string ids)
  console.log('\n=== Mailjet API send + status ===');
  const apiResults = [];
  for (const to of RECIPIENTS) {
    const subject = `[Bitpype] ${MARKER} MJ-API -> ${to}`;
    const send = await httpJson('POST', 'https://api.mailjet.com/v3.1/send', {
      auth,
      body: {
        Messages: [{
          From: { Email: FROM, Name: FROM_NAME },
          To: [{ Email: to }],
          Subject: subject,
          TextPart: `Marker ${MARKER} API path to ${to}`,
          CustomID: MARKER,
        }],
      },
    });
    const body = parseBody(send.raw);
    console.log('apiSend', to, send.status, send.raw);
    const href = body && body.Messages && body.Messages[0] && body.Messages[0].To
      && body.Messages[0].To[0] && body.Messages[0].To[0].MessageHref;
    const uuid = body && body.Messages && body.Messages[0] && body.Messages[0].To
      && body.Messages[0].To[0] && body.Messages[0].To[0].MessageUUID;
    let msgStatus = null;
    let hist = null;
    if (href) {
      await new Promise((r) => setTimeout(r, 5000));
      const id = String(href).split('/').pop();
      const msg = await httpJson('GET', href, { auth });
      const h = await httpJson('GET', `https://api.mailjet.com/v3/REST/messagehistory/${id}`, { auth });
      const info = await httpJson('GET', `https://api.mailjet.com/v3/REST/messageinformation/${id}`, { auth });
      msgStatus = { http: msg.status, body: parseBody(msg.raw) };
      hist = { http: h.status, body: parseBody(h.raw), info: parseBody(info.raw) };
      console.log('msgStatus', id, JSON.stringify({ msgStatus, hist }, null, 2));
    }
    apiResults.push({ to, subject, http: send.status, body, uuid, href, msgStatus, hist });
  }

  // Recent messages
  const recent = await httpJson(
    'GET',
    'https://api.mailjet.com/v3/REST/message?Limit=10&Sort=ArrivedAt+DESC',
    { auth }
  );
  console.log('\n=== recent messages ===');
  console.log(recent.status, recent.raw);

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    marker: MARKER,
    from_email: FROM,
    from_name: FROM_NAME,
    rawSenderStatuses: rows.map((r) => ({
      Email: r.Email,
      Status: r.Status,
      Status_typeof: typeof r.Status,
      IsDefaultSender: r.IsDefaultSender,
    })),
    smtpResults,
    apiResults: apiResults.map((r) => ({
      to: r.to,
      subject: r.subject,
      http: r.http,
      uuid: r.uuid,
      href: r.href,
      apiMessageStatus: r.body && r.body.Messages && r.body.Messages[0] && r.body.Messages[0].Status,
      msgLookup: r.msgStatus,
      history: r.hist,
    })),
  }, null, 2));
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
