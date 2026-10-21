const eng = require('../src/websiteEngine');

const pages = [
  {
    slug: '/',
    title: 'Home',
    html: '<!DOCTYPE html><html><head><style>.nav{display:flex}</style></head><body><nav><a href="about.html">About</a><a href="/contact">Contact</a><a href="./index.html">Home</a></nav><h1>Home</h1></body></html>',
  },
  {
    slug: 'about',
    title: 'About',
    html: '<!DOCTYPE html><html><body><nav><a href="index.html">Home</a></nav><h1>About</h1></body></html>',
  },
  {
    slug: 'contact',
    title: 'Contact',
    sections: [
      { type: 'nav', content: { business_name: 'X' } },
      { type: 'about', content: { heading: 'Hi', body: 'There' } },
    ],
  },
];

const html = eng.renderSite(pages, { primary: '#111' }, { preview: true });
const checks = {
  'has nav guard': html.includes('data-ws-preview-nav'),
  'about anchor': html.includes('href="#about"'),
  'contact anchor': html.includes('href="#contact"'),
  'home anchor': html.includes('href="#home"'),
  'no about.html href': !/href=["']about\.html["']/.test(html),
  'has style from head': html.includes('.nav{display:flex}'),
  'page anchors': html.includes('id="about"') && html.includes('id="contact"'),
};

const one = eng.renderPageAt(pages, {}, { preview: true, pageSlug: 'about' });
checks['single has guard'] = one.includes('data-ws-preview-nav');
checks['single rewrote index'] = one.includes('href="#home"');

const exp = eng.renderPage(pages[0], pages, {}, {});
checks['export no guard'] = !exp.includes('data-ws-preview-nav');
checks['export keeps about.html'] = exp.includes('about.html');

// Hash-style multipage nav (common agent mistake) must become real files on export.
const hashPages = [
  {
    slug: 'index',
    title: 'Home',
    html: '<!DOCTYPE html><html><body><nav><a href="#home">Home</a><a href="#services">Services</a><a href="#about">About</a><a href="#faq">FAQ</a><a href="#contact">Contact</a><a href="#main">Skip</a></nav><main id="main"><h1>Home</h1></main></body></html>',
  },
  { slug: 'services', title: 'Services', html: '<!DOCTYPE html><html><body><nav><a href="#home">Home</a><a href="#services">Services</a></nav><h1>Services</h1></body></html>' },
  { slug: 'about', title: 'About', html: '<html><body><h1>About</h1></body></html>' },
  { slug: 'faq', title: 'FAQ', html: '<html><body><h1>FAQ</h1></body></html>' },
  { slug: 'contact', title: 'Contact', html: '<html><body><h1>Contact</h1></body></html>' },
];
const hashExport = eng.renderPage(hashPages[0], hashPages, {}, {});
checks['export rewrites #services'] = /href=["']services\.html["']/.test(hashExport);
checks['export rewrites #about'] = /href=["']about\.html["']/.test(hashExport);
checks['export rewrites #faq'] = /href=["']faq\.html["']/.test(hashExport);
checks['export rewrites #contact'] = /href=["']contact\.html["']/.test(hashExport);
checks['export rewrites #home'] = /href=["']index\.html["']/.test(hashExport);
checks['export keeps #main'] = /href=["']#main["']/.test(hashExport);
checks['export no dangling page hashes'] = !/href=["']#(home|services|about|faq|contact)["']/.test(hashExport);

const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-export-nav-'));
const written = eng.writeStaticPages(hashPages, {}, tmp, {});
checks['wrote index.html'] = written.files.includes('index.html');
checks['wrote services.html'] = written.files.includes('services.html');
const navCheck = eng.validateExportNavLinks(hashPages, tmp);
checks['validateExportNavLinks ok'] = navCheck.ok === true;
const indexDisk = fs.readFileSync(path.join(tmp, 'index.html'), 'utf8');
checks['disk index has services.html'] = /href=["']services\.html["']/.test(indexDisk);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* optional */ }

// Landing (single page) must keep #section hashes.
const landing = [{ slug: '/', title: 'Home', html: '<body><a href="#services">Services</a><section id="services">S</section></body>' }];
const landHtml = eng.renderPage(landing[0], landing, {}, {});
checks['landing keeps #services'] = /href=["']#services["']/.test(landHtml);

let failed = 0;
for (const [k, v] of Object.entries(checks)) {
  console.log((v ? 'OK' : 'FAIL') + '  ' + k);
  if (!v) failed += 1;
}
process.exit(failed ? 1 : 0);
