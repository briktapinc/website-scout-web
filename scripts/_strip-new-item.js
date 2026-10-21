'use strict';

const fs = require('fs');
const src = process.argv[2];
const out = process.argv[3];
const j = JSON.parse(fs.readFileSync(src, 'utf8'));
const site = j.data.site;
const theme = typeof site.theme === 'string' ? JSON.parse(site.theme) : site.theme;
let pages = typeof site.pages === 'string' ? JSON.parse(site.pages) : site.pages;

const re = /<div[^>]*>\s*<h3[^>]*>\s*(?:<span[^>]*>)?\s*New item\s*(?:<\/span>)?\s*<\/h3>\s*<p[^>]*>\s*(?:<span[^>]*>)?\s*This is a new item\s*(?:<\/span>)?\s*<\/p>\s*<\/div>/gi;

pages = pages.map((pg) => {
  if (!pg.html) return pg;
  const before = pg.html.length;
  const html = pg.html.replace(re, '');
  console.log(pg.slug || pg.path || pg.name, before, '->', html.length, 'still?', /New item/i.test(html));
  return { ...pg, html };
});

const payload = { name: site.name, theme, pages };
const body = { id: 3, payload };
fs.writeFileSync(out, JSON.stringify(body));
console.log('wrote', out, Buffer.byteLength(JSON.stringify(body)), 'bytes');
