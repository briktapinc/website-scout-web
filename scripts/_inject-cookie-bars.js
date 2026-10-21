'use strict';

/**
 * Backfill cookie footer bar into all existing EXPORT_ROOT site folders.
 * Usage: node scripts/_inject-cookie-bars.js
 */
const path = require('path');
const previewChrome = require('../src/previewChrome');
const openPreview = require('../src/openPreview');

const root = openPreview.exportRoot();
console.log('EXPORT_ROOT', root);
const result = previewChrome.injectCookieBarIntoAllExports(root);
console.log(JSON.stringify(result, null, 2));
