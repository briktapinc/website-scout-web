'use strict';

/**
 * Shared Bitpype HTML email layout (table-based, inline CSS, multipart-friendly).
 * All outbound app mail should go through renderBrandedEmail / ensureBrandedEmail.
 */

const LOGO_URL = process.env.BITPYPE_EMAIL_LOGO_URL
  || 'https://bitpype.com/brand/bitpype-mark.svg';
const SITE_URL = process.env.APP_URL || 'https://bitpype.com';
const BRAND_MARKER = 'data-bitpype-mail="1"';

const COLORS = {
  bg: '#f3f0ea',
  surface: '#fffcf8',
  ink: '#1c1915',
  muted: '#6f675e',
  border: '#e4ddd2',
  accent: '#0f6e56',
  accentDark: '#0b5442',
  markBg: '#171512',
  markFg: '#f3ead8',
};

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const t = String(label).replace(/<[^>]+>/g, '').trim();
      return t ? `${t} (${href})` : href;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeHtml(s) {
  return typeof s === 'string' && /<\/?[a-z][\s\S]*>/i.test(s);
}

function isAlreadyBranded(html) {
  return typeof html === 'string' && html.includes(BRAND_MARKER);
}

/** Split plain text into paragraph blocks; preserve blank-line separation. */
function plainToParagraphsHtml(text) {
  const blocks = String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split('\n').map((l) => escapeHtml(l));
      const inner = lines.join('<br>\n');
      if (!inner.trim()) return '';
      return `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:${COLORS.ink};">${inner}</p>`;
    })
    .filter(Boolean)
    .join('\n');
}

/** Turn simple HTML fragments into body HTML; wrap bare text. */
function normalizeBodyHtml(html, text) {
  if (html && looksLikeHtml(html) && !isAlreadyBranded(html)) {
    // Fragment: ensure links are accent-colored for clients that strip <style>
    return String(html)
      .replace(/<a\s/gi, `<a style="color:${COLORS.accentDark};text-decoration:underline;" `);
  }
  const plain = (text && String(text).trim())
    || (html && !looksLikeHtml(html) ? String(html) : stripHtml(html || ''));
  return plainToParagraphsHtml(plain);
}

function extractFirstUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[).,;]+$/, '') : null;
}

/**
 * @param {object} opts
 * @param {string} [opts.title]       Heading inside the card
 * @param {string} [opts.preheader]   Hidden preview text
 * @param {string} [opts.htmlBody]    Inner HTML (paragraphs, lists, …)
 * @param {string[]} [opts.paragraphs] Plain paragraphs (alternative to htmlBody)
 * @param {string} [opts.text]        Plain-text alternative body
 * @param {{ url: string, label?: string }|null} [opts.cta]
 * @param {string} [opts.footerNote]
 * @returns {{ html: string, text: string }}
 */
function renderBrandedEmail(opts = {}) {
  const title = String(opts.title || 'Bitpype').trim();
  const preheader = String(opts.preheader || '').trim();
  const footerNote = String(opts.footerNote || 'Bitpype · Local business desk').trim();
  const cta = opts.cta && opts.cta.url
    ? { url: String(opts.cta.url), label: String(opts.cta.label || 'Open link') }
    : null;

  let bodyHtml = opts.htmlBody;
  if (!bodyHtml && Array.isArray(opts.paragraphs) && opts.paragraphs.length) {
    bodyHtml = opts.paragraphs
      .map((p) => String(p || '').trim())
      .filter(Boolean)
      .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:${COLORS.ink};">${escapeHtml(p).replace(/\n/g, '<br>\n')}</p>`)
      .join('\n');
  }
  if (!bodyHtml) {
    bodyHtml = normalizeBodyHtml(opts.html, opts.text);
  }

  const textParts = [];
  if (title) textParts.push(title);
  if (opts.text) textParts.push(String(opts.text).trim());
  else if (Array.isArray(opts.paragraphs)) textParts.push(opts.paragraphs.join('\n\n'));
  else textParts.push(stripHtml(bodyHtml));
  if (cta) textParts.push(`${cta.label}: ${cta.url}`);
  textParts.push(footerNote, SITE_URL.replace(/\/$/, ''));
  const text = textParts.filter(Boolean).join('\n\n');

  const ctaHtml = cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
        <tr>
          <td align="center" bgcolor="${COLORS.accent}" style="border-radius:8px;background:${COLORS.accent};">
            <a href="${escapeHtml(cta.url)}" target="_blank"
               style="display:inline-block;padding:12px 22px;font-family:Segoe UI,Helvetica Neue,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
              ${escapeHtml(cta.label)}
            </a>
          </td>
        </tr>
      </table>`
    : '';

  const preheaderHtml = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${COLORS.bg};opacity:0;">
        ${escapeHtml(preheader)}
      </div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en" ${BRAND_MARKER}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="x-ua-compatible" content="ie=edge">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.bg};color:${COLORS.ink};">
  ${preheaderHtml}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.bg};">
    <tr>
      <td align="center" style="padding:28px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
          <tr>
            <td style="padding:0 4px 18px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="40" height="40" style="width:40px;height:40px;border-radius:10px;background:${COLORS.markBg};vertical-align:middle;">
                    <a href="${escapeHtml(SITE_URL.replace(/\/$/, ''))}" style="text-decoration:none;">
                      <img src="${escapeHtml(LOGO_URL)}" width="40" height="40" alt="Bitpype"
                           style="display:block;width:40px;height:40px;border:0;border-radius:10px;">
                    </a>
                  </td>
                  <td style="padding-left:12px;vertical-align:middle;">
                    <div style="font-family:Segoe UI,Helvetica Neue,Arial,sans-serif;font-size:17px;font-weight:700;letter-spacing:-0.02em;color:${COLORS.ink};">Bitpype</div>
                    <div style="font-family:Segoe UI,Helvetica Neue,Arial,sans-serif;font-size:12px;color:${COLORS.muted};">Local business desk</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:${COLORS.surface};border:1px solid ${COLORS.border};border-radius:12px;padding:28px 28px 8px;">
              <h1 style="margin:0 0 16px;font-family:Segoe UI,Helvetica Neue,Arial,sans-serif;font-size:20px;line-height:1.3;font-weight:700;letter-spacing:-0.02em;color:${COLORS.ink};">
                ${escapeHtml(title)}
              </h1>
              <div style="font-family:Segoe UI,Helvetica Neue,Arial,sans-serif;">
                ${bodyHtml}
              </div>
              ${ctaHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:18px 8px 0;font-family:Segoe UI,Helvetica Neue,Arial,sans-serif;font-size:12px;line-height:1.45;color:${COLORS.muted};text-align:center;">
              ${escapeHtml(footerNote)}<br>
              <a href="${escapeHtml(SITE_URL.replace(/\/$/, ''))}" style="color:${COLORS.accentDark};text-decoration:none;">bitpype.com</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { html, text };
}

/**
 * Wrap any outbound payload in the shared template unless already branded.
 * Extracts a CTA from an explicit cta option or the first https URL in the body.
 *
 * @param {object} opts
 * @param {string} [opts.subject]
 * @param {string} [opts.title]
 * @param {string} [opts.html]
 * @param {string} [opts.text]
 * @param {string} [opts.preheader]
 * @param {{ url: string, label?: string }|null} [opts.cta]
 * @param {string} [opts.footerNote]
 * @param {boolean} [opts.autoCta=true] Infer CTA button from first URL when none given
 */
function ensureBrandedEmail(opts = {}) {
  const htmlIn = opts.html;
  const textIn = opts.text;
  if (isAlreadyBranded(htmlIn)) {
    return {
      html: htmlIn,
      text: (textIn && String(textIn).trim()) ? String(textIn) : stripHtml(htmlIn),
    };
  }

  const plainSource = (textIn && String(textIn).trim())
    || (htmlIn && !looksLikeHtml(htmlIn) ? String(htmlIn) : stripHtml(htmlIn || ''));

  let cta = opts.cta && opts.cta.url ? opts.cta : null;
  if (!cta && opts.autoCta !== false) {
    const url = extractFirstUrl(plainSource) || extractFirstUrl(htmlIn);
    if (url) cta = { url, label: opts.ctaLabel || 'Open link' };
  }

  const title = String(opts.title || opts.subject || 'Bitpype').trim();
  // Avoid repeating the subject as both title and first line when body starts with it
  let bodyHtml = normalizeBodyHtml(htmlIn, textIn);
  if (looksLikeHtml(htmlIn) && /<a\s/i.test(htmlIn) && cta) {
    // Structured callers often put the same link in body + CTA; keep body as-is.
  }

  return renderBrandedEmail({
    title,
    preheader: opts.preheader || plainSource.slice(0, 140),
    htmlBody: bodyHtml,
    text: plainSource,
    cta,
    footerNote: opts.footerNote,
  });
}

module.exports = {
  LOGO_URL,
  BRAND_MARKER,
  COLORS,
  escapeHtml,
  stripHtml,
  renderBrandedEmail,
  ensureBrandedEmail,
  looksLikeHtml,
  isAlreadyBranded,
};
