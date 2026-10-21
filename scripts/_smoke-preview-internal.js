'use strict';

/**
 * In-container smoke: call domain.sitesPreview for workspace 1 / site 1.
 * Avoids HTTP captcha on /auth/login.
 */

async function main() {
  process.env.APP_URL = process.env.APP_URL || 'https://bitpype.com';
  const domain = require('../server/domain');
  const cf = require('../src/cloudflare');
  const { openWorkspaceDb } = require('../server/workspaceDb');

  const db = openWorkspaceDb(1);
  const cfg = cf.getConfig(db);
  console.log('cf.configured=', cfg.configured, 'project=', JSON.stringify(cfg.project), 'previewDomain=', cfg.previewDomain);

  const before = db.prepare('SELECT id, preview_url FROM websites WHERE id = 1').get();
  console.log('before=', before);

  console.log('sitesPreview force…');
  const result = await domain.sitesPreview(1, 1, { force: true });
  console.log(JSON.stringify(result, null, 2));

  const after = db.prepare('SELECT id, preview_url FROM websites WHERE id = 1').get();
  console.log('after=', after);

  const url = result && result.url;
  if (!url) {
    console.error('FAIL: no url');
    process.exit(1);
  }
  if (/127\.0\.0\.1|localhost|:8755/i.test(url)) {
    console.error('FAIL: localhost url', url);
    process.exit(1);
  }
  console.log('OK url=', url);

  try {
    const res = await fetch(url, { redirect: 'follow' });
    console.log('GET status=', res.status, 'final=', res.url);
  } catch (e) {
    console.log('GET error:', e.message);
  }
}

main().catch((e) => {
  console.error('ERROR', e && e.stack || e);
  process.exit(1);
});
