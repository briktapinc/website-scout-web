'use strict';

/**
 * Regression: sanitizeHtml must preserve ALL BitPype managed embed loaders
 * (module, form, chat, and future data-bitpype-*-script / /js/*-embed.js).
 */
const assert = require('assert');
const eng = require('../src/websiteEngine');

const html = [
  '<div class="bitpype-module-embed" data-bitpype-module="1"',
  ' data-bitpype-module-type="faq" data-bitpype-api="https://bitpype.com"></div>',
  '<script src="https://bitpype.com/js/module-embed.js?v=mod5" defer data-bitpype-module-script="1"></script>',
  '<div class="bitpype-form-embed" data-bitpype-managed="1"',
  ' data-bitpype-form-embed="1_tok" data-bitpype-api="https://bitpype.com"></div>',
  '<script src="https://bitpype.com/js/form-embed.js?v=form1" defer data-bitpype-form-script="1"></script>',
  '<div class="bitpype-chat-embed" data-bitpype-chat="1"',
  ' data-bitpype-chat-token="1_abc" data-bitpype-api="https://bitpype.com"></div>',
  '<script src="https://bitpype.com/js/chat-embed.js?v=chat1" defer data-bitpype-chat-script="1"></script>',
  '<script>alert("evil")</script>',
].join('\n');

const out = eng.sanitizeHtml(html);
assert.ok(/module-embed\.js/.test(out), 'keeps module-embed.js');
assert.ok(/form-embed\.js/.test(out), 'keeps form-embed.js');
assert.ok(/chat-embed\.js/.test(out), 'keeps chat-embed.js');
assert.ok(/data-bitpype-module-script/.test(out), 'keeps module script attr');
assert.ok(/data-bitpype-form-script/.test(out), 'keeps form script attr');
assert.ok(/data-bitpype-chat-script/.test(out), 'keeps chat script attr');
assert.ok(!/alert\(["']evil["']\)/.test(out), 'strips inline evil');

// Future kind: data-bitpype-*-script + /js/*-embed.js (not in named enum).
const future = [
  '<div class="bitpype-gallery-embed" data-bitpype-api="https://bitpype.com"></div>',
  '<script src="https://bitpype.com/js/gallery-embed.js?v=1" defer data-bitpype-gallery-script="1"></script>',
].join('');
const futureOut = eng.sanitizeHtml(future);
assert.ok(/gallery-embed\.js/.test(futureOut), 'keeps future *-embed.js via pattern');
assert.ok(/data-bitpype-gallery-script/.test(futureOut), 'keeps future data-bitpype-*-script');

// Recovery: mount without script → re-inject from data-bitpype-api.
const orphanChat = [
  '<div class="bitpype-chat-embed" data-bitpype-chat="1"',
  ' data-bitpype-chat-token="1_abc" data-bitpype-api="https://bitpype.com"></div>',
].join('');
const recovered = eng.sanitizeHtml(orphanChat);
assert.ok(/chat-embed\.js/.test(recovered), 're-injects chat-embed.js for orphan mount');
assert.ok(/data-bitpype-chat-script/.test(recovered), 're-inject uses chat script attr');

// Park managed scripts even when they have a non-empty body; strip body on restore.
const withBody = [
  '<div class="bitpype-form-embed" data-bitpype-form-embed="tok" data-bitpype-api="https://bitpype.com"></div>',
  '<script src="https://bitpype.com/js/form-embed.js" defer data-bitpype-form-script="1">alert(1)</script>',
].join('');
const bodyOut = eng.sanitizeHtml(withBody);
assert.ok(/form-embed\.js/.test(bodyOut), 'parks form-embed.js despite body');
assert.ok(!/alert\(1\)/.test(bodyOut), 'strips managed script body on restore');

// APP_URL fallback when mount lacks data-bitpype-api.
const prevApp = process.env.APP_URL;
process.env.APP_URL = 'https://app.example.com';
try {
  const noApi = '<div class="bitpype-module-embed" data-bitpype-module="1"></div>';
  const viaApp = eng.sanitizeHtml(noApi);
  assert.ok(/https:\/\/app\.example\.com\/js\/module-embed\.js/.test(viaApp), 're-injects via APP_URL');
} finally {
  if (prevApp == null) delete process.env.APP_URL;
  else process.env.APP_URL = prevApp;
}

const assertOk = eng.assertManagedEmbedScripts(out, 'test-all-three');
assert.ok(assertOk.ok, 'assertManagedEmbedScripts passes for full set');

console.log('OK embed sanitize (module+form+chat+future+recover+body+appurl)');
