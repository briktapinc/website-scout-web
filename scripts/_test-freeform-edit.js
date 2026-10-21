'use strict';

const engine = require('../src/websiteEngine');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const sample = `<!DOCTYPE html><html><head><title>T</title><style>.x{color:red}</style></head>
<body>
  <h1>Hello World</h1>
  <p>Call <a href="tel:555-1212">555-1212</a> today.</p>
  <p>We fix <strong>panels</strong> fast.</p>
  <a href="about.html">About us</a>
</body></html>`;

const marked = engine.markFreeformDocument(engine.sanitizeHtml(sample), 0);
assert(marked.includes('data-edit="html:0:0"'), 'missing first marker');
assert(marked.includes('Hello World'), 'title text present');
assert(!/data-edit="html:0:\d+">555-1212/.test(marked), 'tel link text should stay locked');
assert(marked.includes('data-edit="html:0:'), 'has markers');

const count = (marked.match(/data-edit="html:0:/g) || []).length;
assert(count >= 3, `expected several markers, got ${count}`);

const edited = engine.applyFreeformTextEdits(sample, new Map([[0, 'Edited Headline']]));
assert(edited.includes('Edited Headline'), 'apply should replace first text node');
assert(edited.includes('555-1212'), 'phone text preserved');
assert(edited.includes('<strong>panels</strong>'), 'nested markup preserved');

const pages = [
  { slug: 'index', title: 'Home', html: sample },
  { slug: 'about', title: 'About', html: '<!DOCTYPE html><html><body><h1>About page</h1><p>Story</p></body></html>' },
];
const site = engine.renderSite(pages, { baseCss: false, customCss: 'body{margin:0}' }, { editable: true });
assert(site.includes('data-edit="html:0:'), 'site render page0 markers');
assert(site.includes('data-edit="html:1:'), 'site render page1 markers');
assert(site.includes('contentEditable') || site.includes('data-edit'), 'edit script or markers');
assert(site.includes('ws-preview'), 'preview scripts present');
assert(site.includes('ws-portal') && site.includes('edit-mode'), 'edit-mode toggle script present');
assert(site.includes('ws-editing'), 'edit-mode style present');
assert(site.includes('image-replace'), 'image replace hook present in edit script');

const withBase = engine.injectPreviewBaseHref(
  '<!DOCTYPE html><html><head><title>t</title></head><body><img src="images/a.jpg"></body></html>',
  'https://bitpype.com/site-previews/ws-1-site-2/'
);
assert(withBase.includes('data-ws-preview-base="1"'), 'base tag marker');
assert(withBase.includes('href="https://bitpype.com/site-previews/ws-1-site-2/"'), 'base href');
assert(!engine.injectPreviewBaseHref('<p>x</p>', '').includes('<base'), 'no base without url');

console.log(JSON.stringify({
  ok: true,
  markersPage0: count,
  siteMarkers: (site.match(/data-edit="html:/g) || []).length,
  sampleEditedOk: edited.includes('Edited Headline'),
  baseHrefOk: withBase.includes('data-ws-preview-base'),
}, null, 2));
