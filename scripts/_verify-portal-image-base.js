'use strict';

const portal = require('../server/clientPortal');
const domain = require('../server/domain');

const base = portal.resolveExportPreviewBase(1, {
  id: 1,
  preview_url: 'https://x.pages.dev/',
  preview_path: '/data/website-scout-exports/ws-1-site-1',
});
if (!String(base).includes('/site-previews/ws-1-site-1/')) {
  throw new Error('resolveExportPreviewBase failed: ' + base);
}

const row = domain.withDb(1, (db) =>
  db.prepare('SELECT id, lead_id, preview_url, preview_path FROM websites ORDER BY id DESC LIMIT 1').get()
);
if (!row) throw new Error('no website');

const rendered = portal.renderClientSite(1, row.lead_id, { editable: true });
const tag = (rendered.html.match(/<base\b[^>]*data-ws-preview-base[^>]*>/i) || [])[0] || null;
if (!tag) throw new Error('rendered HTML missing base tag');
if (!/site-previews\//i.test(tag)) throw new Error('base tag not pointing at site-previews: ' + tag);
if (!rendered.assetBase || !/site-previews\//i.test(rendered.assetBase)) {
  throw new Error('assetBase missing site-previews: ' + rendered.assetBase);
}

console.log(JSON.stringify({
  ok: true,
  siteId: row.id,
  leadId: row.lead_id,
  previewUrl: rendered.previewUrl,
  assetBase: rendered.assetBase,
  baseTag: tag,
  hasImageRefs: /images\//i.test(rendered.html),
  hasImageReplace: /image-replace/.test(rendered.html),
}, null, 2));
