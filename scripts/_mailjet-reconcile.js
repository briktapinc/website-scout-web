'use strict';

/**
 * Reconcile UI-Active vs API-Inactive; set from=team@bitpype.com;
 * test team@ and noreply@stickmanautomation.com; dump dns/apikey/acl.
 */

const fs = require('fs');
const https = require('https');
const Database = require('better-sqlite3');

const TS = new Date().toISOString();
const MARKER = `RECONCILE-${TS.replace(/[:.]/g, '-')}`;
const TEST_TO = ['eliayertey@gmail.com', 'briktapinc@gmail.com'];

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
      res.on('end', () => resolve({ status: res.statusCode, raw: data, headers: res.headers }));
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

(async () => {
  const platform = require('../server/platform');
  const { platformSmtpSettings } = require('../server/mailer');
  const { getProvider } = require('../src/email');

  const settings = await platformSmtpSettings();
  const auth = `${settings['smtp.user']}:${settings['smtp.pass']}`;
  const apiKey = settings['smtp.user'];

  console.log('=== marker', MARKER, '===');
  console.log('smtp.user prefix', String(apiKey).slice(0, 8) + '…');

  // 1) Full sender dump
  console.log('\n=== GET /v3/REST/sender FULL RAW ===');
  const senders = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender?Limit=100', { auth });
  console.log('http', senders.status);
  console.log(senders.raw);

  // 2) DNS list + check each
  console.log('\n=== GET /v3/REST/dns ===');
  const dns = await httpJson('GET', 'https://api.mailjet.com/v3/REST/dns?Limit=50', { auth });
  console.log('http', dns.status);
  console.log(dns.raw);
  const dnsBody = parse(dns.raw);
  for (const d of (dnsBody && dnsBody.Data) || []) {
    console.log('\n=== DNS GET', d.ID, d.Domain, '===');
    const one = await httpJson('GET', `https://api.mailjet.com/v3/REST/dns/${d.ID}`, { auth });
    console.log(one.raw);
    console.log('=== DNS CHECK', d.ID, '===');
    const chk = await httpJson('POST', `https://api.mailjet.com/v3/REST/dns/${d.ID}/check`, { auth });
    console.log(chk.status, chk.raw);
  }

  // Also try known domain names from UI
  for (const domain of ['bitpype.com', 'stickmanautomation.com', 'gmail.com']) {
    console.log('\n=== dns filter Domain=', domain, '===');
    const r = await httpJson(
      'GET',
      `https://api.mailjet.com/v3/REST/dns?Domain=${encodeURIComponent(domain)}`,
      { auth }
    );
    console.log(r.status, r.raw);
  }

  // metasender
  console.log('\n=== metasender ===');
  const meta = await httpJson('GET', 'https://api.mailjet.com/v3/REST/metasender?Limit=50', { auth });
  console.log(meta.status, meta.raw);

  // 3) API keys / permissions
  console.log('\n=== apikey list (SecretKey redacted in summary) ===');
  const keys = await httpJson('GET', 'https://api.mailjet.com/v3/REST/apikey?Limit=50', { auth });
  const keysBody = parse(keys.raw);
  console.log('http', keys.status);
  console.log(JSON.stringify({
    Count: keysBody && keysBody.Count,
    keys: ((keysBody && keysBody.Data) || []).map((k) => ({
      ID: k.ID,
      Name: k.Name,
      APIKey: k.APIKey,
      IsActive: k.IsActive,
      IsMaster: k.IsMaster,
      ACL: k.ACL,
      UserID: k.UserID,
      Runlevel: k.Runlevel,
      QuarantineValue: k.QuarantineValue,
      CreatedAt: k.CreatedAt,
      hasSecret: !!k.SecretKey,
    })),
  }, null, 2));

  console.log('\n=== user / myprofile ===');
  for (const path of ['/v3/REST/user', '/v3/REST/myprofile', '/v3/REST/apikeyaccess']) {
    const r = await httpJson('GET', 'https://api.mailjet.com' + path, { auth });
    console.log(path, r.status, r.raw.slice(0, 2000));
  }

  // 4) Set from back to team@bitpype.com
  const FROM_TEAM = 'team@bitpype.com';
  const FROM_STICK = 'noreply@stickmanautomation.com';
  await platform.setPlatformSetting('smtp.from_email', FROM_TEAM);
  await platform.setPlatformSetting('smtp.from_name', 'Bitpype');
  const wsPath = '/app/data/workspaces/1/websitescout.db';
  setWs(wsPath, 'smtp.from_email', FROM_TEAM);
  setWs(wsPath, 'smtp.from_name', 'Bitpype');
  try {
    await platform.savePlatformDefaultsSnapshot();
  } catch (e) {
    console.warn('snapshot failed', e.message);
  }

  const after = await platformSmtpSettings();
  console.log('\n=== from_email set ===');
  console.log(JSON.stringify({
    platform_from: after['smtp.from_email'],
    platform_name: after['smtp.from_name'],
    workspace_from: getWs(wsPath, 'smtp.from_email'),
    workspace_name: getWs(wsPath, 'smtp.from_name'),
  }, null, 2));

  // 5) Send tests via API + SMTP for both From addresses
  const sendResults = [];
  for (const from of [FROM_TEAM, FROM_STICK]) {
    for (const to of TEST_TO) {
      const subject = `[Bitpype] ${MARKER} FROM ${from} -> ${to}`;
      // API send
      const apiSend = await httpJson('POST', 'https://api.mailjet.com/v3.1/send', {
        auth,
        body: {
          Messages: [{
            From: { Email: from, Name: 'Bitpype' },
            To: [{ Email: to }],
            Subject: subject + ' [API]',
            TextPart: `Reconcile test ${MARKER}\nFrom=${from}\nTo=${to}\nPath=API`,
            CustomID: MARKER,
          }],
        },
      });
      const apiBody = parse(apiSend.raw);
      console.log('\nAPI_SEND', from, '->', to, apiSend.status);
      console.log(apiSend.raw);

      let href = null;
      let uuid = null;
      let msgLookup = null;
      let hist = null;
      try {
        href = apiBody.Messages[0].To[0].MessageHref;
        uuid = apiBody.Messages[0].To[0].MessageUUID;
      } catch { /* */ }

      if (href) {
        await new Promise((r) => setTimeout(r, 6000));
        const id = String(href).split('/').pop();
        const msg = await httpJson('GET', href, { auth });
        const h = await httpJson('GET', `https://api.mailjet.com/v3/REST/messagehistory/${id}`, { auth });
        const info = await httpJson('GET', `https://api.mailjet.com/v3/REST/messageinformation/${id}`, { auth });
        msgLookup = { http: msg.status, body: parse(msg.raw) };
        hist = { http: h.status, body: parse(h.raw), infoHttp: info.status, info: parse(info.raw) };
        console.log('LOOKUP', id, JSON.stringify({ msgLookup, hist }));
      }

      // SMTP send (bypass preflight)
      const cfg = { ...after, 'smtp.from_email': from, 'smtp.from_name': 'Bitpype' };
      const provider = getProvider(cfg, null);
      let smtp = null;
      try {
        smtp = await provider.send({
          to,
          subject: subject + ' [SMTP]',
          text: `Reconcile test ${MARKER}\nFrom=${from}\nTo=${to}\nPath=SMTP`,
        });
        console.log('SMTP_OK', from, '->', to, JSON.stringify(smtp));
      } catch (e) {
        smtp = { error: e.message, code: e.code };
        console.log('SMTP_FAIL', from, '->', to, e.message);
      }

      sendResults.push({
        from, to, subject, apiHttp: apiSend.status, apiBody, uuid, href, msgLookup, hist, smtp,
      });
    }
  }

  // Recent messages + stats
  console.log('\n=== recent messages ===');
  const recent = await httpJson(
    'GET',
    'https://api.mailjet.com/v3/REST/message?Limit=20&Sort=ArrivedAt+DESC',
    { auth }
  );
  console.log(recent.status, recent.raw);

  console.log('\n=== statcounters ===');
  const stats = await httpJson(
    'GET',
    'https://api.mailjet.com/v3/REST/statcounters?CounterSource=APIKey&CounterTiming=Message&CounterResolution=Lifetime&Limit=10',
    { auth }
  );
  console.log(stats.status, stats.raw);

  // Re-validate team@ and poll
  const senderList = (parse(senders.raw).Data) || [];
  const team = senderList.find((s) => String(s.Email).toLowerCase() === FROM_TEAM);
  if (team) {
    console.log('\n=== re-validate team@ ===');
    const v = await httpJson('POST', `https://api.mailjet.com/v3/REST/sender/${team.ID}/validate`, { auth });
    console.log(v.status, v.raw);
    await new Promise((r) => setTimeout(r, 2000));
    const g = await httpJson('GET', `https://api.mailjet.com/v3/REST/sender/${team.ID}`, { auth });
    console.log('after validate', g.raw);
  }

  // Try create bitpype.com dns if missing
  console.log('\n=== try POST dns bitpype.com ===');
  const createDns = await httpJson('POST', 'https://api.mailjet.com/v3/REST/dns', {
    auth,
    body: { Domain: 'bitpype.com' },
  });
  console.log(createDns.status, createDns.raw);

  console.log('\n=== SUMMARY ===');
  const recentBody = parse(recent.raw);
  console.log(JSON.stringify({
    marker: MARKER,
    apiKeyName: ((keysBody && keysBody.Data) || []).find((k) => k.APIKey === apiKey),
    senderEmailsApi: senderList.map((s) => ({ Email: s.Email, Status: s.Status, ID: s.ID })),
    dnsDomainsApi: ((dnsBody && dnsBody.Data) || []).map((d) => ({
      Domain: d.Domain, ID: d.ID, SPFStatus: d.SPFStatus, DKIMStatus: d.DKIMStatus,
    })),
    uiExpectedMissingFromApi: [
      'noreply@stickmanautomation.com',
      'stickmanautomation.com domain',
      'bitpype.com domain (if not in dns list)',
    ],
    apiOnlyNotInUi: senderList
      .map((s) => s.Email)
      .filter((e) => !['team@bitpype.com', 'briktapinc@gmail.com', 'noreply@stickmanautomation.com']
        .includes(String(e).toLowerCase())),
    from_email: after['smtp.from_email'],
    recentMessageCount: recentBody && recentBody.Count,
    anyMessageHistory: sendResults.some((r) => r.hist && r.hist.body && r.hist.body.Count > 0),
    anyMsgFound: sendResults.some((r) => r.msgLookup && r.msgLookup.http === 200),
    sendResults: sendResults.map((r) => ({
      from: r.from,
      to: r.to,
      apiHttp: r.apiHttp,
      apiStatus: r.apiBody && r.apiBody.Messages && r.apiBody.Messages[0] && r.apiBody.Messages[0].Status,
      apiErrors: r.apiBody && r.apiBody.Messages && r.apiBody.Messages[0] && r.apiBody.Messages[0].Errors,
      uuid: r.uuid,
      msgHttp: r.msgLookup && r.msgLookup.http,
      histCount: r.hist && r.hist.body && r.hist.body.Count,
      smtpResponse: r.smtp && (r.smtp.response || r.smtp.error),
    })),
  }, null, 2));
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
