const eng = require('../src/websiteEngine');
const h = eng.renderSite([{
  slug: '/',
  title: 'H',
  sections: [
    { type: 'nav', content: { business_name: 'A' } },
    { type: 'about', content: { heading: 'x', body: 'y' } },
  ],
}], {});
const m = h.match(/data-ws-preview-nav="1">([\s\S]*?)<\/script>/);
if (!m) {
  console.error('no match');
  process.exit(1);
}
try {
  // eslint-disable-next-line no-new-func
  new Function(m[1]);
  console.log('OK guard parses');
} catch (err) {
  console.error('FAIL', err.message);
  console.error(m[1].slice(0, 500));
  process.exit(1);
}
