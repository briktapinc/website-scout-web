'use strict';

/**
 * Fast check: DB pages + existing export folder for chat script (no rematerialize).
 * Optionally renders one page through sanitizeHtml/renderPage.
 */
const fs = require('fs');
const path = require('path');
const { openWorkspaceDb } = require('../server/workspaceDb');
const engine = require('../src/websiteEngine');

const db = openWorkspaceDb(1);
const site = db.prepare(
  `SELECT id, lead_id, name, preview_path, preview_url, pages, theme
   FROM websites WHERE id = 10`
).get();

if (!site) {
  console.log(JSON.stringify({ error: 'NO_SITE' }));
  process.exit(1);
}

const pages = JSON.parse(site.pages || '[]');
const theme = JSON.parse(site.theme || '{}');
const pageSummary = pages.map((p) => {
  const html = String(p.html || '');
  const secHtml = (p.sections || [])
    .map((s) => (s && s.content && s.content.html) || '')
    .join('\n');
  const blob = `${html}\n${secHtml}`;
  return {
    slug: p.slug,
    hasChatMount: /\bbitpype-chat-embed\b|\bdata-bitpype-chat\s*=/.test(blob),
    hasChatScript: /chat-embed\.js|\bdata-bitpype-chat-script\b/.test(blob),
  };
});

let emb = null;
try {
  emb = db.prepare(
    `SELECT id, module_type, published, embed_enabled,
            CASE WHEN public_token IS NOT NULL AND length(public_token) > 0 THEN 1 ELSE 0 END AS has_token
     FROM site_module_embeds
     WHERE lead_id = ? AND module_type = 'chatbot'`
  ).get(site.lead_id);
} catch (e) {
  emb = { error: e.message };
}

// Render home through engine (same sanitize path as export) without writing disk.
const home = pages[0];
const rendered = engine.renderPage(home, pages, theme);
const assert = engine.assertManagedEmbedScripts(rendered, 'site-10-render');
const sanitizedSample = engine.sanitizeHtml(
  (home.html || '')
    || ((home.sections || []).map((s) => (s && s.content && s.content.html) || '').join('\n'))
);

// Existing export folder if present
const candidates = [];
if (site.preview_path) {
  candidates.push(site.preview_path);
  candidates.push(path.join(path.dirname(site.preview_path), 'index.html'));
}
try {
  const openPreview = require('../src/openPreview');
  const folder = openPreview.siteExportFolder
    ? openPreview.siteExportFolder(db, 1, 10)
    : null;
  if (folder) candidates.push(path.join(folder, 'index.html'));
} catch { /* optional */ }
try {
  const domain = require('../server/domain');
  if (typeof domain.siteExportFolder === 'function') {
    candidates.push(path.join(domain.siteExportFolder(db, 1, 10), 'index.html'));
  }
} catch { /* optional */ }

let exportCheck = null;
for (const p of candidates) {
  const file = p && (p.endsWith('.html') ? p : path.join(p, 'index.html'));
  if (file && fs.existsSync(file)) {
    const html = fs.readFileSync(file, 'utf8');
    exportCheck = {
      path: file,
      hasChatMount: /\bbitpype-chat-embed\b|\bdata-bitpype-chat\s*=/.test(html),
      hasChatScript: /chat-embed\.js|\bdata-bitpype-chat-script\b/.test(html),
      len: html.length,
    };
    break;
  }
}

console.log(JSON.stringify({
  siteId: site.id,
  name: site.name,
  leadId: site.lead_id,
  pages: pageSummary,
  embed: emb,
  renderHasChatMount: /\bbitpype-chat-embed\b|\bdata-bitpype-chat\s*=/.test(rendered),
  renderHasChatScript: /chat-embed\.js|\bdata-bitpype-chat-script\b/.test(rendered),
  sanitizeKeepsChat: /chat-embed\.js/.test(sanitizedSample) || /chat-embed\.js/.test(rendered),
  assertOk: assert.ok,
  assertMissing: assert.missing,
  existingExport: exportCheck,
}, null, 2));

if (emb && emb.has_token && emb.published && emb.embed_enabled) {
  if (!/\bbitpype-chat-embed\b|\bdata-bitpype-chat\s*=/.test(rendered)) {
    console.error('FAIL: active chatbot but render missing mount');
    process.exit(3);
  }
  if (!/chat-embed\.js|\bdata-bitpype-chat-script\b/.test(rendered)) {
    console.error('FAIL: active chatbot but render missing chat-embed.js');
    process.exit(2);
  }
}

console.log('fast verify delle chat OK');
