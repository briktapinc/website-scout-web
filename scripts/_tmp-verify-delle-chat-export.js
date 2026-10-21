'use strict';

/**
 * VPS verify: site 10 / Delle Donne chat embed survives materialize/export.
 * Does not print tokens.
 */
const fs = require('fs');
const path = require('path');

const domain = require('../server/domain');
const { openWorkspaceDb } = require('../server/workspaceDb');

const workspaceId = Number(process.env.WS_ID || 1);
const db = openWorkspaceDb(workspaceId);
const cols = new Set(db.prepare('PRAGMA table_info(websites)').all().map((c) => c.name));

let site = null;
if (cols.has('name')) {
  site = db.prepare(
    `SELECT id, lead_id, name,
            ${cols.has('cloudflare_url') ? 'cloudflare_url' : 'NULL AS cloudflare_url'},
            ${cols.has('preview_url') ? 'preview_url' : 'NULL AS preview_url'},
            ${cols.has('custom_domain') ? 'custom_domain' : 'NULL AS custom_domain'}
     FROM websites
     WHERE id = ? OR name LIKE ?
     ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
     LIMIT 1`
  ).get(10, '%Delle%', 10);
} else {
  site = db.prepare(
    `SELECT id, lead_id,
            ${cols.has('cloudflare_url') ? 'cloudflare_url' : 'NULL AS cloudflare_url'},
            ${cols.has('preview_url') ? 'preview_url' : 'NULL AS preview_url'},
            ${cols.has('custom_domain') ? 'custom_domain' : 'NULL AS custom_domain'}
     FROM websites WHERE id = ?`
  ).get(10);
}

if (!site) {
  console.log(JSON.stringify({ error: 'NO_SITE', cols: [...cols] }));
  process.exit(1);
}

const pagesRow = db.prepare('SELECT pages FROM websites WHERE id = ?').get(site.id);
const pages = JSON.parse(pagesRow.pages || '[]');
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

console.log(JSON.stringify({
  phase: 'pre-materialize',
  siteId: site.id,
  leadId: site.lead_id,
  name: site.name || null,
  cloudflare_url: site.cloudflare_url || null,
  preview_url: site.preview_url || null,
  custom_domain: site.custom_domain || null,
  pages: pageSummary,
  embed: emb,
}, null, 2));

const exported = domain.materializeWebsiteExport(db, workspaceId, site.id);
const exportDir = exported && (exported.dir || exported.outDir);
const candidates = [
  path.join(exportDir || '', 'index.html'),
  exported && exported.path,
].filter(Boolean);

let indexHtml = '';
let usedPath = null;
for (const p of candidates) {
  if (p && fs.existsSync(p)) {
    indexHtml = fs.readFileSync(p, 'utf8');
    usedPath = p;
    break;
  }
}

const engine = require('../src/websiteEngine');
const sanitized = engine.sanitizeHtml(indexHtml || '');
const assert = engine.assertManagedEmbedScripts(indexHtml || '', `site-${site.id}-export`);

const result = {
  phase: 'post-materialize',
  exportDir: exportDir || null,
  indexPath: usedPath,
  indexLen: indexHtml.length,
  hasChatMount: /\bbitpype-chat-embed\b|\bdata-bitpype-chat\s*=/.test(indexHtml),
  hasChatScript: /chat-embed\.js|\bdata-bitpype-chat-script\b/.test(indexHtml),
  sanitizeKeepsChat: /chat-embed\.js/.test(sanitized),
  assertOk: assert.ok,
  assertMissing: assert.missing,
};
console.log(JSON.stringify(result, null, 2));

if (result.hasChatMount && !result.hasChatScript) {
  console.error('FAIL: chat mount without chat-embed.js after materialize');
  process.exit(2);
}
if (!result.hasChatMount && emb && emb.has_token && emb.published && emb.embed_enabled) {
  console.error('FAIL: chatbot embed active but no chat mount in export');
  process.exit(3);
}

console.log('verify delle chat export OK');
