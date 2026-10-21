/** Quick smoke: layout section renderers produce expected markup. */
const engine = require('../src/websiteEngine');
const structure = require('../src/siteStructure');

const theme = engine.normalizeTheme({ primary: '#0e7a68', secondary: '#1c140f', baseCss: true });
const pages = [{
  slug: '/',
  title: 'Home',
  sections: [
    { type: 'nav', content: { business_name: 'Test Co', phone: '555-0100' } },
    { type: 'hero', content: { headline: 'Hello', subheadline: 'World', cta_text: 'Call', cta_href: 'tel:555' } },
    { type: 'columns', content: { cols: 2, title: 'Two col', cells: [{ heading: 'A', body: 'left' }, { heading: 'B', body: 'right' }] } },
    { type: 'text', content: { heading: 'Text', body: 'Body copy' } },
    { type: 'text_image', content: { heading: 'Split', body: 'With image', image_position: 'right' } },
    { type: 'cards', content: { title: 'Cards', cols: 3, items: [{ title: 'One', text: 'a' }, { title: 'Two', text: 'b' }, { title: 'Three', text: 'c' }] } },
    { type: 'html', content: { html: '<p class="x">Rich fragment</p>' } },
    { type: 'footer', content: { business_name: 'Test Co' } },
  ],
}];

const html = engine.renderPage(pages[0], pages, theme, { preview: true });
const checks = [
  ['cols-2', /cols-2/],
  ['text-block', /text-block/],
  ['text-image', /text-image-grid/],
  ['cards', /cards-grid cols-3/],
  ['html frag', /Rich fragment/],
  ['hero', /<h1>/],
];
let ok = true;
for (const [name, re] of checks) {
  const pass = re.test(html);
  console.log(pass ? 'ok' : 'FAIL', name);
  if (!pass) ok = false;
}

const inserted = structure.insertContentSection(pages, 0, 2, 'columns', { cols: 4 });
const col = inserted.pages[0].sections[3];
console.log(col && col.type === 'columns' && col.content.cols === 4 ? 'ok insert 4-col' : 'FAIL insert');
if (!(col && col.type === 'columns' && col.content.cols === 4)) ok = false;

const types = new Set(engine.COMPONENT_TYPES);
for (const t of ['columns', 'text', 'text_image', 'cards']) {
  if (!types.has(t)) { console.log('FAIL missing type', t); ok = false; }
  else console.log('ok type', t);
}

if (!ok) process.exit(1);
console.log('smoke layout sections passed');
