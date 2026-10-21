'use strict';

/**
 * Offline checks for portal theme colors: engine CSS vars + portal module export.
 */
const assert = require('assert');
const engine = require('../src/websiteEngine');
const portal = require('../server/clientPortal');

assert.strictEqual(typeof engine.themeRootCss, 'function');
assert.strictEqual(typeof engine.siteCss, 'function');
assert.strictEqual(typeof portal.applyClientThemeColors, 'function');

const css = engine.siteCss({
  primary: '#ff0000',
  secondary: '#00aa00',
  bg: '#f0f0f0',
  text: '#111111',
});
assert.ok(css.includes('--ws-primary:#ff0000'), 'root primary var');
assert.ok(css.includes('--ws-secondary:#00aa00'), 'root secondary var');
assert.ok(css.includes('var(--ws-primary)'), 'uses primary var');
assert.ok(css.includes('var(--ws-bg)'), 'uses bg var');

const free = engine.siteCss({
  primary: '#112233',
  secondary: '#445566',
  bg: '#ffffff',
  text: '#000000',
  baseCss: false,
  customCss: 'body{color:var(--ws-text)}',
});
assert.ok(free.includes('--ws-primary:#112233'), 'freeform injects root vars');
assert.ok(free.includes('body{color:var(--ws-text)}'), 'keeps customCss');

const updated = engine.injectThemeStyles(
  '<html><head><style data-ws-theme="1">:root{--ws-primary:#000000}</style></head><body>x</body></html>',
  { primary: '#abcdef', secondary: '#111111', bg: '#ffffff', text: '#222222' }
);
assert.ok(updated.includes('--ws-primary:#abcdef'), 'injectThemeStyles refreshes existing block');

const root = engine.themeRootCss({ primary: '#abc', secondary: '#def', bg: '#fff', text: '#000' });
assert.ok(root.startsWith(':root{'), 'themeRootCss shape');

console.log('portal theme verify OK');
