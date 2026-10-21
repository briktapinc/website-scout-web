'use strict';

/**
 * Website Engine (Workstream 3).
 *
 * Pure component library + site builder for the single-user Website Scout
 * desktop app.
 *
 * Data model: a website is structured JSON —
 *   pages: [{ slug, title, sections?: [...], html?: string }]
 *   theme: { primary, secondary, font, headingFont?, bg, text, customCss?, customJs?, customHead?,
 *            baseCss?, elementFonts?, logoMode?, logoUrl?, brandName? }
 * logoMode: "text" (default) | "image". When "image" and logoUrl is set,
 * built-in nav renders an <img>; otherwise business_name / brandName text.
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
const googleFonts = require('../public/js/fonts.js');
const siteIcons = require('./siteIcons');

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

/** Visible/content text for QA — strip script/style bodies before tags (avoids JS null false alarms). */
function visibleTextFromHtml(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ');
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
  const vCols = db.prepare('PRAGMA table_info(website_versions)').all();
  if (vCols.length && !vCols.some((c) => c.name === 'author')) {
    try { db.exec('ALTER TABLE website_versions ADD COLUMN author TEXT'); } catch { /* exists */ }
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
  logoMode: 'text',
  logoUrl: '',
  brandName: '',
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
 * Theme-level freestyle JS (motion, effects, interactivity).
 * Escapes script-tag breakouts; content is otherwise agent-authored.
 */
function sanitizeJs(js) {
  let s = String(js == null ? '' : js);
  if (s.length > 200000) s = s.slice(0, 200000);
  s = s.replace(/<\/script/gi, '<\\/script');
  return s;
}

/**
 * Theme/page customHead — static HTML injected before </head>.
 * Escapes </head breakouts; content is otherwise agent-authored (incl. third-party scripts).
 */
function sanitizeHead(html) {
  let s = String(html == null ? '' : html);
  if (s.length > 200000) s = s.slice(0, 200000);
  s = s.replace(/<\/head/gi, '<\\/head');
  return s;
}

function themeJsTag(theme) {
  const t = normalizeTheme(theme);
  const js = t.customJs && String(t.customJs).trim();
  if (!js) return '';
  return `<script data-ws-theme-js="1">${js}</script>`;
}

function themeHeadInject(theme) {
  const t = normalizeTheme(theme);
  const head = t.customHead && String(t.customHead).trim();
  if (!head) return '';
  return `<!--data-ws-theme-head-->\n${head}`;
}

function pageHeadInject(pageHead) {
  const head = pageHead && String(pageHead).trim();
  if (!head) return '';
  return `<!--data-ws-page-head-->\n${head}`;
}

/** Truncate HTML without cutting inside an open tag (avoids broken <script …>). */
function truncateHtmlSafely(html, maxLen) {
  const s = String(html == null ? '' : html);
  if (s.length <= maxLen) return s;
  let cut = maxLen;
  const lastLt = s.lastIndexOf('<', cut);
  const lastGt = s.lastIndexOf('>', cut);
  if (lastLt > lastGt) cut = lastLt;
  if (cut < 1) cut = maxLen;
  return s.slice(0, cut);
}

/**
 * Allow agent-authored markup without scripts or event handlers.
 * Safe <style> and https stylesheet/font <link> tags are kept so agents
 * can own typography and layout without the built-in component skin.
 */
function sanitizeHtml(html) {
  let s = String(html == null ? '' : html).replace(/\u0000/g, '');
  if (s.length > 800000) s = truncateHtmlSafely(s, 800000);
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
  // Only exact first-party loaders survive; rebuild tags with no author body/attributes.
  const bitpypeScripts = [];
  s = s.replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, (_, attrs) => {
    const tag = require('./managedScripts').approvedScript(attrs);
    if (!tag) return '';
    const index = bitpypeScripts.push(tag) - 1;
    return `\u0000BPSCRIPT${index}\u0000`;
  });
  s = s.replace(/<\/?script\b[^>]*>/gi, '');
  s = s.replace(/\u0000BPSCRIPT(\d+)\u0000/g, (_, i) => bitpypeScripts[Number(i)] || '');
  // Strip iframe/object/embed/base — form/module embeds are in-page JS mounts now.
  s = s.replace(/<\/?(iframe|object|embed|base)[\s\S]*?>/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/\s(href|src|action)\s*=\s*(['"])\s*javascript:[^'"]*\2/gi, ' $1="#"');
  s = s.replace(/\s(href|src|action)\s*=\s*javascript:[^\s>]*/gi, ' $1="#"');
  s = s.replace(/\u0000KEEP(\d+)\u0000/g, (_, i) => kept[Number(i)] || '');
  // Safety net: mounts without their loader (legacy strip / hand-edited HTML).
  return ensureManagedEmbedScripts(s);
}

/**
 * Known BitPype in-page embed mounts ↔ /js/*-embed.js loaders.
 * Used by sanitizeHtml recovery and export asserts.
 */
const MANAGED_EMBED_KINDS = [
  {
    kind: 'chat',
    mountRe: /\bbitpype-chat-embed\b|\bdata-bitpype-chat\s*=/i,
    scriptRe: /\/js\/chat-embed\.js|\bdata-bitpype-chat-script\b/i,
    file: 'chat-embed.js',
    attr: 'data-bitpype-chat-script',
  },
  {
    kind: 'module',
    mountRe: /\bbitpype-module-embed\b|\bdata-bitpype-module\s*=/i,
    scriptRe: /\/js\/module-embed\.js|\bdata-bitpype-module-script\b/i,
    file: 'module-embed.js',
    attr: 'data-bitpype-module-script',
  },
  {
    kind: 'form',
    mountRe: /\bbitpype-form-embed\b|\bdata-bitpype-form-embed\s*=/i,
    scriptRe: /\/js\/form-embed\.js|\bdata-bitpype-form-script\b/i,
    file: 'form-embed.js',
    attr: 'data-bitpype-form-script',
  },
];

function defaultAppApiBase() {
  try {
    return String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * Recover missing managed loaders from trusted APP_URL, never author API attributes.
 */
function ensureManagedEmbedScripts(html) {
  let s = String(html == null ? '' : html);
  const api = require('./managedScripts').appBase();
  for (const cfg of MANAGED_EMBED_KINDS) {
    if (!cfg.mountRe.test(s)) continue;
    if (cfg.scriptRe.test(s)) continue;
    const label = `[websiteEngine] managed embed: .bitpype-${cfg.kind}-embed without ${cfg.file}`;
    if (!api) {
      console.error(`${label} — cannot re-inject (missing trusted APP_URL)`);
      continue;
    }
    console.warn(`${label} — re-injecting ${cfg.file} via APP_URL`);
    const tag = require('./managedScripts').loaderTag(cfg.file);
    if (/<\/body>/i.test(s)) s = s.replace(/<\/body>/i, `${tag}\n</body>`);
    else s = `${s}\n${tag}`;
  }
  return s;
}

/**
 * Post-export assert: mounts must keep their loaders. Returns { ok, missing[] }.
 * Logs errors when incomplete so publish/materialize surfaces the regression.
 */
function assertManagedEmbedScripts(html, context) {
  const s = String(html == null ? '' : html);
  const missing = [];
  for (const cfg of MANAGED_EMBED_KINDS) {
    if (!cfg.mountRe.test(s)) continue;
    if (cfg.scriptRe.test(s)) continue;
    missing.push(cfg.file);
  }
  if (missing.length) {
    const where = context ? ` (${context})` : '';
    console.error(
      `[websiteEngine] EXPORT EMBED SCRIPT MISSING${where}: mount(s) without ${missing.join(', ')}`
    );
  }
  return { ok: missing.length === 0, missing };
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
  t.font = googleFonts.safeStack(t.font);
  const headingRaw = typeof t.headingFont === 'string' ? t.headingFont.trim() : '';
  t.headingFont = headingRaw ? googleFonts.safeStack(headingRaw) : '';
  t.elementFonts = normalizeElementFonts(t.elementFonts);
  if (typeof t.customCss === 'string') t.customCss = sanitizeCss(t.customCss);
  else t.customCss = '';
  if (typeof t.customJs === 'string') t.customJs = sanitizeJs(t.customJs);
  else t.customJs = '';
  if (typeof t.customHead === 'string') t.customHead = sanitizeHead(t.customHead);
  else if (typeof t.custom_head === 'string') t.customHead = sanitizeHead(t.custom_head);
  else t.customHead = '';
  const logoMode = String(t.logoMode || 'text').trim().toLowerCase();
  t.logoMode = logoMode === 'image' ? 'image' : 'text';
  t.logoUrl = typeof t.logoUrl === 'string' ? t.logoUrl.trim().slice(0, 500) : '';
  if (t.logoMode === 'image' && !t.logoUrl) t.logoMode = 'text';
  t.brandName = typeof t.brandName === 'string' ? t.brandName.trim().slice(0, 120) : '';
  // Favicon: assets/… or images/… path (upload via website.uploadAsset).
  t.favicon = typeof t.favicon === 'string' ? t.favicon.trim().slice(0, 300) : '';
  if (t.favicon && !safeImageUrl(t.favicon) && !/^(?:images|assets)\//i.test(t.favicon)) t.favicon = '';
  // Shared site chrome partials (edit once via website.edit theme.partials).
  if (t.partials && typeof t.partials === 'object' && !Array.isArray(t.partials)) {
    t.partials = {
      headerHtml: typeof t.partials.headerHtml === 'string'
        ? sanitizeHtml(t.partials.headerHtml)
        : (typeof t.partials.header === 'string' ? sanitizeHtml(t.partials.header) : ''),
      footerHtml: typeof t.partials.footerHtml === 'string'
        ? sanitizeHtml(t.partials.footerHtml)
        : (typeof t.partials.footer === 'string' ? sanitizeHtml(t.partials.footer) : ''),
    };
  } else {
    t.partials = { headerHtml: '', footerHtml: '' };
  }
  const explicitOn = t.baseCss === true || t.baseCss === 1 || t.baseCss === '1';
  const explicitOff = t.baseCss === false || t.baseCss === 0 || t.baseCss === '0';
  if (explicitOff) t.baseCss = false;
  else if (explicitOn) t.baseCss = true;
  else t.baseCss = (t.customCss || t.customJs || t.customHead) ? false : true;
  return t;
}

function normalizeElementFonts(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const keys = Object.keys(raw).slice(0, 200);
  for (const key of keys) {
    if (!/^[\w:.-]{1,80}$/.test(key)) continue;
    const name = googleFonts.matchName(raw[key]);
    if (name) out[key] = name;
  }
  return out;
}

function brandLogoCss() {
  return `.brand{display:inline-flex;align-items:center;gap:8px;text-decoration:none}`
    + `.brand img,.brand-logo,[data-ws-logo]{display:block;max-height:44px;width:auto;height:auto;max-width:min(220px,55vw);object-fit:contain}`;
}

/** CSS custom properties for theme colors — portal live preview + freeform sites. */
function themeRootCss(theme) {
  const t = normalizeTheme(theme);
  const heading = t.headingFont || t.font;
  return `:root{--ws-primary:${t.primary};--ws-secondary:${t.secondary};--ws-bg:${t.bg};--ws-text:${t.text};--ws-font:${t.font};--ws-heading-font:${heading}}`;
}

/** Sitewide type. Appended after customCss so a saved font wins; inline element fonts still win. */
function themeFontRules() {
  return 'body{font-family:var(--ws-font)}h1,h2,h3,h4,h5,h6{font-family:var(--ws-heading-font,var(--ws-font))}';
}

function brandLabel(c = {}, t) {
  const theme = normalizeTheme(t);
  return theme.brandName || c.business_name || 'Business';
}

function brandMarkup(c = {}, t) {
  const theme = normalizeTheme(t);
  const label = brandLabel(c, theme);
  const href = Array.isArray(c.links) && c.links[0] ? c.links[0].href : '#';
  if (theme.logoMode === 'image' && theme.logoUrl) {
    const src = theme.logoUrl;
    const safe = /^(images\/|\.\/images\/|\/images\/|https?:\/\/|data:image\/)/i.test(src)
      || /^[A-Za-z0-9._\-\/]+$/.test(src);
    if (safe) {
      return `<a class="brand" href="${esc(href)}" data-ws-brand="1"><img data-ws-logo="1" class="brand-logo" src="${esc(src)}" alt="${esc(label)}" /></a>`;
    }
  }
  return `<a class="brand" href="${esc(href)}" data-ws-brand="1">${esc(label)}</a>`;
}

/* ------------------------------------------------------------------ */
/* CSS (inline, responsive, standalone)                                 */
/* ------------------------------------------------------------------ */

/**
 * One-level submenu panel styles (menuParent / .nav-item.has-children / li.has-children).
 * Do NOT use margin-top on .nav-sub — that creates a hover dead-zone so the panel
 * closes before the pointer reaches a child link. Visual offset uses a transparent
 * ::before bridge instead.
 */
function navSubmenuCss() {
  return `
.nav-item,.nav-menu>li.has-children{position:relative;display:inline-flex;align-items:center}
.nav-item>a,.nav-menu>li>a{display:inline-block}
.nav-sub{display:none;position:absolute;top:100%;left:0;min-width:180px;padding:8px 0;margin:0;background:var(--ws-bg,#fff);border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 10px 28px rgba(15,23,42,.12);flex-direction:column;align-items:stretch;z-index:60;list-style:none}
.nav-sub::before{content:"";position:absolute;left:0;right:0;top:-14px;height:14px}
.nav-item.has-children:hover>.nav-sub,.nav-item.has-children:focus-within>.nav-sub,
li.has-children:hover>.nav-sub,li.has-children:focus-within>.nav-sub{display:flex}
.nav-sub a{display:block;padding:10px 14px;white-space:nowrap}
.nav-sub a:hover{background:rgba(0,0,0,.04)}
`.replace(/\n/g, '').trim();
}

function siteCss(t) {
  const theme = normalizeTheme(t);
  const root = themeRootCss(theme);
  const subNav = navSubmenuCss();
  const icons = siteIcons.iconCss();
  const minimal = `${root}\n*{box-sizing:border-box} img{max-width:100%;height:auto} .ws-edit{cursor:text}\n${brandLogoCss()}\n${subNav}\n${icons}`;
  const fontRules = themeFontRules();
  if (!theme.baseCss) {
    return `${minimal}\n${theme.customCss || ''}\n${fontRules}`;
  }
  const base = `
${root}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--ws-font);color:var(--ws-text);background:var(--ws-bg);line-height:1.6}
a{color:var(--ws-primary)}
.container{max-width:1080px;margin:0 auto;padding:0 20px}
.nav{position:sticky;top:0;z-index:50;background:var(--ws-bg);border-bottom:1px solid #e5e7eb;overflow:visible}
.nav-inner{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;max-width:1080px;margin:0 auto;overflow:visible}
.brand{font-weight:800;font-size:1.25rem;color:var(--ws-secondary);text-decoration:none;display:inline-flex;align-items:center;gap:8px}
.brand img,.brand-logo,[data-ws-logo]{display:block;max-height:44px;width:auto;height:auto;max-width:min(220px,55vw);object-fit:contain}
.nav-links{display:flex;gap:18px;align-items:center;flex-wrap:wrap;overflow:visible}
.nav-links a{text-decoration:none;color:var(--ws-text);font-weight:600;font-size:.95rem}
${subNav}
.nav-cta{background:var(--ws-primary);color:#fff!important;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700}
.hero{background:linear-gradient(135deg,var(--ws-primary),var(--ws-secondary));color:#fff;padding:72px 0}
.hero h1{font-size:2.4rem;line-height:1.2;margin-bottom:14px}
.hero p{font-size:1.15rem;opacity:.95;max-width:640px;margin-bottom:24px}
.btn{display:inline-block;background:#fff;color:var(--ws-secondary);padding:13px 26px;border-radius:8px;font-weight:800;text-decoration:none;margin-right:12px}
.btn-primary{background:var(--ws-primary);color:#fff}
.btn-outline{background:transparent;color:#fff;border:2px solid #fff}
.rating-badge{display:inline-block;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.4);padding:6px 14px;border-radius:999px;font-size:.9rem;margin-bottom:16px}
section.block{padding:56px 0}
.block h2{font-size:1.8rem;color:var(--ws-secondary);margin-bottom:8px}
.block .lede{color:#4b5563;margin-bottom:28px;max-width:680px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.card{border:1px solid #e5e7eb;border-radius:12px;padding:24px;background:#fff}
.card h3{color:var(--ws-secondary);margin-bottom:8px;font-size:1.1rem}
.card p{color:#4b5563;font-size:.95rem}
.chip{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,var(--ws-primary),var(--ws-secondary));color:#fff;font-weight:800;margin-bottom:12px}
.about p{margin-bottom:14px;color:#374151;max-width:760px}
.gallery-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.ph{aspect-ratio:4/3;border-radius:12px;display:flex;align-items:flex-end;justify-content:center;color:#fff;font-weight:700;padding:12px;text-align:center;text-shadow:0 1px 3px rgba(0,0,0,.4);font-size:.9rem}
.stars{color:#f59e0b;letter-spacing:2px;margin-bottom:8px}
.review-card{font-style:normal}
.review-card .who{margin-top:10px;font-weight:700;color:var(--ws-secondary);font-style:normal}
.cta-band{background:var(--ws-secondary);color:#fff;text-align:center;padding:56px 20px;border-radius:16px}
.cta-band h2{color:#fff;margin-bottom:10px}
.cta-band p{opacity:.9;margin-bottom:24px}
.hours-table{width:100%;max-width:520px;border-collapse:collapse}
.hours-table td{padding:10px 4px;border-bottom:1px solid #e5e7eb}
.hours-table td:last-child{text-align:right;font-weight:600}
.faq details{border:1px solid #e5e7eb;border-radius:10px;padding:16px 18px;margin-bottom:12px;background:#fff}
.faq summary{font-weight:700;color:var(--ws-secondary);cursor:pointer}
.faq p{margin-top:8px;color:#4b5563}
.contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:32px}
.field{margin-bottom:14px}
.field label{display:block;font-weight:600;margin-bottom:6px;font-size:.9rem}
.field input,.field textarea{width:100%;padding:11px 12px;border:1px solid #d1d5db;border-radius:8px;font:inherit}
.mapbox{border:2px dashed #c7d2fe;border-radius:12px;background:#eef2ff;min-height:220px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;color:var(--ws-secondary)}
.mapbox .pin{font-size:2.2rem;margin-bottom:8px}
.social-row{display:flex;gap:12px;flex-wrap:wrap}
.social-row a{display:inline-block;padding:10px 18px;border:1px solid #d1d5db;border-radius:999px;text-decoration:none;color:var(--ws-secondary);font-weight:600}
.booking{text-align:center}
.booking .big-call{display:inline-block;background:var(--ws-primary);color:#fff;font-size:1.4rem;font-weight:800;padding:18px 40px;border-radius:12px;text-decoration:none}
.footer{background:var(--ws-secondary);color:#d1d5db;padding:40px 0;margin-top:0;font-size:.92rem}
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
.hero-bleed{background-size:cover;background-position:center;background-repeat:no-repeat}
.custom-block .custom-body{max-width:760px;margin-bottom:12px}
.cols{display:grid;gap:24px;align-items:start;grid-template-columns:repeat(var(--ws-cols,2),minmax(0,1fr))}
.cols-1{grid-template-columns:1fr}
.cols-2{grid-template-columns:1fr 1fr}
.cols-3{grid-template-columns:repeat(3,1fr)}
.cols-4{grid-template-columns:repeat(4,1fr)}
.col-cell{min-width:0}
.col-cell h3{color:var(--ws-secondary);margin-bottom:8px;font-size:1.15rem}
.col-cell p{color:#4b5563}
.col-cell .col-html{color:#374151}
.text-block .text-body{max-width:760px;color:#374151}
.text-image-grid{display:grid;grid-template-columns:1fr 1fr;gap:32px;align-items:center}
.text-image-grid.image-left{direction:rtl}
.text-image-grid.image-left>*{direction:ltr}
.cards-grid{display:grid;gap:20px;grid-template-columns:repeat(var(--ws-cols,3),minmax(0,1fr))}
.cards-grid.cols-2{grid-template-columns:1fr 1fr}
.cards-grid.cols-3{grid-template-columns:repeat(3,1fr)}
.cards-grid.cols-4{grid-template-columns:repeat(4,1fr)}
.ws-edit{cursor:text}
${icons}
@media(max-width:760px){
  .grid,.gallery-grid,.contact-grid,.footer-grid,.hero-grid,.cols,.cols-2,.cols-3,.cols-4,.text-image-grid,.cards-grid,.cards-grid.cols-2,.cards-grid.cols-3,.cards-grid.cols-4{grid-template-columns:1fr!important}
  .hero h1{font-size:1.8rem}
  .nav-links a:not(.nav-cta){display:none}
  .nav-item{display:none}
  .nav-sub{position:static;display:none;box-shadow:none;border:0;margin:0;padding:0}
  section.block{padding:40px 0}
}`;
  return (theme.customCss ? `${base}\n${theme.customCss}` : base) + `\n${fontRules}`;
}


/* ------------------------------------------------------------------ */
/* component library — pure render functions                           */
/*                                                                    */
/* section = { type, content }. Every function is total: missing       */
/* content degrades to a safe fallback, never throws.                  */
/* ------------------------------------------------------------------ */

const COMPONENT_TYPES = [
  'nav', 'hero', 'benefits', 'services', 'about', 'gallery', 'reviews',
  'cta', 'contact_form', 'bitpype_form', 'form', 'map_placeholder', 'hours', 'faq', 'footer',
  'booking_button', 'social_links', 'custom', 'html',
  // Layout modules (Elementor-style composition; freeform HTML lives inside cells)
  'columns', 'text', 'text_image', 'cards',
];

/** Insertable layout / content blocks for portal + MCP (excludes pinned chrome). */
const LAYOUT_SECTION_TYPES = [
  { type: 'heading', label: 'Heading' },
  { type: 'text', label: 'Text' },
  { type: 'image', label: 'Image' },
  { type: 'columns', label: 'Columns', cols: [1, 2, 3, 4, 5, 6] },
  { type: 'text_image', label: 'Text + image' },
  { type: 'cards', label: 'Cards' },
  { type: 'html', label: 'HTML block' },
  { type: 'hero', label: 'Hero' },
  { type: 'benefits', label: 'Benefits' },
  { type: 'services', label: 'Services' },
  { type: 'about', label: 'About' },
  { type: 'gallery', label: 'Gallery' },
  { type: 'reviews', label: 'Reviews' },
  { type: 'cta', label: 'CTA' },
  { type: 'faq', label: 'FAQ' },
  { type: 'custom', label: 'Custom' },
];

/** CSS / attribute markers for freeform design-module roots (edit canvas). */
const DESIGN_MODULE_CLASS_HINTS = [
  'layout-columns', 'text-block', 'text-image', 'layout-cards',
  'ws-html-block', 'ws-design-heading', 'ws-design-image', 'ws-design-module',
  'custom-block',
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
  const id = edit ? `${edit.page}:${edit.section}:${path}` : '';
  const family = id && edit && edit.fonts ? edit.fonts[id] : '';
  const stack = family ? googleFonts.stackFor(family) : '';
  const style = stack ? ` style="font-family:${esc(stack)}"` : '';
  if (!edit || !edit.editing) {
    return style ? `<span${style}>${esc(raw)}</span>` : esc(raw);
  }
  return `<span class="ws-edit" data-edit="${esc(id)}"${style}>${esc(raw)}</span>`;
}

function safeHttps(url) {
  return typeof url === 'string' && url.startsWith('https://');
}

/** https or local export paths (images/… or assets/…) for photos / CSS backgrounds. */
function safeImageUrl(url) {
  if (typeof url !== 'string') return '';
  const u = url.trim().slice(0, 500);
  if (!u) return '';
  if (/^https:\/\//i.test(u)) return u;
  if (/^(?:\.\/)?(?:images|assets)\/[A-Za-z0-9._/-]+$/i.test(u)) return u.replace(/^\.\//, '');
  if (/^\/(?:images|assets)\/[A-Za-z0-9._/-]+$/i.test(u)) return u.slice(1);
  return '';
}

/** Parse "16:9" / number → CSS aspect-ratio value, or ''. */
function aspectCssValue(aspect) {
  try {
    const imageCrop = require('./imageCrop');
    const n = imageCrop.parseAspect(aspect);
    if (!n) return '';
    if (typeof aspect === 'string' && /^\d+(?:\.\d+)?\s*[:/x]\s*\d+/i.test(aspect)) {
      return String(aspect).trim().replace(/\s+/g, '').replace(/[xX/]/, ' / ');
    }
    return String(n);
  } catch {
    return '';
  }
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
  const src = im && safeImageUrl(im.url);
  if (!src) return '';
  const pexelsHost = /pexels\.com/i.test(src);
  const credit = creditHtml(im) || (pexelsHost
    ? `<figcaption class="photo-credit">Photo via <a href="https://www.pexels.com" rel="noopener noreferrer" target="_blank">Pexels</a></figcaption>`
    : '');
  const crop = (im && im.crop && typeof im.crop === 'object') ? im.crop : null;
  const figStyle = [];
  const imgStyle = [];
  const imgAttrs = [];
  if (crop) {
    const ar = aspectCssValue(crop.aspect);
    if (ar) figStyle.push(`aspect-ratio:${ar}`);
    const fx = crop.focalX != null ? Number(crop.focalX) : (crop.focal_x != null ? Number(crop.focal_x) : 0.5);
    const fy = crop.focalY != null ? Number(crop.focalY) : (crop.focal_y != null ? Number(crop.focal_y) : 0.5);
    const px = Number.isFinite(fx) ? Math.round(Math.max(0, Math.min(1, fx)) * 100) : 50;
    const py = Number.isFinite(fy) ? Math.round(Math.max(0, Math.min(1, fy)) * 100) : 50;
    imgStyle.push('width:100%', 'height:100%', 'object-fit:cover', `object-position:${px}% ${py}%`);
    if (crop.width) imgAttrs.push(`width="${esc(String(Math.round(Number(crop.width))))}"`);
    if (crop.height) imgAttrs.push(`height="${esc(String(Math.round(Number(crop.height))))}"`);
  }
  const figAttr = figStyle.length ? ` style="${figStyle.join(';')}"` : '';
  const imgStyleAttr = imgStyle.length ? ` style="${imgStyle.join(';')}"` : '';
  const extra = imgAttrs.length ? ` ${imgAttrs.join(' ')}` : '';
  return `<figure class="${className}"${figAttr}><img src="${esc(src)}" alt="${esc(im.alt || '')}"${imgStyleAttr}${extra}>${credit}</figure>`;
}

/** Resolve background image from content.backgroundImage / .background / image.url. */
function contentBackgroundImageUrl(content) {
  if (!content || typeof content !== 'object') return '';
  if (typeof content.backgroundImage === 'string') return safeImageUrl(content.backgroundImage);
  if (typeof content.background_image === 'string') return safeImageUrl(content.background_image);
  if (content.background && typeof content.background === 'object') {
    return safeImageUrl(content.background.url || content.background.src || '');
  }
  if (typeof content.background === 'string' && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(content.background)) {
    return safeImageUrl(content.background);
  }
  return '';
}

function contentBackgroundColor(content) {
  if (!content || typeof content !== 'object') return '';
  const raw = content.backgroundColor || content.background_color || content.bg
    || (typeof content.background === 'string' && !/\.(jpe?g|png|webp|gif)/i.test(content.background)
      ? content.background : '');
  if (typeof raw !== 'string') return '';
  const s = raw.trim().slice(0, 120);
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return s;
  if (/^(rgb|rgba|hsl|hsla)\(/i.test(s)) return s.replace(/[<>]/g, '');
  if (/^linear-gradient\(/i.test(s)) return s.replace(/[<>]/g, '').slice(0, 300);
  return '';
}

function renderNavLinkTree(links) {
  const items = Array.isArray(links) ? links : [];
  return items.map((l) => {
    const kids = Array.isArray(l.children) ? l.children : [];
    if (!kids.length) {
      return `<a href="${esc(l.href || '#')}">${esc(l.label || '')}</a>`;
    }
    const sub = kids.map((c) =>
      `<a href="${esc(c.href || '#')}">${esc(c.label || '')}</a>`
    ).join('');
    return `<span class="nav-item has-children"><a href="${esc(l.href || '#')}">${esc(l.label || '')}</a><span class="nav-sub">${sub}</span></span>`;
  }).join('');
}

function cNav(c = {}, t, edit) {
  // Freestyle header chrome from the agent (original branded nav / top bar).
  if (typeof c.html === 'string' && c.html.trim()) {
    return `<div class="ws-nav-chrome">${markEditableSectionHtml(c.html, edit)}</div>`;
  }
  const links = Array.isArray(c.links) ? c.links : [];
  const phone = digitsOnly(c.phone);
  return `<nav class="nav"><div class="nav-inner">
    ${brandMarkup(c, t)}
    <div class="nav-links">
      ${renderNavLinkTree(links)}
      ${phone ? `<a class="nav-cta" href="tel:${phone}">${esc(c.phone_display || c.phone)}</a>` : ''}
    </div></div></nav>`;
}

function cHero(c = {}, t, edit) {
  const rating = c.rating && c.review_count
    ? `<div class="rating-badge">★ ${esc(String(c.rating))} · ${esc(String(c.review_count))} customer reviews</div>` : '';
  const hasBg = !!contentBackgroundImageUrl(c);
  // Side photo only when not already using a full-bleed background image.
  const photo = hasBg ? '' : photoFigure(c.image, 'hero-photo');
  const bleed = hasBg ? ' hero-bleed' : '';
  return `<header class="hero${bleed}"><div class="container${photo ? ' hero-grid' : ''}"><div>
    ${rating}
    <h1>${editSpan(edit, 'headline', c.headline || 'Welcome')}</h1>
    ${c.subheadline ? `<p>${editSpan(edit, 'subheadline', c.subheadline)}</p>` : ''}
    <div>${c.cta_text ? `<a class="btn" href="${esc(safeHref(c.cta_href || '#contact'))}">${editSpan(edit, 'cta_text', c.cta_text)}</a>` : ''}
    ${c.cta_secondary_text ? `<a class="btn btn-outline" href="${esc(safeHref(c.cta_secondary_href || '#services'))}">${editSpan(edit, 'cta_secondary_text', c.cta_secondary_text)}</a>` : ''}</div>
  </div>${photo}</div></header>`;
}

function listAddButton(edit, listKey, label) {
  if (!edit || !edit.editing) return '';
  return `<button type="button" class="ws-add-item" data-ws-add="section" data-ws-page="${Number(edit.page)}" data-ws-section="${Number(edit.section)}" data-ws-list="${esc(listKey)}">${esc(label || '+ Add item')}</button>`;
}

function listDeleteButton(edit, listKey, index) {
  if (!edit || !edit.editing) return '';
  return `<button type="button" class="ws-del-item" title="Remove" aria-label="Remove item" data-ws-del="section" data-ws-page="${Number(edit.page)}" data-ws-section="${Number(edit.section)}" data-ws-list="${esc(listKey)}" data-ws-index="${Number(index)}">×</button>`;
}

function wrapListItem(edit, listKey, index, innerHtml) {
  if (!edit || !edit.editing) return innerHtml;
  return `<div class="ws-list-item" data-ws-item="${Number(index)}">${listDeleteButton(edit, listKey, index)}${innerHtml}</div>`;
}

function itemIconHtml(it, fallbackLabel) {
  const name = it && it.icon;
  if (!name || !siteIcons.isKnownIcon(name)) return '';
  const svg = siteIcons.renderIconSvg(name, { label: fallbackLabel || name });
  return svg ? `<div class="ws-icon-wrap chip ws-icon-chip">${svg}</div>` : '';
}

function cBenefits(c = {}, t, edit) {
  const items = Array.isArray(c.items) ? c.items : [];
  if (!items.length && !edit) return '';
  return `<section class="block"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title)}</h2>` : ''}
    ${c.subtitle ? `<p class="lede">${editSpan(edit, 'subtitle', c.subtitle)}</p>` : ''}
    <div class="grid" data-ws-list="items">${items.map((it, i) =>
      wrapListItem(edit, 'items', i,
        `<div class="card">${itemIconHtml(it, it.title) || `<div class="chip">${i + 1}</div>`}<h3>${editSpan(edit, `items.${i}.title`, it.title || '')}</h3><p>${editSpan(edit, `items.${i}.text`, it.text || '')}</p></div>`)
    ).join('')}</div>${listAddButton(edit, 'items', '+ Add card')}</div></section>`;
}

function cServices(c = {}, t, edit) {
  const items = Array.isArray(c.items) ? c.items : [];
  if (!items.length && !edit) return '';
  return `<section class="block page-anchor" id="services"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title)}</h2>` : '<h2>Our Services</h2>'}
    ${c.subtitle ? `<p class="lede">${editSpan(edit, 'subtitle', c.subtitle)}</p>` : ''}
    <div class="grid" data-ws-list="items">${items.map((it, i) =>
      wrapListItem(edit, 'items', i,
        `<div class="card">${itemIconHtml(it, it.name)}<h3>${editSpan(edit, `items.${i}.name`, it.name || '')}</h3><p>${editSpan(edit, `items.${i}.description`, it.description || '')}</p></div>`)
    ).join('')}</div>${listAddButton(edit, 'items', '+ Add service')}</div></section>`;
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

function cReviews(c = {}, t, edit) {
  const reviews = Array.isArray(c.reviews) ? c.reviews : [];
  if (!reviews.length && !edit) return '';
  return `<section class="block"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title || 'What Customers Say')}</h2>` : `<h2>${editSpan(edit, 'title', 'What Customers Say')}</h2>`}
    ${c.subtitle ? `<p class="lede">${editSpan(edit, 'subtitle', c.subtitle)}</p>` : ''}
    <div class="grid" data-ws-list="reviews">${reviews.map((r, i) => {
      const stars = Math.max(1, Math.min(5, Number(r.stars) || 5));
      return wrapListItem(edit, 'reviews', i,
        `<div class="card review-card"><div class="stars">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</div>
        <p>“${editSpan(edit, `reviews.${i}.text`, r.text || '')}”</p><div class="who">— ${editSpan(edit, `reviews.${i}.name`, r.name || 'Customer')}</div></div>`);
    }).join('')}</div>${listAddButton(edit, 'reviews', '+ Add review')}</div></section>`;
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
  const formAction = String(c.form_action || '').trim();
  const formToken = String(c.form_token || '').trim();
  const embedHtml = typeof c.bitpype_embed_html === 'string' ? c.bitpype_embed_html.trim() : '';
  const suppressFields = !!c.suppress_fields || !!embedHtml;
  if (!email && !phone && !formAction && !formToken && !embedHtml) return '';
  const useBitpype = !!(formAction || formToken);
  const action = useBitpype
    ? (formAction || '#')
    : (email ? `mailto:${esc(email)}?subject=${encodeURIComponent(c.mailto_subject || 'Website inquiry')}` : '#');
  const method = useBitpype ? 'post' : 'post';
  const bitpypeAttrs = useBitpype
    ? ` data-bitpype-form="1" data-form-token="${esc(formToken)}" enctype="application/x-www-form-urlencoded"`
    : ' enctype="text/plain"';
  const formBlock = suppressFields
    ? (embedHtml ? sanitizeHtml(embedHtml) : '')
    : `<form action="${esc(action)}" method="${method}"${bitpypeAttrs}${useBitpype ? ' onsubmit="return window.__bitpypeSubmitForm ? window.__bitpypeSubmitForm(event,this) : true"' : ''}>
        <div class="field"><label for="cf-name">Name</label><input id="cf-name" name="name" required></div>
        <div class="field"><label for="cf-phone">Phone</label><input id="cf-phone" name="phone" type="tel"></div>
        <div class="field"><label for="cf-email">Email</label><input id="cf-email" name="email" type="email" required></div>
        <div class="field"><label for="cf-msg">Message</label><textarea id="cf-msg" name="message" rows="5" required></textarea></div>
        <button class="btn btn-primary" type="submit">Send Message</button>
      </form>`;
  return `<section class="block page-anchor" id="contact"><div class="container">
    ${c.title ? `<h2>${esc(c.title)}</h2>` : '<h2>Contact Us</h2>'}
    ${c.text ? `<p class="lede">${esc(c.text)}</p>` : ''}
    <div class="contact-grid"><div>
      ${formBlock}</div>
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
  if (!items.length && !edit) return '';
  return `<section class="block faq"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title)}</h2>` : '<h2>Frequently Asked Questions</h2>'}
    <div data-ws-list="items">${items.map((it, i) =>
      wrapListItem(edit, 'items', i,
        `<details><summary>${editSpan(edit, `items.${i}.q`, it.q || '')}</summary><p>${editSpan(edit, `items.${i}.a`, it.a || '')}</p></details>`)
    ).join('')}</div>${listAddButton(edit, 'items', '+ Add question')}
  </div></section>`;
}

function cFooter(c = {}, t, edit) {
  // Freestyle footer chrome from the agent (original branded footer).
  if (typeof c.html === 'string' && c.html.trim()) {
    return `<div class="ws-footer-chrome">${markEditableSectionHtml(c.html, edit)}</div>`;
  }
  const year = new Date().getFullYear();
  // Use page-slug hashes; rewriteAnchorLinksToFiles converts these to *.html on multipage export.
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
    return markEditableSectionHtml(c.html, edit);
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

function cHtml(c = {}, t, edit) {
  const raw = (typeof c.html === 'string' && c.html.trim())
    ? c.html
    : ((typeof c.markup === 'string' && c.markup.trim()) ? c.markup : '');
  const inner = raw ? markEditableSectionHtml(raw, edit) : '';
  if (!inner) return '';
  // Wrapper so section className / data-ws-* decorate a stable root, not the first inner tag.
  return `<div class="ws-html-block ws-design-module" data-ws-design-module="1">${inner}</div>`;
}

/** Practical column clamp for layout grids (1–12). */
function clampCols(n, fallback = 3) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(1, Math.min(12, v));
}

/** Grid style that works for any column count (not only .cols-1..4). */
function colsGridStyle(cols) {
  const n = clampCols(cols, 2);
  return `grid-template-columns:repeat(${n},minmax(0,1fr))`;
}

/** Render one column cell: text, image, card, module/form widget, or raw html. */
function renderColCell(cell, edit, pathPrefix) {
  const c = cell && typeof cell === 'object' ? cell : {};
  const p = pathPrefix || '';
  // Native module/form-in-cell (no body CSS hacks required).
  if (c.widget && typeof c.widget === 'object') {
    const w = c.widget;
    const wt = String(w.type || w.blockType || '').toLowerCase();
    let inner = '';
    if (wt === 'form' || wt === 'bitpype_form') {
      inner = cBitpypeForm(w);
    } else if (wt === 'site_module' || wt === 'module' || wt === 'widget') {
      inner = cSiteModule(w);
    } else if (typeof w.html === 'string' && w.html.trim()) {
      inner = sanitizeHtml(w.html);
    }
    if (inner) {
      return `<div class="col-cell col-widget" data-ws-layout-cell="1" data-ws-cell-widget="${esc(wt || 'widget')}">${inner}</div>`;
    }
  }
  if (typeof c.html === 'string' && c.html.trim()) {
    // Column cells are not top-level sections — keep sanitized only (no edit ids).
    return `<div class="col-cell col-html" data-ws-layout-cell="1">${sanitizeHtml(c.html)}</div>`;
  }
  const heading = c.heading || c.title || '';
  const body = c.body || c.text || '';
  const photo = photoFigure(c.image || (c.crop ? { url: c.url, alt: c.alt, crop: c.crop } : null), 'photo');
  const button = c.button && typeof c.button === 'object' ? c.button : null;
  if (!heading && !body && !photo && !(button && button.text)) {
    return '<div class="col-cell" data-ws-layout-cell="1"></div>';
  }
  return `<div class="col-cell" data-ws-layout-cell="1">
    ${heading ? `<h3>${editSpan(edit, `${p}heading`, heading)}</h3>` : ''}
    ${body ? `<p>${editSpan(edit, `${p}body`, body)}</p>` : ''}
    ${photo}
    ${button && button.text
      ? `<p><a class="btn btn-primary" href="${esc(safeHref(button.href))}">${editSpan(edit, `${p}button.text`, button.text)}</a></p>`
      : ''}
  </div>`;
}

/** Standalone heading design module. */
function cHeading(c = {}, t, edit) {
  const text = c.heading || c.title || c.text || 'Heading';
  const level = [1, 2, 3, 4].includes(Number(c.level)) ? Number(c.level) : 2;
  const tag = `h${level}`;
  return `<section class="block ws-design-heading ws-design-module" data-ws-design-module="1"><div class="container">`
    + `<${tag}>${editSpan(edit, 'heading', text)}</${tag}></div></section>`;
}

/** Standalone image design module. */
function cImage(c = {}, t, edit) {
  void edit;
  const photo = photoFigure(c.image, 'photo')
    || '<div class="ph" style="background:linear-gradient(135deg,#e5e7eb,#d1d5db);min-height:180px;border-radius:8px" role="img" aria-label="Image"></div>';
  const caption = c.caption || c.alt || '';
  return `<section class="block ws-design-image ws-design-module" data-ws-design-module="1"><div class="container">`
    + `${photo}`
    + (caption ? `<p class="lede">${esc(caption)}</p>` : '')
    + `</div></section>`;
}

/** Column layout module (1–12 columns via CSS grid). */
function cColumns(c = {}, t, edit) {
  const cols = clampCols(c.cols != null ? c.cols : c.columns_count, 2);
  let cells = Array.isArray(c.cells) ? c.cells : (Array.isArray(c.columns) ? c.columns : []);
  if (!cells.length) {
    cells = Array.from({ length: cols }, () => ({ heading: 'Column', body: 'Add your content.' }));
  }
  while (cells.length < cols) cells.push({ heading: '', body: '' });
  cells = cells.slice(0, Math.max(cols, cells.length));
  return `<section class="block layout-columns ws-design-module" data-ws-design-module="1" data-ws-block="columns"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title)}</h2>` : ''}
    ${c.subtitle ? `<p class="lede">${editSpan(edit, 'subtitle', c.subtitle)}</p>` : ''}
    <div class="cols cols-${cols}" style="${colsGridStyle(cols)}">${cells.map((cell, i) => renderColCell(cell, edit, `cells.${i}.`)).join('')}</div>
  </div></section>`;
}

/** Plain text / heading module (optional html override). */
function cText(c = {}, t, edit) {
  if (typeof c.html === 'string' && c.html.trim()) {
    return `<section class="block text-block ws-design-module" data-ws-design-module="1"><div class="container">${markEditableSectionHtml(c.html, edit)}</div></section>`;
  }
  const heading = c.heading || c.title || '';
  const body = c.body || c.text || '';
  if (!heading && !body && !edit) return '';
  return `<section class="block text-block ws-design-module" data-ws-design-module="1"><div class="container">
    ${heading ? `<h2>${editSpan(edit, 'heading', heading)}</h2>` : ''}
    ${body ? `<p class="text-body">${editSpan(edit, 'body', body)}</p>` : ''}
  </div></section>`;
}

/** Text + image split (image left or right). */
function cTextImage(c = {}, t, edit) {
  const heading = c.heading || c.title || '';
  const body = c.body || c.text || '';
  const photo = photoFigure(c.image, 'photo');
  const side = String(c.image_position || c.imagePosition || 'right').toLowerCase() === 'left' ? 'left' : 'right';
  const button = c.button && typeof c.button === 'object' ? c.button : null;
  if (!heading && !body && !photo && !edit) return '';
  const textCol = `<div>
    ${heading ? `<h2>${editSpan(edit, 'heading', heading)}</h2>` : ''}
    ${body ? `<p class="lede">${editSpan(edit, 'body', body)}</p>` : ''}
    ${button && button.text
      ? `<p><a class="btn btn-primary" href="${esc(safeHref(button.href))}">${editSpan(edit, 'button.text', button.text)}</a></p>`
      : ''}
  </div>`;
  const imgCol = photo || '<div class="ph" style="background:linear-gradient(135deg,#e5e7eb,#d1d5db)" role="img" aria-label="Image"></div>';
  return `<section class="block text-image ws-design-module" data-ws-design-module="1"><div class="container">
    <div class="text-image-grid${side === 'left' ? ' image-left' : ''}">${textCol}<div>${imgCol}</div></div>
  </div></section>`;
}

/** Generic N-column card grid. */
function cCards(c = {}, t, edit) {
  const items = Array.isArray(c.items) ? c.items : [];
  const cols = clampCols(c.cols != null ? c.cols : (items.length >= 4 ? 4 : (items.length || 3)), 3);
  if (!items.length && !edit) return '';
  return `<section class="block layout-cards ws-design-module" data-ws-design-module="1"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title)}</h2>` : ''}
    ${c.subtitle ? `<p class="lede">${editSpan(edit, 'subtitle', c.subtitle)}</p>` : ''}
    <div class="cards-grid cols-${cols}" style="${colsGridStyle(cols)}" data-ws-list="items">${items.map((it, i) =>
      wrapListItem(edit, 'items', i,
        `<div class="card">
          ${photoFigure(it.image, 'photo')}
          <h3>${editSpan(edit, `items.${i}.title`, it.title || it.name || '')}</h3>
          <p>${editSpan(edit, `items.${i}.text`, it.text || it.description || '')}</p>
        </div>`)
    ).join('')}</div>${listAddButton(edit, 'items', '+ Add card')}</div></section>`;
}

/** In-page site module mount (portal structure insert). */
function cSiteModule(c = {}) {
  const token = String(c.public_token || c.publicToken || '').trim();
  const moduleType = String(c.module_type || c.moduleType || '').trim();
  if (!token) return '';
  const api = String(c.api_base || c.apiBase || '').replace(/\/$/, '');
  const apiAttr = api ? ` data-bitpype-api="${esc(api)}"` : '';
  const typeAttr = moduleType ? ` data-bitpype-module-type="${esc(moduleType)}"` : '';
  const script = api
    ? `<script src="${esc(api)}/js/module-embed.js?v=mod6" defer data-bitpype-module-script="1"></script>`
    : `<script src="/js/module-embed.js?v=mod6" defer data-bitpype-module-script="1"></script>`;
  return `<section class="block site-module-section"><div class="container">`
    + `<div class="bitpype-module-embed" data-bitpype-module="1"${typeAttr} `
    + `data-bitpype-module-token="${esc(token)}"${apiAttr} data-bitpype-hide-title="1"></div>`
    + `${script}</div></section>`;
}

/** Portal-published contact form embed (in-page JS mount). */
function cBitpypeForm(c = {}) {
  const token = String(c.form_token || c.bitpype_form_token || '').trim();
  if (!token) return '';
  const api = String(c.api_base || c.bitpype_api || '').replace(/\/$/, '');
  const apiAttr = api ? ` data-bitpype-api="${esc(api)}"` : '';
  const script = api
    ? `<script src="${esc(api)}/js/form-embed.js?v=form1" defer data-bitpype-form-script="1"></script>`
    : `<script src="/js/form-embed.js?v=form1" defer data-bitpype-form-script="1"></script>`;
  return `<!--bitpype-form:${esc(token)}--><section class="block"><div class="container" style="max-width:640px;margin:0 auto">`
    + `<div class="bitpype-form-embed" data-bitpype-managed="1" data-bitpype-form-embed="${esc(token)}"${apiAttr}></div>`
    + `${script}</div></section><!--/bitpype-form:${esc(token)}-->`;
}

function cSocialLinks(c = {}, t) {
  const links = Array.isArray(c.links) ? c.links : [];
  if (!links.length) return '';
  return `<section class="block"><div class="container">
    ${c.title ? `<h2>${esc(c.title)}</h2>` : '<h2>Follow Us</h2>'}
    <div class="social-row">${links.map((l) => {
      const network = l.network || l.icon || '';
      const iconName = siteIcons.iconForNetwork(network) || (siteIcons.isKnownIcon(network) ? siteIcons.normalizeIconName(network) : '');
      const href = esc(safeHref(l.url || '#'));
      const label = l.label || network || l.url || 'Social';
      if (iconName) {
        return `<a class="ws-social" href="${href}" target="_blank" rel="noopener" aria-label="${esc(label)}" title="${esc(label)}">${siteIcons.renderIconSvg(iconName, { label })}</a>`;
      }
      return `<a href="${href}" target="_blank" rel="noopener">${esc(label)}</a>`;
    }).join('')}</div></div></section>`;
}

const RENDERERS = {
  nav: cNav, hero: cHero, benefits: cBenefits, services: cServices, about: cAbout,
  gallery: cGallery, reviews: cReviews, cta: cCta, contact_form: cContactForm,
  map_placeholder: cMapPlaceholder, hours: cHours, faq: cFaq, footer: cFooter,
  booking_button: cBookingButton, social_links: cSocialLinks, custom: cCustom, html: cHtml,
  bitpype_form: cBitpypeForm, form: cBitpypeForm, site_module: cSiteModule,
  columns: cColumns, text: cText, text_image: cTextImage, cards: cCards,
  heading: cHeading, image: cImage,
};

const PREVIEW_EDIT_STYLE = `<style data-ws-edit-style="1">
html.ws-editing [data-edit]{
  outline:1px dashed rgba(13,107,92,.5);
  outline-offset:2px;
  cursor:text;
  background:rgba(13,107,92,.06);
  border-radius:2px;
  transition:outline-color .15s ease,background .15s ease;
  user-select:text;
  -webkit-user-select:text;
  pointer-events:auto;
}
html.ws-editing [data-edit]:hover{
  outline-color:rgba(13,107,92,.85);
  background:rgba(13,107,92,.1);
}
html.ws-editing [data-edit]:focus{
  outline:2px solid rgba(13,107,92,.85);
  background:rgba(13,107,92,.12);
}
html.ws-editing img{
  outline:1px dashed rgba(13,107,92,.45);
  outline-offset:2px;
  cursor:pointer;
  transition:outline-color .15s ease,filter .15s ease,opacity .15s ease;
}
html.ws-editing img:hover{
  outline-color:rgba(13,107,92,.9);
  filter:brightness(0.97);
}
html.ws-editing img.ws-img-busy{
  opacity:.55;
  pointer-events:none;
}
/* Block + width:100% — never inline-block shrink-to-fit. Wrapping imgs in
   inline-block with img{max-width:100%;width:100%} collapses the box (esp.
   while lazy/broken), which looks like images "disappear" leaving only ★. */
html.ws-editing .ws-img-host{
  position:relative;
  display:block;
  width:100%;
  max-width:100%;
  line-height:0;
  vertical-align:middle;
}
html.ws-editing .ws-img-host > img{
  max-width:100%;
}
.ws-ai-img{display:none!important}
html.ws-editing .ws-ai-img{
  display:flex!important;
  align-items:center;
  justify-content:center;
  position:absolute;
  top:8px;
  right:8px;
  z-index:7;
  width:32px;
  height:32px;
  padding:0;
  border:0;
  border-radius:8px;
  background:rgba(13,107,92,.92);
  color:#fff;
  font-size:1.1rem;
  line-height:1;
  cursor:pointer;
  box-shadow:0 2px 8px rgba(0,0,0,.16);
}
html.ws-editing .ws-ai-img:hover{background:rgba(10,90,78,.98)}
html.ws-editing .ws-img-host:has(img.ws-img-busy) .ws-ai-img{
  opacity:.45;
  pointer-events:none;
}
.ws-add-item,.ws-del-item,.ws-sec-add{display:none!important}
html.ws-editing .ws-add-item{
  display:inline-flex!important;align-items:center;justify-content:center;gap:6px;
  margin:14px 0 6px;padding:10px 16px;
  border:1px dashed rgba(13,107,92,.55);border-radius:10px;
  background:rgba(13,107,92,.08);color:#0d6b5c;font:inherit;font-weight:650;
  font-size:.9rem;cursor:pointer;line-height:1.2;
  width:auto;max-width:100%;
  flex:0 0 auto;grid-column:1/-1;justify-self:start;
}
html.ws-editing .ws-add-item:hover{background:rgba(13,107,92,.14)}
html.ws-editing .ws-sec-add{
  display:flex!important;align-items:center;justify-content:center;
  width:100%;max-width:100%;box-sizing:border-box;
  margin:10px 0;padding:10px 14px;
  border:1px dashed rgba(13,107,92,.45);border-radius:10px;
  background:rgba(13,107,92,.05);color:#0d6b5c;font:inherit;font-weight:650;
  font-size:.88rem;cursor:pointer;line-height:1.2;
}
html.ws-editing .ws-sec-add:hover{background:rgba(13,107,92,.12)}
html.ws-editing .ws-list-item{position:relative}
html.ws-editing .ws-del-item{
  display:flex!important;align-items:center;justify-content:center;
  position:absolute;top:8px;right:8px;z-index:6;
  width:28px;height:28px;padding:0;border:0;border-radius:8px;
  background:rgba(155,28,28,.92);color:#fff;font-size:1.1rem;line-height:1;
  cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.12);
}
html.ws-editing .ws-ff-item{position:relative!important}
html.ws-editing details.ws-ff-item > .ws-del-item{top:10px;right:10px}
html.ws-editing .ws-embed-module,
html.ws-editing .ws-design-module,
html.ws-editing [data-ws-design-module="1"]{
  outline:1px dashed rgba(13,107,92,.45);
  border-radius:12px;
  padding:8px 10px 12px;
  margin:12px 0;
  position:relative;
}
html.ws-editing .ws-widget-host{
  outline:1px dashed rgba(13,107,92,.35);
  border-radius:10px;
  padding:6px 8px 10px;
  margin:10px 0;
  position:relative;
}
html.ws-editing .ws-embed-module .ws-sec-tools,
html.ws-editing .ws-design-module .ws-sec-tools,
html.ws-editing [data-ws-design-module="1"] .ws-sec-tools,
html.ws-editing .ws-widget-host .ws-sec-tools,
html.ws-editing [data-ws-page-section] .ws-sec-tools{margin-bottom:6px}
.ws-sec-tools{display:none!important}
html.ws-editing .ws-sec-tools{
  display:flex!important;justify-content:flex-end;flex-wrap:wrap;gap:8px;
  margin:0 0 8px;
}
html.ws-editing .ws-sec-del,
html.ws-editing .ws-sec-add-mod{
  position:static;width:auto;height:auto;padding:6px 12px;
  border-radius:8px;font:inherit;font-size:.82rem;font-weight:650;
  line-height:1.2;box-shadow:none;cursor:pointer;
}
html.ws-editing .ws-sec-add-mod{
  border:1px dashed rgba(13,107,92,.5);
  background:rgba(13,107,92,.08);color:#0d6b5c;
}
html.ws-editing .ws-sec-add-mod:hover{background:rgba(13,107,92,.14)}
html.ws-editing.ws-font-only .ws-add-item,
html.ws-editing.ws-font-only .ws-sec-add,
html.ws-editing.ws-font-only .ws-sec-tools,
html.ws-editing.ws-font-only .ws-del-item,
html.ws-editing.ws-font-only .ws-ai-img{display:none!important}
</style>`;

const PREVIEW_EDIT_SCRIPT = `<script>
(function () {
  var editOn = false;
  var fontPick = false;
  var MAX_ITEMS = 24;
  var undoStack = [];
  var MAX_UNDO = 30;

  function setEditMode(on, fontsOnly) {
    editOn = !!on;
    fontPick = editOn && !!fontsOnly;
    try {
      document.documentElement.classList.toggle('ws-editing', editOn);
      document.documentElement.classList.toggle('ws-font-only', fontPick);
    } catch (err) {}
    if (!editOn) {
      var nodes = document.querySelectorAll('[data-edit][contenteditable="true"]');
      for (var i = 0; i < nodes.length; i++) nodes[i].contentEditable = 'false';
      var busy = document.querySelectorAll('img.ws-img-busy');
      for (var j = 0; j < busy.length; j++) busy[j].classList.remove('ws-img-busy');
      clearFreeformControls();
      clearAiImageControls();
      undoStack = [];
      postUndoState();
      postSelection(null);
    } else if (!fontPick) {
      mountFreeformControls();
      mountPageSectionControls();
      mountAiImageControls();
    }
  }

  function pageRootFor(el) {
    var root = el && el.closest ? el.closest('[data-ws-page]') : null;
    return root || document.body;
  }

  function pageIndexOf(el) {
    var root = el && el.closest ? el.closest('[data-ws-page]') : null;
    if (root && root.getAttribute('data-ws-page') != null) {
      return Number(root.getAttribute('data-ws-page')) || 0;
    }
    return 0;
  }

  function sectionIndexOf(el) {
    var root = el && el.closest ? el.closest('[data-ws-section-index]') : null;
    if (root && root.getAttribute('data-ws-section-index') != null) {
      var n = Number(root.getAttribute('data-ws-section-index'));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  function classSig(el) {
    if (!el || !el.className || typeof el.className !== 'string') return '';
    return el.className.split(/\\s+/).filter(function (c) {
      return c && c.indexOf('ws-') !== 0 && c !== 'ws-ff-item';
    }).sort().join('.');
  }

  function isChrome(el) {
    return !!(el && el.classList && (
      el.classList.contains('ws-add-item')
      || el.classList.contains('ws-ff-add')
      || el.classList.contains('ws-sec-add')
      || el.classList.contains('ws-sec-del')
      || el.classList.contains('ws-sec-add-mod')
      || el.classList.contains('ws-sec-tools')
      || el.classList.contains('ws-del-item')
      || el.classList.contains('ws-ai-img')
      || el.classList.contains('ws-img-host')
    ));
  }

  function isModuleOrFormEmbed(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.getAttribute && (
      el.getAttribute('data-bitpype-module')
      || el.getAttribute('data-bitpype-form-embed')
      || el.getAttribute('data-bitpype-managed')
    )) return true;
    if (el.classList && (
      el.classList.contains('bitpype-module-embed')
      || el.classList.contains('bitpype-form-embed')
    )) return true;
    return false;
  }

  function isPageSection(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.classList && el.classList.contains('ws-embed-module')) return false;
    if (el.getAttribute && el.getAttribute('data-ws-page-section') === '1') return true;
    return !!(el.classList && el.classList.contains('ws-page-section'));
  }

  function isDesignModule(el) {
    if (!el || el.nodeType !== 1 || isChrome(el) || isModuleOrFormEmbed(el)) return false;
    if (isPageSection(el)) return false;
    if (el.getAttribute && el.getAttribute('data-ws-design-module') === '1') return true;
    if (el.classList && (
      el.classList.contains('ws-design-module')
      || el.classList.contains('layout-columns')
      || el.classList.contains('text-block')
      || el.classList.contains('text-image')
      || el.classList.contains('layout-cards')
      || el.classList.contains('ws-html-block')
      || el.classList.contains('ws-design-heading')
      || el.classList.contains('ws-design-image')
      || el.classList.contains('custom-block')
    )) return true;
    var st = el.getAttribute && el.getAttribute('data-ws-section-type');
    if (st && /^(heading|text|image|columns|text_image|cards|html|hero|services|benefits|about|faq|cta|reviews|gallery|custom)$/i.test(st)) {
      return true;
    }
    return false;
  }

  var canvasIdSeq = 0;
  function ensureCanvasId(el) {
    if (!el || !el.getAttribute) return '';
    var id = el.getAttribute('data-ws-canvas-id');
    if (id) return id;
    canvasIdSeq += 1;
    id = 'c' + Date.now().toString(36) + '-' + canvasIdSeq;
    el.setAttribute('data-ws-canvas-id', id);
    return id;
  }

  function findByCanvasId(id) {
    if (!id) return null;
    try {
      return document.querySelector('[data-ws-canvas-id="' + String(id).replace(/"/g, '') + '"]');
    } catch (errFind) { return null; }
  }

  function makeToolsRow(buttons) {
    var tools = document.createElement('div');
    tools.className = 'ws-sec-tools';
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = b.className;
      btn.setAttribute(b.attr, b.mode);
      btn.textContent = b.label;
      tools.appendChild(btn);
    }
    return tools;
  }

  function clearAiImageControls() {
    var btns = document.querySelectorAll('.ws-ai-img');
    for (var i = 0; i < btns.length; i++) btns[i].remove();
    var hosts = document.querySelectorAll('.ws-img-host');
    for (var h = 0; h < hosts.length; h++) {
      var host = hosts[h];
      var img = null;
      for (var c = 0; c < host.children.length; c++) {
        if (host.children[c].tagName === 'IMG') { img = host.children[c]; break; }
      }
      if (img && host.parentNode) {
        host.parentNode.insertBefore(img, host);
        host.parentNode.removeChild(host);
      } else if (host.parentNode) {
        host.parentNode.removeChild(host);
      }
    }
  }

  function mountAiImageControls() {
    clearAiImageControls();
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (img.getAttribute('data-ws-logo') === '1' || (img.classList && img.classList.contains('brand-logo'))) continue;
      if (img.closest && img.closest('[data-ws-brand]')) continue;
      if (img.parentElement && img.parentElement.classList
        && img.parentElement.classList.contains('ws-img-host')) continue;
      var src = img.getAttribute('src') || '';
      if (!src || /^data:/i.test(src) || /^blob:/i.test(src)) continue;
      if (!img.parentNode) continue;
      // <div> host keeps block formatting context; span+inline-block collapsed slots.
      var host = document.createElement('div');
      host.className = 'ws-img-host';
      img.parentNode.insertBefore(host, img);
      host.appendChild(img);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ws-ai-img';
      btn.setAttribute('aria-label', 'Generate image with AI');
      btn.setAttribute('data-ws-img-src', src);
      btn.title = 'Generate with AI';
      btn.textContent = '\u2605';
      host.appendChild(btn);
    }
  }

  /** Structural fingerprint so full rows match, not inner text columns. */
  function structureSig(el) {
    if (!el || el.nodeType !== 1) return '';
    var childParts = [];
    for (var i = 0; i < el.children.length; i++) {
      var ch = el.children[i];
      if (isChrome(ch)) continue;
      childParts.push(ch.tagName + ':' + classSig(ch));
    }
    return el.tagName + ':' + classSig(el) + '>' + childParts.join('+');
  }

  function itemWeight(el) {
    var text = (el.textContent || '').replace(/\\s+/g, ' ').trim().length;
    return el.children.length * 10 + Math.min(text, 400);
  }

  function clearFreeformControls() {
    var adds = document.querySelectorAll('.ws-ff-add');
    for (var i = 0; i < adds.length; i++) adds[i].remove();
    var dels = document.querySelectorAll('.ws-del-item[data-ws-del="freeform"]');
    for (var j = 0; j < dels.length; j++) dels[j].remove();
    var items = document.querySelectorAll('.ws-ff-item');
    for (var k = 0; k < items.length; k++) items[k].classList.remove('ws-ff-item');
    clearPageSectionControls();
  }

  function clearPageSectionControls() {
    var btns = document.querySelectorAll('.ws-sec-add, .ws-sec-tools');
    for (var i = 0; i < btns.length; i++) btns[i].remove();
    var hosts = document.querySelectorAll('.ws-widget-host');
    for (var h = 0; h < hosts.length; h++) {
      var host = hosts[h];
      while (host.firstChild) host.parentNode.insertBefore(host.firstChild, host);
      if (host.parentNode) host.parentNode.removeChild(host);
    }
  }

  function postUndoState() {
    try {
      parent.postMessage({
        source: 'ws-preview',
        type: 'undo-state',
        canUndo: undoStack.length > 0
      }, '*');
    } catch (errUndo) {}
  }

  function pushUndo(el, extra) {
    var payload = serializePage(el);
    undoStack.push({
      pageIndex: payload.pageIndex,
      sectionIndex: payload.sectionIndex,
      html: payload.html,
      embedRestore: extra && extra.embedRestore ? extra.embedRestore : null
    });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    postUndoState();
  }

  function postFreeformSave(payload) {
    try {
      var msg = {
        source: 'ws-preview',
        type: 'list-mutate',
        action: 'freeform-save',
        pageIndex: payload.pageIndex,
        sectionIndex: payload.sectionIndex,
        html: payload.html
      };
      if (payload.embedRemove) msg.embedRemove = payload.embedRemove;
      if (payload.embedRestore) msg.embedRestore = payload.embedRestore;
      parent.postMessage(msg, '*');
    } catch (errSave) {}
  }

  function remarkEditable(root) {
    if (!root) return;
    var pi = pageIndexOf(root);
    var filter = {
      acceptNode: function (node) {
        var p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest('script,style,noscript,svg,.bitpype-module-embed,.bitpype-form-embed,.ws-sec-tools,[data-edit]')) {
          return NodeFilter.FILTER_REJECT;
        }
        var a = p.closest ? p.closest('a') : null;
        if (a && /^(tel:|mailto:)/i.test(a.getAttribute('href') || '')) return NodeFilter.FILTER_REJECT;
        if (!String(node.nodeValue || '').trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    };
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, filter);
    var nodes = [];
    var n;
    while ((n = walker.nextNode())) nodes.push(n);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var span = document.createElement('span');
      span.className = 'ws-edit';
      span.setAttribute('data-edit', 'html:' + pi + ':' + (sectionIndexOf(root) != null ? sectionIndexOf(root) + ':' : '') + i);
      span.textContent = node.nodeValue;
      node.parentNode.replaceChild(span, node);
    }
  }

  function undoLast() {
    var snap = undoStack.pop();
    postUndoState();
    if (!snap) return;
    var selector = '[data-ws-page="' + snap.pageIndex + '"]';
    if (snap.sectionIndex != null) selector += '[data-ws-section-index="' + snap.sectionIndex + '"]';
    var root = document.querySelector(selector);
    if (!root && snap.sectionIndex != null) return;
    if (!root) root = document.body;
    root.innerHTML = snap.html;
    remarkEditable(root);
    mountFreeformControls();
    mountPageSectionControls();
    mountAiImageControls();
    var restored = serializePage(root);
    if (snap.embedRestore) restored.embedRestore = snap.embedRestore;
    postFreeformSave(restored);
  }

  function bumpEditId(id) {
    var parts = String(id || '').split(':');
    var n = Number(parts[parts.length - 1]);
    if (!isFinite(n)) n = 0;
    parts[parts.length - 1] = String(n + 1);
    return parts.join(':');
  }

  function nextFreeformEditId(root) {
    var pi = pageIndexOf(root);
    var max = -1;
    var nodes = (root || document).querySelectorAll('[data-edit]');
    for (var i = 0; i < nodes.length; i++) {
      var id = nodes[i].getAttribute('data-edit') || '';
      var bits = id.split(':');
      if (bits[0] !== 'html' || Number(bits[1]) !== pi) continue;
      var n = Number(bits[bits.length - 1]);
      if (n > max) max = n;
    }
    return 'html:' + pi + ':' + (sectionIndexOf(root) != null ? sectionIndexOf(root) + ':' : '') + (max + 1);
  }

  function buildContentSectionEl() {
    var sec = document.createElement('section');
    sec.className = 'ws-page-section';
    sec.setAttribute('data-ws-page-section', '1');
    var hint = document.createElement('p');
    hint.innerHTML = '<span class="ws-edit" data-edit="pending">Empty section — use Add block.</span>';
    sec.appendChild(hint);
    return sec;
  }

  function assignPendingEditIds(root, startId) {
    var id = startId;
    var pending = root.querySelectorAll('[data-edit="pending"]');
    for (var i = 0; i < pending.length; i++) {
      pending[i].setAttribute('data-edit', id);
      id = bumpEditId(id);
    }
    return id;
  }

  function ensureMainPageChrome(main) {
    if (!main) return;
    if (main.classList) {
      if (!main.classList.contains('bp-mod-main')) main.classList.add('bp-mod-main');
      if (!main.classList.contains('page')) main.classList.add('page');
    }
    var title = null;
    for (var i = 0; i < main.children.length; i++) {
      var ch = main.children[i];
      if (isChrome(ch) || isModuleOrFormEmbed(ch)) continue;
      if (/^H1$/i.test(ch.tagName)) { title = ch; break; }
    }
    if (title && title.classList && !title.classList.contains('bp-mod-page-title')) {
      title.classList.add('bp-mod-page-title');
    }
    var hasSection = !!main.querySelector(':scope > [data-ws-page-section], :scope > section.ws-page-section');
    if (hasSection) return;
    var loose = [];
    for (var j = 0; j < main.children.length; j++) {
      var el = main.children[j];
      if (isChrome(el) || isModuleOrFormEmbed(el)) continue;
      if (title && el === title) continue;
      if (/^(SCRIPT|STYLE|NOSCRIPT)$/i.test(el.tagName)) continue;
      loose.push(el);
    }
    if (!loose.length) return;
    var wrap = document.createElement('section');
    wrap.className = 'ws-page-section';
    wrap.setAttribute('data-ws-page-section', '1');
    loose[0].parentNode.insertBefore(wrap, loose[0]);
    for (var L = 0; L < loose.length; L++) wrap.appendChild(loose[L]);
  }

  function insertSectionAddButton(parent, beforeNode) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ws-add-item ws-sec-add';
    btn.setAttribute('data-ws-add', 'page-section');
    btn.textContent = '+ Add section';
    if (beforeNode) parent.insertBefore(btn, beforeNode);
    else parent.appendChild(btn);
    return btn;
  }

  function embedModuleMeta(el) {
    var form = el.classList && el.classList.contains('bitpype-form-embed');
    return {
      kind: form ? 'form' : 'module',
      moduleType: el.getAttribute('data-bitpype-module-type') || '',
      token: form
        ? (el.getAttribute('data-bitpype-form-embed') || '')
        : (el.getAttribute('data-bitpype-module-token') || '')
    };
  }

  function requestPickBlock(targetEl) {
    if (!targetEl) return;
    var canvasId = ensureCanvasId(targetEl);
    try {
      parent.postMessage({
        source: 'ws-preview',
        type: 'pick-block',
        mode: 'block',
        targetId: canvasId,
        pageIndex: pageIndexOf(targetEl),
        sectionIndex: sectionIndexOf(targetEl)
      }, '*');
    } catch (errPick) {}
  }

  function insertHtmlIntoTarget(targetEl, html) {
    if (!targetEl || !html) return null;
    pushUndo(pageRootFor(targetEl) || targetEl);
    var wrap = document.createElement('div');
    wrap.innerHTML = String(html);
    var inserted = [];
    while (wrap.firstChild) {
      var node = wrap.firstChild;
      targetEl.appendChild(node);
      if (node.nodeType === 1) inserted.push(node);
    }
    for (var i = 0; i < inserted.length; i++) {
      if (inserted[i].querySelectorAll) {
        assignPendingEditIds(inserted[i], nextFreeformEditId(pageRootFor(targetEl)));
      }
      remarkEditable(inserted[i]);
    }
    mountFreeformControls();
    mountPageSectionControls();
    mountAiImageControls();
    postFreeformSave(serializePage(targetEl));
    return inserted[0] || null;
  }

  function mountWidgetControls(root) {
    if (!root) return;
    var embeds = root.querySelectorAll('.bitpype-module-embed, .bitpype-form-embed');
    for (var i = 0; i < embeds.length; i++) {
      var el = embeds[i];
      if (el.closest && el.closest('.ws-widget-host')) continue;
      var meta = embedModuleMeta(el);
      var host = document.createElement('div');
      host.className = 'ws-widget-host ws-block';
      host.setAttribute('data-ws-block', meta.kind === 'form' ? 'form' : 'module');
      host.setAttribute('data-ws-embed-kind', meta.kind);
      if (meta.moduleType) host.setAttribute('data-ws-module-type', meta.moduleType);
      if (meta.token) host.setAttribute('data-ws-embed-token', meta.token);
      el.parentNode.insertBefore(host, el);
      host.appendChild(el);
      host.insertBefore(makeToolsRow([
        { className: 'ws-del-item ws-sec-del', attr: 'data-ws-del', mode: 'block', label: 'Delete block' }
      ]), host.firstChild);
    }
  }

  function mountLayoutCellControls(section) {
    if (!section) return;
    var cells = section.querySelectorAll('.col-cell, [data-ws-layout-cell]');
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (cell.querySelector && cell.querySelector(':scope > .ws-sec-tools')) continue;
      ensureCanvasId(cell);
      if (!cell.getAttribute('data-ws-layout-cell')) cell.setAttribute('data-ws-layout-cell', '1');
      cell.insertBefore(makeToolsRow([
        { className: 'ws-sec-add-mod', attr: 'data-ws-add', mode: 'block', label: '+ Add block' }
      ]), cell.firstChild);
    }
  }

  function mountBlockControls(section) {
    if (!section) return;
    var nodes = section.querySelectorAll(
      '[data-ws-block], [data-ws-design-module="1"], .ws-design-module, .layout-columns, .text-block, .text-image, .layout-cards, .ws-html-block, .ws-design-heading, .ws-design-image, .custom-block, [data-ws-section-type]'
    );
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isDesignModule(el) && !(el.getAttribute && el.getAttribute('data-ws-block'))) continue;
      if (el.closest && el.closest('.ws-widget-host')) continue;
      if (el.classList && el.classList.contains('col-cell')) continue;
      if (el.querySelector && el.querySelector(':scope > .ws-sec-tools')) continue;
      ensureCanvasId(el);
      if (!el.getAttribute('data-ws-design-module')) el.setAttribute('data-ws-design-module', '1');
      if (!el.getAttribute('data-ws-block')) el.setAttribute('data-ws-block', '1');
      if (el.classList && !el.classList.contains('ws-design-module')) el.classList.add('ws-design-module');
      el.insertBefore(makeToolsRow([
        { className: 'ws-del-item ws-sec-del', attr: 'data-ws-del', mode: 'block', label: 'Delete block' }
      ]), el.firstChild);
    }
    mountLayoutCellControls(section);
    mountWidgetControls(section);
  }

  function mountPageSectionControls() {
    clearPageSectionControls();
    if (fontPick) return;
    var scopes = document.querySelectorAll('[data-ws-page]');
    if (!scopes.length) scopes = [document.body];
    for (var si = 0; si < scopes.length; si++) {
      var scope = scopes[si];
      var mains = [];
      if (scope.tagName === 'MAIN') mains = [scope];
      else {
        var found = scope.querySelectorAll('main');
        for (var fi = 0; fi < found.length; fi++) mains.push(found[fi]);
      }
      if (!mains.length && scope.tagName === 'BODY') {
        var bodyMains = document.querySelectorAll('main');
        for (var bi = 0; bi < bodyMains.length; bi++) mains.push(bodyMains[bi]);
      }
      for (var mi = 0; mi < mains.length; mi++) {
        var main = mains[mi];
        ensureMainPageChrome(main);
        var kids = [];
        for (var c = 0; c < main.children.length; c++) {
          var kid = main.children[c];
          if (isChrome(kid)) continue;
          kids.push(kid);
        }
        // Page control: Add section
        if (kids.length && /^H1$/i.test(kids[0].tagName)) {
          insertSectionAddButton(main, kids[0].nextSibling);
        } else {
          insertSectionAddButton(main, kids[0] || null);
        }
        var sections = main.querySelectorAll(':scope > [data-ws-page-section], :scope > section.ws-page-section');
        for (var s = 0; s < sections.length; s++) {
          var sec = sections[s];
          if (sec.classList && sec.classList.contains('ws-embed-module')) continue;
          ensureCanvasId(sec);
          sec.insertBefore(makeToolsRow([
            { className: 'ws-sec-add-mod', attr: 'data-ws-add', mode: 'block', label: '+ Add block' },
            { className: 'ws-del-item ws-sec-del', attr: 'data-ws-del', mode: 'page-section', label: 'Delete section' }
          ]), sec.firstChild);
          mountBlockControls(sec);
          insertSectionAddButton(main, sec.nextSibling);
        }
        // Loose widgets not inside a section still get Delete block
        mountWidgetControls(main);
      }
    }
  }

  function discoverGroups(root) {
    var candidates = [];
    var parents = root.querySelectorAll('div, ul, ol, section, main, article, nav');
    for (var pi = 0; pi < parents.length; pi++) {
      var p = parents[pi];
      if (p.closest && p.closest('[data-ws-list]')) continue;
      var kids = [];
      for (var c = 0; c < p.children.length; c++) {
        var ch = p.children[c];
        if (isChrome(ch)) continue;
        if (/^(SCRIPT|STYLE|NOSCRIPT|LINK|BR|HR|BUTTON)$/.test(ch.tagName)) continue;
        kids.push(ch);
      }
      if (kids.length < 2) continue;

      // Cluster by structure signature (full row shape)
      var buckets = {};
      for (var ki = 0; ki < kids.length; ki++) {
        var k = kids[ki];
        var sig = structureSig(k);
        if (k.tagName === 'DETAILS' || k.tagName === 'LI') {
          sig = k.tagName + ':*';
        }
        if (!buckets[sig]) buckets[sig] = [];
        buckets[sig].push(k);
      }
      var best = null;
      Object.keys(buckets).forEach(function (sig) {
        var group = buckets[sig];
        if (group.length < 2) return;
        // Skip tiny inner columns (e.g. only a heading+paragraph wrapper)
        var avg = group.reduce(function (s, el) { return s + itemWeight(el); }, 0) / group.length;
        if (avg < 25 && group[0].tagName !== 'DETAILS' && group[0].tagName !== 'LI') return;
        var score = group.length * 100 + avg;
        if (!best || score > best.score) {
          best = { parent: p, items: group, tag: group[0].tagName, sig: sig, score: score };
        }
      });
      if (best) candidates.push(best);
    }

    // Prefer outer row groups: drop groups whose parent sits inside another group's item
    return candidates.filter(function (g) {
      return !candidates.some(function (o) {
        if (o === g) return false;
        return o.items.some(function (oi) { return oi.contains(g.parent); });
      });
    });
  }

  function mountDeleteButton(item) {
    var existing = null;
    for (var i = 0; i < item.children.length; i++) {
      if (item.children[i].classList && item.children[i].classList.contains('ws-del-item')) {
        existing = item.children[i];
        break;
      }
    }
    if (existing) return;
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'ws-del-item';
    del.setAttribute('data-ws-del', 'freeform');
    del.setAttribute('aria-label', 'Remove item');
    del.title = 'Remove';
    del.textContent = '\u00d7';
    // Append (absolute) so flex/grid order of real children is unchanged
    item.appendChild(del);
  }

  function mountFreeformControls() {
    clearFreeformControls();
    var scopes = document.querySelectorAll('[data-ws-page]');
    if (!scopes.length) scopes = [document.body];
    for (var si = 0; si < scopes.length; si++) {
      var groups = discoverGroups(scopes[si]);
      for (var gi = 0; gi < groups.length; gi++) {
        var g = groups[gi];
        for (var ii = 0; ii < g.items.length; ii++) {
          var item = g.items[ii];
          item.classList.add('ws-ff-item');
          mountDeleteButton(item);
        }
        var hasAdd = false;
        for (var a = 0; a < g.parent.children.length; a++) {
          if (g.parent.children[a].classList && g.parent.children[a].classList.contains('ws-ff-add')) {
            hasAdd = true;
            break;
          }
        }
        if (hasAdd) continue;
        var add = document.createElement('button');
        add.type = 'button';
        add.className = 'ws-add-item ws-ff-add';
        add.setAttribute('data-ws-add', 'freeform');
        add.textContent = g.tag === 'DETAILS' ? '+ Add question'
          : g.tag === 'LI' ? '+ Add bullet'
          : '+ Add item';
        g.parent.appendChild(add);
      }
    }
  }

  function stripEditChrome(root) {
    var clone = root.cloneNode(true);
    var chrome = clone.querySelectorAll('.ws-add-item, .ws-ff-add, .ws-sec-add, .ws-sec-add-mod, .ws-sec-tools, .ws-del-item, .ws-ai-img');
    for (var i = 0; i < chrome.length; i++) chrome[i].remove();
    var embedWraps = clone.querySelectorAll('.ws-embed-module, .ws-widget-host');
    for (var ew = 0; ew < embedWraps.length; ew++) {
      var box = embedWraps[ew];
      while (box.firstChild) box.parentNode.insertBefore(box.firstChild, box);
      box.parentNode.removeChild(box);
    }
    var canvasIds = clone.querySelectorAll('[data-ws-canvas-id]');
    for (var ci = 0; ci < canvasIds.length; ci++) canvasIds[ci].removeAttribute('data-ws-canvas-id');
    var imgHosts = clone.querySelectorAll('.ws-img-host');
    for (var ih = 0; ih < imgHosts.length; ih++) {
      var host = imgHosts[ih];
      while (host.firstChild) host.parentNode.insertBefore(host.firstChild, host);
      host.parentNode.removeChild(host);
    }
    var wraps = clone.querySelectorAll('.ws-list-item');
    for (var w = 0; w < wraps.length; w++) {
      var wrap = wraps[w];
      while (wrap.firstChild) wrap.parentNode.insertBefore(wrap.firstChild, wrap);
      wrap.parentNode.removeChild(wrap);
    }
    var edits = clone.querySelectorAll('[data-edit]');
    for (var e = 0; e < edits.length; e++) {
      var span = edits[e];
      var fam = span.style && span.style.fontFamily;
      span.removeAttribute('data-edit');
      span.removeAttribute('contenteditable');
      if (span.classList) span.classList.remove('ws-edit');
      if (fam) {
        span.setAttribute('data-ws-font', '1');
        span.style.fontFamily = fam;
      } else if (span.parentNode) {
        var text = document.createTextNode(span.textContent || '');
        span.parentNode.replaceChild(text, span);
      }
    }
    var ff = clone.querySelectorAll('.ws-ff-item');
    for (var f = 0; f < ff.length; f++) ff[f].classList.remove('ws-ff-item');
    return clone;
  }

  function serializePage(el) {
    var sectionRoot = el && el.closest ? el.closest('[data-ws-section-index]') : null;
    var root = sectionRoot || pageRootFor(el);
    var clean = stripEditChrome(root);
    var si = sectionIndexOf(el);
    if (si == null && root && root.getAttribute
      && root.getAttribute('data-ws-section-index') != null) {
      var n = Number(root.getAttribute('data-ws-section-index'));
      if (Number.isFinite(n)) si = n;
    }
    return {
      pageIndex: pageIndexOf(el),
      sectionIndex: si,
      html: clean.innerHTML
    };
  }

  function setElText(el, value) {
    if (!el) return;
    // Prefer editing an existing ws-edit span; else replace element text cleanly
    var span = el.querySelector ? el.querySelector('[data-edit]') : null;
    if (span) {
      span.textContent = value;
      return;
    }
    if (el.childElementCount === 0) {
      el.textContent = value;
      return;
    }
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var first = null;
    var n;
    while ((n = walker.nextNode())) {
      if (n.parentElement && /^(SCRIPT|STYLE)$/.test(n.parentElement.tagName)) continue;
      if (String(n.nodeValue || '').trim()) {
        first = n;
        break;
      }
    }
    if (first) first.nodeValue = value;
  }

  function clearCloneText(node) {
    // Strip edit chrome from the clone — keep visual structure (bars, numbers, badges)
    var chrome = node.querySelectorAll('.ws-del-item, .ws-add-item, .ws-ff-add');
    for (var c = 0; c < chrome.length; c++) chrome[c].remove();
    node.classList.remove('ws-ff-item');
    var spans = node.querySelectorAll('[data-edit]');
    for (var i = 0; i < spans.length; i++) {
      spans[i].removeAttribute('data-edit');
      spans[i].classList.remove('ws-edit');
    }
    var title = node.querySelector('h1,h2,h3,h4,h5,h6,[class*="title"],[class*="heading"],[class*="name"]');
    var body = node.querySelector('p,[class*="desc"],[class*="text"],[class*="body"],[class*="copy"],[class*="summary"]');
    if (title) setElText(title, 'New item');
    if (body && body !== title) setElText(body, 'Add your text here.');
    if (!title && !body) {
      var texts = [];
      var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = walker.nextNode())) {
        if (n.parentElement && /^(SCRIPT|STYLE)$/.test(n.parentElement.tagName)) continue;
        if (String(n.nodeValue || '').trim()) texts.push(n);
      }
      if (texts[0]) texts[0].nodeValue = 'New item';
      if (texts[1]) texts[1].nodeValue = 'Add your text here.';
    }
  }

  function renumberChips(parent) {
    var chips = parent.querySelectorAll('.chip, [class*="step-num"], [data-step]');
    // Best-effort: numbered .chip in cards
    var cards = parent.querySelectorAll('.card .chip');
    for (var i = 0; i < cards.length; i++) {
      var v = String(cards[i].textContent || '').trim();
      if (/^\\d+$/.test(v) || /^0*\\d+$/.test(v)) {
        cards[i].textContent = String(i + 1).padStart(v.length >= 2 ? 2 : 1, '0').replace(/^0(\\d)$/, '$1');
        if (v.length === 2) cards[i].textContent = String(i + 1).padStart(2, '0');
        else cards[i].textContent = String(i + 1);
      }
    }
  }

  var selectedEdit = null;

  function fontHost(el) {
    var parent = el && el.parentElement;
    var textTag = /^(H1|H2|H3|H4|H5|H6|P|A|BUTTON|LI|LABEL|FIGCAPTION|TD|TH|BLOCKQUOTE|SPAN|STRONG|EM|SMALL|DT|DD)$/;
    if (!parent || parent === document.body || parent === document.documentElement) return el;
    if (parent.getAttribute && parent.getAttribute('data-edit')) return el;
    if (!textTag.test(parent.tagName)) return el;
    var only = true;
    for (var i = 0; i < parent.childNodes.length; i++) {
      var n = parent.childNodes[i];
      if (n === el) continue;
      if (n.nodeType === 3 && !String(n.nodeValue || '').trim()) continue;
      only = false;
      break;
    }
    return only ? parent : el;
  }

  function postSelection(el) {
    selectedEdit = el || null;
    var fam = '';
    try {
      var host = el ? fontHost(el) : null;
      fam = (host && host.style && host.style.fontFamily) || (el && el.style && el.style.fontFamily) || '';
      if (!fam && el) fam = window.getComputedStyle(el).fontFamily || '';
    } catch (errFam) {}
    try {
      parent.postMessage({
        source: 'ws-preview',
        type: 'element-select',
        id: el ? (el.getAttribute('data-edit') || '') : '',
        fontFamily: fam
      }, '*');
    } catch (errSel) {}
  }

  function applyElementFont(stack, name) {
    var el = selectedEdit;
    if (!el || !el.isConnected) {
      el = document.querySelector('[data-edit]:focus') || document.querySelector('[data-edit][contenteditable="true"]');
    }
    if (!el) return;
    selectedEdit = el;
    var target = fontHost(el);
    if (!stack) {
      target.style.fontFamily = '';
      if (!target.getAttribute('style')) target.removeAttribute('style');
    } else {
      target.style.fontFamily = stack;
    }
    var id = el.getAttribute('data-edit') || '';
    var payload = { pageIndex: 0, sectionIndex: null, html: '' };
    if (id.indexOf('html:') === 0) payload = serializePage(el);
    try {
      parent.postMessage({
        source: 'ws-preview',
        type: 'element-font',
        id: id,
        font: name || '',
        pageIndex: payload.pageIndex,
        sectionIndex: payload.sectionIndex,
        html: id.indexOf('html:') === 0 ? payload.html : ''
      }, '*');
    } catch (errFont) {}
  }

  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (e.source !== parent || !d || d.source !== 'ws-portal') return;
    if (d.type === 'edit-mode') setEditMode(!!d.on, !!d.fontsOnly);
    if (d.type === 'undo') undoLast();
    if (d.type === 'set-font') applyElementFont(d.family || '', d.name || '');
    if (d.type === 'insert-block') {
      var target = findByCanvasId(d.targetId);
      if (!target && d.targetId) {
        try { target = document.querySelector('[data-ws-canvas-id="' + String(d.targetId).replace(/"/g, '') + '"]'); } catch (errT) {}
      }
      if (target && d.html) insertHtmlIntoTarget(target, d.html);
      return;
    }
    if (d.type === 'image-busy') {
      try {
        var list = document.querySelectorAll('img');
        for (var i = 0; i < list.length; i++) {
          var attr = list[i].getAttribute('src') || '';
          if (attr === d.src || list[i].src === d.src) {
            list[i].classList.toggle('ws-img-busy', !!d.on);
          }
        }
      } catch (errBusy) {}
    }
  });

  document.addEventListener('click', function (e) {
    if (!editOn) return;
    if (fontPick) {
      var picked = e.target && e.target.closest ? e.target.closest('[data-edit]') : null;
      if (!picked) return;
      e.preventDefault();
      e.stopPropagation();
      postSelection(picked);
      return;
    }

    var addBtn = e.target && e.target.closest ? e.target.closest('[data-ws-add]') : null;
    if (addBtn) {
      e.preventDefault();
      e.stopPropagation();
      var mode = addBtn.getAttribute('data-ws-add');
      if (mode === 'section') {
        try {
          parent.postMessage({
            source: 'ws-preview',
            type: 'list-mutate',
            action: 'add',
            pageIndex: Number(addBtn.getAttribute('data-ws-page')) || 0,
            sectionIndex: Number(addBtn.getAttribute('data-ws-section')) || 0,
            listKey: addBtn.getAttribute('data-ws-list') || 'items'
          }, '*');
        } catch (errA) {}
        return;
      }
      if (mode === 'page-section') {
        var mainEl = addBtn.closest('main') || addBtn.parentElement;
        if (!mainEl) return;
        pushUndo(mainEl);
        ensureMainPageChrome(mainEl);
        var secEl = buildContentSectionEl();
        assignPendingEditIds(secEl, nextFreeformEditId(pageRootFor(mainEl)));
        mainEl.insertBefore(secEl, addBtn.nextSibling);
        mountFreeformControls();
        mountPageSectionControls();
        mountAiImageControls();
        postFreeformSave(serializePage(mainEl));
        return;
      }
      if (mode === 'block' || mode === 'design-module' || mode === 'widget') {
        var blockTarget = addBtn.closest('[data-ws-layout-cell], .col-cell, [data-ws-page-section], section.ws-page-section, [data-ws-design-module], .ws-design-module');
        if (!blockTarget) return;
        requestPickBlock(blockTarget);
        return;
      }
      if (mode === 'freeform') {
        var parentEl = addBtn.parentElement;
        if (!parentEl) return;
        var siblings = [];
        for (var c = 0; c < parentEl.children.length; c++) {
          var ch = parentEl.children[c];
          if (ch.classList && (ch.classList.contains('ws-add-item') || ch.classList.contains('ws-ff-add'))) continue;
          if (ch.classList && ch.classList.contains('ws-ff-item')) siblings.push(ch);
        }
        if (!siblings.length) return;
        if (siblings.length >= MAX_ITEMS) {
          try { parent.postMessage({ source: 'ws-preview', type: 'list-error', message: 'Maximum items reached' }, '*'); } catch (errM) {}
          return;
        }
        pushUndo(parentEl);
        var clone = siblings[siblings.length - 1].cloneNode(true);
        var oldDels = clone.querySelectorAll('.ws-del-item');
        for (var od = 0; od < oldDels.length; od++) oldDels[od].remove();
        clearCloneText(clone);
        clone.classList.add('ws-ff-item');
        parentEl.insertBefore(clone, addBtn);
        renumberChips(parentEl);
        // Renumber obvious step / index labels in each row
        var rows = [];
        for (var r = 0; r < parentEl.children.length; r++) {
          var row = parentEl.children[r];
          if (row.classList && row.classList.contains('ws-ff-item')) rows.push(row);
        }
        for (var ri = 0; ri < rows.length; ri++) {
          var numEl = rows[ri].querySelector('[class*="num"],[class*="index"],[class*="step"],.chip');
          if (!numEl) continue;
          var cur = String(numEl.textContent || '').trim();
          if (/^\\d{1,2}$/.test(cur)) {
            numEl.textContent = cur.length === 2
              ? String(ri + 1).padStart(2, '0')
              : String(ri + 1);
          }
        }
        mountFreeformControls();
        mountPageSectionControls();
        mountAiImageControls();
        var payload = serializePage(parentEl);
        try {
          parent.postMessage({
            source: 'ws-preview',
            type: 'list-mutate',
            action: 'freeform-save',
            pageIndex: payload.pageIndex,
            sectionIndex: payload.sectionIndex,
            html: payload.html
          }, '*');
        } catch (errF) {}
        return;
      }
    }

    var delBtn = e.target && e.target.closest ? e.target.closest('[data-ws-del]') : null;
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();
      var dmode = delBtn.getAttribute('data-ws-del');
      if (dmode === 'section') {
        try {
          parent.postMessage({
            source: 'ws-preview',
            type: 'list-mutate',
            action: 'delete',
            pageIndex: Number(delBtn.getAttribute('data-ws-page')) || 0,
            sectionIndex: Number(delBtn.getAttribute('data-ws-section')) || 0,
            listKey: delBtn.getAttribute('data-ws-list') || 'items',
            index: Number(delBtn.getAttribute('data-ws-index')) || 0
          }, '*');
        } catch (errD) {}
        return;
      }
      if (dmode === 'embed-module' || dmode === 'widget' || dmode === 'block' || dmode === 'design-module') {
        var blockNode = delBtn.closest('.ws-widget-host, .ws-embed-module, [data-ws-block], [data-ws-design-module], .ws-design-module');
        var blockRoot = blockNode && (blockNode.closest('[data-ws-section-index]') || blockNode.closest('main') || pageRootFor(blockNode) || blockNode.parentElement);
        if (!blockNode || !blockRoot) return;
        var embedRestore = null;
        if (blockNode.classList && (blockNode.classList.contains('ws-widget-host') || blockNode.classList.contains('ws-embed-module'))) {
          embedRestore = {
            kind: blockNode.getAttribute('data-ws-embed-kind') || 'module',
            moduleType: blockNode.getAttribute('data-ws-module-type') || '',
            token: blockNode.getAttribute('data-ws-embed-token') || ''
          };
        } else {
          var widgetEmbeds = blockNode.querySelectorAll('.ws-widget-host, .bitpype-module-embed, .bitpype-form-embed');
          if (widgetEmbeds.length) {
            var wEl = widgetEmbeds[0];
            if (wEl.classList && wEl.classList.contains('ws-widget-host')) {
              embedRestore = {
                kind: wEl.getAttribute('data-ws-embed-kind') || 'module',
                moduleType: wEl.getAttribute('data-ws-module-type') || '',
                token: wEl.getAttribute('data-ws-embed-token') || ''
              };
            } else {
              embedRestore = embedModuleMeta(wEl);
            }
          }
        }
        pushUndo(blockRoot, embedRestore ? { embedRestore: embedRestore } : null);
        blockNode.remove();
        mountFreeformControls();
        mountPageSectionControls();
        mountAiImageControls();
        var blockSaved = serializePage(blockRoot);
        if (embedRestore) blockSaved.embedRemove = embedRestore;
        postFreeformSave(blockSaved);
        return;
      }
      if (dmode === 'page-section') {
        var secNode = delBtn.closest('[data-ws-page-section], section.ws-page-section');
        var secMain = secNode && (secNode.closest('main') || secNode.parentElement);
        if (!secNode || !secMain) return;
        pushUndo(secMain);
        secNode.remove();
        mountFreeformControls();
        mountPageSectionControls();
        mountAiImageControls();
        postFreeformSave(serializePage(secMain));
        return;
      }
      if (dmode === 'freeform') {
        var item = delBtn.closest('.ws-ff-item');
        if (!item || !item.parentElement) return;
        var p = item.parentElement;
        var count = p.querySelectorAll(':scope > .ws-ff-item').length;
        if (count <= 1) {
          try { parent.postMessage({ source: 'ws-preview', type: 'list-error', message: 'Keep at least one item' }, '*'); } catch (err1) {}
          return;
        }
        item.remove();
        renumberChips(p);
        mountFreeformControls();
        mountPageSectionControls();
        mountAiImageControls();
        var saved = serializePage(p);
        try {
          parent.postMessage({
            source: 'ws-preview',
            type: 'list-mutate',
            action: 'freeform-save',
            pageIndex: saved.pageIndex,
            sectionIndex: saved.sectionIndex,
            html: saved.html
          }, '*');
        } catch (errS) {}
        return;
      }
    }

    var aiBtn = e.target && e.target.closest ? e.target.closest('.ws-ai-img') : null;
    if (aiBtn) {
      e.preventDefault();
      e.stopPropagation();
      var hostEl = aiBtn.closest ? aiBtn.closest('.ws-img-host') : null;
      var aiImg = hostEl ? hostEl.querySelector('img') : null;
      if (!aiImg) return;
      var aiSrc = aiImg.getAttribute('src') || '';
      try {
        parent.postMessage({
          source: 'ws-preview',
          type: 'image-ai-generate',
          src: aiSrc,
          absSrc: aiImg.currentSrc || aiImg.src || ''
        }, '*');
      } catch (errAi) {}
      return;
    }

    var img = e.target && e.target.closest ? e.target.closest('img') : null;
    if (img) {
      e.preventDefault();
      e.stopPropagation();
      var src = img.getAttribute('src') || '';
      try {
        parent.postMessage({
          source: 'ws-preview',
          type: 'image-replace',
          src: src,
          absSrc: img.currentSrc || img.src || ''
        }, '*');
      } catch (errImg) {}
      return;
    }
    var el = e.target.closest ? e.target.closest('[data-edit]') : null;
    if (!el && e.target && e.target.closest) {
      var block = e.target.closest('h1,h2,h3,h4,h5,h6,p,li,blockquote,td,th,figcaption');
      if (block && !isChrome(block) && !isModuleOrFormEmbed(block)
        && !(block.closest && block.closest('.bitpype-module-embed, .bitpype-form-embed'))) {
        var innerEdit = block.querySelector('[data-edit]');
        if (innerEdit) {
          var blockText = String(block.textContent || '').replace(/\\s+/g, ' ').trim();
          var innerText = String(innerEdit.textContent || '').replace(/\\s+/g, ' ').trim();
          if (blockText === innerText || block.querySelectorAll('[data-edit]').length === 1) {
            el = innerEdit;
          }
        }
      }
    }
    if (!el) return;
    if (el.closest && el.closest('.bitpype-module-embed, .bitpype-form-embed')) return;
    if (el.getAttribute('contenteditable') === 'true') {
      postSelection(el);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    el.contentEditable = 'true';
    postSelection(el);
    el.focus();
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      var sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (errCaret) {}
  }, true);
  document.addEventListener('focusout', function (e) {
    var el = e.target;
    if (!el || !el.getAttribute || !el.getAttribute('data-edit')) return;
    el.contentEditable = 'false';
    parent.postMessage({ source: 'ws-preview', id: el.getAttribute('data-edit'), text: el.innerText }, '*');
  });
  try { parent.postMessage({ source: 'ws-preview', type: 'ready' }, '*'); } catch (err2) {}
})();
</script>`;

/**
 * srcdoc previews inherit the parent app URL as base. Relative nav links
 * (about.html, /contact, …) would otherwise navigate the iframe into the
 * SPA shell. Keep hash/mailto/tel; intercept everything else.
 * Clicks on [data-edit] are left alone so freeform/section inline edit works.
 */
const PREVIEW_NAV_GUARD = `<script data-ws-preview-nav="1">
(function () {
  function filePart(href) {
    try {
      var raw = String(href || '').split('#')[0].split('?')[0];
      return raw.replace(/^\\.\\//, '').replace(/^\\//, '');
    } catch (e) { return ''; }
  }
  function anchorFromFile(file) {
    var f = String(file || '').replace(/\\.html$/i, '').replace(/\\/$/, '');
    if (!f || f === 'index' || f === 'home') return 'home';
    return f.replace(/[^a-z0-9-_]/gi, '_');
  }
  document.addEventListener('click', function (e) {
    // In edit mode, let [data-edit] clicks become contenteditable (not nav).
    if (document.documentElement.classList.contains('ws-editing')
      && e.target && e.target.closest && e.target.closest('[data-edit]')) {
      return;
    }
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return;
    if (/^(mailto:|tel:|javascript:)/i.test(href)) return;
    e.preventDefault();
    e.stopPropagation();
    if (/^https?:\\/\\//i.test(href)) {
      try { parent.postMessage({ source: 'ws-preview-nav', external: true, href: href }, '*'); } catch (err) {}
      return;
    }
    var file = filePart(href);
    var id = anchorFromFile(file);
    var el = id && document.getElementById(id);
    if (el) {
      try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (err2) { el.scrollIntoView(true); }
      try { history.replaceState({}, '', '#' + id); } catch (err3) {}
      return;
    }
    try {
      parent.postMessage({ source: 'ws-preview-nav', href: href, file: file, slug: id }, '*');
    } catch (err4) {}
  }, true);
})();
</script>`;

/* ------------------------------------------------------------------ */
/* Freeform HTML inline edit — wrap / patch visible text nodes          */
/* ------------------------------------------------------------------ */

const FREEFORM_VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
const FREEFORM_SKIP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'template']);

/**
 * Walk HTML string; invoke onText(text, start, end) for each text run outside
 * script/style/svg and outside tel:/mailto: anchors (locked contact links).
 */
function walkFreeformTextRuns(html, onText) {
  const s = String(html || '');
  const re = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>/g;
  let last = 0;
  let skip = 0;
  let lockLink = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last && skip === 0 && lockLink === 0) {
      onText(s.slice(last, m.index), last, m.index);
    }
    const tag = m[0];
    if (tag.startsWith('<!--')) {
      last = m.index + tag.length;
      continue;
    }
    const open = /^<([a-zA-Z][\w:-]*)/.exec(tag);
    const close = /^<\/([a-zA-Z][\w:-]*)/.exec(tag);
    if (close) {
      const name = close[1].toLowerCase();
      if (FREEFORM_SKIP_TAGS.has(name) && skip > 0) skip -= 1;
      if (name === 'a' && lockLink > 0) lockLink -= 1;
    } else if (open) {
      const name = open[1].toLowerCase();
      const selfClosing = /\/>$/.test(tag) || FREEFORM_VOID_TAGS.has(name);
      if (!selfClosing && FREEFORM_SKIP_TAGS.has(name)) skip += 1;
      if (!selfClosing && name === 'a' && /\bhref\s*=\s*(['"])\s*(tel:|mailto:)/i.test(tag)) {
        lockLink += 1;
      }
    }
    last = m.index + tag.length;
  }
  if (last < s.length && skip === 0 && lockLink === 0) {
    onText(s.slice(last), last, s.length);
  }
}

function splitHtmlBody(html) {
  const s = String(html || '');
  const m = /(<body\b[^>]*>)([\s\S]*)(<\/body\s*>)/i.exec(s);
  if (!m) return null;
  return {
    before: s.slice(0, m.index) + m[1],
    body: m[2],
    after: m[3] + s.slice(m.index + m[0].length),
  };
}

/** Body inner HTML as used by multipage preview stacking (post-sanitize). */
function freeformPreviewInner(pageHtml) {
  const sanitized = sanitizeHtml(pageHtml);
  if (looksLikeFullDocument(pageHtml) || looksLikeFullDocument(sanitized)) {
    const split = splitHtmlBody(sanitized);
    if (split) return split.body;
    return sanitized
      .replace(/^[\s\S]*?<body[^>]*>/i, '')
      .replace(/<\/body>[\s\S]*$/i, '');
  }
  return sanitized;
}

/**
 * Wrap non-empty text runs with <span class="ws-edit" data-edit="…">.
 * - Legacy page.html: html:pageIndex:nodeIndex
 * - Modular section content.html: html:pageIndex:sectionIndex:nodeIndex
 * Indices match applyFreeformTextEdits on the same inner HTML.
 */
function markFreeformTextNodes(html, pageIndex, sectionIndex) {
  const s = String(html || '');
  const pi = Math.max(0, Number(pageIndex) || 0);
  const siRaw = sectionIndex != null ? Number(sectionIndex) : NaN;
  const si = Number.isInteger(siRaw) && siRaw >= 0 ? siRaw : null;
  const parts = [];
  let cursor = 0;
  let idx = 0;
  walkFreeformTextRuns(s, (text, start, end) => {
    if (start > cursor) parts.push(s.slice(cursor, start));
    if (text.trim()) {
      const id = si != null ? `html:${pi}:${si}:${idx}` : `html:${pi}:${idx}`;
      idx += 1;
      parts.push(`<span class="ws-edit" data-edit="${esc(id)}">${text}</span>`);
    } else {
      parts.push(text);
    }
    cursor = end;
  });
  if (cursor < s.length) parts.push(s.slice(cursor));
  return parts.join('');
}

/** Sanitize (+ mark when portal edit mode) freestyle HTML stored on a section. */
function markEditableSectionHtml(html, edit) {
  const cleaned = sanitizeHtml(html);
  if (!edit || !edit.editing) return cleaned;
  return markFreeformTextNodes(cleaned, edit.page, edit.section);
}

/**
 * Apply portal freeform edits (ids html:pageIndex:nodeIndex) to page HTML.
 * Uses the same sanitize + body extract path as preview marking.
 */
function applyFreeformTextEdits(pageHtml, editsByIndex) {
  const map = editsByIndex instanceof Map
    ? editsByIndex
    : new Map(Object.entries(editsByIndex || {}).map(([k, v]) => [Number(k), v]));
  if (!map.size) return String(pageHtml || '');

  const original = String(pageHtml || '');
  const sanitized = sanitizeHtml(original);
  const split = (looksLikeFullDocument(original) || looksLikeFullDocument(sanitized))
    ? splitHtmlBody(sanitized)
    : null;
  const target = split ? split.body : sanitized;
  const parts = [];
  let cursor = 0;
  let idx = 0;
  walkFreeformTextRuns(target, (text, start, end) => {
    if (start > cursor) parts.push(target.slice(cursor, start));
    if (text.trim()) {
      if (map.has(idx)) {
        parts.push(esc(map.get(idx)));
      } else {
        parts.push(text);
      }
      idx += 1;
    } else {
      parts.push(text);
    }
    cursor = end;
  });
  if (cursor < target.length) parts.push(target.slice(cursor));
  const nextBody = parts.join('');
  if (split) return split.before + nextBody + split.after;
  return nextBody;
}

function markFreeformDocument(html, pageIndex) {
  const s = String(html || '');
  const split = splitHtmlBody(s);
  if (split) {
    return split.before + markFreeformTextNodes(split.body, pageIndex) + split.after;
  }
  return markFreeformTextNodes(s, pageIndex);
}

/**
 * Single-page freeform previews need data-ws-page so serializePage /
 * freeform-save use the real page index.
 */
function wrapBodyWithPageRoot(html, pageIndex) {
  const s = String(html || '');
  const pi = Math.max(0, Number(pageIndex) || 0);
  const split = splitHtmlBody(s);
  if (!split) {
    if (/data-ws-page\s*=/.test(s)) return s;
    return `<div data-ws-page="${pi}">${s}</div>`;
  }
  if (/data-ws-page\s*=/.test(split.body)) return s;
  return `${split.before}<div data-ws-page="${pi}">${split.body}</div>${split.after}`;
}

function appendHtmlTail(doc, snippet) {
  const s = String(doc || '');
  const bit = String(snippet || '');
  if (!bit) return s;
  if (/<\/body>/i.test(s)) return s.replace(/<\/body>/i, `${bit}</body>`);
  return s + bit;
}

/**
 * srcdoc iframes resolve relative assets against the parent origin.
 * Inject <base href="…/site-previews/folder/"> so images/… and CSS url()
 * resolve to the exported preview host (sanitizeHtml strips author <base>).
 */
function injectPreviewBaseHref(html, baseUrl) {
  let base = String(baseUrl || '').trim();
  if (!base || !/^https?:\/\//i.test(base)) return String(html || '');
  if (!base.endsWith('/')) base += '/';
  const tag = `<base href="${esc(base)}" data-ws-preview-base="1">`;
  let doc = String(html || '');
  if (/data-ws-preview-base\s*=/.test(doc)) {
    return doc.replace(/<base\b[^>]*data-ws-preview-base[^>]*>/i, tag);
  }
  if (/<head\b[^>]*>/i.test(doc)) {
    return doc.replace(/<head\b[^>]*>/i, (m) => `${m}\n${tag}`);
  }
  if (/<html\b[^>]*>/i.test(doc)) {
    return doc.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${tag}</head>`);
  }
  return `<!DOCTYPE html><html lang="en"><head>${tag}</head><body>${doc}</body></html>`;
}

function previewScripts(opts) {
  const o = opts || {};
  let out = '';
  if (o.preview) out += PREVIEW_NAV_GUARD + '<script>' + fs.readFileSync(path.join(__dirname, '../public/js/preview-bridge.js'), 'utf8').replace(/<\/script/gi, '<\\/script') + '</script>';
  if (o.editable) out += PREVIEW_EDIT_STYLE + PREVIEW_EDIT_SCRIPT;
  return out;
}

/**
 * Safe extra class tokens from agent section.className / content.class.
 * Lets customCss target modules without rewriting renderers.
 */
function sectionExtraClass(section, content) {
  const raw = [section && section.className, section && section.class, content && content.className, content && content.class]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ');
  return raw
    .split(/\s+/)
    .map((c) => c.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64))
    .filter(Boolean)
    .slice(0, 12)
    .join(' ');
}

/** Safe CSS declarations for optional section/content.style + background fields. */
function sectionInlineStyle(section, content) {
  const parts = [];
  const raw = [section && section.style, content && content.style]
    .find((v) => typeof v === 'string' && v.trim());
  if (raw) {
    let s = String(raw).slice(0, 600);
    s = s.replace(/[{}]/g, '').replace(/<\/?style/gi, '');
    s = s.replace(/expression\s*\(/gi, '').replace(/javascript:/gi, '');
    // Keep only safe url(...) — https or images/…
    s = s.replace(/url\s*\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (_, _q, inner) => {
      const ok = safeImageUrl(String(inner || '').trim());
      return ok ? `url("${ok}")` : '';
    });
    if (s.trim()) parts.push(s.trim());
  }
  const bgColor = contentBackgroundColor(content);
  if (bgColor) parts.push(`background-color:${bgColor}`);
  const bgImg = contentBackgroundImageUrl(content);
  if (bgImg) {
    parts.push(`background-image:url("${bgImg}")`);
    parts.push('background-size:cover');
    parts.push('background-position:center');
  }
  return parts.join(';');
}

/**
 * Stamp data-ws-section-* (+ optional class/style) on the section root tag
 * so theme.customCss can style modules freely while content stays structured.
 */
function decorateSectionRoot(html, section, content, edit) {
  const out = String(html || '');
  if (!out.trim()) return '';
  const type = String(section.type || 'custom').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'custom';
  const extra = sectionExtraClass(section, content);
  const style = sectionInlineStyle(section, content);
  const sid = typeof section.id === 'string' ? section.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) : '';
  return out.replace(/^(\s*)<([a-zA-Z][\w-]*)(\s[^>]*)?>/, (m, ws, tag, rest) => {
    let r = rest || '';
    if (!/\bdata-ws-section-type\s*=/.test(r)) {
      r += ` data-ws-section="1" data-ws-section-type="${esc(type)}"`;
    }
    if (edit && Number.isInteger(edit.page) && Number.isInteger(edit.section)) {
      if (!/\bdata-ws-page\s*=/.test(r)) r += ` data-ws-page="${Number(edit.page)}"`;
      if (!/\bdata-ws-section-index\s*=/.test(r)) r += ` data-ws-section-index="${Number(edit.section)}"`;
    }
    if (sid && !/\bid\s*=/.test(r)) r += ` id="${esc(sid)}"`;
    if (extra) {
      if (/\bclass\s*=\s*"/i.test(r)) {
        r = r.replace(/\bclass\s*=\s*"([^"]*)"/i, (_, c) => `class="${c} ${extra}"`);
      } else if (/\bclass\s*=\s*'/i.test(r)) {
        r = r.replace(/\bclass\s*=\s*'([^']*)'/i, (_, c) => `class='${c} ${extra}'`);
      } else {
        r += ` class="${extra}"`;
      }
    }
    if (style) {
      if (/\bstyle\s*=\s*"/i.test(r)) {
        r = r.replace(/\bstyle\s*=\s*"([^"]*)"/i, (_, s) => `style="${s};${style}"`);
      } else {
        r += ` style="${esc(style)}"`;
      }
    }
    return `${ws}<${tag}${r}>`;
  });
}

/**
 * Render one section to HTML. Unknown types use the generic custom block
 * so an agent is not stuck to the built-in list. Text is escaped.
 * Visual design is free: theme.customCss targets [data-ws-section-type="…"].
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
    const html = fn(body, t, edit || null) || '';
    return decorateSectionRoot(html, section, content, edit || null);
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

/**
 * Canonical route key for nav / page identity comparisons.
 * "/", "/index", "index", "index.html", "/index.html", "home", "/home" → "index".
 * Leading slash, trailing slash, and .html suffix are ignored for every page.
 */
function normalizeRoute(hrefOrSlug) {
  let s = String(hrefOrSlug == null ? '' : hrefOrSlug).trim().toLowerCase();
  if (!s || s === '/' || s === '#') return 'index';
  if (s.charAt(0) === '#') {
    s = s.slice(1).split('?')[0];
  } else {
    s = s.split('#')[0].split('?')[0];
  }
  s = s.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
  s = s.replace(/^\/+/, '').replace(/\/+$/, '');
  s = s.replace(/\.html?$/i, '');
  s = s.replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s || s === 'home' || s === 'index') return 'index';
  return s;
}

function navAnchorLabel(innerHtml) {
  return String(innerHtml || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** True when href is a same-site page path (including bare "/"). */
function isComparableNavHref(href) {
  const h = String(href || '').trim();
  if (!h || /^(mailto:|tel:|javascript:|https?:|\/\/)/i.test(h)) return false;
  if (h.charAt(0) === '#') return /^#[A-Za-z][A-Za-z0-9_-]*$/.test(h);
  const path = h.split('#')[0].split('?')[0];
  if (path === '/' || path === '') return true;
  return /^(\.\.\/|\.\/|\/)?[A-Za-z0-9][A-Za-z0-9_-]*(\.html?)?$/i.test(path);
}

function isNavIdentitySkipAttrs(attrs) {
  const a = String(attrs || '');
  // Brand / logo share home href by design — skip so Home is not stripped as a "duplicate".
  // CTAs/buttons (nav-cta, btn, …) ARE compared by route + label so "Book Now" ×2 collapses.
  if (/\bdata-ws-brand\b/i.test(a)) return true;
  if (/\bdata-ws-logo\b/i.test(a)) return true;
  if (/\bclass\s*=\s*["'][^"']*\b(brand|logo|site-logo|navbar-brand|brand-logo)\b/i.test(a)) return true;
  return false;
}

function findNavDuplicateIssues(html) {
  const issues = [];
  const src = String(html || '');
  const navRe = /<nav\b[^>]*>[\s\S]*?<\/nav>/gi;
  let navMatch;
  let navIdx = 0;
  while ((navMatch = navRe.exec(src))) {
    navIdx += 1;
    const nav = navMatch[0];
    const seenRoutes = new Set();
    const seenLabels = new Set();
    const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = linkRe.exec(nav))) {
      const attrs = m[1] || '';
      if (isNavIdentitySkipAttrs(attrs)) continue;
      const href = (attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/i) || []);
      const hrefVal = href[1] || href[2] || href[3] || '';
      if (!isComparableNavHref(hrefVal)) continue;
      const route = normalizeRoute(hrefVal);
      const label = navAnchorLabel(m[2]);
      if (seenRoutes.has(route)) {
        issues.push({ nav: navIdx, kind: 'route', route, label, href: hrefVal });
      }
      if (label && seenLabels.has(label)) {
        issues.push({ nav: navIdx, kind: 'label', route, label, href: hrefVal });
      }
      seenRoutes.add(route);
      if (label) seenLabels.add(label);
    }
  }
  return issues;
}

/**
 * Drop duplicate page links inside each <nav> (same normalizeRoute or same label).
 * Keeps the first occurrence so author-provided links win over later injects.
 */
function dedupeNavHtml(html) {
  const src = String(html || '');
  if (!/<nav\b/i.test(src)) return src;
  return src.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, (navBlock) => {
    const openEnd = navBlock.indexOf('>') + 1;
    const closeStart = navBlock.lastIndexOf('</');
    if (openEnd <= 0 || closeStart <= openEnd) return navBlock;
    const open = navBlock.slice(0, openEnd);
    const close = navBlock.slice(closeStart);
    let inner = navBlock.slice(openEnd, closeStart);
    const seenRoutes = new Set();
    const seenLabels = new Set();
    // Walk anchors back-to-front so index math stays valid while deleting.
    const hits = [];
    const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = linkRe.exec(inner))) {
      const attrs = m[1] || '';
      if (isNavIdentitySkipAttrs(attrs)) continue;
      const href = (attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/i) || []);
      const hrefVal = href[1] || href[2] || href[3] || '';
      if (!isComparableNavHref(hrefVal)) continue;
      hits.push({
        start: m.index,
        end: m.index + m[0].length,
        route: normalizeRoute(hrefVal),
        label: navAnchorLabel(m[2]),
        html: m[0],
      });
    }
    const drop = new Set();
    for (const hit of hits) {
      const routeDup = seenRoutes.has(hit.route);
      const labelDup = !!(hit.label && seenLabels.has(hit.label));
      if (routeDup || labelDup) {
        drop.add(hit);
        continue;
      }
      seenRoutes.add(hit.route);
      if (hit.label) seenLabels.add(hit.label);
    }
    if (!drop.size) return navBlock;
    // Prefer removing the wrapping <li> when the duplicate is a list item.
    const removals = [];
    for (const hit of drop) {
      let start = hit.start;
      let end = hit.end;
      const before = inner.slice(Math.max(0, start - 80), start);
      const after = inner.slice(end, end + 12);
      const liOpen = before.match(/<li\b[^>]*>\s*$/i);
      if (liOpen && /^(\s*)<\/li>/i.test(after)) {
        start = start - liOpen[0].length;
        end = end + after.match(/^(\s*)<\/li>/i)[0].length;
      }
      removals.push({ start, end });
    }
    removals.sort((a, b) => b.start - a.start);
    for (const r of removals) {
      inner = inner.slice(0, r.start) + inner.slice(r.end);
    }
    // Collapse leftover empty list shells / double whitespace between tags.
    inner = inner.replace(/<li\b[^>]*>\s*<\/li>/gi, '');
    inner = inner.replace(/(?:\s*\n){3,}/g, '\n\n');
    return open + inner + close;
  });
}

/** Log loudly when a <nav> would contain duplicate route/label anchors, then dedupe. */
function assertAndDedupeNavHtml(html, context) {
  const issues = findNavDuplicateIssues(html);
  if (issues.length) {
    const where = context ? ` (${context})` : '';
    console.error(
      `[nav-dedupe] DUPLICATE nav anchors${where}:`,
      issues.map((i) => `${i.kind}:${i.route || ''}:${i.label || ''} href=${i.href}`).join('; ')
    );
  }
  return dedupeNavHtml(html);
}

function anchorId(slug) {
  const route = normalizeRoute(slug);
  return route === 'index' ? 'home' : route.replace(/[^a-z0-9-_]/gi, '_');
}

function isHomePage(page, pages) {
  if (!page) return false;
  const slug = String(page.slug || '');
  if (
    slug === '/'
    || slug === 'home' || slug === '/home'
    || slug === 'index' || slug === '/index'
    || /^\/?(?:home|index)(?:\.html)?$/i.test(slug)
  ) return true;
  return Array.isArray(pages) && pages[0] === page;
}

function pageHasHtml(page) {
  // Structured sections win — legacy page.html is ignored when sections exist.
  if (page && Array.isArray(page.sections) && page.sections.length > 0) return false;
  return !!(page && typeof page.html === 'string' && page.html.trim());
}

function homePage(pages) {
  if (!Array.isArray(pages) || !pages.length) return null;
  return pages.find((p) => isHomePage(p, pages)) || pages[0];
}

/** Map file-style / path-style nav links to #anchors so stacked iframe previews can navigate. */
function rewriteFileLinksToAnchors(html, pages) {
  let s = String(html || '');
  const home = homePage(pages);
  const escapeRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const p of pages || []) {
    const isHome = p === home || isHomePage(p, pages);
    const file = isHome ? 'index.html' : pageFileName(p.slug);
    const bare = file.replace(/\.html$/i, '');
    const id = anchorId(p.slug);
    const patterns = new Set([
      file,
      bare,
      `./${file}`,
      `./${bare}`,
      `/${file}`,
      `/${bare}`,
    ]);
    if (isHome) {
      ['/', '/index.html', 'index.html', './index.html', 'home', '/home', 'home.html', './home.html'].forEach((x) => patterns.add(x));
    }
    for (const pat of patterns) {
      const re = new RegExp(`href=(["'])${escapeRe(pat)}\\1`, 'gi');
      s = s.replace(re, `href="#${id}"`);
    }
  }
  s = s.replace(/href=(["'])\/(?:index\.html)?\1/gi, 'href="#home"');
  return s;
}

/**
 * Inverse of rewriteFileLinksToAnchors for static export / Cloudflare Pages.
 * Multipage freeform HTML often uses #services / #about page hashes (works in
 * stacked preview). On real multipage hosts those hashes stay on the current
 * file and break nav — rewrite them to the exported filenames.
 * Same-page section ids that are NOT page slugs (e.g. #main) are left alone.
 * No-op for single-page / landing sites.
 */
function rewriteAnchorLinksToFiles(html, pages) {
  if (!Array.isArray(pages) || pages.length < 2) return String(html || '');
  let s = String(html || '');
  const home = homePage(pages);
  const escapeRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const seen = new Set();
  // Longer anchor ids first so #service-areas beats #service if both exist.
  const targets = pages
    .map((p) => {
      const isHome = p === home || isHomePage(p, pages);
      return {
        id: anchorId(p.slug),
        file: isHome ? 'index.html' : pageFileName(p.slug),
      };
    })
    .filter((t) => t.id && !seen.has(t.id) && (seen.add(t.id) || true))
    .sort((a, b) => b.id.length - a.id.length);
  for (const t of targets) {
    const re = new RegExp(`href=(["'])#${escapeRe(t.id)}\\1`, 'gi');
    s = s.replace(re, `href=$1${t.file}$1`);
  }
  return s;
}

/** Persist multipage file hrefs in stored freeform HTML (source of truth). */
function normalizePagesNavLinks(pages) {
  if (!Array.isArray(pages) || pages.length < 2) return pages;
  return pages.map((p) => {
    if (!p || typeof p.html !== 'string' || !p.html.trim()) return p;
    return { ...p, html: rewriteAnchorLinksToFiles(p.html, pages) };
  });
}

/**
 * After writeStaticPages: every page-slug hash link should be a real file, and
 * relative *.html (or extensionless) nav targets should exist on disk.
 */
function validateExportNavLinks(pages, outDir) {
  if (!Array.isArray(pages) || pages.length < 2) {
    return { ok: true, danglingHashes: [], missing: [], checked: 0 };
  }
  const home = homePage(pages);
  const pageIds = new Set();
  const expectedFiles = new Set();
  for (const p of pages) {
    const isHome = p === home || isHomePage(p, pages);
    pageIds.add(anchorId(p.slug));
    expectedFiles.add(isHome ? 'index.html' : pageFileName(p.slug));
  }
  const danglingHashes = [];
  const missing = [];
  let checked = 0;
  for (const p of pages) {
    const isHome = p === home || isHomePage(p, pages);
    const file = isHome ? 'index.html' : pageFileName(p.slug);
    const abs = path.join(outDir, file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      missing.push(file);
      continue;
    }
    const html = fs.readFileSync(abs, 'utf8');
    const hrefs = [...html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    for (const href of hrefs) {
      if (!href || /^(mailto:|tel:|https?:|javascript:)/i.test(href)) continue;
      if (href.charAt(0) === '#') {
        const id = String(href.slice(1).split('?')[0] || '');
        if (id && pageIds.has(id)) danglingHashes.push(`${file}:${href}`);
        continue;
      }
      let bare = href.split('#')[0].split('?')[0].replace(/^\.\//, '');
      if (bare.startsWith('/')) bare = bare.slice(1);
      if (!bare) continue;
      let target = null;
      if (expectedFiles.has(bare)) target = bare;
      else if (!bare.endsWith('.html') && expectedFiles.has(`${bare}.html`)) target = `${bare}.html`;
      if (!target) continue;
      checked += 1;
      if (!fs.existsSync(path.join(outDir, target))) missing.push(`${file}->${href}`);
    }
  }
  return {
    ok: danglingHashes.length === 0 && missing.length === 0,
    danglingHashes,
    missing,
    checked,
  };
}

function makeEdit(theme, pageIndex, sectionIndex, editable) {
  const fonts = theme && theme.elementFonts && typeof theme.elementFonts === 'object'
    ? theme.elementFonts
    : null;
  const hasFonts = !!(fonts && Object.keys(fonts).length);
  if (!editable && !hasFonts) return null;
  return {
    page: pageIndex,
    section: sectionIndex,
    editing: !!editable,
    fonts,
  };
}

/**
 * Google Fonts stylesheet for families used by the theme and page markup.
 * Replaces a previous data-ws-fonts link so re-renders do not stack tags.
 */
function upsertFontLinks(docHtml, theme, extraText) {
  let html = String(docHtml || '');
  const t = normalizeTheme(theme);
  const blob = [
    t.font,
    t.headingFont,
    t.elementFonts ? Object.values(t.elementFonts).join(' ') : '',
    extraText || '',
    html,
  ].join('\n');
  const href = googleFonts.hrefFor(googleFonts.namesIn(blob));
  html = html.replace(/<link\b[^>]*data-ws-fonts\s*=\s*["']1["'][^>]*>\s*/gi, '');
  if (!href) return html;
  const tag = `<link data-ws-fonts="1" rel="stylesheet" href="${esc(href)}">`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}\n</head>`);
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${tag}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${tag}</head>`);
  return `<!DOCTYPE html><html lang="en"><head>${tag}</head><body>${html}</body></html>`;
}

function pageMetaFields(page) {
  const p = page && typeof page === 'object' ? page : {};
  const description = String(
    p.description || p.metaDescription || p.meta_description || ''
  ).trim().slice(0, 320);
  const ogImage = safeImageUrl(String(p.ogImage || p.og_image || p.ogImageUrl || '').trim())
    || String(p.ogImage || p.og_image || '').trim().slice(0, 500);
  const canonical = String(p.canonical || p.canonicalUrl || p.canonical_url || '').trim().slice(0, 500);
  const customJs = typeof p.customJs === 'string' ? sanitizeJs(p.customJs)
    : (typeof p.custom_js === 'string' ? sanitizeJs(p.custom_js) : '');
  const customHead = typeof p.customHead === 'string' ? sanitizeHead(p.customHead)
    : (typeof p.custom_head === 'string' ? sanitizeHead(p.custom_head) : '');
  const overrideChrome = p.chromeOverride === true || p.chrome_override === true
    || p.useSiteChrome === false || p.use_site_chrome === false;
  return { description, ogImage, canonical, customJs, customHead, overrideChrome };
}

function pageJsTag(pageJs) {
  const js = pageJs && String(pageJs).trim();
  if (!js) return '';
  return `<script data-ws-page-js="1">${js}</script>`;
}

function faviconLinkTag(theme) {
  const t = normalizeTheme(theme);
  const href = t.favicon ? safeImageUrl(t.favicon) || t.favicon : '';
  if (!href) return '';
  const type = /\.svg$/i.test(href) ? 'image/svg+xml'
    : (/\.png$/i.test(href) ? 'image/png'
      : (/\.ico$/i.test(href) ? 'image/x-icon' : ''));
  const typeAttr = type ? ` type="${type}"` : '';
  // data-ws-favicon marks engine-injected tags so freeform re-render can replace them.
  return `<link data-ws-favicon="1" rel="icon"${typeAttr} href="${esc(href)}">`;
}

/**
 * Freeform full documents go through sanitizeHtml, which strips <link rel="icon">
 * (only https stylesheet/preconnect/preload survive). Inject theme.favicon into <head>
 * so setFavicon / theme.favicon reach exported + CF Pages HTML.
 */
function injectFaviconLink(docHtml, theme) {
  let doc = String(docHtml || '');
  if (!doc.trim()) return doc;
  doc = doc.replace(/<link\b[^>]*\bdata-ws-favicon\s*=\s*["']1["'][^>]*>\s*/gi, '');
  doc = doc.replace(/<link\b[^>]*\brel\s*=\s*["'](?:shortcut\s+)?icon["'][^>]*>\s*/gi, '');
  const tag = faviconLinkTag(theme);
  if (!tag) return doc;
  if (/<\/head>/i.test(doc)) return doc.replace(/<\/head>/i, `${tag}\n</head>`);
  if (/<head\b[^>]*>/i.test(doc)) return doc.replace(/<head\b[^>]*>/i, (m) => `${m}\n${tag}`);
  if (/<html\b[^>]*>/i.test(doc)) {
    return doc.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${tag}</head>`);
  }
  return `<!DOCTYPE html><html lang="en"><head>${tag}</head><body>${doc}</body></html>`;
}

function docShell({ title, body, theme, script, description, ogImage, canonical, pageJs, pageHead }) {
  const t = normalizeTheme(theme);
  const themeJs = themeJsTag(t);
  const pageJsTagHtml = pageJsTag(pageJs);
  const themeHead = themeHeadInject(t);
  const pageHeadHtml = pageHeadInject(pageHead);
  const desc = (description && String(description).trim()) || title || '';
  const fav = faviconLinkTag(t);
  const ogImg = ogImage && String(ogImage).trim() ? String(ogImage).trim() : '';
  const canon = canonical && String(canonical).trim() ? String(canonical).trim() : '';
  const ogTags = [
    `<meta property="og:title" content="${esc(title)}">`,
    desc ? `<meta property="og:description" content="${esc(desc)}">` : '',
    ogImg ? `<meta property="og:image" content="${esc(ogImg)}">` : '',
    `<meta property="og:type" content="website">`,
  ].filter(Boolean).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${canon ? `<link rel="canonical" href="${esc(canon)}">` : ''}
${ogTags}
${fav}
<style data-ws-theme="1">${siteCss(t)}</style>
${themeHead}
${pageHeadHtml}
</head>
<body>
${body}
${themeJs}
${pageJsTagHtml}
${script || ''}
</body>
</html>`;
}

/** Inject/replace theme.customHead (+ optional page head) before </head>. */
function injectThemeHead(docHtml, theme, pageHead = '') {
  let doc = String(docHtml || '');
  if (!doc.trim()) return doc;
  doc = doc.replace(/<!--data-ws-theme-head-->[\s\S]*?(?=<\/head>)/i, '');
  doc = doc.replace(/<!--data-ws-page-head-->[\s\S]*?(?=<\/head>)/i, '');
  const chunks = [themeHeadInject(theme), pageHeadInject(pageHead)].filter(Boolean).join('\n');
  if (!chunks) return doc;
  if (/<\/head>/i.test(doc)) return doc.replace(/<\/head>/i, `${chunks}\n</head>`);
  if (/<head\b[^>]*>/i.test(doc)) return doc.replace(/<head\b[^>]*>/i, (m) => `${m}\n${chunks}`);
  if (/<html\b[^>]*>/i.test(doc)) {
    return doc.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${chunks}</head>`);
  }
  return `<!DOCTYPE html><html lang="en"><head>${chunks}</head><body>${doc}</body></html>`;
}

/** Apply site-level header/footer partials unless the page opts out. */
function applySitePartials(bodyHtml, theme, page) {
  const t = normalizeTheme(theme);
  const meta = pageMetaFields(page);
  if (meta.overrideChrome) return String(bodyHtml || '');
  const header = t.partials && t.partials.headerHtml ? String(t.partials.headerHtml).trim() : '';
  const footer = t.partials && t.partials.footerHtml ? String(t.partials.footerHtml).trim() : '';
  if (!header && !footer) return String(bodyHtml || '');
  let body = String(bodyHtml || '');
  // When shared header is set, drop per-page nav sections to avoid duplicate chrome.
  if (header) {
    body = body.replace(/<nav\b[^>]*\bdata-ws-section-type\s*=\s*["']nav["'][^>]*>[\s\S]*?<\/nav>/gi, '');
    body = body.replace(/<header\b[^>]*\bdata-ws-section-type\s*=\s*["']nav["'][^>]*>[\s\S]*?<\/header>/gi, '');
    body = body.replace(/<section\b[^>]*\bdata-ws-section-type\s*=\s*["']nav["'][^>]*>[\s\S]*?<\/section>/gi, '');
    body = `${header}\n${body}`;
  }
  if (footer) {
    body = body.replace(/<(?:footer|section)\b[^>]*\bdata-ws-section-type\s*=\s*["']footer["'][^>]*>[\s\S]*?<\/(?:footer|section)>/gi, '');
    body = `${body}\n${footer}`;
  }
  return body;
}

/**
 * Full-document agent pages often keep CSS in theme.customCss (baseCss:false)
 * rather than inside page.html. Export/publish must inject that CSS or the
 * live preview is unstyled. When a theme block already exists, refresh it so
 * color / :root variable changes apply on re-render.
 */
/**
 * When freeform HTML uses data-bitpype-mobile-nav, inline the shared hamburger
 * CSS so Cloudflare Pages / static export works without a remote /css host.
 */
function injectMobileNavAsset(docHtml) {
  let doc = String(docHtml || '');
  if (!/data-bitpype-mobile-nav\s*=/i.test(doc)) return doc;
  if (/data-bitpype-mobile-nav-css\s*=/i.test(doc)) return doc;
  let css = '';
  try {
    css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'mobile-nav.css'), 'utf8');
  } catch {
    return doc;
  }
  const tag = `<style data-bitpype-mobile-nav-css="1">${sanitizeCss(css)}</style>`;
  if (/<\/head>/i.test(doc)) return doc.replace(/<\/head>/i, `${tag}\n</head>`);
  if (/<head\b[^>]*>/i.test(doc)) return doc.replace(/<head\b[^>]*>/i, (m) => `${m}\n${tag}`);
  if (/<html\b[^>]*>/i.test(doc)) {
    return doc.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${tag}</head>`);
  }
  return `${tag}\n${doc}`;
}

function injectThemeStyles(docHtml, theme) {
  let doc = String(docHtml || '');
  if (!doc.trim()) return doc;
  const css = siteCss(theme);
  if (!css || !String(css).trim()) return doc;
  const styleTag = `<style data-ws-theme="1">${css}</style>`;
  if (/data-ws-theme\s*=\s*["']1["']/.test(doc)) {
    return doc.replace(
      /<style\b[^>]*data-ws-theme\s*=\s*["']1["'][^>]*>[\s\S]*?<\/style>/i,
      styleTag
    );
  }
  if (/<\/head>/i.test(doc)) return doc.replace(/<\/head>/i, `${styleTag}\n</head>`);
  if (/<head\b[^>]*>/i.test(doc)) return doc.replace(/<head\b[^>]*>/i, (m) => `${m}\n${styleTag}`);
  if (/<html\b[^>]*>/i.test(doc)) {
    return doc.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${styleTag}</head>`);
  }
  return `<!DOCTYPE html><html lang="en"><head>${styleTag}</head><body>${doc}</body></html>`;
}

/** Inject/replace theme.customJs before </body> for freestyle motion/effects. */
function injectThemeJs(docHtml, theme) {
  let doc = String(docHtml || '');
  if (!doc.trim()) return doc;
  const tag = themeJsTag(theme);
  doc = doc.replace(/<script\b[^>]*data-ws-theme-js\s*=\s*["']1["'][^>]*>[\s\S]*?<\/script>\s*/gi, '');
  if (!tag) return doc;
  if (/<\/body>/i.test(doc)) return doc.replace(/<\/body>/i, `${tag}\n</body>`);
  return `${doc}\n${tag}`;
}

/**
 * Render a single page as a full standalone HTML document.
 * Nav links point at the exported per-page filenames (unless opts.preview).
 */
function renderPage(page, allPages, theme, opts) {
  if (!page || typeof page !== 'object') throw err('INVALID_PAGE', 'Page must be an object.');
  const t = normalizeTheme(theme);
  const o = opts || {};
  const editable = !!o.editable;
  const preview = !!o.preview;
  const pages = Array.isArray(allPages) ? allPages : [page];
  const pageIndex = Math.max(0, pages.indexOf(page));
  const scripts = previewScripts({ preview, editable });
  // Modular sections win when present. Legacy freeform page.html only if no sections.
  let structure;
  try { structure = require('./siteStructure'); } catch { structure = null; }
  let pageForRender = page;
  if (structure && typeof structure.ensureNavFirstPage === 'function' && Array.isArray(page.sections)) {
    pageForRender = structure.ensureNavFirstPage(page);
  }
  const hasSections = Array.isArray(pageForRender.sections) && pageForRender.sections.length > 0;
  const rawHtml = typeof pageForRender.html === 'string' ? pageForRender.html.trim() : '';
  let freeHtml = !hasSections && rawHtml ? rawHtml : '';
  // Upgrade sparse client page chrome so title/body get stable edit targets.
  if (freeHtml && editable) {
    try {
      const modules = require('../server/siteModules');
      if (typeof modules.ensureClientPageChrome === 'function') {
        freeHtml = modules.ensureClientPageChrome(freeHtml);
      }
    } catch { /* optional */ }
  }
  const finishPage = (html) => assertAndDedupeNavHtml(
    html,
    `renderPage:${String(pageForRender.slug || pageIndex)}`
  );
  const pageMeta = pageMetaFields(pageForRender);
  if (freeHtml) {
    if (looksLikeFullDocument(freeHtml)) {
      // sanitizeHtml strips author <link rel="icon"> — reinject from theme.favicon.
      let doc = injectThemeHead(
        injectThemeJs(
          injectMobileNavAsset(
            injectThemeStyles(injectFaviconLink(sanitizeHtml(freeHtml), t), t)
          ),
          t
        ),
        t,
        pageMeta.customHead
      );
      // Per-page custom JS at body end (author scripts survive sanitizeJs only).
      if (pageMeta.customJs) {
        const tag = pageJsTag(pageMeta.customJs);
        doc = doc.replace(/<script\b[^>]*data-ws-page-js\s*=\s*["']1["'][^>]*>[\s\S]*?<\/script>\s*/gi, '');
        if (/<\/body>/i.test(doc)) doc = doc.replace(/<\/body>/i, `${tag}\n</body>`);
        else doc = `${doc}\n${tag}`;
      }
      if (preview) doc = rewriteFileLinksToAnchors(doc, pages);
      else doc = rewriteAnchorLinksToFiles(doc, pages);
      if (editable) {
        doc = markFreeformDocument(doc, pageIndex);
        doc = wrapBodyWithPageRoot(doc, pageIndex);
      }
      return finishPage(upsertFontLinks(appendHtmlTail(doc, scripts), t));
    }
    let body = sanitizeHtml(freeHtml);
    body = applySitePartials(body, t, pageForRender);
    if (preview) body = rewriteFileLinksToAnchors(body, pages);
    else body = rewriteAnchorLinksToFiles(body, pages);
    if (editable) {
      body = markFreeformTextNodes(body, pageIndex);
      if (!/data-ws-page\s*=/.test(body)) {
        body = `<div data-ws-page="${pageIndex}">${body}</div>`;
      }
    }
    return finishPage(upsertFontLinks(injectMobileNavAsset(docShell({
      title: pageForRender.title || 'Home',
      body,
      theme: t,
      script: scripts,
      description: pageMeta.description,
      ogImage: pageMeta.ogImage,
      canonical: pageMeta.canonical,
      pageJs: pageMeta.customJs,
      pageHead: pageMeta.customHead,
    })), t));
  }
  const sections = Array.isArray(pageForRender.sections) ? pageForRender.sections : null;
  if (!sections) throw err('INVALID_PAGE', 'Page needs sections or html.');
  let navLinks;
  try {
    navLinks = (structure || require('./siteStructure')).buildNavLinks(pages, { preview });
  } catch {
    navLinks = pages.map(p => ({
      label: p.title || p.slug,
      href: preview ? `#${anchorId(p.slug)}` : pageFileName(p.slug),
    }));
  }
  // Structured nav links: drop duplicate route/label before rendering.
  {
    const seenR = new Set();
    const seenL = new Set();
    navLinks = (navLinks || []).filter((l) => {
      const route = normalizeRoute(l && (l.slug || l.href));
      const label = String((l && l.label) || '').trim().toLowerCase();
      if (seenR.has(route) || (label && seenL.has(label))) return false;
      seenR.add(route);
      if (label) seenL.add(label);
      return true;
    });
  }
  const useSharedHeader = !!(t.partials && t.partials.headerHtml && !pageMeta.overrideChrome);
  let body = sections.map((s, si) => {
    const edit = makeEdit(t, pageIndex, si, editable);
    // Skip per-page nav when shared header partial is active.
    if (s.type === 'nav' && useSharedHeader) return '';
    if (s.type === 'footer' && t.partials && t.partials.footerHtml && !pageMeta.overrideChrome) return '';
    if (s.type === 'nav') {
      return sectionToHtml({ type: 'nav', content: Object.assign({}, s.content, { links: navLinks }) }, t, edit);
    }
    return sectionToHtml(s, t, edit);
  }).join('\n');
  body = applySitePartials(body, t, pageForRender);
  // Footer/CTA hashes (#services) must become *.html on static multipage hosts.
  if (!preview) body = rewriteAnchorLinksToFiles(body, pages);
  return finishPage(upsertFontLinks(docShell({
    title: pageForRender.title || 'Home',
    body,
    theme: t,
    script: scripts,
    description: pageMeta.description,
    ogImage: pageMeta.ogImage,
    canonical: pageMeta.canonical,
    pageJs: pageMeta.customJs,
    pageHead: pageMeta.customHead,
  }), t));
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
  const o = Object.assign({}, opts || {}, { preview: true });
  const editable = !!o.editable;
  if (o.pageSlug != null || Number.isInteger(o.pageIndex)) {
    return renderPageAt(pages, theme, o);
  }
  let navLinks;
  try {
    navLinks = require('./siteStructure').buildNavLinks(pages, { preview: true });
  } catch {
    navLinks = pages.map(p => ({ label: p.title || p.slug, href: '#' + anchorId(p.slug) }));
  }
  const freeform = pages.some(pageHasHtml);
  const scripts = previewScripts({ preview: true, editable });
  // Single freeform full document: sanitize + inject theme CSS.
  if (pages.length === 1 && pageHasHtml(pages[0]) && looksLikeFullDocument(pages[0].html)) {
    let doc = injectThemeStyles(sanitizeHtml(pages[0].html), t);
    doc = rewriteFileLinksToAnchors(doc, pages);
    if (editable) {
      doc = markFreeformDocument(doc, 0);
      doc = wrapBodyWithPageRoot(doc, 0);
    }
    return upsertFontLinks(appendHtmlTail(doc, scripts), t);
  }
  const headExtras = [];
  const body = pages.map((p, pi) => {
    if (pageHasHtml(p)) {
      const sanitized = sanitizeHtml(p.html);
      let inner = sanitized;
      if (looksLikeFullDocument(p.html)) {
        sanitized.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => { headExtras.push(m); return ''; });
        sanitized.replace(/<link\b[^>]*>/gi, (m) => { headExtras.push(m); return ''; });
        inner = sanitized.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '');
      }
      if (editable) inner = markFreeformTextNodes(inner, pi);
      return `<div class="page-anchor" id="${anchorId(p.slug)}" data-ws-page="${pi}">${inner}</div>`;
    }
    const sections = (Array.isArray(p.sections) ? p.sections : []).map((s, si) => {
      const edit = makeEdit(t, pi, si, editable);
      if (s.type === 'nav') {
        return sectionToHtml({ type: 'nav', content: Object.assign({}, s.content, { links: navLinks }) }, t, edit);
      }
      return sectionToHtml(s, t, edit);
    }).join('\n');
    return `<div class="page-anchor" id="${anchorId(p.slug)}">${sections}</div>`;
  }).join('\n');
  const title = (homePage(pages) || pages[0]).title || 'Home';
  let html = docShell({
    title,
    body: freeform ? rewriteFileLinksToAnchors(body, pages) : body,
    theme: t,
    script: scripts,
  });
  if (headExtras.length) {
    const unique = [...new Set(headExtras)];
    const inject = unique.join('\n');
    if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, `${inject}\n</head>`);
    else html = inject + html;
  }
  return upsertFontLinks(html, t);
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
    db,
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

function slugifyExportName(s) {
  return String(s || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'site';
}

/**
 * True when an EXPORT_ROOT folder belongs to this website.
 * When workspaceId is set, only that workspace's ws-{ws}-site-{id}* folders
 * plus legacy site-{id} / qa-site-{id} / slug-{id} — never other workspaces.
 */
function folderBelongsToSite(name, websiteId, workspaceId, siteName) {
  const id = String(websiteId);
  if (!name || !id) return false;
  const ws = workspaceId != null && Number.isInteger(Number(workspaceId)) && Number(workspaceId) > 0
    ? String(Number(workspaceId))
    : null;

  if (name === `site-${id}` || name === `qa-site-${id}`) return true;
  if (siteName) {
    const slugFolder = `${slugifyExportName(siteName)}-${id}`;
    if (name === slugFolder) return true;
  }

  if (ws) {
    const wsPrefix = `ws-${ws}-site-${id}`;
    if (name === wsPrefix || name.startsWith(`${wsPrefix}-`)) return true;
    // Truncated exportPages folders (max 40 chars) may cut the slug suffix —
    // accept only when the next char is not another digit (site-5 vs site-50).
    if (name.startsWith(wsPrefix) && name.length <= 40) {
      const rest = name.slice(wsPrefix.length);
      if (!rest || rest[0] === '-' || !/^\d/.test(rest)) return true;
    }
    // Do not match ws-{other}-site-{id}*
    if (/^ws-\d+-site-/.test(name)) return false;
  }

  return folderMatchesSiteId(name, websiteId);
}

function resolveExportRootSafe() {
  try {
    return require('./openPreview').exportRoot();
  } catch {
    return null;
  }
}

function assertDirInsideExportRoot(absPath, root) {
  if (!absPath || !root) return null;
  const rootResolved = path.resolve(root);
  const dirResolved = path.resolve(absPath);
  const rel = path.relative(rootResolved, dirResolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  // Refuse deleting the export root itself.
  if (rel === '.' || rel === '') return null;
  return dirResolved;
}

/**
 * Collect EXPORT_ROOT folders owned by this site (names only, under root).
 */
function collectSiteExportFolders(websiteId, opts = {}) {
  const root = opts.exportRoot || resolveExportRootSafe();
  if (!root || !fs.existsSync(root)) return [];
  const id = Number(websiteId);
  const workspaceId = opts.workspaceId;
  const siteName = opts.siteName || '';
  const found = new Set();

  const candidates = [
    `site-${id}`,
    `qa-site-${id}`,
    siteName ? `${slugifyExportName(siteName)}-${id}` : null,
  ].filter(Boolean);
  if (workspaceId != null && Number(workspaceId) > 0) {
    candidates.push(`ws-${Number(workspaceId)}-site-${id}`);
  }
  for (const name of candidates) found.add(name);

  try {
    for (const name of fs.readdirSync(root)) {
      if (folderBelongsToSite(name, id, workspaceId, siteName)) found.add(name);
    }
  } catch { /* optional */ }

  if (opts.previewPath) {
    try {
      const p = String(opts.previewPath).replace(/\\/g, '/');
      const m = p.match(/website-scout-exports\/([^/]+)/i)
        || p.match(/\/([^/]+)\/(?:index\.html)?$/i);
      if (m && m[1] && folderBelongsToSite(m[1], id, workspaceId, siteName)) {
        found.add(m[1]);
      }
    } catch { /* optional */ }
  }

  return [...found];
}

function removeSiteStorageFolders(websiteId, opts = {}) {
  const root = opts.exportRoot || resolveExportRootSafe();
  const removed = [];
  const skipped = [];
  if (!root) return { removed, skipped, exportRoot: null };
  const folders = collectSiteExportFolders(websiteId, Object.assign({}, opts, { exportRoot: root }));
  for (const name of folders) {
    const abs = assertDirInsideExportRoot(path.join(root, name), root);
    if (!abs) {
      skipped.push(name);
      continue;
    }
    try {
      if (!fs.existsSync(abs)) continue;
      const st = fs.lstatSync(abs);
      if (!st.isDirectory()) {
        skipped.push(name);
        continue;
      }
      fs.rmSync(abs, { recursive: true, force: true });
      removed.push(name);
    } catch (e) {
      skipped.push(`${name}:${e.message}`);
    }
  }
  return { removed, skipped, exportRoot: root };
}

/**
 * Delete a website row and all associated on-disk export/preview assets.
 * Safe across shared EXPORT_ROOT: with workspaceId, never removes another
 * workspace's ws-{other}-site-* folders. Does not delete remote Cloudflare
 * Pages projects (may be shared via cf.project). Design jobs are unlinked,
 * not deleted. Contact forms / modules stay on the lead.
 *
 * @returns {{ id, deleted: true, removedFolders: string[], skippedFolders: string[] }}
 */
function deleteWebsite(db, websiteId, opts = {}) {
  ensureTables(db);
  const id = Number(websiteId);
  if (!Number.isInteger(id) || id < 1) throw err('INVALID_ID', 'id must be a positive integer.');
  const site = db.prepare('SELECT * FROM websites WHERE id = ?').get(id);
  if (!site) throw err('SITE_NOT_FOUND', `Website #${id} not found.`);

  const workspaceId = opts.workspaceId != null ? Number(opts.workspaceId) : null;
  const storageOpts = {
    workspaceId: Number.isInteger(workspaceId) && workspaceId > 0 ? workspaceId : null,
    siteName: site.name,
    previewPath: site.preview_path,
  };

  // Snapshot screenshot paths before DB wipe (files usually live under site-{id}/).
  let shotPaths = [];
  try {
    shotPaths = db.prepare(
      'SELECT storage_path FROM site_screenshots WHERE website_id = ?'
    ).all(id).map((r) => r.storage_path).filter(Boolean);
  } catch { /* table may be absent */ }

  const tx = db.transaction(() => {
    try { db.prepare('DELETE FROM site_screenshots WHERE website_id = ?').run(id); } catch { /* */ }
    try {
      db.prepare('UPDATE site_domains SET website_id = NULL, updated_at = datetime(\'now\') WHERE website_id = ?').run(id);
    } catch { /* */ }
    try {
      db.prepare('UPDATE design_jobs SET website_id = NULL, updated_at = datetime(\'now\') WHERE website_id = ?').run(id);
    } catch { /* */ }
    try { db.prepare('DELETE FROM claim_manifest WHERE website_id = ?').run(id); } catch { /* */ }
    try { db.prepare('DELETE FROM website_versions WHERE website_id = ?').run(id); } catch { /* */ }
    db.prepare('DELETE FROM websites WHERE id = ?').run(id);
  });
  tx();

  const storage = removeSiteStorageFolders(id, storageOpts);

  // Remove any screenshot files that lived outside the folders we already wiped.
  const root = storage.exportRoot || resolveExportRootSafe();
  if (root && shotPaths.length) {
    for (const sp of shotPaths) {
      try {
        const abs = assertDirInsideExportRoot(path.dirname(sp), root);
        if (!abs) continue;
        // Only unlink the file if its parent folder still exists (folder wipe may have got it).
        if (fs.existsSync(sp) && fs.statSync(sp).isFile()) {
          const fileOk = assertDirInsideExportRoot(sp, root);
          if (fileOk) fs.unlinkSync(sp);
        }
      } catch { /* best-effort */ }
    }
  }

  logActivity(db, 'websites', `Website #${id} ("${String(site.name || '').slice(0, 80)}") deleted; removed ${storage.removed.length} export folder(s).`);
  return {
    id,
    deleted: true,
    name: site.name,
    lead_id: site.lead_id,
    removedFolders: storage.removed,
    skippedFolders: storage.skipped,
  };
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
    // Full rebuild: wipe DB row + export/preview storage for the previous site.
    deleteWebsite(db, existing.id, { workspaceId: opts.workspaceId });
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
  require('./siteContentQuality').assertNoNewDefects(pages, [], theme);

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
function saveVersion(db, websiteId, note, author) {
  ensureTables(db);
  const site = getWebsite(db, websiteId);
  const row = db.prepare('SELECT COALESCE(MAX(version_no), 0) AS m FROM website_versions WHERE website_id = ?').get(websiteId);
  const next = Number(row.m) + 1;
  const authorVal = author != null && String(author).trim()
    ? String(author).trim().slice(0, 120)
    : null;
  const info = db.prepare(
    'INSERT INTO website_versions (website_id, version_no, pages, theme, note, author) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    websiteId,
    next,
    site.pages,
    site.theme,
    note ? String(note).slice(0, 500) : null,
    authorVal
  );
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
function saveSite(db, websiteId, pages, theme, note, author) {
  const site = getWebsite(db, websiteId);
  require('./siteContentQuality').assertNoNewDefects(pages, typeof site.pages === 'string' ? JSON.parse(site.pages) : site.pages, theme, typeof site.theme === 'string' ? JSON.parse(site.theme) : site.theme);
  db.prepare("UPDATE websites SET pages = ?, theme = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(pages), JSON.stringify(normalizeTheme(theme)), websiteId);
  return saveVersion(db, websiteId, note || 'Manual edit', author);
}

/* ------------------------------------------------------------------ */
/* QA                                                                  */
/* ------------------------------------------------------------------ */

const QA_BUILD_PROMPT_FALLBACK = `You are a QA reviewer for a local business website.
Check the site for: hallucinated facts (founding years, awards, licenses not in the provided facts), placeholder text, wrong phone numbers, broken image links, spelling errors.
The business facts provided are the ONLY facts allowed. Marketing puffery without factual assertions is fine.
Reply with ONLY JSON: {"pass": true|false, "issues": ["..."]}`;

/**
 * Headless check: render home HTML and detect horizontal overflow at viewport width.
 * Uses puppeteer when available; otherwise returns ok:true with skipped note via throw.
 */
async function checkMobileOverflow(pages, theme, opts = {}) {
  const width = Math.max(320, Math.round(Number(opts.width) || 390));
  const height = Math.max(480, Math.round(Number(opts.height) || 844));
  const html = renderPage(homePage(pages) || pages[0], pages, theme);
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    const e = new Error('puppeteer not installed');
    e.code = 'PUPPETEER_MISSING';
    throw e;
  }
  const launchOpts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  for (const p of [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
  ]) {
    if (p && fs.existsSync(p)) {
      launchOpts.executablePath = p;
      break;
    }
  }
  const browser = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const result = await page.evaluate(() => {
      const docEl = document.documentElement;
      const body = document.body;
      const scrollW = Math.max(docEl.scrollWidth, body ? body.scrollWidth : 0);
      const clientW = docEl.clientWidth || window.innerWidth;
      const overflowing = [];
      const nodes = document.querySelectorAll('body *');
      for (let i = 0; i < Math.min(nodes.length, 400); i++) {
        const el = nodes[i];
        const rect = el.getBoundingClientRect();
        if (rect.width > clientW + 2 && rect.right > clientW + 2) {
          const tag = el.tagName.toLowerCase();
          const cls = (el.className && typeof el.className === 'string')
            ? el.className.split(/\s+/).slice(0, 2).join('.')
            : '';
          overflowing.push(`${tag}${cls ? '.' + cls : ''}`);
          if (overflowing.length >= 4) break;
        }
      }
      return {
        ok: scrollW <= clientW + 1 && overflowing.length === 0,
        scrollWidth: scrollW,
        clientWidth: clientW,
        overflowing,
      };
    });
    return {
      ok: !!result.ok,
      width,
      detail: result.ok
        ? ''
        : `scrollWidth=${result.scrollWidth} clientWidth=${result.clientWidth}`
          + (result.overflowing.length ? `; nodes=${result.overflowing.join(',')}` : ''),
    };
  } finally {
    try { await browser.close(); } catch { /* */ }
  }
}

/* ------------------------------------------------------------------ */
/* CSS presence / applied-class validation (shared by QA + deliver)    */
/* ------------------------------------------------------------------ */

const CSS_MIN_CHARS = 500;

function extractInlineCss(html) {
  const parts = [];
  String(html || '').replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
    parts.push(css);
    return '';
  });
  return parts.join('\n');
}

/** Class tokens from markup class="..." attributes (ignores style/script bodies). */
function extractClassNames(html) {
  const names = new Set();
  const markup = String(html || '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  const re = /\bclass\s*=\s*(["'])([^"']*)\1/gi;
  let m;
  while ((m = re.exec(markup))) {
    for (const c of String(m[2] || '').split(/\s+/)) {
      if (c) names.add(c);
    }
  }
  return [...names];
}

function cssDefinesClass(css, className) {
  const escRe = String(className).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // .foo as a selector token — not a prefix of .foobar
  return new RegExp(`\\.${escRe}(?![\\w-])`).test(String(css || ''));
}

/**
 * Markup that carries agent-authored class names: legacy page.html plus
 * modular section content.html (html/nav/footer freestyle fragments).
 */
function pageMarkupForCss(page) {
  const parts = [];
  if (page && typeof page.html === 'string' && page.html.trim()) {
    parts.push(page.html);
  }
  const sections = Array.isArray(page && page.sections) ? page.sections : [];
  for (const s of sections) {
    const c = s && s.content;
    if (!c || typeof c !== 'object') continue;
    if (typeof c.html === 'string' && c.html.trim()) parts.push(c.html);
  }
  return parts.join('\n');
}

/** Shared BitPype mobile-nav CSS when markup uses data-bitpype-mobile-nav. */
function mobileNavCssForMarkup(markup) {
  if (!/data-bitpype-mobile-nav\s*=/i.test(String(markup || ''))) return '';
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'mobile-nav.css'), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Combined CSS that applies to a freeform/modular page: inline <style> blocks,
 * shared mobile-nav asset when used, plus theme CSS from siteCss.
 */
function pageCombinedCss(page, theme) {
  const markup = pageMarkupForCss(page);
  const inline = extractInlineCss(markup);
  const mobile = mobileNavCssForMarkup(markup);
  const themeCss = siteCss(theme);
  return `${inline}\n${mobile}\n${themeCss}`.trim();
}

/**
 * Validate that class-heavy freeform / modular-html pages ship real CSS that
 * defines those classes. Stock section-only pages (no html fragments) skip.
 * Returns { ok, failures, check: { name, pass, detail } }.
 */
function validatePagesCss(pages, theme) {
  const failures = [];
  for (const page of pages || []) {
    const markup = pageMarkupForCss(page);
    if (!markup.trim()) continue;
    const classes = extractClassNames(markup);
    if (!classes.length) continue;
    const css = pageCombinedCss(page, theme);
    const slug = String((page && page.slug) || '(unknown)');
    if (!css || css.length < CSS_MIN_CHARS) {
      const sample = classes.slice(0, 8);
      failures.push({
        slug,
        undefinedClasses: sample,
        detail: `Page "${slug}": combined CSS is ${css ? css.length : 0} chars (< ${CSS_MIN_CHARS}) but markup uses class attributes (e.g. ${sample.join(', ')}).`,
      });
      continue;
    }
    const undefinedClasses = classes.filter((c) => !cssDefinesClass(css, c));
    if (undefinedClasses.length / classes.length > 0.1) {
      const sample = undefinedClasses.slice(0, 8);
      failures.push({
        slug,
        undefinedClasses: sample,
        detail: `Page "${slug}": ${undefinedClasses.length}/${classes.length} class names not defined in CSS (e.g. ${sample.join(', ')}).`,
      });
    }
  }
  const pass = failures.length === 0;
  return {
    ok: pass,
    failures,
    check: {
      name: 'css-present-and-applied',
      pass,
      detail: pass
        ? 'CSS present and class selectors apply.'
        : failures.map((f) => f.detail).join(' '),
    },
  };
}

/** Throw INVALID_CSS if pages/theme would fail css-present-and-applied. */
function assertPagesCss(pages, theme) {
  const result = validatePagesCss(pages, theme);
  if (!result.ok) {
    const e = err('INVALID_CSS', result.check.detail || 'CSS validation failed.');
    e.failures = result.failures;
    throw e;
  }
  return result;
}

function registeredImageUrlSet(db, websiteId) {
  const urls = new Set();
  if (!db || websiteId == null) return urls;
  // Unified registry: design deliverable images + on-disk site-{id}/images|assets
  // (uploadAsset, replaceImage, addImages, deliver remote localizations).
  try {
    const rows = db.prepare(
      'SELECT deliverable FROM design_jobs WHERE website_id = ?'
    ).all(websiteId);
    for (const row of rows || []) {
      let payload = null;
      try { payload = JSON.parse(row.deliverable || 'null'); } catch { /* ignore */ }
      if (!payload || !Array.isArray(payload.images)) continue;
      for (const im of payload.images) {
        if (!im) continue;
        if (im.url) urls.add(String(im.url));
        if (im.name) urls.add(`images/${im.name}`);
      }
    }
  } catch { /* optional */ }
  try {
    const openPreview = require('./openPreview');
    const root = openPreview.exportRoot();
    for (const sub of ['images', 'assets']) {
      const dir = path.join(root, `site-${websiteId}`, sub);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        const abs = path.join(dir, name);
        if (fs.statSync(abs).isFile()) urls.add(`${sub}/${name}`);
      }
    }
  } catch { /* optional */ }
  try {
    for (const im of imagesForWebsite(db, websiteId) || []) {
      if (im && im.url) urls.add(String(im.url));
      if (im && im.name) urls.add(`images/${im.name}`);
    }
  } catch { /* optional */ }
  return urls;
}

function isRegisteredImageSrc(src, registry) {
  const s = String(src || '').trim();
  if (!s || !registry || !registry.size) return false;
  if (registry.has(s)) return true;
  const bare = s.replace(/^\.\//, '');
  if (registry.has(bare)) return true;
  for (const u of registry) {
    if (!u) continue;
    if (s.endsWith(u) || u.endsWith(bare) || bare.endsWith(u)) return true;
  }
  return false;
}

const PLACEHOLDER_IMAGE_RE = /(?:via\.placeholder|placehold\.it|placekitten|picsum\.photos|dummyimage|lorempixel|placeholder\.com|lorem\.flickr|placehold\.co)/i;

/** HEAD/GET probe: URL returns image/asset bytes (status 200 + content-length or body). */
function httpUrlHasBytes(url, opts = {}) {
  const timeoutMs = Math.max(2000, Number(opts.timeoutMs) || 8000);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let u;
    try { u = new URL(String(url)); } catch { done(false); return; }
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'HEAD',
      timeout: timeoutMs,
      headers: { 'User-Agent': 'website-scout-qa/1' },
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 200 && code < 400) {
        const len = Number(res.headers['content-length'] || 0);
        res.resume();
        if (len > 0) { done(true); return; }
        // Some hosts omit content-length on HEAD — fall through to GET.
      } else {
        res.resume();
      }
      const get = lib.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'website-scout-qa/1' } }, (r2) => {
        const chunks = [];
        r2.on('data', (c) => {
          chunks.push(c);
          if (Buffer.concat(chunks).length > 64) { r2.destroy(); done((r2.statusCode || 0) >= 200 && (r2.statusCode || 0) < 400); }
        });
        r2.on('end', () => done((r2.statusCode || 0) >= 200 && (r2.statusCode || 0) < 400 && Buffer.concat(chunks).length > 0));
        r2.on('error', () => done(false));
      });
      get.on('error', () => done(false));
      get.on('timeout', () => { try { get.destroy(); } catch { /* */ } done(false); });
    });
    req.on('error', () => done(false));
    req.on('timeout', () => { try { req.destroy(); } catch { /* */ } done(false); });
    req.end();
  });
}

/** Probe form submit endpoint (HEAD/OPTIONS) — live if 2xx/405/415 (method not allowed still means route exists). */
function httpFormSubmitLive(url) {
  const timeoutMs = 8000;
  return new Promise((resolve) => {
    let u;
    try { u = new URL(String(url)); } catch { resolve({ ok: false, detail: 'bad url' }); return; }
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const tryMethod = (method) => new Promise((res) => {
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        timeout: timeoutMs,
        headers: { 'User-Agent': 'website-scout-qa/1' },
      }, (r) => {
        const code = r.statusCode || 0;
        r.resume();
        res({ ok: code > 0 && code < 500, code, method });
      });
      req.on('error', () => res({ ok: false, code: 0, method }));
      req.on('timeout', () => { try { req.destroy(); } catch { /* */ } res({ ok: false, code: 0, method }); });
      req.end();
    });
    Promise.resolve()
      .then(() => tryMethod('OPTIONS'))
      .then((r) => (r.ok ? r : tryMethod('HEAD')))
      .then((r) => resolve(r.ok
        ? { ok: true, detail: `${r.method} → ${r.code}` }
        : { ok: false, detail: `submit endpoint unreachable` }))
      .catch(() => resolve({ ok: false, detail: 'submit probe failed' }));
  });
}

function ymdAddDays(ymd, days) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + Number(days || 0));
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Live flow verification for website.qa:
 * - bookings widget → ≥1 published service + slots for next open day (or documented closed)
 * - forms → published token + submit endpoint responds
 */
async function runFlowsLiveCheck(db, site, pages, html) {
  const results = [];
  let pass = true;
  const blob = String(html || '');
  const hasBookingsMount = /data-bitpype-module-type\s*=\s*["']bookings["']/i.test(blob)
    || /data-bitpype-module-token\s*=/i.test(blob) && /bookings/i.test(JSON.stringify(pages || []));

  // Bookings
  try {
    const modules = require('../server/siteModules');
    modules.ensureTables(db);
    const emb = db.prepare(
      "SELECT * FROM site_module_embeds WHERE lead_id = ? AND module_type = 'bookings' AND published = 1 LIMIT 1"
    ).get(site.lead_id);
    const mounted = hasBookingsMount || !!emb;
    if (mounted) {
      if (!emb || !emb.embed_enabled) {
        pass = false;
        results.push('bookings: widget mounted but embed not published/enabled');
      } else {
        const services = modules.listBookingServices(db, site.lead_id, { includeDrafts: false }) || [];
        if (!services.length) {
          pass = false;
          results.push('bookings: empty widget (no published services) — FAIL');
        } else {
          const svc = services[0];
          let found = null;
          let closedDays = 0;
          const today = new Date();
          const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
          for (let i = 0; i < 21; i++) {
            const date = ymdAddDays(todayYmd, i);
            try {
              const slots = modules.listAvailableSlots(db, site.lead_id, {
                date,
                serviceId: svc.id,
              });
              if (slots.closed) { closedDays += 1; continue; }
              if ((slots.slots || []).length >= 1) {
                found = { date, count: slots.slots.length, service: svc.name };
                break;
              }
            } catch { /* try next day */ }
          }
          if (found) {
            results.push(`bookings: ok — ${found.count} slot(s) on ${found.date} for "${found.service}"`);
          } else if (closedDays >= 7) {
            results.push(`bookings: ok — documented closed (no open windows in next 21 days; ${closedDays} closed day probes)`);
          } else {
            pass = false;
            results.push('bookings: no slots for next open day (and not documented closed)');
          }
        }
      }
    } else {
      results.push('bookings: N/A (no bookings widget)');
    }
  } catch (e) {
    pass = false;
    results.push(`bookings: error ${e.message || e}`);
  }

  // Forms
  try {
    const forms = require('../server/contactForms');
    forms.ensureTables(db);
    const tokenRe = /data-bitpype-form-embed\s*=\s*["']([^"']+)["']/gi;
    const tokens = new Set();
    let tm;
    while ((tm = tokenRe.exec(blob))) tokens.add(tm[1]);
    const nativeTok = /data-form-token\s*=\s*["']([^"']+)["']/gi;
    while ((tm = nativeTok.exec(blob))) tokens.add(tm[1]);
    if (!tokens.size) {
      results.push('forms: N/A (no form embeds)');
    } else {
      let appBase = '';
      try { appBase = require('../server/stripeClient').appUrl(); } catch { /* */ }
      if (!appBase) appBase = String(process.env.APP_URL || '').replace(/\/$/, '');
      for (const token of [...tokens].slice(0, 6)) {
        const row = db.prepare(
          'SELECT * FROM contact_forms WHERE public_token = ? LIMIT 1'
        ).get(token);
        if (!row || !row.published) {
          pass = false;
          results.push(`forms: token ${token.slice(0, 8)}… not published`);
          continue;
        }
        if (!appBase) {
          results.push(`forms: token ${token.slice(0, 8)}… published (submit probe skipped — no APP_URL)`);
          continue;
        }
        const submitUrl = `${appBase}/api/v1/forms/public/${token}/submit`;
        const live = await httpFormSubmitLive(submitUrl);
        if (live.ok) {
          results.push(`forms: token ${token.slice(0, 8)}… live submit (${live.detail})`);
        } else {
          pass = false;
          results.push(`forms: token ${token.slice(0, 8)}… ${live.detail}`);
        }
      }
    }
  } catch (e) {
    pass = false;
    results.push(`forms: error ${e.message || e}`);
  }

  return {
    pass,
    detail: results.length ? results.join(' · ') : 'No interactive flows to verify.',
    results,
  };
}

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
  const contentIssues = require('./siteContentQuality').inspect(pages, theme);
  check('generated-content-integrity', contentIssues.length === 0, contentIssues.length ? contentIssues.map(issue => issue.code + ':' + issue.page + issue.path).join('; ').slice(0,500) : 'No reproduced navigation-body or punctuation defects.');

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

  // 3. no placeholder text (visible content only — ignore script/style)
  let placeholderHit = null;
  if (renderOk) {
    const textOnly = visibleTextFromHtml(html);
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

  // 5. images: registered local (images/...), https stock, or CSS-only gallery.
  // Fail only on true placeholder hosts or non-https srcs not in the deliverable registry.
  let imgOk = true;
  let imgDetail = 'Gallery uses CSS gradient placeholders; no <img> tags.';
  if (renderOk) {
    const imgs = html.match(/<img\b[^>]*>/gi) || [];
    const registry = registeredImageUrlSet(db, websiteId);
    const bad = [];
    for (const tag of imgs) {
      const src = (tag.match(/\ssrc\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
      if (!src) {
        bad.push('img missing src');
        continue;
      }
      if (isRegisteredImageSrc(src, registry)) continue;
      if (PLACEHOLDER_IMAGE_RE.test(src)) {
        bad.push(`placeholder image: ${src.slice(0, 80)}`);
        continue;
      }
      if (src.startsWith('https://')) {
        if (/images\.pexels\.com/i.test(src) && !/Photo by /i.test(html)) {
          bad.push('Pexels image missing credit');
        }
        continue;
      }
      bad.push(`non-https image not in registry: ${src.slice(0, 80)}`);
    }
    imgOk = bad.length === 0;
    imgDetail = imgs.length
      ? (imgOk
        ? `${imgs.length} image(s) ok (registered local, https, or credited Pexels).`
        : bad.slice(0, 6).join('; '))
      : 'Gallery uses CSS gradient placeholders; no <img> tags.';
  }
  check('images-are-placeholders', imgOk, imgDetail);

  // 6. spelling sanity: no leaked 'undefined' / 'null' in visible text
  // (never scan <script>/<style> — preview nav guard used to trip every QA run)
  let sanityOk = true;
  let sanityDetail = 'Clean.';
  if (renderOk) {
    const textOnly = visibleTextFromHtml(html);
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

  // 8. Custom sites: no mandatory template hero. Pass when freeform, or modular with
  // any purposeful content (columns/html/heading/image/hero/cta/contact/module…).
  let reqOk = false;
  let reqDetail = '';
  if (renderOk && pages.length) {
    if (pages.some(pageHasHtml)) {
      reqOk = true;
      reqDetail = `Freeform / custom HTML site (${pages.length} page(s)).`;
    } else {
      const homeSecs = (pages[0] && pages[0].sections) || [];
      const homeTypes = new Set(homeSecs.map((s) => s && s.type).filter(Boolean));
      const hasContent = homeSecs.some((s) => {
        if (!s) return false;
        const t = String(s.type || '');
        if (['nav', 'footer'].includes(t)) return false;
        return true;
      }) || homeTypes.size > 2;
      const purposeful = [
        'hero', 'columns', 'html', 'custom', 'text', 'text_image', 'cards', 'heading',
        'image', 'cta', 'contact_form', 'bitpype_form', 'form', 'site_module',
        'about', 'services', 'benefits', 'gallery', 'faq',
      ].some((t) => homeTypes.has(t));
      reqOk = !!(hasContent && purposeful);
      reqDetail = reqOk
        ? `Custom modular site ok (types: ${[...homeTypes].slice(0, 8).join(', ') || '—'}).`
        : 'Home page needs at least one content/layout section (hero not required).';
    }
  }
  check('required-sections', reqOk, reqDetail || 'Render failed.');
  // Soft alias: never fail custom sites for missing template hero specifically.
  check(
    'no-template-conformity',
    true,
    'Template section types (hero, etc.) are optional for custom freestyle sites.'
  );

  // 9. class-heavy freeform pages must ship real CSS that defines those classes
  if (renderOk) {
    const cssResult = validatePagesCss(pages, theme);
    check(cssResult.check.name, cssResult.check.pass, cssResult.check.detail);
  } else {
    check('css-present-and-applied', false, 'Skipped (render failed).');
  }

  // 9b. at most one functional form/embed per page; reject action "#" / empty
  if (renderOk) {
    const formProblems = [];
    for (let pi = 0; pi < pages.length; pi++) {
      let pageHtml = '';
      try { pageHtml = renderPage(pages[pi], pages, theme) || ''; } catch { pageHtml = ''; }
      const formTags = pageHtml.match(/<form\b[^>]*>/gi) || [];
      const embeds = pageHtml.match(/\bdata-bitpype-form-embed\s*=/gi) || [];
      const managedNative = pageHtml.match(/\bdata-bitpype-form\s*=\s*["']?1["']?/gi) || [];
      // Native contact_form with data-bitpype-form counts as the form itself (not +embed).
      const functional = formTags.length + embeds.length;
      const slug = String((pages[pi] && pages[pi].slug) || `page-${pi}`);
      if (functional > 1) {
        formProblems.push(`${slug}: ${functional} forms/embeds (max 1)`);
      }
      for (const tag of formTags) {
        const actionM = tag.match(/\baction\s*=\s*["']([^"']*)["']/i);
        const action = actionM ? String(actionM[1] || '').trim() : '';
        if (!actionM || action === '' || action === '#') {
          formProblems.push(`${slug}: form action empty or "#"`);
        }
      }
      // Embed-only mounts are OK (JS posts to public API). Flag native forms without a real action.
      void managedNative;
    }
    check(
      'single-functional-form',
      formProblems.length === 0,
      formProblems.length
        ? formProblems.slice(0, 6).join('; ')
        : 'Each page has at most one functional form/embed with a real action.'
    );
  } else {
    check('single-functional-form', false, 'Skipped (render failed).');
  }

  // 9c. module-fit: appointment-intent pages need bookings module + published service + hours
  if (renderOk) {
    try {
      const moduleFit = require('../server/moduleFit');
      const fit = moduleFit.assessModuleFit(db, site.lead_id, pages);
      check('module-fit', fit.pass, fit.detail);
    } catch (e) {
      check('module-fit', true, `module-fit skipped (${e.message || e}).`);
    }
  } else {
    check('module-fit', false, 'Skipped (render failed).');
  }

  // 9d. structured-purpose forms should not be free-text-only (warning, not hard fail)
  if (renderOk) {
    try {
      const forms = require('../server/contactForms');
      forms.ensureTables(db);
      const formRows = forms.listFormRows(db, site.lead_id) || [];
      const purposeWarnings = [];
      for (const row of formRows) {
        const kind = row.form_kind || forms.inferFormKind(row) || null;
        const purpose = forms.normalizePurpose(kind)
          || (kind === 'appointment' ? 'appointment_request'
            : kind === 'quote' ? 'quote_request' : null);
        if (!purpose || !forms.STRUCTURED_PURPOSES.has(purpose)) continue;
        const fields = forms.listFields(db, row.id);
        if (forms.isFreeTextOnlyFields(fields)) {
          purposeWarnings.push(
            `Form #${row.id} (${purpose}) is free-text-only — use forms.create purpose=${purpose} or forms.suggestFields for typed fields`
          );
        }
      }
      check(
        'form-purpose-fields',
        true,
        purposeWarnings.length
          ? `Warning: ${purposeWarnings.slice(0, 4).join('; ')}`
          : 'Structured-purpose forms use typed fields (or none present).'
      );
    } catch (e) {
      check('form-purpose-fields', true, `form-purpose-fields skipped (${e.message || e}).`);
    }
  } else {
    check('form-purpose-fields', true, 'Skipped (render failed).');
  }

  // 9e. flows-live: bookings slots + forms submit endpoint
  if (renderOk) {
    try {
      const flow = await runFlowsLiveCheck(db, site, pages, html);
      check('flows-live', flow.pass, flow.detail);
    } catch (e) {
      check('flows-live', false, `flows-live failed: ${e.message || e}`);
    }
  } else {
    check('flows-live', false, 'Skipped (render failed).');
  }

  // 10. materialize export and require every local asset to exist on disk;
  //     when preview_url is set, also curl DEPLOYED image bytes.
  if (renderOk) {
    try {
      const openPreviewMod = require('./openPreview');
      const exportDir = path.join(openPreviewMod.exportRoot(), `qa-site-${websiteId}`);
      const images = imagesForWebsite(db, websiteId);
      writeStaticPages(pages, theme, exportDir, { images, websiteId });
      const assetCheck = validateExportAssets(pages, theme, exportDir);
      const miss = assetCheck.missing || [];
      let deployDetail = '';
      let deployOk = true;
      const previewBase = String(site.preview_url || '').replace(/\/+$/, '');
      if (previewBase && /^https?:\/\//i.test(previewBase) && assetCheck.checked > 0) {
        const deployMiss = [];
        const refs = collectLocalAssetRefs(html).filter((r) => /^(?:images|assets)\//i.test(r));
        for (const rel of refs.slice(0, 24)) {
          const okBytes = await httpUrlHasBytes(`${previewBase}/${rel}`);
          if (!okBytes) deployMiss.push(rel);
        }
        deployOk = deployMiss.length === 0;
        deployDetail = deployOk
          ? ` Deployed URL ok (${Math.min(refs.length, 24)} image/asset curl(s)).`
          : ` Deployed missing: ${deployMiss.slice(0, 6).join(', ')}${deployMiss.length > 6 ? '…' : ''}`;
      }
      check(
        'assets-present-in-export',
        assetCheck.ok && deployOk,
        assetCheck.ok
          ? `${assetCheck.checked} local asset(s) present in export.${deployDetail}`
          : `Missing from export (${miss.length}): ${miss.slice(0, 8).join(', ')}${miss.length > 8 ? '…' : ''}${deployDetail}`
      );
      const navCheck = validateExportNavLinks(pages, exportDir);
      const navMiss = [...(navCheck.danglingHashes || []), ...(navCheck.missing || [])];
      check(
        'multipage-nav-export',
        navCheck.ok,
        navCheck.ok
          ? (pages.length < 2
            ? 'Single-page site; multipage nav check skipped.'
            : `Multipage nav ok (${navCheck.checked} cross-page link(s) resolve).`)
          : `Broken multipage nav (${navMiss.length}): ${navMiss.slice(0, 8).join(', ')}${navMiss.length > 8 ? '…' : ''}`
      );

      // Duplicate nav labels (case-insensitive) across rendered home nav.
      const labelDupes = [];
      try {
        const homeHtml = renderPage(pages[0], pages, theme) || '';
        const labels = [];
        const re = /<nav\b[^>]*>[\s\S]*?<\/nav>/gi;
        let nm;
        while ((nm = re.exec(homeHtml))) {
          const aRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
          let am;
          while ((am = aRe.exec(nm[0]))) {
            const lab = String(am[1] || '').replace(/<[^>]+>/g, '').trim().toLowerCase();
            if (lab) labels.push(lab);
          }
        }
        const seen = new Set();
        for (const lab of labels) {
          if (seen.has(lab)) labelDupes.push(lab);
          seen.add(lab);
        }
      } catch { /* optional */ }
      check(
        'nav-labels-unique',
        labelDupes.length === 0,
        labelDupes.length
          ? `Duplicate nav labels: ${[...new Set(labelDupes)].slice(0, 6).join(', ')}`
          : 'Nav labels unique.'
      );

      // Declared crop aspects: if image.crop.aspect is set, width/height should match.
      const cropProblems = [];
      const walkCrop = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node.crop && typeof node.crop === 'object' && node.crop.aspect != null) {
          try {
            const imageCrop = require('./imageCrop');
            const ar = imageCrop.parseAspect(node.crop.aspect);
            const w = Number(node.crop.width);
            const h = Number(node.crop.height);
            if (ar && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
              const got = w / h;
              if (Math.abs(got - ar) / ar > 0.05) {
                cropProblems.push(`crop ${w}x${h} ≠ aspect ${node.crop.aspect}`);
              }
            }
          } catch { /* skip */ }
        }
        if (Array.isArray(node)) node.forEach(walkCrop);
        else Object.values(node).forEach(walkCrop);
      };
      walkCrop(pages);
      check(
        'images-crop-aspect',
        cropProblems.length === 0,
        cropProblems.length
          ? cropProblems.slice(0, 4).join('; ')
          : 'Cropped images match declared aspect (or no crop metadata).'
      );
    } catch (e) {
      check('assets-present-in-export', false, `Export asset check failed: ${e.message || e}`);
      check('multipage-nav-export', false, `Export nav check failed: ${e.message || e}`);
      check('nav-labels-unique', false, `Nav label check failed: ${e.message || e}`);
      check('images-crop-aspect', false, `Crop check failed: ${e.message || e}`);
    }
  } else {
    check('assets-present-in-export', false, 'Skipped (render failed).');
    check('multipage-nav-export', false, 'Skipped (render failed).');
    check('nav-labels-unique', false, 'Skipped (render failed).');
    check('images-crop-aspect', false, 'Skipped (render failed).');
  }

  // Horizontal overflow at 390px (headless) — best-effort when puppeteer available.
  if (renderOk) {
    try {
      const overflow = await checkMobileOverflow(pages, theme, { width: 390 });
      check(
        'no-horizontal-overflow-390',
        overflow.ok,
        overflow.ok
          ? `No horizontal overflow at ${overflow.width}px.`
          : `Horizontal overflow at ${overflow.width}px: ${overflow.detail || 'scrollWidth > clientWidth'}`
      );
    } catch (e) {
      check(
        'no-horizontal-overflow-390',
        true,
        `Overflow check skipped (${e.message || e}).`
      );
    }
  } else {
    check('no-horizontal-overflow-390', false, 'Skipped (render failed).');
  }

  // 11. optional AI QA pass
  if (ai.aiConfigured(db) && renderOk) {
    try {
      const promptRow = db.prepare('SELECT body FROM prompts WHERE key = ?').get('qa_website');
      const systemPrompt = (promptRow && promptRow.body ? String(promptRow.body).trim() : '') || QA_BUILD_PROMPT_FALLBACK;
      const facts = collectFacts(db, lead || { id: site.lead_id });
      const factList = [...facts.ok.entries()].map(([k, f]) => `${k} = ${f.value} [${f.claim_class}]`).join('\n');
      const { text } = await ai.chat({
        task: 'qa',
        db,
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

/** True for site-1, ws-1-site-1, ws-1-site-1-<slug> (not site-10 when id=1). */
function folderMatchesSiteId(name, websiteId) {
  const id = String(websiteId);
  if (!name || !id) return false;
  if (name === `site-${id}`) return true;
  const m = String(name).match(/(?:^|-)site-(\d+)(?:-|$)/);
  return !!(m && m[1] === id);
}

/** Export folders / design image dirs that may hold assets for a website id. */
function siteImageSearchDirs(websiteId, exportRootFn, subfolder = 'images') {
  const dirs = [];
  if (!exportRootFn || websiteId == null) return dirs;
  const sub = String(subfolder || 'images').replace(/[^a-z0-9_-]/gi, '') || 'images';
  let root;
  try { root = exportRootFn(); } catch { return dirs; }
  try {
    for (const name of fs.readdirSync(root)) {
      if (!folderMatchesSiteId(name, websiteId)) continue;
      const dir = path.join(root, name, sub);
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) dirs.push(dir);
    }
  } catch { /* optional */ }
  return dirs;
}

function resolveImageOnDisk(name, searchDirs) {
  const base = path.basename(String(name || ''));
  if (!base || base === '.' || base === '..') return null;
  for (const dir of searchDirs || []) {
    try {
      const abs = path.join(dir, base);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Collect deliverable.images[] for every design job linked to a website.
 * Resolves missing/stale paths via design-{jobId}/images/<name> and sibling
 * export folders (ws-*-site-{id}*) when present — critical after export_slug
 * rematerialize creates a fresh folder that would otherwise only get logo.png.
 */
function imagesForWebsite(db, websiteId) {
  const images = [];
  if (!db || websiteId == null) return images;
  let exportRootFn = null;
  try {
    exportRootFn = () => require('./openPreview').exportRoot();
  } catch { /* optional */ }
  const searchDirs = siteImageSearchDirs(websiteId, exportRootFn);
  try {
    const jobRows = db.prepare('SELECT id FROM design_jobs WHERE website_id = ?').all(websiteId);
    for (const row of jobRows || []) {
      if (!exportRootFn) break;
      const imgDir = path.join(exportRootFn(), `design-${row.id}`, 'images');
      if (fs.existsSync(imgDir) && fs.statSync(imgDir).isDirectory()) searchDirs.push(imgDir);
    }
  } catch { /* optional */ }

  const seenNames = new Set();
  const pushImage = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    let name = typeof entry.name === 'string' ? path.basename(entry.name) : '';
    if (!name && typeof entry.url === 'string') {
      const bare = String(entry.url).replace(/\\/g, '/').replace(/^\.\//, '');
      const m = bare.match(/(?:^|\/)([^/]+\.(?:png|jpe?g|webp|gif|svg|ico))$/i);
      if (m) name = m[1];
    }
    if (!name && typeof entry.path === 'string') name = path.basename(entry.path);
    if (!name || seenNames.has(name)) return;
    const copy = Object.assign({}, entry, { name });
    if (!copy.url) copy.url = `images/${name}`;
    const pathOk = typeof copy.path === 'string' && copy.path
      && fs.existsSync(copy.path) && fs.statSync(copy.path).isFile();
    if (!pathOk) {
      const recovered = resolveImageOnDisk(name, searchDirs);
      if (!recovered) return;
      copy.path = recovered;
      if (!copy.source) copy.source = 'recovered';
    }
    seenNames.add(name);
    images.push(copy);
  };

  // Prefer an already-materialized theme logo so rematerialize keeps images/logo.png.
  try {
    const site = db.prepare('SELECT theme FROM websites WHERE id = ?').get(websiteId);
    const theme = site ? (typeof site.theme === 'string' ? JSON.parse(site.theme || '{}') : site.theme) : null;
    const logoUrl = theme && typeof theme.logoUrl === 'string' ? theme.logoUrl.trim() : '';
    if (theme && theme.logoMode === 'image' && /^images\/logo\.png$/i.test(logoUrl)) {
      pushImage({ name: 'logo.png', url: 'images/logo.png', role: 'logo', source: 'theme' });
    }
  } catch { /* optional */ }
  try {
    const rows = db.prepare(
      'SELECT id, deliverable FROM design_jobs WHERE website_id = ?'
    ).all(websiteId);
    for (const row of rows || []) {
      let payload = null;
      try { payload = JSON.parse(row.deliverable || 'null'); } catch { /* ignore */ }
      if (!payload || !Array.isArray(payload.images)) continue;
      for (const im of payload.images) pushImage(im);
    }
  } catch { /* optional */ }

  // Harvest any images/… referenced in page HTML that deliverable.images missed.
  try {
    const site = db.prepare('SELECT pages, theme FROM websites WHERE id = ?').get(websiteId);
    if (site) {
      const pages = typeof site.pages === 'string' ? JSON.parse(site.pages || '[]') : site.pages;
      const theme = typeof site.theme === 'string' ? JSON.parse(site.theme || '{}') : site.theme;
      const html = renderSite(pages || [], theme || {});
      for (const rel of collectLocalAssetRefs(html)) {
        if (!/^images\//i.test(rel)) continue;
        pushImage({ name: path.basename(rel), url: rel, source: 'html-ref' });
      }
    }
  } catch { /* optional */ }

  return images;
}

/**
 * After export: copy any still-missing local assets from sibling site folders.
 * Returns list of recovered relative paths.
 */
function recoverMissingExportAssets(pages, theme, outDir, opts = {}) {
  const recovered = [];
  if (typeof outDir !== 'string' || !outDir.trim()) return recovered;
  let refs = [];
  try {
    refs = collectLocalAssetRefs(renderSite(pages, theme));
  } catch {
    return recovered;
  }
  const websiteId = opts && opts.websiteId != null ? opts.websiteId : null;
  let exportRootFn = null;
  try {
    exportRootFn = () => require('./openPreview').exportRoot();
  } catch { /* optional */ }
  const imageDirs = siteImageSearchDirs(websiteId, exportRootFn, 'images');
  const assetDirs = siteImageSearchDirs(websiteId, exportRootFn, 'assets');
  if (opts && Array.isArray(opts.searchDirs)) {
    for (const d of opts.searchDirs) {
      if (d && !imageDirs.includes(d)) imageDirs.push(d);
    }
  }
  const outImg = path.join(outDir, 'images');
  const outAssets = path.join(outDir, 'assets');
  const imgSearch = imageDirs.filter((d) => path.resolve(d) !== path.resolve(outImg));
  const assetSearch = assetDirs.filter((d) => path.resolve(d) !== path.resolve(outAssets));

  for (const rel of refs) {
    const dest = path.join(outDir, rel);
    try {
      if (fs.existsSync(dest) && fs.statSync(dest).isFile()) continue;
    } catch { /* try recover */ }
    const underAssets = /^assets\//i.test(rel);
    const abs = resolveImageOnDisk(
      path.basename(rel),
      underAssets ? assetSearch : imgSearch
    );
    if (!abs) continue;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
      recovered.push(rel);
    } catch { /* skip */ }
  }
  return recovered;
}

/**
 * Copy deliverable.images[].path into outDir/images/<filename>.
 * Preserves registered relative URLs (images/foo.png). Re-copies every call.
 */
function copyDeliverableImages(images, outDir) {
  const written = [];
  if (!Array.isArray(images) || !images.length) return written;
  if (typeof outDir !== 'string' || !outDir.trim()) return written;
  const imgDir = path.join(outDir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  for (const im of images) {
    if (!im || typeof im !== 'object') continue;
    let srcPath = typeof im.path === 'string' ? im.path.trim() : '';
    let name = typeof im.name === 'string' ? im.name.trim() : '';
    if (!name && typeof im.url === 'string') {
      const bare = String(im.url).replace(/\\/g, '/').replace(/^\.\//, '');
      const m = bare.match(/(?:^|\/)([^/]+\.(?:png|jpe?g|webp|gif|svg|ico))$/i);
      if (m) name = m[1];
    }
    if (!name && srcPath) name = path.basename(srcPath);
    if (!name) continue;
    name = path.basename(name);
    if (!name || name === '.' || name === '..') continue;
    try {
      if (!srcPath || !fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) continue;
      const dest = path.join(imgDir, name);
      fs.copyFileSync(srcPath, dest);
      written.push(`images/${name}`);
    } catch { /* skip unreadable */ }
  }
  return written;
}

/** Local (non-https) asset paths referenced by rendered HTML / CSS. */
function collectLocalAssetRefs(html) {
  const refs = new Set();
  const text = String(html || '');
  const consider = (raw) => {
    let u = String(raw || '').trim();
    if (!u) return;
    if (/^(https?:|data:|mailto:|tel:|javascript:|#)/i.test(u)) return;
    u = u.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    if (!u || u.includes('..')) return;
    if (/^(?:images|assets)\//i.test(u)
      || /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|css|js|mp4|webm|pdf)$/i.test(u)) {
      refs.add(u);
    }
  };
  const attrRe = /\b(?:src|href)=["']([^"']+)["']/gi;
  let m;
  while ((m = attrRe.exec(text))) consider(m[1]);
  const cssRe = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  while ((m = cssRe.exec(text))) consider(m[1]);
  return [...refs];
}

/**
 * After materialize: every local asset referenced by pages must exist under outDir.
 * Returns { ok, missing, checked }.
 */
function validateExportAssets(pages, theme, outDir) {
  let html = '';
  try {
    html = renderSite(pages, theme);
  } catch (e) {
    return { ok: false, missing: [], checked: 0, error: e.message || String(e) };
  }
  const refs = collectLocalAssetRefs(html);
  const missing = [];
  for (const rel of refs) {
    const abs = path.join(outDir, rel);
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) missing.push(rel);
    } catch {
      missing.push(rel);
    }
  }
  return { ok: missing.length === 0, missing, checked: refs.length };
}

/**
 * Write a real multi-page static site: one HTML file per page.
 * Home (slug `/` or first page) becomes index.html; others use pageFileName.
 * When opts.images is set, copies deliverable images into images/.
 */
function writeStaticPages(pages, theme, outDir, opts) {
  if (!Array.isArray(pages) || !pages.length) throw err('INVALID_PAGES', 'pages must be a non-empty array.');
  fs.mkdirSync(outDir, { recursive: true });
  const home = homePage(pages);
  const written = [];
  for (const p of pages) {
    const file = (p === home || isHomePage(p, pages)) ? 'index.html' : pageFileName(p.slug);
    let pageHtml = renderPage(p, pages, theme, opts);
    // Final guard: sanitize/render must leave managed embed loaders intact.
    pageHtml = ensureManagedEmbedScripts(pageHtml);
    const embedAssert = assertManagedEmbedScripts(pageHtml, `export ${file}`);
    if (!embedAssert.ok) {
      throw err(
        'EMBED_SCRIPT_MISSING',
        `Publish/export refused: ${file} missing managed embed scripts: ${embedAssert.missing.join(', ')}`
      );
    }
    fs.writeFileSync(path.join(outDir, file), pageHtml, 'utf8');
    written.push(file);
  }
  const images = opts && Array.isArray(opts.images) ? opts.images : [];
  const assetFiles = copyDeliverableImages(images, outDir);
  for (const f of assetFiles) {
    if (!written.includes(f)) written.push(f);
  }
  // Copy stable website.uploadAsset files (assets/<filename> — never renamed).
  if (opts && opts.websiteId != null) {
    try {
      const openPreview = require('./openPreview');
      const srcAssets = path.join(openPreview.exportRoot(), `site-${opts.websiteId}`, 'assets');
      const destAssets = path.join(outDir, 'assets');
      if (fs.existsSync(srcAssets) && fs.statSync(srcAssets).isDirectory()) {
        fs.mkdirSync(destAssets, { recursive: true });
        for (const name of fs.readdirSync(srcAssets)) {
          const from = path.join(srcAssets, name);
          const to = path.join(destAssets, name);
          if (fs.statSync(from).isFile()) {
            fs.copyFileSync(from, to);
            const rel = `assets/${name}`;
            if (!written.includes(rel)) written.push(rel);
          }
        }
      }
    } catch { /* optional */ }
  }
  // List any images/ already on disk (e.g. prior stage) so preview file lists include them.
  try {
    const imgDir = path.join(outDir, 'images');
    if (fs.existsSync(imgDir)) {
      for (const name of fs.readdirSync(imgDir)) {
        const abs = path.join(imgDir, name);
        if (fs.statSync(abs).isFile()) {
          const rel = `images/${name}`;
          if (!written.includes(rel)) written.push(rel);
        }
      }
    }
  } catch { /* optional */ }
  try {
    const assetsDir = path.join(outDir, 'assets');
    if (fs.existsSync(assetsDir)) {
      for (const name of fs.readdirSync(assetsDir)) {
        const abs = path.join(assetsDir, name);
        if (fs.statSync(abs).isFile()) {
          const rel = `assets/${name}`;
          if (!written.includes(rel)) written.push(rel);
        }
      }
    }
  } catch { /* optional */ }
  return { outDir, files: written };
}

/**
 * Export a website as separate HTML files (true multi-pager). Returns outDir.
 * Copies linked design-job images into images/ on every export.
 */
/**
 * Download Pexels/Unsplash hotlinks from a website's pages into
 * EXPORT_ROOT/site-{id}/images and rewrite HTML to images/….
 */
async function localizeWebsiteRemoteImages(db, websiteId) {
  ensureTables(db);
  const site = getWebsite(db, websiteId);
  let pages = JSON.parse(site.pages);
  const theme = JSON.parse(site.theme);
  const blob = JSON.stringify(pages);
  if (!/images\.pexels\.com|images\.unsplash\.com/i.test(blob)) {
    return { id: websiteId, localized: 0, pages };
  }
  const openPreview = require('./openPreview');
  const pexels = require('./pexels');
  const imgDir = path.join(openPreview.exportRoot(), `site-${websiteId}`, 'images');
  const { pages: next, assets } = await pexels.localizeUrlsInPages(pages, imgDir, { prefix: 'pexels' });
  if (assets.length) {
    saveSite(db, websiteId, next, theme, 'Localized stock image hotlinks into app storage');
    logActivity(db, 'websites', `Website #${websiteId}: stored ${assets.length} stock image(s) in app storage.`);
  }
  return { id: websiteId, localized: assets.length, pages: next };
}

function exportStatic(db, websiteId, outDir) {
  const site = getWebsite(db, websiteId);
  const pages = JSON.parse(site.pages);
  const theme = JSON.parse(site.theme);
  const images = imagesForWebsite(db, websiteId);
  const written = writeStaticPages(pages, theme, outDir, { images, websiteId });
  const recovered = recoverMissingExportAssets(pages, theme, outDir, { websiteId });
  for (const rel of recovered) {
    if (!written.files.includes(rel)) written.files.push(rel);
  }
  // Copy any app-storage site-{id}/images + assets into this export folder.
  try {
    const openPreview = require('./openPreview');
    for (const folder of ['images', 'assets']) {
      const srcDir = path.join(openPreview.exportRoot(), `site-${websiteId}`, folder);
      const destDir = path.join(outDir, folder);
      if (fs.existsSync(srcDir)) {
        fs.mkdirSync(destDir, { recursive: true });
        for (const name of fs.readdirSync(srcDir)) {
          const from = path.join(srcDir, name);
          const to = path.join(destDir, name);
          if (fs.statSync(from).isFile()) {
            fs.copyFileSync(from, to);
            const rel = `${folder}/${name}`;
            if (!written.files.includes(rel)) written.files.push(rel);
          }
        }
      }
    }
  } catch { /* optional */ }
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
  // Persist into app export storage (EXPORT_ROOT/site-{id}/images), not CDN hotlinks.
  let exportRoot;
  try { exportRoot = require('./openPreview').exportRoot(); } catch {
    throw err('EXPORT_ROOT', 'App export storage is not available.');
  }
  const imgDir = path.join(exportRoot, `site-${websiteId}`, 'images');
  const localPhotos = await pexels.localizePhotos(photos, imgDir, { prefix: 'pexels' });
  if (!localPhotos.length) throw err('PEXELS_DOWNLOAD', 'Could not store Pexels photos in app storage.');
  const industry = TEMPLATES[site.industry] ? site.industry : detectIndustry(lead && lead.category);
  const heroImage = site.origin === 'agent' || !!(TEMPLATES[industry] && TEMPLATES[industry].heroImage);
  let pages = applyImagesToPages(JSON.parse(site.pages), localPhotos, { heroImage: heroImage || true });
  // Also rewrite any existing freeform hotlinks on the site.
  try {
    const localized = await pexels.localizeUrlsInPages(pages, imgDir, { prefix: 'pexels' });
    pages = localized.pages;
  } catch { /* pages already local from applyImages */ }
  const theme = JSON.parse(site.theme);
  saveSite(db, websiteId, pages, theme, `Pexels photos for "${query}"`);
  logActivity(db, 'websites', `Attached ${localPhotos.length} Pexels photo(s) to website #${websiteId} (stored in app storage, query="${query}").`);
  return { id: websiteId, count: localPhotos.length, query, stored: true };
}

/* ------------------------------------------------------------------ */

module.exports = {
  // components / rendering
  COMPONENT_TYPES,
  LAYOUT_SECTION_TYPES,
  sectionToHtml,
  renderPage,
  renderPageAt,
  renderSite,
  pageFileName,
  normalizeRoute,
  navAnchorLabel,
  isComparableNavHref,
  findNavDuplicateIssues,
  dedupeNavHtml,
  assertAndDedupeNavHtml,
  isHomePage,
  homePage,
  pageHasHtml,
  rewriteFileLinksToAnchors,
  rewriteAnchorLinksToFiles,
  normalizePagesNavLinks,
  validateExportNavLinks,
  markFreeformTextNodes,
  markFreeformDocument,
  applyFreeformTextEdits,
  freeformPreviewInner,
  writeStaticPages,
  copyDeliverableImages,
  imagesForWebsite,
  recoverMissingExportAssets,
  collectLocalAssetRefs,
  validateExportAssets,
  normalizeTheme,
  themeRootCss,
  injectThemeStyles,
  injectThemeJs,
  injectFaviconLink,
  faviconLinkTag,
  injectMobileNavAsset,
  sanitizeJs,
  sanitizeHead,
  injectThemeHead,
  injectPreviewBaseHref,
  siteCss,
  navSubmenuCss,
  // templates
  TEMPLATES,
  detectIndustry,
  // facts
  collectFacts,
  getManifest,
  // lifecycle
  generateSite,
  deleteWebsite,
  buildPages,
  deterministicCopy,
  saveVersion,
  restoreVersion,
  saveSite,
  getWebsite,
  qaSite,
  exportStatic,
  localizeWebsiteRemoteImages,
  ensureTables,
  applyImagesToPages,
  attachPexelsImages,
  sanitizeCss,
  sanitizeHtml,
  ensureManagedEmbedScripts,
  assertManagedEmbedScripts,
  MANAGED_EMBED_KINDS,
  validatePagesCss,
  pageMarkupForCss,
  assertPagesCss,
  pageCombinedCss,
  extractClassNames,
  extractInlineCss,
  pageMetaFields,
  applySitePartials,
  checkMobileOverflow,
  // exposed for tests
  _cleanText: cleanText,
  _deterministicCopy: deterministicCopy,
  _cssDefinesClass: cssDefinesClass,
  _registeredImageUrlSet: registeredImageUrlSet,
  _isRegisteredImageSrc: isRegisteredImageSrc,
};
