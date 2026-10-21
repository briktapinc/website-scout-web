'use strict';

/**
 * Force rematerialize website 1 preview (HTML + images/) and print file list + QA.
 * Run inside the app container.
 */
process.env.APP_URL = process.env.APP_URL || 'https://bitpype.com';

async function main() {
  const domain = require('../server/domain');
  const fs = require('fs');
  const path = require('path');

  const preview = await domain.sitesPreview(1, 1, { force: true });
  console.log(JSON.stringify({
    url: preview.url,
    via: preview.via,
    folder: preview.folder,
    files: preview.files || [],
    cloudflare: preview.cloudflare || null,
  }, null, 2));

  const files = preview.files || [];
  const imageFiles = files.filter((f) => String(f).startsWith('images/'));
  if (!imageFiles.length) {
    console.error('FAIL: preview file list has no images/* entries');
    process.exit(1);
  }
  console.log('OK image files in list:', imageFiles.join(', '));

  const exportDir = preview.path
    ? path.dirname(preview.path)
    : path.join(require('os').homedir(), 'website-scout-exports', preview.folder);
  for (const rel of imageFiles) {
    const abs = path.join(exportDir, rel);
    if (!fs.existsSync(abs)) {
      console.error('FAIL missing on disk:', abs);
      process.exit(1);
    }
    const st = fs.statSync(abs);
    console.log('OK on disk', rel, 'bytes=', st.size);
  }

  const qa = await domain.sitesQa(1, 1);
  const byName = {};
  for (const c of qa.checks || []) byName[c.name] = c;
  console.log('QA assets-present-in-export:', JSON.stringify(byName['assets-present-in-export'] || null));
  if (!byName['assets-present-in-export'] || !byName['assets-present-in-export'].pass) {
    console.error('FAIL: assets-present-in-export did not pass');
    process.exit(1);
  }
  console.log('OK rematerialize complete url=', preview.url);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
