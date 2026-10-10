'use strict';

const platform = require('./platform');

async function platformSmtpSettings() {
  const keys = [
    'smtp.host', 'smtp.port', 'smtp.secure', 'smtp.user', 'smtp.pass',
    'smtp.from_name', 'smtp.from_email',
  ];
  const out = {};
  for (const k of keys) out[k] = await platform.getPlatformSetting(k, '');
  return out;
}

async function sendPlatformMail({ to, subject, html, text }) {
  const settings = await platformSmtpSettings();
  const { getProvider } = require('../src/email');
  const provider = getProvider(settings, null);
  if (provider.name === 'stub' || !settings['smtp.host']) {
    const e = new Error('Platform SMTP is not configured');
    e.code = 'SMTP_NOT_CONFIGURED';
    throw e;
  }
  await provider.send({
    to,
    subject,
    html: html || text || '',
    text: text || undefined,
  });
  return { sent: true, provider: provider.name };
}

module.exports = { sendPlatformMail, platformSmtpSettings };
