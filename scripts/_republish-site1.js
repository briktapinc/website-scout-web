'use strict';

async function main() {
  process.env.APP_URL = process.env.APP_URL || 'https://bitpype.com';
  const domain = require('../server/domain');
  const engine = require('../src/websiteEngine');
  const { openWorkspaceDb } = require('../server/workspaceDb');
  const db = openWorkspaceDb(1);
  const site = db.prepare('SELECT id, theme FROM websites WHERE id = 1').get();
  const theme = JSON.parse(site.theme || '{}');
  console.log('customCss_len=', (theme.customCss || '').length, 'baseCss=', theme.baseCss);

  // Sanity: local export includes injected CSS
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const dir = path.join(os.homedir(), 'website-scout-exports', 'ws-1-site-1-csscheck');
  fs.rmSync(dir, { recursive: true, force: true });
  engine.exportStatic(db, 1, dir);
  const index = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const styleChars = [...index.matchAll(/<style[\s\S]*?<\/style>/gi)].reduce((n, m) => n + m[0].length, 0);
  console.log('local_export_style_chars=', styleChars, 'has_ws_theme=', /data-ws-theme/.test(index));
  if (styleChars < 100) {
    console.error('FAIL local export still unstyled');
    process.exit(1);
  }

  const result = await domain.sitesPreview(1, 1, { force: true });
  console.log(JSON.stringify(result, null, 2));
  if (!result.url || /127\.0\.0\.1|localhost|:8755/i.test(result.url)) {
    console.error('FAIL bad url');
    process.exit(1);
  }
  console.log('OK preview url=', result.url);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
