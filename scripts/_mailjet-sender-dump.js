'use strict';

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

(async () => {
  const { platformSmtpSettings } = require('../server/mailer');
  const s = await platformSmtpSettings();
  const auth = `${s['smtp.user']}:${s['smtp.pass']}`;
  console.log('apiKeyPrefix', String(s['smtp.user']).slice(0, 8) + '…');

  for (const path of [
    '/v3/REST/sender?Limit=100',
    '/v3/REST/metasender?Limit=50',
    '/v3/REST/dns?Limit=50',
    '/v3/REST/apikey',
    '/v3/REST/user',
  ]) {
    console.log('\n===', path, '===');
    const r = await httpJson('GET', 'https://api.mailjet.com' + path, { auth });
    console.log('http', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  }

  // Per-sender GET + validate probe (no assumption)
  const senders = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender?Limit=100', { auth });
  for (const sender of (senders.body && senders.body.Data) || []) {
    console.log('\n=== GET sender', sender.ID, sender.Email, '===');
    const g = await httpJson('GET', `https://api.mailjet.com/v3/REST/sender/${sender.ID}`, { auth });
    console.log(JSON.stringify(g.body, null, 2));
  }

  // Try a minimal API send from each address to see real error
  for (const from of ['eliayertey@gmail.com', 'team@bitpype.com']) {
    console.log('\n=== probe send from', from, '===');
    const send = await httpJson('POST', 'https://api.mailjet.com/v3.1/send', {
      auth,
      body: {
        Messages: [{
          From: { Email: from, Name: 'Bitpype' },
          To: [{ Email: 'eliayertey@gmail.com' }],
          Subject: `[Bitpype] probe-active ${from} ${new Date().toISOString()}`,
          TextPart: 'Probe whether Mailjet accepts this From as validated.',
        }],
      },
    });
    console.log(JSON.stringify(send, null, 2));
  }
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
