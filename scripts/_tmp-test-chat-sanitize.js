'use strict';
const assert = require('assert');
const eng = require('../src/websiteEngine');

const html = [
  '<div class="bitpype-chat-embed" data-bitpype-chat="1"',
  ' data-bitpype-chat-token="1_abc" data-bitpype-api="https://bitpype.com"></div>',
  '<script src="https://bitpype.com/js/chat-embed.js?v=chat1" defer data-bitpype-chat-script="1"></script>',
].join('');

const out = eng.sanitizeHtml(html);
assert(/bitpype-chat-embed/.test(out), 'keeps chat mount div');
assert(/chat-embed\.js/.test(out), 'keeps chat-embed.js: ' + out);
assert(/data-bitpype-chat-script/.test(out), 'keeps chat script attr');
assert(!/<script\b[^>]*>\s*alert/.test(out), 'still strips random scripts');

const evil = html + '<script>alert(1)</script>';
const out2 = eng.sanitizeHtml(evil);
assert(/chat-embed\.js/.test(out2), 'keeps chat when evil present');
assert(!/alert\(1\)/.test(out2), 'strips inline alert');

console.log('OK chat sanitize');
