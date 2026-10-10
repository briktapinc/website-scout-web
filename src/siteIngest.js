'use strict';

/**
 * Site ingest: fetch a business website (+ same-origin content pages),
 * build a redesign site map (services, areas, FAQ, contact), and extract
 * structured copy. No layout cloning — content and quality signals only.
 */

const MAX_PAGES = 18;
const MAX_SITEMAP_URLS = 200;
const FETCH_MS = 12000;
const MAX_HTML = 800_000;
const MAX_TEXT = 12_000;
const MAX_ABOUT = 2500;
const MAX_SNAPSHOT = 12000;
const UA = 'WebsiteScout/0.1 (+local; site-ingest)';

const AREA_SLUGS = [
  'brooklyn-ny', 'manhattan-ny', 'queens-ny', 'bronx-ny', 'the-bronx-ny',
  'staten-island-ny', 'westchester-ny', 'long-island-ny', 'nassau-ny',
  'suffolk-ny', 'jersey-city-nj', 'hoboken-nj',
];

const PAGE_HINTS = [
  { re: /\/(about|about-us|our-story|who-we-are)(\/|$|\?)/i, role: 'about' },
  { re: /\/(services|our-services|what-we-do|solutions|offerings)(\/|$|\?)/i, role: 'services' },
  { re: /\/(contact|contact-us|get-in-touch)(\/|$|\?)/i, role: 'contact' },
  { re: /\/(hours|schedule|book|booking|appointment)(\/|$|\?)/i, role: 'hours' },
  { re: /\/(team|staff|people|careers?|hiring|jobs?)(\/|$|\?)/i, role: 'team' },
  { re: /\/(faq|questions)(\/|$|\?)/i, role: 'faq' },
  { re: /\/(locations?|service-area|areas-we-serve)(\/|$|\?)/i, role: 'locations' },
];

const SERVICE_SLUG_RE = /^(drain|pipe|boiler|heater|backflow|sprinkler|sewer|garbage|plumb|repair|install|water|gas|ll\d|local-law|rpz|inspection)/i;

function absUrl(base, href) {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return Number.isFinite(c) && c > 0 && c < 0x110000 ? String.fromCodePoint(c) : '';
    });
}

function stripToText(html) {
  const cleaned = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
  return decodeEntities(cleaned).trim().slice(0, MAX_TEXT);
}

function metaContent(html, nameOrProp) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${nameOrProp}["'][^>]+content=["']([^"']+)["']`,
    'i'
  );
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${nameOrProp}["']`,
    'i'
  );
  const m = html.match(re) || html.match(re2);
  return m ? decodeEntities(m[1]).trim().slice(0, 500) : '';
}

function pageTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

function extractPhones(text) {
  const out = [];
  const re = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;
  let m;
  while ((m = re.exec(text)) && out.length < 5) {
    const p = m[0].replace(/\s+/g, ' ').trim();
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

function extractEmails(text) {
  const out = [];
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  let m;
  while ((m = re.exec(text)) && out.length < 5) {
    const e = m[0].toLowerCase();
    if (/example\.com$|sentry\.|wixpress|domain\.com$/.test(e)) continue;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

function extractLinks(html, baseUrl) {
  const links = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && links.length < 80) {
    const href = absUrl(baseUrl, m[1].trim());
    if (!href || !sameOrigin(baseUrl, href)) continue;
    const label = stripToText(m[2]).slice(0, 80);
    links.push({ href, label });
  }
  return links;
}

function titleFromSlug(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
    .replace(/\bLl(\d+)/i, 'LL$1')
    .replace(/\bRpz\b/i, 'RPZ');
}

function areaLabel(slug) {
  const s = String(slug || '').replace(/-ny$|-nj$/i, '').replace(/the-/i, '');
  return titleFromSlug(s);
}

function classifyPath(pathname) {
  const parts = String(pathname || '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (!parts.length) return { kind: 'home', slug: 'home', area: '' };
  const first = parts[0].toLowerCase();
  const second = (parts[1] || '').toLowerCase();
  for (const hint of PAGE_HINTS) {
    if (hint.re.test(`/${first}/`) || hint.re.test(first)) {
      return { kind: hint.role, slug: first, area: '' };
    }
  }
  if (first === 'plumber' || first === 'plumbers') {
    return { kind: 'location', slug: 'plumber', area: second };
  }
  if (parts.length >= 2 && AREA_SLUGS.includes(second)) {
    return { kind: 'service', slug: first, area: second };
  }
  if (parts.length === 1 && SERVICE_SLUG_RE.test(first)) {
    return { kind: 'service', slug: first, area: '' };
  }
  if (parts.length === 1) return { kind: 'page', slug: first, area: '' };
  return { kind: 'other', slug: parts.join('/'), area: '' };
}

function normalizeUrlKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return String(url || '').replace(/\/$/, '').toLowerCase();
  }
}

async function fetchSitemapUrls(origin) {
  const out = [];
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  for (const smUrl of candidates) {
    const got = await fetchHtml(smUrl);
    if (!got.ok || !got.html || !/<loc>/i.test(got.html)) continue;
    const locs = [...got.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
      .map((m) => absUrl(origin, m[1].trim()))
      .filter((u) => u && sameOrigin(origin, u));
    for (const u of locs) {
      if (out.length >= MAX_SITEMAP_URLS) break;
      if (!out.includes(u)) out.push(u);
    }
    if (out.length) break;
  }
  return out;
}

/**
 * Prefer one canonical URL per service (home-city / first area) and keep
 * core IA pages. Geo matrix sites often have 50–100 location variants.
 */
function buildCrawlPlan(homeUrl, linkUrls, sitemapUrls) {
  const origin = (() => {
    try { return new URL(homeUrl).origin; } catch { return homeUrl; }
  })();
  const all = [];
  const push = (u) => {
    const abs = absUrl(homeUrl, u);
    if (!abs || !sameOrigin(homeUrl, abs)) return;
    if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4)(\?|$)/i.test(abs)) return;
    if (!all.some((x) => normalizeUrlKey(x) === normalizeUrlKey(abs))) all.push(abs);
  };
  push(homeUrl);
  for (const u of sitemapUrls || []) push(u);
  for (const u of linkUrls || []) push(u);

  const services = new Map(); // slug -> { areas:Set, urls:[] }
  const locations = new Map();
  const cores = [];
  const extras = [];

  for (const url of all) {
    let pathname = '/';
    try { pathname = new URL(url).pathname; } catch { /* keep */ }
    const info = classifyPath(pathname);
    if (info.kind === 'home') continue;
    if (info.kind === 'service') {
      if (!services.has(info.slug)) services.set(info.slug, { areas: new Set(), urls: [] });
      const row = services.get(info.slug);
      if (info.area) row.areas.add(info.area);
      row.urls.push(url);
      continue;
    }
    if (info.kind === 'location') {
      locations.set(info.area || url, url);
      continue;
    }
    if (['about', 'contact', 'services', 'faq', 'team', 'hours', 'locations'].includes(info.kind)) {
      if (!cores.some((c) => c.role === info.kind)) cores.push({ url, role: info.kind, slug: info.slug });
      continue;
    }
    if (info.kind === 'page' && extras.length < 6) {
      extras.push({ url, role: 'page', slug: info.slug });
    }
  }

  const preferArea = (() => {
    const counts = new Map();
    for (const row of services.values()) {
      for (const a of row.areas) counts.set(a, (counts.get(a) || 0) + 1);
    }
    let best = '';
    let n = 0;
    for (const [a, c] of counts) {
      if (c > n) { best = a; n = c; }
    }
    return best || 'brooklyn-ny';
  })();

  const servicePlan = [];
  for (const [slug, row] of services) {
    const areas = [...row.areas];
    let canonical = row.urls.find((u) => u.includes(`/${slug}/${preferArea}`));
    if (!canonical) {
      canonical = row.urls.find((u) => AREA_SLUGS.some((a) => u.includes(`/${slug}/${a}`))) || row.urls[0];
    }
    if (!canonical) continue;
    servicePlan.push({
      url: canonical,
      role: 'service',
      slug,
      title: titleFromSlug(slug),
      areas,
      preferArea,
    });
  }
  servicePlan.sort((a, b) => a.title.localeCompare(b.title));

  const areaList = [...new Set([
    ...[...locations.keys()].filter(Boolean).map(areaLabel),
    ...[...services.values()].flatMap((r) => [...r.areas].map(areaLabel)),
  ])].filter(Boolean).sort();

  const fetchList = [];
  const seen = new Set([normalizeUrlKey(homeUrl)]);
  const addFetch = (item) => {
    const key = normalizeUrlKey(item.url);
    if (seen.has(key)) return;
    if (fetchList.length >= MAX_PAGES - 1) return;
    seen.add(key);
    fetchList.push(item);
  };

  for (const c of cores) addFetch(c);
  for (const s of servicePlan) addFetch(s);
  // One representative location/service-area page
  const locUrl = locations.get(preferArea)
    || [...locations.values()][0]
    || null;
  if (locUrl) addFetch({ url: locUrl, role: 'location', slug: 'service-area', areas: areaList });
  for (const e of extras) addFetch(e);

  return {
    origin,
    sitemap_count: (sitemapUrls || []).length,
    discovered_count: all.length,
    prefer_area: preferArea,
    areas: areaList,
    services: servicePlan.map((s) => ({
      slug: s.slug,
      title: s.title,
      url: s.url,
      areas: s.areas,
    })),
    cores: cores.map((c) => ({ role: c.role, url: c.url, slug: c.slug })),
    fetchList,
  };
}

function pickRelatedUrls(homeUrl, links) {
  // Legacy helper — kept for callers; deep crawl uses buildCrawlPlan.
  const plan = buildCrawlPlan(homeUrl, (links || []).map((l) => l.href), []);
  return plan.fetchList.map((x) => ({ url: x.url, role: x.role }));
}

function faqFromSections(sections) {
  const faq = [];
  for (const s of sections || []) {
    const h = String(s.heading || '');
    if (/^(why |how |what |when |do |is |are |can )/i.test(h) || /\?$/.test(h)) {
      if (String(s.body || '').length > 40) faq.push({ question: h, answer: String(s.body).slice(0, 1200) });
    }
  }
  return faq.slice(0, 12);
}

function mergeFaq(...lists) {
  const out = [];
  for (const list of lists) {
    for (const q of list || []) {
      if (!q || !q.question) continue;
      if (out.some((x) => x.question.toLowerCase() === String(q.question).toLowerCase())) continue;
      out.push(q);
      if (out.length >= 12) return out;
    }
  }
  return out;
}

function extractHeadings(html) {
  const out = [];
  const re = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 40) {
    const t = stripToText(m[2]).slice(0, 120);
    if (t && t.length > 2) out.push({ level: Number(m[1]), text: t });
  }
  return out;
}

function extractListItems(html) {
  const out = [];
  const re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 60) {
    const t = stripToText(m[1]).slice(0, 160);
    if (t && t.length > 2 && t.length < 120) out.push(t);
  }
  return out;
}

function guessServices(html, text, headings) {
  const services = [];
  const push = (s) => {
    const v = String(s || '').replace(/\s+/g, ' ').trim();
    if (!v || v.length < 3 || v.length > 80) return;
    if (/^(home|about|contact|menu|login|read more|learn more)$/i.test(v)) return;
    if (!services.some((x) => x.toLowerCase() === v.toLowerCase())) services.push(v);
  };

  const serviceHeading = headings.find((h) =>
    /service|what we do|offer|solution|specialt/i.test(h.text)
  );
  if (serviceHeading) {
    // Prefer list items near a services heading in the HTML.
    const idx = html.search(/<(h[1-3])[^>]*>[^<]*(service|what we do|offer)/i);
    const chunk = idx >= 0 ? html.slice(idx, idx + 8000) : html;
    for (const li of extractListItems(chunk).slice(0, 15)) push(li);
  }
  for (const h of headings) {
    if (h.level >= 2 && /service|repair|install|plumb|hvac|clean|roof|electric|paint|landscap/i.test(h.text)) {
      push(h.text);
    }
  }
  // Fallback: short lines that look like offerings in body text.
  if (services.length < 3) {
    for (const line of text.split(/\n+/)) {
      const t = line.trim();
      if (/^(we offer|our services|services include)/i.test(t)) {
        const rest = t.replace(/^[^:]+:\s*/, '');
        rest.split(/[,;•|]/).forEach((p) => push(p));
      }
    }
  }
  return services.slice(0, 12);
}

function guessAbout(html, text, metaDesc) {
  const aboutBlock = html.match(
    /<(?:section|div)[^>]*(?:id|class)=["'][^"']*about[^"']*["'][^>]*>([\s\S]*?)<\/(?:section|div)>/i
  );
  if (aboutBlock) {
    const t = stripToText(aboutBlock[1]);
    if (t.length > 80) return t.slice(0, MAX_ABOUT);
  }
  const hAbout = html.search(/<h[1-3][^>]*>\s*about[^<]*<\/h[1-3]>/i);
  if (hAbout >= 0) {
    const after = stripToText(html.slice(hAbout, hAbout + 5000));
    const paras = after.split(/\n+/).filter((p) => p.length > 60);
    if (paras[1] || paras[0]) return (paras.slice(0, 3).join('\n\n')).slice(0, MAX_ABOUT);
  }
  if (metaDesc && metaDesc.length > 40) return metaDesc.slice(0, MAX_ABOUT);
  const paras = text.split(/\n+/).filter((p) => p.length > 80);
  return (paras[0] || '').slice(0, MAX_ABOUT);
}

function extractImages(html, baseUrl) {
  const out = [];
  const push = (raw, role = 'gallery') => {
    const u = absUrl(baseUrl, String(raw || '').trim());
    if (!u) return;
    if (/data:|sprite|pixel|tracking|1x1|spacer|favicon|\.svg($|\?)/i.test(u)) return;
    if (out.some((x) => x.url === u)) return;
    if (out.length < 16) out.push({ url: u, role });
  };

  const og = metaContent(html, 'og:image');
  if (og) push(og, 'hero');
  const tw = metaContent(html, 'twitter:image');
  if (tw) push(tw, 'hero');

  const imgRe = /<img\b([^>]*)>/gi;
  let tag;
  while ((tag = imgRe.exec(html)) && out.length < 16) {
    const attrs = tag[1] || '';
    const src = (attrs.match(/\bsrc=["']([^"']+)["']/i)
      || attrs.match(/\bdata-src=["']([^"']+)["']/i)
      || attrs.match(/\bdata-lazy-src=["']([^"']+)["']/i) || [])[1];
    const srcset = (attrs.match(/\bsrcset=["']([^"']+)["']/i)
      || attrs.match(/\bdata-srcset=["']([^"']+)["']/i) || [])[1];
    let pick = src;
    if (srcset) {
      const parts = srcset.split(',').map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
      if (parts.length) pick = parts[parts.length - 1];
    }
    const cls = `${attrs} ${pick || ''}`;
    let role = 'gallery';
    if (/logo/i.test(cls)) role = 'logo';
    else if (/hero|banner|cover|header|slideshow|carousel/i.test(cls)) role = 'hero';
    else if (/team|staff|about/i.test(cls)) role = 'team';
    if (pick) push(pick, role);
  }

  // CSS background-image urls
  const bgRe = /background(?:-image)?\s*:\s*url\(["']?([^"')]+)["']?\)/gi;
  let bg;
  while ((bg = bgRe.exec(html)) && out.length < 16) {
    push(bg[1], 'hero');
  }

  return out.slice(0, 12);
}

function extractCtas(html, text) {
  const ctas = [];
  const btnRe = /<(?:a|button)\b[^>]*>([\s\S]*?)<\/(?:a|button)>/gi;
  let m;
  while ((m = btnRe.exec(html)) && ctas.length < 8) {
    const label = stripToText(m[1]).slice(0, 60);
    if (!label) continue;
    if (/(call|book|quote|contact|schedule|get started|request|free estimate|hire)/i.test(label)) {
      if (!ctas.includes(label)) ctas.push(label);
    }
  }
  if (!ctas.length) {
    for (const phrase of ['Call Now', 'Get a Quote', 'Book Online', 'Contact Us', 'Free Estimate']) {
      if (new RegExp(phrase, 'i').test(text)) ctas.push(phrase);
    }
  }
  return ctas.slice(0, 5);
}

function guessHours(text) {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const hours = [];
  for (const line of lines) {
    if (/(mon|tue|wed|thu|fri|sat|sun|monday|hours)/i.test(line) &&
        /\d{1,2}\s*[:.]?\s*\d{0,2}\s*(am|pm)?/i.test(line) &&
        line.length < 120) {
      hours.push(line);
    }
  }
  return hours.slice(0, 8);
}

/** Normalize #rgb / #rrggbb / rgb() to #rrggbb lowercase. */
function normalizeHex(raw) {
  const s = String(raw || '').trim();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1].toLowerCase();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return `#${h}`;
  }
  const rgb = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (rgb) {
    const to = (n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
    return `#${to(rgb[1])}${to(rgb[2])}${to(rgb[3])}`;
  }
  return null;
}

function colorLuma(hex) {
  const h = normalizeHex(hex);
  if (!h) return 0;
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Pull a lightweight brand style guide from homepage HTML/CSS.
 * Used for redesign briefs — colors/fonts/logo as inspiration, not layout clone.
 */
function extractStyleGuide(html, baseUrl) {
  const src = String(html || '');
  const colors = [];
  const fonts = [];
  const fontLinks = [];
  const pushColor = (c) => {
    const hex = normalizeHex(c);
    if (!hex) return;
    if (/^#(000000|ffffff|fff|000)$/i.test(hex)) return;
    if (!colors.includes(hex) && colors.length < 12) colors.push(hex);
  };
  const pushFont = (name) => {
    let n = String(name || '').replace(/["']/g, '').trim();
    n = n.split(',')[0].trim();
    if (!n || /^(inherit|initial|sans-serif|serif|monospace|system-ui|arial|helvetica|times|georgia|verdana|cursive|fantasy|emoji|ui-)/i.test(n)) return;
    if (!fonts.some((f) => f.toLowerCase() === n.toLowerCase()) && fonts.length < 8) fonts.push(n);
  };

  const themeColor = metaContent(src, 'theme-color') || metaContent(src, 'msapplication-TileColor');
  if (themeColor) pushColor(themeColor);

  // Google / Adobe / Bunny font links
  const linkRe = /<link[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let lm;
  while ((lm = linkRe.exec(src))) {
    const href = lm[1];
    if (/fonts\.google|fonts\.bunny|use\.typekit|fonts\.cdnfonts/i.test(href)) {
      const abs = absUrl(baseUrl, href) || href;
      if (abs && !fontLinks.includes(abs) && fontLinks.length < 6) fontLinks.push(abs);
      const fam = [...href.matchAll(/family=([^&:]+)/gi)];
      for (const m of fam) pushFont(decodeURIComponent(m[1].replace(/\+/g, ' ')));
    }
  }

  // CSS blocks + inline style attributes (sample)
  const cssChunks = [];
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let sm;
  while ((sm = styleRe.exec(src)) && cssChunks.length < 8) cssChunks.push(sm[1]);
  const inlineRe = /style=["']([^"']{0,400})["']/gi;
  let im;
  while ((im = inlineRe.exec(src)) && cssChunks.length < 40) cssChunks.push(im[1]);
  const cssBlob = cssChunks.join('\n').slice(0, 120000);

  for (const m of cssBlob.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)) pushColor(`#${m[1]}`);
  for (const m of cssBlob.matchAll(/rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}/gi)) pushColor(m[0]);
  for (const m of cssBlob.matchAll(/--[a-z0-9-_]*color[a-z0-9-_]*\s*:\s*([^;]+)/gi)) pushColor(m[1].trim());
  for (const m of cssBlob.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
    m[1].split(',').forEach((part) => pushFont(part));
  }

  // Prefer vivid accents + a dark/light pair
  const ranked = [...colors].sort((a, b) => {
    const la = colorLuma(a);
    const lb = colorLuma(b);
    const sat = (hex) => {
      const h = normalizeHex(hex);
      const r = parseInt(h.slice(1, 3), 16);
      const g = parseInt(h.slice(3, 5), 16);
      const b2 = parseInt(h.slice(5, 7), 16);
      return Math.max(r, g, b2) - Math.min(r, g, b2);
    };
    return sat(b) - sat(a) || Math.abs(la - 0.45) - Math.abs(lb - 0.45);
  });
  const primary = themeColor && normalizeHex(themeColor) ? normalizeHex(themeColor) : (ranked[0] || '');
  const secondary = ranked.find((c) => c !== primary) || '';
  const background = [...colors].sort((a, b) => colorLuma(b) - colorLuma(a))[0] || '';
  const ink = [...colors].sort((a, b) => colorLuma(a) - colorLuma(b))[0] || '';

  let logo = '';
  const logoImg = src.match(/<img[^>]+(?:id|class)=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/i)
    || src.match(/<img[^>]+src=["']([^"']+)["'][^>]*(?:id|class)=["'][^"']*logo[^"']*["']/i);
  if (logoImg) logo = absUrl(baseUrl, logoImg[1]) || logoImg[1];
  if (!logo) {
    const og = metaContent(src, 'og:image');
    if (og) logo = absUrl(baseUrl, og) || og;
  }

  const mood = [];
  if (colorLuma(background || '#ffffff') > 0.75) mood.push('light');
  else if (colorLuma(ink || '#000000') < 0.25 && colorLuma(background || '#ffffff') < 0.35) mood.push('dark');
  else mood.push('mixed');
  if (fonts.length) mood.push('custom-type');
  if (ranked.some((c) => colorLuma(c) > 0.15 && colorLuma(c) < 0.85)) mood.push('brand-accent');

  const direction = [
    primary ? `Lead with brand color ${primary}` : 'Infer a strong brand accent from trade photography / logo',
    fonts[0] ? `Type cue from site: ${fonts.slice(0, 2).join(' + ')}` : 'Pick expressive non-default display type',
    'Reuse the old site’s copy and information architecture; restyle the presentation — do not invent a new service menu',
  ].join('. ');

  return {
    primary: primary || null,
    secondary: secondary || null,
    background: background || null,
    ink: ink || null,
    palette: ranked.slice(0, 8),
    fonts,
    font_links: fontLinks,
    logo: logo || null,
    theme_color: themeColor ? normalizeHex(themeColor) || themeColor : null,
    mood,
    direction,
    source: 'site-ingest',
  };
}

function analyzeQuality(html, text, url, loadTimeMs, ok) {
  const lower = (html || '').toLowerCase();
  const hasViewport = /name=["']viewport["']/.test(lower);
  const hasCta = /(call now|get a quote|book|contact us|free estimate|schedule)/i.test(text) ||
    /href=["']tel:/i.test(lower);
  const hasContactForm = /<form\b/i.test(html) && /(email|message|phone|name)/i.test(lower);
  const hasBooking = /(calendly|booksy|squareup\.com\/appointments|houselogic|setmore|booking)/i.test(lower) ||
    /\/book\b/i.test(lower);
  const outdated =
    /<table\s[^>]*width=["']\d{3,}["']/i.test(html) ||
    /<font\b/i.test(html) ||
    (!hasViewport && ok);
  return {
    reachable: ok,
    hasSsl: String(url).startsWith('https'),
    mobileFriendly: hasViewport,
    hasCta,
    hasContactForm,
    hasBooking,
    loadTimeMs,
    outdatedDesign: outdated,
    checkedAt: new Date().toISOString(),
  };
}

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    const ct = String(res.headers.get('content-type') || '');
    let html = '';
    if (res.ok && /html|text\/plain|xml|css|javascript|json/i.test(ct || 'html')) {
      const buf = await res.arrayBuffer();
      const slice = buf.byteLength > MAX_HTML ? buf.slice(0, MAX_HTML) : buf;
      html = new TextDecoder('utf-8', { fatal: false }).decode(slice);
    } else if (res.ok && !ct) {
      const buf = await res.arrayBuffer();
      const slice = buf.byteLength > MAX_HTML ? buf.slice(0, MAX_HTML) : buf;
      html = new TextDecoder('utf-8', { fatal: false }).decode(slice);
    }
    return {
      ok: res.ok,
      finalUrl: res.url || url,
      status: res.status,
      html,
      loadTimeMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      ok: false,
      finalUrl: url,
      status: 0,
      html: '',
      loadTimeMs: Date.now() - t0,
      error: String(err && err.message || err).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Slice the page into heading → body blocks for redesign reuse
 * (information architecture + copy, not visual layout).
 */
function extractSections(html, text) {
  const sections = [];
  const headingRe = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const matches = [];
  let m;
  while ((m = headingRe.exec(html))) {
    matches.push({
      index: m.index,
      end: m.index + m[0].length,
      level: Number(m[1]),
      heading: stripToText(m[2]).slice(0, 160),
    });
  }
  if (!matches.length) {
    const paras = String(text || '').split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 40);
    if (paras[0]) {
      sections.push({
        id: 'intro',
        heading: paras[0].slice(0, 80),
        body: paras.slice(0, 3).join('\n\n').slice(0, 1200),
      });
    }
    return sections;
  }
  for (let i = 0; i < matches.length && sections.length < 28; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    const chunkHtml = html.slice(cur.end, next ? next.index : cur.end + 6000);
    let body = stripToText(chunkHtml).slice(0, 1400);
    if (!body || body.length < 20) {
      // Fallback: nearby lines from full text
      const idx = String(text || '').toLowerCase().indexOf(cur.heading.toLowerCase().slice(0, 40));
      if (idx >= 0) body = String(text).slice(idx + cur.heading.length, idx + cur.heading.length + 900).trim();
    }
    if (!cur.heading) continue;
    sections.push({
      id: `h${cur.level}-${sections.length}`,
      heading: cur.heading,
      body,
      level: cur.level,
    });
  }
  return sections;
}

/** Pull FAQ Q&A from heading blocks even when they sit below long service lists. */
function extractFaq(html) {
  const faq = [];
  const headingRe = /<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const matches = [];
  let m;
  while ((m = headingRe.exec(html))) {
    matches.push({
      index: m.index,
      end: m.index + m[0].length,
      heading: stripToText(m[2]).slice(0, 200),
    });
  }
  for (let i = 0; i < matches.length && faq.length < 12; i++) {
    const cur = matches[i];
    const h = cur.heading || '';
    if (!(/^(why |how |what |when |do |is |are |can )/i.test(h) || /\?$/.test(h))) continue;
    const next = matches[i + 1];
    const body = stripToText(html.slice(cur.end, next ? next.index : cur.end + 5000)).slice(0, 1200);
    if (body.length < 40) continue;
    faq.push({ question: h, answer: body });
  }
  return faq;
}

function navLabels(html) {
  const labels = [];
  const re = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && labels.length < 20) {
    const t = stripToText(m[1]).slice(0, 40);
    if (!t || t.length < 2 || t.length > 28) continue;
    if (/^(home|about|services|contact|blog|gallery|faq|book|call|login|sign)/i.test(t)
      || /plumbing|drain|sewer|repair|emergency|estimate/i.test(t)) {
      if (!labels.some((x) => x.toLowerCase() === t.toLowerCase())) labels.push(t);
    }
  }
  return labels.slice(0, 12);
}

function parsePage(html, url, role) {
  const text = stripToText(html);
  const title = pageTitle(html);
  const metaDescription = metaContent(html, 'description') || metaContent(html, 'og:description');
  const headings = extractHeadings(html);
  const services = guessServices(html, text, headings);
  const about = guessAbout(html, text, metaDescription);
  const phones = extractPhones(text);
  const emails = extractEmails(text);
  const images = extractImages(html, url);
  const ctas = extractCtas(html, text);
  const hours = guessHours(text);
  const links = extractLinks(html, url);
  const sections = extractSections(html, text);
  const faq = extractFaq(html);
  const nav = navLabels(html);
  return {
    url,
    role,
    title,
    metaDescription,
    about,
    services,
    phones,
    emails,
    images,
    ctas,
    hours,
    headings: headings.slice(0, 20).map((h) => h.text),
    sections,
    faq,
    nav,
    textPreview: text.slice(0, 2500),
    links,
  };
}

function mergeExtracted(pages) {
  const phones = [];
  const emails = [];
  const services = [];
  const images = [];
  const ctas = [];
  const hours = [];
  let about = '';
  let title = '';
  let metaDescription = '';

  const pushUnique = (arr, v, max) => {
    const s = String(v || '').trim();
    if (!s) return;
    if (arr.some((x) => String(x).toLowerCase() === s.toLowerCase())) return;
    if (arr.length < max) arr.push(s);
  };
  const pushImage = (img) => {
    const url = typeof img === 'string' ? img : (img && img.url);
    if (!url) return;
    if (images.some((x) => x.url === url)) return;
    if (images.length < 14) {
      images.push({
        url,
        role: (img && img.role) || 'gallery',
      });
    }
  };

  for (const p of pages) {
    if (!title && p.title) title = p.title;
    if (!metaDescription && p.metaDescription) metaDescription = p.metaDescription;
    if (!about && p.about) about = p.about;
    else if (p.role === 'about' && p.about && p.about.length > about.length) about = p.about;
    for (const x of p.phones || []) pushUnique(phones, x, 5);
    for (const x of p.emails || []) pushUnique(emails, x, 5);
    for (const x of p.services || []) pushUnique(services, x, 24);
    for (const x of p.images || []) pushImage(x);
    for (const x of p.ctas || []) pushUnique(ctas, x, 5);
    for (const x of p.hours || []) pushUnique(hours, x, 8);
  }

  const structure = [];
  const nav = [];
  for (const p of pages) {
    for (const n of p.nav || []) {
      if (!nav.some((x) => x.toLowerCase() === n.toLowerCase()) && nav.length < 14) nav.push(n);
    }
    structure.push({
      role: p.role,
      slug: p.slug || p.role,
      title: p.serviceTitle || p.title,
      url: p.url,
      nav: p.nav || [],
      headings: p.headings || [],
      sections: (p.sections || []).slice(0, 12),
      textPreview: p.textPreview,
      areas: p.areas || undefined,
      serviceTitle: p.serviceTitle || undefined,
    });
  }

  return {
    title,
    metaDescription,
    about,
    phones,
    emails,
    services,
    images,
    ctas,
    hours,
    nav,
    structure,
    pages: pages.map((p) => ({
      url: p.url,
      role: p.role,
      slug: p.slug || p.role,
      title: p.serviceTitle || p.title,
      textPreview: p.textPreview,
      headings: p.headings,
      sections: p.sections,
      nav: p.nav,
      areas: p.areas,
    })),
  };
}

/**
 * Ingest a business website. Returns quality check + merged extraction + snapshot.
 * @param {string} url
 * @returns {Promise<{ check: object, extracted: object, snapshot: object, pageCount: number, error?: string }>}
 */
/** Fetch a few linked stylesheets so SPA builders still yield a palette. */
async function enrichStyleFromSheets(html, baseUrl, styleGuide) {
  if (!styleGuide || !html) return styleGuide;
  const hrefs = [];
  const re = /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi;
  const re2 = /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']stylesheet["']/gi;
  let m;
  while ((m = re.exec(html)) && hrefs.length < 3) {
    const u = absUrl(baseUrl, m[1]);
    if (u && !hrefs.includes(u)) hrefs.push(u);
  }
  while ((m = re2.exec(html)) && hrefs.length < 3) {
    const u = absUrl(baseUrl, m[1]);
    if (u && !hrefs.includes(u)) hrefs.push(u);
  }
  let css = '';
  for (const href of hrefs) {
    try {
      const got = await fetchHtml(href);
      if (got.html || got.ok) css += `\n${String(got.html || '').slice(0, 80000)}`;
    } catch { /* ignore */ }
  }
  if (!css.trim()) return styleGuide;
  // Re-run color extraction against stylesheet text via a fake HTML wrapper.
  const enriched = extractStyleGuide(`<style>${css.slice(0, 100000)}</style>${html.slice(0, 20000)}`, baseUrl);
  return {
    ...styleGuide,
    primary: styleGuide.primary || enriched.primary,
    secondary: styleGuide.secondary || enriched.secondary,
    background: styleGuide.background || enriched.background,
    ink: styleGuide.ink || enriched.ink,
    palette: (styleGuide.palette && styleGuide.palette.length) ? styleGuide.palette : enriched.palette,
    fonts: (styleGuide.fonts && styleGuide.fonts.length) ? styleGuide.fonts : enriched.fonts,
    font_links: [...new Set([...(styleGuide.font_links || []), ...(enriched.font_links || [])])].slice(0, 6),
    direction: enriched.direction || styleGuide.direction,
  };
}

async function ingestSite(url) {
  const start = String(url || '').trim();
  if (!start) {
    return {
      check: {
        reachable: false, hasSsl: false, mobileFriendly: false, hasCta: false,
        hasContactForm: false, hasBooking: false, loadTimeMs: 0,
        outdatedDesign: false, checkedAt: new Date().toISOString(),
      },
      extracted: mergeExtracted([]),
      snapshot: { url: '', pages: [], note: 'no url' },
      pageCount: 0,
      error: 'no url',
    };
  }

  let homeUrl = start;
  try {
    const u = new URL(start.includes('://') ? start : `https://${start}`);
    homeUrl = u.toString();
  } catch {
    return {
      check: {
        reachable: false, hasSsl: false, mobileFriendly: false, hasCta: false,
        hasContactForm: false, hasBooking: false, loadTimeMs: 0,
        outdatedDesign: false, checkedAt: new Date().toISOString(),
      },
      extracted: mergeExtracted([]),
      snapshot: { url: start, pages: [], note: 'invalid url' },
      pageCount: 0,
      error: 'invalid url',
    };
  }

  const home = await fetchHtml(homeUrl);
  const pages = [];
  if (home.html) {
    pages.push(parsePage(home.html, home.finalUrl || homeUrl, 'home'));
  }

  let crawlPlan = null;
  if (home.ok && home.html) {
    const origin = (() => {
      try { return new URL(home.finalUrl || homeUrl).origin; } catch { return homeUrl; }
    })();
    const sitemapUrls = await fetchSitemapUrls(origin);
    const linkUrls = (pages[0] && pages[0].links ? pages[0].links : []).map((l) => l.href);
    crawlPlan = buildCrawlPlan(home.finalUrl || homeUrl, linkUrls, sitemapUrls);

    for (const rel of crawlPlan.fetchList) {
      if (pages.length >= MAX_PAGES) break;
      const got = await fetchHtml(rel.url);
      if (!got.html) continue;
      const parsed = parsePage(got.html, got.finalUrl || rel.url, rel.role);
      if (rel.slug) parsed.slug = rel.slug;
      if (rel.title) parsed.serviceTitle = rel.title;
      if (rel.areas) parsed.areas = rel.areas;
      // Prefer meta/H1 body on service pages as about-for-service
      if (rel.role === 'service' && parsed.metaDescription) {
        parsed.sections = [
          {
            id: 'service-intro',
            heading: rel.title || parsed.title,
            body: parsed.metaDescription,
            level: 1,
          },
          ...(parsed.sections || []).slice(0, 10),
        ];
      }
      pages.push(parsed);
    }
  }

  const extracted = mergeExtracted(pages);
  let styleGuide = home.html
    ? extractStyleGuide(home.html, home.finalUrl || homeUrl)
    : null;
  if (styleGuide && home.html) {
    styleGuide = await enrichStyleFromSheets(home.html, home.finalUrl || homeUrl, styleGuide);
  }
  extracted.style_guide = styleGuide;

  // Merge sitemap service titles into services list (deduped).
  if (crawlPlan && crawlPlan.services.length) {
    for (const s of crawlPlan.services) {
      if (!extracted.services.some((x) => String(x).toLowerCase() === s.title.toLowerCase())) {
        if (extracted.services.length < 24) extracted.services.push(s.title);
      }
    }
  }

  const faq = mergeFaq(
    ...pages.map((p) => p.faq || []),
    ...pages.map((p) => faqFromSections(p.sections)),
  );

  const siteMap = {
    origin: crawlPlan ? crawlPlan.origin : (() => { try { return new URL(homeUrl).origin; } catch { return homeUrl; } })(),
    sitemap_count: crawlPlan ? crawlPlan.sitemap_count : 0,
    discovered_count: crawlPlan ? crawlPlan.discovered_count : pages.length,
    prefer_area: crawlPlan ? crawlPlan.prefer_area : '',
    areas: crawlPlan ? crawlPlan.areas : [],
    services: crawlPlan ? crawlPlan.services : [],
    cores: crawlPlan ? crawlPlan.cores : [],
    faq,
    recommended_pages: [
      { slug: 'home', role: 'home', title: 'Home' },
      { slug: 'services', role: 'services', title: 'Services' },
      ...(crawlPlan ? crawlPlan.services.map((s) => ({
        slug: s.slug,
        role: 'service',
        title: s.title,
        source_url: s.url,
      })) : []),
      ...(crawlPlan && crawlPlan.areas.length ? [{ slug: 'areas', role: 'locations', title: 'Service Areas', areas: crawlPlan.areas }] : []),
      ...(faq.length ? [{ slug: 'faq', role: 'faq', title: 'FAQ' }] : []),
      { slug: 'about', role: 'about', title: 'About' },
      { slug: 'contact', role: 'contact', title: 'Contact' },
    ],
    fetched_pages: pages.map((p) => ({
      role: p.role,
      slug: p.slug || p.role,
      title: p.serviceTitle || p.title,
      url: p.url,
    })),
  };
  extracted.site_map = siteMap;
  extracted.faq = faq;

  const check = analyzeQuality(
    home.html || '',
    pages[0] ? pages[0].textPreview : '',
    home.finalUrl || homeUrl,
    home.loadTimeMs,
    home.ok
  );

  const snapshot = {
    url: home.finalUrl || homeUrl,
    ingested_at: new Date().toISOString(),
    title: extracted.title,
    metaDescription: extracted.metaDescription,
    about: extracted.about,
    services: extracted.services,
    phones: extracted.phones,
    emails: extracted.emails,
    hours: extracted.hours,
    ctas: extracted.ctas,
    images: (extracted.images || []).map((img) => (typeof img === 'string' ? img : img.url)).filter(Boolean),
    image_assets: extracted.images || [],
    style_guide: styleGuide,
    nav: extracted.nav || [],
    site_map: siteMap,
    faq,
    structure: (extracted.structure || []).map((p) => ({
      role: p.role,
      slug: p.slug || p.role,
      title: p.serviceTitle || p.title,
      url: p.url,
      headings: (p.headings || []).slice(0, 10),
      sections: (p.sections || []).slice(0, 10).map((s) => ({
        heading: s.heading,
        body: String(s.body || '').slice(0, 900),
      })),
      textPreview: String(p.textPreview || '').slice(0, 900),
      areas: p.areas || undefined,
    })),
    pages: extracted.pages.map((p) => ({
      url: p.url,
      role: p.role,
      slug: p.slug || p.role,
      title: p.serviceTitle || p.title,
      headings: (p.headings || []).slice(0, 8),
      textPreview: String(p.textPreview || '').slice(0, 600),
    })),
  };

  // Keep JSON compact for fact storage. Prefer dropping bulky structure from the
  // snapshot (it is also stored as site.structure) rather than mid-string slicing.
  let snapJson = JSON.stringify(snapshot);
  if (snapJson.length > MAX_SNAPSHOT) {
    snapshot.structure = (snapshot.structure || []).map((p) => ({
      role: p.role,
      slug: p.slug,
      title: p.title,
      url: p.url,
      headings: (p.headings || []).slice(0, 6),
    }));
    snapshot.pages = (snapshot.pages || []).map((p) => ({
      url: p.url, role: p.role, slug: p.slug, title: p.title,
      headings: (p.headings || []).slice(0, 4),
    }));
    snapshot.about = String(snapshot.about || '').slice(0, 1200);
    snapJson = JSON.stringify(snapshot);
  }
  if (snapJson.length > 80000) {
    delete snapshot.structure;
    snapshot.faq = (snapshot.faq || []).slice(0, 6);
    snapJson = JSON.stringify(snapshot);
  }

  return {
    check,
    extracted,
    snapshot,
    snapshotJson: snapJson,
    pageCount: pages.length,
    siteMap,
    error: home.ok ? undefined : (home.error || `HTTP ${home.status}`),
  };
}

/**
 * Turn ingest result into fact rows for business_facts.
 * Clear on-page contact / about / services → VERIFIED; thin heuristics → UNKNOWN.
 */
function factsFromIngest(ingest) {
  const facts = [];
  if (!ingest) return facts;
  const ex = ingest.extracted || {};
  const homeUrl = (ingest.snapshot && ingest.snapshot.url) || null;
  const pageUrl = (role) => {
    const p = (ex.pages || []).find((x) => x.role === role);
    return (p && p.url) || homeUrl;
  };

  const add = (fact_key, value, opts = {}) => {
    if (value === null || value === undefined || String(value).trim() === '') return;
    // Large JSON blobs (structure / snapshot) need headroom so parse stays valid.
    const max = opts.maxLen || (/^site\.(structure|snapshot|style_guide|map)$/.test(fact_key) ? 80000 : 5000);
    facts.push({
      fact_key,
      value: String(value).slice(0, max),
      source: 'site-ingest',
      source_url: opts.source_url || homeUrl,
      confidence: opts.confidence || 'medium',
      claim_class: opts.claim_class || 'VERIFIED',
    });
  };

  if (ingest.check) {
    const c = ingest.check;
    add('website.reachable', String(c.reachable), { claim_class: 'VERIFIED', confidence: 'high' });
    add('website.has_ssl', String(c.hasSsl), { claim_class: 'VERIFIED', confidence: 'high' });
    add('website.mobile_friendly', String(c.mobileFriendly));
    add('website.has_cta', String(c.hasCta));
    add('website.has_contact_form', String(c.hasContactForm));
    add('website.has_booking', String(c.hasBooking));
    add('website.load_time_ms', String(c.loadTimeMs), { claim_class: 'VERIFIED', confidence: 'high' });
    add('website.outdated_design', String(c.outdatedDesign), { claim_class: 'UNKNOWN', confidence: 'low' });
    add('website.checked_at', c.checkedAt, { claim_class: 'VERIFIED', confidence: 'high' });
  }

  add('site.ingested_at', ingest.snapshot && ingest.snapshot.ingested_at, { confidence: 'high' });
  add('site.title', ex.title);
  add('site.meta_description', ex.metaDescription);
  add('site.about', ex.about, { source_url: pageUrl('about'), confidence: ex.about && ex.about.length > 80 ? 'medium' : 'low' });
  if (Array.isArray(ex.ctas) && ex.ctas.length) add('site.ctas', JSON.stringify(ex.ctas));
  if (Array.isArray(ex.hours) && ex.hours.length) {
    add('hours', JSON.stringify(ex.hours), { source_url: pageUrl('hours') || pageUrl('contact') });
  }
  (ex.phones || []).forEach((p, i) => add(i === 0 ? 'phone' : `phone:${i}`, p, { confidence: 'high' }));
  (ex.emails || []).forEach((e, i) => add(i === 0 ? 'email' : `email:${i}`, e, { confidence: 'high' }));
  (ex.services || []).forEach((sv, i) => {
    add(`service:${i}`, sv, {
      source_url: pageUrl('services') || homeUrl,
      claim_class: 'VERIFIED',
      confidence: 'medium',
    });
  });
  (ex.images || []).forEach((img, i) => {
    const url = typeof img === 'string' ? img : img.url;
    const role = (img && img.role) || 'gallery';
    add(`site.image:${i}`, url, { confidence: 'medium' });
    add(`site.image:${i}.role`, role, { confidence: 'low', claim_class: 'UNKNOWN' });
  });
  (ex.pages || []).forEach((p) => {
    if (!p.role || p.role === 'home') return;
    const key = p.slug && p.slug !== p.role ? `site.page:${p.role}:${p.slug}` : `site.page:${p.role}`;
    add(key, p.url, { source_url: p.url, confidence: 'high' });
  });
  if (ingest.snapshotJson) {
    add('site.snapshot', ingest.snapshotJson, { confidence: 'medium' });
  }
  const siteMap = ex.site_map || ingest.siteMap || (ingest.snapshot && ingest.snapshot.site_map);
  if (siteMap) {
    // Compact map for agents: recommended pages + services + areas + FAQ.
    const compactMap = {
      origin: siteMap.origin,
      sitemap_count: siteMap.sitemap_count,
      discovered_count: siteMap.discovered_count,
      prefer_area: siteMap.prefer_area,
      areas: siteMap.areas || [],
      services: (siteMap.services || []).map((s) => ({
        slug: s.slug, title: s.title, url: s.url, areas: s.areas,
      })),
      recommended_pages: siteMap.recommended_pages || [],
      faq: (siteMap.faq || ex.faq || []).slice(0, 12),
      fetched_pages: siteMap.fetched_pages || [],
    };
    add('site.map', JSON.stringify(compactMap), { confidence: 'medium', maxLen: 80000 });
  }
  if (Array.isArray(ex.faq) && ex.faq.length) {
    add('site.faq', JSON.stringify(ex.faq.slice(0, 12)), { confidence: 'medium', maxLen: 40000 });
  }
  if (ex.structure && ex.structure.length) {
    // Prefer compact IA (roles + headings + short bodies) so JSON never truncates mid-string.
    const compact = ex.structure.map((p) => ({
      role: p.role,
      slug: p.slug || p.role,
      title: p.title,
      url: p.url,
      nav: (p.nav || []).slice(0, 12),
      headings: (p.headings || []).slice(0, 12),
      sections: (p.sections || []).slice(0, 10).map((s) => ({
        heading: s.heading,
        body: String(s.body || '').slice(0, 600),
      })),
      areas: p.areas,
    }));
    add('site.structure', JSON.stringify(compact), { confidence: 'medium', maxLen: 80000 });
  }
  if (ex.nav && ex.nav.length) {
    add('site.nav', JSON.stringify(ex.nav), { confidence: 'medium' });
  }
  // Persist reusable copy blocks across the full fetched IA.
  let copyIdx = 0;
  for (const page of ex.structure || []) {
    for (const sec of page.sections || []) {
      if (!sec.heading && !sec.body) continue;
      if (copyIdx >= 48) break;
      add(`site.copy:${copyIdx}`, JSON.stringify({
        page: page.slug || page.role,
        role: page.role,
        heading: sec.heading,
        body: String(sec.body || '').slice(0, 1500),
      }), { source_url: page.url, confidence: 'medium' });
      copyIdx++;
    }
    if (copyIdx >= 48) break;
  }
  const guide = (ingest.extracted && ingest.extracted.style_guide)
    || (ingest.snapshot && ingest.snapshot.style_guide);
  if (guide && (guide.primary || (guide.palette && guide.palette.length) || (guide.fonts && guide.fonts.length))) {
    add('site.style_guide', JSON.stringify(guide), { confidence: 'medium' });
    if (guide.primary) add('site.brand.primary', guide.primary, { confidence: 'medium' });
    if (guide.secondary) add('site.brand.secondary', guide.secondary, { confidence: 'low' });
    if (guide.fonts && guide.fonts[0]) add('site.brand.font', guide.fonts[0], { confidence: 'medium' });
    if (guide.logo) add('site.brand.logo', guide.logo, { confidence: 'medium' });
  }

  return facts;
}

module.exports = {
  ingestSite,
  factsFromIngest,
  extractStyleGuide,
  buildCrawlPlan,
  classifyPath,
  fetchSitemapUrls,
  extractFaq,
  // exported for tests
  stripToText,
  extractPhones,
  extractEmails,
  guessServices,
  analyzeQuality,
};
