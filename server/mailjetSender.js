'use strict';

/**
 * Mailjet sender preflight — SMTP 250 is not delivery proof when From is Inactive.
 */

const https = require('https');

function mailjetGet(path, apiKey, apiSecret) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'GET',
      hostname: 'api.mailjet.com',
      path,
      headers: {
        Accept: 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64'),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('Mailjet API timeout')); });
    req.end();
  });
}

/**
 * When SMTP host is Mailjet, refuse to pretend success if From address is Inactive.
 */
async function assertMailjetSenderActive(settings) {
  const host = String((settings && settings['smtp.host']) || '').toLowerCase();
  if (!host.includes('mailjet.com')) return null;
  const apiKey = settings['smtp.user'];
  const apiSecret = settings['smtp.pass'];
  const from = String((settings && settings['smtp.from_email']) || '').trim().toLowerCase();
  if (!apiKey || !apiSecret || !from) return null;

  let resp;
  try {
    resp = await mailjetGet('/v3/REST/sender?Limit=100', apiKey, apiSecret);
  } catch (e) {
    console.warn('[mailjetSender] check failed:', e.message);
    return null;
  }
  if (!resp || resp.status !== 200 || !resp.body || !Array.isArray(resp.body.Data)) return null;

  const sender = resp.body.Data.find((s) => String(s.Email || '').toLowerCase() === from);
  if (!sender) {
    const e = new Error(
      `Mailjet has no verified sender for ${from}. Add and activate it in Mailjet → Account → Sender addresses (or temporarily set smtp.from_email to an Active sender).`
    );
    e.code = 'SENDER_NOT_VERIFIED';
    e.mailjetStatus = 'missing';
    throw e;
  }
  const status = String(sender.Status || '');
  if (status.toLowerCase() !== 'active') {
    const e = new Error(
      `Mailjet sender ${from} is ${status || 'Inactive'} — SMTP may return 250 but mail will not deliver. Open Mailjet → Sender addresses, complete verification for ${from} (and authenticate domain bitpype.com). Temporary workaround: verify a personal inbox sender and set smtp.from_email to that Active address.`
    );
    e.code = 'SENDER_NOT_VERIFIED';
    e.mailjetStatus = status || 'Inactive';
    throw e;
  }
  return { email: sender.Email, status, id: sender.ID };
}

module.exports = { assertMailjetSenderActive };
