#!/usr/bin/env node
/**
 * Run inside the app container (workspace 1):
 *   node scripts/_qa-new-lead-site-vps.js
 * Creates a fresh lead + site, exercises addSection/addBlock, exports preview HTML, scans for bugs.
 */
const path = require('path');
process.chdir('/app');

const domain = require('/app/server/domain');
const structure = require('/app/src/siteStructure');
const engine = require('/app/src/websiteEngine');
const { openWorkspaceDb } = require('/app/server/workspaceDb');

const WS = 1;

function uniqName() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `North Harbor Studio QA ${stamp}`;
}

async function main() {
  const name = uniqName();
  console.log('1) leadsCreate', name);
  const lead = domain.leadsCreate(WS, {
    business_name: name,
    email: 'qa-northharbor@example.com',
    phone: '555-010-2048',
    city: 'Portland',
    category: 'Photography',
    notes: 'QA Page→Section→Block',
    status: 'new',
  });
  const leadId = lead.id;
  console.log('   leadId=', leadId);

  console.log('2) sitesGenerate / template');
  let site;
  if (typeof domain.sitesGenerate === 'function') {
    site = await domain.sitesGenerate(WS, leadId, { force: true });
  } else if (typeof domain.websitesGenerate === 'function') {
    site = await domain.websitesGenerate(WS, leadId, { force: true });
  } else {
    // fall back: design job path
    const job = domain.designCreateWebsiteJob
      ? domain.designCreateWebsiteJob(WS, { leadId, title: name })
      : null;
    throw new Error('No sitesGenerate; job=' + (job && job.id));
  }
  const siteId = site.id || site.siteId || site.site?.id;
  console.log('   siteId=', siteId, 'keys=', Object.keys(site || {}).join(','));

  const db = openWorkspaceDb(WS);
  const row = db.prepare('SELECT id, pages, theme FROM websites WHERE id = ?').get(siteId);
  let pages = typeof row.pages === 'string' ? JSON.parse(row.pages || '[]') : (row.pages || []);
  const theme = typeof row.theme === 'string' ? JSON.parse(row.theme || '{}') : (row.theme || {});
  console.log('3) pages=', pages.length, pages.map((p, i) => `${i}:${p.slug || p.title}`).join(' | '));

  const pageIndex = 0;
  const page = pages[pageIndex];
  const hasSections = Array.isArray(page.sections) && page.sections.length;
  console.log('   home sections?', hasSections, 'html?', typeof page.html === 'string' ? page.html.length : 0);

  console.log('4) insertContentSection heading + columns(6)');
  let afterIndex = hasSections ? Math.max(0, page.sections.length - 2) : -1;
  let r1 = structure.insertContentSection(pages, pageIndex, afterIndex, 'heading', {});
  if (!r1.changed) {
    console.log('   heading insert failed', r1.reason, '— trying section wrapper via sitesInsertSection');
  } else {
    pages = r1.pages;
    console.log('   heading at', r1.sectionIndex);
  }

  r1 = structure.insertContentSection(pages, pageIndex, afterIndex + 1, 'columns', { cols: 6 });
  if (!r1.changed) console.log('   columns failed', r1.reason);
  else {
    pages = r1.pages;
    console.log('   columns6 at', r1.sectionIndex);
  }

  if (typeof structure.insertBlockIntoSection === 'function') {
    console.log('5) insertBlockIntoSection text + html');
    const secs = pages[pageIndex].sections || [];
    let sectionIndex = secs.findIndex((s) => s && s.type === 'columns');
    if (sectionIndex < 0) {
      sectionIndex = secs.findIndex((s) => s && s.type === 'heading');
    }
    if (sectionIndex < 0) {
      for (let i = secs.length - 1; i >= 0; i--) {
        const t = secs[i] && secs[i].type;
        if (t !== 'footer' && t !== 'nav') { sectionIndex = i; break; }
      }
    }
    console.log('   target sectionIndex=', sectionIndex, secs[sectionIndex] && secs[sectionIndex].type);
    let b = structure.insertBlockIntoSection(pages, pageIndex, sectionIndex, 'text', {});
    console.log('   text block', b.changed, b.reason || 'ok');
    if (b.changed) pages = b.pages;
    b = structure.insertBlockIntoSection(pages, pageIndex, sectionIndex, 'html', {
      html: '<p data-qa="block-html">QA HTML block</p>',
    });
    console.log('   html block', b.changed, b.reason || 'ok');
    if (b.changed) pages = b.pages;
    const colIdx = (pages[pageIndex].sections || []).findIndex((s) => s && s.type === 'columns');
    if (colIdx >= 0) {
      b = structure.insertBlockIntoSection(pages, pageIndex, colIdx, 'text', { cellIndex: 0 });
      console.log('   cell0 text', b.changed, b.reason || 'ok');
      if (b.changed) pages = b.pages;
    }
  } else {
    console.log('5) insertBlockIntoSection MISSING');
  }

  console.log('6) saveSite');
  const version = engine.saveSite(db, siteId, pages, theme, 'QA: section/block nesting');
  console.log('   version', version.version_no || version.id);

  console.log('7) render editable + public');
  const siteObj = engine.getWebsite(db, siteId);
  let pagesForRender = siteObj.pages;
  if (typeof pagesForRender === 'string') {
    try { pagesForRender = JSON.parse(pagesForRender || '[]'); } catch { pagesForRender = pages; }
  }
  if (!Array.isArray(pagesForRender) || !pagesForRender.length) pagesForRender = pages;
  const themeForRender = (siteObj.theme && typeof siteObj.theme === 'object')
    ? siteObj.theme
    : theme;

  let homePub = '';
  let homeEdit = '';
  try {
    homePub = engine.renderSite(pagesForRender, themeForRender, { editable: false }) || '';
    homeEdit = engine.renderSite(pagesForRender, themeForRender, { editable: true }) || '';
  } catch (e) {
    console.log('   renderSite err', e.message);
  }

  function scan(html, label) {
    const issues = [];
    const s = String(html || '');
    if (s.length < 100) issues.push('too short: ' + s.length);
    if (/Internal Server Error|TypeError|ReferenceError|Cannot read prop/i.test(s)) issues.push('error text');
    if (/undefined<\/|null<\/|\[object Object\]/i.test(s)) issues.push('leaked undefined/object');
    const has6 = /repeat\(6|cols-6|--ws-cols:\s*6|grid-template-columns:repeat\(6/i.test(s);
    const hasHeading = /heading-block|Section heading|New heading|bp-mod-page-title|data-edit=.*heading/i.test(s)
      || /<h[12][^>]*>/i.test(s);
    const hasQa = /data-qa="block-html"|QA HTML block/i.test(s);
    const hasAdd = /Add section|Add block|Add design module|data-ws-add/i.test(s);
    return {
      label,
      len: s.length,
      has6,
      hasHeading,
      hasQa,
      hasAdd,
      issues,
      snippet: s.replace(/\s+/g, ' ').slice(0, 280),
    };
  }

  // Inspect columns content in saved pages
  const colSec = (pages[pageIndex].sections || []).find((s) => s && s.type === 'columns');
  console.log('8) columns content cols=', colSec && colSec.content && colSec.content.cols,
    'cells=', colSec && colSec.content && (colSec.content.cells || []).length);

  const scans = [
    scan(homePub, 'public'),
    scan(homeEdit, 'editable'),
  ];

  // Export preview URL if available
  let previewUrl = null;
  try {
    if (typeof domain.sitesPreview === 'function') {
      const prev = await domain.sitesPreview(WS, siteId, { force: true });
      previewUrl = prev.previewUrl || prev.url || prev.preview_url;
      console.log('9) previewUrl=', previewUrl);
    } else if (typeof domain.sitesExport === 'function') {
      const exp = await domain.sitesExport(WS, siteId, {});
      previewUrl = exp.previewUrl || exp.url;
      console.log('9) export previewUrl=', previewUrl);
    }
  } catch (e) {
    console.log('9) preview failed', e.message);
  }

  const report = {
    leadId,
    siteId,
    name,
    previewUrl,
    sectionTypes: (pages[pageIndex].sections || []).map((s) => s.type),
    scans,
    columnCols: colSec && colSec.content && colSec.content.cols,
  };
  console.log('\n=== QA REPORT ===');
  console.log(JSON.stringify(report, null, 2));

  const bad = scans.some((s) => s.issues.length) || !colSec || Number(colSec.content?.cols) !== 6;
  if (bad) {
    console.log('QA ISSUES FOUND');
    process.exit(2);
  }
  console.log('QA OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
