'use strict';

/**
 * Set From to team@bitpype.com (platform + workspace 1 + platform-defaults),
 * verify public DNS + Mailjet DNS, send distinctive tests, report status.
 */

const fs = require('fs');
const https = require('https');
const dns = require('dns').promises;
const Database = require('better-sqlite3');

const FROM = 'team@bitpype.com';
const FROM_NAME = 'Bitpype';
const DOMAIN = 'bitpype.com';
const TEST_TO = ['briktapinc@gmail.com', 'eliayertey@gmail.com'];
const TS = new Date().toISOString();
const MARKER = `BITPYPE-TEAM-${TS.replace(/[:.]/g, '-')}`;
const WS_PATH = '/app/data/workspaces/1/websitescout.db';

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
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch { /* keep raw */ }
        resolve({ status: res.statusCode, raw: data, body: parsed });
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

function getWs(dbPath, key) {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  db.close();
  return row ? row.value : '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function lookupTxt(name) {
  try {
    const rows = await dns.resolveTxt(name);
    return rows.map((parts) => parts.join(''));
  } catch (e) {
    return { error: e.code || e.message };
  }
}

(async () => {
  const platform = require('../server/platform');
  const { platformSmtpSettings } = require('../server/mailer');
  const { getProvider } = require('../src/email');

  const before = await platformSmtpSettings();
  console.log('=== BEFORE ===');
  console.log(JSON.stringify({
    platform_from: before['smtp.from_email'],
    platform_name: before['smtp.from_name'],
    workspace_from: getWs(WS_PATH, 'smtp.from_email'),
    workspace_name: getWs(WS_PATH, 'smtp.from_name'),
    apiKeyPrefix: String(before['smtp.user'] || '').slice(0, 8),
  }, null, 2));

  await platform.setPlatformSetting('smtp.from_email', FROM);
  await platform.setPlatformSetting('smtp.from_name', FROM_NAME);
  setWs(WS_PATH, 'smtp.from_email', FROM);
  setWs(WS_PATH, 'smtp.from_name', FROM_NAME);
  try {
    await platform.savePlatformDefaultsSnapshot();
  } catch (e) {
    console.warn('snapshot failed:', e.message);
  }

  // Also patch flat/nested keys in platform-defaults if present
  for (const file of [
    '/app/data/workspaces/platform-defaults.json',
    '/app/data/platform-defaults.json',
  ]) {
    if (!fs.existsSync(file)) continue;
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (obj.settings && typeof obj.settings === 'object') {
        obj.settings['smtp.from_email'] = FROM;
        obj.settings['smtp.from_name'] = FROM_NAME;
      }
      obj['smtp.from_email'] = FROM;
      obj['smtp.from_name'] = FROM_NAME;
      fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
      console.log('patched', file);
    } catch (e) {
      console.warn('patch failed', file, e.message);
    }
  }

  const after = await platformSmtpSettings();
  console.log('\n=== AFTER from_email ===');
  console.log(JSON.stringify({
    platform_from: after['smtp.from_email'],
    platform_name: after['smtp.from_name'],
    workspace_from: getWs(WS_PATH, 'smtp.from_email'),
    workspace_name: getWs(WS_PATH, 'smtp.from_name'),
  }, null, 2));

  // Public DNS
  console.log('\n=== PUBLIC DNS ===');
  const spf = await lookupTxt(DOMAIN);
  const dmarc = await lookupTxt(`_dmarc.${DOMAIN}`);
  const dkim = await lookupTxt(`mailjet._domainkey.${DOMAIN}`);
  const dnsFindings = {
    spf_txt: spf,
    spf_includes_mailjet: Array.isArray(spf) && spf.some((t) => /include:.*mailjet/i.test(t)),
    dkim_mailjet: dkim,
    dkim_present: Array.isArray(dkim) && dkim.length > 0 && !dkim.error,
    dmarc_txt: dmarc,
    dmarc_present: Array.isArray(dmarc) && dmarc.some((t) => /^v=DMARC1/i.test(t)),
  };
  console.log(JSON.stringify(dnsFindings, null, 2));

  const auth = `${after['smtp.user']}:${after['smtp.pass']}`;

  // Mailjet senders + DNS
  console.log('\n=== MAILJET SENDERS (bitpype) ===');
  const sendersR = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender?Limit=100', { auth });
  const senders = ((sendersR.body && sendersR.body.Data) || []).filter((s) =>
    String(s.Email || '').toLowerCase().includes('bitpype') ||
    String(s.Email || '').toLowerCase() === FROM
  );
  console.log(JSON.stringify(senders.map((s) => ({
    ID: s.ID, Email: s.Email, Status: s.Status, Name: s.Name, IsDefaultSender: s.IsDefaultSender,
  })), null, 2));

  console.log('\n=== MAILJET DNS bitpype.com ===');
  const dnsR = await httpJson(
    'GET',
    `https://api.mailjet.com/v3/REST/dns?Domain=${encodeURIComponent(DOMAIN)}`,
    { auth }
  );
  console.log('http', dnsR.status);
  const dnsRows = (dnsR.body && dnsR.body.Data) || [];
  for (const d of dnsRows) {
    const one = await httpJson('GET', `https://api.mailjet.com/v3/REST/dns/${d.ID}`, { auth });
    const chk = await httpJson('POST', `https://api.mailjet.com/v3/REST/dns/${d.ID}/check`, { auth });
    console.log(JSON.stringify({
      id: d.ID,
      domain: d.Domain,
      SPFStatus: d.SPFStatus,
      DKIMStatus: d.DKIMStatus,
      OwnerShipToken: d.OwnerShipToken,
      check: chk.body,
      detail: one.body && one.body.Data && one.body.Data[0],
    }, null, 2));
  }
  if (!dnsRows.length) {
    console.log('no Mailjet DNS rows for domain; full dns list:');
    const all = await httpJson('GET', 'https://api.mailjet.com/v3/REST/dns?Limit=50', { auth });
    console.log(JSON.stringify(((all.body && all.body.Data) || []).map((d) => ({
      ID: d.ID, Domain: d.Domain, SPFStatus: d.SPFStatus, DKIMStatus: d.DKIMStatus,
    })), null, 2));
  }

  // Send tests via Mailjet API + SMTP
  console.log('\n=== SEND TESTS ===');
  const sendResults = [];
  for (const to of TEST_TO) {
    const subject = `[Bitpype] ${MARKER} team@ -> ${to}`;
    const text =
      `Deliverability alignment test.\n` +
      `Marker: ${MARKER}\n` +
      `From: ${FROM} (${FROM_NAME})\n` +
      `To: ${to}\n` +
      `Why: Gmail From via Mailjet breaks SPF/DKIM alignment; bitpype.com is authenticated.\n` +
      `If this landed in spam once, mark Not spam / move to Inbox.\n`;

    const apiSend = await httpJson('POST', 'https://api.mailjet.com/v3.1/send', {
      auth,
      body: {
        Messages: [{
          From: { Email: FROM, Name: FROM_NAME },
          To: [{ Email: to }],
          Subject: subject + ' [API]',
          TextPart: text + 'Path=API\n',
          Headers: {
            'List-Unsubscribe': `<mailto:${FROM}?subject=unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
          CustomID: MARKER,
        }],
      },
    });
    const apiMsgs = (((apiSend.body || {}).Messages) || []);
    const apiMsg = apiMsgs[0] || {};
    const messageIds = ((apiMsg.To) || []).map((t) => t.MessageID).filter(Boolean);

    let smtpResult = null;
    try {
      const provider = getProvider({
        ...after,
        'smtp.from_email': FROM,
        'smtp.from_name': FROM_NAME,
      }, null);
      smtpResult = await provider.send({
        to,
        subject: subject + ' [SMTP]',
        text: text + 'Path=SMTP\n',
      });
    } catch (e) {
      smtpResult = { ok: false, error: e.message, mailjetStatus: e.mailjetStatus };
    }

    sendResults.push({
      to,
      subjectApi: subject + ' [API]',
      subjectSmtp: subject + ' [SMTP]',
      apiHttp: apiSend.status,
      apiStatus: apiMsg.Status,
      messageIds,
      apiErrors: apiMsg.Errors || apiSend.body,
      smtp: smtpResult && {
        ok: smtpResult.ok,
        response: smtpResult.response,
        messageId: smtpResult.messageId,
        error: smtpResult.error,
        mailjetStatus: smtpResult.mailjetStatus,
      },
    });
    console.log(JSON.stringify(sendResults[sendResults.length - 1], null, 2));
  }

  // Poll Mailjet message status
  await sleep(4000);
  console.log('\n=== MESSAGE STATUS ===');
  const statuses = [];
  for (const r of sendResults) {
    for (const id of r.messageIds || []) {
      const hist = await httpJson('GET', `https://api.mailjet.com/v3/REST/messagehistory/${id}`, { auth });
      const info = await httpJson('GET', `https://api.mailjet.com/v3/REST/messageinformation/${id}`, { auth });
      const msg = await httpJson('GET', `https://api.mailjet.com/v3/REST/message/${id}`, { auth });
      statuses.push({
        id,
        to: r.to,
        message: msg.body && msg.body.Data && msg.body.Data[0],
        history: hist.body && hist.body.Data,
        info: info.body && info.body.Data && info.body.Data[0],
      });
    }
  }
  console.log(JSON.stringify(statuses, null, 2));

  const recent = await httpJson(
    'GET',
    'https://api.mailjet.com/v3/REST/message?Limit=10&Sort=ArrivedAt+DESC',
    { auth }
  );
  console.log('\n=== RECENT MESSAGES ===');
  console.log(JSON.stringify(((recent.body && recent.body.Data) || []).map((m) => ({
    ID: m.ID,
    Status: m.Status,
    Arrival: m.ArrivedAt,
    From: m.ContactAlt || m.FromEmail || m.FromID,
    Subject: m.Subject,
  })), null, 2));

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    marker: MARKER,
    from_email: FROM,
    from_name: FROM_NAME,
    platform_from: after['smtp.from_email'],
    workspace_from: getWs(WS_PATH, 'smtp.from_email'),
    dnsFindings,
    subjects: sendResults.flatMap((r) => [r.subjectApi, r.subjectSmtp]),
    sendResults: sendResults.map((r) => ({
      to: r.to,
      apiStatus: r.apiStatus,
      apiHttp: r.apiHttp,
      messageIds: r.messageIds,
      smtpOk: r.smtp && r.smtp.ok,
      smtpResponse: r.smtp && (r.smtp.response || r.smtp.error),
    })),
    messageStatuses: statuses.map((s) => ({
      id: s.id,
      to: s.to,
      Status: s.message && s.message.Status,
      events: (s.history || []).map((h) => h.EventAt + ' ' + h.EventType),
    })),
  }, null, 2));
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
