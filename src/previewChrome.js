'use strict';

/**
 * Shared injectors for static preview / publish HTML (cookie bar, etc.).
 */

const fs = require('fs');
const path = require('path');

function appBase() {
  return String(process.env.APP_URL || '').replace(/\/$/, '') || 'https://bitpype.com';
}

function listHtmlFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => {
    if (!/\.html?$/i.test(n)) return false;
    try {
      return fs.statSync(path.join(dir, n)).isFile();
    } catch {
      return false;
    }
  });
}

function replaceOrAppendBeforeBody(html, markerStart, markerEnd, snippet) {
  let out = String(html || '');
  const re = new RegExp(
    `\\n?<!-- ${markerStart} -->[\\s\\S]*?<!-- \\/${markerEnd} -->\\n?`,
    'i'
  );
  if (re.test(out)) out = out.replace(re, '');
  const block = `\n<!-- ${markerStart} -->\n${snippet}\n<!-- /${markerEnd} -->\n`;
  if (/<\/body>/i.test(out)) return out.replace(/<\/body>/i, `${block}</body>`);
  return out + block;
}

/**
 * Inject cookie footer bar script into every HTML file in an export folder.
 */
function injectCookieBarIntoExport(exportDir) {
  const dir = String(exportDir || '');
  const base = appBase();
  const snippet = `<script src="${base}/js/cookie-bar.js?v=1" defer></script>`;
  let injected = 0;
  for (const name of listHtmlFiles(dir)) {
    const full = path.join(dir, name);
    try {
      let html = fs.readFileSync(full, 'utf8');
      html = replaceOrAppendBeforeBody(html, 'bitpype-cookie-bar', 'bitpype-cookie-bar', snippet);
      fs.writeFileSync(full, html, 'utf8');
      injected++;
    } catch (e) {
      console.warn('[previewChrome] cookie bar', name, e.message || e);
    }
  }
  return { injected };
}

/**
 * Walk EXPORT_ROOT folders that look like site exports and inject cookie bars.
 */
function injectCookieBarIntoAllExports(rootDir) {
  const root = String(rootDir || '');
  if (!root || !fs.existsSync(root)) return { folders: 0, files: 0 };
  let folders = 0;
  let files = 0;
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      // Site export folders: ws-*-site-*, site-*, qa-site-*, design-*, social-* skip pure asset dirs
      if (/^ws-\d+-site-\d+/i.test(name) || /^site-\d+/i.test(name) || /^qa-site-/i.test(name)) {
        const r = injectCookieBarIntoExport(full);
        if (r.injected > 0) {
          folders++;
          files += r.injected;
        }
      }
    } catch { /* skip */ }
  }
  return { folders, files };
}

module.exports = {
  appBase,
  injectCookieBarIntoExport,
  injectCookieBarIntoAllExports,
  replaceOrAppendBeforeBody,
  listHtmlFiles,
};
