'use strict';

/**
 * Send one test email via platform SMTP settings.
 * Usage (in container): node scripts/_test-platform-smtp.js [toEmail]
 */

const toArg = process.argv[2] || '';

async function main() {
  const platform = require('../server/platform');
  const { sendPlatformMail, platformSmtpSettings } = require('../server/mailer');
  const settings = await platformSmtpSettings();
  const keys = [
    'smtp.host', 'smtp.port', 'smtp.secure', 'smtp.user', 'smtp.pass',
    'smtp.from_name', 'smtp.from_email',
  ];
  console.log('SMTP config (platform):');
  for (const k of keys) {
    const v = settings[k] || '';
    if (k === 'smtp.pass' || k === 'smtp.user') {
      console.log(`  ${k}=${v ? `SET(len=${String(v).length})` : 'EMPTY'}`);
    } else {
      console.log(`  ${k}=${JSON.stringify(v)}`);
    }
  }

  const to = toArg || settings['smtp.from_email'] || 'eliayertey@gmail.com';
  const subject = `[Bitpype] Platform HTML email test ${new Date().toISOString()}`;
  const text = [
    'This is a platform HTML email test from Bitpype (website-scout-web).',
    `Host: ${settings['smtp.host']}:${settings['smtp.port']} secure=${settings['smtp.secure']}`,
    `From: ${settings['smtp.from_name']} <${settings['smtp.from_email']}>`,
  ].join('\n');

  console.log('sending to', to);
  const result = await sendPlatformMail({
    to,
    subject,
    title: 'Platform email check',
    paragraphs: [
      'This is a platform HTML email test from Bitpype (website-scout-web).',
      `Host: ${settings['smtp.host']}:${settings['smtp.port']} secure=${settings['smtp.secure']}`,
      `From: ${settings['smtp.from_name']} <${settings['smtp.from_email']}>`,
    ],
    cta: { url: 'https://bitpype.com', label: 'Open Bitpype' },
    text,
  });
  console.log('OK', JSON.stringify(result));
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL', e && e.message ? e.message : e);
  if (e && e.code) console.error('code=', e.code);
  if (e && e.stack) console.error(e.stack.split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
