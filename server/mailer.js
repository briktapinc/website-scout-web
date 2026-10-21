'use strict';

const platform = require('./platform');
const { assertMailjetSenderActive } = require('../src/mailjetSender');
const { renderBrandedEmail, ensureBrandedEmail } = require('../src/emailTemplate');

async function platformSmtpSettings() {
  const keys = [
    'smtp.host', 'smtp.port', 'smtp.secure', 'smtp.user', 'smtp.pass',
    'smtp.from_name', 'smtp.from_email',
  ];
  const out = {};
  for (const k of keys) out[k] = await platform.getPlatformSetting(k, '');
  return out;
}

/**
 * Send platform mail through the shared Bitpype HTML template.
 * Prefer structured fields (title, paragraphs, cta) when composing new emails.
 */
async function sendPlatformMail({
  to, subject, html, text, title, paragraphs, cta, preheader, footerNote,
}) {
  const settings = await platformSmtpSettings();
  const { getProvider } = require('../src/email');
  const provider = getProvider(settings, null);
  if (provider.name === 'stub' || !settings['smtp.host']) {
    const e = new Error('Platform SMTP is not configured');
    e.code = 'SMTP_NOT_CONFIGURED';
    throw e;
  }
  await assertMailjetSenderActive(settings);

  const payload = Array.isArray(paragraphs) && paragraphs.length
    ? renderBrandedEmail({
      title: title || subject,
      paragraphs,
      text: text || paragraphs.join('\n\n'),
      cta,
      preheader,
      footerNote,
    })
    : ensureBrandedEmail({
      subject,
      title,
      html: html || text || '',
      text: text || undefined,
      cta,
      preheader,
      footerNote,
    });

  const result = await provider.send({
    to,
    subject,
    html: payload.html,
    text: payload.text,
    skipBrand: true,
  });
  console.log(
    '[mailer] sent',
    JSON.stringify({
      to,
      subject,
      provider: provider.name,
      smtpResponse: result && result.response,
      messageId: result && result.messageId,
    })
  );
  return {
    sent: true,
    provider: provider.name,
    smtpResponse: result && result.response,
    messageId: result && result.messageId,
  };
}

module.exports = {
  sendPlatformMail,
  platformSmtpSettings,
  assertMailjetSenderActive,
  renderBrandedEmail,
  ensureBrandedEmail,
};
