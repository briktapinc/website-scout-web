/**
 * Restore original freestyle look as modular sections with styled chrome:
 *   [nav(content.html=original header), html(main), footer(content.html=original footer)]
 * Nav is always first. theme.customCss / customJs preserved from the original.
 */
const Database = require('better-sqlite3');
const engine = require('../src/websiteEngine');
const structure = require('../src/siteStructure');
const domain = require('../server/domain');
const siteModules = require('../server/siteModules');
const contactForms = require('../server/contactForms');

const DB = process.env.WS_DB || '/app/data/workspaces/1/websitescout.db';
const WORKSPACE_ID = Number(process.env.WS_WORKSPACE_ID || 1);
const SITE_IDS = (process.env.WS_SITE_IDS || '1,2,3')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

function extractBody(html) {
  const s = String(html || '');
  const m = s.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return (m ? m[1] : s).trim();
}

function extractHeadStyles(html) {
  const styles = [];
  String(html || '').replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
    if (css && String(css).trim()) styles.push(String(css).trim());
    return '';
  });
  return styles.join('\n\n');
}

/**
 * Split original body into freestyle header chrome, main, footer chrome.
 * Prefer the full <header>…</header> (nav is often nested inside). Cutting at
 * the first </nav> left half the masthead in the body and broke CSS.
 */
function splitChrome(inner) {
  let s = String(inner || '').trim();
  let navHtml = '';
  let footerHtml = '';

  const mainAt = s.search(/<main\b/i);
  const headRegion = mainAt >= 0 ? s.slice(0, mainAt) : s.slice(0, Math.min(s.length, 12000));

  const headerClose = headRegion.search(/<\/header>/i);
  if (headerClose >= 0 && /<header\b/i.test(headRegion.slice(0, headerClose))) {
    const end = headerClose + '</header>'.length;
    navHtml = s.slice(0, end).trim();
    s = s.slice(end).trim();
  } else {
    const navEnd = s.search(/<\/nav>/i);
    if (navEnd >= 0) {
      const afterNav = navEnd + '</nav>'.length;
      const chunk = s.slice(0, afterNav);
      if (/<header\b/i.test(chunk) && !/<\/header>/i.test(chunk)) {
        const hEnd = s.search(/<\/header>/i);
        if (hEnd >= 0) {
          navHtml = s.slice(0, hEnd + '</header>'.length).trim();
          s = s.slice(hEnd + '</header>'.length).trim();
        } else {
          navHtml = chunk.trim();
          s = s.slice(afterNav).trim();
        }
      } else {
        navHtml = chunk.trim();
        s = s.slice(afterNav).trim();
      }
    } else {
      const headerMatch = s.match(/^([\s\S]*?<\/header>)/i);
      if (headerMatch && /header|site-header|top-bar|banner/i.test(headerMatch[1])) {
        navHtml = headerMatch[1].trim();
        s = s.slice(headerMatch[0].length).trim();
      }
    }
  }

  // Drop orphaned closers left from older bad splits.
  s = s.replace(/^(?:\s*<\/(?:a|div|header|nav|section)>)+/i, '').trim();

  const footMatch = s.match(/<footer\b[\s\S]*?<\/footer>/i);
  if (footMatch) {
    footerHtml = footMatch[0].trim();
    s = s.replace(footMatch[0], '').trim();
  }

  return { navHtml, footerHtml, body: s };
}

/** Prefer one copy of theme CSS (prior redesigns appended head styles repeatedly). */
function dedupeCss(css) {
  const s = String(css || '');
  if (!s.trim()) return '';
  const marker = ':root{';
  const first = s.indexOf(marker);
  if (first < 0) return s.trim();
  const second = s.indexOf(marker, first + 1);
  if (second > first) return s.slice(0, second).trim();
  return s.trim();
}

function pickOriginal(db, siteId, leadId) {
  const vers = db.prepare(
    `SELECT id, version_no, note, pages, theme FROM website_versions
     WHERE website_id = ? ORDER BY version_no DESC LIMIT 50`
  ).all(siteId);
  for (const v of vers) {
    let pages;
    try { pages = JSON.parse(v.pages || '[]'); } catch { continue; }
    const free = (pages || []).filter((p) => p && String(p.html || '').trim().length > 400);
    // Prefer full freeform originals (not our modular rebuild notes)
    const note = String(v.note || '');
    if (/Rebuild:|modular|template/i.test(note) && free.length === 0) continue;
    if (free.length >= Math.min(2, pages.length) || (pages.length === 1 && free.length === 1)) {
      let theme = {};
      try { theme = JSON.parse(v.theme || '{}') || {}; } catch { theme = {}; }
      return { source: `version:${v.version_no}`, note, pages, theme };
    }
  }
  const jobs = db.prepare(
    `SELECT id, deliverable FROM design_jobs WHERE lead_id = ? AND deliverable IS NOT NULL
     ORDER BY id DESC LIMIT 10`
  ).all(leadId);
  for (const j of jobs) {
    let payload;
    try { payload = JSON.parse(j.deliverable); } catch { continue; }
    const pages = Array.isArray(payload.pages) ? payload.pages : [];
    const free = pages.filter((p) => p && String(p.html || '').trim().length > 400);
    if (free.length) {
      return {
        source: `design_job:${j.id}`,
        pages,
        theme: (payload.theme && typeof payload.theme === 'object') ? payload.theme : {},
      };
    }
  }
  return null;
}

function pageToModular(page, lead, isHome) {
  const contact = {
    business_name: lead.business_name || 'Business',
    phone: lead.phone || '',
    email: lead.email || '',
    address: [lead.address, lead.city, lead.state].filter(Boolean).join(', '),
    tagline: lead.category || '',
  };
  const raw = typeof page.html === 'string' ? page.html : '';
  const { navHtml, footerHtml, body } = splitChrome(extractBody(raw));
  const headCss = extractHeadStyles(raw);

  const sections = [];

  if (navHtml) {
    sections.push({
      type: 'nav',
      className: 'site-chrome-nav',
      content: {
        html: navHtml,
        business_name: contact.business_name,
        phone: contact.phone,
        phone_display: contact.phone,
      },
    });
  } else {
    sections.push({
      type: 'nav',
      content: {
        business_name: contact.business_name,
        phone: contact.phone,
        phone_display: contact.phone,
      },
    });
  }

  if (body) {
    sections.push({
      type: 'html',
      className: isHome ? 'page-home-main' : 'page-inner-main',
      content: { html: body },
    });
  }

  if (footerHtml) {
    sections.push({
      type: 'footer',
      className: 'site-chrome-footer',
      content: Object.assign({}, contact, { html: footerHtml }),
    });
  } else {
    sections.push({ type: 'footer', content: contact });
  }

  const next = {
    slug: page.slug || '/',
    title: page.title || (isHome ? 'Home' : 'Page'),
    sections: structure.ensureNavFirstSections(sections),
  };
  if (page.menuParent) next.menuParent = page.menuParent;
  if (page.navVisible === false) next.navVisible = false;
  return { page: next, headCss, hasStyledNav: !!navHtml, hasStyledFooter: !!footerHtml };
}

function convertSite(original, lead) {
  const pagesIn = Array.isArray(original.pages) ? original.pages : [];
  const home = engine.homePage(pagesIn) || pagesIn[0];
  const headCssParts = [];
  let styledNav = 0;
  let styledFooter = 0;
  const pages = pagesIn.map((p) => {
    const { page, headCss, hasStyledNav, hasStyledFooter } = pageToModular(p, lead, p === home);
    if (headCss) headCssParts.push(headCss);
    if (hasStyledNav) styledNav += 1;
    if (hasStyledFooter) styledFooter += 1;
    return page;
  });

  let theme = Object.assign({}, original.theme || {});
  const priorCss = typeof theme.customCss === 'string' ? theme.customCss : '';
  const fromPages = headCssParts.filter(Boolean).join('\n\n');
  // Prefer the original theme stylesheet; only merge page <style> when theme CSS is thin.
  if (priorCss.trim().length > 800) {
    theme.customCss = dedupeCss(priorCss);
  } else {
    theme.customCss = dedupeCss([priorCss, fromPages].filter((s) => s && String(s).trim()).join('\n\n'));
  }
  theme.baseCss = false;
  if (typeof theme.customJs !== 'string') theme.customJs = '';
  theme = engine.normalizeTheme(theme);
  return {
    pages: structure.ensureNavFirstPages(pages),
    theme,
    styledNav,
    styledFooter,
  };
}

async function main() {
  const db = new Database(DB);
  engine.ensureTables(db);
  console.log('DB', DB);

  for (const id of SITE_IDS) {
    const row = db.prepare('SELECT * FROM websites WHERE id = ?').get(id);
    if (!row) { console.log('missing', id); continue; }
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(row.lead_id);
    if (!lead) { console.log('no lead', id); continue; }

    const original = pickOriginal(db, id, lead.id);
    if (!original) {
      console.log('NO ORIGINAL freeform for site', id, row.name);
      continue;
    }
    console.log('site', id, 'from', original.source, 'pages', original.pages.length);

    const { pages, theme, styledNav, styledFooter } = convertSite(original, lead);
    try {
      const curTheme = JSON.parse(row.theme || '{}') || {};
      if (!theme.logoUrl && curTheme.logoUrl) {
        theme.logoUrl = curTheme.logoUrl;
        theme.logoMode = curTheme.logoMode || 'image';
      }
    } catch { /* */ }

    // Clone freestyle chrome onto any leftover template-nav pages (e.g. shop).
    const home = pages.find((p) => structure.isHomeLike(p, pages)) || pages[0];
    const homeNav = home && (home.sections || []).find((s) => s && s.type === 'nav');
    const homeFoot = home && (home.sections || []).find((s) => s && s.type === 'footer');
    if (homeNav && homeNav.content && homeNav.content.html) {
      for (const p of pages) {
        if (!p || !Array.isArray(p.sections)) continue;
        const nav = p.sections.find((s) => s && s.type === 'nav');
        if (nav && !(nav.content && nav.content.html)) {
          nav.content = Object.assign({}, nav.content || {}, {
            html: homeNav.content.html,
            business_name: homeNav.content.business_name,
            phone: homeNav.content.phone,
            phone_display: homeNav.content.phone_display,
          });
          if (homeNav.className) nav.className = homeNav.className;
        }
        const foot = p.sections.find((s) => s && s.type === 'footer');
        if (foot && !(foot.content && foot.content.html) && homeFoot && homeFoot.content && homeFoot.content.html) {
          foot.content = Object.assign({}, foot.content || {}, { html: homeFoot.content.html });
          if (homeFoot.className) foot.className = homeFoot.className;
        }
      }
    }

    domain.sitesSave(WORKSPACE_ID, id, {
      pages,
      theme,
      note: `Redesign modular + styled chrome (${original.source})`,
    });
    db.prepare(`UPDATE websites SET origin = 'agent', updated_at = datetime('now') WHERE id = ?`).run(id);

    try {
      contactForms.ensureSiteForms(db, lead.id, { workspaceId: WORKSPACE_ID, missingOnly: true });
    } catch (e) {
      console.warn('forms sync', e.message);
    }
    try {
      siteModules.syncSiteModuleEmbeds(db, lead.id);
    } catch (e) {
      console.warn('modules sync', e.message);
    }

    try {
      const job = db.prepare(
        `SELECT id FROM design_jobs WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
      ).get(lead.id);
      if (job) {
        const del = db.prepare('SELECT deliverable FROM design_jobs WHERE id=?').get(job.id);
        let payload = {};
        try { payload = JSON.parse(del.deliverable || '{}') || {}; } catch { payload = {}; }
        payload.pages = pages;
        payload.theme = theme;
        db.prepare(
          `UPDATE design_jobs SET deliverable = ?, website_id = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(JSON.stringify(payload), id, job.id);
      }
    } catch (e) {
      console.warn('deliverable sync', e.message);
    }

    console.log(JSON.stringify({
      id,
      lead: lead.business_name,
      pages: pages.length,
      navFirst: pages.every((p) => p.sections && p.sections[0] && p.sections[0].type === 'nav'),
      styledNav,
      styledFooter,
      cssLen: String(theme.customCss || '').length,
    }));
  }
  db.close();

  for (const id of SITE_IDS) {
    try {
      const r = await domain.sitesPreview(WORKSPACE_ID, id, { force: true });
      console.log('published', id, r && (r.url || r.previewUrl || r));
    } catch (e) {
      console.warn('publish', id, e.message || e);
    }
  }
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
