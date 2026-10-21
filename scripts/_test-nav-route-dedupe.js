'use strict';

/**
 * Regression: authored <a href="/">Home</a> must not get a second Home via /index.
 * Usage: node scripts/_test-nav-route-dedupe.js
 */

const structure = require('../src/siteStructure');
const eng = require('../src/websiteEngine');
const modules = require('../server/siteModules');

function assert(cond, msg, dump) {
  if (!cond) {
    const extra = dump ? `\n---\n${String(dump).slice(0, 2000)}\n---` : '';
    throw new Error((msg || 'assertion failed') + extra);
  }
}

function countHomeInNav(html) {
  const nav = (String(html || '').match(/<nav\b[\s\S]*?<\/nav>/i) || [])[0] || '';
  return [...nav.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].filter((m) =>
    /\bhome\b/i.test(m[0].replace(/<[^>]+>/g, ''))
  ).length;
}

function primaryNav(html) {
  return (String(html || '').match(/<nav\b[\s\S]*?<\/nav>/i) || [])[0] || '';
}

// ── normalizeRoute identity ──────────────────────────────────────────
const homeAliases = ['/', '/index', 'index', 'index.html', '/index.html', 'home', '/home', 'home.html', './index.html'];
for (const a of homeAliases) {
  assert(eng.normalizeRoute(a) === 'index', `normalizeRoute(${JSON.stringify(a)}) === index`);
}
assert(eng.normalizeRoute('/about/') === 'about', 'about trailing slash');
assert(eng.normalizeRoute('about.html') === 'about', 'about.html');
assert(eng.normalizeRoute('/services') === 'services', '/services');
assert(eng.isComparableNavHref('/'), 'bare / is page-like');
assert(eng.isComparableNavHref('/index'), '/index is page-like');
assert(!eng.isComparableNavHref('https://example.com'), 'external skipped');

// ── rebuild + sync: slash Home must stay singular ────────────────────
const pages = [
  {
    slug: '/',
    title: 'Home',
    html: `<!DOCTYPE html><html><body><header><nav>
      <a href="/">Home</a>
      <a href="/about">About</a>
      <a href="/contact">Contact</a>
    </nav></header><main><h1>Home</h1></main></body></html>`,
  },
  {
    slug: '/about',
    title: 'About',
    html: `<!DOCTYPE html><html><body><header><nav>
      <a href="/">Home</a>
      <a href="/about">About</a>
      <a href="/contact">Contact</a>
    </nav></header><main><h1>About</h1></main></body></html>`,
  },
  {
    slug: '/contact',
    title: 'Contact',
    html: `<!DOCTYPE html><html><body><header><nav>
      <a href="/">Home</a>
      <a href="/about">About</a>
      <a href="/contact">Contact</a>
    </nav></header><main><h1>Contact</h1></main></body></html>`,
  },
];

const navLinks = structure.buildNavLinks(pages, { preview: false });
const rebuilt = modules.rebuildFreeformPrimaryNav(pages[0].html, navLinks, pages);
assert(countHomeInNav(rebuilt) === 1, 'rebuild: exactly one Home', primaryNav(rebuilt));
assert(/href=["']\/["']/.test(primaryNav(rebuilt)), 'rebuild: keeps author href="/"', primaryNav(rebuilt));
assert(!/href=["']\/index(?:\.html)?["']/i.test(primaryNav(rebuilt)), 'rebuild: no /index Home', primaryNav(rebuilt));

const synced = structure.syncFreeformNavOrder(JSON.parse(JSON.stringify(pages)));
for (const p of synced) {
  assert(countHomeInNav(p.html) === 1, `sync page ${p.slug}: one Home`, primaryNav(p.html));
  const issues = eng.findNavDuplicateIssues(p.html);
  assert(issues.length === 0, `sync page ${p.slug}: no nav dupes`, JSON.stringify(issues));
}

// ── label dedupe: same label different href ──────────────────────────
const labelDupHtml = `<header><nav>
  <a href="/">Home</a>
  <a href="/index">Home</a>
  <a href="/about">About</a>
</nav></header>`;
const deduped = eng.assertAndDedupeNavHtml(labelDupHtml, 'test');
assert(countHomeInNav(deduped) === 1, 'dedupeNavHtml collapses Home', primaryNav(deduped));
assert(/href=["']\/["']/.test(primaryNav(deduped)), 'dedupe keeps first (author) Home', primaryNav(deduped));

// ── renderPage path ──────────────────────────────────────────────────
const rendered = eng.renderPage(synced[0], synced, { name: 'North Harbor' }, { preview: false });
assert(countHomeInNav(rendered) === 1, 'renderPage: one Home', primaryNav(rendered));

// ── insertModuleNavLinks skips matching label ────────────────────────
const withBlogLabel = `<header><nav>
  <a href="/">Home</a>
  <a href="/journal">Blog</a>
</nav></header><main></main>`;
const afterInsert = modules.insertModuleNavLinks
  ? null
  : null;
// insertModuleNavLinks is not exported — exercise via rebuild with active module page.
const blogPages = [
  { slug: '/', title: 'Home', html: withBlogLabel },
  { slug: '/about', title: 'About', html: withBlogLabel },
  { slug: 'blog', title: 'Blog', html: withBlogLabel },
];
const blogSynced = structure.syncFreeformNavOrder(JSON.parse(JSON.stringify(blogPages)), {
  activeModules: [{ type: 'blog', slug: 'blog', label: 'Blog' }],
});
const blogNav = primaryNav(blogSynced[0].html);
const blogLinks = [...blogNav.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].filter((m) =>
  /\bblog\b/i.test(m[0].replace(/<[^>]+>/g, ''))
);
assert(blogLinks.length === 1, 'Blog label not duplicated', blogNav);

// ── CTA label dedupe: Book Now with nav-cta / btn must collapse ─────
function countLabelInNav(html, labelRe) {
  const nav = primaryNav(html);
  return [...nav.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].filter((m) =>
    labelRe.test(m[0].replace(/<[^>]+>/g, ''))
  ).length;
}

const bookNowDupHtml = `<header><nav>
  <a class="brand" href="/" data-ws-brand="1">North Harbor</a>
  <a href="/">Home</a>
  <a href="/about">About</a>
  <a class="nav-cta btn" href="/book">Book Now</a>
  <a class="nav-cta" href="book.html">Book Now</a>
</nav></header>`;
const bookDeduped = eng.assertAndDedupeNavHtml(bookNowDupHtml, 'book-now-cta');
assert(countLabelInNav(bookDeduped, /\bbook now\b/i) === 1, 'dedupe collapses Book Now CTAs', primaryNav(bookDeduped));
assert(/data-ws-brand|class=["'][^"']*\bbrand\b/i.test(primaryNav(bookDeduped)), 'brand logo kept', primaryNav(bookDeduped));
assert(countHomeInNav(bookDeduped) === 1, 'Home still singular beside brand', primaryNav(bookDeduped));
assert(eng.findNavDuplicateIssues(bookDeduped).length === 0, 'no issues after Book Now dedupe');

// Mixed: authored CTA + page link with same label (rebuild leftover pattern)
const bookMixedHtml = `<header><nav>
  <a class="brand" href="/">Logo</a>
  <a href="/">Home</a>
  <a class="btn cta" href="/book">Book Now</a>
  <a href="/book">Book Now</a>
</nav></header>`;
const bookMixed = eng.assertAndDedupeNavHtml(bookMixedHtml, 'book-now-mixed');
assert(countLabelInNav(bookMixed, /\bbook now\b/i) === 1, 'mixed CTA+page Book Now → one', primaryNav(bookMixed));

// syncFreeformNavOrder: page titled Book Now + authored nav-cta Book Now
const bookPages = [
  {
    slug: '/',
    title: 'Home',
    html: `<!DOCTYPE html><html><body><header><nav>
      <a class="brand" href="/">North Harbor</a>
      <a href="/">Home</a>
      <a href="/about">About</a>
      <a class="nav-cta" href="/book">Book Now</a>
    </nav></header><main><h1>Home</h1></main></body></html>`,
  },
  {
    slug: '/about',
    title: 'About',
    html: `<!DOCTYPE html><html><body><header><nav>
      <a class="brand" href="/">North Harbor</a>
      <a href="/">Home</a>
      <a href="/about">About</a>
      <a class="nav-cta" href="/book">Book Now</a>
    </nav></header><main><h1>About</h1></main></body></html>`,
  },
  {
    slug: 'book',
    title: 'Book Now',
    html: `<!DOCTYPE html><html><body><header><nav>
      <a class="brand" href="/">North Harbor</a>
      <a href="/">Home</a>
      <a href="/about">About</a>
      <a class="nav-cta" href="/book">Book Now</a>
    </nav></header><main><h1>Book</h1></main></body></html>`,
  },
];
const bookSynced = structure.syncFreeformNavOrder(JSON.parse(JSON.stringify(bookPages)), {
  activeModules: [{ type: 'bookings', slug: 'book', label: 'Book Now' }],
});
for (const p of bookSynced) {
  assert(
    countLabelInNav(p.html, /\bbook now\b/i) === 1,
    `sync page ${p.slug}: one Book Now`,
    primaryNav(p.html)
  );
  const issues = eng.findNavDuplicateIssues(p.html);
  assert(issues.length === 0, `sync page ${p.slug}: no nav dupes`, JSON.stringify(issues));
}
const bookRendered = eng.renderPage(bookSynced[0], bookSynced, { name: 'North Harbor' }, { preview: false });
assert(countLabelInNav(bookRendered, /\bbook now\b/i) === 1, 'renderPage: one Book Now', primaryNav(bookRendered));

console.log('OK _test-nav-route-dedupe.js');
