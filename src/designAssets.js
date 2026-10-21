'use strict';

/**
 * Design assets the MCP agent can pull into website builds.
 * Mobile nav is CSS-only (checkbox) so it survives sanitizeHtml (scripts stripped).
 */

const MOBILE_NAV_ID = 'mobile-nav';
const MOBILE_NAV_CSS_HREF = '/css/mobile-nav.css';
const MOBILE_NAV_MARKER = 'data-bitpype-mobile-nav';

const MOBILE_NAV_HTML = `<!-- BitPype mobile hamburger nav (no JS). Keep this structure on every page. -->
<header class="site-header" ${MOBILE_NAV_MARKER}="1">
  <div class="bp-nav-bar">
    <a class="brand" href="index.html">{{BRAND}}</a>
    <input type="checkbox" id="bp-nav" class="bp-nav-toggle" aria-controls="bp-nav-panel">
    <label for="bp-nav" class="bp-nav-burger" aria-label="Open menu">
      <span></span><span></span><span></span>
    </label>
    <nav id="bp-nav-panel" class="bp-nav-panel" aria-label="Main">
      <a href="index.html">Home</a>
      <a href="services.html">Services</a>
      <a href="about.html">About</a>
      <a href="faq.html">FAQ</a>
      <a href="contact.html">Contact</a>
    </nav>
  </div>
</header>`;

const MOBILE_NAV_USAGE = [
  'Use on every multipage (and most landing) builds when top nav has 3+ links.',
  `Put ${MOBILE_NAV_MARKER}="1" on the header wrapper and keep .bp-nav-toggle + .bp-nav-burger + .bp-nav-panel as siblings (burger label immediately after the checkbox).`,
  'Nav hrefs must stay relative *.html filenames (index.html, services.html, …).',
  'Do not add custom menu JavaScript — scripts are stripped. BitPype injects /css/mobile-nav.css when the marker is present.',
  'Style brand/links with your theme; the asset only handles show/hide + burger icon.',
].join(' ');

function listDesignAssets() {
  return [
    {
      id: MOBILE_NAV_ID,
      name: 'Mobile hamburger nav',
      kind: 'nav',
      description: 'Accessible CSS-only hamburger menu for mobile breakpoints. No JavaScript.',
      cssHref: MOBILE_NAV_CSS_HREF,
      marker: `${MOBILE_NAV_MARKER}="1"`,
      html: MOBILE_NAV_HTML,
      usage: MOBILE_NAV_USAGE,
    },
  ];
}

function getDesignAsset(id) {
  const want = String(id || '').trim().toLowerCase();
  return listDesignAssets().find((a) => a.id === want) || null;
}

function mobileNavHtml(brandName) {
  const brand = String(brandName || 'Home').trim() || 'Home';
  return MOBILE_NAV_HTML.replace(/\{\{BRAND\}\}/g, brand);
}

module.exports = {
  MOBILE_NAV_ID,
  MOBILE_NAV_CSS_HREF,
  MOBILE_NAV_MARKER,
  MOBILE_NAV_HTML,
  listDesignAssets,
  getDesignAsset,
  mobileNavHtml,
};
