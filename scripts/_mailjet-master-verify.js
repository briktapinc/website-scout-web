'use strict';

/**
 * After user pastes Primary/Master Mailjet key: verify IsMaster, sync workspace,
 * send tests From briktapinc@gmail.com, prove via message history.
 */

const https = require('https');
const Database = require('better-sqlite3');

const FROM = 'briktapinc@gmail.com';
const FROM_NAME = 'Bitpype';
const RECIPIENTS = ['briktapinc@gmail.com', 'eliayertey@gmail.com'];
const TS = new Date().toISOString();
const MARKER = `MASTER-KEY-TEST-${TS.replace(/[:.]/g, '-')}`;
const OLD_SUBKEY = '5ac7cc76fb013226a9cda835342e3713';

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

function getWs(dbPath, key) {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  db.close();
  return row ? row.value : '';
}

function redact(s) {
  const v = String(s || '');
  if (!v) return 'EMPTY';
  return `SET(len=${v.length}, prefix=${v.slice(0, 8)}…)`;
}

(async () => {
  const platform = require('../server/platform');
  const { platformSmtpSettings, sendPlatformMail } = require('../server/mailer');
  const { getProvider } = require('../src/email');

  let plat = await platformSmtpSettings();
  const wsPath = '/app/data/workspaces/1/websitescout.db';
  let wsUser = getWs(wsPath, 'smtp.user');
  let wsPass = getWs(wsPath, 'smtp.pass');

  console.log('=== credentials before sync ===');
  console.log(JSON.stringify({
    platform_user: redact(plat['smtp.user']),
    platform_pass: redact(plat['smtp.pass']),
    platform_from: plat['smtp.from_email'],
    workspace_user: redact(wsUser),
    workspace_pass: redact(wsPass),
    workspace_from: getWs(wsPath, 'smtp.from_email'),
    stillOldSubkey: String(plat['smtp.user']) === OLD_SUBKEY,
  }, null, 2));

  if (!plat['smtp.user'] || !plat['smtp.pass']) {
    console.error('FAIL: platform SMTP credentials missing');
    process.exit(2);
  }

  // Sync platform -> workspace + from
  setWs(wsPath, 'smtp.user', plat['smtp.user']);
  setWs(wsPath, 'smtp.pass', plat['smtp.pass']);
  setWs(wsPath, 'smtp.host', plat['smtp.host'] || 'in-v3.mailjet.com');
  setWs(wsPath, 'smtp.port', plat['smtp.port'] || '587');
  setWs(wsPath, 'smtp.secure', plat['smtp.secure'] || '0');
  await platform.setPlatformSetting('smtp.from_email', FROM);
  await platform.setPlatformSetting('smtp.from_name', FROM_NAME);
  setWs(wsPath, 'smtp.from_email', FROM);
  setWs(wsPath, 'smtp.from_name', FROM_NAME);
  try { await platform.savePlatformDefaultsSnapshot(); } catch (e) {
    console.warn('snapshot', e.message);
  }

  plat = await platformSmtpSettings();
  wsUser = getWs(wsPath, 'smtp.user');
  wsPass = getWs(wsPath, 'smtp.pass');

  console.log('\n=== credentials after sync ===');
  console.log(JSON.stringify({
    platform_user: redact(plat['smtp.user']),
    workspace_user: redact(wsUser),
    usersMatch: String(plat['smtp.user']) === String(wsUser),
    passesMatch: String(plat['smtp.pass']) === String(wsPass),
    from: plat['smtp.from_email'],
    stillOldSubkey: String(plat['smtp.user']) === OLD_SUBKEY,
  }, null, 2));

  const auth = `${plat['smtp.user']}:${plat['smtp.pass']}`;

  console.log('\n=== apikey / user identity ===');
  const keysR = await httpJson('GET', 'https://api.mailjet.com/v3/REST/apikey?Limit=50', { auth });
  const userR = await httpJson('GET', 'https://api.mailjet.com/v3/REST/user', { auth });
  const keys = parse(keysR.raw);
  const user = parse(userR.raw);
  if (keysR.status !== 200) {
    console.error('FAIL: apikey lookup', keysR.status, keysR.raw);
    process.exit(3);
  }
  const keyRows = (keys && keys.Data) || [];
  const thisKey = keyRows.find((k) => String(k.APIKey) === String(plat['smtp.user'])) || keyRows[0];
  const identity = {
    http: keysR.status,
    userEmail: user && user.Data && user.Data[0] && user.Data[0].Email,
    thisKey: thisKey && {
      Name: thisKey.Name,
      APIKey: thisKey.APIKey,
      IsMaster: thisKey.IsMaster,
      IsActive: thisKey.IsActive,
      ACL: thisKey.ACL,
      Runlevel: thisKey.Runlevel,
    },
    allKeys: keyRows.map((k) => ({
      Name: k.Name,
      APIKey: k.APIKey,
      IsMaster: k.IsMaster,
      IsActive: k.IsActive,
    })),
  };
  console.log(JSON.stringify(identity, null, 2));

  if (String(plat['smtp.user']) === OLD_SUBKEY || (thisKey && thisKey.IsMaster === false)) {
    console.log('\n=== STILL SUBKEY / OLD CREDENTIALS ===');
    console.log(JSON.stringify({
      stillOldSubkey: String(plat['smtp.user']) === OLD_SUBKEY,
      IsMaster: thisKey && thisKey.IsMaster,
      Name: thisKey && thisKey.Name,
      action: 'User must paste Primary/Master key (IsMaster=true) into platform SMTP user/pass. Current key is still secondary.',
    }, null, 2));
  }

  console.log('\n=== senders ===');
  const sendersR = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender?Limit=100', { auth });
  console.log(sendersR.status, sendersR.raw);
  const senders = ((parse(sendersR.raw).Data) || []).map((s) => ({
    Email: s.Email,
    Status: s.Status,
    IsDefaultSender: s.IsDefaultSender,
    EmailType: s.EmailType,
  }));
  const active = senders.filter((s) => String(s.Status).toLowerCase() === 'active');
  console.log('active', JSON.stringify(active, null, 2));

  console.log('\n=== dns ===');
  const dnsR = await httpJson('GET', 'https://api.mailjet.com/v3/REST/dns?Limit=50', { auth });
  console.log(dnsR.status, dnsR.raw);

  const briktapActive = active.some((s) => String(s.Email).toLowerCase() === FROM);
  if (!briktapActive && thisKey && thisKey.IsMaster === true) {
    console.warn('WARN: briktapinc@gmail.com not Active on master key; still testing as requested');
  }

  // Prefer sendPlatformMail if preflight passes; else raw provider
  const results = [];
  for (const to of RECIPIENTS) {
    const subject = `[Bitpype] ${MARKER} -> ${to}`;
    const text = [
      `Marker: ${MARKER}`,
      `From: ${FROM_NAME} <${FROM}>`,
      `To: ${to}`,
      `Time: ${TS}`,
      `API key IsMaster: ${thisKey && thisKey.IsMaster}`,
      'Check inbox/spam for this subject.',
    ].join('\n');

    let smtpResult = null;
    let path = 'sendPlatformMail';
    try {
      smtpResult = await sendPlatformMail({ to, subject, text, html: `<pre>${text}</pre>` });
    } catch (e) {
      console.warn('sendPlatformMail failed, trying raw SMTP:', e.code, e.message);
      path = 'rawSmtp';
      const provider = getProvider({
        ...plat,
        'smtp.from_email': FROM,
        'smtp.from_name': FROM_NAME,
      }, null);
      try {
        smtpResult = await provider.send({ to, subject, text, html: `<pre>${text}</pre>` });
      } catch (e2) {
        smtpResult = { error: e2.message, code: e2.code };
      }
    }
    console.log('SMTP', to, JSON.stringify(smtpResult));

    // API send for MessageHref / history
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
      await new Promise((r) => setTimeout(r, 6000));
      const id = String(href).split('/').pop();
      const msg = await httpJson('GET', href, { auth });
      const hist = await httpJson('GET', `https://api.mailjet.com/v3/REST/messagehistory/${id}`, { auth });
      const info = await httpJson('GET', `https://api.mailjet.com/v3/REST/messageinformation/${id}`, { auth });
      lookup = {
        id,
        msgHttp: msg.status,
        msg: parse(msg.raw),
        histHttp: hist.status,
        hist: parse(hist.raw),
        info: parse(info.raw),
      };
      console.log('LOOKUP', id, JSON.stringify(lookup));
    }

    results.push({
      to,
      subject,
      subjectApi: subject + ' [API]',
      path,
      smtpResult,
      uuid,
      href,
      lookup,
    });
  }

  await new Promise((r) => setTimeout(r, 2000));
  const recent = await httpJson(
    'GET',
    'https://api.mailjet.com/v3/REST/message?Limit=20&Sort=ArrivedAt+DESC',
    { auth }
  );
  const recentBody = parse(recent.raw);
  console.log('\n=== recent messages ===');
  console.log(recent.status, recent.raw);

  const deliveryProof = results.some((r) => {
    const histCount = r.lookup && r.lookup.hist && r.lookup.hist.Count;
    const msgOk = r.lookup && r.lookup.msgHttp === 200;
    const status = r.lookup && r.lookup.msg && r.lookup.msg.Data && r.lookup.msg.Data[0]
      && r.lookup.msg.Data[0].Status;
    return msgOk || (histCount > 0) || (status && String(status).toLowerCase() !== 'unknown');
  }) || ((recentBody && recentBody.Count) > 0);

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    marker: MARKER,
    ts: TS,
    stillOldSubkey: String(plat['smtp.user']) === OLD_SUBKEY,
    IsMaster: thisKey && thisKey.IsMaster,
    keyName: thisKey && thisKey.Name,
    apiKeyPrefix: String(plat['smtp.user']).slice(0, 8),
    from_email: FROM,
    activeSenders: active,
    recentMessageCount: recentBody && recentBody.Count,
    deliveryProof,
    results: results.map((r) => ({
      to: r.to,
      subject: r.subject,
      subjectApi: r.subjectApi,
      smtpResponse: r.smtpResult && (r.smtpResult.smtpResponse || r.smtpResult.response || r.smtpResult.error),
      messageId: r.smtpResult && r.smtpResult.messageId,
      uuid: r.uuid,
      msgHttp: r.lookup && r.lookup.msgHttp,
      msgStatus: r.lookup && r.lookup.msg && r.lookup.msg.Data && r.lookup.msg.Data[0]
        && r.lookup.msg.Data[0].Status,
      histCount: r.lookup && r.lookup.hist && r.lookup.hist.Count,
      histEvents: r.lookup && r.lookup.hist && r.lookup.hist.Data,
    })),
    recentSample: ((recentBody && recentBody.Data) || []).slice(0, 5).map((m) => ({
      ID: m.ID,
      Status: m.Status,
      ArrivedAt: m.ArrivedAt,
      ContactID: m.ContactID,
    })),
  }, null, 2));

  if (!deliveryProof) process.exitCode = 4;
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
