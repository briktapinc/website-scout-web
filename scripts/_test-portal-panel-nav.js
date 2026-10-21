'use strict';

/** Pure regression checks for portal tab hash vs sticky ?panel= query. */

const PANEL_ALIASES = {
  website: 'website',
  preview: 'website',
  site: 'website',
  changes: 'changes',
  change: 'changes',
  request: 'changes',
  forms: 'forms',
  form: 'forms',
  submissions: 'forms',
  social: 'social',
  calendar: 'social',
  posts: 'social',
  billing: 'billing',
  plans: 'billing',
  subscribe: 'billing',
};

function parsePortalHash(search, hash) {
  const raw = String(hash || '').replace(/^#\/?/, '').trim().toLowerCase();
  const key = raw.split(/[/?&#]/)[0] || '';
  if (key) return PANEL_ALIASES[key] || null;
  try {
    const panel = new URLSearchParams(search).get('panel');
    if (!panel) return null;
    return PANEL_ALIASES[String(panel).toLowerCase()] || null;
  } catch {
    return null;
  }
}

const cases = [
  ['?panel=social', '#/website', 'website'],
  ['?panel=social&connected=1', '#/changes', 'changes'],
  ['?panel=billing', '#/forms', 'forms'],
  ['', '#/changes', 'changes'],
  ['?panel=social', '', 'social'],
  ['?panel=social', '#/', 'social'],
  ['?panel=website', '#/billing', 'billing'],
  ['', '#/unknown-tab', null],
];

let failed = 0;
for (const [search, hash, want] of cases) {
  const got = parsePortalHash(search, hash);
  const ok = got === want;
  console.log((ok ? 'OK' : 'FAIL') + `  search=${search || '(none)'} hash=${hash || '(none)'} -> ${got} (want ${want})`);
  if (!ok) failed += 1;
}

if (failed) {
  console.error(`portal panel nav: ${failed} failed`);
  process.exit(1);
}
console.log('portal panel nav: all ok');
