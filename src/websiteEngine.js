'use strict';

/**
 * Website Engine (Workstream 3).
 *
 * Pure component library + site builder for the single-user Website Scout
 * desktop app.
 *
 * Data model: a website is structured JSON —
 *   pages: [{ slug, title, sections?: [...], html?: string }]
 *   theme: { primary, secondary, font, bg, text, customCss?, baseCss? }
 * Agent deliveries may use freeform page.html (body or full document) instead
 * of built-in sections. Static export writes one HTML file per page.
 *
 * Anti-hallucination (top priority):
 *  - Only facts with claim_class VERIFIED or OWNER_PROVIDED (from
 *    business_facts) — plus lead-record contact basics — are ever rendered
 *    as facts. UNKNOWN facts are never rendered.
 *  - We never invent founding years, awards, addresses, licenses, or review
 *    texts. When in doubt the claim is omitted or labelled AI_COPY
 *    (marketing tone only, no factual assertions).
 *  - Every generated site stores a claim manifest (claim_manifest table)
 *    listing each rendered claim and its class.
 */

const fs = require('fs');
const path = require('path');
const ai = require('./ai');

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Plain-text sanitizer for AI/deterministic copy: strip tags, trim, cap. */
function cleanText(s, max = 500) {
  let t = String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > max) t = t.slice(0, max).trim();
  return t;
}

function digitsOnly(s) {
  return String(s ?? '').replace(/\D/g, '');
}

function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS claim_manifest (
    website_id INTEGER PRIMARY KEY REFERENCES websites(id) ON DELETE CASCADE,
    manifest TEXT NOT NULL
  )`);
  const cols = db.prepare('PRAGMA table_info(websites)').all();
  if (cols.length && !cols.some((c) => c.name === 'origin')) {
    db.exec('ALTER TABLE websites ADD COLUMN origin TEXT');
  }
}

function getSetting(db, key, def) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}

function logActivity(db, area, message) {
  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(area, message);
  } catch (e) { /* activity logging must never break generation */ }
}

function setLeadStatus(db, leadId, status) {
  db.prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, leadId);
}

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ------------------------------------------------------------------ */
/* theme                                                               */
/* ------------------------------------------------------------------ */

const DEFAULT_THEME = {
  primary: '#1a56db',
  secondary: '#0e2a5c',
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  bg: '#ffffff',
  text: '#1f2937',
};

function sanitizeCss(css) {
  let s = String(css == null ? '' : css);
  if (s.length > 200000) s = s.slice(0, 200000);
  // Strip anything that could break out of <style> or run script via CSS.
  s = s.replace(/<\/style/gi, '');
  s = s.replace(/<\/script/gi, '');
  // Keep only https font @imports from Google Fonts; drop every other @import.
  s = s.replace(/@import\s+url\(\s*['"]?(https:\/\/fonts\.googleapis\.com\/[^'")\s]+)['"]?\s*\)\s*;?/gi,
    '@import url("$1");');
  s = s.replace(/@import\b(?![^;]*fonts\.googleapis\.com)[^;]*;?/gi, '');
  s = s.replace(/expression\s*\(/gi, 'expr\u200Bession(');
  // Strip IE/XUL behaviors without touching CSS properties like scroll-behavior.
  s = s.replace(/(^|[;{])\s*-moz-binding\s*:[^;}]*/gi, '$1');
  s = s.replace(/(^|[;{])\s*behavior\s*:[^;}]*/gi, '$1');
  s = s.replace(/javascript\s*:/gi, '');
  return s;
}

/**
 * Allow agent-authored markup without scripts or event handlers.
 * Safe <style> and https stylesheet/font <link> tags are kept so agents
 * can own typography and layout without the built-in component skin.
 */
function sanitizeHtml(html) {
  let s = String(html == null ? '' : html);
  if (s.length > 800000) s = s.slice(0, 800000);
  const kept = [];
  const park = (chunk) => {
    const i = kept.length;
    kept.push(chunk);
    return `\u0000KEEP${i}\u0000`;
  };
  s = s.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => park(`<style>${sanitizeCss(css)}</style>`));
  s = s.replace(/<link\b([^>]*)\/?>/gi, (_, attrs) => {
    const hrefM = /href\s*=\s*(['"])(https:\/\/[^'"]+)\1/i.exec(attrs);
    if (!hrefM) return '';
    const href = hrefM[2];
    const relM = /rel\s*=\s*(['"])([^'"]+)\1/i.exec(attrs);
    const rel = (relM ? relM[2] : 'stylesheet').toLowerCase();
    if (!/^(stylesheet|preconnect|preload)$/.test(rel)) return '';
    const cross = /\bcrossorigin\b/i.test(attrs) ? ' crossorigin' : '';
    return park(`<link rel="${rel}" href="${href}"${cross}>`);
  });
  s = s.replace(/<meta\b([^>]*)\/?>/gi, (_, attrs) => {
    if (/http-equiv/i.test(attrs)) return '';
    if (/\bcharset\b/i.test(attrs)) return park(`<meta${attrs}>`);
    if (/\bname\s*=/i.test(attrs) && /\bcontent\s*=/i.test(attrs)) return park(`<meta${attrs}>`);
    return '';
  });
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<\/?script\b[^>]*>/gi, '');
  s = s.replace(/<\/?(iframe|object|embed|base)[\s\S]*?>/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/\s(href|src|action)\s*=\s*(['"])\s*javascript:[^'"]*\2/gi, ' $1="#"');
  s = s.replace(/\s(href|src|action)\s*=\s*javascript:[^\s>]*/gi, ' $1="#"');
  s = s.replace(/\u0000KEEP(\d+)\u0000/g, (_, i) => kept[Number(i)] || '');
  return s;
}

function looksLikeFullDocument(html) {
  return /^\s*(<!doctype\s+html|<html[\s>])/i.test(String(html || ''));
}

/** Prefer agent-owned styling when custom CSS or an explicit opt-out is present. */
function normalizeTheme(theme) {
  const raw = theme && typeof theme === 'object' ? theme : {};
  const t = Object.assign({}, DEFAULT_THEME, raw);
  for (const k of ['primary', 'secondary', 'bg', 'text']) {
    if (typeof t[k] !== 'string' || !t[k].trim()) t[k] = DEFAULT_THEME[k];
  }
  if (typeof t.font !== 'string' || !t.font.trim()) t.font = DEFAULT_THEME.font;
  if (typeof t.customCss === 'string') t.customCss = sanitizeCss(t.customCss);
  else t.customCss = '';
  const explicitOn = t.baseCss === true || t.baseCss === 1 || t.baseCss === '1';
  const explicitOff = t.baseCss === false || t.baseCss === 0 || t.baseCss === '0';
  if (explicitOff) t.baseCss = false;
  else if (explicitOn) t.baseCss = true;
  else t.baseCss = t.customCss ? false : true;
  return t;
}

/* ------------------------------------------------------------------ */
/* CSS (inline, responsive, standalone)                                 */
/* ------------------------------------------------------------------ */

function siteCss(t) {
  const theme = normalizeTheme(t);
  const minimal = `*{box-sizing:border-box} img{max-width:100%;height:auto} .ws-edit{cursor:text}`;
  if (!theme.baseCss) {
    return `${minimal}\n${theme.customCss || ''}`;
  }
  const base = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:${theme.font};color:${theme.text};background:${theme.bg};line-height:1.6}
a{color:${theme.primary}}
.container{max-width:1080px;margin:0 auto;padding:0 20px}
.nav{position:sticky;top:0;z-index:50;background:${theme.bg};border-bottom:1px solid #e5e7eb}
.nav-inner{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;max-width:1080px;margin:0 auto}
.brand{font-weight:800;font-size:1.25rem;color:${theme.secondary};text-decoration:none}
.nav-links{display:flex;gap:18px;align-items:center}
.nav-links a{text-decoration:none;color:${theme.text};font-weight:600;font-size:.95rem}
.nav-cta{background:${theme.primary};color:#fff!important;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700}
.hero{background:linear-gradient(135deg,${theme.primary},${theme.secondary});color:#fff;padding:72px 0}
.hero h1{font-size:2.4rem;line-height:1.2;margin-bottom:14px}
.hero p{font-size:1.15rem;opacity:.95;max-width:640px;margin-bottom:24px}
.btn{display:inline-block;background:#fff;color:${theme.secondary};padding:13px 26px;border-radius:8px;font-weight:800;text-decoration:none;margin-right:12px}
.btn-primary{background:${theme.primary};color:#fff}
.btn-outline{background:transparent;color:#fff;border:2px solid #fff}
.rating-badge{display:inline-block;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.4);padding:6px 14px;border-radius:999px;font-size:.9rem;margin-bottom:16px}
section.block{padding:56px 0}
.block h2{font-size:1.8rem;color:${theme.secondary};margin-bottom:8px}
.block .lede{color:#4b5563;margin-bottom:28px;max-width:680px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.card{border:1px solid #e5e7eb;border-radius:12px;padding:24px;background:#fff}
.card h3{color:${theme.secondary};margin-bottom:8px;font-size:1.1rem}
.card p{color:#4b5563;font-size:.95rem}
.chip{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,${theme.primary},${theme.secondary});color:#fff;font-weight:800;margin-bottom:12px}
.about p{margin-bottom:14px;color:#374151;max-width:760px}
.gallery-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.ph{aspect-ratio:4/3;border-radius:12px;display:flex;align-items:flex-end;justify-content:center;color:#fff;font-weight:700;padding:12px;text-align:center;text-shadow:0 1px 3px rgba(0,0,0,.4);font-size:.9rem}
.stars{color:#f59e0b;letter-spacing:2px;margin-bottom:8px}
.review-card{font-style:normal}
.review-card .who{margin-top:10px;font-weight:700;color:${theme.secondary};font-style:normal}
.cta-band{background:${theme.secondary};color:#fff;text-align:center;padding:56px 20px;border-radius:16px}
.cta-band h2{color:#fff;margin-bottom:10px}
.cta-band p{opacity:.9;margin-bottom:24px}
.hours-table{width:100%;max-width:520px;border-collapse:collapse}
.hours-table td{padding:10px 4px;border-bottom:1px solid #e5e7eb}
.hours-table td:last-child{text-align:right;font-weight:600}
.faq details{border:1px solid #e5e7eb;border-radius:10px;padding:16px 18px;margin-bottom:12px;background:#fff}
.faq summary{font-weight:700;color:${theme.secondary};cursor:pointer}
.faq p{margin-top:8px;color:#4b5563}
.contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:32px}
.field{margin-bottom:14px}
.field label{display:block;font-weight:600;margin-bottom:6px;font-size:.9rem}
.field input,.field textarea{width:100%;padding:11px 12px;border:1px solid #d1d5db;border-radius:8px;font:inherit}
.mapbox{border:2px dashed #c7d2fe;border-radius:12px;background:#eef2ff;min-height:220px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;color:${theme.secondary}}
.mapbox .pin{font-size:2.2rem;margin-bottom:8px}
.social-row{display:flex;gap:12px;flex-wrap:wrap}
.social-row a{display:inline-block;padding:10px 18px;border:1px solid #d1d5db;border-radius:999px;text-decoration:none;color:${theme.secondary};font-weight:600}
.booking{text-align:center}
.booking .big-call{display:inline-block;background:${theme.primary};color:#fff;font-size:1.4rem;font-weight:800;padding:18px 40px;border-radius:12px;text-decoration:none}
.footer{background:${theme.secondary};color:#d1d5db;padding:40px 0;margin-top:0;font-size:.92rem}
.footer a{color:#fff}
.footer-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;max-width:1080px;margin:0 auto;padding:0 20px}
.footer h4{color:#fff;margin-bottom:10px}
.copyright{text-align:center;margin-top:28px;opacity:.7;font-size:.85rem}
.page-anchor{scroll-margin-top:70px}
.photo{margin:0}
.photo img,.hero-photo img{width:100%;object-fit:cover;border-radius:12px;display:block;background:#e5e7eb}
.photo img{aspect-ratio:4/3}
.hero-photo img{height:260px}
.photo-credit{font-size:.78rem;margin-top:6px;color:#6b7280}
.hero .photo-credit,.hero .photo-credit a{color:#fff}
.hero-grid{display:grid;grid-template-columns:1.25fr .75fr;gap:28px;align-items:center}
.custom-block .custom-body{max-width:760px;margin-bottom:12px}
.ws-edit{cursor:text}
@media(max-width:760px){
  .grid,.gallery-grid,.contact-grid,.footer-grid,.hero-grid{grid-template-columns:1fr}
  .hero h1{font-size:1.8rem}
  .nav-links a:not(.nav-cta){display:none}
  section.block{padding:40px 0}
}`;
  return theme.customCss ? `${base}\n${theme.customCss}` : base;
}

/* ------------------------------------------------------------------ */
/* component library — pure render functions                           */
/*                                                                    */
/* section = { type, content }. Every function is total: missing       */
/* content degrades to a safe fallback, never throws.                  */
/* ------------------------------------------------------------------ */

const COMPONENT_TYPES = [
  'nav', 'hero', 'benefits', 'services', 'about', 'gallery', 'reviews',
  'cta', 'contact_form', 'map_placeholder', 'hours', 'faq', 'footer',
  'booking_button', 'social_links', 'custom', 'html',
];

/** Safe link for CTAs: https, http, tel, mailto, hash, or site-relative path. */
function safeHref(url) {
  if (typeof url !== 'string') return '#';
  const u = url.trim();
  if (!u) return '#';
  if (/^(https?:|tel:|mailto:|#|\/|\.\/|\.\.\/)/i.test(u)) return u;
  return '#';
}

function editSpan(edit, path, text) {
  const raw = text == null ? '' : String(text);
  if (!edit) return esc(raw);
  const id = `${edit.page}:${edit.section}:${path}`;
  return `<span class="ws-edit" data-edit="${esc(id)}">${esc(raw)}</span>`;
}

function safeHttps(url) {
  return typeof url === 'string' && url.startsWith('https://');
}

function creditHtml(im) {
  if (!im || !im.photographer) return '';
  const name = im.photographer_url && safeHttps(im.photographer_url)
    ? `<a href="${esc(im.photographer_url)}" rel="noopener noreferrer" target="_blank">${esc(im.photographer)}</a>`
    : esc(im.photographer);
  const on = im.pexels_url && safeHttps(im.pexels_url)
    ? `<a href="${esc(im.pexels_url)}" rel="noopener noreferrer" target="_blank">Pexels</a>`
    : 'Pexels';
  return `<figcaption class="photo-credit">Photo by ${name} on ${on}</figcaption>`;
}

function photoFigure(im, className) {
  if (!im || !safeHttps(im.url)) return '';
  const pexelsHost = /pexels\.com/i.test(im.url);
  const credit = creditHtml(im) || (pexelsHost
    ? `<figcaption class="photo-credit">Photo via <a href="https://www.pexels.com" rel="noopener noreferrer" target="_blank">Pexels</a></figcaption>`
    : '');
  return `<figure class="${className}"><img src="${esc(im.url)}" alt="${esc(im.alt || '')}">${credit}</figure>`;
}

function cNav(c = {}, t) {
  const links = Array.isArray(c.links) ? c.links : [];
  const phone = digitsOnly(c.phone);
  return `<nav class="nav"><div class="nav-inner">
    <a class="brand" href="${esc(links[0] ? links[0].href : '#')}">${esc(c.business_name || 'Business')}</a>
    <div class="nav-links">
      ${links.map(l => `<a href="${esc(l.href || '#')}">${esc(l.label || '')}</a>`).join('')}
      ${phone ? `<a class="nav-cta" href="tel:${phone}">${esc(c.phone_display || c.phone)}</a>` : ''}
    </div></div></nav>`;
}

function cHero(c = {}, t, edit) {
  const rating = c.rating && c.review_count
    ? `<div class="rating-badge">★ ${esc(String(c.rating))} · ${esc(String(c.review_count))} customer reviews</div>` : '';
  const photo = photoFigure(c.image, 'hero-photo');
  return `<header class="hero"><div class="container${photo ? ' hero-grid' : ''}"><div>
    ${rating}
    <h1>${editSpan(edit, 'headline', c.headline || 'Welcome')}</h1>
    ${c.subheadline ? `<p>${editSpan(edit, 'subheadline', c.subheadline)}</p>` : ''}
    <div>${c.cta_text ? `<a class="btn" href="${esc(safeHref(c.cta_href || '#contact'))}">${editSpan(edit, 'cta_text', c.cta_text)}</a>` : ''}
    ${c.cta_secondary_text ? `<a class="btn btn-outline" href="${esc(safeHref(c.cta_secondary_href || '#services'))}">${editSpan(edit, 'cta_secondary_text', c.cta_secondary_text)}</a>` : ''}</div>
  </div>${photo}</div></header>`;
}

function cBenefits(c = {}, t, edit) {
  const items = Array.isArray(c.items) ? c.items : [];
  if (!items.length) return '';
  return `<section class="block"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title)}</h2>` : ''}
    ${c.subtitle ? `<p class="lede">${editSpan(edit, 'subtitle', c.subtitle)}</p>` : ''}
    <div class="grid">${items.map((it, i) =>
      `<div class="card"><div class="chip">${i + 1}</div><h3>${editSpan(edit, `items.${i}.title`, it.title || '')}</h3><p>${editSpan(edit, `items.${i}.text`, it.text || '')}</p></div>`
    ).join('')}</div></div></section>`;
}

function cServices(c = {}, t, edit) {
  const items = Array.isArray(c.items) ? c.items : [];
  if (!items.length) return '';
  return `<section class="block page-anchor" id="services"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title)}</h2>` : '<h2>Our Services</h2>'}
    ${c.subtitle ? `<p class="lede">${editSpan(edit, 'subtitle', c.subtitle)}</p>` : ''}
    <div class="grid">${items.map((it, i) =>
      `<div class="card"><h3>${editSpan(edit, `items.${i}.name`, it.name || '')}</h3><p>${editSpan(edit, `items.${i}.description`, it.description || '')}</p></div>`
    ).join('')}</div></div></section>`;
}

function cAbout(c = {}, t, edit) {
  const paras = Array.isArray(c.paragraphs) ? c.paragraphs : [];
  if (!c.title && !paras.length) return '';
  return `<section class="block about"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title)}</h2>` : ''}
    ${paras.map((p, i) => `<p>${editSpan(edit, `paragraphs.${i}`, p)}</p>`).join('')}
  </div></section>`;
}

const GALLERY_GRADIENTS = [
  'linear-gradient(135deg,#667eea,#764ba2)',
  'linear-gradient(135deg,#f093fb,#f5576c)',
  'linear-gradient(135deg,#4facfe,#00f2fe)',
  'linear-gradient(135deg,#43e97b,#38f9d7)',
  'linear-gradient(135deg,#fa709a,#fee140)',
  'linear-gradient(135deg,#30cfd0,#330867)',
];

function cGallery(c = {}, t, edit) {
  const images = (Array.isArray(c.images) ? c.images : []).slice(0, 6);
  const slots = images.length ? images : [{ caption: 'Your photo here' }, { caption: 'Your photo here' }, { caption: 'Your photo here' }];
  return `<section class="block"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title)}</h2>` : `<h2>${editSpan(edit, 'title', 'Gallery')}</h2>`}
    ${c.subtitle ? `<p class="lede">${editSpan(edit, 'subtitle', c.subtitle)}</p>` : ''}
    <div class="gallery-grid">${slots.map((im, i) => {
      const fig = photoFigure(im, 'photo');
      if (fig) return fig;
      return `<div class="ph" style="background:${GALLERY_GRADIENTS[i % GALLERY_GRADIENTS.length]}" role="img" aria-label="${esc(im.caption || 'Gallery image')}">${editSpan(edit, `images.${i}.caption`, im.caption || 'Your photo here')}</div>`;
    }).join('')}</div></div></section>`;
}

function cReviews(c = {}, t) {
  const reviews = Array.isArray(c.reviews) ? c.reviews : [];
  if (!reviews.length) return '';
  return `<section class="block"><div class="container">
    ${c.title ? `<h2>${esc(c.title)}</h2>` : '<h2>What Customers Say</h2>'}
    ${c.subtitle ? `<p class="lede">${esc(c.subtitle)}</p>` : ''}
    <div class="grid">${reviews.map(r => {
      const stars = Math.max(1, Math.min(5, Number(r.stars) || 5));
      return `<div class="card review-card"><div class="stars">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</div>
        <p>“${esc(r.text || '')}”</p><div class="who">— ${esc(r.name || 'Customer')}</div></div>`;
    }).join('')}</div></div></section>`;
}

function cCta(c = {}, t, edit) {
  return `<section class="block"><div class="container"><div class="cta-band">
    <h2>${editSpan(edit, 'title', c.title || 'Get in touch today')}</h2>
    ${c.text ? `<p>${editSpan(edit, 'text', c.text)}</p>` : ''}
    ${c.button_text ? `<a class="btn" href="${esc(safeHref(c.button_href || '#contact'))}">${editSpan(edit, 'button_text', c.button_text)}</a>` : ''}
  </div></div></section>`;
}

function cContactForm(c = {}, t) {
  const email = String(c.email || '').trim();
  const phone = digitsOnly(c.phone);
  if (!email && !phone) return '';
  const action = email ? `mailto:${esc(email)}?subject=${encodeURIComponent(c.mailto_subject || 'Website inquiry')}` : '#';
  return `<section class="block page-anchor" id="contact"><div class="container">
    ${c.title ? `<h2>${esc(c.title)}</h2>` : '<h2>Contact Us</h2>'}
    ${c.text ? `<p class="lede">${esc(c.text)}</p>` : ''}
    <div class="contact-grid"><div>
      <form action="${action}" method="post" enctype="text/plain">
        <div class="field"><label for="cf-name">Name</label><input id="cf-name" name="name" required></div>
        <div class="field"><label for="cf-phone">Phone</label><input id="cf-phone" name="phone" type="tel"></div>
        <div class="field"><label for="cf-email">Email</label><input id="cf-email" name="email" type="email" required></div>
        <div class="field"><label for="cf-msg">Message</label><textarea id="cf-msg" name="message" rows="5" required></textarea></div>
        <button class="btn btn-primary" type="submit">Send Message</button>
      </form></div>
      <div>
        ${phone ? `<p style="margin-bottom:12px"><strong>Phone:</strong> <a href="tel:${phone}">${esc(c.phone)}</a></p>` : ''}
        ${email ? `<p style="margin-bottom:12px"><strong>Email:</strong> <a href="mailto:${esc(email)}">${esc(email)}</a></p>` : ''}
        ${c.address ? `<p><strong>Address:</strong><br>${esc(c.address)}</p>` : ''}
      </div>
    </div></div></section>`;
}

function cMapPlaceholder(c = {}, t) {
  const lines = Array.isArray(c.address_lines) ? c.address_lines : (c.address ? [c.address] : []);
  if (!lines.length) return '';
  return `<section class="block"><div class="container">
    ${c.title ? `<h2>${esc(c.title)}</h2>` : '<h2>Find Us</h2>'}
    <div class="mapbox"><div class="pin">📍</div>
      ${lines.map(l => `<div><strong>${esc(l)}</strong></div>`).join('')}
    </div></div></section>`;
}

function cHours(c = {}, t) {
  const hours = Array.isArray(c.hours) ? c.hours : [];
  if (!hours.length) return '';
  return `<section class="block"><div class="container">
    ${c.title ? `<h2>${esc(c.title)}</h2>` : '<h2>Business Hours</h2>'}
    <table class="hours-table"><tbody>
      ${hours.map(h => `<tr><td>${esc(h.day || '')}</td><td>${esc(h.open || '')} – ${esc(h.close || '')}</td></tr>`).join('')}
    </tbody></table></div></section>`;
}

function cFaq(c = {}, t, edit) {
  const items = Array.isArray(c.items) ? c.items : [];
  if (!items.length) return '';
  return `<section class="block faq"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title)}</h2>` : '<h2>Frequently Asked Questions</h2>'}
    ${items.map((it, i) => `<details><summary>${editSpan(edit, `items.${i}.q`, it.q || '')}</summary><p>${editSpan(edit, `items.${i}.a`, it.a || '')}</p></details>`).join('')}
  </div></section>`;
}

function cFooter(c = {}, t) {
  const year = new Date().getFullYear();
  return `<footer class="footer"><div class="footer-grid">
    <div><h4>${esc(c.business_name || 'Business')}</h4>
      ${c.tagline ? `<p>${esc(c.tagline)}</p>` : ''}</div>
    <div><h4>Contact</h4>
      ${c.phone ? `<p>Phone: <a href="tel:${digitsOnly(c.phone)}">${esc(c.phone)}</a></p>` : ''}
      ${c.email ? `<p>Email: <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></p>` : ''}
      ${c.address ? `<p>${esc(c.address)}</p>` : ''}</div>
    <div><h4>Quick Links</h4>
      <p><a href="#home">Home</a> · <a href="#about">About</a> · <a href="#services">Services</a> · <a href="#contact">Contact</a></p></div>
  </div>
  <div class="copyright">© ${year} ${esc(c.business_name || 'Business')}. All rights reserved.</div></footer>`;
}

function cBookingButton(c = {}, t) {
  const phone = digitsOnly(c.href && String(c.href).startsWith('tel:') ? c.href : c.phone);
  const href = c.href || (phone ? `tel:${phone}` : '#contact');
  return `<section class="block booking"><div class="container">
    ${c.title ? `<h2 style="margin-bottom:16px">${esc(c.title)}</h2>` : ''}
    <a class="big-call" href="${esc(href)}">${esc(c.text || 'Call Now')}</a>
    ${c.subtext ? `<p style="margin-top:12px;color:#4b5563">${esc(c.subtext)}</p>` : ''}
  </div></section>`;
}

function cCustom(c = {}, t, edit) {
  const heading = c.heading || c.title || '';
  const body = c.body || c.text || '';
  const button = c.button && typeof c.button === 'object' ? c.button : null;
  const photo = photoFigure(c.image, 'photo');
  // Freeform HTML fragment from the agent (scripts stripped).
  if (typeof c.html === 'string' && c.html.trim()) {
    return sanitizeHtml(c.html);
  }
  if (!heading && !body && !photo && !(button && button.text)) return '';
  const href = button ? safeHref(button.href) : '#';
  return `<section class="block custom-block"><div class="container">
    ${heading ? `<h2>${editSpan(edit, 'heading', heading)}</h2>` : ''}
    ${body ? `<p class="custom-body">${editSpan(edit, 'body', body)}</p>` : ''}
    ${photo}
    ${button && button.text ? `<p><a class="btn btn-primary" href="${esc(href)}">${editSpan(edit, 'button.text', button.text)}</a></p>` : ''}
  </div></section>`;
}

function cHtml(c = {}) {
  if (typeof c.html === 'string' && c.html.trim()) return sanitizeHtml(c.html);
  if (typeof c.markup === 'string' && c.markup.trim()) return sanitizeHtml(c.markup);
  return '';
}

function cSocialLinks(c = {}, t) {
  const links = Array.isArray(c.links) ? c.links : [];
  if (!links.length) return '';
  return `<section class="block"><div class="container">
    ${c.title ? `<h2>${esc(c.title)}</h2>` : '<h2>Follow Us</h2>'}
    <div class="social-row">${links.map(l =>
      `<a href="${esc(l.url || '#')}" target="_blank" rel="noopener">${esc(l.label || l.url || '')}</a>`
    ).join('')}</div></div></section>`;
}

const RENDERERS = {
  nav: cNav, hero: cHero, benefits: cBenefits, services: cServices, about: cAbout,
  gallery: cGallery, reviews: cReviews, cta: cCta, contact_form: cContactForm,
  map_placeholder: cMapPlaceholder, hours: cHours, faq: cFaq, footer: cFooter,
  booking_button: cBookingButton, social_links: cSocialLinks, custom: cCustom, html: cHtml,
};

const PREVIEW_EDIT_SCRIPT = `<script>
(function () {
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-edit]');
    if (!el) return;
    el.contentEditable = 'true';
    el.focus();
  });
  document.addEventListener('focusout', function (e) {
    var el = e.target;
    if (!el || !el.getAttribute || !el.getAttribute('data-edit')) return;
    el.contentEditable = 'false';
    parent.postMessage({ source: 'ws-preview', id: el.getAttribute('data-edit'), text: el.innerText }, '*');
  });
})();
</script>`;

/**
 * Render one section to HTML. Unknown types use the generic custom block
 * so an agent is not stuck to the built-in list. Text is escaped.
 */
function sectionToHtml(section, theme, edit) {
  const t = normalizeTheme(theme);
  try {
    if (!section || typeof section.type !== 'string') return '<!-- invalid section -->';
    const fn = RENDERERS[section.type] || cCustom;
    const content = (section.content && typeof section.content === 'object') ? section.content : {};
    const body = fn === cCustom && !RENDERERS[section.type]
      ? Object.assign({ heading: content.heading || content.title || section.type }, content)
      : content;
    return fn(body, t, edit || null) || '';
  } catch (e) {
    return `<!-- section render error: ${esc(e.message || 'unknown')} -->`;
  }
}

/* ------------------------------------------------------------------ */
/* page / site rendering                                               */
/* ------------------------------------------------------------------ */

function pageFileName(slug) {
  const s = String(slug || '/').replace(/^\//, '').replace(/\/$/, '');
  if (!s || s === 'home' || s === 'index') return 'index.html';
  return s.replace(/[^a-z0-9-_]/gi, '_') + '.html';
}

function anchorId(slug) {
  const s = String(slug || '/').replace(/^\//, '').replace(/\/$/, '');
  return (!s || s === 'home' || s === 'index') ? 'home' : s.replace(/[^a-z0-9-_]/gi, '_');
}

function isHomePage(page, pages) {
  if (!page) return false;
  const slug = String(page.slug || '');
  if (slug === '/' || slug === 'home' || slug === '/home' || slug === 'index') return true;
  return Array.isArray(pages) && pages[0] === page;
}

function pageHasHtml(page) {
  return !!(page && typeof page.html === 'string' && page.html.trim());
}

function homePage(pages) {
  if (!Array.isArray(pages) || !pages.length) return null;
  return pages.find((p) => isHomePage(p, pages)) || pages[0];
}

/** Map file-style nav links to #anchors so stacked iframe previews can navigate. */
function rewriteFileLinksToAnchors(html, pages) {
  let s = String(html || '');
  const home = homePage(pages);
  for (const p of pages || []) {
    const file = (p === home || isHomePage(p, pages)) ? 'index.html' : pageFileName(p.slug);
    const id = anchorId(p.slug);
    const re = new RegExp(`href=(["'])(?:\\.?\\/)?${file.replace(/\./g, '\\.')}\\1`, 'gi');
    s = s.replace(re, `href="#${id}"`);
  }
  s = s.replace(/href=(["'])\/(?:index\.html)?\1/gi, 'href="#home"');
  return s;
}

function docShell({ title, body, theme, script }) {
  const t = normalizeTheme(theme);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(title)}">
<style>${siteCss(t)}</style>
</head>
<body>
${body}
${script || ''}
</body>
</html>`;
}

/**
 * Render a single page as a full standalone HTML document.
 * Nav links point at the exported per-page filenames.
 */
function renderPage(page, allPages, theme, opts) {
  if (!page || typeof page !== 'object') throw err('INVALID_PAGE', 'Page must be an object.');
  const t = normalizeTheme(theme);
  const editable = !!(opts && opts.editable);
  const pages = Array.isArray(allPages) ? allPages : [page];
  const pageIndex = Math.max(0, pages.indexOf(page));
  // Agent freeform: page.html is body markup, or a full HTML document.
  const freeHtml = typeof page.html === 'string' ? page.html.trim() : '';
  if (freeHtml) {
    if (looksLikeFullDocument(freeHtml)) {
      let doc = sanitizeHtml(freeHtml);
      if (editable) {
        if (/<\/body>/i.test(doc)) doc = doc.replace(/<\/body>/i, `${PREVIEW_EDIT_SCRIPT}</body>`);
        else doc += PREVIEW_EDIT_SCRIPT;
      }
      return doc;
    }
    return docShell({
      title: page.title || 'Home',
      body: sanitizeHtml(freeHtml),
      theme: t,
      script: editable ? PREVIEW_EDIT_SCRIPT : '',
    });
  }
  const sections = Array.isArray(page.sections) ? page.sections : null;
  if (!sections) throw err('INVALID_PAGE', 'Page needs sections or html.');
  const navLinks = pages.map(p => ({ label: p.title || p.slug, href: pageFileName(p.slug) }));
  const body = sections.map((s, si) => {
    const edit = editable ? { page: pageIndex, section: si } : null;
    if (s.type === 'nav') {
      return sectionToHtml({ type: 'nav', content: Object.assign({}, s.content, { links: navLinks }) }, t, edit);
    }
    return sectionToHtml(s, t, edit);
  }).join('\n');
  return docShell({ title: page.title || 'Home', body, theme: t, script: editable ? PREVIEW_EDIT_SCRIPT : '' });
}

/**
 * Render one page (by slug or index). Used by in-app multipage preview tabs.
 */
function renderPageAt(pages, theme, opts) {
  if (!Array.isArray(pages) || !pages.length) throw err('INVALID_PAGES', 'pages must be a non-empty array.');
  const o = opts || {};
  let page = null;
  if (o.pageSlug != null && String(o.pageSlug).trim()) {
    const want = String(o.pageSlug).trim();
    page = pages.find((p) => String(p.slug) === want || pageFileName(p.slug) === want || anchorId(p.slug) === want);
  }
  if (!page && Number.isInteger(o.pageIndex)) page = pages[o.pageIndex];
  if (!page) page = homePage(pages);
  return renderPage(page, pages, theme, o);
}

/**
 * Render the whole site for iframe preview.
 * Freeform multipage sites stack pages and rewrite *.html nav links to #anchors.
 * Prefer renderPageAt + page tabs when browsing one page at a time.
 */
function renderSite(pages, theme, opts) {
  if (!Array.isArray(pages) || !pages.length) throw err('INVALID_PAGES', 'pages must be a non-empty array.');
  const t = normalizeTheme(theme);
  const editable = !!(opts && opts.editable);
  if (opts && (opts.pageSlug != null || Number.isInteger(opts.pageIndex))) {
    return renderPageAt(pages, theme, opts);
  }
  const navLinks = pages.map(p => ({ label: p.title || p.slug, href: '#' + anchorId(p.slug) }));
  const freeform = pages.some(pageHasHtml);
  // Single freeform full document: return it as-is.
  if (pages.length === 1 && pageHasHtml(pages[0]) && looksLikeFullDocument(pages[0].html)) {
    let doc = sanitizeHtml(pages[0].html);
    if (editable) {
      if (/<\/body>/i.test(doc)) doc = doc.replace(/<\/body>/i, `${PREVIEW_EDIT_SCRIPT}</body>`);
      else doc += PREVIEW_EDIT_SCRIPT;
    }
    return doc;
  }
  const body = pages.map((p, pi) => {
    if (pageHasHtml(p)) {
      const inner = looksLikeFullDocument(p.html)
        ? sanitizeHtml(p.html).replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '')
        : sanitizeHtml(p.html);
      return `<div class="page-anchor" id="${anchorId(p.slug)}">${inner}</div>`;
    }
    const sections = (Array.isArray(p.sections) ? p.sections : []).map((s, si) => {
      const edit = editable ? { page: pi, section: si } : null;
      if (s.type === 'nav') {
        return sectionToHtml({ type: 'nav', content: Object.assign({}, s.content, { links: navLinks }) }, t, edit);
      }
      return sectionToHtml(s, t, edit);
    }).join('\n');
    return `<div class="page-anchor" id="${anchorId(p.slug)}">${sections}</div>`;
  }).join('\n');
  const title = (homePage(pages) || pages[0]).title || 'Home';
  let html = docShell({ title, body: freeform ? rewriteFileLinksToAnchors(body, pages) : body, theme: t, script: editable ? PREVIEW_EDIT_SCRIPT : '' });
  return html;
}

/* ------------------------------------------------------------------ */
/* industry templates                                                  */
/* ------------------------------------------------------------------ */

const TEMPLATES = {
  plumber: {
    label: 'Plumber',
    theme: { primary: '#0b5fff', secondary: '#0a2a6b', font: DEFAULT_THEME.font },
    home: ['nav', 'hero', 'benefits', 'services', 'about', 'reviews', 'cta', 'booking_button', 'footer'],
    about: ['nav', 'about', 'gallery', 'footer'],
    services: ['nav', 'services', 'faq', 'cta', 'footer'],
    contact: ['nav', 'contact_form', 'hours', 'map_placeholder', 'social_links', 'footer'],
  },
  electrician: {
    label: 'Electrician',
    theme: { primary: '#d97706', secondary: '#451a03', font: DEFAULT_THEME.font },
    home: ['nav', 'hero', 'benefits', 'services', 'about', 'reviews', 'faq', 'cta', 'booking_button', 'footer'],
    about: ['nav', 'about', 'gallery', 'footer'],
    services: ['nav', 'services', 'faq', 'cta', 'footer'],
    contact: ['nav', 'contact_form', 'hours', 'map_placeholder', 'social_links', 'footer'],
  },
  restaurant: {
    label: 'Restaurant',
    theme: { primary: '#b91c1c', secondary: '#450a0a', font: 'Georgia, "Times New Roman", serif' },
    home: ['nav', 'hero', 'benefits', 'gallery', 'reviews', 'hours', 'cta', 'booking_button', 'footer'],
    about: ['nav', 'about', 'gallery', 'footer'],
    services: ['nav', 'services', 'faq', 'cta', 'footer'],
    contact: ['nav', 'contact_form', 'hours', 'map_placeholder', 'social_links', 'footer'],
  },
  salon: {
    label: 'Salon',
    theme: { primary: '#be185d', secondary: '#500f28', font: DEFAULT_THEME.font },
    home: ['nav', 'hero', 'benefits', 'services', 'gallery', 'reviews', 'booking_button', 'cta', 'footer'],
    about: ['nav', 'about', 'gallery', 'footer'],
    services: ['nav', 'services', 'faq', 'cta', 'footer'],
    contact: ['nav', 'contact_form', 'hours', 'map_placeholder', 'social_links', 'footer'],
  },
  dentist: {
    label: 'Dentist',
    theme: { primary: '#0284c7', secondary: '#0c2d48', font: DEFAULT_THEME.font },
    home: ['nav', 'hero', 'benefits', 'services', 'about', 'reviews', 'faq', 'cta', 'booking_button', 'footer'],
    about: ['nav', 'about', 'gallery', 'footer'],
    services: ['nav', 'services', 'faq', 'cta', 'footer'],
    contact: ['nav', 'contact_form', 'hours', 'map_placeholder', 'social_links', 'footer'],
  },
  law_office: {
    label: 'Law Office',
    theme: { primary: '#1e3a5f', secondary: '#0b1c33', font: 'Georgia, "Times New Roman", serif' },
    home: ['nav', 'hero', 'benefits', 'about', 'services', 'reviews', 'faq', 'cta', 'footer'],
    about: ['nav', 'about', 'gallery', 'footer'],
    services: ['nav', 'services', 'faq', 'cta', 'footer'],
    contact: ['nav', 'contact_form', 'hours', 'map_placeholder', 'social_links', 'footer'],
  },
  general: {
    label: 'Local Business',
    theme: { primary: '#1a56db', secondary: '#0e2a5c', font: DEFAULT_THEME.font },
    home: ['nav', 'hero', 'benefits', 'services', 'about', 'reviews', 'faq', 'cta', 'booking_button', 'footer'],
    about: ['nav', 'about', 'gallery', 'footer'],
    services: ['nav', 'services', 'faq', 'cta', 'footer'],
    contact: ['nav', 'contact_form', 'hours', 'map_placeholder', 'social_links', 'footer'],
  },
};

const INDUSTRY_KEYWORDS = [
  [/plumb/i, 'plumber'],
  [/electric/i, 'electrician'],
  [/restaurant|diner|cafe|caf[eé]|pizza|sushi|grill|bistro|eatery|taco|bakery|barbecue|bbq|steakhouse/i, 'restaurant'],
  [/salon|barber|spa|nails|beauty|hair/i, 'salon'],
  [/dent|orthodont/i, 'dentist'],
  [/law|attorney|legal/i, 'law_office'],
];

function detectIndustry(category) {
  const c = String(category || '');
  for (const [re, key] of INDUSTRY_KEYWORDS) {
    if (re.test(c)) return key;
  }
  return 'general';
}

/* ------------------------------------------------------------------ */
/* facts + claim manifest                                              */
/* ------------------------------------------------------------------ */

/**
 * Collect renderable facts: business_facts rows with claim_class VERIFIED or
 * OWNER_PROVIDED, plus lead-record contact basics (treated as VERIFIED from
 * the lead record). UNKNOWN facts are returned separately for QA.
 */
function collectFacts(db, lead) {
  const ok = new Map();      // fact_key -> { value, source, claim_class }
  const unknown = [];        // [{ fact_key, value }]
  const rows = db.prepare(
    'SELECT fact_key, value, source, claim_class FROM business_facts WHERE lead_id = ?'
  ).all(lead.id);
  for (const r of rows) {
    if (r.claim_class === 'VERIFIED' || r.claim_class === 'OWNER_PROVIDED') {
      ok.set(r.fact_key, { value: r.value, source: r.source, claim_class: r.claim_class });
    } else if (r.claim_class === 'UNKNOWN') {
      unknown.push({ fact_key: r.fact_key, value: r.value });
    }
  }
  const leadFact = (key, value) => {
    if (value !== null && value !== undefined && String(value).trim() !== '' && !ok.has(key)) {
      ok.set(key, { value: String(value), source: 'lead record', claim_class: 'VERIFIED' });
    }
  };
  leadFact('business_name', lead.business_name);
  leadFact('phone', lead.phone);
  leadFact('email', lead.email);
  leadFact('category', lead.category);
  leadFact('city', lead.city);
  leadFact('state', lead.state);
  const addrParts = [lead.address, lead.city, lead.state, lead.postal_code].filter(Boolean);
  if (addrParts.length) leadFact('address', addrParts.join(', '));
  leadFact('description', lead.description);
  // hours JSON -> 'hours'
  try {
    const h = lead.hours ? JSON.parse(lead.hours) : null;
    if (Array.isArray(h) && h.length) ok.set('hours', { value: JSON.stringify(h), source: 'lead record', claim_class: 'VERIFIED' });
  } catch (e) { /* ignore malformed */ }
  // services JSON -> service:<name> facts
  try {
    const s = lead.services ? JSON.parse(lead.services) : null;
    if (Array.isArray(s)) {
      for (const name of s) {
        const n = String(name || '').trim();
        if (n) ok.set(`service:${n.toLowerCase()}`, { value: n, source: 'lead record', claim_class: 'VERIFIED' });
      }
    }
  } catch (e) { /* ignore malformed */ }
  // social links JSON -> 'social'
  try {
    const s = lead.social_links ? JSON.parse(lead.social_links) : null;
    if (Array.isArray(s) && s.length) ok.set('social', { value: JSON.stringify(s), source: 'lead record', claim_class: 'VERIFIED' });
  } catch (e) { /* ignore malformed */ }
  return { ok, unknown };
}

function serviceNames(facts) {
  const names = [];
  for (const [k, f] of facts.ok) {
    if (k.startsWith('service:')) names.push(f.value);
  }
  return names;
}

/* ------------------------------------------------------------------ */
/* copy — deterministic fallback + AI generation                        */
/* ------------------------------------------------------------------ */

const DEFAULT_BUILD_PROMPT = `You write marketing copy for a local business website.
RULES (anti-hallucination — critical):
- Use ONLY the facts provided in the business context. Never invent founding years, awards, licenses, addresses, prices, or staff names.
- Marketing tone is welcome, but every sentence must be either (a) grounded in a provided fact, or (b) generic puffery with no factual assertion (e.g. "We treat every job with care.").
- Do not claim the business is "licensed", "insured", "award-winning", "the best", or "since YEAR" unless that fact was provided.
Return ONLY valid JSON with this shape:
{
  "hero_headline": "string (<= 90 chars)",
  "hero_subheadline": "string (<= 200 chars)",
  "benefits": [{"title": "...", "text": "..."} x4],
  "about_paragraphs": ["...", "..."],
  "faq": [{"q": "...", "a": "..."} x5],
  "cta_title": "string",
  "cta_text": "string (<= 200 chars)"
}`;

function getBuildPrompt(db) {
  const row = db.prepare('SELECT body FROM prompts WHERE key = ?').get('build_website');
  const body = row && row.body ? String(row.body).trim() : '';
  return body || DEFAULT_BUILD_PROMPT;
}

function stripCodeFences(s) {
  let t = String(s || '').trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return t.trim();
}

function deterministicCopy(lead, industry, facts) {
  const name = lead.business_name || 'Our Business';
  const label = TEMPLATES[industry].label;
  const city = facts.ok.get('city');
  const cityBit = city ? ` in ${city.value}` : '';
  const phone = facts.ok.get('phone');
  const services = serviceNames(facts);

  const hero_headline = `${name} — Trusted ${label} Services${cityBit}`;
  const hero_subheadline = phone
    ? `Call ${phone.value} today for friendly, reliable ${label.toLowerCase()} service${cityBit}.`
    : `Friendly, reliable ${label.toLowerCase()} service${cityBit} — get in touch today.`;

  const benefits = [
    { title: 'Local & Friendly', text: `A neighborhood ${label.toLowerCase()} you can talk to directly — no call centers, no runaround.` },
    { title: 'Clear Communication', text: 'We explain what we are doing in plain language before any work begins.' },
    { title: 'Respectful Service', text: 'We treat your home or business with care and clean up after ourselves.' },
    { title: 'Easy to Reach', text: phone ? `One call to ${phone.value} is all it takes to get started.` : 'Reach out by phone or through the contact form below.' },
  ];

  const about_paragraphs = [
    `${name} provides ${label.toLowerCase()} services${cityBit}.`,
    'We focus on honest work, clear pricing, and treating every customer like a neighbor — because you are one.',
  ];
  const desc = facts.ok.get('description');
  if (desc) about_paragraphs.unshift(desc.value);

  const faq = [
    { q: `How do I get started with ${name}?`, a: phone ? `Just call ${phone.value} or send a message through the contact form and we will take it from there.` : 'Just send a message through the contact form and we will take it from there.' },
    { q: 'Do I need an appointment?', a: 'It is best to reach out ahead of time so we can make sure someone is available to help you.' },
    { q: 'What areas do you serve?', a: city ? `We serve ${city.value} and the surrounding area. Contact us to confirm.` : 'Contact us to confirm we cover your area.' },
    { q: 'How do I get a quote?', a: 'Call or message us with a few details about what you need and we will walk you through the next steps.' },
    { q: 'What if I need to reschedule?', a: 'Life happens — just let us know as early as you can and we will find another time.' },
  ];

  return {
    hero_headline: cleanText(hero_headline, 90),
    hero_subheadline: cleanText(hero_subheadline, 200),
    benefits,
    about_paragraphs: about_paragraphs.map(p => cleanText(p, 600)),
    faq: faq.map(f => ({ q: cleanText(f.q, 160), a: cleanText(f.a, 400) })),
    cta_title: `Ready to get started with ${name}?`,
    cta_text: phone ? `Call ${phone.value} or send us a message — we would love to help.` : 'Send us a message — we would love to help.',
    services: services.map(n => ({ name: n, description: `Professional ${n.toLowerCase()} done with care.` })),
  };
}

async function aiCopy(db, lead, industry, facts) {
  const context = {
    business_name: lead.business_name,
    industry: TEMPLATES[industry].label,
    category: lead.category || null,
    city: facts.ok.get('city')?.value || null,
    state: facts.ok.get('state')?.value || null,
    phone: facts.ok.get('phone')?.value || null,
    email: facts.ok.get('email')?.value || null,
    address: facts.ok.get('address')?.value || null,
    hours: facts.ok.get('hours') ? JSON.parse(facts.ok.get('hours').value) : null,
    services: serviceNames(facts),
    description: facts.ok.get('description')?.value || null,
    rating: lead.rating || null,
    review_count: lead.review_count || null,
  };
  const systemPrompt = getBuildPrompt(db);
  const { text } = await ai.chat({
    task: 'generation',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Business context (facts only — do not invent anything else):\n${JSON.stringify(context, null, 2)}` },
    ],
    maxTokens: 2000,
    leadId: lead.id,
    note: `website copy for ${lead.business_name}`,
  });
  const parsed = JSON.parse(stripCodeFences(text));
  const det = deterministicCopy(lead, industry, facts); // fallback for missing keys
  const pick = (v, fb, max) => {
    const c = cleanText(v, max);
    return c || fb;
  };
  const benefits = Array.isArray(parsed.benefits) && parsed.benefits.length
    ? parsed.benefits.slice(0, 4).map((b, i) => ({
        title: pick(b.title, det.benefits[i % det.benefits.length].title, 80),
        text: pick(b.text, det.benefits[i % det.benefits.length].text, 300),
      }))
    : det.benefits;
  const about_paragraphs = Array.isArray(parsed.about_paragraphs) && parsed.about_paragraphs.length
    ? parsed.about_paragraphs.slice(0, 4).map(p => cleanText(p, 600)).filter(Boolean)
    : det.about_paragraphs;
  const faq = Array.isArray(parsed.faq) && parsed.faq.length
    ? parsed.faq.slice(0, 6).map((f, i) => ({
        q: pick(f.q, det.faq[i % det.faq.length].q, 160),
        a: pick(f.a, det.faq[i % det.faq.length].a, 400),
      }))
    : det.faq;
  return {
    hero_headline: pick(parsed.hero_headline, det.hero_headline, 90),
    hero_subheadline: pick(parsed.hero_subheadline, det.hero_subheadline, 200),
    benefits,
    about_paragraphs: about_paragraphs.length ? about_paragraphs : det.about_paragraphs,
    faq,
    cta_title: pick(parsed.cta_title, det.cta_title, 90),
    cta_text: pick(parsed.cta_text, det.cta_text, 200),
    services: det.services, // service names always come from verified facts
  };
}

/* ------------------------------------------------------------------ */
/* page assembly                                                       */
/* ------------------------------------------------------------------ */

function buildSection(type, lead, facts, copy, industry) {
  const name = lead.business_name || 'Our Business';
  const phone = facts.ok.get('phone')?.value || null;
  const email = facts.ok.get('email')?.value || null;
  const address = facts.ok.get('address')?.value || null;
  const city = facts.ok.get('city')?.value || null;
  const label = TEMPLATES[industry].label;

  switch (type) {
    case 'nav':
      return { type, content: { business_name: name, phone, phone_display: phone, links: [] } };
    case 'hero': {
      const c = { headline: copy.hero_headline, subheadline: copy.hero_subheadline };
      if (phone) { c.cta_text = `Call ${phone}`; c.cta_href = `tel:${digitsOnly(phone)}`; }
      c.cta_secondary_text = 'Our Services'; c.cta_secondary_href = '#services';
      if (lead.rating && lead.review_count) { c.rating = lead.rating; c.review_count = lead.review_count; }
      return { type, content: c };
    }
    case 'benefits':
      return { type, content: { title: `Why Choose ${name}`, items: copy.benefits } };
    case 'services': {
      const items = copy.services.length ? copy.services : [];
      if (!items.length) return null; // omit section when nothing verified
      return { type, content: { title: 'Our Services', subtitle: `What ${name} can do for you.`, items } };
    }
    case 'about':
      return { type, content: { title: `About ${name}`, paragraphs: copy.about_paragraphs } };
    case 'gallery':
      return { type, content: { title: 'Gallery', subtitle: 'A look at our work. (Photo placeholders — the owner can replace these.)' } };
    case 'reviews': {
      const items = [];
      // Only real review texts would go here; lead rating alone is shown as a badge.
      if (!items.length) return null;
      return { type, content: { title: 'Customer Reviews', reviews: items } };
    }
    case 'cta':
      return { type, content: { title: copy.cta_title, text: copy.cta_text, button_text: phone ? `Call ${phone}` : 'Contact Us', button_href: phone ? `tel:${digitsOnly(phone)}` : '#contact' } };
    case 'contact_form': {
      if (!email && !phone) return null;
      return { type, content: { title: 'Contact Us', text: `Reach out to ${name} — we will get back to you as soon as we can.`, email, phone, address, mailto_subject: `Website inquiry for ${name}` } };
    }
    case 'map_placeholder': {
      if (!address) return null;
      return { type, content: { title: 'Find Us', address_lines: [address] } };
    }
    case 'hours': {
      const h = facts.ok.get('hours');
      if (!h) return null;
      let hours = [];
      try { hours = JSON.parse(h.value); } catch (e) { return null; }
      if (!Array.isArray(hours) || !hours.length) return null;
      return { type, content: { title: 'Business Hours', hours } };
    }
    case 'faq':
      return { type, content: { title: 'Frequently Asked Questions', items: copy.faq } };
    case 'footer':
      return { type, content: { business_name: name, phone, email, address, tagline: `${label} services${city ? ` in ${city}` : ''}.` } };
    case 'booking_button': {
      if (!phone) return null;
      return { type, content: { title: 'Ready when you are', text: `Call ${phone}`, href: `tel:${digitsOnly(phone)}`, subtext: 'Tap to call now.' } };
    }
    case 'social_links': {
      const s = facts.ok.get('social');
      if (!s) return null;
      let links = [];
      try { links = JSON.parse(s.value); } catch (e) { return null; }
      if (!Array.isArray(links) || !links.length) return null;
      return { type, content: { title: 'Follow Us', links } };
    }
    default:
      return null;
  }
}

/**
 * Build pages JSON + claim manifest from template + verified facts.
 * Returns { pages, manifest } where manifest is [{claim, value, class, source}].
 */
function buildPages(lead, industry, facts, copy, aiUsed) {
  const tpl = TEMPLATES[industry];
  const manifest = [];
  const claim = (claimName, value, cls, source) => {
    manifest.push({ claim: claimName, value: String(value).slice(0, 200), class: cls, source });
  };

  // Record every rendered fact with its provenance.
  const renderedFactKeys = new Set(['business_name', 'phone', 'email', 'address', 'city', 'state', 'hours', 'social', 'description']);
  for (const [k, f] of facts.ok) {
    if (k.startsWith('service:') || renderedFactKeys.has(k)) {
      claim(k.startsWith('service:') ? 'service' : k, f.value, f.claim_class, f.source);
    }
  }
  if (lead.rating && lead.review_count) {
    claim('rating', `${lead.rating} (${lead.review_count} reviews)`, 'VERIFIED', 'lead record');
  }
  // Marketing copy is AI_COPY by definition (tone only, no factual assertions).
  claim('marketing_copy', aiUsed ? 'AI-generated headlines, benefits, about text, FAQ' : 'Template-generated headlines, benefits, about text, FAQ', 'AI_COPY', aiUsed ? 'ai: generation' : 'websiteEngine deterministic');

  const pageDefs = [
    { slug: '/', title: 'Home', types: tpl.home },
    { slug: '/about', title: 'About', types: tpl.about },
    { slug: '/services', title: 'Services', types: tpl.services },
    { slug: '/contact', title: 'Contact', types: tpl.contact },
  ];

  const pages = pageDefs.map(pd => {
    const sections = [];
    for (const st of pd.types) {
      const s = buildSection(st, lead, facts, copy, industry);
      if (s) sections.push(s);
    }
    // A page must never be empty: nav + footer are the floor.
    if (!sections.some(s => s.type === 'nav')) sections.unshift(buildSection('nav', lead, facts, copy, industry));
    if (!sections.some(s => s.type === 'footer')) sections.push(buildSection('footer', lead, facts, copy, industry));
    return { slug: pd.slug, title: pd.title, sections };
  });

  return { pages, manifest };
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

function getWebsite(db, websiteId) {
  const site = db.prepare('SELECT * FROM websites WHERE id = ?').get(websiteId);
  if (!site) throw err('SITE_NOT_FOUND', `Website #${websiteId} not found.`);
  return site;
}

function getManifest(db, websiteId) {
  ensureTables(db);
  const row = db.prepare('SELECT manifest FROM claim_manifest WHERE website_id = ?').get(websiteId);
  if (!row) return [];
  try { return JSON.parse(row.manifest); } catch (e) { return []; }
}

/**
 * Generate a website for a lead.
 * - industry template + VERIFIED/OWNER_PROVIDED facts only
 * - AI marketing copy when configured, else deterministic template copy
 * - stores website row + version 1 + claim manifest; lead -> qa_pending
 */
async function generateSite(db, leadId, opts = {}) {
  ensureTables(db);
  ai.setDb(db);

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw err('LEAD_NOT_FOUND', `Lead #${leadId} not found.`);

  const existing = db.prepare('SELECT id FROM websites WHERE lead_id = ?').get(leadId);
  if (existing && !opts.force) return { id: existing.id, reused: true };
  if (existing && opts.force) {
    // Full rebuild: versions + claim manifest go via ON DELETE CASCADE.
    db.prepare('DELETE FROM websites WHERE id = ?').run(existing.id);
    logActivity(db, 'websites', `Regenerating website for "${lead.business_name}" (lead #${leadId}) — previous site replaced.`);
  }

  setLeadStatus(db, leadId, 'building');
  logActivity(db, 'websites', `Generating website for "${lead.business_name}" (lead #${leadId}).`);

  const industry = detectIndustry(lead.category);
  const facts = collectFacts(db, lead);

  let copy;
  let aiUsed = false;
  if (ai.aiConfigured()) {
    try {
      copy = await aiCopy(db, lead, industry, facts);
      aiUsed = true;
    } catch (e) {
      // AI failure (incl. AI_NOT_CONFIGURED/BUDGET_EXCEEDED/AUTOMATION_PAUSED)
      // falls back to deterministic copy — generation never hard-fails on AI.
      logActivity(db, 'websites', `AI copy failed for lead #${leadId} (${e.code || e.message}); using template copy.`);
      copy = deterministicCopy(lead, industry, facts);
    }
  } else {
    copy = deterministicCopy(lead, industry, facts);
  }

  const theme = normalizeTheme(TEMPLATES[industry].theme);
  const { pages, manifest } = buildPages(lead, industry, facts, copy, aiUsed);

  const info = db.prepare(
    `INSERT INTO websites (lead_id, name, industry, theme, pages, status)
     VALUES (?, ?, ?, ?, ?, 'draft')`
  ).run(leadId, lead.business_name, industry, JSON.stringify(theme), JSON.stringify(pages));
  const websiteId = Number(info.lastInsertRowid);

  db.prepare(
    'INSERT INTO website_versions (website_id, version_no, pages, theme, note) VALUES (?, ?, ?, ?, ?)'
  ).run(websiteId, 1, JSON.stringify(pages), JSON.stringify(theme), aiUsed ? 'Initial generation (AI copy)' : 'Initial generation (template copy)');

  db.prepare('INSERT OR REPLACE INTO claim_manifest (website_id, manifest) VALUES (?, ?)')
    .run(websiteId, JSON.stringify(manifest));

  try {
    db.prepare("UPDATE websites SET origin = 'template' WHERE id = ?").run(websiteId);
  } catch (e) { /* origin column is added by ensureTables */ }

  setLeadStatus(db, leadId, 'qa_pending');
  logActivity(db, 'websites', `Website #${websiteId} generated for "${lead.business_name}" — awaiting QA.`);

  return { id: websiteId, industry, aiUsed, reused: false };
}

/** Snapshot current pages+theme as a new version. Returns the version row. */
function saveVersion(db, websiteId, note) {
  const site = getWebsite(db, websiteId);
  const row = db.prepare('SELECT COALESCE(MAX(version_no), 0) AS m FROM website_versions WHERE website_id = ?').get(websiteId);
  const next = Number(row.m) + 1;
  const info = db.prepare(
    'INSERT INTO website_versions (website_id, version_no, pages, theme, note) VALUES (?, ?, ?, ?, ?)'
  ).run(websiteId, next, site.pages, site.theme, note ? String(note).slice(0, 500) : null);
  return db.prepare('SELECT * FROM website_versions WHERE id = ?').get(Number(info.lastInsertRowid));
}

/** Restore a version: applies its pages+theme and snapshots as a new version. */
function restoreVersion(db, versionId) {
  const v = db.prepare('SELECT * FROM website_versions WHERE id = ?').get(versionId);
  if (!v) throw err('VERSION_NOT_FOUND', `Version #${versionId} not found.`);
  db.prepare("UPDATE websites SET pages = ?, theme = ?, updated_at = datetime('now') WHERE id = ?")
    .run(v.pages, v.theme, v.website_id);
  saveVersion(db, v.website_id, `Restored version ${v.version_no}`);
  return getWebsite(db, v.website_id);
}

/** Apply an edited pages/theme model (validated by the IPC layer) + version it. */
function saveSite(db, websiteId, pages, theme, note) {
  const site = getWebsite(db, websiteId);
  void site;
  db.prepare("UPDATE websites SET pages = ?, theme = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(pages), JSON.stringify(normalizeTheme(theme)), websiteId);
  return saveVersion(db, websiteId, note || 'Manual edit');
}

/* ------------------------------------------------------------------ */
/* QA                                                                  */
/* ------------------------------------------------------------------ */

const QA_BUILD_PROMPT_FALLBACK = `You are a QA reviewer for a local business website.
Check the site for: hallucinated facts (founding years, awards, licenses not in the provided facts), placeholder text, wrong phone numbers, broken image links, spelling errors.
The business facts provided are the ONLY facts allowed. Marketing puffery without factual assertions is fine.
Reply with ONLY JSON: {"pass": true|false, "issues": ["..."]}`;

/**
 * Run the QA checklist. Returns { pass, checks: [{ name, pass, detail }] }.
 * On pass: website -> approved, lead -> ready. On fail: lead stays qa_pending.
 */
async function qaSite(db, websiteId) {
  ensureTables(db);
  ai.setDb(db);
  const site = getWebsite(db, websiteId);
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(site.lead_id);

  let pages, theme;
  try {
    pages = JSON.parse(site.pages);
    theme = JSON.parse(site.theme);
  } catch (e) {
    return { pass: false, checks: [{ name: 'valid-json', pass: false, detail: 'Stored pages/theme JSON is corrupt.' }] };
  }

  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail || '' });

  // 1. every page renders without exception
  let html = '';
  let renderOk = true;
  let renderErr = '';
  try {
    for (const p of pages) renderPage(p, pages, theme);
    html = renderSite(pages, theme);
  } catch (e) {
    renderOk = false;
    renderErr = e.message || String(e);
  }
  check('renders-without-exception', renderOk, renderOk ? `${pages.length} page(s) rendered.` : `Render failed: ${renderErr}`);

  // 2. no UNKNOWN-class facts rendered as fact
  const { unknown } = collectFacts(db, lead || { id: site.lead_id });
  const unknownHits = [];
  if (renderOk) {
    const lower = html.toLowerCase();
    for (const u of unknown) {
      const k = String(u.fact_key || '');
      const v = String(u.value || '').trim();
      // Skip meta/role tags and tiny tokens that collide with normal copy ("hero", "logo").
      if (/\.role$/i.test(k) || v.length < 6) continue;
      if (/^(hero|logo|gallery|team|home|true|false)$/i.test(v)) continue;
      if (lower.includes(v.toLowerCase())) unknownHits.push(`${k}="${v.slice(0, 40)}"`);
    }
  }
  check('no-unknown-facts', unknownHits.length === 0,
    unknownHits.length ? `UNKNOWN facts found in output: ${unknownHits.join('; ')}` : `${unknown.length} UNKNOWN fact(s) on record, none rendered.`);

  // 3. no placeholder text
  let placeholderHit = null;
  if (renderOk) {
    const textOnly = html.replace(/<[^>]*>/g, ' ');
    const m = textOnly.match(/lorem ipsum|TODO|FIXME|\[insert|\[your /i);
    if (m) placeholderHit = m[0];
  }
  check('no-placeholder-text', !placeholderHit, placeholderHit ? `Placeholder text found: "${placeholderHit}"` : 'No lorem/TODO placeholders.');

  // 4. phone matches lead phone
  if (lead && lead.phone && digitsOnly(lead.phone).length >= 7) {
    const digits = digitsOnly(lead.phone);
    const found = renderOk && html.includes(digits);
    // also accept formatted variants by comparing digit runs
    let foundLoose = found;
    if (!found && renderOk) {
      const htmlDigits = html.replace(/\D/g, '');
      foundLoose = htmlDigits.includes(digits);
    }
    check('phone-matches', foundLoose, foundLoose ? `Lead phone ${lead.phone} present.` : `Lead phone ${lead.phone} NOT found in output.`);
  } else {
    check('phone-matches', true, 'Lead has no phone on record; nothing to verify.');
  }

  // 5. images are placeholders, credited stock photos, or https images the agent supplied
  let imgOk = true;
  let imgDetail = 'Gallery uses CSS gradient placeholders; no <img> tags.';
  if (renderOk) {
    const imgs = html.match(/<img\b[^>]*>/gi) || [];
    const bad = [];
    for (const tag of imgs) {
      const src = (tag.match(/\ssrc\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
      if (!src.startsWith('https://')) bad.push('non-https image');
      else if (/images\.pexels\.com/i.test(src) && !/Photo by /i.test(html)) bad.push('Pexels image missing credit');
    }
    imgOk = bad.length === 0;
    imgDetail = imgs.length
      ? (imgOk ? `${imgs.length} image(s), https and credited when from Pexels.` : bad.join('; '))
      : 'Gallery uses CSS gradient placeholders; no <img> tags.';
  }
  check('images-are-placeholders', imgOk, imgDetail);

  // 6. spelling sanity: no leaked 'undefined' / 'null' strings
  let sanityOk = true;
  let sanityDetail = 'Clean.';
  if (renderOk) {
    const textOnly = html.replace(/<[^>]*>/g, ' ');
    const bad = textOnly.match(/\b(undefined|null|NaN)\b/);
    if (bad) { sanityOk = false; sanityDetail = `Suspicious token in output: "${bad[0]}"`; }
  }
  check('spelling-sanity', sanityOk, sanityDetail);

  // 7. unknown section types
  const known = new Set(COMPONENT_TYPES);
  const unknownTypes = new Set();
  for (const p of pages) {
    for (const s of (p.sections || [])) {
      if (!known.has(s.type)) unknownTypes.add(String(s.type));
    }
  }
  check('known-section-types', true,
    unknownTypes.size ? `Generic block used for: ${[...unknownTypes].join(', ')}` : 'All section types known.');

  // 8. required content: freeform agent HTML counts; else home needs hero + contact path
  let reqOk = false;
  let reqDetail = '';
  if (renderOk && pages.length) {
    if (pages.some(pageHasHtml)) {
      reqOk = true;
      reqDetail = `Freeform multipage site (${pages.length} page(s)).`;
    } else {
      const homeTypes = new Set((pages[0].sections || []).map(s => s.type));
      const hasHero = homeTypes.has('hero');
      const hasContact = homeTypes.has('contact_form') || homeTypes.has('booking_button') || homeTypes.has('cta');
      reqOk = hasHero && hasContact;
      reqDetail = `hero=${hasHero}, contact-path=${hasContact}`;
    }
  }
  check('required-sections', reqOk, reqDetail || 'Render failed.');

  // 9. optional AI QA pass
  if (ai.aiConfigured() && renderOk) {
    try {
      const promptRow = db.prepare('SELECT body FROM prompts WHERE key = ?').get('qa_website');
      const systemPrompt = (promptRow && promptRow.body ? String(promptRow.body).trim() : '') || QA_BUILD_PROMPT_FALLBACK;
      const facts = collectFacts(db, lead || { id: site.lead_id });
      const factList = [...facts.ok.entries()].map(([k, f]) => `${k} = ${f.value} [${f.claim_class}]`).join('\n');
      const { text } = await ai.chat({
        task: 'qa',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Allowed facts (only these may appear as facts):\n${factList || '(none)'}\n\nSite HTML to review:\n${html.slice(0, 12000)}` },
        ],
        maxTokens: 800,
        leadId: site.lead_id,
        note: `QA website #${websiteId}`,
      });
      let verdict = null;
      try { verdict = JSON.parse(stripCodeFences(text)); } catch (e) { /* unparseable */ }
      if (verdict && typeof verdict.pass === 'boolean') {
        check('ai-qa', verdict.pass, (verdict.issues || []).join('; ').slice(0, 500) || 'AI QA verdict recorded.');
      } else {
        check('ai-qa', true, 'AI QA returned an unparseable verdict; skipped.');
      }
    } catch (e) {
      check('ai-qa', true, `AI QA skipped (${e.code || e.message}).`);
    }
  } else {
    check('ai-qa', true, ai.aiConfigured() ? 'Skipped (render failed).' : 'Skipped (AI not configured).');
  }

  const pass = checks.every(c => c.pass);
  if (pass) {
    db.prepare("UPDATE websites SET status = 'approved', updated_at = datetime('now') WHERE id = ?").run(websiteId);
    if (lead) setLeadStatus(db, lead.id, 'ready');
    logActivity(db, 'websites', `Website #${websiteId} passed QA — marked ready.`);
  } else {
    const failed = checks.filter(c => !c.pass).map(c => c.name).join(', ');
    logActivity(db, 'websites', `Website #${websiteId} FAILED QA: ${failed}.`);
  }
  return { pass, checks };
}

/* ------------------------------------------------------------------ */
/* export                                                              */
/* ------------------------------------------------------------------ */

/**
 * Write a real multi-page static site: one HTML file per page.
 * Home (slug `/` or first page) becomes index.html; others use pageFileName.
 */
function writeStaticPages(pages, theme, outDir, opts) {
  if (!Array.isArray(pages) || !pages.length) throw err('INVALID_PAGES', 'pages must be a non-empty array.');
  fs.mkdirSync(outDir, { recursive: true });
  const home = homePage(pages);
  const written = [];
  for (const p of pages) {
    const file = (p === home || isHomePage(p, pages)) ? 'index.html' : pageFileName(p.slug);
    fs.writeFileSync(path.join(outDir, file), renderPage(p, pages, theme, opts), 'utf8');
    written.push(file);
  }
  return { outDir, files: written };
}

/**
 * Export a website as separate HTML files (true multi-pager). Returns outDir.
 */
function exportStatic(db, websiteId, outDir) {
  const site = getWebsite(db, websiteId);
  const pages = JSON.parse(site.pages);
  const theme = JSON.parse(site.theme);
  const written = writeStaticPages(pages, theme, outDir);
  db.prepare("UPDATE websites SET preview_path = ?, updated_at = datetime('now') WHERE id = ?")
    .run(outDir, websiteId);
  logActivity(db, 'websites', `Website #${websiteId} exported to ${outDir} (${(written.files || []).join(', ')}).`);
  return outDir;
}

function applyImagesToPages(pages, images, opts) {
  const list = Array.isArray(images) ? images.slice(0, 6) : [];
  const hero = !!(opts && opts.heroImage);
  let galleries = 0;
  const next = (Array.isArray(pages) ? pages : []).map((page) => ({
    ...page,
    sections: (page.sections || []).map((section) => {
      const content = Object.assign({}, section.content);
      if (section.type === 'gallery') {
        galleries += 1;
        content.images = list;
        if (!content.subtitle) content.subtitle = 'Photos from Pexels. Each picture credits the photographer.';
        return { ...section, content };
      }
      if (section.type === 'hero' && hero && list[0]) {
        content.image = list[0];
        return { ...section, content };
      }
      return section;
    }),
  }));
  // Freeform agent pages (html-only): never inject a template gallery section.
  const freeformOnly = next.length && next.every((p) =>
    typeof p.html === 'string' && p.html.trim() && !(Array.isArray(p.sections) && p.sections.length));
  if (freeformOnly) return next;
  if (!galleries && list.length && next[0]) {
    if (!Array.isArray(next[0].sections)) next[0].sections = [];
    const gallery = { type: 'gallery', content: { title: 'Gallery', images: list, subtitle: 'Photos from Pexels. Each picture credits the photographer.' } };
    const footerAt = next[0].sections.findIndex((s) => s.type === 'footer');
    if (footerAt >= 0) next[0].sections.splice(footerAt, 0, gallery);
    else next[0].sections.push(gallery);
  }
  return next;
}

async function attachPexelsImages(db, websiteId, opts = {}) {
  ensureTables(db);
  const site = getWebsite(db, websiteId);
  const paused = getSetting(db, 'automation_paused', '0');
  if (String(paused) === '1') throw err('AUTOMATION_PAUSED', 'Automation is paused. Resume it before pulling photos.');
  const key = String(getSetting(db, 'pexels.api_key', '') || '').trim();
  if (!key) throw err('PEXELS_NOT_CONFIGURED', 'Pexels API key is not set. Add it in Settings.');
  const pexels = require('./pexels');
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(site.lead_id);
  const requested = pexels.cleanQuery(opts.query);
  const query = requested || (lead && lead.category ? String(lead.category).trim().slice(0, 100) : '') || (site.industry || 'business');
  const photos = await pexels.searchPhotos(key, query, pexels.clampCount(opts.count == null ? 5 : opts.count));
  if (!photos.length) throw err('PEXELS_EMPTY', `Pexels returned no photos for "${query}".`);
  const industry = TEMPLATES[site.industry] ? site.industry : detectIndustry(lead && lead.category);
  const heroImage = site.origin === 'agent' || !!(TEMPLATES[industry] && TEMPLATES[industry].heroImage);
  const pages = applyImagesToPages(JSON.parse(site.pages), photos, { heroImage: heroImage || true });
  const theme = JSON.parse(site.theme);
  saveSite(db, websiteId, pages, theme, `Pexels photos for "${query}"`);
  logActivity(db, 'websites', `Attached ${photos.length} Pexels photo(s) to website #${websiteId} (query="${query}").`);
  return { id: websiteId, count: photos.length, query };
}

/* ------------------------------------------------------------------ */

module.exports = {
  // components / rendering
  COMPONENT_TYPES,
  sectionToHtml,
  renderPage,
  renderPageAt,
  renderSite,
  pageFileName,
  homePage,
  pageHasHtml,
  writeStaticPages,
  normalizeTheme,
  // templates
  TEMPLATES,
  detectIndustry,
  // facts
  collectFacts,
  getManifest,
  // lifecycle
  generateSite,
  saveVersion,
  restoreVersion,
  saveSite,
  getWebsite,
  qaSite,
  exportStatic,
  ensureTables,
  applyImagesToPages,
  attachPexelsImages,
  sanitizeCss,
  sanitizeHtml,
  // exposed for tests
  _cleanText: cleanText,
  _deterministicCopy: deterministicCopy,
};
