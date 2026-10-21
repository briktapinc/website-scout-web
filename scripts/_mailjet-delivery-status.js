'use strict';

/**
 * Poll Mailjet message status + attempt sender validate.
 * Usage: node scripts/_mailjet-delivery-status.js [messageHrefOrId...]
 */

const https = require('https');

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
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function loadCreds() {
  const { platformSmtpSettings } = require('../server/mailer');
  const s = await platformSmtpSettings();
  return { apiKey: s['smtp.user'], apiSecret: s['smtp.pass'], from: s['smtp.from_email'] };
}

(async () => {
  const { apiKey, apiSecret, from } = await loadCreds();
  const auth = `${apiKey}:${apiSecret}`;

  console.log('=== sender status ===');
  const senders = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender?Limit=50', { auth });
  console.log(JSON.stringify(senders.body, null, 2));

  const sender = ((senders.body && senders.body.Data) || []).find(
    (x) => String(x.Email).toLowerCase() === String(from).toLowerCase()
  ) || ((senders.body && senders.body.Data) || [])[0];

  if (sender) {
    console.log('\n=== attempt validate sender', sender.ID, sender.Email, 'status=', sender.Status, '===');
    // Mailjet: POST /v3/REST/sender/{id}/validate  (resends validation email)
    const v1 = await httpJson('POST', `https://api.mailjet.com/v3/REST/sender/${sender.ID}/validate`, { auth });
    console.log('validate POST:', JSON.stringify(v1, null, 2));

    // Some accounts use PUT status
    const v2 = await httpJson('GET', `https://api.mailjet.com/v3/REST/sender/${sender.ID}`, { auth });
    console.log('sender GET:', JSON.stringify(v2.body, null, 2));
  }

  console.log('\n=== dns / domains ===');
  const dns = await httpJson('GET', 'https://api.mailjet.com/v3/REST/dns', { auth });
  console.log(JSON.stringify(dns.body, null, 2));

  // Try create domain bitpype.com if missing
  if (!dns.body || !dns.body.Count) {
    console.log('\n=== try create dns domain bitpype.com ===');
    const created = await httpJson('POST', 'https://api.mailjet.com/v3/REST/dns', {
      auth,
      body: { DomainOwnerShipTokenCheck: true },
    });
    // Correct endpoint is often /v3/REST/dns with Domain
    const created2 = await httpJson('POST', 'https://api.mailjet.com/v3/REST/dns', {
      auth,
      body: { Domain: 'bitpype.com' },
    });
    console.log('create1', JSON.stringify(created, null, 2));
    console.log('create2', JSON.stringify(created2, null, 2));
  }

  // Message IDs from probe (use href string to avoid JS bigint loss)
  const hrefs = process.argv.slice(2);
  if (!hrefs.length) {
    hrefs.push(
      'https://api.mailjet.com/v3/REST/message/288230417119073633',
      'https://api.mailjet.com/v3/REST/message/1152921545513840124',
    );
  }

  console.log('\n=== message status by href ===');
  for (const href of hrefs) {
    const id = href.includes('/') ? href.split('/').pop() : href;
    const msg = await httpJson('GET', `https://api.mailjet.com/v3/REST/message/${id}`, { auth });
    console.log('message', id, JSON.stringify(msg.body, null, 2));
    const hist = await httpJson('GET', `https://api.mailjet.com/v3/REST/messagehistory/${id}`, { auth });
    console.log('history', id, JSON.stringify(hist.body, null, 2));
    const info = await httpJson('GET', `https://api.mailjet.com/v3/REST/messageinformation/${id}`, { auth });
    console.log('info', id, JSON.stringify(info.body, null, 2));
  }

  // Also list messages again + apikeyuser
  console.log('\n=== recent messages ===');
  const recent = await httpJson('GET', 'https://api.mailjet.com/v3/REST/message?Limit=20&Sort=ArrivedAt+DESC', { auth });
  console.log(JSON.stringify(recent.body, null, 2));

  console.log('\n=== apikey meta ===');
  const me = await httpJson('GET', 'https://api.mailjet.com/v3/REST/apikey', { auth });
  console.log(JSON.stringify(me.body, null, 2));

  // Send one more via API and immediately fetch by MessageHref string
  console.log('\n=== fresh API send + immediate fetch ===');
  const send = await httpJson('POST', 'https://api.mailjet.com/v3.1/send', {
    auth,
    body: {
      Messages: [{
        From: { Email: from, Name: 'Bitpype' },
        To: [{ Email: 'eliayertey@gmail.com' }],
        Subject: `[Bitpype] MJ-STATUS-CHECK ${new Date().toISOString()}`,
        TextPart: 'Mailjet status check after inactive sender finding.',
      }],
    },
  });
  console.log('send', JSON.stringify(send.body, null, 2));
  const href = send.body && send.body.Messages && send.body.Messages[0]
    && send.body.Messages[0].To && send.body.Messages[0].To[0]
    && send.body.Messages[0].To[0].MessageHref;
  if (href) {
    await new Promise((r) => setTimeout(r, 3000));
    const id = href.split('/').pop();
    const msg = await httpJson('GET', href, { auth });
    const hist = await httpJson('GET', `https://api.mailjet.com/v3/REST/messagehistory/${id}`, { auth });
    const info = await httpJson('GET', `https://api.mailjet.com/v3/REST/messageinformation/${id}`, { auth });
    console.log('fetched', JSON.stringify({ msg: msg.body, hist: hist.body, info: info.body }, null, 2));
  }

  // Errors endpoint
  console.log('\n=== statistics / errors sample ===');
  const stats = await httpJson('GET', 'https://api.mailjet.com/v3/REST/statcounters?CounterSource=APIKey&CounterTiming=Message&CounterResolution=Lifetime&Limit=5', { auth });
  console.log(JSON.stringify(stats.body, null, 2));
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
