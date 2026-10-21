'use strict';

/**
 * Menu (pages[]) and section reorder helpers for portal + staff UI + MCP.
 * WordPress-style: pages may set menuParent (parent page slug) for one-level submenus.
 * Banner/hero/nav section types stay pinned; other sections can move past each other.
 */

const engine = require('./websiteEngine');

const PINNED_SECTION_TYPES = new Set(['nav', 'hero', 'banner']);
const MAX_MENU_DEPTH = 1;
const MAX_BLOCK_COLS = 12;

/** Column count for layout blocks (1–12). */
function clampBlockCols(n, fallback = 2) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(1, Math.min(MAX_BLOCK_COLS, v));
}

function isPinnedSection(section) {
  if (!section || typeof section !== 'object') return true;
  return PINNED_SECTION_TYPES.has(String(section.type || '').toLowerCase());
}

function isNavSection(section) {
  return !!(section && String(section.type || '').toLowerCase() === 'nav');
}

/**
 * Nav is always the first section on a page (sticky top chrome).
 * Extra nav sections are dropped; missing nav is left as-is (caller may require it).
 */
function ensureNavFirstSections(sections) {
  const list = Array.isArray(sections) ? sections.slice() : [];
  if (!list.length) return list;
  const navs = list.filter(isNavSection);
  const rest = list.filter((s) => !isNavSection(s));
  if (!navs.length) return list;
  return [navs[0], ...rest];
}

function ensureNavFirstPage(page) {
  if (!page || typeof page !== 'object') return page;
  if (!Array.isArray(page.sections) || !page.sections.length) return page;
  const next = ensureNavFirstSections(page.sections);
  if (next === page.sections || (
    next.length === page.sections.length
    && next.every((s, i) => s === page.sections[i])
  )) return page;
  return Object.assign({}, page, { sections: next });
}

function ensureNavFirstPages(pages) {
  if (!Array.isArray(pages)) return pages;
  return pages.map(ensureNavFirstPage);
}

function isHomeLike(page, pages) {
  try {
    return engine.isHomePage(page, pages);
  } catch {
    const slug = String((page && page.slug) || '').toLowerCase().replace(/\.html$/i, '');
    return slug === '' || slug === 'home' || slug === 'index';
  }
}

function slugKey(slug) {
  return String(slug == null ? '' : slug).trim().toLowerCase().replace(/\.html$/i, '').replace(/\/+$/, '') || '';
}

function pageSlugKey(page) {
  return slugKey(page && page.slug);
}

function menuParentKey(page) {
  if (!page || typeof page !== 'object') return '';
  return slugKey(page.menuParent != null ? page.menuParent : page.menu_parent);
}

/** Default true — set page.navVisible = false to omit from site nav (page may still exist). */
function isNavVisible(page) {
  if (!page || typeof page !== 'object') return true;
  if (page.navVisible === false || page.nav_visible === false) return false;
  if (page.hiddenInNav === true || page.hidden_in_nav === true) return false;
  return true;
}

function setNavVisible(page, visible) {
  const next = Object.assign({}, page);
  if (visible) {
    delete next.navVisible;
    delete next.nav_visible;
    delete next.hiddenInNav;
    delete next.hidden_in_nav;
  } else {
    next.navVisible = false;
    delete next.nav_visible;
    delete next.hiddenInNav;
    delete next.hidden_in_nav;
  }
  return next;
}

function setMenuParent(page, parentSlug) {
  const next = Object.assign({}, page);
  const key = slugKey(parentSlug);
  if (!key) {
    delete next.menuParent;
    delete next.menu_parent;
  } else {
    next.menuParent = parentSlug;
    delete next.menu_parent;
  }
  return next;
}

function clonePages(pages) {
  return Array.isArray(pages) ? JSON.parse(JSON.stringify(pages)) : [];
}

/**
 * Resolve a stable parent key → page index map. Invalid/cyclic parents are treated as top-level.
 */
function resolveMenuParents(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const bySlug = new Map();
  list.forEach((p, i) => {
    const k = pageSlugKey(p);
    if (k && !bySlug.has(k)) bySlug.set(k, i);
  });
  const parentOf = list.map((p, i) => {
    if (isHomeLike(p, list)) return '';
    let parent = menuParentKey(p);
    if (!parent || !bySlug.has(parent)) return '';
    if (bySlug.get(parent) === i) return '';
    // One level only: if parent is itself a child, promote to grandparent's parent (top).
    const parentPage = list[bySlug.get(parent)];
    const grand = menuParentKey(parentPage);
    if (grand && bySlug.has(grand)) {
      // Collapse deep nests to depth 1 under the top-most ancestor.
      let top = parent;
      let guard = 0;
      while (guard++ < 8) {
        const pi = bySlug.get(top);
        if (pi == null) break;
        const gp = menuParentKey(list[pi]);
        if (!gp || !bySlug.has(gp) || gp === top) break;
        top = gp;
      }
      parent = top;
    }
    return parent;
  });
  return { bySlug, parentOf };
}

/** Visual WordPress-style menu list (DFS, max depth 1). */
function menuVisualList(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const { parentOf } = resolveMenuParents(list);
  const childrenOf = new Map();
  const tops = [];
  list.forEach((p, i) => {
    const parent = parentOf[i];
    if (!parent) {
      tops.push(i);
      return;
    }
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(i);
  });
  // Keep home first among tops when present.
  tops.sort((a, b) => {
    const ah = isHomeLike(list[a], list) ? 0 : 1;
    const bh = isHomeLike(list[b], list) ? 0 : 1;
    if (ah !== bh) return ah - bh;
    return a - b;
  });

  const out = [];
  tops.forEach((ti) => {
    const kids = childrenOf.get(pageSlugKey(list[ti])) || [];
    out.push({
      index: ti,
      depth: 0,
      slug: list[ti].slug,
      title: list[ti].title || list[ti].slug || `Page ${ti + 1}`,
      file: engine.pageFileName(list[ti].slug),
      pinned: isHomeLike(list[ti], list),
      parentSlug: null,
      childCount: kids.length,
      sectionCount: Array.isArray(list[ti].sections) ? list[ti].sections.length : 0,
      freeform: typeof list[ti].html === 'string' && !!list[ti].html.trim()
        && !(Array.isArray(list[ti].sections) && list[ti].sections.length),
      navVisible: isNavVisible(list[ti]),
    });
    kids.forEach((ci) => {
      out.push({
        index: ci,
        depth: 1,
        slug: list[ci].slug,
        title: list[ci].title || list[ci].slug || `Page ${ci + 1}`,
        file: engine.pageFileName(list[ci].slug),
        pinned: false,
        parentSlug: list[ti].slug,
        childCount: 0,
        sectionCount: Array.isArray(list[ci].sections) ? list[ci].sections.length : 0,
        freeform: typeof list[ci].html === 'string' && !!list[ci].html.trim()
          && !(Array.isArray(list[ci].sections) && list[ci].sections.length),
        navVisible: isNavVisible(list[ci]),
      });
    });
  });
  // Orphans already included as tops when parent invalid.
  return out;
}

function summarizeStructure(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const menu = menuVisualList(list).map((item, visualIndex, arr) => {
    const prev = visualIndex > 0 ? arr[visualIndex - 1] : null;
    const next = visualIndex < arr.length - 1 ? arr[visualIndex + 1] : null;
    const canUp = !item.pinned && !!prev && prev.depth === item.depth
      && String(prev.parentSlug || '') === String(item.parentSlug || '');
    const canDown = !item.pinned && !!next && next.depth === item.depth
      && String(next.parentSlug || '') === String(item.parentSlug || '');
    // Nest under previous top-level item (or previous item's parent chain).
    let canNest = false;
    if (!item.pinned && item.depth < MAX_MENU_DEPTH && visualIndex > 0) {
      const candidate = arr[visualIndex - 1];
      if (candidate.depth === 0 && !candidate.pinned) canNest = true;
      else if (candidate.depth === 1 && candidate.parentSlug) canNest = item.depth === 0;
    }
    const canUnnest = !item.pinned && item.depth > 0;
    return Object.assign({}, item, { visualIndex, canUp, canDown, canNest, canUnnest });
  });
  return {
    menu,
    pages: list.map((p, i) => ({
      index: i,
      slug: p.slug,
      title: p.title || p.slug || `Page ${i + 1}`,
      menuParent: menuParentKey(p) || null,
      navVisible: isNavVisible(p),
      sections: Array.isArray(p.sections)
        ? p.sections.map((s, si) => ({
          index: si,
          type: s.type || 'block',
          pinned: isPinnedSection(s),
          label: sectionLabel(s, si),
        }))
        : [],
    })),
  };
}

function sectionLabel(section, index) {
  const t = String((section && section.type) || 'block');
  const c = (section && section.content) || {};
  if (t === 'site_module') {
    const mt = String(c.module_type || c.moduleType || 'module');
    const label = c.title || mt;
    return `Module: ${String(label).slice(0, 48)}`;
  }
  const title = c.title || c.heading || c.label || '';
  if (title) return `${t}: ${String(title).slice(0, 48)}`;
  return `${t} #${index + 1}`;
}

function titleToPageSlug(title) {
  const s = String(title || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const base = s || 'page';
  return base.startsWith('/') ? base : `/${base}`;
}

function ensureUniquePageSlug(pages, slug) {
  let candidate = String(slug || '/page').trim();
  if (!candidate.startsWith('/')) candidate = `/${candidate.replace(/^\//, '')}`;
  const used = new Set((pages || []).map((p) => pageSlugKey(p)).filter(Boolean));
  if (!used.has(pageSlugKey({ slug: candidate }))) return candidate;
  const stem = candidate.replace(/^\//, '').replace(/\/$/, '') || 'page';
  for (let n = 2; n < 200; n += 1) {
    const next = `/${stem}-${n}`;
    if (!used.has(pageSlugKey({ slug: next }))) return next;
  }
  return `/${stem}-${Date.now()}`;
}

function defaultSectionContent(type, opts = {}) {
  const t = String(type || 'custom').toLowerCase();
  switch (t) {
    case 'hero':
      return { headline: 'Headline', subheadline: 'Add a short supporting line.', cta_text: 'Contact Us', cta_href: '#contact' };
    case 'benefits':
      return { title: 'Why Choose Us', items: [{ title: 'Benefit one', text: 'Short description.' }] };
    case 'services':
      return { title: 'Our Services', items: [{ name: 'Service name', description: 'Short description.' }] };
    case 'about':
      return { title: 'About Us', paragraphs: ['About paragraph.'] };
    case 'gallery':
      return { title: 'Gallery' };
    case 'reviews':
      return { title: 'Customer Reviews', reviews: [{ name: 'Customer', text: 'Great experience.', stars: 5 }] };
    case 'cta':
      return { title: 'Get in touch today', text: '', button_text: 'Contact Us', button_href: '#contact' };
    case 'faq':
      return { title: 'FAQ', items: [{ q: 'Question?', a: 'Answer.' }] };
    case 'columns': {
      const cols = clampBlockCols(opts.cols, 2);
      return {
        title: '',
        cols,
        cells: Array.from({ length: cols }, (_, i) => ({
          heading: `Column ${i + 1}`,
          body: 'Add your content.',
        })),
      };
    }
    case 'heading':
      return { heading: 'Heading', level: 2 };
    case 'image':
      return { image: null, caption: '' };
    case 'text':
      return { heading: 'Section heading', body: 'Add your content here.' };
    case 'text_image':
      return {
        heading: 'Section heading',
        body: 'Add your content here.',
        image_position: 'right',
        image: null,
      };
    case 'cards': {
      const cols = clampBlockCols(opts.cols, 3);
      const items = [];
      for (let i = 0; i < cols; i++) {
        items.push({ title: `Card ${i + 1}`, text: 'Short description.' });
      }
      return { title: 'Cards', cols, items };
    }
    case 'section':
      return {
        html: '<section class="ws-page-section" data-ws-page-section="1">'
          + '<p>Empty section — use Add block.</p></section>',
      };
    case 'html':
      return { html: '<p>Custom HTML block</p>' };
    case 'custom':
    default:
      return { heading: 'New section', body: 'Add your content here.' };
  }
}

/**
 * Insert a content section (custom/services/…) after afterIndex. afterIndex -1 inserts at 0.
 * Skips pinning past footer when present.
 */
function insertContentSection(pages, pageIndex, afterIndex, sectionType, opts = {}) {
  const list = clonePages(pages);
  const pi = Number(pageIndex);
  if (!Number.isInteger(pi) || pi < 0 || pi >= list.length) {
    return { pages: list, changed: false };
  }
  const page = list[pi];
  if (!page || !Array.isArray(page.sections) || !page.sections.length) {
    return { pages: list, changed: false, reason: 'no_sections' };
  }
  let type = String(sectionType || 'custom').toLowerCase() || 'custom';
  // Empty page section container (Page → Section → Block model).
  if (type === 'section' || type === 'page_section' || type === 'page-section') {
    type = 'html';
    opts = Object.assign({}, opts, {
      html: opts.html || (
        '<section class="ws-page-section" data-ws-page-section="1">'
        + '<p>Empty section — use Add block.</p></section>'
      ),
    });
  }
  if (PINNED_SECTION_TYPES.has(type) || type === 'footer' || type === 'nav') {
    return { pages: list, changed: false, reason: 'pinned_type' };
  }
  page.sections = ensureNavFirstSections(page.sections);
  // Never insert above nav — afterIndex -1 lands right after nav when present.
  let insertAt = Math.max(0, Math.min(Number(afterIndex) + 1, page.sections.length));
  if (page.sections[0] && isNavSection(page.sections[0]) && insertAt < 1) insertAt = 1;
  const footerAt = page.sections.findIndex((s) => s && s.type === 'footer');
  let at = insertAt;
  if (footerAt >= 0 && at > footerAt) at = footerAt;
  let content = opts.content && typeof opts.content === 'object'
    ? Object.assign({}, opts.content)
    : defaultSectionContent(type, opts);
  if (opts.html != null && type === 'html') content.html = String(opts.html);
  page.sections.splice(at, 0, { type, content });
  page.sections = ensureNavFirstSections(page.sections);
  // Drop legacy freeform so modular sections become the source of truth.
  if (typeof page.html === 'string') delete page.html;
  list[pi] = page;
  return { pages: list, changed: true, sectionIndex: at };
}

/**
 * Insert a content/layout/widget block into (or after) a section.
 * Nesting: Page → Section → Block; optional cellIndex for columns cells.
 * For modular typed sections, inserts a sibling section (the block) after sectionIndex.
 * For html/custom freestyle bodies, appends block markup inside the section HTML when possible.
 */
function insertBlockIntoSection(pages, pageIndex, sectionIndex, blockType, opts = {}) {
  const list = clonePages(pages);
  const pi = Number(pageIndex);
  const si = Number(sectionIndex);
  if (!Number.isInteger(pi) || pi < 0 || pi >= list.length) {
    return { pages: list, changed: false, reason: 'bad_page' };
  }
  const page = list[pi];
  if (!page || !Array.isArray(page.sections) || !page.sections.length) {
    return { pages: list, changed: false, reason: 'no_sections' };
  }
  if (!Number.isInteger(si) || si < 0 || si >= page.sections.length) {
    return { pages: list, changed: false, reason: 'bad_section' };
  }
  const type = String(blockType || opts.type || '').trim().toLowerCase();
  if (!type) return { pages: list, changed: false, reason: 'block_type_required' };
  if (PINNED_SECTION_TYPES.has(type) || type === 'footer' || type === 'nav' || type === 'section') {
    return { pages: list, changed: false, reason: 'invalid_block' };
  }

  const host = page.sections[si];
  const cellIndex = opts.cellIndex != null ? Number(opts.cellIndex) : null;
  const content = opts.content && typeof opts.content === 'object'
    ? opts.content
    : defaultSectionContent(type, opts);

  // Inject into a columns cell when requested.
  if (Number.isInteger(cellIndex) && cellIndex >= 0 && host && host.type === 'columns') {
    const cells = Array.isArray(host.content && host.content.cells)
      ? host.content.cells.slice()
      : [];
    while (cells.length <= cellIndex) cells.push({ heading: '', body: '' });
    const cell = Object.assign({}, cells[cellIndex] || {});
    // First-class module/form widgets in a cell (native mounts — no body CSS hacks).
    if (type === 'module' || type === 'site_module' || type === 'widget'
      || type === 'form' || type === 'bitpype_form') {
      const widgetType = (type === 'form' || type === 'bitpype_form') ? 'form' : 'site_module';
      const widget = Object.assign(
        {},
        (content && typeof content === 'object') ? content : {},
        (opts.widget && typeof opts.widget === 'object') ? opts.widget : {},
        { type: widgetType }
      );
      if (opts.html) widget.html = String(opts.html);
      cell.widget = widget;
      if (widget.html) cell.html = String(widget.html);
      // Clear competing text so the cell is the widget.
      cell.heading = '';
      cell.body = '';
    } else if (type === 'html' && content.html) {
      cell.html = content.html;
      delete cell.widget;
    } else if (type === 'heading') {
      cell.heading = content.heading || content.title || 'Heading';
      delete cell.widget;
    } else if (type === 'text') {
      cell.heading = content.heading || cell.heading || '';
      cell.body = content.body || content.text || 'Add your content.';
      delete cell.widget;
    } else if (type === 'image' && content.image) {
      cell.image = content.image;
      if (content.image && content.image.crop) cell.crop = content.image.crop;
      delete cell.widget;
    } else if (opts.html) {
      cell.html = String(opts.html);
    } else {
      cell.heading = content.heading || content.title || cell.heading || '';
      cell.body = content.body || content.text || cell.body || '';
    }
    cells[cellIndex] = cell;
    host.content = Object.assign({}, host.content || {}, { cells });
    list[pi] = page;
    return { pages: list, changed: true, sectionIndex: si, cellIndex };
  }

  // Freestyle html section: append rendered block or raw html inside first ws-page-section.
  if (host && host.type === 'html' && host.content && typeof host.content.html === 'string'
    && (opts.html || type === 'html')) {
    const blockHtml = opts.html != null
      ? String(opts.html)
      : (content.html || `<div class="ws-block" data-ws-block="${type}"><p>${type}</p></div>`);
    let html = host.content.html;
    if (/<\/section>/i.test(html) && /ws-page-section/i.test(html)) {
      html = html.replace(/<\/section>/i, `${blockHtml}</section>`);
    } else {
      html = `${html}\n${blockHtml}`;
    }
    host.content = Object.assign({}, host.content, { html });
    list[pi] = page;
    return { pages: list, changed: true, sectionIndex: si };
  }

  // Default: insert typed block as a sibling section after the host (modular pages).
  return insertContentSection(list, pi, si, type, Object.assign({}, opts, { content }));
}

/**
 * Insert a site_module section after afterIndex (between sections). afterIndex -1 inserts at 0.
 */
function insertModuleSection(pages, pageIndex, afterIndex, moduleContent) {
  const list = clonePages(pages);
  const pi = Number(pageIndex);
  if (!Number.isInteger(pi) || pi < 0 || pi >= list.length) {
    return { pages: list, changed: false };
  }
  const page = list[pi];
  if (!page || !Array.isArray(page.sections) || !page.sections.length) {
    return { pages: list, changed: false, reason: 'no_sections' };
  }
  const content = moduleContent && typeof moduleContent === 'object' ? moduleContent : {};
  const token = String(content.public_token || content.publicToken || '').trim();
  const moduleType = String(content.module_type || content.moduleType || '').trim();
  if (!token || !moduleType) return { pages: list, changed: false, reason: 'invalid_module' };

  const insertAt = Math.max(0, Math.min(Number(afterIndex) + 1, page.sections.length));
  const footerAt = page.sections.findIndex((s) => s && s.type === 'footer');
  let at = insertAt;
  if (footerAt >= 0 && at > footerAt) at = footerAt;

  // Prefer Page → Section → Block: wrap the live widget inside a ws-page-section.
  const apiBase = content.api_base || content.apiBase || '';
  const title = content.title || moduleType;
  const embedDiv = `<div class="bitpype-module-embed" data-bitpype-module="1" `
    + `data-bitpype-module-type="${String(moduleType).replace(/"/g, '')}" `
    + `data-bitpype-module-token="${String(token).replace(/"/g, '')}"`
    + (apiBase ? ` data-bitpype-api="${String(apiBase).replace(/"/g, '')}"` : '')
    + ` data-bitpype-hide-title="1"></div>`;
  const section = {
    type: 'html',
    content: {
      html: `<section class="ws-page-section" data-ws-page-section="1">`
        + `<h2>${String(title).replace(/</g, '&lt;')}</h2>${embedDiv}</section>`,
      module_type: moduleType,
      public_token: token,
      api_base: apiBase,
      title,
    },
  };
  page.sections.splice(at, 0, section);
  page.sections = ensureNavFirstSections(page.sections);
  // Drop legacy freeform so modular sections become the source of truth.
  if (typeof page.html === 'string') delete page.html;
  list[pi] = page;
  return { pages: list, changed: true, sectionIndex: at };
}

/**
 * Add a page with a nav entry (pages[] drives menu). Structured sites clone nav/footer shell.
 */
function createClientPage(pages, opts = {}) {
  const list = clonePages(pages);
  const title = String(opts.title || '').trim().slice(0, 120);
  if (!title) return { pages: list, changed: false, reason: 'title_required' };

  let slug = opts.slug != null ? String(opts.slug).trim() : titleToPageSlug(title);
  slug = ensureUniquePageSlug(list, slug);

  const structured = list.some((p) => Array.isArray(p.sections) && p.sections.length);
  const home = list.find((p, i) => isHomeLike(p, list)) || list[0];

  if (structured && home && Array.isArray(home.sections) && home.sections.length) {
    const navSec = home.sections.find((s) => s && s.type === 'nav');
    const footerSec = home.sections.find((s) => s && s.type === 'footer');
    const sections = [];
    if (navSec) sections.push(JSON.parse(JSON.stringify(navSec)));
    // Page title as custom heading; body invites edit-mode / structure “+” sections.
    sections.push({
      type: 'custom',
      content: {
        heading: title,
        body: 'Add your content here. Use + to add another section.',
      },
    });
    if (footerSec) sections.push(JSON.parse(JSON.stringify(footerSec)));
    list.push({ slug, title, sections, navVisible: opts.navVisible !== false });
  } else {
    const shellHtml = typeof opts.shellHtml === 'string' ? opts.shellHtml : '';
    const inner = typeof opts.pageInner === 'string' && opts.pageInner.trim()
      ? opts.pageInner
      : (typeof opts.defaultInner === 'function'
        ? opts.defaultInner(title)
        : `<h1 class="bp-mod-page-title">${escapeHtml(title)}</h1>`
          + `<section class="ws-page-section" data-ws-page-section="1">`
          + `<h2>Add your content here.</h2>`
          + `<p>Write this section, or use + to add another.</p>`
          + `</section>`);
    let html;
    if (shellHtml.trim() && typeof opts.fillShellMain === 'function') {
      html = opts.fillShellMain(shellHtml, inner);
    } else if (shellHtml.trim()) {
      html = shellHtml;
    } else {
      html = `<main class="bp-mod-main page">${inner}</main>`;
    }
    list.push({ slug, title, html, sections: [], navVisible: opts.navVisible !== false });
  }

  const next = syncFreeformNavOrder(list);
  return { pages: next, changed: true, pageIndex: next.length - 1, slug, title };
}

/** Swap adjacent items only when both ends are allowed to move. */
function moveItem(list, from, dir, canMove) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const i = Number(from);
  const d = Number(dir) < 0 ? -1 : 1;
  const j = i + d;
  if (!Number.isInteger(i) || i < 0 || i >= arr.length) return { list: arr, changed: false };
  if (j < 0 || j >= arr.length) return { list: arr, changed: false };
  if (typeof canMove === 'function') {
    if (!canMove(arr[i], i) || !canMove(arr[j], j)) return { list: arr, changed: false };
  }
  const tmp = arr[i];
  arr[i] = arr[j];
  arr[j] = tmp;
  return { list: arr, changed: true };
}

/**
 * Rebuild pages[] in visual DFS order so sibling order matches the menu.
 * Preserves page objects (with updated menuParent).
 */
function flattenMenuToPages(pages, visualIndices) {
  const list = Array.isArray(pages) ? pages : [];
  const seen = new Set();
  const out = [];
  visualIndices.forEach((i) => {
    if (!Number.isInteger(i) || i < 0 || i >= list.length || seen.has(i)) return;
    seen.add(i);
    out.push(list[i]);
  });
  list.forEach((p, i) => {
    if (!seen.has(i)) out.push(p);
  });
  return out;
}

function reorderMenu(pages, fromIndex, direction) {
  const list = clonePages(pages);
  const visual = menuVisualList(list);
  const vi = visual.findIndex((v) => v.index === Number(fromIndex));
  if (vi < 0) return { pages: list, changed: false };
  const item = visual[vi];
  if (item.pinned) return { pages: list, changed: false };
  const d = Number(direction) < 0 ? -1 : 1;
  const vj = vi + d;
  if (vj < 0 || vj >= visual.length) return { pages: list, changed: false };
  const other = visual[vj];
  if (other.depth !== item.depth) return { pages: list, changed: false };
  if (String(other.parentSlug || '') !== String(item.parentSlug || '')) return { pages: list, changed: false };
  if (other.pinned) return { pages: list, changed: false };

  // Swap visual siblings; when moving a top-level parent, keep its children glued after it.
  const order = visual.map((v) => v.index);
  if (item.depth === 0) {
    // Build blocks: each top + its following depth-1 children
    const blocks = [];
    for (let i = 0; i < visual.length;) {
      if (visual[i].depth !== 0) { i += 1; continue; }
      const block = [visual[i].index];
      let j = i + 1;
      while (j < visual.length && visual[j].depth === 1) {
        block.push(visual[j].index);
        j += 1;
      }
      blocks.push({ start: i, indices: block, pinned: visual[i].pinned });
      i = j;
    }
    const bi = blocks.findIndex((b) => b.indices[0] === item.index);
    const bj = bi + d;
    if (bi < 0 || bj < 0 || bj >= blocks.length) return { pages: list, changed: false };
    if (blocks[bi].pinned || blocks[bj].pinned) return { pages: list, changed: false };
    const tmp = blocks[bi];
    blocks[bi] = blocks[bj];
    blocks[bj] = tmp;
    const flat = [];
    blocks.forEach((b) => flat.push(...b.indices));
    const next = flattenMenuToPages(list, flat);
    return { pages: syncFreeformNavOrder(next), changed: true };
  }

  // Child: swap with adjacent sibling in order array
  const tmp = order[vi];
  order[vi] = order[vj];
  order[vj] = tmp;
  const next = flattenMenuToPages(list, order);
  return { pages: syncFreeformNavOrder(next), changed: true };
}

function nestMenuItem(pages, fromIndex) {
  const list = clonePages(pages);
  const visual = menuVisualList(list);
  const vi = visual.findIndex((v) => v.index === Number(fromIndex));
  if (vi <= 0) return { pages: list, changed: false };
  const item = visual[vi];
  if (item.pinned || item.depth >= MAX_MENU_DEPTH) return { pages: list, changed: false };

  // Previous visual item: if child, use its parent; if top, use it.
  const prev = visual[vi - 1];
  let parentSlug = null;
  if (prev.depth === 0 && !prev.pinned) parentSlug = prev.slug;
  else if (prev.depth === 1 && prev.parentSlug) parentSlug = prev.parentSlug;
  if (!parentSlug) return { pages: list, changed: false };
  if (slugKey(parentSlug) === pageSlugKey(list[item.index])) return { pages: list, changed: false };

  list[item.index] = setMenuParent(list[item.index], parentSlug);
  // Place nested item immediately after parent block start (after parent, among children).
  const parentIdx = list.findIndex((p) => pageSlugKey(p) === slugKey(parentSlug));
  if (parentIdx < 0) return { pages: list, changed: false };
  const moving = list[item.index];
  // Rebuild visual after parent assign, then flatten.
  const nextVisual = menuVisualList(list);
  const flat = nextVisual.map((v) => v.index);
  // Ensure the nested page sits with its siblings after parent:
  const without = flat.filter((i) => i !== item.index);
  const pPos = without.indexOf(parentIdx);
  if (pPos < 0) return { pages: list, changed: false };
  // Insert after existing children of this parent already in without
  let insertAt = pPos + 1;
  while (
    insertAt < without.length
    && menuParentKey(list[without[insertAt]]) === slugKey(parentSlug)
  ) {
    insertAt += 1;
  }
  without.splice(insertAt, 0, item.index);
  list[item.index] = moving;
  const next = flattenMenuToPages(list, without);
  return { pages: syncFreeformNavOrder(next), changed: true };
}

function unnestMenuItem(pages, fromIndex) {
  const list = clonePages(pages);
  const visual = menuVisualList(list);
  const vi = visual.findIndex((v) => v.index === Number(fromIndex));
  if (vi < 0) return { pages: list, changed: false };
  const item = visual[vi];
  if (item.pinned || item.depth <= 0) return { pages: list, changed: false };
  list[item.index] = setMenuParent(list[item.index], null);
  // Place right after former parent's block
  const nextVisual = menuVisualList(list);
  const flat = nextVisual.map((v) => v.index);
  const next = flattenMenuToPages(list, flat);
  return { pages: syncFreeformNavOrder(next), changed: true };
}

function toggleNavVisibility(pages, fromIndex) {
  const list = clonePages(pages);
  const i = Number(fromIndex);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) return { pages: list, changed: false };
  if (isHomeLike(list[i], list)) return { pages: list, changed: false };
  const nextVisible = !isNavVisible(list[i]);
  list[i] = setNavVisible(list[i], nextVisible);
  return { pages: syncFreeformNavOrder(list), changed: true };
}

function applyMenuAction(pages, body = {}) {
  const action = String(body.action || 'move').toLowerCase();
  const fromIndex = Number(body.fromIndex);
  if (!Number.isInteger(fromIndex) || fromIndex < 0) {
    return { pages: clonePages(pages), changed: false };
  }
  if (action === 'nest' || action === 'indent') return nestMenuItem(pages, fromIndex);
  if (action === 'unnest' || action === 'outdent') return unnestMenuItem(pages, fromIndex);
  if (action === 'togglenav' || action === 'toggle-nav' || action === 'toggle_nav') {
    return toggleNavVisibility(pages, fromIndex);
  }
  const direction = Number(body.direction);
  if (direction !== 1 && direction !== -1) return { pages: clonePages(pages), changed: false };
  return reorderMenu(pages, fromIndex, direction);
}

function reorderSections(pages, pageIndex, fromIndex, direction) {
  const list = clonePages(pages);
  const pi = Number(pageIndex);
  if (!Number.isInteger(pi) || pi < 0 || pi >= list.length) {
    return { pages: list, changed: false };
  }
  const page = list[pi];
  if (!page || !Array.isArray(page.sections) || !page.sections.length) {
    return { pages: list, changed: false };
  }
  const { list: secs, changed } = moveItem(
    page.sections,
    fromIndex,
    direction,
    (sec) => !isPinnedSection(sec)
  );
  if (!changed) return { pages: list, changed: false };
  page.sections = ensureNavFirstSections(secs);
  list[pi] = page;
  return { pages: list, changed: true };
}

/**
 * Build nav link tree for structured render (and MCP).
 * opts.preview → #anchor hrefs; else *.html files.
 */
function buildNavLinks(pages, opts = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const preview = !!opts.preview;
  const visual = menuVisualList(list);
  const links = [];
  visual.forEach((item) => {
    if (item.depth !== 0) return;
    const page = list[item.index];
    if (!isNavVisible(page)) return;
    const href = preview
      ? `#${engine.anchorId ? engine.anchorId(item.slug) : String(item.slug || 'home').replace(/^\//, '')}`
      : item.file;
    // Prefer engine.anchorId / pageFileName already on item.file
    let anchorHref = href;
    try {
      anchorHref = preview ? `#${require('./websiteEngine').anchorId(item.slug)}` : item.file;
    } catch {
      anchorHref = href;
    }
    const children = visual
      .filter((c) => c.depth === 1 && slugKey(c.parentSlug) === pageSlugKey({ slug: item.slug })
        && isNavVisible(list[c.index]))
      .map((c) => ({
        label: c.title,
        href: preview
          ? `#${(() => { try { return engine.anchorId(c.slug); } catch { return String(c.slug || '').replace(/^\//, ''); } })()}`
          : c.file,
        slug: c.slug,
      }));
    links.push({
      label: item.title,
      href: anchorHref,
      slug: item.slug,
      children,
    });
  });
  return links;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderNavLinksHtml(links, { asList } = {}) {
  const items = Array.isArray(links) ? links : [];
  if (asList) {
    return `<ul class="nav-menu">${items.map((l) => {
      const kids = Array.isArray(l.children) ? l.children : [];
      const sub = kids.length
        ? `<ul class="nav-sub">${kids.map((c) =>
          `<li><a href="${escapeHtml(c.href || '#')}">${escapeHtml(c.label || '')}</a></li>`
        ).join('')}</ul>`
        : '';
      const cls = kids.length ? ' class="has-children"' : '';
      return `<li${cls}><a href="${escapeHtml(l.href || '#')}">${escapeHtml(l.label || '')}</a>${sub}</li>`;
    }).join('')}</ul>`;
  }
  return items.map((l) => {
    const kids = Array.isArray(l.children) ? l.children : [];
    if (!kids.length) {
      return `<a href="${escapeHtml(l.href || '#')}">${escapeHtml(l.label || '')}</a>`;
    }
    const sub = kids.map((c) =>
      `<a href="${escapeHtml(c.href || '#')}">${escapeHtml(c.label || '')}</a>`
    ).join('');
    return `<span class="nav-item has-children"><a href="${escapeHtml(l.href || '#')}">${escapeHtml(l.label || '')}</a><span class="nav-sub">${sub}</span></span>`;
  }).join('\n');
}

function buildPageHrefIndex(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const byFile = new Map();
  const byAnchor = new Map();
  list.forEach((p, i) => {
    const file = engine.pageFileName(p.slug).toLowerCase();
    byFile.set(file, i);
    const bare = file.replace(/\.html$/i, '');
    if (bare && bare !== file) byFile.set(bare, i);
    try {
      const aid = String(engine.anchorId(p.slug) || '').toLowerCase();
      if (aid) byAnchor.set(aid, i);
    } catch { /* optional */ }
    const sk = slugKey(p.slug);
    if (sk) byAnchor.set(sk, i);
  });
  const homeIdx = list.findIndex((p) => isHomeLike(p, list));
  if (homeIdx >= 0) {
    byFile.set('index.html', homeIdx);
    byAnchor.set('home', homeIdx);
    byAnchor.set('index', homeIdx);
  }
  return { byFile, byAnchor, multipage: list.length >= 2 };
}

function hrefPageIndex(href, hrefIndex) {
  const h = String(href || '').trim();
  if (!h || /^(mailto:|tel:|javascript:|https?:|\/\/)/i.test(h)) return null;
  let pathPart = h;
  let hashPart = '';
  if (h.includes('#')) {
    const parts = h.split('#');
    pathPart = parts[0];
    hashPart = slugKey(parts.slice(1).join('#'));
  }
  let bare = String(pathPart || '').replace(/^\.\//, '').split('?')[0].toLowerCase();
  if (bare.startsWith('/')) bare = bare.slice(1);
  // Bare "/" / "" / home / index → home page file.
  let route = '';
  try {
    route = engine.normalizeRoute ? engine.normalizeRoute(h) : '';
  } catch { route = ''; }
  if (!bare || bare === 'home' || bare === 'index' || route === 'index') {
    if (hrefIndex.byFile.has('index.html')) return hrefIndex.byFile.get('index.html');
    if (hrefIndex.byAnchor.has('home')) return hrefIndex.byAnchor.get('home');
    if (hrefIndex.byAnchor.has('index')) return hrefIndex.byAnchor.get('index');
  }
  if (bare && hrefIndex.byFile.has(bare)) return hrefIndex.byFile.get(bare);
  if (bare && !bare.endsWith('.html') && hrefIndex.byFile.has(`${bare}.html`)) {
    return hrefIndex.byFile.get(`${bare}.html`);
  }
  if (hashPart && hrefIndex.byAnchor.has(hashPart)) return hrefIndex.byAnchor.get(hashPart);
  if (h.charAt(0) === '#' && h.length > 1) {
    const id = slugKey(h.slice(1));
    if (hrefIndex.byAnchor.has(id)) return hrefIndex.byAnchor.get(id);
  }
  return null;
}

function isManagedModuleNavLink(linkHtml) {
  return /data-bitpype-module-nav/i.test(String(linkHtml || ''));
}

function keepNonPageNavLink(linkHtml, hrefIndex) {
  if (isManagedModuleNavLink(linkHtml)) return true;
  if (!hrefIndex.multipage) return true;
  const hm = String(linkHtml || '').match(/\bhref\s*=\s*["']([^"']+)["']/i);
  if (!hm) return true;
  return hrefPageIndex(hm[1], hrefIndex) == null;
}

/** Fallback when primary nav heuristics miss: rewrite whole <nav> inner. */
function syncLegacyNavTags(html, navLinks, list, fileSet, hrefIndex) {
  return String(html || '').replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, (navBlock) => {
    const openEnd = navBlock.indexOf('>') + 1;
    const closeStart = navBlock.lastIndexOf('</');
    if (openEnd <= 0 || closeStart <= openEnd) return navBlock;
    const open = navBlock.slice(0, openEnd);
    const close = navBlock.slice(closeStart);
    const inner = navBlock.slice(openEnd, closeStart);
    const linkRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi;
    const pageLinks = new Map();
    const other = [];
    let m;
    while ((m = linkRe.exec(inner))) {
      const href = String(m[1] || '').trim();
      const pi = hrefPageIndex(href, hrefIndex);
      if (pi != null) {
        const file = engine.pageFileName(list[pi].slug).toLowerCase();
        if (!pageLinks.has(file)) pageLinks.set(file, m[0]);
      } else {
        other.push(m[0]);
      }
    }
    if (!pageLinks.size) return navBlock;

    const useList = /<ul\b/i.test(inner);
    const resolveLink = (file, label) => {
      const existing = pageLinks.get(String(file || '').toLowerCase());
      if (existing) return existing;
      return `<a href="${escapeHtml(file)}">${escapeHtml(label || file)}</a>`;
    };
    const filteredOther = other.filter((chunk) => keepNonPageNavLink(chunk, hrefIndex));

    let rebuilt;
    if (useList) {
      rebuilt = `<ul class="nav-menu">${navLinks.map((l) => {
        const kids = Array.isArray(l.children) ? l.children : [];
        const sub = kids.length
          ? `<ul class="nav-sub">${kids.map((c) =>
            `<li>${resolveLink(engine.pageFileName(c.slug), c.label)}</li>`
          ).join('')}</ul>`
          : '';
        const cls = kids.length ? ' class="has-children"' : '';
        return `<li${cls}>${resolveLink(engine.pageFileName(l.slug), l.label)}${sub}</li>`;
      }).join('')}</ul>`;
      if (filteredOther.length) rebuilt += filteredOther.join(' ');
    } else {
      const parts = navLinks.map((l) => {
        const kids = Array.isArray(l.children) ? l.children : [];
        const top = resolveLink(engine.pageFileName(l.slug), l.label);
        if (!kids.length) return top;
        const sub = kids.map((c) => resolveLink(engine.pageFileName(c.slug), c.label)).join('');
        return `<span class="nav-item has-children">${top}<span class="nav-sub">${sub}</span></span>`;
      });
      rebuilt = parts.concat(filteredOther).join(/\n/.test(inner) ? '\n' : ' ');
    }
    return open + rebuilt + close;
  });
}

/**
 * Reorder / hide menu links in freeform HTML to match pages[] (menuParent + navVisible).
 * Uses primary header/nav detection (same as module nav); falls back to bare <nav> rewrite.
 */
function syncFreeformNavOrder(pages, opts = {}) {
  let list = Array.isArray(pages) ? pages : [];
  if (!list.length) return list;
  if (list.length >= 2 && typeof engine.normalizePagesNavLinks === 'function') {
    list = engine.normalizePagesNavLinks(list);
  }
  const fileOrder = list.map((p) => engine.pageFileName(p.slug).toLowerCase());
  const fileSet = new Set(fileOrder);
  const hrefIndex = buildPageHrefIndex(list);
  const navLinks = buildNavLinks(list, { preview: false });
  const rebuildOpts = {
    activeModules: Array.isArray(opts.activeModules) ? opts.activeModules : [],
  };
  let rebuildPrimary = null;
  try {
    rebuildPrimary = require('../server/siteModules').rebuildFreeformPrimaryNav;
  } catch { /* electron / tests without server */ }

  return list.map((page) => {
    if (!page) return page;
    let next = page;
    const hasSections = Array.isArray(page.sections) && page.sections.length > 0;
    const hasHtml = typeof page.html === 'string' && !!page.html.trim();

    if (hasHtml && !hasSections) {
      let html = page.html;
      if (typeof rebuildPrimary === 'function') {
        const rebuilt = rebuildPrimary(html, navLinks, list, rebuildOpts);
        if (rebuilt !== html) {
          next = Object.assign({}, next, { html: rebuilt });
          html = rebuilt;
        }
      }
      const legacy = syncLegacyNavTags(html, navLinks, list, fileSet, hrefIndex);
      if (legacy !== html) {
        next = Object.assign({}, next, { html: legacy });
        html = legacy;
      }
      try {
        const deduped = engine.assertAndDedupeNavHtml(html, `syncFreeformNavOrder:${page.slug || ''}`);
        if (deduped !== html) next = Object.assign({}, next, { html: deduped });
      } catch { /* optional */ }
    }

    // Freestyle nav chrome lives in sections[nav].content.html on modular sites.
    if (hasSections && typeof rebuildPrimary === 'function') {
      let sectionsChanged = false;
      const sections = page.sections.map((sec) => {
        if (!sec || sec.type !== 'nav' || !sec.content || typeof sec.content.html !== 'string') {
          return sec;
        }
        let html = sec.content.html;
        if (!html.trim()) return sec;
        const rebuilt = rebuildPrimary(html, navLinks, list, rebuildOpts);
        if (rebuilt !== html) html = rebuilt;
        try {
          html = engine.assertAndDedupeNavHtml(html, `syncFreeformNavOrder:nav:${page.slug || ''}`);
        } catch { /* optional */ }
        if (html === sec.content.html) return sec;
        sectionsChanged = true;
        return Object.assign({}, sec, {
          content: Object.assign({}, sec.content, { html }),
        });
      });
      if (sectionsChanged) next = Object.assign({}, next, { sections });
    }

    return next;
  });
}

module.exports = {
  PINNED_SECTION_TYPES,
  MAX_MENU_DEPTH,
  isPinnedSection,
  isNavSection,
  ensureNavFirstSections,
  ensureNavFirstPage,
  ensureNavFirstPages,
  isHomeLike,
  slugKey,
  menuParentKey,
  isNavVisible,
  setNavVisible,
  setMenuParent,
  menuVisualList,
  summarizeStructure,
  reorderMenu,
  nestMenuItem,
  unnestMenuItem,
  toggleNavVisibility,
  applyMenuAction,
  reorderSections,
  insertModuleSection,
  insertContentSection,
  insertBlockIntoSection,
  clampBlockCols,
  MAX_BLOCK_COLS,
  defaultSectionContent,
  createClientPage,
  titleToPageSlug,
  ensureUniquePageSlug,
  syncFreeformNavOrder,
  buildNavLinks,
  renderNavLinksHtml,
  moveItem,
};
