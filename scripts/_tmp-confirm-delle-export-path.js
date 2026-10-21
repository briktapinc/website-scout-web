'use strict';
const fs = require('fs');
const path = require('path');
const { openWorkspaceDb } = require('../server/workspaceDb');
const domain = require('../server/domain');
const openPreview = require('../src/openPreview');

const db = openWorkspaceDb(1);
const site = db.prepare('SELECT id, preview_path FROM websites WHERE id = 10').get();
const folder = domain.siteExportFolder(db, 1, 10);
const root = openPreview.exportRoot();

const candidates = [
  folder,
  path.isAbsolute(folder) ? folder : path.join(root, folder),
  path.isAbsolute(folder) ? folder : path.join(process.cwd(), folder),
  site.preview_path ? path.dirname(site.preview_path) : null,
  '/var/lib/website-scout-exports/ws-1-site-10-4ed328040f63e51091',
].filter(Boolean);

const results = [];
for (const dir of [...new Set(candidates)]) {
  const index = path.join(dir, 'index.html');
  if (!fs.existsSync(index)) {
    results.push({ dir, exists: false });
    continue;
  }
  const html = fs.readFileSync(index, 'utf8');
  const st = fs.statSync(index);
  results.push({
    dir,
    exists: true,
    mtime: st.mtime.toISOString(),
    len: html.length,
    hasChatMount: /\bbitpype-chat-embed\b|\bdata-bitpype-chat\s*=/.test(html),
    hasChatScript: /chat-embed\.js|\bdata-bitpype-chat-script\b/.test(html),
    hasFormScript: /form-embed\.js|\bdata-bitpype-form-script\b/.test(html),
  });
}

console.log(JSON.stringify({
  preview_path: site.preview_path,
  siteExportFolder: folder,
  exportRoot: root,
  cwd: process.cwd(),
  results,
}, null, 2));
