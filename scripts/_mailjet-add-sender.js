'use strict';

/**
 * Add / validate an alternate Mailjet sender and inspect DNS by ID.
 * Usage: node scripts/_mailjet-add-sender.js [email]
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
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const email = process.argv[2] || 'eliayertey@gmail.com';
  const { platformSmtpSettings } = require('../server/mailer');
  const s = await platformSmtpSettings();
  const auth = `${s['smtp.user']}:${s['smtp.pass']}`;

  console.log('=== list senders ===');
  let senders = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender?Limit=50', { auth });
  console.log(JSON.stringify(senders.body, null, 2));

  const existing = ((senders.body && senders.body.Data) || [])
    .find((x) => String(x.Email).toLowerCase() === email.toLowerCase());

  let senderId = existing && existing.ID;
  if (!existing) {
    console.log('\n=== create sender', email, '===');
    const created = await httpJson('POST', 'https://api.mailjet.com/v3/REST/sender', {
      auth,
      body: { Email: email, Name: 'Bitpype', EmailType: 'transactional' },
    });
    console.log(JSON.stringify(created, null, 2));
    senderId = created.body && created.body.Data && created.body.Data[0] && created.body.Data[0].ID;
  } else {
    console.log('sender already exists id=', senderId, 'status=', existing.Status);
  }

  if (senderId) {
    console.log('\n=== validate sender', senderId, '===');
    const v = await httpJson('POST', `https://api.mailjet.com/v3/REST/sender/${senderId}/validate`, { auth });
    console.log(JSON.stringify(v, null, 2));
    const g = await httpJson('GET', `https://api.mailjet.com/v3/REST/sender/${senderId}`, { auth });
    console.log('after validate:', JSON.stringify(g.body, null, 2));
  }

  // Inspect DNSID from team@bitpype.com
  const team = ((senders.body && senders.body.Data) || [])
    .find((x) => String(x.Email).toLowerCase() === 'team@bitpype.com');
  const dnsId = team && team.DNSID;
  if (dnsId && dnsId > 0) {
    console.log('\n=== dns by id', dnsId, '===');
    const d = await httpJson('GET', `https://api.mailjet.com/v3/REST/dns/${dnsId}`, { auth });
    console.log(JSON.stringify(d, null, 2));
    const check = await httpJson('POST', `https://api.mailjet.com/v3/REST/dns/${dnsId}/check`, { auth });
    console.log('dns check:', JSON.stringify(check, null, 2));
  } else {
    // re-fetch team sender for updated DNSID
    const team2 = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender/6485080936', { auth });
    console.log('\n=== team sender refreshed ===');
    console.log(JSON.stringify(team2.body, null, 2));
    const id2 = team2.body && team2.body.Data && team2.body.Data[0] && team2.body.Data[0].DNSID;
    if (id2 && id2 > 0) {
      const d = await httpJson('GET', `https://api.mailjet.com/v3/REST/dns/${id2}`, { auth });
      console.log('dns:', JSON.stringify(d, null, 2));
      const check = await httpJson('POST', `https://api.mailjet.com/v3/REST/dns/${id2}/check`, { auth });
      console.log('dns check:', JSON.stringify(check, null, 2));
    }
  }

  console.log('\n=== final sender list ===');
  senders = await httpJson('GET', 'https://api.mailjet.com/v3/REST/sender?Limit=50', { auth });
  console.log(JSON.stringify(senders.body, null, 2));
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
