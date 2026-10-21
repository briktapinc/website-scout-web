'use strict';

const portal = require('../server/clientPortal');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const preview = 'https://bitpype.com/site-previews/ws-1-site-9/';

assert(
  portal.normalizePortalImageSrc('images/hero.jpg', preview) === 'images/hero.jpg',
  'relative images/'
);
assert(
  portal.normalizePortalImageSrc('./images/hero.jpg', preview) === 'images/hero.jpg',
  './images/'
);
assert(
  portal.normalizePortalImageSrc(
    'https://bitpype.com/site-previews/ws-1-site-9/images/hero.jpg',
    preview
  ) === 'images/hero.jpg',
  'absolute preview url'
);
assert(
  portal.normalizePortalImageSrc('images/../evil.jpg', preview) == null,
  'reject path traversal'
);
assert(
  portal.normalizePortalImageSrc('data:image/png;base64,xxx', preview) == null,
  'reject data uri'
);
assert(
  portal.normalizePortalImageSrc('https://d59c.pages.dev/images/hero.jpg', preview) === 'images/hero.jpg',
  'cf/pages absolute images path'
);

console.log(JSON.stringify({ ok: true }, null, 2));
