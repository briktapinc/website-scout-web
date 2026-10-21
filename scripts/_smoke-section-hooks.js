const e = require('../src/websiteEngine');
const html = e.sectionToHtml(
  {
    type: 'hero',
    className: 'dd-hero full-bleed',
    content: {
      headline: 'Hi',
      subheadline: 'There',
      cta_text: 'Call',
      cta_href: 'tel:1',
      style: 'min-height:80vh',
    },
  },
  { baseCss: true, primary: '#122539' },
  { page: 0, section: 1, editing: false }
);
console.log(html.slice(0, 320));
const checks = [
  ['type', /data-ws-section-type="hero"/],
  ['class', /dd-hero/],
  ['style', /min-height:80vh/],
];
let ok = true;
for (const [name, re] of checks) {
  const pass = re.test(html);
  console.log(pass ? 'ok' : 'FAIL', name);
  if (!pass) ok = false;
}
if (!ok) process.exit(1);
console.log('section hooks passed');
