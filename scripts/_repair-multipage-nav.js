'use strict';

/**
 * Rewrite stored #page hashes → *.html on a multipage website, then
 * optionally force a Cloudflare / preview republish.
 *
 * Usage (on VPS / in app container):
 *   node scripts/_repair-multipage-nav.js [websiteId] [--publish]
 */
async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--publish');
  const doPublish = process.argv.includes('--publish');
  const websiteId = Number(args[0] || 1);
  if (!Number.isInteger(websiteId) || websiteId < 1) {
    throw new Error('websiteId must be a positive integer');
  }

  process.env.APP_URL = process.env.APP_URL || 'https://bitpype.com';
  const engine = require('../src/websiteEngine');
  const { openWorkspaceDb } = require('../server/workspaceDb');
  const db = openWorkspaceDb(1);

  engine.ensureTables(db);
  const site = engine.getWebsite(db, websiteId);
  const pages = JSON.parse(site.pages);
  const theme = JSON.parse(site.theme);
  if (!Array.isArray(pages) || pages.length < 2) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'not multipage', websiteId }));
    return;
  }

  let changed = 0;
  const next = pages.map((p) => {
    if (!p || typeof p.html !== 'string' || !p.html.trim()) return p;
    const before = p.html;
    const after = engine.rewriteAnchorLinksToFiles(before, pages);
    if (after !== before) changed += 1;
    return Object.assign({}, p, { html: after });
  });

  if (changed) {
    engine.saveSite(db, websiteId, next, theme, 'Repair multipage nav hashes → *.html');
  }

  const result = {
    ok: true,
    websiteId,
    pages: pages.length,
    pagesRewritten: changed,
    preview_url: site.preview_url || null,
  };

  if (doPublish) {
    const domain = require('../server/domain');
    const pub = await domain.sitesPreview(1, websiteId, { force: true });
    result.publish = {
      ok: !!(pub && pub.url),
      url: pub && pub.url ? pub.url : null,
      detail: pub || null,
    };
  }

  console.log(JSON.stringify(result, null, 2));
  if (doPublish && (!result.publish || !result.publish.ok)) process.exit(1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
