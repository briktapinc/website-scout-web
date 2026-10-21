'use strict';

/**
 * Unit tests: deliverable images copy into export + assets-present-in-export QA.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../src/websiteEngine');
const cf = require('../src/cloudflare');

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('OK', msg);
  else {
    failed += 1;
    console.error('FAIL', msg);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-export-assets-'));
const srcImg = path.join(tmp, 'src-openai-1.png');
// Minimal valid-ish PNG header bytes
fs.writeFileSync(srcImg, Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe,
  0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]));

const pages = [{
  slug: '/',
  title: 'Home',
  html: '<div class="hero"><img src="images/openai-1.png" alt="Hero"></div>',
}];
const theme = {
  customCss: '.hero { display:block } .hero img { max-width:100% }',
};

const outDir = path.join(tmp, 'site-out');
const images = [{
  name: 'openai-1.png',
  path: srcImg,
  url: 'images/openai-1.png',
  source: 'openai',
}];

const written = engine.writeStaticPages(pages, theme, outDir, { images });
ok(written.files.includes('index.html'), 'writes index.html');
ok(written.files.some((f) => f === 'images/openai-1.png'), 'file list includes images/openai-1.png');
ok(fs.existsSync(path.join(outDir, 'images', 'openai-1.png')), 'image copied into export images/');

const assetCheck = engine.validateExportAssets(pages, theme, outDir);
ok(assetCheck.ok, 'validateExportAssets passes when image present');
ok(assetCheck.checked >= 1, 'validateExportAssets checked at least one ref');

const brokenDir = path.join(tmp, 'broken-out');
engine.writeStaticPages(pages, theme, brokenDir, { images: [] });
const broken = engine.validateExportAssets(pages, theme, brokenDir);
ok(!broken.ok, 'validateExportAssets fails when image missing');
ok(broken.missing.includes('images/openai-1.png'), 'missing list names the image');

// Cloudflare asset key: blake3(base64 + ext), not raw bytes
const sample = Buffer.from('hello pages');
const key = cf.pagesAssetKey(sample, '/index.html');
ok(typeof key === 'string' && /^[0-9a-f]{32}$/.test(key), 'pagesAssetKey returns 32 hex chars');
const { blake3 } = require('@noble/hashes/blake3');
const { bytesToHex } = require('@noble/hashes/utils');
const expected = bytesToHex(blake3(Buffer.from(sample.toString('base64') + 'html', 'utf8'))).slice(0, 32);
ok(key === expected, 'pagesAssetKey matches wrangler base64+ext algorithm');
const wrong = bytesToHex(blake3(Buffer.concat([sample, Buffer.from('html')]))).slice(0, 32);
ok(key !== wrong, 'pagesAssetKey is not the old raw-bytes hash');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

if (failed) {
  console.error(`\n${failed} export-asset test(s) failed.`);
  process.exit(1);
}
console.log('\nAll export-asset tests passed.');
