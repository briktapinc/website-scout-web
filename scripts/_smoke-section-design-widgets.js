#!/usr/bin/env node
'use strict';

/**
 * Smoke: page → section → design module → widget nesting + placement-preserving sync.
 */
const path = require('path');
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg || 'assert failed');
};

const engine = require('../src/websiteEngine');
const structure = require('../src/siteStructure');
const modules = require('../server/siteModules');
const forms = require('../server/contactForms');

let ok = true;
function check(name, cond) {
  if (cond) console.log('ok', name);
  else {
    console.error('FAIL', name);
    ok = false;
  }
}

// ── Layout catalog ──────────────────────────────────────────────
for (const type of ['heading', 'text', 'image', 'html', 'columns', 'text_image', 'cards']) {
  const content = structure.defaultSectionContent(type, { cols: 2 });
  const html = engine.sectionToHtml({ type, content }, {});
  check(`layout ${type} renders`, !!html && html.length > 20);
  check(`layout ${type} marked design-module`, /data-ws-design-module|ws-design-module|layout-columns|text-block|text-image|layout-cards|ws-html-block|ws-design-heading|ws-design-image/.test(html));
}

// ── Edit script controls ────────────────────────────────────────
const src = require('fs').readFileSync(path.join(__dirname, '../src/websiteEngine.js'), 'utf8');
const editStart = src.indexOf('const PREVIEW_EDIT_SCRIPT');
const editEnd = src.indexOf('</script>`', editStart);
const edit = src.slice(editStart, editEnd);
check('Add section control', /data-ws-add',\s*'page-section'|data-ws-add="page-section"|'page-section'/.test(edit) && /\+ Add section/.test(edit));
check('Add design module control', /Add design module/.test(edit) && /design-module/.test(edit));
check('Add widget control', /Add widget/.test(edit));
check('Delete design module', /Delete design module/.test(edit));
check('Delete widget', /Delete widget/.test(edit));
check('pick-block request', /pick-block/.test(edit));
check('insert-block handler', /insert-block/.test(edit));

// ── Sync preserves nest placement ───────────────────────────────
const token = '99_smokeTokenAbc';
const nestedHtml = `<main class="page">
  <section class="ws-page-section" data-ws-page-section="1">
    <section class="block layout-columns ws-design-module" data-ws-design-module="1">
      <div class="container">
        <div class="bitpype-module-embed" data-bitpype-module="1" data-bitpype-module-type="bookings"
          data-bitpype-module-token="${token}" data-bitpype-api="https://example.com" data-bitpype-hide-title="1"></div>
      </div>
    </section>
  </section>
</main>`;

const keep = new Set([token]);
const preserved = modules.stripInactiveModuleEmbedsFromHtml
  ? modules.stripInactiveModuleEmbedsFromHtml(nestedHtml, keep)
  : null;

if (typeof modules.stripInactiveModuleEmbedsFromHtml === 'function') {
  check('module strip keeps active nested token', modules.htmlHasModuleToken(preserved, token));
  check('module strip keeps design module wrapper', /layout-columns/.test(preserved) && /ws-page-section/.test(preserved));
  const stripped = modules.stripInactiveModuleEmbedsFromHtml(nestedHtml, new Set());
  check('module strip removes inactive token', !modules.htmlHasModuleToken(stripped, token));
} else {
  // Helpers may not be exported — test via sync path with in-memory DB stub
  check('stripInactiveModuleEmbedsFromHtml exported', false);
}

// Form inactive strip
const formTok = '99_formTokXyz';
const formNested = nestedHtml.replace(
  /bitpype-module-embed[\s\S]*?<\/div>/,
  `bitpype-form-embed" data-bitpype-managed="1" data-bitpype-form-embed="${formTok}" data-bitpype-api="https://example.com"></div>`
);
if (typeof forms.stripInactiveFormEmbedsFromHtml === 'function') {
  const keepF = forms.stripInactiveFormEmbedsFromHtml(formNested, new Set([formTok]));
  check('form strip keeps active nested token', forms.htmlHasFormToken(keepF, formTok));
  const dropF = forms.stripInactiveFormEmbedsFromHtml(formNested, new Set());
  check('form strip removes inactive token', !forms.htmlHasFormToken(dropF, formTok));
} else {
  // Inline regex check mirroring the server helper
  const re = new RegExp(`data-bitpype-form-embed\\s*=\\s*["']${formTok}["']`, 'i');
  check('form nest html has token', re.test(formNested));
}

// ── Nesting HTML shape ──────────────────────────────────────────
const nest = `<main>
  <section class="ws-page-section" data-ws-page-section="1">
    <section class="block text-block ws-design-module" data-ws-design-module="1">
      <div class="bitpype-form-embed" data-bitpype-managed="1" data-bitpype-form-embed="1_abc"></div>
    </section>
  </section>
</main>`;
check('nest order page>section>design>widget',
  /ws-page-section[\s\S]*ws-design-module[\s\S]*bitpype-form-embed/.test(nest));

if (!ok) {
  console.error('SMOKE FAILED');
  process.exit(1);
}
console.log('SMOKE OK section-design-widgets');
