'use strict';
const s = require('../src/siteStructure');
const m = require('../server/siteModules');
const pages = [
  {
    slug: 'home',
    title: 'Home',
    html: '<header><a href="index.html">Home</a><a href="about.html">About</a></header>',
  },
  {
    slug: 'about',
    title: 'About',
    html: '<header><a href="index.html">Home</a><a href="about.html">About</a></header>',
  },
];
const r = s.toggleNavVisibility(pages, 1);
const ok = r.pages[1].navVisible === false && !/about/i.test(r.pages[0].html) && typeof m.rebuildFreeformPrimaryNav === 'function';
console.log(ok ? 'OK nav_visible_header' : 'FAIL nav_visible_header');
process.exit(ok ? 0 : 1);
