'use strict';

/**
 * Prefer From briktapinc@gmail.com; also probe noreply@stickmanautomation.com.
 * Tests TO briktapinc@gmail.com + eliayertey@gmail.com only.
 * Dig into subkey vs UI sender mismatch.
 */

const https = require('https');
const Database = require('better-sqlite3');

const FROM_PRIMARY = 'briktapinc@gmail.com';
const FROM_ALT = 'noreply@stickmanautomation.com';
const FROM_NAME = 'Bitpype';
const RECIPIENTS = ['briktapinc@gmail.com', 'eliayertey@gmail.com'];
const TS = new Date().toISOString();
const MARKER = `DELIVER-${TS.replace(/[:.]/g, '-')}`;

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

async function sendApi(auth, from, to, subject, text) {
  return httpJson('POST', 'https://api.mailjet.com/v3.1/send', {
    auth,
    body: {
      Messages: [{
        From: { Email: from, Name: FROM_NAME },
        To: [{ Email: to }],
        Subject: subject,
        TextPart: text,
        CustomID: MARKER,
      }],
    },
  });
}

async function lookupMessage(auth, href) {
  if (!href) return null;
  const id = String(href).split('/').pop();
  await new Promise((r) => setTimeout(r, 5000));
  const msg = await httpJson('GET', href, { auth });
  const hist = await httpJson('GET', `https://api.mailjet.com/v3/REST/messagehistory/${id}`, { auth });
  const info = await httpJson('GET', `https://api.mailjet.com/v3/REST/messageinformation/${id}`, { auth });
  return {
    id,
    msgHttp: msg.status,
    msg: parse(msg.raw),
    histHttp: hist.status,
    hist: parse(hist.raw),
    infoHttp: info.status,
    info: parse(info.raw),
  };
}

(async () => {
  const platform = require('../server/platform');
  const { platformSmtpSettings } = require('../server/mailer');
  const { getProvider } = require('../src/email');

  const settings = await platformSmtpSettings();
  const auth = `${settings['smtp.user']}:${settings['smtp.pass']}`;

  console.log('MARKER', MARKER);
  console.log('apiKey', String(settings['smtp.user']).slice(0, 8) + '…');

  // Identity + keys
  const keysR = await httpJson('GET', 'https://api.mailjet.com/v3/REST/apikey?Limit=20', { auth });
  const userR = await httpJson('GET', 'https://api.mailjet.com/v3/REST/user', { auth });
  const keys = parse(keysR.raw);
  const user = parse(userR.raw);
  console.log('\n=== account / keys (no secrets) ===');
  console.log(JSON.stringify({
    user: user && user.Data && user.Data[0] && {
      Email: user.Data[0].Email,
      ID: user.Data[0].ID,
      Username: user.Data[0].Username,
    },
    keys: ((keys && keys.Data) || []).map((k) => ({
      ID: k.ID,
      Name: k.Name,
      APIKey: k.APIKey,
      IsMaster: k.IsMaster,
      IsActive: k.IsActive,
      ACL: k.ACL,
      Runlevel: k.Runlevel,
      QuarantineValue: k.QuarantineValue,
    })),
  }, null, 2));

  // Full senders + dns
  const sendersR = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender?Limit=100', { auth });
  const dnsR = await httpJson('GET', 'https://api.mailjet.com/v3/REST/dns?Limit=50', { auth });
  const senders = parse(sendersR.raw);
  const dns = parse(dnsR.raw);
  console.log('\n=== API senders FULL ===');
  console.log(sendersR.raw);
  console.log('\n=== API dns FULL ===');
  console.log(dnsR.raw);

  const uiSenders = [
    'team@bitpype.com',
    'noreply@stickmanautomation.com',
    'briktapinc@gmail.com',
  ];
  const apiEmails = ((senders && senders.Data) || []).map((s) => String(s.Email).toLowerCase());
  console.log('\n=== UI vs API reconciliation ===');
  console.log(JSON.stringify({
    inUiNotInApi: uiSenders.filter((e) => !apiEmails.includes(e)),
    inApiNotInUiScreenshot: apiEmails.filter(
      (e) => !uiSenders.includes(e) && e !== 'eliayertey@gmail.com'
    ),
    eliayerteyInApi: apiEmails.includes('eliayertey@gmail.com'),
    stickmanInApi: apiEmails.includes('noreply@stickmanautomation.com'),
    diagnosis:
      'Bitpype subkey sees a DIFFERENT sender set than the Mailjet UI (master account view). '
      + 'UI has Active stickman noreply + bitpype.com domain; this key has orphan Inactive senders '
      + '(incl. eliayertey@ we created) and only gmail.com DNS stub. Subkey is not synced to master senders.',
  }, null, 2));

  // DNS checks
  for (const d of (dns && dns.Data) || []) {
    const chk = await httpJson('POST', `https://api.mailjet.com/v3/REST/dns/${d.ID}/check`, { auth });
    console.log('dnsCheck', d.Domain, d.ID, chk.status, chk.raw.slice(0, 800));
  }

  // Choose From: prefer briktapinc; if stickman API send gets real message history, prefer stickman for reliability note
  let chosenFrom = FROM_PRIMARY;

  // Set platform/workspace to briktapinc first
  await platform.setPlatformSetting('smtp.from_email', chosenFrom);
  await platform.setPlatformSetting('smtp.from_name', FROM_NAME);
  const wsPath = '/app/data/workspaces/1/websitescout.db';
  setWs(wsPath, 'smtp.from_email', chosenFrom);
  setWs(wsPath, 'smtp.from_name', FROM_NAME);
  try { await platform.savePlatformDefaultsSnapshot(); } catch (e) {
    console.warn('snapshot', e.message);
  }

  const results = [];
  for (const from of [FROM_PRIMARY, FROM_ALT]) {
    for (const to of RECIPIENTS) {
      const subject = `[Bitpype] ${MARKER} FROM ${from} -> ${to}`;
      const text = [
        `Marker: ${MARKER}`,
        `From: ${FROM_NAME} <${from}>`,
        `To: ${to}`,
        `Time: ${TS}`,
        'Delivery proof test — reply or check inbox/spam.',
      ].join('\n');

      const api = await sendApi(auth, from, to, subject + ' [API]', text);
      const apiBody = parse(api.raw);
      console.log('\nAPI', from, '->', to, api.status, api.raw);

      let href = null;
      let uuid = null;
      let errors = null;
      try {
        href = apiBody.Messages[0].To[0].MessageHref;
        uuid = apiBody.Messages[0].To[0].MessageUUID;
        errors = apiBody.Messages[0].Errors || null;
      } catch { /* */ }
      // Also capture top-level Errors
      if (!errors && apiBody && apiBody.Messages && apiBody.Messages[0] && apiBody.Messages[0].Status !== 'success') {
        errors = apiBody.Messages[0];
      }

      const lookup = await lookupMessage(auth, href);

      // SMTP
      const after = await platformSmtpSettings();
      const cfg = { ...after, 'smtp.from_email': from, 'smtp.from_name': FROM_NAME };
      const provider = getProvider(cfg, null);
      let smtp;
      try {
        smtp = await provider.send({
          to,
          subject: subject + ' [SMTP]',
          text,
        });
        console.log('SMTP_OK', JSON.stringify({ from, to, response: smtp.response, messageId: smtp.messageId }));
      } catch (e) {
        smtp = { error: e.message };
        console.log('SMTP_FAIL', from, to, e.message);
      }

      const histCount = lookup && lookup.hist && lookup.hist.Count;
      const deliveredEvidence = !!(lookup && lookup.msgHttp === 200)
        || (typeof histCount === 'number' && histCount > 0);

      results.push({
        from,
        to,
        subject,
        apiHttp: api.status,
        apiStatus: apiBody && apiBody.Messages && apiBody.Messages[0] && apiBody.Messages[0].Status,
        errors,
        uuid,
        href,
        lookup,
        smtp,
        deliveredEvidence,
      });
    }
  }

  // If stickman got message history and briktapinc didn't, switch from to stickman
  const stickOk = results.some((r) => r.from === FROM_ALT && r.deliveredEvidence);
  const brikOk = results.some((r) => r.from === FROM_PRIMARY && r.deliveredEvidence);
  if (stickOk && !brikOk) {
    chosenFrom = FROM_ALT;
    await platform.setPlatformSetting('smtp.from_email', chosenFrom);
    setWs(wsPath, 'smtp.from_email', chosenFrom);
    try { await platform.savePlatformDefaultsSnapshot(); } catch { /* */ }
    console.log('SWITCHED from_email to stickman noreply due to better delivery evidence');
  }

  const recent = await httpJson(
    'GET',
    'https://api.mailjet.com/v3/REST/message?Limit=20&Sort=ArrivedAt+DESC',
    { auth }
  );
  console.log('\n=== recent messages ===');
  console.log(recent.status, recent.raw);

  const finalFrom = await platform.getPlatformSetting('smtp.from_email', '');
  const recentBody = parse(recent.raw);

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    marker: MARKER,
    from_email_chosen: finalFrom,
    from_name: FROM_NAME,
    workspace_from: getWs(wsPath, 'smtp.from_email'),
    recentMessageCount: recentBody && recentBody.Count,
    anyDeliveryEvidence: results.some((r) => r.deliveredEvidence) || ((recentBody && recentBody.Count) > 0),
    mismatch:
      'UI Active senders/domains (incl. noreply@stickmanautomation.com, bitpype.com) are NOT visible '
      + 'to the Bitpype secondary API key. That key only sees its own Inactive sender rows. '
      + 'Fix: Account Settings → API Keys → use the Master API key + secret (IsMaster=true) as SMTP user/pass, '
      + 'OR create a new primary key with full send access on the same account that owns those Active senders.',
    results: results.map((r) => ({
      from: r.from,
      to: r.to,
      subjectApi: r.subject + ' [API]',
      subjectSmtp: r.subject + ' [SMTP]',
      apiHttp: r.apiHttp,
      apiStatus: r.apiStatus,
      errors: r.errors,
      uuid: r.uuid,
      msgHttp: r.lookup && r.lookup.msgHttp,
      histCount: r.lookup && r.lookup.hist && r.lookup.hist.Count,
      smtpResponse: r.smtp && (r.smtp.response || r.smtp.error),
      deliveredEvidence: r.deliveredEvidence,
    })),
  }, null, 2));
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
