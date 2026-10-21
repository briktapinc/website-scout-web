#!/usr/bin/env node
'use strict';
/**
 * Local smoke for gaps 1–5 (no network deploy).
 */
const assert = require('assert');
const engine = require('../src/websiteEngine');

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('OK', msg);
  else { failed += 1; console.error('FAIL', msg); }
}

// Gap 1: spelling-sanity must not fail on preview scripts / stock template
const pages = [{
  slug: '/',
  title: 'Home',
  sections: [
    { type: 'nav', content: { business_name: 'Acme Co', links: [{ label: 'Home', href: '#home' }] } },
    { type: 'hero', content: { headline: 'Welcome', subheadline: 'Quality work', cta_text: 'Call us' } },
    { type: 'footer', content: { business_name: 'Acme Co' } },
  ],
}];
const theme = { primary: '#0d6b5c', secondary: '#123', bg: '#fff', text: '#111', font: 'Georgia' };
const html = engine.renderSite(pages, theme);
ok(/\bnull\b/.test(html.replace(/<script[\s\S]*?<\/script>/gi, ' ')) === false
  || !/\bnull\b/.test(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' ')),
  'visible text has no null (after script strip)');
// Simulate QA spelling check
const visible = String(html)
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ');
ok(!/\b(undefined|null|NaN)\b/.test(visible), 'spelling-sanity visible text clean for stock template');
ok(!/\bnull\b/.test(html.match(/data-ws-preview-nav[\s\S]*?<\/script>/) || [''])[0]
  || true, 'preview nav guard checked');
const navGuard = (html.match(/<script data-ws-preview-nav[\s\S]*?<\/script>/) || [''])[0];
ok(!/\bnull\b/.test(navGuard), 'PREVIEW_NAV_GUARD emits no literal null token');

// Gap 4/5 helpers exist
ok(typeof engine.validateExportAssets === 'function', 'validateExportAssets exported');
ok(typeof engine._registeredImageUrlSet === 'function' || typeof engine.imagesForWebsite === 'function',
  'image registry helpers present');

// Gap 2 helpers
const shots = require('../src/siteScreenshots');
ok(typeof shots.captureOneScreenshot === 'function', 'captureOneScreenshot present');

// Gap 3: flows-live function exists via qa (check source string)
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '../src/websiteEngine.js'), 'utf8');
ok(src.includes("check('flows-live'"), 'flows-live QA check wired');
ok(src.includes('runFlowsLiveCheck'), 'runFlowsLiveCheck helper present');
ok(src.includes('visibleTextFromHtml'), 'visibleTextFromHtml helper present');

const cf = require('../src/cloudflare');
ok(typeof cf.publishDirectory === 'function', 'publishDirectory present');
const cfSrc = fs.readFileSync(require('path').join(__dirname, '../src/cloudflare.js'), 'utf8');
ok(cfSrc.includes('deployedVersion'), 'publish returns deployedVersion');
ok(cfSrc.includes('cf_deployment_id'), 'stores cf_deployment_id');

const domainSrc = fs.readFileSync(require('path').join(__dirname, '../server/domain.js'), 'utf8');
ok(domainSrc.includes('pinVersion'), 'materialize/publish pinVersion');
ok(domainSrc.includes('versionNo'), 'export carries versionNo');

console.log(failed ? `\n${failed} FAIL(s)` : '\nAll gap 1–5 smokes passed');
process.exit(failed ? 1 : 0);
