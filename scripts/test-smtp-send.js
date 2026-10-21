'use strict';

/**
 * Send one SMTP test using workspace settings.
 * Usage: node scripts/test-smtp-send.js [workspaceDbPath] [toEmail]
 */

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.argv[2] || path.join(__dirname, '..', 'data', 'workspaces', '1', 'websitescout.db');
const toArg = process.argv[3] || '';

const db = new Database(dbPath, { readonly: true });
const settings = {};
for (const r of db.prepare('SELECT key, value FROM settings').all()) settings[r.key] = r.value;

const keys = ['smtp.host', 'smtp.port', 'smtp.secure', 'smtp.user', 'smtp.pass', 'smtp.from_name', 'smtp.from_email'];
console.log('SMTP config:');
for (const k of keys) {
  const v = settings[k] || '';
  if (k === 'smtp.pass' || k === 'smtp.user') {
    console.log(`  ${k}=${v ? `SET(len=${String(v).length})` : 'EMPTY'}`);
  } else {
    console.log(`  ${k}=${JSON.stringify(v)}`);
  }
}

const { getProvider } = require('../src/email');
const provider = getProvider(settings, db);
console.log('provider=', provider.name);

if (provider.name === 'stub') {
  console.error('FAIL: SMTP not configured (stub provider)');
  process.exit(2);
}

const to = toArg || settings['smtp.from_email'] || process.env.BOOTSTRAP_EMAIL || 'owner@example.com';
const fromEmail = settings['smtp.from_email'] || '';
const subject = `[Bitpype] SMTP HTML test ${new Date().toISOString()}`;
const text = [
  'This is an HTML-formatted test email from Bitpype.',
  `Sent via ${settings['smtp.host']}:${settings['smtp.port']} (secure=${settings['smtp.secure']}).`,
  `From setting: ${fromEmail}`,
  `Provider: ${provider.name}`,
].join('\n');

(async () => {
  console.log('sending to', to);
  const result = await provider.send({
    to,
    subject,
    text,
    title: 'SMTP delivery check',
    cta: { url: 'https://bitpype.com', label: 'Open Bitpype' },
  });
  console.log('OK', JSON.stringify(result || { sent: true }));
})().catch((e) => {
  console.error('FAIL', e && e.message ? e.message : e);
  if (e && e.code) console.error('code=', e.code);
  process.exit(1);
});
