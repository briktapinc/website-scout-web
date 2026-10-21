'use strict';

/**
 * Lightweight rematerialize for site 10: sync modules + writeStaticPages only
 * (skip image optimize / CF). Verifies chat-embed.js survives.
 */
const fs = require('fs');
const path = require('path');
const { openWorkspaceDb } = require('../server/workspaceDb');
const engine = require('../src/websiteEngine');

const workspaceId = 1;
const siteId = 10;
const db = openWorkspaceDb(workspaceId);
const site = engine.getWebsite(db, siteId);

try {
  require('../server/siteModules').syncPublishedModules(db, site.lead_id);
} catch (e) {
  console.warn('syncPublishedModules:', e.message || e);
}

const fresh = engine.getWebsite(db, siteId);
const pages = JSON.parse(fresh.pages);
const theme = JSON.parse(fresh.theme);

const domain = require('../server/domain');
const folder = domain.siteExportFolder(db, workspaceId, siteId);
const images = engine.imagesForWebsite(db, siteId);
const written = engine.writeStaticPages(pages, theme, folder, { images, websiteId: siteId });

const indexPath = path.join(folder, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');
const assert = engine.assertManagedEmbedScripts(html, 'site-10-rematerialize');

console.log(JSON.stringify({
  siteId,
  folder,
  files: (written.files || []).slice(0, 12),
  hasChatMount: /\bbitpype-chat-embed\b|\bdata-bitpype-chat\s*=/.test(html),
  hasChatScript: /chat-embed\.js|\bdata-bitpype-chat-script\b/.test(html),
  assertOk: assert.ok,
  assertMissing: assert.missing,
  indexLen: html.length,
}, null, 2));

if (!/chat-embed\.js|\bdata-bitpype-chat-script\b/.test(html)) {
  console.error('FAIL: rematerialize lost chat-embed.js');
  process.exit(2);
}
console.log('rematerialize delle html OK');
