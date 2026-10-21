'use strict';

/**
 * Deep delivery probe: SMTP transcript + Message-ID + Mailjet message API.
 * Usage (in container):
 *   node scripts/_delivery-probe.js [to1] [to2] ...
 */

const crypto = require('crypto');
const https = require('https');
const nodemailer = require('nodemailer');

const recipients = process.argv.slice(2);
if (!recipients.length) {
  recipients.push('eliayertey@gmail.com', 'team@bitpype.com');
}

const TS = new Date().toISOString();
const MARKER = `DELIVERY-PROBE-${TS.replace(/[:.]/g, '-')}`;

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
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
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

async function loadSettings() {
  // Prefer platform settings (portal/password path); fall back to workspace 1.
  try {
    const { platformSmtpSettings } = require('../server/mailer');
    const s = await platformSmtpSettings();
    if (s['smtp.host'] && s['smtp.user'] && s['smtp.pass']) {
      return { source: 'platform', settings: s };
    }
  } catch (e) {
    console.warn('platform settings failed:', e.message);
  }
  const Database = require('better-sqlite3');
  const db = new Database('/app/data/workspaces/1/websitescout.db', { readonly: true });
  const settings = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) settings[r.key] = r.value;
  db.close();
  return { source: 'workspace1', settings };
}

async function sendViaAppProvider(settings, to, subject) {
  const { getProvider, buildMime, readSmtpConfig } = require('../src/email');
  const provider = getProvider(settings, null);
  if (provider.name === 'stub') throw new Error('stub provider');
  const cfg = readSmtpConfig(settings);
  const text = [
    `Marker: ${MARKER}`,
    `To: ${to}`,
    `From: ${cfg.fromName} <${cfg.fromEmail}>`,
    `Path: app SmtpProvider`,
    `Time: ${TS}`,
  ].join('\n');
  const mimePreview = buildMime({
    fromName: cfg.fromName,
    fromEmail: cfg.fromEmail,
    to,
    subject,
    text,
    html: `<pre>${text}</pre>`,
  });
  const msgIdMatch = /Message-ID:\s*(<[^>]+>)/i.exec(mimePreview);
  const result = await provider.send({ to, subject, text, html: `<pre>${text}</pre>` });
  return {
    path: 'app-smtp',
    subject,
    messageIdHeader: msgIdMatch ? msgIdMatch[1] : null,
    smtpResponse: result && result.response,
    result,
  };
}

async function sendViaNodemailerDebug(settings, to, subject) {
  const host = settings['smtp.host'];
  const port = parseInt(settings['smtp.port'] || '587', 10);
  const secure = settings['smtp.secure'] === '1';
  const user = settings['smtp.user'];
  const pass = settings['smtp.pass'];
  const fromName = settings['smtp.from_name'] || 'Bitpype';
  const fromEmail = settings['smtp.from_email'];
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    logger: true,
    debug: true,
  });
  const text = [
    `Marker: ${MARKER}`,
    `To: ${to}`,
    `From: ${fromName} <${fromEmail}>`,
    `Path: nodemailer debug`,
    `Time: ${TS}`,
  ].join('\n');
  const info = await transporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject,
    text,
    html: `<pre>${text}</pre>`,
  });
  return {
    path: 'nodemailer',
    subject,
    messageId: info.messageId,
    response: info.response,
    accepted: info.accepted,
    rejected: info.rejected,
    pending: info.pending,
    envelope: info.envelope,
  };
}

async function mailjetSenderCheck(apiKey, apiSecret) {
  const auth = `${apiKey}:${apiSecret}`;
  const senders = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender?Limit=50', { auth });
  const domains = await httpJson('GET', 'https://api.mailjet.com/v3/REST/dns?Limit=50', { auth });
  return { senders, domains };
}

async function mailjetSendAndPoll(apiKey, apiSecret, to, subject) {
  const auth = `${apiKey}:${apiSecret}`;
  const text = `Marker: ${MARKER}\nPath: mailjet-api\nTime: ${TS}\nTo: ${to}`;
  const send = await httpJson('POST', 'https://api.mailjet.com/v3.1/send', {
    auth,
    body: {
      Messages: [{
        From: { Email: 'team@bitpype.com', Name: 'Bitpype' },
        To: [{ Email: to }],
        Subject: subject,
        TextPart: text,
        HTMLPart: `<pre>${text}</pre>`,
        CustomID: MARKER,
      }],
    },
  });

  // Poll recent messages for this recipient
  await new Promise((r) => setTimeout(r, 2500));
  const encoded = encodeURIComponent(to);
  const messages = await httpJson(
    'GET',
    `https://api.mailjet.com/v3/REST/message?ContactAlt=${encoded}&Limit=5&Sort=ArrivedAt+DESC`,
    { auth }
  );
  let details = [];
  const rows = (messages.body && messages.body.Data) || [];
  for (const m of rows.slice(0, 3)) {
    const hist = await httpJson('GET', `https://api.mailjet.com/v3/REST/messagehistory/${m.ID}`, { auth });
    const info = await httpJson('GET', `https://api.mailjet.com/v3/REST/message/${m.ID}`, { auth });
    details.push({ id: m.ID, status: m.Status, arrivedAt: m.ArrivedAt, history: hist.body, info: info.body });
  }
  return { send, messages: messages.body, details };
}

async function mailjetRecentEvents(apiKey, apiSecret) {
  const auth = `${apiKey}:${apiSecret}`;
  // last 50 message events
  const events = await httpJson('GET', 'https://api.mailjet.com/v3/REST/eventcallbackurl', { auth });
  const messages = await httpJson(
    'GET',
    'https://api.mailjet.com/v3/REST/message?Limit=10&Sort=ArrivedAt+DESC',
    { auth }
  );
  return { eventCallbackUrls: events, recentMessages: messages };
}

(async () => {
  console.log(JSON.stringify({ marker: MARKER, ts: TS, recipients }, null, 2));
  const { source, settings } = await loadSettings();
  console.log('settings_source=', source);
  console.log('smtp.host=', settings['smtp.host']);
  console.log('smtp.port=', settings['smtp.port']);
  console.log('smtp.from_email=', settings['smtp.from_email']);
  console.log('smtp.from_name=', settings['smtp.from_name']);
  console.log('smtp.user=', settings['smtp.user'] ? `SET(len=${String(settings['smtp.user']).length})` : 'EMPTY');
  console.log('smtp.pass=', settings['smtp.pass'] ? `SET(len=${String(settings['smtp.pass']).length})` : 'EMPTY');

  const apiKey = settings['smtp.user'];
  const apiSecret = settings['smtp.pass'];

  console.log('\n=== Mailjet sender/domain verification ===');
  try {
    const v = await mailjetSenderCheck(apiKey, apiSecret);
    console.log(JSON.stringify(v, null, 2));
  } catch (e) {
    console.error('sender check failed:', e.message);
  }

  console.log('\n=== Recent Mailjet messages ===');
  try {
    const recent = await mailjetRecentEvents(apiKey, apiSecret);
    console.log(JSON.stringify(recent, null, 2));
  } catch (e) {
    console.error('recent failed:', e.message);
  }

  const results = [];
  for (const to of recipients) {
    const subjApp = `[Bitpype] ${MARKER} APP-SMTP -> ${to}`;
    const subjNm = `[Bitpype] ${MARKER} NODEMAILER -> ${to}`;
    const subjApi = `[Bitpype] ${MARKER} MJ-API -> ${to}`;

    console.log(`\n=== APP SMTP -> ${to} ===`);
    try {
      const r = await sendViaAppProvider(settings, to, subjApp);
      console.log(JSON.stringify(r, null, 2));
      results.push(r);
    } catch (e) {
      console.error('APP SMTP FAIL', e.message);
      results.push({ path: 'app-smtp', to, error: e.message });
    }

    console.log(`\n=== NODEMAILER DEBUG -> ${to} ===`);
    try {
      const r = await sendViaNodemailerDebug(settings, to, subjNm);
      console.log(JSON.stringify(r, null, 2));
      results.push(r);
    } catch (e) {
      console.error('NODEMAILER FAIL', e.message);
      results.push({ path: 'nodemailer', to, error: e.message });
    }

    console.log(`\n=== MAILJET API -> ${to} ===`);
    try {
      const r = await mailjetSendAndPoll(apiKey, apiSecret, to, subjApi);
      console.log(JSON.stringify(r, null, 2));
      results.push({ path: 'mailjet-api', to, subject: subjApi, ...r });
    } catch (e) {
      console.error('MAILJET API FAIL', e.message);
      results.push({ path: 'mailjet-api', to, error: e.message });
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({ marker: MARKER, results: results.map((r) => ({
    path: r.path,
    to: r.to,
    subject: r.subject,
    messageId: r.messageId || r.messageIdHeader,
    response: r.response || r.smtpResponse,
    accepted: r.accepted,
    rejected: r.rejected,
    error: r.error,
    mjStatus: r.send && r.send.status,
    mjBody: r.send && r.send.body,
    details: r.details && r.details.map((d) => ({ id: d.id, status: d.status, arrivedAt: d.arrivedAt })),
  })) }, null, 2));
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
