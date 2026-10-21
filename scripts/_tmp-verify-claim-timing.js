'use strict';

/**
 * Static verify of claim-preview.js timing UX (no browser).
 * Usage: node scripts/_tmp-verify-claim-timing.js [path]
 */
const fs = require('fs');
const path = require('path');
const file = process.argv[2] || path.join(__dirname, '..', 'public', 'js', 'claim-preview.js');
const src = fs.readFileSync(file, 'utf8');

const checks = [
  [/DELAY_MS\s*=\s*10000/, '10s delay constant'],
  [/setTimeout\(\s*\(\)\s*=>\s*triggerShow\(['"]timer['"]\)/, 'timer trigger'],
  [/popstate/, 'popstate back intercept'],
  [/bpClaimGuard/, 'history guard pushState'],
  [/beforeunload/, 'beforeunload fallback'],
  [/visibilitychange/, 'visibilitychange leave'],
  [/pagehide/, 'pagehide leave'],
  [/Yes I'm interested|Yes I\\'m interested/, 'Yes label'],
  [/No - Delete it/, 'No label'],
  [/Maybe later/, 'Later label'],
  [/markLaterSession/, 'later session mark'],
  [/disarm\(\)/, 'disarm after answer'],
  [/canTrigger/, 'anti-spam canTrigger'],
  [/isOpen\(\)/, 'anti-spam isOpen'],
];

let fail = 0;
for (const [re, name] of checks) {
  if (re.test(src)) console.log('OK', name);
  else {
    console.error('MISSING', name);
    fail++;
  }
}
// Must NOT show immediately on boot without timer/leave
if (/DOMContentLoaded.*showPopup|showPopup\(meta\);\s*\}\s*\n\s*boot/.test(src)
  && !/armTriggers/.test(src)) {
  console.error('FAIL appears to show immediately without armTriggers');
  fail++;
} else {
  console.log('OK deferred show via armTriggers');
}
process.exit(fail ? 1 : 0);
